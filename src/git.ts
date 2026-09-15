// Git plumbing for the change: the work tree, the merge base, and the changed
// paths. Ports gorefactor's internal/changectx/git.go and analyzer/gitenv.go.

import { spawnSync } from "node:child_process";

import { compareStrings } from "./envelope.ts";

// gitRepoEnvVars are the repository-locating variables git exports to hook
// processes. Inherited by a child process they redirect every diff and
// rev-parse run in another directory back at the hook's repository.
export const gitRepoEnvVars = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_QUARANTINE_PATH",
] as const;

// sanitizedGitEnv returns the environment with gitRepoEnvVars removed.
export function sanitizedGitEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const drop = new Set<string>(gitRepoEnvVars);
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) {
    if (!drop.has(k) && v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

// maxGitOutput bounds one git command's stdout. Node's default of 1 MiB is
// smaller than the diff of an ordinary large change.
const maxGitOutput = 1024 * 1024 * 1024;

// gitOutput runs git against root via -C and returns its stdout. Stderr is
// folded into the error so a caller reporting a note says what git said.
export function gitOutput(root: string, ...args: string[]): string {
  const res = spawnSync("git", ["-C", root, ...args], {
    env: sanitizedGitEnv(),
    encoding: "utf8",
    maxBuffer: maxGitOutput,
  });
  if (res.error) {
    throw new Error(`git ${args.join(" ")}: ${res.error.message}`);
  }
  if (res.status !== 0) {
    const msg = res.stderr.trim() || `exit status ${res.status ?? res.signal}`;
    throw new Error(`git ${args.join(" ")}: ${msg}`);
  }
  return res.stdout;
}

// repoRoot returns the top level of the work tree containing dir.
export function repoRoot(dir: string): string {
  return gitOutput(dir, "rev-parse", "--show-toplevel").trim();
}

// mergeBase resolves the point the change is measured from: the merge base of
// ref and HEAD. A ref with no common ancestor, and a repository with no HEAD,
// fall back to the ref itself so a first commit still produces an envelope.
export function mergeBase(repo: string, ref: string): string {
  try {
    const sha = gitOutput(repo, "merge-base", ref, "HEAD").trim();
    if (sha !== "") {
      return sha;
    }
  } catch {
    // fall through to the ref itself
  }
  return gitOutput(repo, "rev-parse", "--verify", `${ref}^{commit}`).trim();
}

// Change is one path the diff reports, with the git status letter that
// produced it. Untracked paths are reported as additions.
export interface Change {
  path: string; // repo-relative, forward slashes
  status: string;
}

export function isDeleted(c: Change): boolean {
  return c.status.startsWith("D");
}

// changedFiles lists every path that differs between base and the working
// tree, including files git does not track yet. A failure to list the
// untracked paths fails the call rather than returning a manifest that looks
// complete: every expansion is derived from this list, and a silently dropped
// file leaves the envelope reading like a fully covered change.
export function changedFiles(repo: string, base: string): Change[] {
  const tracked = gitOutput(repo, "diff", "--name-status", "-z", base);
  const byPath = new Map<string, Change>();
  for (const c of parseNameStatus(tracked)) {
    byPath.set(c.path, c);
  }
  const untracked = gitOutput(repo, "ls-files", "--others", "--exclude-standard", "-z");
  for (const p of splitNUL(untracked)) {
    const path = toSlash(p);
    if (!byPath.has(path)) {
      byPath.set(path, { path, status: "A" });
    }
  }
  return [...byPath.values()].sort((a, b) => compareStrings(a.path, b.path));
}

// parseNameStatus reads the NUL-separated form of `git diff --name-status`.
// Rename and copy records carry two paths; the second one is where the code
// lives now, which is the one a reviewer reads.
export function parseNameStatus(s: string): Change[] {
  const fields = splitNUL(s);
  const out: Change[] = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i]!;
    const want = status.startsWith("R") || status.startsWith("C") ? 2 : 1;
    if (i + want >= fields.length) {
      break;
    }
    const path = fields[i + want]!;
    i += want;
    out.push({ path: toSlash(path), status });
  }
  return out;
}

// LineRange is an inclusive 1-based span of lines in the working-tree file.
export interface LineRange {
  start: number;
  end: number;
}

// hunkRanges returns the working-tree line spans the diff touches in path. A
// hunk that only deletes lines has no working-tree span of its own, so it is
// reported as the single line the deletion sits after, which is where the
// reviewer has to look.
export function hunkRanges(repo: string, base: string, path: string): LineRange[] {
  const out = gitOutput(repo, "diff", "-U0", "--no-color", base, "--", path);
  const ranges: LineRange[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("@@")) {
      continue;
    }
    const r = parseHunkHeader(line);
    if (r) {
      ranges.push(r);
    }
  }
  return mergeRanges(ranges);
}

