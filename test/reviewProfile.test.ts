// The redline review profile keeps reviews terse and keeps the markers the studio gate reads.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const profile = readFileSync(new URL("../.github/redline-review.yml", import.meta.url), "utf8");
const lines = new Set(profile.split("\n").filter((l) => !l.startsWith("#")));

test("review profile uses the walkthrough with the chosen sections", () => {
  assert.ok(lines.has("body_style: walkthrough"));
  const included = [...lines].filter((l) => l.startsWith("  - ")).map((l) => l.slice(4).split(/\s/, 1)[0]);
  assert.deepEqual(included, ["line-counts", "test-totals", "generated-totals", "low-confidence", "diff-links"]);
});

test("review profile keeps the gate fields", () => {
  for (const line of [
    "review_marker: redline-review:v1",
    "finding_marker: redline-finding:v1",
    "blocking: [error, warning]",
    "require_head: true",
    "fail_closed_pane: false",
  ]) {
    assert.ok(lines.has(line), line);
  }
});
