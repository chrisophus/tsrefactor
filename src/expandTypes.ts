// The type and sibling roles. Ports gorefactor's internal/changectx/expand_types.go.

import { Node, type ClassDeclaration, type Symbol as MorphSymbol, type Type } from "ts-morph";

import { errorMessage, type Builder } from "./builder.ts";
import { compareStrings } from "./envelope.ts";
import { priorityFor } from "./priority.ts";
import { functionValueOf, type Decl } from "./decls.ts";

// siblingsPerInterface caps how many other implementations one interface
// contributes. A widely implemented interface would otherwise answer a
// two-line change with every class in the project.
const siblingsPerInterface = 12;

// typeWalkDepth stops the walk descending into deeply nested generic, array,
// and union types.
const typeWalkDepth = 6;

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
    if (signatureKinds.has(d.kind)) {
      emitTypes(b, d, signatureTypeDecls(b, d), "signature", changed, seen);
      // What the body names, which a signature does not reach. A change that
      // starts constructing a different type, or asserting to one, is judged
      // against that type and the signature never mentions it.
      emitTypes(b, d, referencedTypeDecls(b, d), "body", changed, seen);
      continue;
    }
    // A changed interface, class, type alias or variable. Its own referents
    // were never walked: the stage only ever read signatures, so editing an
    // interface brought none of the types of its members.
    emitTypes(b, d, referencedTypeDecls(b, d), "declared", changed, seen);
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
// declCollector accumulates type declarations by key. The two walks below both
// resolve symbols and both have to dedupe, and writing that twice is one
// closure two functions have to be kept in step by hand.
function declCollector(b: Builder): { out: Decl[]; push: (sym: MorphSymbol | undefined) => void } {
  const out: Decl[] = [];
  const keys = new Set<string>();
  return {
    out,
    push: (sym: MorphSymbol | undefined): void => {
      for (const t of declsOfSymbol(b, sym)) {
        if (!keys.has(t.key)) {
          keys.add(t.key);
          out.push(t);
        }
      }
    },
  };
}

// typesPerDecl caps how many types one changed declaration contributes under
// one route. A body naming thirty types would otherwise spend the consumer's
// budget on the vocabulary of the module rather than on the change.
const typesPerDecl = 8;

// emitTypes adds the declarations of types reached by one route, once each
// across the whole change, skipping the ones the change already carries.
//
// via says how the type was reached, because the three are worth different
// amounts: a type in a signature is part of the contract, one in a body is what
// the code works with, and one a changed declaration refers to is its shape.
function emitTypes(
  b: Builder,
  d: Decl,
  targets: readonly Decl[],
  via: string,
  changed: ReadonlySet<string>,
  seen: Set<string>,
): void {
  let kept = 0;
  for (const target of targets) {
    if (seen.has(target.key)) {
      continue;
    }
    if (changed.has(target.key) || target.ancestors.some((k) => changed.has(k))) {
      continue; // its own declaration already carries the change
    }
    if (kept >= typesPerDecl) {
      b.notes.push(`further ${via} type(s) of ${d.scope} were not expanded (cap ${typesPerDecl} per declaration)`);
      return;
    }
    seen.add(target.key);
    kept++;
    b.add({
      role: "type",
      priority: priorityFor(d),
      symbol: target.symbol,
      scope: target.scope,
      file: target.rel,
      startLine: target.start,
      endLine: target.end,
      content: b.slice(target.rel, target.start, target.end),
      details: { kind: "type", referencedBy: d.scope, via },
    });
  }
}

// referencedTypeDecls collects the types a declaration names anywhere inside
// it: a member's type annotation, a local's, a type assertion, a type argument,
// or the class of a new expression. Resolution is the checker's, so a name that
// reaches the type through an alias or a re-export still lands on the
// declaration it was written in.
function referencedTypeDecls(b: Builder, d: Decl): Decl[] {
  const { out, push } = declCollector(b);
  d.node.forEachDescendant((n) => {
    if (Node.isTypeReference(n)) {
      push(n.getTypeName().getSymbol());
      return;
    }
    if (Node.isNewExpression(n)) {
      const e = n.getExpression();
      if (Node.isIdentifier(e)) {
        push(e.getSymbol());
      }
    }
  });
  return out;
}

