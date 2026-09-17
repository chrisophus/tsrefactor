import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { build } from "../src/build.ts";
import { validate, type Envelope, type Expansion } from "../src/envelope.ts";
import { fixtureRepo, removeFile, writeFile } from "./helpers.ts";

// baseFiles is a small project kept under web/ behind a solution-style
// tsconfig, the layout that defeats a loader looking only at the root.
const baseFiles: Record<string, string> = {
  "web/tsconfig.json": JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }, null, 2) + "\n",
  "web/tsconfig.app.json":
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["src"],
      },
      null,
      2,
    ) + "\n",
  "web/src/money.ts": "export type Money = number;\n",
  "web/src/store.ts": `// Copyright header, separated by a blank line.

import type { Money } from "./money";

/** Store counts the records it was given. */
export class Store {
  private n = 0;

  /** insert stores a record. */
  insert(cents: Money): number {
    this.n++;
    return this.n;
  }

  size(): number {
    return this.n;
  }
}

// total sums a bill.
export const total = (cents: Money): Money => cents;

function helper(): void {}
`,
  "README.md": "# fixture\n",
};

// edit replaces text in the working-tree copy, so successive edits accumulate.
function edit(dir: string, rel: string, from: string, to: string): void {
  const content = readFileSync(join(dir, rel), "utf8");
  assert.ok(content.includes(from), `fixture ${rel} lacks ${JSON.stringify(from)}`);
  writeFile(dir, rel, content.replace(from, to));
}

function run(t: TestContext, mutate: (dir: string) => void): Envelope {
  const dir = fixtureRepo(t, baseFiles);
  mutate(dir);
  const env = build({ root: dir, baseRef: "HEAD", version: "0.0.0-test" });
  assert.equal(validate(env), undefined);
  return env;
}

const role = (env: Envelope, r: string): Expansion[] => (env.expansions ?? []).filter((e) => e.role === r);

test("a hunk inside a method and a function resolves to exactly those declarations", (t) => {
  const env = run(t, (dir) => {
    edit(dir, "web/src/store.ts", "    this.n++;", "    this.n += 1;");
    edit(dir, "web/src/store.ts", "=> cents;", "=> Math.max(cents, 0);");
  });

  assert.deepEqual(env.files, [{ path: "web/src/store.ts", class: "source", symbols: ["Store.insert", "total"] }]);
  const enclosing = role(env, "enclosing");
  assert.deepEqual(
    enclosing.map((e) => [e.symbol, e.startLine, e.endLine, e.priority]),
    [
      ["Store.insert", 9, 13, 81],
      ["total", 20, 21, 81],
    ],
  );
  const [insert, total] = enclosing;
  assert.equal(insert!.scope, "web/src/store.ts:Store.insert");
  assert.equal(insert!.content, "  /** insert stores a record. */\n  insert(cents: Money): number {\n    this.n += 1;\n    return this.n;\n  }\n");
  assert.deepEqual(insert!.details, { kind: "method", exported: "true", changedLines: "1", container: "Store" });
  assert.equal(total!.content, "// total sums a bill.\nexport const total = (cents: Money): Money => Math.max(cents, 0);\n");
  assert.deepEqual(total!.details, { kind: "function", exported: "true", changedLines: "1" });

  assert.ok(!env.notes?.some((n) => n.startsWith("type-check")), `unexpected type-check notes: ${env.notes}`);
  assert.ok(env.notes?.includes("no caller expansions: nothing outside the change references a changed symbol"));
});

test("a change to a class outside its members emits the class once", (t) => {
  const env = run(t, (dir) => {
    edit(dir, "web/src/store.ts", "/** Store counts the records it was given. */", "/** Store counts every record it was given. */");
    edit(dir, "web/src/store.ts", "    this.n++;", "    this.n += 1;");
  });
  assert.deepEqual(env.files?.[0]?.symbols, ["Store", "Store.insert"]);
  const enclosing = role(env, "enclosing");
  assert.deepEqual(
    enclosing.map((e) => e.symbol),
    ["Store"],
  );
  assert.ok(enclosing[0]!.content.includes("this.n += 1;"));
});

test("an untracked file resolves as a whole", (t) => {
  const env = run(t, (dir) => {
    writeFile(dir, "web/src/fresh.ts", "export function one(): number {\n  return 1;\n}\n\nconst two = 2;\n");
  });
  assert.deepEqual(env.files, [{ path: "web/src/fresh.ts", class: "source", symbols: ["one", "two"] }]);
  assert.deepEqual(
    role(env, "enclosing").map((e) => [e.symbol, e.priority]),
    [
      ["one", 83],
      ["two", 51],
    ],
  );
});

