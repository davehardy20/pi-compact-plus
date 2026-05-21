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

echo "✅ Verification complete"
