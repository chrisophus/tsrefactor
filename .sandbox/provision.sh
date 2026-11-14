#!/usr/bin/env bash
# Once per slot, in its fresh worktree, before the agent has run there: the dependencies CI uses.
set -euo pipefail
npm ci --no-fund --no-audit
