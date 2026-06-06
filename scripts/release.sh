#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage: scripts/release.sh [--allow-dirty] <patch|minor|major> [commit message]

Options:
  --allow-dirty  Allow releasing with uncommitted tracked changes.
                 Untracked files are never auto-committed.

Examples:
  scripts/release.sh patch
  scripts/release.sh patch "Fix persisted focus echo status output"
  scripts/release.sh --allow-dirty patch "WIP checkpoint"
EOF
}

ALLOW_DIRTY=0
BUMP_TYPE=""
COMMIT_MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --help|-h) usage; exit 0 ;;
    patch|minor|major)
      if [[ -n "$BUMP_TYPE" ]]; then
        echo "❌ Only one bump type allowed." >&2
        usage >&2
        exit 1
      fi
      BUMP_TYPE="$1"
      shift
      ;;
    *)
      COMMIT_MESSAGE="$COMMIT_MESSAGE $1"
      shift
      ;;
  esac
done

COMMIT_MESSAGE="${COMMIT_MESSAGE# }"

if [[ -z "$BUMP_TYPE" ]]; then
  usage >&2
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  echo "❌ Could not determine the current git branch." >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "❌ Git remote 'origin' is not configured; cannot push release commit/tag." >&2
  exit 1
fi

PACKAGE_NAME="$(node -p "require('./package.json').name")"
CURRENT_VERSION="$(node -p "require('./package.json').version")"

GIT_STATUS="$(git status --short)"
HAS_MODIFIED_UNSTAGED="$(git diff --name-only | wc -l | tr -d ' ')"
HAS_MODIFIED_STAGED="$(git diff --cached --name-only | wc -l | tr -d ' ')"
HAS_MODIFIED_TRACKED=$((HAS_MODIFIED_UNSTAGED + HAS_MODIFIED_STAGED))
HAS_UNTRACKED="$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')"

if [[ -n "$GIT_STATUS" ]]; then
  if [[ "$ALLOW_DIRTY" -eq 0 ]]; then
    echo "❌ Working tree is not clean. Commit or stash changes before release." >&2
    echo "   Use --allow-dirty to stage tracked changes only after cleaning untracked files." >&2
    echo
    echo "$GIT_STATUS"
    exit 1
  fi

  if [[ "$HAS_UNTRACKED" -gt 0 ]]; then
    echo "❌ Working tree has untracked files." >&2
    echo "   Untracked files can be accidentally included by npm pack. Clean or ignore them before release." >&2
    echo
    echo "$GIT_STATUS"
    exit 1
  fi

  if [[ "$HAS_MODIFIED_TRACKED" -eq 0 ]]; then
    echo "❌ Working tree has no modified tracked files to commit." >&2
    echo
    echo "$GIT_STATUS"
    exit 1
  fi

  if [[ -z "$COMMIT_MESSAGE" ]]; then
    read -r -p "Commit message for tracked changes: " COMMIT_MESSAGE
  fi

  if [[ -z "$COMMIT_MESSAGE" ]]; then
    echo "❌ A commit message is required when there are uncommitted changes." >&2
    exit 1
  fi
fi

echo "==> Running release checks"
RC_ARGS=()
[[ "$ALLOW_DIRTY" -eq 1 ]] && RC_ARGS+=("--allow-dirty")
"$ROOT_DIR/scripts/release-check.sh" "${RC_ARGS[@]}"

if [[ -n "$GIT_STATUS" ]]; then
  echo
  echo "==> Staging tracked modified files only:"
  if [[ "$HAS_MODIFIED_STAGED" -gt 0 ]]; then
    echo "--- staged ---"
    git diff --cached --name-only
  fi
  if [[ "$HAS_MODIFIED_UNSTAGED" -gt 0 ]]; then
    echo "--- unstaged ---"
    git diff --name-only
  fi
  echo

  read -r -p "Continue with commit? [y/N] " CONFIRM
  case "$CONFIRM" in
    y|Y|yes|YES) ;;
    *)
      echo "Release cancelled."
      exit 1
      ;;
  esac

  echo "==> git add -u"
  git add -u

  echo "==> git commit -m \"$COMMIT_MESSAGE\""
  git commit -m "$COMMIT_MESSAGE"
fi

echo
PREVIEW_VERSION="$(npm version --no-git-tag-version "$BUMP_TYPE" | tr -d 'v')"
git checkout -- package.json >/dev/null 2>&1 || true
if git ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
  git checkout -- package-lock.json >/dev/null 2>&1 || true
fi

echo "Package: $PACKAGE_NAME"
echo "Current version: $CURRENT_VERSION"
echo "Next version:    $PREVIEW_VERSION"
echo

echo "==> Checking npm version availability"
NPM_VIEW_OUTPUT=""
if NPM_VIEW_OUTPUT="$(npm view "$PACKAGE_NAME@$PREVIEW_VERSION" version 2>&1)"; then
  echo "❌ $PACKAGE_NAME@$PREVIEW_VERSION is already published on npm." >&2
  exit 1
fi
if ! grep -Eq '(E404|404|not in this registry)' <<<"$NPM_VIEW_OUTPUT"; then
  echo "❌ Could not verify npm version availability for $PACKAGE_NAME@$PREVIEW_VERSION" >&2
  echo "$NPM_VIEW_OUTPUT" >&2
  exit 1
fi
echo "npm: $PACKAGE_NAME@$PREVIEW_VERSION is available"

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
NEW_TAG="v$NEW_VERSION"

echo "==> npm publish --dry-run --access public"
npm publish --dry-run --access public

echo "==> git push origin $BRANCH"
git push origin "$BRANCH"

echo "==> git push origin $NEW_TAG"
git push origin "$NEW_TAG"

echo "==> npm publish --access public"
npm publish --access public

echo

echo "✅ Released $PACKAGE_NAME@$NEW_VERSION on branch $BRANCH"