function signatureTypeDecls(b: Builder, d: Decl): Decl[] {
  const { out, push } = declCollector(b);

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
  const { ifaces, classes } = projectTypes(b);
  const emitted = new Set<string>();
  const ifaceSeen = new Set<string>();
  // When the interface itself is what changed, the classes implementing it are
  // the answer: they are the ones owed the same change. Nothing reached this
  // before, because the walk started from changed classes and an interface is
  // not one.
  addImplementations(b, classes, emitted);
  if (changed.length === 0) {
    return;
  }
  for (const ct of changed) {
    for (const iface of ifaces) {
      if (!hasRequiredMembers(iface) || !satisfies(b, ct, iface)) {
        continue;
      }
      if (addSiblings(b, ct, iface, classes, emitted) > 0) {
        addInterface(b, iface, ifaceSeen);
      }
    }
  }
}

// implementsContract reports whether a class is an implementation of an
// interface for the purpose of a changed contract, which is not the question
// satisfies asks.
//
// An interface that gains a member is exactly the case where its
// implementations stop being assignable to it, and that is the moment a
// reviewer most needs to see them: matching on assignability alone finds the
// classes that are still fine and hides every one the change broke. So a class
// counts when it is assignable, or when it declares a member the interface
// requires -- which is what an implementation halfway through a contract change
// looks like.
function implementsContract(b: Builder, cls: Decl, iface: Decl): boolean {
  if (satisfies(b, cls, iface)) {
    return true;
  }
  if (!Node.isClassDeclaration(cls.node) || !Node.isInterfaceDeclaration(iface.node)) {
    return false;
  }
  const members = new Set(cls.node.getMembers().map((m) => memberName(m)).filter((n) => n !== undefined));
  return iface.node.getMembers().some((m) => {
    const n = memberName(m);
    return n !== undefined && members.has(n);
  });
}

// memberName is the declared name of a class or interface member, when it has
// one an implementation could match: an index signature or a call signature
// does not.
function memberName(m: Node): string | undefined {
  if (Node.isPropertyDeclaration(m) || Node.isMethodDeclaration(m) || Node.isGetAccessorDeclaration(m)) {
    return m.getName();
  }
  if (Node.isPropertySignature(m) || Node.isMethodSignature(m)) {
    return m.getName();
  }
  return undefined;
}

// addImplementations emits the classes that implement an interface the change
// edits. A changed interface is a changed contract, and the reviewer's question
// is which implementations still keep it -- the same question the sibling role
// answers from the other direction.
function addImplementations(b: Builder, classes: readonly Decl[], emitted: Set<string>): void {
  for (const iface of b.decls) {
    if (!Node.isInterfaceDeclaration(iface.node) || !hasRequiredMembers(iface)) {
      continue;
    }
    let kept = 0;
    let skipped = 0;
    for (const cls of classes) {
      if (b.decls.some((c) => c.key === cls.key) || !implementsContract(b, cls, iface)) {
        continue;
      }
      const key = `${iface.scope}|${cls.scope}`;
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
        priority: priorityFor(cls),
        symbol: cls.symbol,
        scope: cls.scope,
        file: cls.rel,
        startLine: cls.start,
        endLine: cls.end,
        content: b.slice(cls.rel, cls.start, cls.end),
        details: { kind: "implementation", interface: iface.scope, implementsChanged: "true" },
      });
    }
    if (skipped > 0) {
      b.notes.push(
        `${skipped} further implementation(s) of ${iface.scope} were not expanded (cap ${siblingsPerInterface} per interface)`,
      );
    }
  }
}

// addInterface emits the interface a changed class satisfies, once, and only
// when a sibling was emitted under it.
//
// The sibling role names it in details.interface and has never sent it. With no
// sibling there is no details.interface either, so there is nothing to complete
// and the interface is one more type the reviewer did not ask for. A
// reviewer holding two implementations and no interface has been shown that the
// two are peers and not what they are peers under, which is the only place the
// contract they both have to keep is written down.
function addInterface(b: Builder, iface: Decl, seen: Set<string>): void {
  if (seen.has(iface.key)) {
    return;
  }
  seen.add(iface.key);
  if (b.decls.some((c) => c.key === iface.key)) {
    return; // the enclosing role already carries it
  }
  b.add({
    role: "type",
    priority: priorityFor(iface),
    symbol: iface.symbol,
    scope: iface.scope,
    file: iface.rel,
    startLine: iface.start,
    endLine: iface.end,
    content: b.slice(iface.rel, iface.start, iface.end),
    details: { kind: "interface", whyShown: "the interface the changed type satisfies" },
  });
}

function addSiblings(b: Builder, ct: Decl, iface: Decl, classes: readonly Decl[], emitted: Set<string>): number {
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
  return kept;
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
