// Maps each changed hunk to the declaration that encloses it. Ports the
// resolve stage of gorefactor's internal/changectx.

import { errorMessage, sortedUnique, type Builder } from "./builder.ts";
import { countChanged, declCompare, selectedBy } from "./decls.ts";
import type { File } from "./envelope.ts";
import { hunkRanges, isDeleted, type Change, type LineRange } from "./git.ts";
import { loadProject } from "./project.ts";

// tsSourceRe matches the files this provider resolves symbols in.
const tsSourceRe = /\.[cm]?tsx?$/;

// resolveChanges maps each changed hunk to the declaration that encloses it.
// The project is loaded once, and only when a reviewable TypeScript file changed.
export function resolveChanges(b: Builder, changes: readonly Change[]): void {
  const deleted = new Set(changes.filter(isDeleted).map((c) => c.path));
  const targets = b.files.filter((f) => reviewable(f) && !deleted.has(f.path));
  if (targets.length === 0) {
    return;
  }
  const { project, notes } = loadProject(
    b.repo,
    targets.map((f) => b.abs(f.path)),
  );
  b.project = project;
  b.notes.push(...notes);

  for (const f of targets) {
    let ranges: LineRange[];
    try {
      ranges = hunkRanges(b.repo, b.base, f.path);
    } catch (err) {
      b.notes.push(`no diff hunks for ${f.path}: ${errorMessage(err)}`);
      continue;
    }
    if (ranges.length === 0) {
      ranges = b.wholeFileRange(f.path);
    }
    b.ranges.set(f.path, ranges);
    resolveFile(b, f, ranges);
  }
  b.decls.sort(declCompare);
}

// reviewable reports whether a changed file is worth resolving symbols in.
// Machine output and vendored code are listed in the manifest and read by
// nobody, so the work of type-checking them buys nothing.
function reviewable(f: File): boolean {
  return tsSourceRe.test(f.path) && !f.generated && f.class !== "vendored" && f.class !== "generated";
}

function resolveFile(b: Builder, f: File, ranges: readonly LineRange[]): void {
  if (!b.sourceFile(f.path)) {
    b.notes.push(`could not parse ${f.path}; its symbols were not resolved`);
    return;
  }
  const symbols: string[] = [];
  for (const d of b.declsForRel(f.path)) {
    if (!selectedBy(d, ranges)) {
      continue;
    }
    d.changed = countChanged(d, ranges);
    b.decls.push(d);
    symbols.push(d.symbol);
  }
  const sorted = sortedUnique(symbols);
  if (sorted.length > 0) {
    f.symbols = sorted;
  }
}
