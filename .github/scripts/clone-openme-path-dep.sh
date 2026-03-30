#!/usr/bin/env bash
# ClawX depends on @shadanai/openclaw via file:../openme. CI clones GitLab repo
# thinkgs/openme, branch dabao, into …/openme (folder name matches file:../openme).
#
# Private repo: do NOT put passwords in this file. Add GitHub Actions secret
# OPENME_GIT_URL = https://oauth2:<gitlab_token>@hub.thinkgs.cn/thinkgs/openme.git
# (create a Personal Access Token or Deploy Token on GitLab with read_repository).
# Optional: secret OPENME_GIT_REF to override branch (default: dabao).
set -euo pipefail
: "${GITHUB_WORKSPACE:?GITHUB_WORKSPACE must be set}"

DEFAULT_OPENME_GIT_URL="https://hub.thinkgs.cn/thinkgs/openme.git"
OPENME_GIT_REF="${OPENME_GIT_REF:-dabao}"

PARENT="$(dirname "$GITHUB_WORKSPACE")"
OPENME_DIR="$PARENT/openme"

if [[ -f "$OPENME_DIR/package.json" ]]; then
  echo "openme already present at $OPENME_DIR"
  exit 0
fi

CLONE_URL="${OPENME_GIT_URL:-$DEFAULT_OPENME_GIT_URL}"
echo "Cloning thinkgs/openme (branch ${OPENME_GIT_REF}) → $OPENME_DIR"
git clone -b "$OPENME_GIT_REF" --depth 1 "$CLONE_URL" "$OPENME_DIR"
