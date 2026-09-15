# Build `tsrefactor`: a TypeScript context provider for redline, mirroring gorefactor's `changectx`

## Context

Redline (the code-review CLI at `~/sandbox/redline`, `github.com/chrisophus/redline`) builds an
LLM review packet out of per-language "context envelopes." For Go, `gorefactor context --changed
<ref> --json` supplies real semantic context — enclosing declarations, call sites, referenced
types, interface siblings, history — resolved through `go/types`, never by text matching. For
TypeScript there is currently **no equivalent provider configured** in the application repository: `.redline.yml`
has no `context:` key at all, so every `ui/**/*.ts(x)` file in a diff is reported as uncovered
context.

We proved this matters. Investigating why two independent redline reviews (and a real GitHub
Copilot review) all missed a specific bug — `DetailExpansionPanel.tsx`'s React Query
cache keys not covered by `DashboardPage.tsx`'s refresh-button invalidation (`useRefreshQueries`)
— we traced it to a structural gap: the frontend gets zero symbol-level context in redline's packet
today. We then tested whether adding a graphify-backed provider would help, and confirmed graphify's
`tree-sitter-typescript` parser (syntax-only, no type binder) **also misses this exact relationship**:
it never captured that `DashboardPage.tsx` calls `useRefreshQueries` at all, because resolving a
destructured hook return to its declaration needs real symbol binding, not pattern matching.

gorefactor's `internal/changectx` package proves the right shape for this job already exists and
works: one project load, one pass to resolve every changed span to its declaration, then expansion
stages (enclosing / caller / type / sibling / test / history) driven entirely by the type checker.
The plan is to build a TypeScript sibling, `tsrefactor`, that reproduces the same pipeline using
`ts-morph` (a wrapper over the real TypeScript compiler/checker) instead of `go/types` — closing the
exact gap that caused the miss, because `ts-morph`'s reference resolution follows destructuring,
re-exports, and barrel files the way `go/types`'s `Uses` map already does for Go.

This is a new standalone repo, pure Node.js/TypeScript (decided), analogous to how gorefactor is its
own repo rather than living inside redline or the application repository. Redline needs **no source changes** —
provider discovery is purely config-driven (`internal/provider/provider.go`); this only requires a
`context:` entry in the application repository's `.redline.yml` once `tsrefactor` exists on PATH.

## Wire contract (fixed — do not deviate)

Verified directly against redline's source (`internal/envelope/envelope.go`,
`internal/provider/provider.go`) and `docs/context-envelope.md`:

- **Invocation**: `tsrefactor context --changed <ref> [--in <path>] [--json]`, run with cwd = the
  tree under review (may be a detached worktree, never assume the user's checkout). Exit 0 on
  success. Anything on stderr is shown verbatim in the report on failure, so first-line stderr
  should be a useful diagnosis. `--budget` must be a **usage error** when combined with
  `--changed` (gorefactor's rule: "expansions are emitted whole for the consumer to rank").
- **Output**: one JSON object on stdout, either the bare envelope or wrapped as
  `{"ok": bool, "error": string, "data": {...}}` — bare is simplest, adopt that.
- **Determinism**: the same revision must produce byte-identical output. This governs every sort
  order below.
- **Envelope shape** (TS port of `envelope.go`'s Go structs, same JSON field names/optionality):
  ```ts
  interface Envelope {
    schemaVersion: 1
    provider: { name: "tsrefactor"; version: string; language: "typescript" }
    baseSHA?: string
    files?: File[]
    expansions?: Expansion[]
    promptFragment?: string
    notes?: string[]
  }
  interface File {
    path: string
    class: "source" | "generated" | "vendored" | "test" | "migration" | "lockfile" | "other"
    generated?: boolean   // omit key when false
    symbols?: string[]
  }
  interface Expansion {
    role: "enclosing" | "caller" | "type" | "sibling" | "test" | "history"
    priority?: number     // omit key when 0 — higher = more valuable, ranks only within a role
    symbol?: string
    scope?: string
    file?: string
    startLine?: number    // omit key when 0; 1-based inclusive
    endLine?: number
    content: string       // never omitted; never emit a blank one — drop the expansion instead
    details?: Record<string, string>
  }
  ```
  Redline ranks by `role` (fixed order enclosing→caller→type→sibling→test→history) then `priority`
  descending — a provider cannot promote a role. An unknown role ranks last and is reported by name,
  never silently dropped. **Never truncate to a self-imposed budget** — emit everything resolved;
  redline's 250k-token ceiling does the cutting.
- **No caps in the wire contract**, but gorefactor imposes several *internally* to keep any one
  file/interface from drowning the envelope (see caps table below) — port these exactly for parity.

## Architecture — one module per changectx stage

New repo `~/sandbox/tsrefactor` (mirrors `~/sandbox/gorefactor`'s layout intent, Node/TS instead of
Go). Each module below is a direct port of the correspondingly-named file in
`~/sandbox/gorefactor/internal/changectx/`; cite that file when a design question comes up during
implementation — the algorithms are already fully specified there, not to be redesigned.

| Module (new) | Ports | Job |
|---|---|---|
| `src/git.ts` | `git.go` | Merge-base, changed paths (tracked + untracked, `--name-status -z` + `ls-files --others`), hunk ranges (`git diff -U0`), line history (`git log -L`). **Same exact command list, same env-scrubbing** (strip `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE`/`GIT_OBJECT_DIRECTORY`/`GIT_ALTERNATE_OBJECT_DIRECTORIES`/`GIT_PREFIX`/`GIT_COMMON_DIR`/`GIT_QUARANTINE_PATH` from the child's env before every git call — this is not Go-specific, port it verbatim). |
| `src/classify.ts` | `classify.go` | File classification. Reuse gorefactor's exact lockfile/migration name lists (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, etc. are cross-language already). TS-specific: generated-name suffixes `.generated.ts`, `.gen.ts`, `.d.ts` (careful: `.d.ts` is nearly always hand-written for ambient types in this repo — verify against real files before treating as generated) and prefixes matching this repo's codegen dirs (check for an OpenAPI-generated TS client, similar to `oas_*` in Go); anchored "DO NOT EDIT"/"@generated" header scan, same 40-line cap. Test suffix: `.test.ts(x)`, `.spec.ts(x)`. |
| `src/project.ts` | `goload.go` | **The single ts-morph `Project` load.** Construct from `tsconfig.json` (search upward from `--in`, matching `ui/` in the application repository), `Project.getProgram()` triggers the type-check once. No caching layer needed — like `goload`, called exactly once per `Build`, and only if at least one changed path is `.ts`/`.tsx`. |
| `src/resolve.ts` | `resolve.go` | Map each changed hunk's line range to its enclosing top-level declaration. Decl shapes to handle (wider than Go's func/method/type/var/const): function declaration, `const x = (...) => ...` / `function expression`, class + class method, object literal method, exported `interface`/`type` alias, and — TS/React-specific — a component defined as a `const Foo: FC<Props> = (...) => ...`. Use `sourceFile.getDescendantAtPos()` + ascend to nearest declaration-shaped ancestor, analogous to `declsIn`. Track `(file, start-pos)` as the identity key the way `resolve.go` tracks `types.Object.Pos()` — this is what ties a symbol found one way to a decl found another way; do not use name-string matching for identity anywhere in this pipeline. |
| `src/expand.ts` | `expand.go` | Orchestration + `priorityFor` (identical formula: `50 + (exported?30:0) + min(changed,20)`, so 50..100), history-role driving from the manifest (not decls), `noteEmptyRoles`, `sortExpansions` (role rank → priority desc → file → startLine → symbol → content, stable). |
| `src/expandUses.ts` | `expand_uses.go` | **The load-bearing module — this is what fixes the bug.** For each changed decl, use ts-morph's `Node#findReferencesAsNodes()` (backed by the real LanguageService, so it resolves through destructuring, re-exports, and barrel `index.ts` files) to get every real reference, not text search. Classify `call-site` vs `reference-site` by checking whether the reference's parent is a `CallExpression`/`JsxOpeningElement` (JSX component usage is a TS-specific "call-site" concept Go doesn't have — decide whether to fold it into `call-site` or add reasoning in `details`). Skip references inside any changed declaration's own span (mirrors `insideChanged`). Partition non-test → `caller` role (±2 lines context, same as `callerContextLines = 2`); test → grouped-by-enclosing-test-function `test` role expansions, same dedupe-by-`(function, symbol)` logic that stopped gorefactor's own duplicate-test-row bug. |
| `src/expandTypes.ts` | `expand_types.go` | For a changed function/component's signature, walk parameter/return/prop types (ts-morph `Type` walking through unions/arrays/promises, same depth-6 cutoff) emitting `type`-role expansions for each named type/interface declared outside the change. For sibling implementations of a changed `interface`: TS structural typing means "implements" isn't nominal like Go — use `checker.isTypeAssignableTo` against every other declared type/interface in the project (skip global/library ones the same way gorefactor skips anything outside the loaded module), same `siblingsPerInterface = 12` cap. |
| `src/prompt.ts` | `prompt.go` | Static TypeScript-idiom prose, structurally parallel to gorefactor's seven sections but for TS/React: promise/async error handling and unhandled rejections; `unknown` vs `any` and narrowing; nullish (`null` vs `undefined`) semantics; structural typing and when an interface is redundant beside its only implementation; React hook rules (deps arrays, stale closures, effect cleanup); test convention in this repo (co-located `*.test.tsx`, RTL patterns) — check a few existing `ui/src/**/*.test.tsx` files for the actual house style before writing this section; load-bearing idioms (discriminated unions + exhaustiveness checks, early return over nesting). Keep it about idiom only — no output-format rules (that's redline's harness half). |
| `src/summary.ts` | `summary.go` | Same rendered fields, same order, for human sanity-checking without `--json`. |
| `src/envelope.ts` | `envelope.go` | Types above + `Role` rank table + `Validate()`/`UnknownRoles()` ports, used by the CLI and by tests. |
| `src/cli.ts` (bin `tsrefactor`) | `cmd_context_changed.go` | Arg parsing, `--budget`+`--changed` usage error, `--json` wrapping (2-space indent, `\n` line endings), non-JSON `Summary()` output. |

### Numeric caps to port exactly (parity with gorefactor's fixture behavior)

| constant | value | purpose |
|---|---|---|
| generated-header scan window | 40 lines | how far into a file to look for a generated-file marker |
| `historyRevisions` | 3 | `git log -n 3 -L...` |
| `historyRangesPerFile` | 3 | capped spans per file that get their own history (changed side and removed side, separately) |
| `removedHistoryPriority` | 120 | fixed priority for removed-line history (above the 50–100 decl band) |
| `callerContextLines` | 2 | lines of context around a call site |
| `siblingsPerInterface` | 12 | capped implementations emitted per (changed type, interface) pair |
| type-walk depth cutoff | 6 | stops descending into deeply nested generic/array/union types |
| `priorityFor` | `50 + (exported?30:0) + min(changed,20)` | same formula, same band |
| type-check error notes cap | 5 | max diagnostic messages surfaced in `notes[]` |

### Error-handling convention (port exactly — this is what keeps the tool honest under partial failure)

Only three failures should abort the whole run: can't locate the work tree, can't resolve the
merge-base, can't list changed files. Everything else — a file that fails to parse, a symbol ts-morph
can't resolve, a `tsconfig.json` that doesn't fully type-check — degrades into a `notes[]` entry, and
the envelope still ships with whatever it could resolve (enclosing/history from syntax alone, even
when the checker can't bind a symbol). `noteEmptyRoles()` must explain *every* empty role by name —
an absent role must never be indistinguishable from a stage that silently crashed.

## Delivery order

Each phase is independently testable and mirrors the module boundaries above, so nothing is built
speculatively ahead of what exercises it:

1. **Skeleton**: `src/git.ts`, `src/classify.ts`, `src/envelope.ts`, `src/cli.ts`. `--changed` returns
   a valid envelope with `files[]` classified and zero expansions. Verifies the wire contract and git
   plumbing before any TS parsing exists.
2. **Project load + resolve + enclosing**: `src/project.ts`, `src/resolve.ts`, enclosing-role emission
   in `src/expand.ts`. First point where `content` is real source text.
3. **History**: the `git log -L` port in `src/git.ts` + history-role wiring in `src/expand.ts`
   (independent of ts-morph entirely, like gorefactor's own history role).
4. **Uses (caller/test)**: `src/expandUses.ts`. This is the phase that must be validated against the
   actual bug (see Verification) before moving on.
5. **Types + siblings**: `src/expandTypes.ts`.
6. **Prompt + summary + determinism tests**: `src/prompt.ts`, `src/summary.ts`, and a test that runs
   `context --changed` twice against a fixed revision and asserts byte-identical stdout.
7. **Wire into the application repository**: add to `.redline.yml`:
   ```yaml
   context:
     - name: tsrefactor
       command: tsrefactor
       args: ["context", "--changed", "{{base}}", "--json"]
       scope: ["ui/**/*.ts", "ui/**/*.tsx"]
   ```
   (gorefactor already claims `**/*.go`; no overlap, no `--defer-callers`-style flag needed.)

## Verification

- **Unit-level**: fixture repos under `test/fixtures/` with a base commit and a follow-up commit,
  asserting exact expansion sets/roles/priorities for known changes (functions, class methods,
  interfaces, hooks) — same style as gorefactor's own `changectx_test.go`.
- **The bug we found, as an acceptance test**: point `tsrefactor context --changed <base>` at the
  redline worktree already materialized at
  `a redline worktree`
  (the application repository at the exact commit both redline runs and the real Copilot review targeted) and
  confirm the envelope now contains a `caller`-role expansion in `DashboardPage.tsx` pointing at the
  `useRefreshQueries(refreshQueryKeys)` call site — the exact edge graphify's tree-sitter
  parser missed. This is the concrete, falsifiable proof the tool does what it's for.
- **Determinism**: run twice against the same revision, diff stdout, must be empty.
- **End-to-end with redline**: after wiring `.redline.yml` (delivery step 7), run `redline run` (or
  the project's usual invocation) against a diff touching `ui/**` and inspect the resulting
  `session.json` envelopes array — `tsrefactor` should appear alongside `gorefactor`/`instructions`/
  `precedent`, and files under `ui/src/components/detail/DetailExpansionPanel.tsx`
  specifically should now carry real expansions instead of appearing only in the bare `files` list
  with `class: "other"` and no symbols, as they did in the session.json we inspected earlier
  (`an earlier session.json`).
