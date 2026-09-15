// The bug tsrefactor exists to catch, reproduced without the repository it was
// found in. A review missed that a panel's React Query keys were not covered by
// the page's refresh invalidation, because nothing in the review packet showed
// the page calling useRefreshQueries: the hook reaches the page through
// a barrel re-export and a destructured return, which a syntax-only parser does
// not bind. These tests pin that the caller role now carries that edge.
//
// The fixture has no node_modules on purpose. React's types cannot resolve, and
// the references must resolve anyway.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";

import { build } from "../src/build.ts";
import { validate, type Envelope, type Expansion } from "../src/envelope.ts";
import { fixtureRepo, writeFile } from "./helpers.ts";

const hookPath = "app/src/hooks/useRefreshQueries.ts";
const panelPath = "app/src/components/detail/DetailExpansionPanel.tsx";
const pagePath = "app/src/pages/DashboardPage.tsx";

const files: Record<string, string> = {
  "app/tsconfig.json":
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          jsx: "react-jsx",
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
  [hookPath]: `// useRefreshQueries refreshes the queries a view shows.
export function useRefreshQueries(keys: readonly string[][]) {
  const refresh = () => keys.length;
  return { refresh, isRefreshing: false };
}
`,
  "app/src/hooks/index.ts": `export { useRefreshQueries } from "./useRefreshQueries";\n`,
  [panelPath]: `export function DetailExpansionPanel({ itemId }: { itemId: string }) {
  const queryKey = ["buyers", "focus", itemId];
  return <section data-key={queryKey.join("/")}>{itemId}</section>;
}
`,
  [pagePath]: `import { useRefreshQueries } from "../hooks";
import { DetailExpansionPanel } from "../components/detail/DetailExpansionPanel";

const refreshQueryKeys = [["buyers", "list"]];

export function DashboardPage({ itemId }: { itemId: string }) {
  const { refresh } = useRefreshQueries(refreshQueryKeys);
  return (
    <main>
      <button onClick={refresh}>Refresh</button>
      <DetailExpansionPanel itemId={itemId} />
    </main>
  );
}
`,
  "app/src/pages/DashboardPage.test.tsx": `import { useRefreshQueries } from "../hooks";

describe("DashboardPage refresh", () => {
  it("invalidates the list", () => {
    const { refresh } = useRefreshQueries([["buyers", "list"]]);
    expect(refresh()).toBe(1);
  });
});
`,
};

function run(t: TestContext, rel: string, from: string, to: string): Envelope {
  const dir = fixtureRepo(t, files);
  assert.equal(existsSync(join(dir, "node_modules")) || existsSync(join(dir, "app", "node_modules")), false);
  const content = readFileSync(join(dir, rel), "utf8");
  assert.ok(content.includes(from), `fixture ${rel} lacks ${JSON.stringify(from)}`);
  writeFile(dir, rel, content.replace(from, to));
  const env = build({ root: dir, baseRef: "HEAD", version: "0.0.0-test" });
  assert.equal(validate(env), undefined);
  return env;
}

const ofRole = (env: Envelope, role: string): Expansion[] => (env.expansions ?? []).filter((e) => e.role === role);

test("changing the hook puts the page's destructured call through the barrel in the caller role", (t) => {
  const env = run(t, hookPath, "keys: readonly string[][])", "keys: readonly string[][], exact = false)");

  assert.deepEqual(env.files, [{ path: hookPath, class: "source", symbols: ["useRefreshQueries"] }]);
  const callers = ofRole(env, "caller");
  const call = callers.find((e) => e.file === pagePath && e.details?.["line"] === "7");
  assert.ok(call, `no caller at ${pagePath}:7; callers = ${JSON.stringify(callers, null, 2)}`);
  assert.equal(call.symbol, "useRefreshQueries");
  assert.equal(call.scope, `${hookPath}:useRefreshQueries`);
  assert.deepEqual(call.details, {
    kind: "call-site",
    line: "7",
    callerSymbol: `${pagePath}:DashboardPage`,
    callerKind: "function",
  });
  assert.ok(call.content.includes("const { refresh } = useRefreshQueries(refreshQueryKeys);"), call.content);
  assert.equal(call.startLine, 5);
  assert.equal(call.endLine, 9);

  // The barrel's re-export and the page's import move the name; they are not uses.
  assert.deepEqual(
    callers.map((e) => `${e.file}:${e.details?.["line"]}`),
    [`${pagePath}:7`],
  );

  // The test reaching the hook ships whole, once, under its describe path.
  const tests = ofRole(env, "test");
  assert.deepEqual(
    tests.map((e) => [e.symbol, e.startLine, e.endLine, e.details]),
    [
      [
        "DashboardPage refresh > invalidates the list",
        4,
        7,
        {
          kind: "test",
          covers: `${hookPath}:useRefreshQueries`,
          testFor: "useRefreshQueries",
        },
      ],
    ],
  );
});

test("changing the panel's query keys puts the page's JSX usage in the caller role", (t) => {
  const env = run(t, panelPath, '["buyers", "focus", itemId]', '["buyers", "focus", itemId, "expanded"]');

  assert.deepEqual(env.files, [{ path: panelPath, class: "source", symbols: ["DetailExpansionPanel"] }]);
  const callers = ofRole(env, "caller");
  assert.deepEqual(
    callers.map((e) => [e.file, e.symbol, e.details]),
    [
      [
        pagePath,
        "DetailExpansionPanel",
        {
          kind: "call-site",
          syntax: "jsx",
          line: "11",
          callerSymbol: `${pagePath}:DashboardPage`,
          callerKind: "function",
        },
      ],
    ],
  );
  assert.ok(callers[0]!.content.includes("<DetailExpansionPanel itemId={itemId} />"));
  assert.ok(
    env.notes?.includes("no test expansions: no test outside the change reaches a changed symbol"),
    `${env.notes}`,
  );
});
