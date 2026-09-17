# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-09-17

First release. A TypeScript context provider for redline, mirroring gorefactor's
`context --changed` for a project resolved through `ts-morph` (the real
TypeScript compiler and checker) instead of `go/types`.

### Added
- `tsrefactor context --changed <ref> [--in <path>] [--json]`: one project load,
  one pass resolving every changed span to its declaration, then expansion
  stages driven by the checker - `enclosing`, `caller`, `type`, `sibling`,
  `test`, `history`, `removal`, `callee`, `indirect-caller`.
- Symbol resolution through the compiler, not text matching: callers are found
  through barrel re-exports, destructured returns, aliased imports, and JSX.
  JavaScript is resolved too when the project allows it.
- A deterministic `queryKey` note: when a change edits a cache key - a
  `queryKey` property, or a variable named for one - the envelope names the
  `invalidateQueries` and friends found in the resolved context and says
  plainly that whether those keys still cover the changed one was not
  determined. Matching two array literals is a guess, so it goes to the
  unknowns rather than an asserted finding.
- `--history-revisions`/`--history-spans` to size the history and removal
  roles per the repository's own churn.
- `make install` (npm ci, build, npm link) and `make help`/`build`/`check`/
  `test`/`lint`/`clean`.
- Off-the-shelf linting: ESLint's type-aware rules, sonarjs, unicorn,
  import-x, and knip for unused files/exports/dependencies, instead of
  hand-rolled checks.

## [Unreleased]: https://github.com/chrisophus/tsrefactor/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/chrisophus/tsrefactor/releases/tag/v0.1.0
