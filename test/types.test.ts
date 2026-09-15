import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { build } from "../src/build.ts";
import { validate, type Envelope, type Expansion } from "../src/envelope.ts";
import { fixtureRepo, writeFile } from "./helpers.ts";

const tsconfig =
  JSON.stringify({
    compilerOptions: {
      strict: true,
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["src"],
  }) + "\n";

const files: Record<string, string> = {
  "tsconfig.json": tsconfig,
  "src/types.ts": `export interface Record {
  id: string;
}

export type RecordId = string;

export type Maybe<T> = T | undefined;

export interface Writer {
  insert(r: Record): Promise<void>;
}

export interface Repo<T> {
  get(id: RecordId): Maybe<T>;
}

export interface Loose {
  label?: string;
}
`,
  "src/store.ts": `import type { Record, Writer } from "./types";

export class Store implements Writer {
  count = 0;

  async insert(r: Record): Promise<void> {
    this.count++;
  }
}

export function fresh() {
  return { id: "fresh" } as Record;
}
`,
  "src/mem.ts": `import type { Record } from "./types";

// MemStore satisfies Writer structurally, with no implements clause.
export class MemStore {
  items: Record[] = [];

  async insert(r: Record): Promise<void> {
    this.items.push(r);
  }
}
`,
  "src/repos.ts": `import type { Maybe, Record, RecordId, Repo } from "./types";

export class UserRepo implements Repo<Record> {
  get(id: RecordId): Maybe<Record> {
    return undefined;
  }
}

export class OrderRepo implements Repo<Record> {
  get(id: RecordId): Maybe<Record> {
    return { id };
  }
}
`,
  "src/labels.ts": `export class Tagged {
  label = "tag";
  tag = 1;
}

export class Badge {
  label = "badge";
  color = "red";
}
`,
};

function run(t: TestContext, edits: Array<[rel: string, from: string, to: string]>, base = files): Envelope {
  const dir = fixtureRepo(t, base);
  for (const [rel, from, to] of edits) {
    const content = readFileSync(join(dir, rel), "utf8");
    assert.ok(content.includes(from), `fixture ${rel} lacks ${JSON.stringify(from)}`);
    writeFile(dir, rel, content.replace(from, to));
  }
  const env = build({ root: dir, baseRef: "HEAD", version: "0.0.0-test" });
  assert.equal(validate(env), undefined);
  assert.ok(!env.notes?.some((n) => n.startsWith("type-check")), `unexpected type-check notes: ${env.notes}`);
  return env;
}

const ofRole = (env: Envelope, role: string): Expansion[] => (env.expansions ?? []).filter((e) => e.role === role);

test("a changed method's signature brings its project types, not library ones, and its class's siblings", (t) => {
  const env = run(t, [["src/store.ts", "    this.count++;", "    this.count += 1;"]]);

  assert.deepEqual(
    ofRole(env, "type").map((e) => [e.symbol, e.file, e.priority, e.details]),
    [["Record", "src/types.ts", 81, { kind: "type", referencedBy: "src/store.ts:Store.insert" }]],
  );
  assert.equal(ofRole(env, "type")[0]!.content, "export interface Record {\n  id: string;\n}\n");

  // MemStore has no implements clause; it is a sibling because it is assignable.
  assert.deepEqual(
    ofRole(env, "sibling").map((e) => [e.symbol, e.file, e.priority, e.details]),
    [
      [
        "MemStore",
        "src/mem.ts",
        80,
        { kind: "implementation", interface: "src/types.ts:Writer", peerOf: "src/store.ts:Store" },
      ],
    ],
  );
  assert.ok(ofRole(env, "sibling")[0]!.content.startsWith("// MemStore satisfies Writer structurally"));
});

test("aliases the checker erases are still found, and a generic interface's siblings come from its clause", (t) => {
  const env = run(t, [["src/repos.ts", "    return undefined;", "    return void 0;"]]);

  assert.deepEqual(
    ofRole(env, "type")
      .map((e) => e.symbol)
      .sort(),
    ["Maybe", "Record", "RecordId"],
  );
  assert.deepEqual(
    ofRole(env, "sibling").map((e) => [e.symbol, e.details]),
    [["OrderRepo", { kind: "implementation", interface: "src/types.ts:Repo", peerOf: "src/repos.ts:UserRepo" }]],
  );
});

test("an inferred return type is walked", (t) => {
  const env = run(t, [["src/store.ts", '{ id: "fresh" }', '{ id: "fresh-1" }']]);
  assert.deepEqual(
    ofRole(env, "type").map((e) => [e.symbol, e.details?.["referencedBy"]]),
    [["Record", "src/store.ts:fresh"]],
  );
  assert.ok(env.notes?.includes("no sibling expansions: no changed class implements an interface declared in this project"));
});

test("an interface with no required member does not make siblings", (t) => {
  // Tagged and Badge both satisfy Loose, whose only member is optional.
  const env = run(t, [["src/labels.ts", "  tag = 1;", "  tag = 2;"]]);
  assert.equal(ofRole(env, "sibling").length, 0);
  assert.ok(env.notes?.includes("no sibling expansions: no changed class implements an interface declared in this project"));
});

test("a type the change also edits is not emitted again", (t) => {
  const env = run(t, [
    ["src/types.ts", "  id: string;\n}", "  id: string;\n  name?: string;\n}"],
    ["src/store.ts", "    this.count++;", "    this.count += 1;"],
  ]);
  assert.equal(ofRole(env, "type").length, 0);
  assert.ok(
    env.notes?.includes("no type expansions: the changed signatures name no type declared outside the change"),
    `${env.notes}`,
  );
});

test("siblings are capped per interface, and the cap says what it dropped", (t) => {
  const classes = Array.from({ length: 14 }, (_, i) => {
    const name = `H${String(i + 1).padStart(2, "0")}`;
    return `export class ${name} {\n  handle(): void {}\n}\n`;
  });
  const env = run(
    t,
    [["src/handlers.ts", "export class H01 {\n  handle(): void {}", "export class H01 {\n  handle(): void {\n    return;\n  }"]],
    {
      "tsconfig.json": tsconfig,
      "src/handlers.ts": `export interface Handler {\n  handle(): void;\n}\n\n${classes.join("\n")}`,
    },
  );
  assert.deepEqual(
    ofRole(env, "sibling").map((e) => e.symbol),
    ["H02", "H03", "H04", "H05", "H06", "H07", "H08", "H09", "H10", "H11", "H12", "H13"],
  );
  assert.ok(
    env.notes?.includes("1 further implementation(s) of src/handlers.ts:Handler were not expanded (cap 12 per interface)"),
    `${env.notes}`,
  );
});
