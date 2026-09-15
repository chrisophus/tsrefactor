// The caller and test roles. Ports gorefactor's internal/changectx/expand_uses.go.
//
// Both come from the same walk: every reference the language service resolves
// to a changed declaration. It follows re-exports, barrel files, aliased and
// destructured imports, and JSX, because it binds symbols rather than matching
// text. Name matching would also find `total` in an unrelated module, and a
// reviewer who is shown one wrong call site stops trusting all of them.

import { Node, SyntaxKind } from "ts-morph";

import { errorMessage, sortedUnique, type Builder } from "./builder.ts";
import { isTestPath } from "./classify.ts";
import { compareStrings } from "./envelope.ts";
import { callerContextLines, priorityFor } from "./expand.ts";
import type { Decl } from "./resolve.ts";

// UseSite is one place the code reads a changed symbol.
interface UseSite {
  rel: string;
  line: number;
  col: number;
  kind: "call-site" | "reference-site";
  syntax: string | undefined; // "jsx" for a component rendered as an element
  target: Decl;
}

// plumbingParents are references that only move a name between modules or
// close a JSX element whose opening tag is already the use. An import or
// re-export line says nothing about what the code does with the symbol.
const plumbingParents: ReadonlySet<SyntaxKind> = new Set([
  SyntaxKind.ImportSpecifier,
  SyntaxKind.ImportClause,
  SyntaxKind.NamespaceImport,
  SyntaxKind.ImportEqualsDeclaration,
  SyntaxKind.ExportSpecifier,
  SyntaxKind.NamespaceExport,
  SyntaxKind.ExportAssignment,
  SyntaxKind.JsxClosingElement,
]);

// typeLikeKinds are declarations that are never called: a type in a call
// position is an instantiation expression or a namespace qualifier, and
// labelling it a call site is the kind of wrong label that costs the role its
// credibility.
const typeLikeKinds: ReadonlySet<string> = new Set(["interface", "type", "enum", "namespace"]);

// expandUses emits the caller and test roles.
//
// Uses of unexported declarations count, as in gorefactor: most signature
// changes are to module-private functions used within their own module.
// Exportedness is a ranking input, which priorityFor already scores.
export function expandUses(b: Builder): void {
  const tests: UseSite[] = [];
  for (const s of collectUses(b)) {
    if (isTestPath(s.rel)) {
      tests.push(s);
      continue;
    }
    addCallerSite(b, s);
  }
  addTestSites(b, tests);
}

function addCallerSite(b: Builder, s: UseSite): void {
  const start = Math.max(s.line - callerContextLines, 1);
  const end = s.line + callerContextLines;
  const details: Record<string, string> = { kind: s.kind, line: String(s.line) };
  if (s.syntax !== undefined) {
    details["syntax"] = s.syntax;
  }
  const encl = b.enclosingAt(s.rel, s.line);
  if (encl) {
    details["callerSymbol"] = encl.scope;
    details["callerKind"] = encl.kind;
  }
  b.add({
    role: "caller",
    priority: priorityFor(s.target),
    symbol: s.target.symbol,
    scope: s.target.scope,
    file: s.rel,
    startLine: start,
    endLine: end,
    content: b.slice(s.rel, start, end),
    details,
  });
}

// addTestSites emits the whole test block that reaches a changed symbol, once,
// naming every changed symbol it reaches. The assertions are the part that
// says what the symbol is supposed to do, and they are usually below the call.
//
// The key is the block, not the block and the symbol: gorefactor once shipped
// one table test thirteen times, byte for byte, differing only in what it
// covered. The block is the innermost one around the use, identified by
// position, so two tests with the same name in different describes stay apart.
function addTestSites(b: Builder, sites: readonly UseSite[]): void {
  interface Group {
    encl: Decl;
    covers: string[];
    symbols: string[];
    priority: number;
  }
  const order: Group[] = [];
  const byKey = new Map<string, Group>();
  for (const s of sites) {
    const encl = b.enclosingAt(s.rel, s.line);
    if (!encl) {
      continue;
    }
    let g = byKey.get(encl.key);
    if (!g) {
      g = { encl, covers: [], symbols: [], priority: 0 };
      byKey.set(encl.key, g);
      order.push(g);
    }
    g.covers.push(s.target.scope);
    g.symbols.push(s.target.symbol);
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
      details: {
        kind: "test",
        covers: sortedUnique(g.covers).join(", "),
        testFor: sortedUnique(g.symbols).join(", "),
      },
    });
  }
}

