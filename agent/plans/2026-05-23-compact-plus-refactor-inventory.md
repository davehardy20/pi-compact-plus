# Compact+ context architecture refactor inventory

Created: 2026-05-23
Seeds issue: pi-compact-plus-6281
Plan: pl-a6bb revision 2, step 3

## Scope of this inventory

This inventory records the current Compact+ module responsibilities and the
behavior baseline that must remain stable before any structural source moves.
This step is characterization-only: it may add tests, fixtures, and planning
notes, but it must not move production code or intentionally change runtime
behavior.

## Current behavior baseline

The refactor must preserve these externally visible behaviors:

- Package identity and manifest stay available through `package.json` and the Pi
  extension entrypoint.
- `/compact-plus`, `/compact-plus hard`, `/compact-plus status`,
  `/compact-plus-status`, and `/checkpoint` remain registered with the same
  meanings.
- Tiered compaction thresholds, cooldown/regrowth guards, same-turn guard,
  model-change state reset, and manual/native/custom compaction flow remain
  equivalent.
- Compaction telemetry restores and persists without wiping restored state on
  first model selection.
- Focus echoes remain generated, non-authoritative synthetic user-context from
  the newest valid Compact+ compaction summary only. Current Pi custom messages
  also serialize to provider user messages, so there is no provider-safe
  lower-authority memory role to switch to yet.
- Focus echo detection rejects fenced/examples/spoofs and deduplicates existing
  `<focus-echo>` blocks.
- Focus echo normalization keeps the current readable/actionable behavior,
  including active-file path preference and prompt-injection neutralization.
- Tool-output pruning remains experimental, default-off, agent-message-only,
  stub-only for v1, protected-exclusion-aware, bounded, current-branch-only,
  atomic on flush/index failures, historical-data-framed, and recoverable only
  through the guarded query tool when enabled.
- Context composition keeps tool-output pruning before focus echo injection.
- Release packaging continues to exclude accidental local artifacts.

## Existing tests covering the baseline

- `test/index.test.ts`
  - package identity, command registration, lifecycle registration, status
    output, compaction fallback paths, telemetry persistence, model-scoped
    state, focus echo positioning, focus echo normalization regressions,
    adversarial focus echo hardening, pruning/context integration, pruning
    lifecycle boundaries, and pruning command integration.
- `test/tool-output-pruning/*.test.ts`
  - pruning settings, effective enablement, capture, lifecycle flush behavior,
    index reconciliation, current-branch stubbing, query bounds and recovery,
    state, summarizer parsing/error handling, commands, and short refs.
- `test/lifecycle.test.ts`, `test/persist.test.ts`, and `test/release.test.ts`
  - compaction lifecycle helpers, telemetry persistence diagnostics, and release
    script/package sanity checks.
- `test/focus-echo-goldens.test.ts`
  - newly added exact focus echo characterization for curated live-status and
    adversarial-memory fixtures plus newest-summary detection, fenced-summary
    rejection, recency insertion, and duplicate echo suppression.

## New focus echo golden fixtures

- `test/fixtures/focus-echo-goldens.ts`
  - `SOURCE_OF_TRUTH_STATUS_SUMMARY` captures the current live-status-style
    source-of-truth normalization target.
  - `ADVERSARIAL_SUMMARY` captures the current generated-memory quoting and
    delimiter-stripping behavior for prompt-injection-like content.

These goldens intentionally assert current behavior, including imperfect but
readable truncation. Later normalization changes must update or add fixtures with
a clear rationale rather than silently drifting output shape.

## Current module responsibilities

### `src/index.ts`

Current composition root and high-churn entrypoint. It owns package metadata,
command registration, lifecycle event wiring, state initialization, status
assembly, telemetry persistence coordination, compaction orchestration glue,
tool-output pruning lifecycle hooks, focus echo context composition, and test
exports.

### `src/reorder.ts`

Focus echo engine. It owns Compact+ summary detection, fenced-block stripping,
focus echo parsing, active-file extraction, blocker/decision/dependency/next-step
normalization, adversarial sanitization, generated-memory rendering, synthetic
message creation, recency insertion, and duplicate echo suppression.

### `src/settings.ts` and `src/types.ts`

Settings and threshold resolution. These files define Compact+ settings shapes,
defaults, env/settings-file precedence, threshold constants, tool-output pruning
settings, compaction telemetry types, and public constants.

### `src/policy.ts`

Compaction policy/status helpers. It owns usage bands, mode selection,
checkpoint/status snapshot formatting, model key construction, and status lines.

### `src/lifecycle.ts`, `src/compact.ts`, `src/prompts.ts`, `src/focus.ts`, `src/extract.ts`

Compaction support modules. They own compaction preparation/execution helpers,
custom summarization, prompt construction, current-focus extraction,
classification, snapshot extraction, and text extraction.

### `src/tool-output-pruning/*`

Experimental pruning subsystem. Current responsibilities are already separated
by capture, lifecycle flush, index reconciliation, pruning/stubbing, query tool,
settings policy, state, summarization, short refs, command helpers, and shared
types. The remaining refactor pressure is coordinator-level orchestration and
metadata reconstruction design rather than basic file decomposition.

### `scripts/*` and `test/release.test.ts`

Release and verification scripts. These protect build/test/typecheck/release
sanity and package contents.

## Intended future destinations

- Keep `src/index.ts` as a small composition root after supporting modules exist.
- Move low-risk command/status registration glue into extension modules after
  characterization is stable.
- Extract focus echo into a module family for detection, parsing, model types,
  rendering, sanitization, and named normalization rules.
- Add shared Pi message/type guard utilities before broad replacement of casts or
  repeated shape checks.
- Introduce a `CompactionCoordinator` for trigger decisions, session lifecycle,
  telemetry side effects, and fallback handling.
- Decide branch-safe pruning metadata reconstruction before introducing a
  `ToolOutputPruningCoordinator` that owns pruning lifecycle orchestration.
- Keep summarizer robustness and fixture/test-export cleanup as later slices.

## Non-goals for step 3

- No production source moves.
- No intended behavior changes.
- No new runtime settings or public commands.
- No changes to tool-output pruning safety scope.
- No broad migration of the full live-status regression corpus out of
  `test/index.test.ts`; curated goldens are sufficient for this step.

## Safety invariants for future slices

- Preserve exact-output-sensitive tool exclusions unless explicitly and safely
  changed with tests.
- Preserve tool-call/tool-result protocol structure in context transforms.
- Treat generated focus echoes and recovered pruned outputs as historical data,
  never as new instructions. Revisit the focus-echo injection strategy when Pi
  exposes a provider-preserved context/memory role below user authority.
- Keep query recovery bounded and inactive when pruning is not effectively
  enabled.
- Run targeted tests plus typecheck after each structural slice, then full
  validation before final Oracle review.
