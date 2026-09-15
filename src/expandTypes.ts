// The type and sibling roles. Ports gorefactor's internal/changectx/expand_types.go.

import { Node, type ClassDeclaration, type Symbol as MorphSymbol, type Type } from "ts-morph";

import { errorMessage, type Builder } from "./builder.ts";
import { compareStrings } from "./envelope.ts";
import { priorityFor } from "./expand.ts";
import { functionValueOf, type Decl } from "./resolve.ts";

// siblingsPerInterface caps how many other implementations one interface
// contributes. A widely implemented interface would otherwise answer a
// two-line change with every class in the project.
export const siblingsPerInterface = 12;

// typeWalkDepth stops the walk descending into deeply nested generic, array,
// and union types.
export const typeWalkDepth = 6;

// signatureKinds are the declarations that have a signature to read.
const signatureKinds: ReadonlySet<string> = new Set(["function", "method", "constructor", "getter", "setter"]);

// expandTypes emits the definition of each project type a changed signature
// names. A signature the reviewer cannot resolve is a signature they have to
// guess at.
export function expandTypes(b: Builder): void {
  if (!b.project) {
    return;
  }
  const changed = new Set(b.decls.map((d) => d.key));
  const seen = new Set<string>();
  for (const d of b.decls) {
    if (!signatureKinds.has(d.kind)) {
      continue;
    }
    for (const target of signatureTypeDecls(b, d)) {
      if (seen.has(target.key)) {
        continue;
      }
      seen.add(target.key);
      if (changed.has(target.key) || target.ancestors.some((k) => changed.has(k))) {
        continue; // its own declaration already carries the change
      }
      b.add({
        role: "type",
        priority: priorityFor(d),
        symbol: target.symbol,
        scope: target.scope,
        file: target.rel,
        startLine: target.start,
        endLine: target.end,
        content: b.slice(target.rel, target.start, target.end),
        details: { kind: "type", referencedBy: d.scope },
      });
    }
  }
}

// signatureTypeDecls returns the project type declarations a signature names,
// in the order it names them.
//
// Two walks, because neither sees everything. The checker erases an alias of a
// primitive — `id: RecordId` has type string — so the names written in the
// annotations are read first, resolved through imports. Then the checker's own
// types are walked, which carry what no annotation spells: an inferred return
// type, the element type of an array, the arguments of a generic.
function signatureTypeDecls(b: Builder, d: Decl): Decl[] {
  const out: Decl[] = [];
  const keys = new Set<string>();
  const push = (sym: MorphSymbol | undefined) => {
    for (const t of declsOfSymbol(b, sym)) {
      if (!keys.has(t.key)) {
        keys.add(t.key);
        out.push(t);
      }
    }
  };

  const fn = Node.isVariableDeclaration(d.node) ? functionValueOf(d.node.getInitializer()) : d.node;
  const annotations: Node[] = [];
  if (Node.isVariableDeclaration(d.node)) {
    const tn = d.node.getTypeNode();
    if (tn) annotations.push(tn);
  }
  if (fn && Node.isParametered(fn)) {
    for (const p of fn.getParameters()) {
      const tn = p.getTypeNode();
      if (tn) annotations.push(tn);
    }
  }
  if (fn && Node.isReturnTyped(fn)) {
    const tn = fn.getReturnTypeNode();
    if (tn) annotations.push(tn);
  }
  for (const annotation of annotations) {
    for (const n of [annotation, ...annotation.getDescendants()]) {
      if (Node.isTypeReference(n)) {
        const name = n.getTypeName();
        push((Node.isQualifiedName(name) ? name.getRight() : name).getSymbol());
      } else if (Node.isExpressionWithTypeArguments(n)) {
        push(n.getExpression().getSymbol());
      }
    }
  }

  try {
    const visited = new Set<Type>();
    const walk = (t: Type, depth: number): void => {
      if (depth > typeWalkDepth || visited.has(t)) {
        return;
      }
      visited.add(t);
      push(t.getAliasSymbol());
      push(t.getSymbol());
      const next: Type[] = [...t.getUnionTypes(), ...t.getIntersectionTypes(), ...t.getAliasTypeArguments()];
      if (t.isTuple()) next.push(...t.getTupleElements());
      const element = t.getArrayElementType();
      if (element) next.push(element);
      next.push(...t.getTypeArguments());
      if (t.isAnonymous()) {
        for (const sig of t.getCallSignatures()) {
          for (const p of sig.getParameters()) next.push(p.getTypeAtLocation(d.node));
          next.push(sig.getReturnType());
        }
      }
      for (const n of next) walk(n, depth + 1);
    };
    for (const sig of (fn ?? d.node).getType().getCallSignatures()) {
      for (const p of sig.getParameters()) walk(p.getTypeAtLocation(d.node), 0);
      walk(sig.getReturnType(), 0);
    }
  } catch (err) {
    b.notes.push(`types in the signature of ${d.scope} were not resolved: ${errorMessage(err)}`);
  }
  return out;
}

// declsOfSymbol maps a symbol to the project declarations of the types it
// names, following an import to what it imports. Only type-declaring nodes
// count — an anonymous object type's symbol points into whatever declaration
// wrote the literal, which is not a type the reviewer can go and read — and
// only declarations inside the work tree, so library types are never emitted.
// Identity is the declaration node, never the name.
function declsOfSymbol(b: Builder, sym: MorphSymbol | undefined): Decl[] {
  if (!sym) {
    return [];
  }
  const resolved = sym.isAlias() ? (sym.getAliasedSymbol() ?? sym) : sym;
  const out: Decl[] = [];
  for (const declaration of resolved.getDeclarations()) {
    const node = Node.isEnumMember(declaration) ? declaration.getParent() : declaration;
    if (
      !Node.isInterfaceDeclaration(node) &&
      !Node.isTypeAliasDeclaration(node) &&
      !Node.isClassDeclaration(node) &&
      !Node.isEnumDeclaration(node)
    ) {
      continue;
    }
    const rel = b.rel(node.getSourceFile().getFilePath());
    if (rel === undefined) {
      continue;
    }
    const target = b.declsForRel(rel).find((x) => x.node === node);
    if (target) {
      out.push(target);
    }
  }
  return out;
}

