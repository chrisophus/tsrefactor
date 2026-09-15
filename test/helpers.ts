import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestContext } from "node:test";

import { sanitizedGitEnv } from "../src/git.ts";

export const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

// git runs a git command in a fixture repository with a fixed identity, and
// fails the test with git's own output if it fails.
export function git(dir: string, ...args: string[]): string {
  const res = spawnSync(
    "git",
    [
      "-C",
      dir,
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "user.name=Fixture",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "init.defaultBranch=main",
      ...args,
    ],
    { env: sanitizedGitEnv(), encoding: "utf8" },
  );
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${res.stderr}${res.stdout}`);
  }
  return res.stdout;
}

export function writeFile(dir: string, rel: string, content: string): void {
  const p = join(dir, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
}

export function removeFile(dir: string, rel: string): void {
  unlinkSync(join(dir, rel));
}

// tempDir makes a directory removed when the test ends. The path is resolved
// through symlinks (macOS's /var is one) so it compares with what git reports.
export function tempDir(t: TestContext): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "tsrefactor-")));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// fixtureRepo commits files as the repository's first commit.
export function fixtureRepo(t: TestContext, files: Record<string, string>): string {
  const dir = tempDir(t);
  git(dir, "init", "-q");
  for (const [rel, content] of Object.entries(files)) {
    writeFile(dir, rel, content);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

export interface CliResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// runCli runs the command the way redline does: a subprocess with its own cwd.
export function runCli(args: string[], cwd: string): CliResult {
  const res = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: sanitizedGitEnv(),
    encoding: "utf8",
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}