// collectUses resolves the references of every changed declaration and keeps
// the ones outside the change. The result is sorted because the language
// service makes no promise about order, and an envelope whose order depends on
// it cannot be compared with itself.
function collectUses(b: Builder): UseSite[] {
  const seen = new Set<string>();
  const out: UseSite[] = [];
  for (const d of b.decls) {
    if (d.kind === "describe" || d.kind === "test" || !Node.isReferenceFindable(d.nameNode)) {
      continue;
    }
    let refs: Node[];
    try {
      refs = d.nameNode.findReferencesAsNodes();
    } catch (err) {
      b.notes.push(`references to ${d.scope} were not resolved: ${errorMessage(err)}`);
      continue;
    }
    for (const r of refs) {
      const parent = r.getParent();
      if (!parent || plumbingParents.has(parent.getKind())) {
        continue;
      }
      const sf = r.getSourceFile();
      const rel = b.rel(sf.getFilePath());
      if (rel === undefined) {
        continue;
      }
      const { line, column } = sf.getLineAndColumnAtPos(r.getStart());
      if (insideChanged(b, rel, line)) {
        continue;
      }
      // Keyed on the line, not the column: a caller's content is the lines
      // around the use, so two uses of one symbol on one line — a parameter
      // and a return type, say — would ship the same bytes twice.
      const key = `${rel}:${line}:${d.scope}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const [kind, syntax] = useKind(r, d);
      out.push({ rel, line, col: column, kind, syntax, target: d });
    }
  }
  return out.sort((a, c) => compareStrings(sortKey(a), sortKey(c)));
}

// sortKey orders a use site by where it sits, padded so the string compares in
// numeric order.
function sortKey(u: UseSite): string {
  const pad = (n: number) => String(n).padStart(8, "0");
  return `${u.rel}:${pad(u.line)}:${pad(u.col)}:${u.target.scope}`;
}

// insideChanged reports whether a line falls inside a declaration the diff
// touched. These roles answer what else the change affects, and code inside
// the change is not that: the enclosing role already ships those lines whole.
function insideChanged(b: Builder, rel: string, line: number): boolean {
  return b.decls.some((d) => d.rel === rel && d.start <= line && line <= d.end);
}

// useKind labels what a reference does with the symbol it reaches: calls it
// (directly, as a method, with new, as a tag, or by rendering it as a JSX
// element), or only names it.
function useKind(ref: Node, target: Decl): [UseSite["kind"], string | undefined] {
  let cur: Node = ref;
  let parent = cur.getParent();
  while (
    parent &&
    ((Node.isPropertyAccessExpression(parent) && parent.getNameNode() === cur) ||
      Node.isParenthesizedExpression(parent) ||
      Node.isNonNullExpression(parent))
  ) {
    cur = parent;
    parent = cur.getParent();
  }
  if (!parent || typeLikeKinds.has(target.kind)) {
    return ["reference-site", undefined];
  }
  if ((Node.isCallExpression(parent) || Node.isNewExpression(parent)) && parent.getExpression() === cur) {
    return ["call-site", undefined];
  }
  if (Node.isTaggedTemplateExpression(parent) && parent.getTag() === cur) {
    return ["call-site", undefined];
  }
  if ((Node.isJsxOpeningElement(parent) || Node.isJsxSelfClosingElement(parent)) && parent.getTagNameNode() === cur) {
    return ["call-site", "jsx"];
  }
  return ["reference-site", undefined];
}
