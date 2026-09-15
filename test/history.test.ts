import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";

import { build } from "../src/build.ts";
import { roleRank, type Envelope, type Expansion } from "../src/envelope.ts";
import { rankedRanges } from "../src/expand.ts";
import { parseRemovedHunkHeader } from "../src/git.ts";
import { git, tempDir, writeFile } from "./helpers.ts";

// commitAll commits the working tree with a subject a history assertion can find.
function commitAll(dir: string, subject: string): void {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", subject);
}

function emptyRepo(t: TestContext): string {
  const dir = tempDir(t);
  git(dir, "init", "-q");
  return dir;
}

const buildAt = (dir: string): Envelope => build({ root: dir, baseRef: "HEAD", version: "0.0.0-test" });
const ofRole = (env: Envelope, role: string): Expansion[] => (env.expansions ?? []).filter((e) => e.role === role);

// storeCommit wrote the counter line; guardCommit added the guard above it.
const storeCommit = "add the store: insert counts the records it is given";
const guardCommit = "reject a record with no identity: an empty ID overwrote the last row";

// historyFixture commits twice, then deletes a line above the counter and
// rewrites the counter. The deletion shifts the counter up one line, so the
// working-tree position of the rewrite names the guard's closing brace at base:
// a walk with the wrong coordinates reaches guardCommit instead of storeCommit.
function historyFixture(t: TestContext): string {
  const dir = emptyRepo(t);
  writeFile(
    dir,
    "store.ts",
    "let n = 0;\n\n// insert stores a record.\nexport function insert(id: string): number {\n  n++;\n  return n;\n}\n",
  );
  commitAll(dir, storeCommit);
  writeFile(
    dir,
    "store.ts",
    'let n = 0;\n\n// insert stores a record.\nexport function insert(id: string): number {\n  if (id === "") {\n    return -1;\n  }\n  n++;\n  return n;\n}\n',
  );
  commitAll(dir, guardCommit);
  writeFile(
    dir,
    "store.ts",
    'let n = 0;\n// insert stores a record.\nexport function insert(id: string): number {\n  if (id === "") {\n    return -1;\n  }\n  n += 1;\n  return n;\n}\n',
  );
  return dir;
}

test("history walks the base-side span of a hunk and reports working-tree lines", (t) => {
  const env = buildAt(historyFixture(t));
  const hist = ofRole(env, "history").find((e) => e.details?.["kind"] === "line-history" && e.startLine === 7);
  assert.ok(hist, `no line-history expansion at line 7: ${JSON.stringify(ofRole(env, "history"))}`);
  assert.ok(hist.content.includes(storeCommit), `history does not reach the commit that wrote the line:\n${hist.content}`);
  assert.ok(!hist.content.includes(guardCommit), `history walked the wrong span:\n${hist.content}`);
  assert.equal(hist.symbol, "insert");
  assert.equal(hist.scope, "store.ts:insert");
  assert.deepEqual(hist.details, { kind: "line-history", lines: "7-7", baseLines: "8-8", revisions: "3" });
  assert.equal(hist.priority, 81);
});

// Pins the two fields the consumer ranks by.
test("expansions are grouped by role rank with priority descending within a role", (t) => {
  const env = buildAt(historyFixture(t));
  let last = -1;
  const prev = new Map<string, number>();
  for (const e of env.expansions ?? []) {
    const [rank, known] = roleRank(e.role);
    assert.ok(known, `unranked role ${e.role}`);
    assert.ok(rank >= last, `${e.role} after rank ${last}`);
    last = rank;
    const p = prev.get(e.role);
    assert.ok(p === undefined || (e.priority ?? 0) <= p, `${e.role} priority ${e.priority} follows ${p}`);
    prev.set(e.role, e.priority ?? 0);
  }
  assert.ok(ofRole(env, "removal").length > 0 && ofRole(env, "history").length > 0);
});

