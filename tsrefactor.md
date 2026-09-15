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
provider discovery is purely config-driven (`internal/provider/provider.go`); a consuming repo only
adds a `context:` entry to its `.redline.yml` once `tsrefactor` exists on PATH.

**tsrefactor is repo-agnostic.** Nothing in it may assume the application repository, a `ui/` directory, or any
fixed location of TypeScript sources or of the `typescript` package. Development and verification
must not require a the application repository checkout: the bug described above is reproduced as a self-contained
fixture (see Verification). the application repository is one consumer, used only for an optional manual check.

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
    role: "enclosing" | "caller" | "removal" | "type" | "sibling" | "test" | "history"
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
  Redline ranks by `role` (fixed order enclosing→caller→removal→type→sibling→test→history, per
  `roleRank` in redline's `envelope.go`) then `priority`
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
| `src/git.ts` | `git.go` (+ `analyzer/gitenv.go`) | Merge-base (with `mergeBase`'s fallback: if `git merge-base <ref> HEAD` fails, use `git rev-parse --verify <ref>^{commit}` so a first commit still produces an envelope), changed paths (tracked + untracked, `--name-status -z` + `ls-files --others`), hunk ranges (`git diff -U0`), line history (`git log -L`). **Same exact command list, same env-scrubbing** (strip `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_WORK_TREE`/`GIT_OBJECT_DIRECTORY`/`GIT_ALTERNATE_OBJECT_DIRECTORIES`/`GIT_PREFIX`/`GIT_COMMON_DIR`/`GIT_QUARANTINE_PATH` from the child's env before every git call — this is not Go-specific, port it verbatim). |
| `src/classify.ts` | `classify.go` | File classification. Reuse gorefactor's exact lockfile/migration name lists (`package-lock.json`, `yarn.lock`, `pnpm-lock.yaml`, etc. are cross-language already). TS-specific: generated-name suffixes `.generated.ts`, `.gen.ts`, `.d.ts` (careful: `.d.ts` is nearly always hand-written for ambient types in this repo — verify against real files before treating as generated) — no repo-specific codegen prefixes baked in; anchored header scan, same 40-line cap, but the regex must cover TS conventions (`@generated`, `DO NOT EDIT`, `eslint-disable` + `generated` banners) rather than Go's `Code generated … DO NOT EDIT` only. `migrationNameRe` accepts only `.sql`/`.go` in Go — extend to `.ts`/`.js`. Test suffix: `.test.ts(x)`, `.spec.ts(x)`. |
| `src/project.ts` | `loadModule` + `index.unit` in `resolve.go` (which call `internal/goload`) | **The single ts-morph `Project` load.** No hardcoded paths: `--in` (default cwd) only locates the work tree. Configs are discovered **per changed file** — the nearest `tsconfig.json` walking upward from each changed `.ts(x)` file, bounded by the git top-level — because redline runs from the tree root, where an upward search from cwd never reaches a config in a subdirectory. Compiler options come from the discovered leaf config that owns the most changed files; every leaf's files are loaded. If that config is a solution-style root (`files: []` + `references`, common in Vite setups), follow the references and load every referenced project's files. If no tsconfig is found, fall back to a default-options project over the changed files, with a note. The compiler is ts-morph's bundled `typescript` — never resolved from the target repo — so an uninstalled `node_modules` only degrades imported-type resolution into `notes[]`. `getProgram()` triggers the type-check once; called exactly once per `Build`, and only if at least one changed path is `.ts`/`.tsx`. Port `index.unit`'s fallback: a changed file the project doesn't include (or that fails to parse into it) is parsed standalone so it still gets enclosing decls, without types. |
| `src/resolve.ts` | `resolve.go` | Map each changed hunk's line range to its enclosing top-level declaration. Decl shapes to handle (wider than Go's func/method/type/var/const): function declaration, `const x = (...) => ...` / `function expression`, class + class method, object literal method, exported `interface`/`type` alias, and — TS/React-specific — a component defined as a `const Foo: FC<Props> = (...) => ...`. Use `sourceFile.getDescendantAtPos()` + ascend to nearest declaration-shaped ancestor, analogous to `declsIn`. Track `(file, start-pos)` as the identity key the way `resolve.go` tracks `types.Object.Pos()` — this is what ties a symbol found one way to a decl found another way; do not use name-string matching for identity anywhere in this pipeline. |
| `src/expand.ts` | `expand.go` | Orchestration + `priorityFor` (identical formula: `50 + (exported?30:0) + min(changed,20)`, so 50..100), history driving from the manifest (not decls): changed-line spans → `history` role; **deleted-line spans → `removal` role** at fixed priority `removedHistoryPriority` (`expandRemovedHistory`), `rankedSides`/`rankedRanges` longest-span-first capping with a note per dropped span count, `noteEmptyRoles` over all seven roles, `sortExpansions` (role rank → priority desc → file → startLine → symbol → content, stable). |
| `src/expandUses.ts` | `expand_uses.go` | **The load-bearing module — this is what fixes the bug.** For each changed decl, use ts-morph's `Node#findReferencesAsNodes()` (backed by the real LanguageService, so it resolves through destructuring, re-exports, and barrel `index.ts` files) to get every real reference, not text search. Classify `call-site` vs `reference-site` by checking whether the reference's parent is a `CallExpression`/`JsxOpeningElement` (JSX component usage is a TS-specific "call-site" concept Go doesn't have — decide whether to fold it into `call-site` or add reasoning in `details`). Skip references inside any changed declaration's own span (mirrors `insideChanged`). Partition non-test → `caller` role (±2 lines context, same as `callerContextLines = 2`); test → grouped-by-enclosing-test-function `test` role expansions, same dedupe-by-`(function, symbol)` logic that stopped gorefactor's own duplicate-test-row bug. |
| `src/expandTypes.ts` | `expand_types.go` | For a changed function/component's signature, walk parameter/return/prop types (ts-morph `Type` walking through unions/arrays/promises, same depth-6 cutoff) emitting `type`-role expansions for each named type/interface declared outside the change. Siblings follow `expandSiblings`' direction exactly: **changed type (or class of a changed method) → each project interface it satisfies → the *other* project types that satisfy the same interface**. TS structural typing means "implements" isn't nominal like Go: use assignability (confirm `isTypeAssignableTo` is public on the pinned TypeScript's `TypeChecker`; otherwise go through ts-morph's `compilerObject`), but also count explicit `implements` clauses. Skip project-external (lib/`node_modules`) types as gorefactor skips out-of-module ones, and skip interfaces with **no required members** — Go's `NumMethods() == 0` guard, which matters more under structural typing since an all-optional interface matches nearly everything. Same `siblingsPerInterface = 12` cap and overflow note. |
| `src/prompt.ts` | `prompt.go` | Static TypeScript-idiom prose, structurally parallel to gorefactor's seven sections but for TS/React: promise/async error handling and unhandled rejections; `unknown` vs `any` and narrowing; nullish (`null` vs `undefined`) semantics; structural typing and when an interface is redundant beside its only implementation; React hook rules (deps arrays, stale closures, effect cleanup); test convention in this repo (co-located `*.test.tsx`, RTL patterns) — generic TS/React test idiom, not any one repo's house style; load-bearing idioms (discriminated unions + exhaustiveness checks, early return over nesting). Keep it about idiom only — no output-format rules (that's redline's harness half). |
| `src/summary.ts` | `summary.go` | Same rendered fields, same order, for human sanity-checking without `--json`. |
| `src/envelope.ts` | `envelope.go` | Types above + `Role` rank table + `Validate()`/`UnknownRoles()` ports, used by the CLI and by tests. |
| `src/cli.ts` (bin `tsrefactor`) | `cmd_context_changed.go` | Arg parsing, `--budget`+`--changed` usage error, `--json` wrapping (2-space indent, `\n` line endings), non-JSON `Summary()` output. |

Additional modules and decisions made during implementation:

- `src/build.ts` ports `changectx.go`'s `Build`/`manifest` (the three abort points); `src/builder.ts`
  holds the per-run state and helpers (`slice`, `add`, `declsForRel`, `enclosingAt`, `sortedUnique`).
- **Class members**: a top-level class yields the class decl plus one decl per member
  (`Class.member`). A hunk inside a member selects only the member; the class is selected only for
  changed lines outside every member (header, decorators, attached comments, between members). When
  both a class and its members are changed, `enclosing` emits the class once and skips the members,
  whose content it already carries; the members still count as changed decls for later stages.
- **Attached comments**: a decl's start includes the run of comments directly above it, stopping at
  a blank line (Go's `Doc` semantics), so a file header is not the first decl's documentation.
- **Scope format**: `path/to/file.ts:Symbol` — TS modules are files, not directories.
- **Identity**: `Decl.key` is `rel:offset` of the declared name node.
- **Type-check notes** cover option/global diagnostics and the changed files only (checking the
  whole program on every run is the cost gorefactor pays per package, not per file); cap 5 plus a
  count line.
- Until a stage lands, `noteEmptyRoles` says "this version of tsrefactor does not produce this role
  yet" rather than claiming the change had nothing for it.
- **History labelling with classes**: `historyContext` treats a changed class and its own changed
  members as one declaration (the class), so a span inside a changed class is labelled with the class
  rather than left unlabelled as a multi-declaration span.
- **Uses (phase 4, as built)**: references come from `findReferencesAsNodes()` on each changed decl's
  name node (verified to follow barrels, destructured returns, and JSX with no `node_modules`).
  Import/export specifiers, `export default X`, and JSX closing tags are plumbing and skipped.
  `call-site` covers direct and method calls, `new`, tagged templates, and a component rendered as a
  JSX element (`details.syntax = "jsx"`); references to interfaces, type aliases, enums, and
  namespaces are always `reference-site`. Dedupe key is `file:line:scope` — a deliberate departure
  from gorefactor's `file:line:col:scope`: a caller's content is the ±2 lines around the use, so two
  uses of one symbol on one line (`(a: Decl, c: Decl)`) shipped byte-identical expansions twice, as
  observed on this repo's own diff.
  A use is a test use when `isTestPath` (classify's test rule) holds; it groups under the innermost
  enclosing decl by position key.
- **Test blocks (as built)**: `describe`/`context`/`suite` and `it`/`test`/`specify`/`bench` calls —
  through `.only`/`.skip`/`.each(...)` chains, requiring a function argument — are decls of kind
  `describe`/`test`, named `outer > inner` from their first argument, nested with `ancestors` and a
  `members` rule like classes. Recognizing the framework by callee name is classification only;
  identity is still the block's position. (Superseded note below kept for the record.)
- **Types (phase 5, as built)**: two walks per changed function/method/constructor/accessor. First the
  names written in parameter and return annotations (and a variable's own annotation), resolved
  through imports — needed because the checker erases aliases of primitives (`id: RecordId` has type
  `string`). Then the checker's types, depth 6, through unions, intersections, tuples, arrays, type
  arguments, alias type arguments, and anonymous function types' signatures — for inferred types.
  Only interface/type-alias/class/enum declarations inside the work tree count (enum members map to
  their enum); library types are walked through but never emitted. Identity is the declaration node.
  A type is emitted once across all changed decls, and never when it is itself changed.
- **Siblings (phase 5, as built)**: changed classes and classes of changed members → project
  interfaces (and object-literal type aliases) with at least one required member → other project
  classes that satisfy the same interface. "Satisfies" is `checker.isTypeAssignableTo` (public in the
  bundled TypeScript 6.0) or an explicit `implements` clause resolving to that interface — the clause
  is what catches generic interfaces, whose declared type instantiations are not assignable to.
  Known gap: a generic interface implemented structurally with no clause is not matched. Only classes
  are implementations; a changed interface does not itself look for siblings.
- With all seven roles built, the "does not produce this role yet" placeholder is gone.
- **Test blocks need a decl shape before phase 4.** TS tests are top-level call statements
  (`test("name", () => …)`, `describe(…, () => { it(…) })`), which resolve to no declaration today —
  observed on this repo's own diff, where history inside `test(...)` bodies is unlabelled. gorefactor's
  test role groups use sites by *enclosing test function*; the TS port must group by enclosing test
  block instead, named from the call's string argument(s) (e.g. `describe name > it name`), with the
  same one-expansion-per-block dedupe.

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
4. **Uses (caller/test)**: `src/expandUses.ts`. This is the phase that must pass the
   bug-reproduction fixture (see Verification) before moving on.
5. **Types + siblings**: `src/expandTypes.ts`.
6. **Prompt + summary + determinism tests**: `src/prompt.ts`, `src/summary.ts`, and a test that runs
   `context --changed` twice against a fixed revision and asserts byte-identical stdout.
7. **Wire into a consumer** (e.g. the application repository — outside this repo, optional for tsrefactor's own
   completion): add to that repo's `.redline.yml`, with `scope` globs matching wherever *that* repo
   keeps its TypeScript:
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
- **The bug we found, as a self-contained acceptance fixture** (no the application repository needed): a fixture
  repo under `test/fixtures/` whose TypeScript sits in a non-root subdirectory (so tsconfig discovery
  is exercised, not assumed) and reproduces the shape of the miss:
  - `useRefreshQueries.ts` — a hook taking a list of query keys and returning a refresh
    callback, re-exported through a barrel `index.ts`;
  - `DashboardPage.tsx` — imports the hook via the barrel and calls
    `useRefreshQueries(refreshQueryKeys)`, using a destructured return;
  - `DetailExpansionPanel.tsx` — a component using its own query keys, rendered by the page.

  Two follow-up commits, each a separate test: (a) change the hook's signature → the envelope must
  contain a `caller` expansion in `DashboardPage.tsx` at the `useRefreshQueries(refreshQueryKeys)`
  line (the edge graphify's tree-sitter parser missed); (b) change the panel's query keys → the
  envelope must contain a `caller` expansion at the panel's JSX usage in `DashboardPage.tsx`. Note what
  the caller role can and can't reach: the refresh call site appears only when the hook (or
  `refreshQueryKeys`) is part of the change. The fixture must be installable-free — no
  `node_modules` — to prove resolution relies on nothing outside the repo.
- **Determinism**: run twice against the same revision, diff stdout, must be empty.
- **End-to-end with redline**: in-repo, run redline against a fixture repo whose `.redline.yml`
  configures `tsrefactor` and confirm the resulting `session.json` envelopes array includes
  `tsrefactor`, with the changed `.ts(x)` files carrying expansions rather than being reported as
  uncovered. Optionally, and outside this repo's done-criteria, repeat against a real consumer such as
  the application repository once it's wired (delivery step 7).
