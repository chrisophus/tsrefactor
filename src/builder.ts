// Builder carries the state of one build call. Every stage appends to it and
// nothing reads back, which is what keeps the output a function of the
// revision alone. Ports the builder half of gorefactor's changectx.go.

import { readFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";

import type { Project, SourceFile } from "ts-morph";

import { compareStrings, type Expansion, type File } from "./envelope.ts";
import type { LineRange } from "./git.ts";
import { declsIn, functionKinds, type Decl } from "./decls.ts";

// defaultHistoryRevisions is how far back the history role reads per span when
// the caller names no cap. A handful of revisions is enough to show a line was
// deliberate, and it keeps a file rewritten fifty times from burying the rest.
const defaultHistoryRevisions = 3;

// defaultHistoryRangesPerFile is how many spans of one file get their own
// history when the caller names no cap.
const defaultHistoryRangesPerFile = 3;

export class Builder {
  readonly repo: string;
  readonly base: string;
  files: File[] = [];
  exps: Expansion[] = [];
  notes: string[] = [];
  decls: Decl[] = [];
  ranges = new Map<string, LineRange[]>();
  project: Project | undefined;

  private readonly lines = new Map<string, string[]>();
  private readonly declCache = new Map<string, Decl[]>();

  // historyRevisions and historyRanges are the caps the history and removal
  // roles read under, taken from the options when set. Zero or less means
  // unset rather than none: a cap of none would silently empty a role.
  readonly historyRevisions: number;
  readonly historyRanges: number;

  constructor(repo: string, base: string, revisions?: number, ranges?: number) {
    this.repo = repo;
    this.base = base;
    this.historyRevisions = revisions !== undefined && revisions > 0 ? revisions : defaultHistoryRevisions;
    this.historyRanges = ranges !== undefined && ranges > 0 ? ranges : defaultHistoryRangesPerFile;
  }

  abs(rel: string): string {
    return join(this.repo, rel);
  }

  // rel converts an absolute path to the repo-relative, forward-slash form the
  // envelope carries. A path outside the work tree, or inside node_modules, is
  // refused: an absolute path would name a machine the reviewer is not on, and
  // a dependency's own code is not the change's context.
  rel(abs: string): string | undefined {
    const r = relative(this.repo, abs);
    if (r === "" || r === ".." || r.startsWith(`..${sep}`) || isAbsolute(r)) {
      return undefined;
    }
    const slashed = r.split(sep).join("/");
    return slashed.split("/").includes("node_modules") ? undefined : slashed;
  }

  // sourceFile returns the loaded syntax tree for a file, adding it to the
  // project when the load did not include it. A file outside every tsconfig
  // still gets its declarations mapped.
  sourceFile(rel: string): SourceFile | undefined {
    if (!this.project) {
      return undefined;
    }
    const abs = this.abs(rel);
    return this.project.getSourceFile(abs) ?? this.project.addSourceFileAtPathIfExists(abs);
  }

  // declsForRel returns the top-level declarations of a file, parsed once and
  // kept. It is how an expansion found by position reports the declaration it
  // sits in.
  declsForRel(rel: string): Decl[] {
    const cached = this.declCache.get(rel);
    if (cached) {
      return cached;
    }
    const sf = this.sourceFile(rel);
    const ds = sf ? declsIn(sf, rel) : [];
    this.declCache.set(rel, ds);
    return ds;
  }

  // enclosingFunctionAt returns the outermost function containing a line: the
  // component rather than the callback inside it.
  //
  // A call site is worth reading with the whole function around it, and since
  // nested functions became declarations the innermost answer is often a
  // handler four lines wide -- which is the window this role was changed to
  // stop sending. It stops at anything that is not a function, so a method
  // stays a method rather than widening to its class.
  enclosingFunctionAt(rel: string, line: number): Decl | undefined {
    const start = this.enclosingAt(rel, line);
    if (!start) {
      return undefined;
    }
    const byKey = new Map<string, Decl>(this.declsForRel(rel).map((x) => [x.key, x]));
    let d: Decl = start;
    for (;;) {
      const parentKey = d.parentKey;
      const parent = parentKey === undefined ? undefined : byKey.get(parentKey);
      if (!parent || !functionKinds.has(parent.kind)) {
        return d;
      }
      d = parent;
    }
  }

  // enclosingAt returns the innermost declaration containing a line of a file:
  // a class member rather than its class.
  enclosingAt(rel: string, line: number): Decl | undefined {
    let found: Decl | undefined;
    for (const d of this.declsForRel(rel)) {
      if (d.start <= line && line <= d.end && (!found || d.end - d.start <= found.end - found.start)) {
        found = d;
      }
    }
    return found;
  }

  // sourceLines reads a working-tree file once and keeps its lines for slicing.
  sourceLines(rel: string): string[] {
    const cached = this.lines.get(rel);
    if (cached) {
      return cached;
    }
    let lines: string[] = [];
    try {
      lines = readFileSync(this.abs(rel), "utf8").replaceAll("\r\n", "\n").split("\n");
    } catch {
      // an unreadable file slices to nothing, and add drops the expansion
    }
    this.lines.set(rel, lines);
    return lines;
  }

  // slice returns lines start..end of a file, inclusive and 1-based.
  slice(rel: string, start: number, end: number): string {
    const lines = this.sourceLines(rel);
    if (lines.length === 0 || start < 1) {
      return "";
    }
    const last = Math.min(end, lines.length);
    if (start > last) {
      return "";
    }
    return lines.slice(start - 1, last).join("\n") + "\n";
  }

  // wholeFileRange covers a file the diff reports without hunks, such as one
  // that git has not tracked yet.
  wholeFileRange(rel: string): LineRange[] {
    const n = this.sourceLines(rel).length;
    return n === 0 ? [] : [{ start: 1, end: n }];
  }

  // add records an expansion, dropping ones with no content so an empty string
  // never reaches the consumer as if it were context.
  add(e: Expansion): void {
    if (e.content.trim() === "") {
      return;
    }
    this.exps.push(e);
  }
}

// sortedUnique drops empty and repeated strings and sorts the rest, so two runs
// of the same revision report the same list in the same order.
export function sortedUnique(input: readonly string[]): string[] {
  return [...new Set(input.filter((s) => s !== ""))].sort(compareStrings);
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
