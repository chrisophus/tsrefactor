import assert from "node:assert/strict";
import { test } from "node:test";

import { changedFiles, gitOutput, gitRepoEnvVars, mergeBase, parseNameStatus, sanitizedGitEnv } from "../src/git.ts";
import { fixtureRepo, git, removeFile, writeFile } from "./helpers.ts";

test("parseNameStatus keeps the new path of a rename or copy", () => {
  const raw = ["M", "a.ts", "R087", "old.ts", "new.ts", "C100", "src.ts", "copy.ts", "D", "gone.ts", ""].join("\x00");
  assert.deepEqual(parseNameStatus(raw), [
    { path: "a.ts", status: "M" },
    { path: "new.ts", status: "R087" },
    { path: "copy.ts", status: "C100" },
    { path: "gone.ts", status: "D" },
  ]);
  // A truncated record is dropped rather than misread.
  assert.deepEqual(parseNameStatus("R100\x00only-old.ts\x00"), []);
});

test("sanitizedGitEnv strips every repo-locating variable", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/bin", HOME: "/home/x" };
  for (const v of gitRepoEnvVars) env[v] = "/elsewhere";
  assert.deepEqual(sanitizedGitEnv(env), { PATH: "/bin", HOME: "/home/x" });
});

test("git calls ignore an inherited GIT_DIR", (t) => {
  const dir = fixtureRepo(t, { "a.ts": "export {};\n" });
  const saved = process.env["GIT_DIR"];
  process.env["GIT_DIR"] = "/nonexistent/.git";
  t.after(() => {
    if (saved === undefined) delete process.env["GIT_DIR"];
    else process.env["GIT_DIR"] = saved;
  });
  assert.equal(gitOutput(dir, "rev-parse", "--show-toplevel").trim(), dir);
});

test("changedFiles lists tracked and untracked changes, sorted", (t) => {
  const dir = fixtureRepo(t, {
    "src/keep.ts": "export const keep = 1;\n",
    "src/edit.ts": "export const edit = 1;\n",
    "src/gone.ts": "export const gone = 1;\n",
    ".gitignore": "ignored.ts\n",
  });
  const base = git(dir, "rev-parse", "HEAD").trim();
  writeFile(dir, "src/edit.ts", "export const edit = 2;\n");
  removeFile(dir, "src/gone.ts");
  writeFile(dir, "src/added.ts", "export const added = 1;\n");
  writeFile(dir, "ignored.ts", "export {};\n");

  assert.deepEqual(changedFiles(dir, base), [
    { path: "src/added.ts", status: "A" },
    { path: "src/edit.ts", status: "M" },
    { path: "src/gone.ts", status: "D" },
  ]);
});

test("mergeBase finds the common ancestor with HEAD", (t) => {
  const dir = fixtureRepo(t, { "a.ts": "export const a = 1;\n" });
  const first = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "checkout", "-q", "-b", "feature");
  writeFile(dir, "a.ts", "export const a = 2;\n");
  git(dir, "commit", "-q", "-am", "feature");
  git(dir, "checkout", "-q", "main");
  writeFile(dir, "b.ts", "export const b = 1;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "main moves on");
  git(dir, "checkout", "-q", "feature");

  assert.equal(mergeBase(dir, "main"), first);
});

test("mergeBase falls back to the ref when there is no common ancestor", (t) => {
  const dir = fixtureRepo(t, { "a.ts": "export const a = 1;\n" });
  const first = git(dir, "rev-parse", "HEAD").trim();
  git(dir, "checkout", "-q", "--orphan", "unrelated");
  git(dir, "commit", "-q", "-m", "unrelated root");

  assert.equal(mergeBase(dir, first), first);
  assert.throws(() => mergeBase(dir, "no-such-ref"), /git rev-parse --verify no-such-ref\^\{commit\}/);
});