// parseHunkHeader reads the "+start,count" half of a unified diff hunk header.
export function parseHunkHeader(line: string): LineRange | undefined {
  const i = line.indexOf("+");
  if (i === -1) {
    return undefined;
  }
  let rest = line.slice(i + 1);
  const j = rest.search(/[ @]/);
  if (j >= 0) {
    rest = rest.slice(0, j);
  }
  const [startStr, countStr] = rest.split(",", 2);
  const start = parseDecimal(startStr);
  if (start === undefined) {
    return undefined;
  }
  let count = 1;
  if (countStr !== undefined) {
    const c = parseDecimal(countStr);
    if (c === undefined) {
      return undefined;
    }
    count = c;
  }
  if (count === 0) {
    const at = Math.max(start, 1);
    return { start: at, end: at };
  }
  return { start, end: start + count - 1 };
}

// removedRanges returns the base-side spans a diff deletes from path.
//
// These are the lines that no longer exist, so they have no working-tree span
// and hunkRanges cannot report them. Their history is the interesting kind:
// the reason a line was added is the reason not to delete it, and a diff that
// only removes code carries none of that on its face.
export function removedRanges(repo: string, base: string, path: string): LineRange[] {
  const out = gitOutput(repo, "diff", "-U0", "--no-color", base, "--", path);
  const ranges: LineRange[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("@@")) {
      continue;
    }
    const r = parseRemovedHunkHeader(line);
    if (r) {
      ranges.push(r);
    }
  }
  return mergeRanges(ranges);
}

// HunkSide pairs a hunk's working-tree span with the span it replaced at base.
//
// History needs both halves and they are not interchangeable. The revision
// walked is base, so the -L span has to be in base coordinates: a file whose
// earlier hunks inserted or deleted lines has a working-tree position that
// names different lines at base, and `git log -L` will happily trace those
// instead of erroring. The working-tree half locates the span for the reviewer
// and maps it onto a changed declaration, since those live in the head tree.
export interface HunkSide {
  head: LineRange;
  base: LineRange;
}

// hunkSides returns both halves of every hunk that has a base-side span. A hunk
// that only adds has none, and lines that did not exist before have no prior
// history to trace.
export function hunkSides(repo: string, base: string, path: string): HunkSide[] {
  const out = gitOutput(repo, "diff", "-U0", "--no-color", base, "--", path);
  const sides: HunkSide[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("@@")) {
      continue;
    }
    const head = parseHunkHeader(line);
    const baseSide = parseRemovedHunkHeader(line);
    if (head && baseSide) {
      sides.push({ head, base: baseSide });
    }
  }
  return sides;
}

// parseRemovedHunkHeader reads the "-start,count" half. A count of zero means
// the hunk adds without removing, and there is nothing deleted to trace.
export function parseRemovedHunkHeader(line: string): LineRange | undefined {
  const i = line.indexOf("-");
  if (i === -1) {
    return undefined;
  }
  let rest = line.slice(i + 1);
  const j = rest.search(/[ @+]/);
  if (j >= 0) {
    rest = rest.slice(0, j);
  }
  const [startStr, countStr] = rest.split(",", 2);
  const start = parseDecimal(startStr);
  if (start === undefined || start < 1) {
    return undefined;
  }
  let count = 1;
  if (countStr !== undefined) {
    const c = parseDecimal(countStr);
    if (c === undefined) {
      return undefined;
    }
    count = c;
  }
  if (count === 0) {
    return undefined;
  }
  return { start, end: start + count - 1 };
}

// logLineHistory returns the recent history of a line span, capped at max
// revisions. The cap is what keeps this role cheap: a file rewritten fifty
// times would otherwise bury everything else in the envelope.
//
// The walk starts at rev rather than at HEAD: the change under review sits at
// the tip, so a walk from HEAD answers "why is this line here" with the commit
// the reviewer is already reading. Walking from the base answers it with the
// history the change was made against.
export function logLineHistory(repo: string, rev: string, path: string, r: LineRange, max: number): string {
  return gitOutput(repo, "log", "--no-color", "--date=iso-strict", "-n", String(max), `-L${r.start},${r.end}:${path}`, rev);
}

// logRemovedHistory traces a span that existed at base and does not now. The
// span is interpreted against base, the only revision where those line
// numbers mean anything.
export function logRemovedHistory(repo: string, base: string, path: string, r: LineRange, max: number): string {
  return gitOutput(repo, "log", "--no-color", "--date=iso-strict", "-n", String(max), `-L${r.start},${r.end}:${path}`, base);
}

// mergeRanges sorts spans and folds overlapping or touching ones together, so
// one declaration spanning several hunks is asked about once.
export function mergeRanges(input: readonly LineRange[]): LineRange[] {
  const sorted = [...input].sort((a, b) => a.start - b.start || a.end - b.end);
  const out: LineRange[] = [];
  for (const r of sorted) {
    const last = out.at(-1);
    if (last && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
      continue;
    }
    out.push({ ...r });
  }
  return out;
}

function parseDecimal(s: string | undefined): number | undefined {
  return s !== undefined && /^\d+$/.test(s) ? Number(s) : undefined;
}

function splitNUL(s: string): string[] {
  return s.split("\u{0}").filter((f) => f !== "");
}

function toSlash(p: string): string {
  return p.replaceAll("\\", "/");
}
