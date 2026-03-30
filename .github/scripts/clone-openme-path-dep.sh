#!/usr/bin/env bash
# ClawX depends on @shadanai/openclaw via file:../openme. CI only checks out this
# repo, so we clone openme next to GITHUB_WORKSPACE (…/work/<repo>/openme).
#
# Configure clone URL (pick one):
#   - Repository secret OPENME_GIT_URL = full HTTPS clone URL of your openme repo
#     Example (self-hosted GitLab): https://hub.thinkgs.cn/thinkgs/openme.git
#     Private repo: use deploy token or PAT in URL per GitLab docs, e.g.
#     https://oauth2:<token>@hub.thinkgs.cn/thinkgs/openme.git
#   - If OPENME_GIT_URL is unset, falls back to cloning from GitHub using GITHUB_TOKEN
#     (legacy default; only works when openme is on github.com).
set -euo pipefail
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE must be set}"

PARENT="$(dirname "$GITHUB_WORKSPACE")"
OPENME_DIR="$PARENT/openme"

if [[ -f "$OPENME_DIR/package.json" ]]; then
  echo "openme already present at $OPENME_DIR"
  exit 0
fi

if [[ -n "${OPENME_GIT_URL:-}" ]]; then
  echo "Cloning openme from OPENME_GIT_URL → $OPENME_DIR"
  git clone --depth 1 "$OPENME_GIT_URL" "$OPENME_DIR"
elif [[ -n "${GITHUB_TOKEN:-}" ]]; then
  echo "Cloning openme from GitHub (legacy default; set OPENME_GIT_URL if openme is not on GitHub)"
  git clone --depth 1 \
    "https://x-access-token:${GITHUB_TOKEN}@github.com/Shadan-Ai/openme.git" \
    "$OPENME_DIR"
else
  echo "ERROR: Cannot clone openme."
  echo "  Set repository secret OPENME_GIT_URL to the HTTPS git clone URL of your openme repo"
  echo "  (e.g. https://gitee.com/your-org/openme.git or a token URL for private hosts)."
  exit 1
fi
