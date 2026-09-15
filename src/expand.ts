// Fills the envelope with the code around the change, in the order the consumer
// ranks the roles. Ports gorefactor's internal/changectx/expand.go.

import type { Builder } from "./builder.ts";
import { compareStrings, roleRank, roles, type Expansion, type Role } from "./envelope.ts";
import type { Decl } from "./resolve.ts";

// implementedRoles are the roles this version produces. A role not yet built
// says so in its note rather than claiming the change had nothing for it.
const implementedRoles: ReadonlySet<Role> = new Set<Role>(["enclosing"]);

// expand runs every stage. The roles that read declarations need declarations;
// history does not, and is driven from the manifest instead.
export function expand(b: Builder): void {
  if (b.decls.length > 0) {
    expandEnclosing(b);
  }
  noteEmptyRoles(b);
  sortExpansions(b.exps);
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
