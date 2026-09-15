// Fills the envelope with the code around the change, in the order the consumer
// ranks the roles. Ports gorefactor's internal/changectx/expand.go.

import { errorMessage, type Builder } from "./builder.ts";
import { compareStrings, roleRank, roles, type Expansion, type Role } from "./envelope.ts";
import {
  hunkSides,
  logLineHistory,
  logRemovedHistory,
  removedRanges,
  type HunkSide,
  type LineRange,
} from "./git.ts";
import type { Decl } from "./resolve.ts";

// historyRevisions caps how far back the history role reads per line span. A
// handful of revisions is enough to show that a line was deliberate, and it
// keeps a file rewritten fifty times from burying the rest of the envelope.
export const historyRevisions = 3;

// historyRangesPerFile caps how many spans of one file get their own history.
export const historyRangesPerFile = 3;

// removedHistoryPriority orders a deleted span's history within the removal
// role. It sits above priorityFor's 50..100 band, where gorefactor set it while
// removals shared the history role with surviving lines and had to outrank them.
export const removedHistoryPriority = 120;

// implementedRoles are the roles this version produces. A role not yet built
// says so in its note rather than claiming the change had nothing for it.
const implementedRoles: ReadonlySet<Role> = new Set<Role>(["enclosing", "removal", "history"]);

// expand runs every stage. The roles that read declarations need declarations;
// history does not, and is driven from the manifest instead. A change that only
// deletes files resolves to no declaration at all, and that is precisely where
// history earns its place: the lines are gone, so nothing else in the envelope
// says why they were there.
export function expand(b: Builder): void {
  if (b.decls.length > 0) {
    expandEnclosing(b);
  }
  expandHistory(b);
  noteEmptyRoles(b);
  sortExpansions(b.exps);
}

// expandHistory emits the recent history of the changed line spans. It is
// cheap, and it stops a whole class of bad review comment: the suggestion to
// undo a deliberate fix.
//
// The span is asked for in base coordinates and reported in working-tree ones.
// Walking base with a working-tree position traces whatever happens to sit at
// that offset in the older file, which on any file whose earlier hunks shifted
// line numbers is not the code under review — and git reports no error for it.
export function expandHistory(b: Builder): void {
  for (const f of b.files) {
    let sides: HunkSide[];
    try {
      sides = hunkSides(b.repo, b.base, f.path);
    } catch (err) {
      b.notes.push(`no history for ${f.path}: ${errorMessage(err)}`);
      continue;
    }
    const [kept, dropped] = rankedSides(sides, historyRangesPerFile);
    if (dropped > 0) {
      b.notes.push(
        `${dropped} further changed span(s) of ${f.path} were not traced (cap ${historyRangesPerFile} per file)`,
      );
    }
    for (const s of kept) {
      let out: string;
      try {
        out = logLineHistory(b.repo, b.base, f.path, s.base, historyRevisions);
      } catch {
        continue;
      }
      if (out.trim() === "") {
        continue;
      }
      const [d, priority] = historyContext(b, f.path, s.head);
      const e: Expansion = {
        role: "history",
        priority,
        file: f.path,
        startLine: s.head.start,
        endLine: s.head.end,
        content: out,
        details: {
          kind: "line-history",
          lines: `${s.head.start}-${s.head.end}`,
          baseLines: `${s.base.start}-${s.base.end}`,
          revisions: String(historyRevisions),
        },
      };
      if (d) {
        e.symbol = d.symbol;
        e.scope = d.scope;
      }
      b.add(e);
    }
    expandRemovedHistory(b, f.path);
  }
}

// expandRemovedHistory traces the lines this change deletes.
//
// A deletion is where history earns its place. The lines are gone, so nothing
// in the diff says why they were there, and a guard added on purpose reads
// exactly like a tidy simplification. Tracing the span against the base
// revision recovers the commit that introduced it, and with it the reason.
function expandRemovedHistory(b: Builder, path: string): void {
  let all: LineRange[];
  try {
    all = removedRanges(b.repo, b.base, path);
  } catch {
    return;
  }
  const [ranges, dropped] = rankedRanges(all, historyRangesPerFile);
  if (dropped > 0) {
    b.notes.push(`${dropped} further removed span(s) of ${path} were not traced (cap ${historyRangesPerFile} per file)`);
  }
  for (const r of ranges) {
    let out: string;
    try {
      out = logRemovedHistory(b.repo, b.base, path, r, historyRevisions);
    } catch {
      continue;
    }
    if (out.trim() === "") {
      continue;
    }
    b.add({
      role: "removal",
      priority: removedHistoryPriority,
      file: path,
      startLine: r.start,
      endLine: r.end,
      content: out,
      details: {
        kind: "removed-line-history",
        lines: `${r.start}-${r.end} at the base revision`,
        revisions: String(historyRevisions),
      },
    });
  }
}

// rankedRanges applies the per-file cap to a set of changed spans, keeping the
// longest ones. The spans arrive sorted by position, so keeping the first few
// would keep whatever sits nearest the top of the file; span length is the
// proxy for substance, being how many lines the diff touched there.
//
// The second value is how many spans were dropped. The caller reports it as a
// note, because a file whose history was cut has to say so.
export function rankedRanges(ranges: readonly LineRange[], limit: number): [LineRange[], number] {
  if (ranges.length <= limit) {
    return [[...ranges], 0];
  }
  const ranked = [...ranges].sort((a, c) => c.end - c.start - (a.end - a.start) || a.start - c.start);
  const kept = ranked.slice(0, limit).sort((a, c) => a.start - c.start);
  return [kept, ranges.length - limit];
}