test("a type error degrades to notes and the enclosing role survives", (t) => {
  const env = run(t, (dir) => {
    edit(dir, "web/src/store.ts", "=> cents;", '=> cents + "x";');
  });
  assert.deepEqual(
    role(env, "enclosing").map((e) => e.symbol),
    ["total"],
  );
  assert.ok(env.notes?.includes("1 type-check error(s) in the changed files; symbols they name may not resolve"), `${env.notes}`);
  assert.ok(
    env.notes?.some((n) => /^type-check: web\/src\/store\.ts:21:\d+: TS2322: /.test(n)),
    `${env.notes}`,
  );
});

test("a tree with no tsconfig loads with default options and says so", (t) => {
  const dir = fixtureRepo(t, { "lib/a.ts": "export const a = 1;\n" });
  writeFile(dir, "lib/a.ts", "export const a = 2;\n");
  const env = build({ root: dir, baseRef: "HEAD", version: "0.0.0-test" });
  assert.deepEqual(
    role(env, "enclosing").map((e) => e.symbol),
    ["a"],
  );
  assert.ok(
    env.notes?.includes(
      "no tsconfig.json found above the changed TypeScript files; they were loaded with default compiler options",
    ),
  );
});

test("a change with no TypeScript declaration explains every empty role", (t) => {
  const env = run(t, (dir) => {
    writeFile(dir, "README.md", "# fixture, edited\n");
    removeFile(dir, "web/src/money.ts");
  });
  assert.equal(role(env, "enclosing").length, 0);
  for (const r of ["enclosing", "caller", "type", "sibling", "test"]) {
    assert.ok(env.notes?.includes(`no ${r} expansions: the change resolved to no TypeScript declaration`), r);
  }
  // History is driven from the manifest, not from declarations.
  assert.ok(role(env, "history").some((e) => e.file === "web/src/money.ts"), JSON.stringify(env.expansions));
});

test("build is deterministic", (t) => {
  const dir = fixtureRepo(t, baseFiles);
  edit(dir, "web/src/store.ts", "    this.n++;", "    this.n += 1;");
  writeFile(dir, "web/src/fresh.ts", "export const fresh = 1;\n");
  const first = JSON.stringify(build({ root: dir, baseRef: "HEAD", version: "0.0.0-test" }));
  const second = JSON.stringify(build({ root: dir, baseRef: "HEAD", version: "0.0.0-test" }));
  assert.equal(first, second);
});

// ts-morph does not give TypeScript each file's ESM/CommonJS format, so under
// nodenext an ESM package's import.meta reads as an error. That is the loader's
// blind spot, not the change's, and must not be reported as a type error.
test("a nodenext ESM package does not report module-format errors as type errors", (t) => {
  const dir = fixtureRepo(t, {
    "package.json": JSON.stringify({ name: "esm-fixture", type: "module" }) + "\n",
    "tsconfig.json":
      JSON.stringify({
        compilerOptions: {
          module: "NodeNext",
          moduleResolution: "NodeNext",
          target: "ES2022",
          strict: true,
          skipLibCheck: true,
          noEmit: true,
          types: [],
        },
        include: ["src"],
      }) + "\n",
    "src/where.ts": "export const meta = import.meta;\n",
  });
  writeFile(dir, "src/where.ts", "export const meta = import.meta;\nexport const again = import.meta;\n");
  const env = build({ root: dir, baseRef: "HEAD", version: "0.0.0-test" });

  assert.deepEqual(
    role(env, "enclosing").map((e) => e.symbol),
    ["again"],
  );
  assert.ok(!env.notes?.some((n) => n.includes("type-check")), `${env.notes}`);
  assert.ok(
    // One per import.meta in the changed file.
    env.notes?.some((n) => n.startsWith("2 ESM/CommonJS diagnostic(s) were dropped: ")),
    `${env.notes}`,
  );
});

test("uses of a changed symbol are callers once per declaration, and type uses are reference sites", (t) => {
  const env = run(t, (dir) => {
    edit(dir, "web/src/money.ts", "export type Money = number;", "export type Money = number | bigint;");
  });
  const callers = role(env, "caller");
  // store.ts:21 names Money twice — `(cents: Money): Money` — and ships once.
  // The import on line 3 only moves the name and is not a use. The two uses are
  // in different declarations, so they stay two expansions; two uses in one
  // would now be one, since a caller carries the declaration whole.
  assert.deepEqual(
    callers.map((e) => [e.file, e.details?.["line"], e.details?.["kind"], e.details?.["callerSymbol"]]),
    [
      ["web/src/store.ts", "10", "reference-site", "web/src/store.ts:Store.insert"],
      ["web/src/store.ts", "21", "reference-site", "web/src/store.ts:total"],
    ],
  );
  // A caller is named for the declaration that does the using and says what it
  // reaches in details.calls, the shape the test role already used.
  assert.deepEqual(
    callers.map((e) => [e.symbol, e.scope, e.details?.["calls"]]),
    [
      ["Store.insert", "web/src/store.ts:Store.insert", "web/src/money.ts:Money"],
      ["total", "web/src/store.ts:total", "web/src/money.ts:Money"],
    ],
  );
});
