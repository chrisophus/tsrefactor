# tsrefactor

A TypeScript context provider for redline, the TypeScript
sibling of gorefactor's `context --changed`. For a change, it emits redline's context envelope:
every changed file classified, and the code a reviewer needs that the diff does not carry —
enclosing declarations, callers, the history of changed and deleted lines, the types a changed
signature names, sibling implementations, and the tests that reach a changed symbol.

Symbols are resolved with the TypeScript compiler (through ts-morph), never by matching text, so
callers are found through barrel re-exports, destructured returns, aliased imports, and JSX.

## Install

```sh
npm ci
npm run build
npm link        # puts `tsrefactor` on PATH
```

The target repository needs no `node_modules`: tsrefactor uses the compiler ts-morph bundles, and
imports it cannot resolve become notes rather than failures.

## Use

```sh
tsrefactor context --changed <ref> [--in <path>] [--json]
```

- `--changed <ref>`: measure the change from the merge base of `<ref>` and `HEAD` to the working
  tree, untracked files included.
- `--in <path>`: any directory inside the work tree (default: the current directory). tsconfig files
  are found by walking up from each changed file, so TypeScript kept in a subdirectory needs no flag.
- `--json`: the envelope redline reads. Without it, a short summary for a person.

Output is byte-identical for the same revision. `--budget` is refused: expansions are emitted whole
for redline to rank and cut.

## With redline

Add to the reviewed repository's `.redline.yml`, with `scope` matching where that repository keeps
its TypeScript:

```yaml
context:
  - name: tsrefactor
    command: tsrefactor
    args: ["context", "--changed", "{{base}}", "--json"]
    scope: ["**/*.ts", "**/*.tsx"]
```

## Develop

```sh
npm run check     # typecheck, lint, knip, tests — what CI should run
npm test          # node --test, run directly on the TypeScript sources
npm run typecheck
npm run lint      # eslint; --fix is `npm run lint:fix`
npm run knip      # unused files, exports, dependencies
```

Linting follows the same division this repository recommends for Go: nothing
here re-implements a check an off-the-shelf linter already does. ESLint carries
the type-aware rules (typescript-eslint's strict type-checked set), the size and
shape thresholds gorefactor uses for Go (75-line functions, complexity 15,
nesting 5), sonarjs for cognitive complexity and duplicate logic, unicorn's
correctness rules, and import-x for cycles and fan-out. knip owns unused files,
exports, and dependencies. Complexity findings are warnings, the advisory tier;
everything else is an error.

`tsrefactor.md` is the design: what each module ports from gorefactor, and the decisions made where
TypeScript differs from Go.