// A deletion is where history earns its place: the lines are gone, so the diff
// carries no trace of why they were there, and a guard removed on purpose reads
// exactly like a simplification.
test("the history of deleted lines reaches the commit that added them, ranked ahead of history", (t) => {
  const dir = emptyRepo(t);
  const plain = "export function drain(items: string[]): string[] {\n  const out: string[] = [];\n  for (const it of items) {\n    out.push(it);\n  }\n  return out;\n}\n";
  const guarded = plain.replace("    out.push(it);\n", '    if (it === "") {\n      continue;\n    }\n    out.push(it);\n');
  writeFile(dir, "queue.ts", plain);
  commitAll(dir, "add the queue");
  writeFile(dir, "queue.ts", guarded);
  commitAll(dir, "skip empty entries: a nil from the retry path panicked in production");
  writeFile(dir, "queue.ts", plain);

  const env = buildAt(dir);
  const removal = ofRole(env, "removal");
  const hit = removal.find((e) => e.content.includes("panicked in production"));
  assert.ok(hit, `the deleted guard's commit did not reach the removal role: ${JSON.stringify(removal)}`);
  assert.equal(hit.priority, 120);
  assert.deepEqual(hit.details, { kind: "removed-line-history", lines: "4-6 at the base revision", revisions: "3" });
  assert.equal(hit.startLine, 4);
  assert.equal(hit.endLine, 6);

  const exps = env.expansions ?? [];
  const firstRemoval = exps.findIndex((e) => e.role === "removal");
  const firstHistory = exps.findIndex((e) => e.role === "history");
  assert.ok(firstHistory < 0 || firstRemoval < firstHistory, "removal must rank ahead of history");
});

// A deleted file resolves to no declaration at all, so history is the only
// thing left that can say why the code existed.
test("a deleted file still carries its history", (t) => {
  const dir = emptyRepo(t);
  const subject = "add the drain: the retry path needed a copy it could keep";
  writeFile(dir, "drain.ts", "// drain copies the items.\nexport function drain(items: string[]): string[] {\n  return [...items];\n}\n");
  commitAll(dir, subject);
  git(dir, "rm", "-q", "drain.ts");

  const env = buildAt(dir);
  assert.deepEqual(env.files, [{ path: "drain.ts", class: "source" }]);
  assert.ok(
    ofRole(env, "history").some((e) => e.content.includes(subject)),
    `no history names the commit that added the file; notes = ${env.notes}`,
  );
  assert.ok(env.notes?.includes("no enclosing expansions: the change resolved to no TypeScript declaration"));
});

test("history traces at most three spans per file, the longest, and says what it dropped", (t) => {
  const dir = emptyRepo(t);
  const lines = Array.from({ length: 20 }, (_, i) => `export const v${i + 1} = ${i + 1};`);
  writeFile(dir, "values.ts", lines.join("\n") + "\n");
  commitAll(dir, "add the values");
  const edited = [...lines];
  for (const i of [2, 5, 6, 7, 10, 13, 14, 18]) {
    edited[i - 1] = `export const v${i} = ${i * 100};`;
  }
  writeFile(dir, "values.ts", edited.join("\n") + "\n");

  const env = buildAt(dir);
  const spans = ofRole(env, "history")
    .map((e) => [e.startLine, e.endLine])
    .sort((a, c) => a[0]! - c[0]!);
  assert.deepEqual(spans, [
    [2, 2],
    [5, 7],
    [13, 14],
  ]);
  assert.ok(env.notes?.includes("2 further changed span(s) of values.ts were not traced (cap 3 per file)"), `${env.notes}`);
});

test("parseRemovedHunkHeader reads the base side", () => {
  assert.deepEqual(parseRemovedHunkHeader("@@ -40,6 +39,0 @@ function x() {"), { start: 40, end: 45 });
  assert.deepEqual(parseRemovedHunkHeader("@@ -1 +1 @@"), { start: 1, end: 1 });
  assert.equal(parseRemovedHunkHeader("@@ -3,0 +4,2 @@"), undefined);
  assert.equal(parseRemovedHunkHeader("@@ -0,0 +1,5 @@"), undefined);
});

test("rankedRanges keeps the longest spans in position order", () => {
  const [kept, dropped] = rankedRanges(
    [
      { start: 1, end: 1 },
      { start: 4, end: 9 },
      { start: 12, end: 12 },
      { start: 15, end: 17 },
    ],
    2,
  );
  assert.deepEqual(kept, [
    { start: 4, end: 9 },
    { start: 15, end: 17 },
  ]);
  assert.equal(dropped, 2);
});
