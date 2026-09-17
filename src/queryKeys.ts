import { Node } from "ts-morph";

import type { Builder } from "./builder.ts";
import type { Decl } from "./decls.ts";

// invalidators are the calls that clear cached queries. The names are React
// Query's, which is the library the miss behind this repository came from.
const invalidators: ReadonlySet<string> = new Set([
  "invalidateQueries",
  "refetchQueries",
  "resetQueries",
  "removeQueries",
  "cancelQueries",
]);

// maxQueryKeyNotes caps the notes one change produces, so a rename touching
// forty keys does not bury every other unknown.
const maxQueryKeyNotes = 5;

// noteQueryKeys reports, as an unknown, that the change edits a cache key and
// that whether the code clearing those keys still covers it was not determined.
//
// This is the one thing here found by reading names rather than by resolving
// symbols, and that is why it is a note and not an expansion. Every role in
// this envelope is resolved through the checker, and a reviewer has to be able
// to trust that; a key match is a guess about two array literals, so it goes
// where the provider's guesses go -- the unknowns, which redline reports as
// what could not be determined rather than as context it stands behind.
//
// The question is the one the original miss turned on. A panel declared keys
// ["items", "detail", id], a page refreshed [["items", "list"]], and nothing
// said the second does not clear the first.
export function noteQueryKeys(b: Builder): void {
  const changedKeys: string[] = [];
  for (const d of b.decls) {
    changedKeys.push(...queryKeyNames(d));
  }
  if (changedKeys.length === 0) {
    return;
  }
  const sites = invalidationSites(b);
  if (sites.length === 0) {
    b.notes.push(
      `the change edits cache key(s) ${unique(changedKeys).slice(0, maxQueryKeyNotes).join(", ")}, ` +
        "and nothing in the resolved context clears them: whether anything invalidates the changed key was not determined",
    );
    return;
  }
  b.notes.push(
    `the change edits cache key(s) ${unique(changedKeys).slice(0, maxQueryKeyNotes).join(", ")}; ` +
      `${sites.slice(0, maxQueryKeyNotes).join(", ")} clear cached queries. ` +
      "Whether those keys still cover the changed one was not determined: keys are matched by reading names, not resolved",
  );
}

// queryKeyNames returns the cache keys a declaration names, identified by the
// name they are written under rather than by their shape. An array of strings
// is too common to guess from; a property called queryKey is not.
function queryKeyNames(d: Decl): string[] {
  const out: string[] = [];
  const consider = (label: string, value: Node | undefined): void => {
    if (value && Node.isArrayLiteralExpression(value)) {
      out.push(`${label} ${value.getText().replaceAll(/\s+/g, " ")}`);
    }
  };
  d.node.forEachDescendant((n) => {
    if (Node.isPropertyAssignment(n) && n.getName() === "queryKey") {
      consider("queryKey", n.getInitializer());
      return;
    }
    if (Node.isVariableDeclaration(n)) {
      const name = n.getNameNode();
      if (Node.isIdentifier(name) && /querykey/i.test(name.getText())) {
        consider(name.getText(), n.getInitializer());
      }
    }
  });
  return out;
}

// invalidationSites locates the calls that clear cached queries, in the code
// the envelope already resolved: the change itself and what the roles reached.
// Scanning the whole tree would cost more and say less, since a clear a long
// way from the change is not the one the reviewer is being asked about.
function invalidationSites(b: Builder): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const rel of unique(b.exps.map((e) => e.file ?? "").concat(b.decls.map((d) => d.rel)))) {
    if (rel === "") {
      continue;
    }
    const sf = b.sourceFile(rel);
    if (!sf) {
      continue;
    }
    sf.forEachDescendant((n) => {
      if (!Node.isCallExpression(n)) {
        return;
      }
      const name = calleeName(n.getExpression());
      if (!invalidators.has(name)) {
        return;
      }
      const { line } = sf.getLineAndColumnAtPos(n.getStart());
      const at = `${rel}:${String(line)} ${name}`;
      if (!seen.has(at)) {
        seen.add(at);
        out.push(at);
      }
    });
  }
  return out.sort((a, z) => a.localeCompare(z));
}

// calleeName is the name a call is written under: client.invalidateQueries or
// a bare invalidateQueries.
function calleeName(e: Node): string {
  if (Node.isPropertyAccessExpression(e)) {
    return e.getName();
  }
  if (Node.isIdentifier(e)) {
    return e.getText();
  }
  return "";
}

function unique(input: readonly string[]): string[] {
  return [...new Set(input)].sort((a, z) => a.localeCompare(z));
}
