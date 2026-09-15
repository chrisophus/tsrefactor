// Maps each changed hunk to the top-level declaration that encloses it. Ports
// declsIn and the resolve stage of gorefactor's internal/changectx.
//
// A declaration's identity is the position of the name it declares, never the
// name as a string: two files may both declare `total`, and only a position
// ties a symbol found one way to a declaration found another.

import { Node, SyntaxKind, type ClassDeclaration, type ExpressionStatement, type SourceFile } from "ts-morph";

import { errorMessage, sortedUnique, type Builder } from "./builder.ts";
import type { File } from "./envelope.ts";
import { hunkRanges, isDeleted, type Change, type LineRange } from "./git.ts";
import { loadProject } from "./project.ts";

// tsSourceRe matches the files this provider resolves symbols in.
export const tsSourceRe = /\.[cm]?tsx?$/;

// Decl is one top-level declaration, one member of a top-level class, or one
// test block (describe/it/test) at the top level or nested in a describe.
export interface Decl {
  rel: string; // repo-relative path of the file it lives in
  symbol: string; // name, or Class.member for a class member
  scope: string; // file-qualified symbol, opaque to the consumer
  kind: string; // function, class, method, property, interface, type, enum, const, ...
  container: string | undefined; // the class a member belongs to
  parentKey: string | undefined; // the key of the declaration directly containing this one
  ancestors: string[]; // keys of every declaration containing this one, outermost first
  start: number; // first line, attached comments included
  end: number; // last line
  exported: boolean;
  changed: number; // how many of its lines the diff touched
  key: string; // rel:offset of the declared name, the identity used across stages
  node: Node;
  nameNode: Node; // the name references are resolved from
  members: LineRange[] | undefined; // for a class, the spans of its members
}

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

// declsIn returns every top-level declaration in the file, plus the members of
// top-level classes, in source order. A variable statement declaring several
// names yields one declaration per name so a one-line change inside a long
// list names the entry it touched.
export function declsIn(sf: SourceFile, rel: string): Decl[] {
  const text = sf.getFullText();
  const lineOf = (pos: number) => sf.getLineAndColumnAtPos(pos).line;
  const make = (node: Node, span: Node, symbol: string, nameNode: Node, kind: string, exported: boolean): Decl => ({
    rel,
    symbol,
    scope: qualify(rel, symbol),
    kind,
    container: undefined,
    parentKey: undefined,
    ancestors: [],
    start: lineOf(attachedStart(span, text)),
    end: lineOf(span.getEnd()),
    exported,
    changed: 0,
    key: `${rel}:${nameNode.getStart()}`,
    node,
    nameNode,
    members: undefined,
  });

  const out: Decl[] = [];
  for (const stmt of sf.getStatements()) {
    if (Node.isFunctionDeclaration(stmt)) {
      const nameNode = stmt.getNameNode();
      out.push(make(stmt, stmt, nameNode?.getText() ?? "default", nameNode ?? stmt, "function", isExported(stmt)));
    } else if (Node.isClassDeclaration(stmt)) {
      out.push(...classDecls(stmt, make));
    } else if (Node.isInterfaceDeclaration(stmt)) {
      out.push(make(stmt, stmt, stmt.getName(), stmt.getNameNode(), "interface", isExported(stmt)));
    } else if (Node.isTypeAliasDeclaration(stmt)) {
      out.push(make(stmt, stmt, stmt.getName(), stmt.getNameNode(), "type", isExported(stmt)));
    } else if (Node.isEnumDeclaration(stmt)) {
      out.push(make(stmt, stmt, stmt.getName(), stmt.getNameNode(), "enum", isExported(stmt)));
    } else if (Node.isModuleDeclaration(stmt)) {
      out.push(make(stmt, stmt, stmt.getName(), stmt.getNameNode(), "namespace", isExported(stmt)));
    } else if (Node.isVariableStatement(stmt)) {
      const list = stmt.getDeclarations();
      const word = stmt.getDeclarationKind();
      for (const decl of list) {
        const span = list.length === 1 ? stmt : decl;
        const kind = isFunctionValue(decl.getInitializer()) ? "function" : word;
        const nameNode = decl.getNameNode();
        if (Node.isIdentifier(nameNode)) {
          out.push(make(decl, span, nameNode.getText(), nameNode, kind, isExported(decl) || stmt.isExported()));
          continue;
        }
        for (const id of nameNode.getDescendantsOfKind(SyntaxKind.Identifier)) {
          if (!isBindingName(id)) continue;
          out.push(make(decl, span, id.getText(), id, kind, stmt.isExported()));
        }
      }
    } else if (Node.isExportAssignment(stmt)) {
      out.push(make(stmt, stmt, stmt.isExportEquals() ? "export=" : "default", stmt, "export", true));
    } else if (Node.isExpressionStatement(stmt)) {
      out.push(...testBlocks(stmt, [], [], make));
    }
  }
  return out;
}

