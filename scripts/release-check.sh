#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ALLOW_DIRTY=0
DRY_RUN=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: release-check.sh [--allow-dirty] [--dry-run]" >&2
      exit 1
      ;;
  esac
done

PACKAGE_NAME="$(node -p "require('./package.json').name")"
PACKAGE_VERSION="$(node -p "require('./package.json').version")"
BRANCH="$(git branch --show-current)"

if [[ -z "$BRANCH" ]]; then
  echo "❌ Could not determine the current git branch." >&2
  exit 1
fi

echo "Package: $PACKAGE_NAME@$PACKAGE_VERSION"
echo "Branch:  $BRANCH"
echo

echo "==> git status --short"
GIT_STATUS="$(git status --short)"
HAS_UNTRACKED="$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')"
echo "${GIT_STATUS:-(clean)}"
echo

if [[ -n "$GIT_STATUS" ]]; then
  if [[ "$ALLOW_DIRTY" -eq 0 ]]; then
    echo "❌ Working tree is not clean. Commit, stash, or ignore changes before release." >&2
    echo "   Use --allow-dirty to bypass this check for tracked changes only." >&2
    exit 1
  fi

  if [[ "$HAS_UNTRACKED" -gt 0 ]]; then
    echo "❌ Working tree has untracked files." >&2
    echo "   Untracked files can be accidentally included by npm pack. Clean or ignore them before release." >&2
    exit 1
  fi

  echo "⚠️ Working tree has tracked uncommitted changes (allowed via --allow-dirty)"
fi

echo "==> Running verification"
"$ROOT_DIR/scripts/verify.sh"

echo

echo "==> npm whoami"
npm whoami

echo

echo "==> npm pack --dry-run"
npm pack --dry-run

echo

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "✅ Dry run complete"
else
  echo "✅ Release checks complete"
fi
