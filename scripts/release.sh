#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

usage() {
  cat <<'EOF'
Usage:
  scripts/release.sh [--allow-dirty] [--yes] <patch|minor|major> [commit message]
  scripts/release.sh [--yes] --publish-current

Options:
  --allow-dirty     Allow releasing with uncommitted tracked changes.
                    Untracked files are never auto-committed.
  --yes, -y         Answer yes to confirmation prompts.
  --publish-current Publish the current package.json version without bumping.
                    Use after a version-bump PR has merged to a protected branch.

Examples:
  scripts/release.sh patch
  scripts/release.sh patch "Fix persisted focus echo status output"
  scripts/release.sh --allow-dirty patch "WIP checkpoint"
  scripts/release.sh --publish-current
EOF
}

fail() {
  echo "❌ $1" >&2
  exit 1
}

confirm() {
  local prompt="$1"
  local reply=""

  if [[ "$YES" -eq 1 ]]; then
    echo "$prompt y (--yes)"
    return 0
  fi

  if ! read -r -p "$prompt" reply; then
    echo >&2
    fail "Confirmation required. Re-run interactively or pass --yes after reviewing the output."
  fi

  case "$reply" in
    y|Y|yes|YES) ;;
    *)
      echo "Release cancelled."
      exit 1
      ;;
  esac
}

check_npm_version_available() {
  local package_name="$1"
  local package_version="$2"
  local npm_view_output=""

  echo "==> Checking npm version availability"
  if npm_view_output="$(npm view "$package_name@$package_version" version 2>&1)"; then
    fail "$package_name@$package_version is already published on npm."
  fi
  if ! grep -Eq '(E404|404|not in this registry)' <<<"$npm_view_output"; then
    echo "❌ Could not verify npm version availability for $package_name@$package_version" >&2
    echo "$npm_view_output" >&2
    exit 1
  fi
  echo "npm: $package_name@$package_version is available"
}

restore_version_preview() {
  git checkout -- package.json >/dev/null 2>&1 || true
  if git ls-files --error-unmatch package-lock.json >/dev/null 2>&1; then
    git checkout -- package-lock.json >/dev/null 2>&1 || true
  fi
}

ensure_branch_synced_with_origin() {
  local branch="$1"
  local remote_ref="origin/$branch"

  echo "==> Checking local branch is synced with $remote_ref"
  git fetch origin "$branch" >/dev/null
  if ! git rev-parse --verify "$remote_ref" >/dev/null 2>&1; then
    fail "Remote branch $remote_ref does not exist."
  fi
  if [[ "$(git rev-parse HEAD)" != "$(git rev-parse "$remote_ref")" ]]; then
    fail "Local $branch is not synced with $remote_ref. Merge/pull the version bump first, then publish current."
  fi
}

ensure_branch_push_allowed() {
  local branch="$1"

  echo "==> Checking direct push permission for $branch"
  if git push --dry-run origin "$branch" >/dev/null 2>&1; then
    return 0
  fi

  echo "❌ Cannot push directly to $branch." >&2
  echo "   If this branch is protected, create and merge a version-bump PR, then run:" >&2
  echo "   npm run release:publish-current -- --yes" >&2
  exit 1
}

remote_tag_exists() {
  local tag="$1"
  git ls-remote --exit-code --tags origin "refs/tags/$tag" >/dev/null 2>&1
}

ensure_tag_points_at_head() {
  local tag="$1"
  local head_sha
  head_sha="$(git rev-parse HEAD)"

  if git rev-parse --verify "refs/tags/$tag" >/dev/null 2>&1; then
    if [[ "$(git rev-parse "$tag^{commit}")" == "$head_sha" ]]; then
      return 0
    fi

    if remote_tag_exists "$tag"; then
      fail "Tag $tag exists locally/remotely but does not point at HEAD."
    fi

    confirm "Local tag $tag exists from an earlier failed release and remote tag is absent. Move it to HEAD? [y/N] "
    echo "==> git tag -f $tag"
    git tag -f "$tag"
    return 0
  fi

  echo "==> git tag $tag"
  git tag "$tag"
}

