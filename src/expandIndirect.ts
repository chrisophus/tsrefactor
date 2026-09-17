import type { Builder } from "./builder.ts";
import { sortedUnique } from "./builder.ts";
import { isTestPath } from "./classify.ts";
import type { Decl } from "./decls.ts";
import { collectUsesOf, insideChanged } from "./expandUses.ts";
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
  for (const s of sites) {
    // A test that reaches a caller is not a hop worth paying for: the test role
    // already carries the tests that reach the change.
    if (isTestPath(s.rel)) {
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
