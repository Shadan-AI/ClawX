#!/usr/bin/env bash
# openme's dist/ is gitignored; ClawX links file:../openme — CI must build before pnpm install.
set -euo pipefail
: "${GITHUB_WORKSPACE:?}"
PARENT="$(dirname "$GITHUB_WORKSPACE")"
OPENME="$PARENT/openme"
cd "$OPENME"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=8192}"
echo "Building openme at $OPENME (pnpm install + pnpm run build)..."
pnpm install
pnpm run build
echo "openme build finished."
