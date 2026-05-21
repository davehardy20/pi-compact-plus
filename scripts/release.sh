#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: scripts/release.sh <patch|minor|major> [commit message]

Examples:
  scripts/release.sh patch
  scripts/release.sh patch "Fix persisted focus echo status output"
EOF
}

if [[ $# -lt 1 ]]; then
  usage >&2
  exit 1
fi

BUMP_TYPE="$1"
shift

case "$BUMP_TYPE" in
  patch|minor|major) ;;
  *)
    usage >&2
    exit 1
    ;;
esac

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "❌ Could not determine the current git branch." >&2
  exit 1
fi

PACKAGE_NAME="$(node -p "require('./package.json').name")"
CURRENT_VERSION="$(node -p "require('./package.json').version")"
COMMIT_MESSAGE="$*"

if [[ -n "$(git status --short)" ]]; then
  if [[ -z "$COMMIT_MESSAGE" ]]; then
    read -r -p "Commit message for current changes: " COMMIT_MESSAGE
  fi

  if [[ -z "$COMMIT_MESSAGE" ]]; then
    echo "❌ A commit message is required when there are uncommitted changes." >&2
    exit 1
  fi
fi

echo "==> Running release checks"
"$ROOT_DIR/scripts/release-check.sh"

if [[ -n "$(git status --short)" ]]; then
  echo
  echo "==> git add -A"
  git add -A

  echo "==> git commit -m \"$COMMIT_MESSAGE\""
  git commit -m "$COMMIT_MESSAGE"
fi

echo
PREVIEW_VERSION="$(npm version --no-git-tag-version "$BUMP_TYPE" | tr -d 'v')"
git checkout -- package.json package-lock.json >/dev/null 2>&1 || true

echo "Package: $PACKAGE_NAME"
echo "Current version: $CURRENT_VERSION"
echo "Next version:    $PREVIEW_VERSION"
read -r -p "Continue with release? [y/N] " CONFIRM
case "$CONFIRM" in
  y|Y|yes|YES) ;;
  *)
    echo "Release cancelled."
    exit 1
    ;;
esac

echo

echo "==> npm version $BUMP_TYPE"
npm version "$BUMP_TYPE"
NEW_VERSION="$(node -p "require('./package.json').version")"

echo "==> git push origin $BRANCH"
git push origin "$BRANCH"

echo "==> git push origin $BRANCH --tags"
git push origin "$BRANCH" --tags

echo "==> npm publish --access public"
npm publish --access public

echo

echo "✅ Released $PACKAGE_NAME@$NEW_VERSION on branch $BRANCH"
