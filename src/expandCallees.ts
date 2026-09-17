import { Node } from "ts-morph";

import { type Builder, sortedUnique } from "./builder.ts";
import { isTestPath } from "./classify.ts";
import type { Decl } from "./decls.ts";
import { priorityFor } from "./priority.ts";

// maxCalleesPerDecl caps how many callees one changed declaration contributes.
// A component that calls forty things would otherwise spend the consumer's
// whole budget describing code the change only passes through.
const maxCalleesPerDecl = 12;

// expandCallees emits what the change calls: for every changed declaration, the
// declarations its body reaches that this work tree declares.
//
// It is the other half of the caller role, and the half no caller can stand in
// for. A change that starts returning undefined is judged by the code reading
// the result, which is a caller. A change to what a handler invalidates,
// refreshes or commits is judged by what that handler calls, and the callers of
// the handler show none of it. That is the shape of the miss this repository
// exists to catch: what a page's refresh actually clears is a callee of its
// handler, not a caller of it.
//
// Only declarations inside the work tree are emitted, so a call into React or
// a dependency is never offered as context the reviewer can go and read.
export function expandCallees(b: Builder): void {
  interface Group {
    target: Decl;
    from: string[];
    priority: number;
  }
  const order: Group[] = [];
  const byKey = new Map<string, Group>();
  for (const d of b.decls) {
    // A changed test's callees are its own scaffolding; the test role carries
    // tests, and describe blocks are containers rather than callers.
    if (d.kind === "describe" || d.kind === "test" || isTestPath(d.rel)) {
      continue;
    }
    let kept = 0;
    let dropped = 0;
    for (const target of calleeDecls(b, d)) {
      if (target.key === d.key || isChangedDecl(b, target) || isTestPath(target.rel)) {
        continue;
      }
      if (!byKey.has(target.key)) {
        if (kept >= maxCalleesPerDecl) {
          dropped++;
          continue;
        }
        kept++;
      }
      let g = byKey.get(target.key);
      if (!g) {
        g = { target, from: [], priority: 0 };
        byKey.set(target.key, g);
        order.push(g);
      }
      g.from.push(d.scope);
      g.priority = Math.max(g.priority, priorityFor(target));
    }
    if (dropped > 0) {
      b.notes.push(
        `${String(dropped)} further callee(s) of ${d.scope} were not expanded (cap ${String(maxCalleesPerDecl)} per declaration)`,
      );
    }
  }
  for (const g of order) {
    b.add({
      role: "callee",
      priority: g.priority,
      symbol: g.target.symbol,
      scope: g.target.scope,
      file: g.target.rel,
      startLine: g.target.start,
      endLine: g.target.end,
      content: b.slice(g.target.rel, g.target.start, g.target.end),
      details: {
        kind: g.target.kind,
        calledBy: sortedUnique(g.from).join(", "),
      },
    });
  }
}

// isChangedDecl reports whether a declaration is one the diff touched. Identity
// is the key, which decls hands out once per declaration, never the name: a
// name is not an identity.
function isChangedDecl(b: Builder, d: Decl): boolean {
  return b.decls.some((c) => c.key === d.key);
}

// calleeDecls resolves what one declaration calls, in source order, through the
// type checker rather than by name.
//
// JSX counts. `<DetailExpansionPanel itemId={itemId} />` is a call of the
// component in every sense a reviewer cares about, and it is exactly the edge
// the bug behind this repository turned on.
function calleeDecls(b: Builder, d: Decl): Decl[] {
  const out: Decl[] = [];
  const seen = new Set<string>();
  d.node.forEachDescendant((n) => {
    const name = calleeName(n);
    if (!name) {
      return;
    }
    for (const target of declsOfCallee(b, name)) {
      if (seen.has(target.key)) {
        continue;
      }
      seen.add(target.key);
      out.push(target);
    }
  });
  return out;
}

// calleeName returns the identifier naming what a node calls: a call
// expression's callee, or the tag of a JSX element. A call through a value that
// has no declaration to point at yields nothing rather than a guess.
function calleeName(n: Node): Node | undefined {
  if (Node.isCallExpression(n) || Node.isNewExpression(n)) {
    return identifierOf(n.getExpression());
  }
  if (Node.isJsxSelfClosingElement(n) || Node.isJsxOpeningElement(n)) {
    return identifierOf(n.getTagNameNode());
  }
  return undefined;
}

// identifierOf unwraps what is called down to the identifier naming it, through
// a property access and the parentheses a callee is occasionally written with.
function identifierOf(e: Node): Node | undefined {
  if (Node.isIdentifier(e)) {
    return e;
  }
  if (Node.isPropertyAccessExpression(e)) {
    return e.getNameNode();
  }
  if (Node.isParenthesizedExpression(e)) {
    return identifierOf(e.getExpression());
  }
  return undefined;
}

// declsOfCallee maps an identifier to the declarations it resolves to, keeping
// only those inside the work tree. Aliases are followed, so a callee reached
// through a barrel re-export resolves to where it is written rather than to the
// re-export, which is the edge a syntax-only parser cannot bind.
function declsOfCallee(b: Builder, name: Node): Decl[] {
  const sym = name.getSymbol();
  if (!sym) {
    return [];
  }
  const resolved = sym.isAlias() ? (sym.getAliasedSymbol() ?? sym) : sym;
  const out: Decl[] = [];
  for (const declaration of resolved.getDeclarations()) {
    const rel = b.rel(declaration.getSourceFile().getFilePath());
    if (rel === undefined) {
      continue;
    }
    const { line } = declaration.getSourceFile().getLineAndColumnAtPos(declaration.getStart());
    const target = b.declsForRel(rel).find((x) => x.node === declaration) ?? b.enclosingAt(rel, line);
    if (target) {
      out.push(target);
    }
  }
  return out;
}
