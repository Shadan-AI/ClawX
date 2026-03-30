#!/usr/bin/env bash
# ClawX depends on @shadanai/openclaw via file:../openme. CI clones GitLab repo
# thinkgs/openme, branch dabao, into …/openme (folder name matches file:../openme).
#
# Private repo — use ONE of:
#   A) Secret OPENME_GIT_TOKEN = GitLab PAT only (recommended). Token is URL-encoded
#      here so special characters (e.g. + / @ :) do not break the clone URL.
#   B) Secret OPENME_GIT_URL = full HTTPS URL (if you must; paste carefully, no
#      trailing newline; if clone fails with "Port number", switch to A).
# Optional: OPENME_GIT_REF (default: dabao).
set -euo pipefail
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE must be set}"

GITLAB_HOST="hub.thinkgs.cn"
GITLAB_REPO="thinkgs/openme.git"
DEFAULT_OPENME_GIT_URL="https://${GITLAB_HOST}/${GITLAB_REPO}"
OPENME_GIT_REF="${OPENME_GIT_REF:-dabao}"

trim() {
  printf '%s' "$1" | tr -d '\r\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//'
}

PARENT="$(dirname "$GITHUB_WORKSPACE")"
OPENME_DIR="$PARENT/openme"

if [[ -f "$OPENME_DIR/package.json" ]]; then
  echo "openme already present at $OPENME_DIR"
  exit 0
fi

OPENME_GIT_URL="$(trim "${OPENME_GIT_URL:-}")"
OPENME_GIT_TOKEN="$(trim "${OPENME_GIT_TOKEN:-}")"

if [[ -n "$OPENME_GIT_TOKEN" ]]; then
  # Encode token so oauth2:<token>@host does not break on + / @ : etc.
  export OPENME_GIT_TOKEN
  ENC=$(node -p "encodeURIComponent(process.env.OPENME_GIT_TOKEN || '')")
  CLONE_URL="https://oauth2:${ENC}@${GITLAB_HOST}/${GITLAB_REPO}"
elif [[ -n "$OPENME_GIT_URL" ]]; then
  CLONE_URL="$OPENME_GIT_URL"
else
  CLONE_URL="$DEFAULT_OPENME_GIT_URL"
fi

echo "Cloning thinkgs/openme (branch ${OPENME_GIT_REF}) → $OPENME_DIR"
git clone -b "$OPENME_GIT_REF" --depth 1 "$CLONE_URL" "$OPENME_DIR"
