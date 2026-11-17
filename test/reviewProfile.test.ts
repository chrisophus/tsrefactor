// The redline review profile keeps reviews terse and keeps the markers the studio gate reads.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const profile = readFileSync(new URL("../.github/redline-review.yml", import.meta.url), "utf8");
const lines = new Set(profile.split("\n").filter((l) => !l.startsWith("#")));

test("review profile uses the lean walkthrough with no body sections", () => {
  assert.ok(lines.has("body_style: walkthrough"));
  assert.ok(lines.has("body_include: []"));
});

test("review profile keeps the gate fields", () => {
  for (const line of [
    "review_marker: redline-review:v1",
    "finding_marker: redline-finding:v1",
    "blocking: [error, warning]",
    "require_head: true",
    "fail_closed_pane: true",
  ]) {
    assert.ok(lines.has(line), line);
  }
});