type MakeDecl = (node: Node, span: Node, symbol: string, nameNode: Node, kind: string, exported: boolean) => Decl;

// classDecls yields the class and each of its members. A member is exported
// when its class is and it is not private.
function classDecls(cls: ClassDeclaration, make: MakeDecl): Decl[] {
  const className = cls.getName() ?? "default";
  const exported = isExported(cls);
  const classDecl = make(cls, cls, className, cls.getNameNode() ?? cls, "class", exported);
  const members: Decl[] = [];
  for (const m of cls.getMembers()) {
    let name: string;
    let nameNode: Node;
    let kind: string;
    if (Node.isConstructorDeclaration(m)) {
      name = "constructor";
      nameNode = m.getFirstChildByKind(SyntaxKind.ConstructorKeyword) ?? m;
      kind = "constructor";
    } else if (Node.isClassStaticBlockDeclaration(m)) {
      name = "static";
      nameNode = m;
      kind = "static block";
    } else if (Node.isPropertyNamed(m)) {
      nameNode = m.getNameNode();
      name = nameNode.getText();
      kind = Node.isMethodDeclaration(m)
        ? "method"
        : Node.isGetAccessorDeclaration(m)
          ? "getter"
          : Node.isSetAccessorDeclaration(m)
            ? "setter"
            : "property";
    } else {
      continue;
    }
    const isPrivate = name.startsWith("#") || (Node.isModifierable(m) && m.hasModifier(SyntaxKind.PrivateKeyword));
    const d = make(m, m, `${className}.${name}`, nameNode, kind, exported && !isPrivate);
    d.container = className;
    d.parentKey = classDecl.key;
    d.ancestors = [classDecl.key];
    members.push(d);
  }
  classDecl.members = members.map((d) => ({ start: d.start, end: d.end }));
  return [classDecl, ...members];
}

// Test framework entry points. Recognizing a block by the function it calls is
// classification, not identity: the block's identity is still its position.
const describeNames: ReadonlySet<string> = new Set(["describe", "context", "suite"]);
const testNames: ReadonlySet<string> = new Set(["it", "test", "specify", "bench"]);

// testBlocks yields the test block a statement opens, if it opens one, and the
// blocks nested in it. A test file's code lives in calls rather than
// declarations, so without these a change inside a test resolves to nothing
// and a use of a changed symbol from a test has no function to group under.
//
// A block is a call to a framework entry point, through .only/.skip/.each
// chains, that passes a function. It is named from its first argument, joined
// with the names of the describes around it.
function testBlocks(stmt: ExpressionStatement, outerNames: string[], outerKeys: string[], make: MakeDecl): Decl[] {
  const call = stmt.getExpression();
  if (!Node.isCallExpression(call)) {
    return [];
  }
  const kind = frameworkKind(call);
  const args = call.getArguments();
  const body = args.find((a) => Node.isArrowFunction(a) || Node.isFunctionExpression(a));
  if (!kind || !body || !(Node.isArrowFunction(body) || Node.isFunctionExpression(body))) {
    return [];
  }
  const names = [...outerNames, blockName(args[0])];
  const block = make(stmt, stmt, names.join(" > "), stmt, kind, false);
  block.ancestors = [...outerKeys];
  block.parentKey = outerKeys[outerKeys.length - 1];
  const out = [block];
  const inner = body.getBody();
  if (kind === "describe" && Node.isBlock(inner)) {
    for (const s of inner.getStatements()) {
      if (Node.isExpressionStatement(s)) {
        out.push(...testBlocks(s, names, [...outerKeys, block.key], make));
      }
    }
    block.members = out.filter((d) => d.parentKey === block.key).map((d) => ({ start: d.start, end: d.end }));
  }
  return out;
}

