#!/usr/bin/env bash
# ClawX depends on @shadanai/openclaw via file:../openme. CI only checks out this
# repo, so we clone openme next to GITHUB_WORKSPACE (…/work/<repo>/openme).
set -euo pipefail
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE must be set}"
: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set for private same-org clones}"

PARENT="$(dirname "$GITHUB_WORKSPACE")"
OPENME_DIR="$PARENT/openme"

if [[ -f "$OPENME_DIR/package.json" ]]; then
  echo "openme already present at $OPENME_DIR"
  exit 0
fi

git clone --depth 1 \
  "https://x-access-token:${GITHUB_TOKEN}@github.com/Shadan-Ai/openme.git" \
  "$OPENME_DIR"