// expandSiblings emits the other implementations of an interface a changed
// class satisfies. It answers the question a diff cannot: whether the same
// change is owed to the classes that sit beside this one.
//
// TypeScript's typing is structural, so a class implements an interface when
// it is assignable to it, clause or no clause; an explicit implements clause
// also counts, since a generic interface's declared type is not one its
// instantiations are assignable to. Interfaces with no required member are
// skipped, gorefactor's empty-interface guard: an all-optional interface is
// satisfied by nearly anything with one matching property.
export function expandSiblings(b: Builder): void {
  if (!b.project) {
    return;
  }
  const changed = changedClasses(b);
  if (changed.length === 0) {
    return;
  }
  const { ifaces, classes } = projectTypes(b);
  const emitted = new Set<string>();
  for (const ct of changed) {
    for (const iface of ifaces) {
      if (!hasRequiredMembers(iface) || !satisfies(b, ct, iface)) {
        continue;
      }
      addSiblings(b, ct, iface, classes, emitted);
    }
  }
}

function addSiblings(b: Builder, ct: Decl, iface: Decl, classes: readonly Decl[], emitted: Set<string>): void {
  let kept = 0;
  let skipped = 0;
  for (const other of classes) {
    if (other.key === ct.key || !satisfies(b, other, iface)) {
      continue;
    }
    const key = `${ct.key}|${other.key}`;
    if (emitted.has(key)) {
      continue;
    }
    if (kept >= siblingsPerInterface) {
      skipped++;
      continue;
    }
    emitted.add(key);
    kept++;
    b.add({
      role: "sibling",
      priority: priorityFor(ct),
      symbol: other.symbol,
      scope: other.scope,
      file: other.rel,
      startLine: other.start,
      endLine: other.end,
      content: b.slice(other.rel, other.start, other.end),
      details: { kind: "implementation", interface: iface.scope, peerOf: ct.scope },
    });
  }
  if (skipped > 0) {
    b.notes.push(
      `${skipped} further implementation(s) of ${iface.scope} were not expanded (cap ${siblingsPerInterface} per interface)`,
    );
  }
}

// changedClasses returns the classes the change touches: changed classes, and
// the classes of changed members.
function changedClasses(b: Builder): Decl[] {
  const out: Decl[] = [];
  const seen = new Set<string>();
  for (const d of b.decls) {
    let cls: Decl | undefined;
    if (d.kind === "class") {
      cls = d;
    } else if (d.container !== undefined && d.parentKey !== undefined) {
      cls = b.declsForRel(d.rel).find((x) => x.key === d.parentKey);
    }
    if (cls && Node.isClassDeclaration(cls.node) && !seen.has(cls.key)) {
      seen.add(cls.key);
      out.push(cls);
    }
  }
  return out;
}

// projectTypes returns every top-level interface (and object-literal type
// alias) and every class declared in the project's own files, each sorted by
// scope. Library and node_modules types are not considered: matching against
// them would report half the project as siblings under some DOM interface.
function projectTypes(b: Builder): { ifaces: Decl[]; classes: Decl[] } {
  const ifaces: Decl[] = [];
  const classes: Decl[] = [];
  const rels = b
    .project!.getSourceFiles()
    .map((sf) => b.rel(sf.getFilePath()))
    .filter((r): r is string => r !== undefined)
    .sort(compareStrings);
  for (const rel of rels) {
    for (const d of b.declsForRel(rel)) {
      if (Node.isInterfaceDeclaration(d.node)) {
        ifaces.push(d);
      } else if (Node.isTypeAliasDeclaration(d.node) && Node.isTypeLiteral(d.node.getTypeNode())) {
        ifaces.push(d);
      } else if (Node.isClassDeclaration(d.node)) {
        classes.push(d);
      }
    }
  }
  const byScope = (a: Decl, c: Decl) => compareStrings(a.scope, c.scope);
  return { ifaces: ifaces.sort(byScope), classes: classes.sort(byScope) };
}

function hasRequiredMembers(iface: Decl): boolean {
  const t = iface.node.getType();
  return (
    t.getProperties().some((p) => !p.isOptional()) ||
    t.getCallSignatures().length > 0 ||
    t.getConstructSignatures().length > 0
  );
}

// satisfies reports whether a class implements an interface, structurally or
// by an explicit clause.
function satisfies(b: Builder, cls: Decl, iface: Decl): boolean {
  if (!Node.isClassDeclaration(cls.node)) {
    return false;
  }
  const checker = b.project!.getTypeChecker().compilerObject;
  try {
    if (checker.isTypeAssignableTo(cls.node.getType().compilerType, iface.node.getType().compilerType)) {
      return true;
    }
  } catch {
    // fall through to the clause
  }
  return implementsClause(b, cls.node, iface);
}

function implementsClause(b: Builder, cls: ClassDeclaration, iface: Decl): boolean {
  return cls.getImplements().some((h) => declsOfSymbol(b, h.getExpression().getSymbol()).some((t) => t.key === iface.key));
}
