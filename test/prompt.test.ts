import assert from "node:assert/strict";
import { test } from "node:test";

import { build } from "../src/build.ts";
import { promptFragment } from "../src/prompt.ts";
import { fixtureRepo, writeFile } from "./helpers.ts";

test("every envelope carries the TypeScript prompt fragment, even one with no TypeScript", (t) => {
  const dir = fixtureRepo(t, { "README.md": "# fixture\n" });
  writeFile(dir, "README.md", "# fixture, edited\n");
  const env = build({ root: dir, baseRef: "HEAD", version: "0.0.0-test" });
  assert.equal(env.promptFragment, promptFragment);
});

test("the prompt fragment covers each idiom section", () => {
  assert.ok(promptFragment.startsWith("Reviewing TypeScript.\n"));
  const sections = promptFragment.trim().split("\n\n");
  assert.equal(sections.length, 8, "a heading and seven sections, parallel to gorefactor's");
  for (const marker of [
    "promise nobody awaits", // async error handling
    "unknown is checked and any is not", // unknown vs any, assertions
    "?? and ||", // nullish semantics
    "Typing is structural", // structural typing, exhaustiveness
    "React hooks run in the same order", // hooks, dependency arrays, cleanup, query keys
    "Tests usually sit beside the code", // test conventions
    "Load-bearing idioms", // idioms
  ]) {
    assert.ok(promptFragment.includes(marker), marker);
  }
});

// The consumer owns output format; a language fragment that talks about it
// competes with the harness instead of informing it.
test("the prompt fragment says nothing about output format", () => {
  for (const word of [/\bfindings?\b/i, /\bschema\b/i, /\bseverity\b/i, /\boutput format\b/i, /\brespond\b/i]) {
    assert.doesNotMatch(promptFragment, word);
  }
});