ALLOW_DIRTY=0
YES=0
PUBLISH_CURRENT=0
BUMP_TYPE=""
COMMIT_MESSAGE=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-dirty) ALLOW_DIRTY=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --publish-current) PUBLISH_CURRENT=1; shift ;;
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

if [[ "$PUBLISH_CURRENT" -eq 1 && -n "$BUMP_TYPE" ]]; then
  usage >&2
  exit 1
fi
if [[ "$PUBLISH_CURRENT" -eq 0 && -z "$BUMP_TYPE" ]]; then
  usage >&2
  exit 1
fi

BRANCH="$(git branch --show-current)"
if [[ -z "$BRANCH" ]]; then
  fail "Could not determine the current git branch."
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  fail "Git remote 'origin' is not configured; cannot push release commit/tag."
fi

PACKAGE_NAME="$(node -p "require('./package.json').name")"
CURRENT_VERSION="$(node -p "require('./package.json').version")"

GIT_STATUS="$(git status --short)"
HAS_MODIFIED_UNSTAGED="$(git diff --name-only | wc -l | tr -d ' ')"
HAS_MODIFIED_STAGED="$(git diff --cached --name-only | wc -l | tr -d ' ')"
HAS_MODIFIED_TRACKED=$((HAS_MODIFIED_UNSTAGED + HAS_MODIFIED_STAGED))
HAS_UNTRACKED="$(git ls-files --others --exclude-standard | wc -l | tr -d ' ')"

if [[ "$PUBLISH_CURRENT" -eq 1 ]]; then
  if [[ -n "$GIT_STATUS" ]]; then
    echo "$GIT_STATUS"
    fail "Working tree is not clean. Publish-current requires the merged release commit only."
  fi

  echo "==> Running release checks"
  "$ROOT_DIR/scripts/release-check.sh"

  echo
  echo "Package: $PACKAGE_NAME"
  echo "Current version: $CURRENT_VERSION"
  echo

  check_npm_version_available "$PACKAGE_NAME" "$CURRENT_VERSION"
  ensure_branch_synced_with_origin "$BRANCH"

  confirm "Continue with publishing $PACKAGE_NAME@$CURRENT_VERSION? [y/N] "

  echo
  echo "==> npm publish --dry-run --access public"
  npm publish --dry-run --access public

  NEW_TAG="v$CURRENT_VERSION"
  ensure_tag_points_at_head "$NEW_TAG"

  echo "==> git push origin $NEW_TAG"
  git push origin "$NEW_TAG"

  echo "==> npm publish --access public"
  npm publish --access public

  echo
  echo "✅ Released $PACKAGE_NAME@$CURRENT_VERSION on branch $BRANCH"
  exit 0
fi

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
    if ! read -r -p "Commit message for tracked changes: " COMMIT_MESSAGE; then
      echo >&2
      fail "A commit message is required when there are uncommitted changes."
    fi
  fi

  if [[ -z "$COMMIT_MESSAGE" ]]; then
    fail "A commit message is required when there are uncommitted changes."
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

  confirm "Continue with commit? [y/N] "

  echo "==> git add -u"
  git add -u

  echo "==> git commit -m \"$COMMIT_MESSAGE\""
  git commit -m "$COMMIT_MESSAGE"
fi

echo
PREVIEW_VERSION="$(npm version --no-git-tag-version "$BUMP_TYPE" | tr -d 'v')"
restore_version_preview

echo "Package: $PACKAGE_NAME"
echo "Current version: $CURRENT_VERSION"
echo "Next version:    $PREVIEW_VERSION"
echo

check_npm_version_available "$PACKAGE_NAME" "$PREVIEW_VERSION"

confirm "Continue with release? [y/N] "

echo

echo "==> npm version $BUMP_TYPE"
npm version "$BUMP_TYPE"
NEW_VERSION="$(node -p "require('./package.json').version")"
NEW_TAG="v$NEW_VERSION"

ensure_branch_push_allowed "$BRANCH"

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
