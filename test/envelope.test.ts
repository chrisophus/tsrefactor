import assert from "node:assert/strict";
import { test } from "node:test";

import {
  encodeEnvelope,
  generatedFiles,
  roleRank,
  roles,
  unknownRoles,
  validate,
  type Envelope,
  type Role,
} from "../src/envelope.ts";

const frame = (): Envelope => ({ schemaVersion: 1, provider: { name: "tsrefactor", version: "0.1.0" } });

test("roles rank in redline's order", () => {
  // This order is redline's, not this provider's: it mirrors roleRank in
  // redline's internal/envelope. callee sits beside caller because it is the
  // same question asked the other way; indirect-caller is last, below history,
  // because history is cheap and a second hop is whole declarations.
  assert.deepEqual(
    [...roles],
    ["enclosing", "caller", "callee", "removal", "type", "sibling", "test", "history", "indirect-caller"],
  );
  assert.deepEqual(roleRank("enclosing"), [0, true]);
  assert.deepEqual(roleRank("callee"), [2, true]);
  assert.deepEqual(roleRank("history"), [7, true]);
  assert.deepEqual(roleRank("indirect-caller"), [8, true]);
  assert.deepEqual(roleRank("invented"), [99, false]);
});

test("validate checks the frame, not the contents", () => {
  assert.equal(validate(frame()), undefined);
  assert.equal(validate({ ...frame(), expansions: [] }), undefined);
  assert.match(validate(null)!.message, /absent/);
  assert.match(validate({ ...frame(), schemaVersion: 2 })!.message, /schema version 2, want 1/);
  assert.match(validate({ ...frame(), provider: { name: " ", version: "" } })!.message, /names no provider/);
  const noRole = { ...frame(), expansions: [{ role: "" as Role, content: "x" }] };
  assert.match(validate(noRole)!.message, /expansion 0 has no role/);
});

test("unknownRoles reports invented roles once, sorted", () => {
  const env: Envelope = {
    ...frame(),
    expansions: [
      { role: "zeta" as Role, content: "a" },
      { role: "enclosing", content: "b" },
      { role: "alpha" as Role, content: "c" },
      { role: "zeta" as Role, content: "d" },
    ],
  };
  assert.equal(validate(env), undefined);
  assert.deepEqual(unknownRoles(env), ["alpha", "zeta"]);
});

test("generatedFiles lists flagged paths sorted", () => {
  const env: Envelope = {
    ...frame(),
    files: [
      { path: "b.gen.ts", class: "generated", generated: true },
      { path: "a.ts", class: "source" },
      { path: "a.gen.ts", class: "generated", generated: true },
    ],
  };
  assert.deepEqual(generatedFiles(env), ["a.gen.ts", "b.gen.ts"]);
});

test("encodeEnvelope follows the Go structs' omitempty rules and key order", () => {
  const env: Envelope = {
    schemaVersion: 1,
    provider: { name: "tsrefactor", version: "" },
    baseSHA: "",
    files: [{ path: "a.ts", class: "source", generated: false, symbols: [] }],
    expansions: [
      {
        role: "enclosing",
        priority: 0,
        symbol: "f",
        startLine: 0,
        content: "",
        details: { zeta: "1", alpha: "2" },
      },
    ],
    notes: [],
  };
  const out = encodeEnvelope(env);
  assert.ok(out.endsWith("}\n") && !out.endsWith("\n\n"));
  assert.equal(
    out,
    JSON.stringify(
      {
        schemaVersion: 1,
        provider: { name: "tsrefactor", version: "" },
        files: [{ path: "a.ts", class: "source" }],
        expansions: [{ role: "enclosing", symbol: "f", content: "", details: { alpha: "2", zeta: "1" } }],
      },
      null,
      2,
    ) + "\n",
  );
});