// rankedSides applies the same cap to paired hunk halves, ranking on the
// working-tree span because that is the side whose size says how much of the
// change the span accounts for.
export function rankedSides(sides: readonly HunkSide[], limit: number): [HunkSide[], number] {
  if (sides.length <= limit) {
    return [[...sides], 0];
  }
  const len = (s: HunkSide) => s.head.end - s.head.start;
  const ranked = [...sides].sort((a, c) => len(c) - len(a) || a.head.start - c.head.start);
  const kept = ranked.slice(0, limit).sort((a, c) => a.head.start - c.head.start);
  return [kept, sides.length - limit];
}

// historyContext returns the changed declaration a history span belongs to, and
// the priority the expansion carries.
//
// A span covering more than one changed declaration belongs to none of them:
// naming one would name whichever happened to be declared first. Such a span is
// left unlabelled and scored from everything the change touched inside it. A
// class and its own changed members count as one declaration, the class.
function historyContext(b: Builder, rel: string, r: LineRange): [Decl | undefined, number] {
  const covered = b.decls.filter((d) => d.rel === rel && d.start <= r.end && r.start <= d.end);
  const keys = new Set(covered.map((d) => d.key));
  const outer = covered.filter((d) => d.parentKey === undefined || !keys.has(d.parentKey));
  if (outer.length === 0) {
    return [undefined, 0];
  }
  if (outer.length === 1) {
    return [outer[0], priorityFor(outer[0]!)];
  }
  return [
    undefined,
    priorityFor({
      exported: outer.some((d) => d.exported),
      changed: outer.reduce((n, d) => n + d.changed, 0),
    }),
  ];
}

// expandEnclosing emits the whole declaration each changed hunk sits inside. A
// hunk without it cannot be judged at all, which is why this role is first.
//
// A member whose class is itself changed is not emitted again: the class's
// content already carries it, and shipping the same method twice spends the
// consumer's budget on a copy.
export function expandEnclosing(b: Builder): void {
  const changedKeys = new Set(b.decls.map((d) => d.key));
  for (const d of b.decls) {
    if (d.parentKey !== undefined && changedKeys.has(d.parentKey)) {
      continue;
    }
    b.add({
      role: "enclosing",
      priority: priorityFor(d),
      symbol: d.symbol,
      scope: d.scope,
      file: d.rel,
      startLine: d.start,
      endLine: d.end,
      content: b.slice(d.rel, d.start, d.end),
      details: declDetails(d),
    });
  }
}

// priorityFor scores a declaration within its role. Exported symbols outrank
// unexported ones, and a heavily rewritten declaration outranks a one-line
// edit. The scale is local to a role; the consumer never compares across two.
export function priorityFor(d: Pick<Decl, "exported" | "changed">): number {
  return 50 + (d.exported ? 30 : 0) + Math.min(d.changed, 20);
}

// declDetails is the TypeScript-shaped half of an expansion. The consumer
// passes it through and renders it generically.
function declDetails(d: Decl): Record<string, string> {
  const m: Record<string, string> = {
    kind: d.kind,
    exported: String(d.exported),
    changedLines: String(d.changed),
  };
  if (d.container !== undefined) {
    m["container"] = d.container;
  }
  return m;
}

// noteEmptyRoles records why a role produced nothing. A role that is merely
// absent is indistinguishable from a stage that crashed; each note states the
// condition that emptied the role, which is knowable here and nowhere else.
export function noteEmptyRoles(b: Builder): void {
  const present = new Set(b.exps.map((e) => e.role));
  for (const role of roles) {
    if (!present.has(role)) {
      b.notes.push(`no ${role} expansions: ${emptyRoleReason(b, role)}`);
    }
  }
}

function emptyRoleReason(b: Builder, role: Role): string {
  if (b.decls.length === 0 && role !== "history" && role !== "removal") {
    return "the change resolved to no TypeScript declaration";
  }
  if (!implementedRoles.has(role)) {
    return "this version of tsrefactor does not produce this role yet";
  }
  switch (role) {
    case "enclosing":
      return "the changed declarations had no readable content in the working tree";
    case "removal":
      return "the change deletes no line git has history for";
    case "history":
      return "git reported no history for the changed spans";
    default:
      return "the stage produced nothing";
  }
}

// sortExpansions puts the output in the order the consumer will rank it: by
// role, then by the provider's own hint, then by position. The last three keys
// exist only to break ties the same way twice.
export function sortExpansions(exps: Expansion[]): void {
  exps.sort((a, c) => {
    const ra = roleRank(a.role)[0];
    const rc = roleRank(c.role)[0];
    if (ra !== rc) return ra - rc;
    const pa = a.priority ?? 0;
    const pc = c.priority ?? 0;
    if (pa !== pc) return pc - pa;
    if ((a.file ?? "") !== (c.file ?? "")) return compareStrings(a.file ?? "", c.file ?? "");
    if ((a.startLine ?? 0) !== (c.startLine ?? 0)) return (a.startLine ?? 0) - (c.startLine ?? 0);
    if ((a.symbol ?? "") !== (c.symbol ?? "")) return compareStrings(a.symbol ?? "", c.symbol ?? "");
    return compareStrings(a.content, c.content);
  });
}
