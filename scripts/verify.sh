#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "==> npm run typecheck"
npm run typecheck

echo "==> npm test"
npm test

echo "==> npm run build"
npm run build

echo "==> node scripts/live-custom-path-check.mjs"
node scripts/live-custom-path-check.mjs

echo "==> node scripts/check-package-contents.js"
node scripts/check-package-contents.js

echo "✅ Verification complete"
