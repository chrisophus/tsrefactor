This project is tsrefactor, a TypeScript refactoring tool for agents. The code is in `src/`, tests in `test/`.

- When a ticket leaves product or design choices open, even ones it says are for a person, pick the
  simplest reasonable option, build it, and list the choices you made at the top of the pull request
  so they can be changed in review. Start permissive and leave tightening for later. Stop and ask only
  when the change would delete data, cannot be undone, or would expose a secret. The other rules here
  still apply.
- Read `README.md` and `tsrefactor.md` before changing behaviour; keep them true when the code changes.
- Every change needs a test in `test/` next to the ones already there.
- Dependencies are installed. Run `npm run typecheck`, `npm run lint`, `npm run knip` and `npm test` for what you changed, and say in your reply what you ran and what it said. Do not add dependencies unless the issue asks for it.
- Never edit `dist/`; it is build output.
- Add a line to `CHANGELOG.md` for a change a user would notice.
