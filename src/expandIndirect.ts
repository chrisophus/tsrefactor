import type { Builder } from "./builder.ts";
import { sortedUnique } from "./builder.ts";
import { isTestPath } from "./classify.ts";
import type { Decl } from "./decls.ts";
import { collectUsesOf, insideChanged, type UseSite } from "./expandUses.ts";
import { priorityFor } from "./priority.ts";

// maxIndirectCallers caps the second hop across the whole change, not per
// declaration. The first hop is bounded by how many places reach the change;
// the second is bounded by how many reach those, which for a widely used hook
// is most of the app. This is the least valuable role here, so it is the one
// with a hard ceiling.
const maxIndirectCallers = 8;

// addIndirectCallerSites emits the second hop: the declarations that reach a
// changed symbol through one of its direct callers.
//
// One hop is often not where the caller's own contract is decided. A changed
// hook starts returning a new shape, the component using it passes the value
// down, and whether that matters is decided in the component's own caller,
// which renders it or does not. The first hop shows the pass-through and
// answers nothing.
//
// The consumer ranks it last, below history, and it is capped hard, because it
// is whole declarations that may have nothing to do with the change. A deferred
// index can carry it at one line each and let the reviewer decide; a prompt
// that has to fit cannot.
export function addIndirectCallerSites(b: Builder, direct: readonly Decl[]): void {
  if (direct.length === 0) {
    return;
  }
  // Skip anything a nearer role already carries: the change itself, and the
  // direct callers, whose bodies the caller role has just emitted whole.
  const inDirect = (rel: string, line: number): boolean =>
    direct.some((d) => d.rel === rel && d.start <= line && line <= d.end);
  const sites = collectUsesOf(b, direct, (rel, line) => insideChanged(b, rel, line) || inDirect(rel, line));

  interface Group {
    encl: Decl;
    reaches: string[];
    lines: string[];
    priority: number;
  }
  const order: Group[] = [];
  const byKey = new Map<string, Group>();
  let dropped = 0;
  const indirectTests: UseSite[] = [];
  for (const s of sites) {
    // A test at the second hop is a test, not a caller. The test role carries
    // the tests that name a changed symbol; one that reaches it through another
    // declaration is the case that role never covered, and it is still the
    // answer to "what checks this".
    if (isTestPath(s.rel)) {
      indirectTests.push(s);
      continue;
    }
    const encl = b.enclosingAt(s.rel, s.line);
    if (!encl || b.decls.some((c) => c.key === encl.key)) {
      continue;
    }
    let g = byKey.get(encl.key);
    if (!g) {
      if (order.length >= maxIndirectCallers) {
        dropped++;
        continue;
      }
      g = { encl, reaches: [], lines: [], priority: 0 };
      byKey.set(encl.key, g);
      order.push(g);
    }
    g.reaches.push(s.target.scope);
    g.lines.push(String(s.line));
    g.priority = Math.max(g.priority, priorityFor(s.target));
  }
  if (dropped > 0) {
    b.notes.push(
      `${String(dropped)} further indirect caller(s) were not expanded (cap ${String(maxIndirectCallers)})`,
    );
  }
  addIndirectTestSites(b, indirectTests);
  for (const g of order) {
    b.add({
      role: "indirect-caller",
      priority: g.priority,
      symbol: g.encl.symbol,
      scope: g.encl.scope,
      file: g.encl.rel,
      startLine: g.encl.start,
      endLine: g.encl.end,
      content: b.slice(g.encl.rel, g.encl.start, g.encl.end),
      details: {
        kind: g.encl.kind,
        hop: "2",
        // The direct callers this one reaches, so the path from the change is
        // readable without opening both expansions.
        reaches: sortedUnique(g.reaches).join(", "),
        line: g.lines[0] ?? "",
      },
    });
  }
}

// addIndirectTestSites emits the tests that reach the change through one of its
// callers, under the test role.
//
// The test role finds tests that name a changed symbol. A test usually does not
// when the change is a file away: it exercises the thing that calls the change,
// which is the test most likely to fail and the one nothing here reported.
// details.hop says the check is not a direct one, so a reviewer reading "what
// checks this" knows how far away it sits.
function addIndirectTestSites(b: Builder, sites: readonly UseSite[]): void {
  interface Group {
    encl: Decl;
    reaches: string[];
    priority: number;
  }
  const order: Group[] = [];
  const byKey = new Map<string, Group>();
  for (const s of sites) {
    const encl = b.enclosingAt(s.rel, s.line);
    if (!encl || b.decls.some((c) => c.key === encl.key)) {
      continue;
    }
    let g = byKey.get(encl.key);
    if (!g) {
      if (order.length >= maxIndirectCallers) {
        continue;
      }
      g = { encl, reaches: [], priority: 0 };
      byKey.set(encl.key, g);
      order.push(g);
    }
    g.reaches.push(s.target.scope);
    g.priority = Math.max(g.priority, priorityFor(s.target));
  }
  for (const g of order) {
    b.add({
      role: "test",
      priority: g.priority,
      symbol: g.encl.symbol,
      scope: g.encl.scope,
      file: g.encl.rel,
      startLine: g.encl.start,
      endLine: g.encl.end,
      content: b.slice(g.encl.rel, g.encl.start, g.encl.end),
      details: { kind: "test", hop: "2", reaches: sortedUnique(g.reaches).join(", ") },
    });
  }
}
