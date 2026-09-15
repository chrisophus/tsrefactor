import assert from "node:assert/strict";
import { test } from "node:test";

import { Project } from "ts-morph";

import { countChanged, declsIn, selectedBy, type Decl } from "../src/resolve.ts";

const mappingFixture = `// Licensed under the fixture license.

import { thing } from "./thing";

/** Kind is what a thing is. */
export enum Kind {
  A,
  B,
}

// greet says hello.
// It is exported through the list below.
function greet(name: string): string {
  return \`hello \${name}\`;
}

export interface Greeter {
  greet(name: string): string;
}

export type Name = string;

export const Panel: FC<Props> = ({ title }) => {
  return title;
};

export const { first, second: renamed } = thing;

let a = 1,
  b = 2;

export class Store {
  #secret = 1;
  private hidden = 2;

  /** add records a greeting. */
  add(name: string): void {
    greet(name);
  }
}

export default function () {}

export { greet };
`;

function declsOf(source: string): Decl[] {
  const project = new Project({ useInMemoryFileSystem: true });
  const sf = project.createSourceFile("/src/fix.ts", source);
  return declsIn(sf, "src/fix.ts");
}

function bySymbol(decls: Decl[]): Map<string, Decl> {
  return new Map(decls.map((d) => [d.symbol, d]));
}

test("declsIn names, kinds, spans, and exports", () => {
  const got = bySymbol(declsOf(mappingFixture));
  const want: Array<[symbol: string, kind: string, start: number, end: number, exported: boolean]> = [
    ["Kind", "enum", 5, 9, true],
    ["greet", "function", 11, 15, true],
    ["Greeter", "interface", 17, 19, true],
    ["Name", "type", 21, 21, true],
    ["Panel", "function", 23, 25, true],
    ["first", "const", 27, 27, true],
    ["renamed", "const", 27, 27, true],
    ["a", "let", 29, 29, false],
    ["b", "let", 30, 30, false],
    ["Store", "class", 32, 40, true],
    ["Store.#secret", "property", 33, 33, false],
    ["Store.hidden", "property", 34, 34, false],
    ["Store.add", "method", 36, 39, true],
    ["default", "function", 42, 42, true],
  ];
  assert.deepEqual([...got.keys()].sort(), want.map(([s]) => s).sort());
  for (const [symbol, kind, start, end, exported] of want) {
    const d = got.get(symbol)!;
    assert.deepEqual(
      { kind: d.kind, start: d.start, end: d.end, exported: d.exported },
      { kind, start, end, exported },
      symbol,
    );
  }
  assert.equal(got.get("Store.add")!.container, "Store");
  assert.equal(got.get("Store.add")!.parentKey, got.get("Store")!.key);
  assert.equal(got.get("greet")!.scope, "src/fix.ts:greet");
});

test("declaration keys are positions, unique per declared name", () => {
  const decls = declsOf(mappingFixture);
  assert.equal(new Set(decls.map((d) => d.key)).size, decls.length);
  const again = declsOf(mappingFixture);
  assert.deepEqual(
    again.map((d) => d.key),
    decls.map((d) => d.key),
  );
});

test("attached comments stop at a blank line", () => {
  const header = bySymbol(declsOf("// File header.\n\nexport const x = 1;\n"));
  assert.equal(header.get("x")!.start, 3);
  const attached = bySymbol(declsOf("// x is one.\nexport const x = 1;\n"));
  assert.equal(attached.get("x")!.start, 1);
});

test("a changed line maps to the innermost declaration", () => {
  const decls = declsOf(mappingFixture);
  const cases: Array<[line: number, want: string[]]> = [
    [14, ["greet"]], // the body of greet
    [12, ["greet"]], // its attached comment
    [24, ["Panel"]],
    [30, ["b"]],
    [38, ["Store.add"]], // inside a method: the method, not the class
    [36, ["Store.add"]],
    [35, ["Store"]], // between members: the class
    [32, ["Store"]], // the class header
    [2, []],
  ];
  for (const [line, want] of cases) {
    const hits = decls.filter((d) => selectedBy(d, [{ start: line, end: line }])).map((d) => d.symbol);
    assert.deepEqual(hits, want, `line ${line}`);
  }
});

test("countChanged counts only the overlap", () => {
  const greet = bySymbol(declsOf(mappingFixture)).get("greet")!;
  assert.equal(
    countChanged(greet, [
      { start: 1, end: 12 },
      { start: 15, end: 20 },
    ]),
    3,
  );
});