// frameworkKind reports whether a call opens a describe or a test, following
// the callee through property accesses and curried calls down to the entry
// point: it.only(...), describe.each(table)(...), test.describe(...).
function frameworkKind(call: Node): "describe" | "test" | undefined {
  let callee: Node = call;
  const properties: string[] = [];
  for (;;) {
    if (Node.isCallExpression(callee)) {
      callee = callee.getExpression();
    } else if (Node.isPropertyAccessExpression(callee)) {
      properties.push(callee.getName());
      callee = callee.getExpression();
    } else {
      break;
    }
  }
  if (!Node.isIdentifier(callee)) {
    return undefined;
  }
  const root = callee.getText();
  if (!describeNames.has(root) && !testNames.has(root)) {
    return undefined;
  }
  return describeNames.has(root) || properties.some((p) => describeNames.has(p)) ? "describe" : "test";
}

function blockName(arg: Node | undefined): string {
  if (!arg) {
    return "(anonymous)";
  }
  if (Node.isStringLiteral(arg) || Node.isNoSubstitutionTemplateLiteral(arg)) {
    return arg.getLiteralText();
  }
  return arg.getText().replaceAll(/\s+/g, " ");
}

function isExported(n: Node): boolean {
  return Node.isExportGetable(n) && n.isExported();
}

// isFunctionValue reports whether an initializer is a function, directly or
// through the wrappers components are commonly declared with: memo(() => ...),
// forwardRef(function ...), and type assertions.
function isFunctionValue(init: Node | undefined): boolean {
  let n = init;
  while (
    n &&
    (Node.isParenthesizedExpression(n) ||
      Node.isAsExpression(n) ||
      Node.isSatisfiesExpression(n) ||
      Node.isTypeAssertion(n) ||
      Node.isNonNullExpression(n))
  ) {
    n = n.getExpression();
  }
  if (!n) return false;
  if (Node.isArrowFunction(n) || Node.isFunctionExpression(n)) return true;
  if (Node.isCallExpression(n)) {
    const first = n.getArguments()[0];
    return first !== undefined && (Node.isArrowFunction(first) || Node.isFunctionExpression(first));
  }
  return false;
}

// isBindingName reports whether an identifier inside a destructuring pattern
// is a name the pattern binds, rather than a property key or a default value.
function isBindingName(id: Node): boolean {
  const parent = id.getParent();
  return Node.isBindingElement(parent) && parent.getNameNode() === id;
}

// attachedStart is where a declaration starts once the comments attached to it
// are counted: the run of comments directly above, stopping at a blank line so
// a file header is not read as the first declaration's documentation.
function attachedStart(node: Node, text: string): number {
  let start = node.getStart();
  const comments = node.getLeadingCommentRanges();
  for (let i = comments.length - 1; i >= 0; i--) {
    const c = comments[i]!;
    const gap = text.slice(c.getEnd(), start);
    if ((gap.match(/\n/g)?.length ?? 0) > 1) {
      break;
    }
    start = c.getPos();
  }
  return start;
}

// qualify prefixes a symbol with the file it lives in. The consumer treats the
// result as an opaque string; the shape only has to be stable and readable.
export function qualify(rel: string, symbol: string): string {
  return `${rel}:${symbol}`;
}

// overlaps reports whether a declaration covers any part of a changed span.
export function overlaps(d: Decl, r: LineRange): boolean {
  return d.start <= r.end && r.start <= d.end;
}

// selectedBy reports whether the change touched a declaration. A class counts
// only for changed lines outside all its members — its header, decorators,
// attached comments, the lines between members — so an edit inside one method
// names the method, not the method and the whole class around it.
export function selectedBy(d: Decl, ranges: readonly LineRange[]): boolean {
  if (!ranges.some((r) => overlaps(d, r))) {
    return false;
  }
  if (!d.members || d.members.length === 0) {
    return true;
  }
  for (const r of ranges) {
    for (let line = Math.max(r.start, d.start); line <= Math.min(r.end, d.end); line++) {
      if (!d.members.some((m) => m.start <= line && line <= m.end)) {
        return true;
      }
    }
  }
  return false;
}

// countChanged sums the lines of a declaration the diff touched. It feeds the
// priority hint, where a heavily rewritten function outranks a one-line edit.
export function countChanged(d: Decl, ranges: readonly LineRange[]): number {
  let total = 0;
  for (const r of ranges) {
    const lo = Math.max(r.start, d.start);
    const hi = Math.min(r.end, d.end);
    if (lo <= hi) {
      total += hi - lo + 1;
    }
  }
  return total;
}

// declCompare orders declarations by where they live, so every stage that walks
// them emits in the same order on every run.
export function declCompare(a: Decl, c: Decl): number {
  if (a.rel !== c.rel) return a.rel < c.rel ? -1 : 1;
  if (a.start !== c.start) return a.start - c.start;
  return a.symbol < c.symbol ? -1 : a.symbol > c.symbol ? 1 : 0;
}
