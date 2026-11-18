// The redline review profile keeps the fields the studio and the gate depend on. Which body
// sections reviews show is the operator's preference and is deliberately not pinned here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const profile = readFileSync(new URL("../.github/redline-review.yml", import.meta.url), "utf8");
const lines = profile
  .split("\n")
  .map((l) => {
    const hash = l.search(/\s#/);
    return (hash === -1 ? l : l.slice(0, hash)).trim();
  })
  .filter((l) => l !== "" && !l.startsWith("#"));

// Top-level keys to their values: a scalar string, or a list from the inline `[a, b]` or the
// block `- a` form.
const fields = new Map<string, string | string[]>();
let listKey: string | undefined;
for (const line of lines) {
  if (line.startsWith("- ") && listKey !== undefined) {
    (fields.get(listKey) as string[]).push(line.slice(2).trim());
    continue;
  }
  const colon = line.indexOf(":");
  const key = line.slice(0, colon);
  if (colon === -1 || !/^[a-z_]+$/.test(key)) continue;
  const value = line.slice(colon + 1).trim();
  listKey = undefined;
  if (value === "") {
    fields.set(key, []);
    listKey = key;
  } else if (value.startsWith("[")) {
    fields.set(
      key,
      value
        .replaceAll(/[[\]]/g, "")
        .split(",")
        .map((x) => x.trim())
        .filter((x) => x !== ""),
    );
  } else {
    fields.set(key, value);
  }
}

// The body sections Redline knows (internal/post/profile.go in redline).
const knownSections = new Set([
  "intent",
  "composition",
  "line-counts",
  "test-totals",
  "generated-totals",
  "evidence",
  "coverage",
  "lint",
  "confirmations",
  "unknowns",
  "low-confidence",
  "diff-links",
]);

test("review profile loads", () => {
  assert.ok(fields.size > 0);
  for (const line of lines) assert.match(line, /^([a-z_]+:|- )/, line);
});

test("review profile keeps the gate fields", () => {
  assert.equal(fields.get("review_marker"), "redline-review:v1");
  assert.equal(fields.get("finding_marker"), "redline-finding:v1");
  assert.equal(fields.get("require_head"), "true");
  assert.equal(fields.get("fail_closed_pane"), "false");
});

test("review profile blocks on error and warning", () => {
  const blocking = new Set(fields.get("blocking"));
  assert.ok(blocking.has("error"));
  assert.ok(blocking.has("warning"));
});

test("review profile body_include lists only sections Redline knows", () => {
  const entries = fields.get("body_include") ?? [];
  assert.ok(Array.isArray(entries));
  for (const entry of entries) {
    assert.ok(knownSections.has(entry), `unknown body section: ${entry}`);
  }
});
