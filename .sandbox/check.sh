#!/usr/bin/env bash
# Sandbox Studio's check for this repository: `npm run check`, the same gate as CI (typecheck,
# eslint, knip, then the tests). It runs in a slot's worktree as the agent user.
# It installs the dependencies first when the slot has none yet, or when the lockfile changed since
# it last installed them, so the check runs against what the branch names. The agent user owns
# node_modules that way, and can run `npm ci` itself during a turn.
set -euo pipefail
export npm_config_cache="${SANDBOX_SLOT_DIR:?}/npm-cache"
if [ ! -d node_modules ] || ! cmp -s package-lock.json node_modules/.package-lock.studio; then
  npm ci --no-audit --no-fund
  cp package-lock.json node_modules/.package-lock.studio
fi
exec npm run check
