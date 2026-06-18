# Normalization-rules locality — branch & characterization baseline

- **Plan:** `pl-874d` — Localize focus-echo normalization rules and remove stale barrels
- **Root seed:** `pi-compact-plus-0c2c`
- **This step:** `pi-compact-plus-dd53` (setup / branch / characterization)
- **Feature branch:** `architecture/normalization-rules-locality` (created off `master`)

## Baseline commit

The feature branch was created from a clean `master` tree. The working tree is
unchanged at branch creation, so the baseline is the existing committed state on
`master`. All characterization work below is the locked-in pre-refactor behavior.

## Characterization baseline (verified green)

Full suite at branch creation:

- `npx vitest run` → 29 files, **529 tests passed**
- `npx tsc --noEmit` → exit 0
- `npx biome check ...` → clean

Characterization-relevant test files (the ones later steps must keep green):

| File | Tests | Purpose |
| --- | --- | --- |
| `test/focus-echo-goldens.test.ts` | 10 | End-to-end parse/render goldens incl. live status variants |
| `test/focus-echo-normalizer-characterization.test.ts` | 2 | Field-level cleanup + list caps/dedupe/truncation |
| `test/focus-echo-normalization-rules.test.ts` | 2 | Rule taxonomy privacy + per-field semantic helpers |
| `test/index.test.ts` | 139 | Public package surface incl. normalizer integration |

Total for those four files: **153 tests passed**.

## Behavior this baseline locks in

- `normalizeFocusEchoDraft` deep interface is a pure 6-field delegation; later
  slices must keep it byte-identical for all inputs **except** those referencing
  the deleted `src/reorder.ts` path (those change in step 4 / plan step index 3).
- Six `src/reorder.ts`-anchored normalization rules currently live in
  `src/focus-echo/normalization-rules.ts` (blocker-028, dependency-005,
  dependency-006, next-step-005, next-step-006, plus the two vitest/reconcile
  next-step rules). These are intentionally path-specific and will be pruned in
  the later "Prune stale src/reorder.ts-anchored rules" step, with golden
  fixture updates documented there.
- The characterization/goldens tests currently assert `src/reorder.ts`-bearing
  expected output (e.g. `buildPersistedFocusEcho()/parseFocusEcho() in
  src/reorder.ts`, `src/reorder.ts` in active-files). Those expectations are the
  **pre-prune** baseline; the prune step owns the fixture delta and rationale.

## Four stale backward-compat barrels (deleted in Slice 0)

- `src/reorder.ts` — focus-echo barrel; two live consumers to repoint:
  `compaction-coordinator.ts` (`buildPersistedFocusEcho`) and `events.ts`
  (`reorderForPositioning`), both to `./focus-echo/index.js`.
- `src/focus.ts` — `classifyMessages` + session-evidence re-exports.
- `src/extract.ts` — session-evidence extraction re-exports.
- `src/snapshot.ts` — session-evidence snapshot re-exports.

## Next steps (other child issues, not this one)

1. `pi-compact-plus-d886` — Slice 0: delete the four barrels, repoint imports.
2. `pi-compact-plus-4d52` — Slice 1: split `normalization-rules.ts` into
   `src/focus-echo/rules/` field modules.
3. Prune stale `src/reorder.ts`-anchored rules + update golden fixtures.
4. Full validation + version bump to `0.2.0`.
5. Open PR + record plan outcome (closeout owner).

## Validation pass + version bump (step 4, child `pi-compact-plus-a5e9`)

- `npx tsc --noEmit` → exit 0
- `npm run build` (`tsc -p tsconfig.build.json`) → exit 0
- `npx biome check src test scripts` → clean (90 files)
- `npx vitest run` → 29 files, **529 tests passed** (stable across 5+ runs;
  earlier intermittent failures were release-test temp-git-repo flakiness under
  parallelism, not assertion mismatches — the prune-step fixture deltas in
  `test/index.test.ts` and the goldens are already in place and green)
- `npm version minor --no-git-tag-version` → `0.1.9` → **`0.2.0`**
  (updated both `package.json` and `package-lock.json`; no commit/tag — that
  belongs to the closeout owner's PR-first flow)
- `release-check.sh --allow-dirty --dry-run` recognizes `@0.2.0`; remaining
  warning is the expected untracked-files state from the uncommitted
  dependency slices + this bump.

Open follow-up (closeout owner only): commit the barrel deletions, rules
split, prune-step fixture deltas, and this version bump on
`architecture/normalization-rules-locality`, push, open the PR, and record
the plan outcome. Do not report this child as partial for that — it is
out of this intermediate child's harness scope.
