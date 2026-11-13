This repository is tsrefactor, a TypeScript command-line tool that writes the context envelope
for redline. `README.md` says what it does and `tsrefactor.md` describes the design.

- A new worktree has no `node_modules`. Run `npm ci` before anything else.
- The source is in `src/` and the tests in `test/`. Node runs the TypeScript directly; there is no
  build step for the tests.
- Every change needs a test. `npm test` runs the suite, and `node --test test/<file>.test.ts` runs
  one file.
- `npm run check` is the gate CI runs: typecheck, eslint, knip, then the tests. Run it before you
  finish, and say in your reply what it said. knip fails on an export nothing uses, so remove what
  you stop using.
- Symbols are resolved with the TypeScript compiler, never by matching text. Keep it that way.
- If you change `package.json`, run `npm ci` so `package-lock.json` and `node_modules` match it.
- Add an entry to `CHANGELOG.md` under "Unreleased" for a change a user of the tool would notice.
- You cannot change `.github/` or `.sandbox/`. If the issue needs a change there, make the rest of
  the change and say what is left for a person.
