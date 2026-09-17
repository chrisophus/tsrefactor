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
import { appPath, bugFixture, hookPath, pagePath, panelPath } from "./bugFixture.ts";
import { fixtureRepo, writeFile } from "./helpers.ts";

function run(t: TestContext, rel: string, from: string, to: string): Envelope {
  const dir = fixtureRepo(t, bugFixture);
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
  assert.equal(call.symbol, "DashboardPage");
  assert.equal(call.scope, `${pagePath}:DashboardPage`);
  assert.deepEqual(call.details, {
    kind: "call-site",
    calls: `${hookPath}:useRefreshQueries`,
    line: "7",
    callerSymbol: `${pagePath}:DashboardPage`,
    callerKind: "function",
  });
  assert.ok(call.content.includes("const { refresh } = useRefreshQueries(refreshQueryKeys);"), call.content);
  // The whole component, not a window around the call. This is the half of the
  // bug the window could not reach: the page renders DetailExpansionPanel, whose
  // query keys refreshQueryKeys does not cover, and the render is four lines
  // below the call. The old span stopped at line 9, on `<main>`.
  assert.equal(call.startLine, 6);
  assert.equal(call.endLine, 14);
  assert.ok(call.content.includes("<DetailExpansionPanel itemId={itemId} />"), call.content);

  // The barrel's re-export and the page's import move the name; they are not uses.
  assert.deepEqual(
    callers.map((e) => `${e.file}:${e.details?.["line"]}`),
    [`${pagePath}:7`],
  );

  // Two tests, and they reach the hook by different routes. The first names it
  // and is found by the walk over references to the change. The second never
  // names it: it renders the page, which calls it, and is found at the second
  // hop -- the case the role matching on named symbols reported nothing for.
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
      [
        "DashboardPage > renders the panel",
        4,
        6,
        { kind: "test", hop: "2", reaches: `${pagePath}:DashboardPage` },
      ],
    ],
  );
});

test("changing the panel's query keys puts the page's JSX usage in the caller role", (t) => {
  const env = run(t, panelPath, '["items", "detail", itemId]', '["items", "detail", itemId, "expanded"]');

  assert.deepEqual(env.files, [{ path: panelPath, class: "source", symbols: ["DetailExpansionPanel"] }]);
  const callers = ofRole(env, "caller");
  assert.deepEqual(
    callers.map((e) => [e.file, e.symbol, e.details]),
    [
      [
        pagePath,
        "DashboardPage",
        {
          kind: "call-site",
          calls: `${panelPath}:DetailExpansionPanel`,
          syntax: "jsx",
          line: "11",
          callerSymbol: `${pagePath}:DashboardPage`,
          callerKind: "function",
        },
      ],
    ],
  );
  assert.ok(callers[0]!.content.includes("<DetailExpansionPanel itemId={itemId} />"));
  // No test names the panel, and until the second hop that read as no test at
  // all. The page's render test is the check that would catch a key change,
  // because the page renders the panel.
  assert.deepEqual(
    ofRole(env, "test").map((e) => [e.symbol, e.details?.["hop"], e.details?.["reaches"]]),
    [["DashboardPage > renders the panel", "2", `${pagePath}:DashboardPage`]],
  );
});

// The same miss from the other end. When the page itself is what changed, the
// question is not who calls the page but what the page reaches: the hook whose
// keys it refreshes, and the panel whose keys it renders. Neither is visible
// from a caller of DashboardPage, and both are callees of it.
test("changing the page puts the hook it refreshes and the panel it renders in the callee role", (t) => {
  const env = run(t, pagePath, "<button onClick={refresh}>Refresh</button>", "<button onClick={refresh}>Reload</button>");

  const callees = ofRole(env, "callee");
  assert.deepEqual(
    callees
      .map((e) => [e.symbol, e.file, e.details?.["calledBy"]])
      .sort((a, z) => (a[0] ?? "").localeCompare(z[0] ?? "")),
    [
      ["DetailExpansionPanel", panelPath, `${pagePath}:DashboardPage`],
      ["useRefreshQueries", hookPath, `${pagePath}:DashboardPage`],
    ],
  );
  // The panel arrives through JSX, which is a call in every sense a reviewer
  // cares about, and through a barrel-free direct import; the hook arrives
  // through the barrel re-export, which is the edge a syntax parser cannot bind.
  const panel = callees.find((e) => e.symbol === "DetailExpansionPanel");
  assert.ok(panel, "no callee for the panel");
  assert.ok(panel.content.includes('["items", "detail", itemId]'), panel.content);
});

// The second hop. App never names useRefreshQueries; it reaches it through
// DashboardPage, and whether the hook's new argument matters can be decided
// there -- App renders the page with no refresh of its own.
test("changing the hook puts the page's own caller in the indirect-caller role", (t) => {
  const env = run(t, hookPath, "keys: readonly string[][])", "keys: readonly string[][], exact = false)");

  const indirect = ofRole(env, "indirect-caller");
  assert.deepEqual(
    indirect.map((e) => [e.symbol, e.file, e.details?.["hop"], e.details?.["reaches"]]),
    [["App", appPath, "2", `${pagePath}:DashboardPage`]],
  );
  assert.ok(indirect[0]!.content.includes("<DashboardPage itemId=\"a\" />"), indirect[0]!.content);
});

// Item 4d: the test that checks the page never names the hook. It exercises
// DashboardPage, which calls useRefreshQueries, so a change to the hook is
// most likely to surface there -- and the test role, which matches tests that
// name a changed symbol, reported nothing.
test("changing the hook finds the test that reaches it through the page", (t) => {
  const env = run(t, hookPath, "keys: readonly string[][])", "keys: readonly string[][], exact = false)");

  const hopTests = ofRole(env, "test").filter((e) => e.details?.["hop"] === "2");
  assert.deepEqual(
    hopTests.map((e) => [e.symbol, e.details?.["reaches"]]),
    [["DashboardPage > renders the panel", `${pagePath}:DashboardPage`]],
  );
});
