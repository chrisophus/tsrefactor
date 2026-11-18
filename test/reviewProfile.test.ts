// The redline review profile keeps the fields the studio and the gate depend on. Which body
// sections reviews show is the operator's preference and is deliberately not pinned here.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const profile = readFileSync(new URL("../.github/redline-review.yml", import.meta.url), "utf8");
const lines = profile
  .split("\n")
  .map((l) => l.trim())
  .filter((l) => l !== "" && !l.startsWith("#"));
const lineSet = new Set(lines);

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
  assert.ok(lines.length > 0);
  for (const line of lines) assert.match(line, /^[a-z_]+:/, line);
});

test("review profile keeps the gate fields", () => {
  for (const line of [
    "review_marker: redline-review:v1",
    "finding_marker: redline-finding:v1",
    "require_head: true",
    "fail_closed_pane: true",
  ]) {
    assert.ok(lineSet.has(line), line);
  }
});

test("review profile blocks on error and warning", () => {
  const line = lines.find((l) => l.startsWith("blocking:"));
  assert.ok(line, "blocking is set");
  const levels = new Set(line
    .slice("blocking:".length)
    .replaceAll(/[[\]]/g, "")
    .split(",")
    .map((s) => s.trim()));
  assert.ok(levels.has("error"));
  assert.ok(levels.has("warning"));
});

test("review profile body_include lists only sections Redline knows", () => {
  const start = lines.findIndex((l) => l.startsWith("body_include:"));
  if (start === -1) return;
  const inline = lines[start]!.slice("body_include:".length).replaceAll(/[[\]]/g, "").trim();
  const entries = inline ? inline.split(",").map((s) => s.trim()) : [];
  for (const l of lines.slice(start + 1)) {
    if (!l.startsWith("- ")) break;
    entries.push(l.slice(2).trim());
  }
  for (const entry of entries.filter((e) => e !== "")) {
    assert.ok(knownSections.has(entry), `unknown body section: ${entry}`);
  }
});
