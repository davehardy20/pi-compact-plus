# Testing & Release

> Test structure, commands, CI workflow, release flow, package checks, and common failure modes.

## Test framework

- **Vitest** (`vitest run` for CI, `vitest` for watch mode).
- **Environment:** Node (`vitest.config.ts`).
- **Mock strategy:** most suites mock Pi core packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`) via `vi.mock`. The `@earendil-works/pi-ai` mock exposes `completeSimple` and `streamSimple` for summarizer/compatibility tests. Two suites run against the real Pi SDK, and `test/provider-boundary-087.test.ts` uses `vi.mock` only as a forwarding bridge to the isolated real Pi 0.87.1 helper — see "Real-SDK integration suites" below.

## Test commands

```bash
npm test                                    # vitest run (all tests)
npm run test:watch                          # vitest (watch mode)
npm run test:coverage                       # v8 JSON coverage → coverage/
npx vitest run test/index.test.ts           # Main integration suite (~139 tests)
npx vitest run test/tool-output-pruning/    # All pruning tests
npx vitest run test/focus-echo              # All focus-echo tests (by pattern)
```

## Test file map

| File | Tests | Coverage area |
|---|---|---|
| `test/index.test.ts` | ~139 | Policy, settings, compaction, focus-echo, usage, public API surface |
| `test/persist.test.ts` | — | Telemetry persistence, trust-root/symlink/ancestor checks, schema versioning |
| `test/sdk-runtime-regression.test.ts` | — | Real Pi 0.84.4 SDK: cut point, routed stream summary, projection, usage, echo, continuation (see below) |
| `test/sdk-session-reload.test.ts` | — | Real Pi JSONL session reload: A→B→A branch reconciliation, metadata-only durability, recovery (see below) |
| `test/provider-boundary-087.test.ts` | — | Real Pi 0.87.1 runtime/registry/session preparation via `PI_COMPACT_PLUS_TEST_PI_087_ROOT`; skips locally when unset |
| `test/lifecycle.test.ts` | — | `executeCompaction` lifecycle (onComplete/onError) |
| `test/classify-extract.test.ts` | — | Content classification, density scoring |
| `test/snapshot-evidence.test.ts` | — | Session evidence extraction (objective, blockers, files) |
| `test/session-branch-view.test.ts` | — | Branch view projection, entry filtering |
| `test/pi-messages.test.ts` | — | Message role/content-block helpers |
| `test/package-metadata.test.ts` | — | Package metadata resolution |
| `test/extension-status.test.ts` | — | `/compact-plus-status` command output |
| `test/release.test.ts` | — | Release script validation (temp git repos) |
| `test/focus-echo-goldens.test.ts` | 10 | End-to-end parse/render goldens |
| `test/focus-echo-normalizer-characterization.test.ts` | 2 | Field-level normalization, caps/dedupe |
| `test/focus-echo-normalization-rules.test.ts` | 2 | Rule taxonomy, per-field helpers |
| `test/focus-echo-draft.test.ts` | — | Draft extraction from summary sections |
| `test/tool-output-pruning/*.test.ts` | 15 files | Full pruning subsystem |

### Real-SDK integration suites

Three suites exercise the **real** Pi SDK:

- `test/sdk-runtime-regression.test.ts` — Pi **0.84.4** (versions asserted for all three packages), resolved from the lockfile via `import.meta.resolve`, no `vi.mock`. Builds a real in-memory `SessionManager` branch from synthetically appended tool messages, drives `prepareCompaction` (asserting the cut point keeps a redirect user message), routes a local stream into Pi's real compaction helper, then exercises Pi-owned `appendCompaction` + context projection, post-compaction usage (`getEffectiveUsage` must not resurrect stale estimates), focus echo, and a manually appended continuation turn. The model response stream and extension event delivery are simulated — no tool or continuation prompt is executed, and no network access occurs.
- `test/sdk-session-reload.test.ts` — Pi **0.84.4**, resolved from the lockfile, no `vi.mock`. Creates a real on-disk JSONL session via `SessionManager.create`, persists a tool-prune summary custom entry, reopens with `SessionManager.open`, and verifies metadata-only reconstruction (`fallbackSnippets` null; the original output is absent from the durable pruning metadata entry while remaining in Pi's JSONL tool-result message), recovery-query content bounds, and A→B→A branch reconciliation with short-ref continuity.
- `test/provider-boundary-087.test.ts` — Pi **0.87.1** from an isolated prefix (CI) or `PI_COMPACT_PLUS_TEST_PI_087_ROOT` (local opt-in). Its `vi.mock` of `@earendil-works/pi-coding-agent` is solely a forwarding bridge to the isolated real 0.87.1 compact helper (this Vitest process resolves the locked 0.84 package); the helper, session manager, and model registry are real. Uses a registry-backed local stream; never a remote provider.

The README's **"Runtime regression matrix (F1–F11)"** section is the canonical map from each regression class (F1 unsafe compaction, F2 summary provenance, … F11 ancestor-symlink telemetry) to the test files covering it.

### Test fixtures

| File | Purpose |
|---|---|
| `test/fixtures/extension.ts` | `createMockCtx` and `createMockPi` helpers |
| `test/fixtures/focus-echo-goldens.ts` | Golden input/expected output pairs for focus-echo |
| `test/fixtures/tool-output-pruning.ts` | Mock tool results and branch entries for pruning tests |

### Test conventions

- `index.test.ts` uses `beforeEach(() => __test__.resetState())` to reset the singleton `CompactionState` between tests.
- Settings path is overridden to `/tmp/compact-plus-test-missing-settings.json` in `index.test.ts` to avoid reading real user settings.
- The `__test__` export in `src/index.ts` provides getters for internal state inspection.

## Build

```bash
npm run build          # tsc -p tsconfig.build.json → dist/
npm run typecheck      # tsc --noEmit (no output)
```

**TypeScript config:**
- `tsconfig.json`: target ES2022, module NodeNext, strict mode, includes `src/` and `test/`.
- `tsconfig.build.json`: builds to `dist/`, excludes tests.

**Biome:** `biome.json` configured for formatting/linting. Run manually with `npx biome check src test scripts`. Not yet a required CI gate (see `cheatsheet.md`).

## CI workflow (`.github/workflows/pr-checks-node.yml`)

**Trigger:** Pull requests and manual dispatch.

**Steps:**
1. Checkout (Node 22, npm cache).
2. Detect repository capabilities (package.json, lockfile, scripts).
3. Install: `npm ci --no-audit` — installs exactly the committed `package-lock.json`; `npm ci` fails closed on manifest/lockfile drift.
4. Lockfile consistency check: `npm ci --dry-run --package-lock-only` — fails if lockfile is out of sync.
5. Typecheck: `npm run typecheck` (if `typecheck` script or `tsconfig.json` exists).
6. Test: `npm test` (if `test` script or vitest config exists).
7. Pi 0.87 provider boundary (if tests exist): installs an isolated `@earendil-works/pi-coding-agent@0.87.1` into `$RUNNER_TEMP/pi-087` (`npm install --prefix`, `--ignore-scripts`, no audit/fund) and runs `npx --no-install vitest run test/provider-boundary-087.test.ts` with `PI_COMPACT_PLUS_TEST_PI_087_ROOT` pointing at it. The test asserts the exact 0.87.1 versions of the coding-agent package and its nested `pi-agent-core`/`pi-ai` packages; a configured-but-incomplete runtime **fails** rather than skipping. Locally the test skips when `PI_COMPACT_PLUS_TEST_PI_087_ROOT` is unset — there is no host-global fallback path.
8. Build: `npm run build` (if `build` script exists).
9. Audit: `npm audit --audit-level=high` (if lockfile exists; `continue-on-error`).
10. Secret scan: `gitleaks/gitleaks-action@v2` (`continue-on-error`).

**Required status check name:** `Typecheck and test` (or `CI / Typecheck and test`).

**Concurrency:** Cancels in-progress runs for the same PR/branch.

## Verification (`scripts/verify.sh`)

Full local verification before opening a PR:

```bash
npm run verify
```

Runs:
1. `npm run typecheck`
2. `npm test`
3. `npm run build`
4. `node scripts/live-custom-path-check.mjs`
5. `node scripts/check-package-contents.js`

## Package content check (`scripts/check-package-contents.js`)

Fast sanity check that `npm pack` would include the right files (only `src/`, `README.md`, `LICENSE`, `package.json` per `package.json:files`).

## Release flow

### Pre-release checks (`scripts/release-check.sh`)

```bash
npm run release:check                        # Strict: requires clean working tree
npm run release:check -- --allow-dirty       # Allow tracked uncommitted changes
npm run release:check -- --dry-run           # Don't make changes, just validate
```

Checks:
1. Git branch is determined.
2. Working tree is clean (or `--allow-dirty` for tracked changes).
3. **Untracked files always fail** — they can be accidentally packed by npm.
4. Runs `scripts/verify.sh`.
5. `npm whoami` — must be logged in.
6. `npm pack --dry-run` — shows what would be published.

### Release (`scripts/release.sh`)

```bash
npm run release:patch       # 0.2.0 → 0.2.1
npm run release:minor       # 0.2.0 → 0.3.0
npm run release:major       # 0.2.0 → 1.0.0
npm run release:publish-current  # Publish current version without bump
```

The script:
1. Runs `release-check.sh`.
2. Bumps version in `package.json` and `package-lock.json`.
3. Commits version bump.
4. Tags release.
5. Publishes to npm.

`--allow-dirty` stages tracked changes with `git add -u`; untracked files must be cleaned or ignored first.

### Post-install verification

After installing from a local checkout or package update, run `/compact-plus-status` to confirm:
- Package name and version
- Loaded source path
- Package root
- Current compaction state
- Tool-output pruning one-line status

## Common failure modes

| Failure | Cause | Fix |
|---|---|---|
| Lockfile out of sync | `package.json` changed without `npm install` | Run `npm install` and commit updated `package-lock.json` |
| Commands appear twice | Old local extension + new package both loaded | Remove old local auto-discovered extension; check `/compact-plus-status` for loaded path |
| `streamSimple` unavailable | Peer dep `@earendil-works/pi-ai` missing or wrong version | Install correct peer dep version |
| Release fails on untracked files | Working tree has untracked files | Clean or `.gitignore` untracked files |
| Test flakiness in `release.test.ts` | Temp git repo operations under parallelism | Re-run; this is known intermittent, not an assertion failure |
| Biome check fails | Formatting/linting issues | Run `npx biome check --write src test scripts` |
| Custom summary fails, native fallback | Runtime missing streamFn and streamSimple | Check `compatibilityReason` in telemetry; ensure Pi runtime supports stream-aware compaction |

## Dev/release playbook (from README)

1. Keep local validation green: `npm run typecheck && npm test && npm run build`.
2. Run `/compact-plus-status` after installing from a local checkout or package update.
3. To pick up a newer published package commit: `pi update --extensions` or reinstall, then `/reload`. `/reload` alone does not fetch package updates.
4. Before release: `npm run package:check` then `npm run release:check`.
5. Use `scripts/release.sh <patch|minor|major>` only for an intentional release.

## Safe-edit guidance

- **Always run the full test suite** before opening a PR: `npm test`.
- **Run typecheck** even if tests pass: `npm run typecheck`.
- **Check lockfile sync** if you changed `package.json`: `npm install` and commit the lockfile.
- **Do not add `biome check` as a required CI gate** until existing repo-wide Biome findings are fixed (see `cheatsheet.md`).
- **Test fixtures are load-bearing.** Focus-echo goldens and characterization tests lock in pre-refactor behavior. Changing source that affects their output requires updating fixtures with documented rationale.
