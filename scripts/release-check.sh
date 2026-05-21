#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

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
git status --short

echo
"$ROOT_DIR/scripts/verify.sh"

echo

echo "==> npm whoami"
npm whoami

echo

echo "==> npm pack --dry-run"
npm pack --dry-run

echo

echo "✅ Release checks complete"
