#!/usr/bin/env bash
# The studio's checks for this project (.sandbox/sandbox.yaml), the same as `npm run check` in CI,
# split so a failure names its step. Runs in the slot's worktree as the agent user.
set -euo pipefail
export npm_config_cache="${SANDBOX_SLOT_DIR:?}/npm-cache"
case "${1:-}" in
  typecheck) exec npm run --silent typecheck ;;
  lint) npm run --silent lint; exec npm run --silent knip ;;
  test) exec npm test ;;
  *) echo "usage: check.sh typecheck|lint|test" >&2; exit 2 ;;
esac
