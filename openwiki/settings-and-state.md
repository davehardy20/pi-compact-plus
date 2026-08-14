# Settings & State

> Settings resolution (env → settings.json → defaults), threshold validation fallbacks, telemetry persistence, and state management.

## Settings resolution (`src/settings.ts`)

### Precedence (highest to lowest)

1. **Environment variables** (`COMPACT_PLUS_*`)
2. **Settings file** (`~/.pi/agent/settings.json` or `COMPACT_PLUS_SETTINGS_PATH`)
3. **Frozen defaults** (`DEFAULT_COMPACT_PLUS_SETTINGS`)

**Invariant:** Environment variables always win. If an env var is set (even to an invalid value), the settings file value is ignored for that key.

### Entry point

`resolveCompactPlusSettings(env?, fileSettings?)` → `ResolvedCompactPlusSettings`

- Called at module-load time in `index.ts` for threshold settings (frozen after load).
- Called per-event by `ToolOutputPruningCoordinator` (via `getSettings: () => resolveCompactPlusSettings()`).
- Tool-output pruning settings are re-resolved when pruning commands and lifecycle events run, but `/reload` is still the safest way to apply settings edits consistently.

### Settings file location

`getSettingsPath(env)`:
- If `COMPACT_PLUS_SETTINGS_PATH` is set → resolve as absolute path.
- Otherwise → `~/.pi/agent/settings.json` (`getDefaultSettingsPath()`).

`loadCompactPlusSettingsFile(env)`:
- Reads and parses JSON from the settings path.
- Returns `{}` if file doesn't exist or is unparseable (fail-safe).

### Two settings file key formats

The settings file supports two key layouts:

**Nested `thresholds` object:**
```json
{
  "thresholdMode": "effective_cap",
  "thresholds": {
    "checkpoint": 65,
    "standard": 70,
    "hard": 90,
    "checkpointTokens": 185000,
    "standardTokens": 200000,
    "hardTokens": 260000
  }
}
```

**Top-level flat keys:**
```json
{
  "thresholdMode": "effective_cap",
  "checkpointThresholdPercent": 65,
  "standardThresholdPercent": 70,
  "hardThresholdPercent": 90,
  "checkpointThresholdTokens": 185000,
  "standardThresholdTokens": 200000,
  "hardThresholdTokens": 260000
}
```

Resolution uses `firstDefined()` to check multiple aliases: e.g., `checkpoint` → `checkpointCandidate` → `checkpointThresholdPercent` (see `resolveCompactPlusSettings` for exact alias chains).

## Default constants (`DEFAULT_COMPACT_PLUS_SETTINGS`)

| Setting | Default | Validation |
|---|---|---|
| `thresholdMode` | `effective_cap` | Enum: `percent`/`tokens`/`effective_cap` |
| `checkpointThresholdPercent` | 65 | `resolvePercentSetting()` — clamped 0–100 |
| `standardThresholdPercent` | 70 | Same |
| `hardThresholdPercent` | 90 | Same |
| `checkpointThresholdTokens` | 185,000 | `resolveTokenThresholdSetting()` — clamped 50,000–2,000,000 |
| `standardThresholdTokens` | 200,000 | Same |
| `hardThresholdTokens` | 260,000 | Same |
| `cooldownMs` | 120,000 | `resolvePositiveIntegerSetting()` |
| `disableAutoCompaction` | `false` | `resolveBoolSetting()` (env: `parseEnvBool()`) |
| `experimentalToolOutputPruning` | `false` | `parseEnvBool()` |
| `toolOutputPruningMode` | `off` | Enum: `off`/`agent-message` |
| `toolOutputSummaryStrategy` | `llm` | Enum: `llm` (only option for v1) |
| `toolOutputPruneStrategy` | `stub` | Enum: `stub`/`delete` (v1 uses `stub`) |
| `toolOutputPruneMinChars` | 3,000 | Clamped 100–50,000 |
| `toolOutputSummaryMaxChars` | 1,600 | Clamped 100–10,000 |
| `toolOutputQueryMaxChars` | 12,000 | Clamped 100–100,000 |
| `toolOutputSummarizerModel` | `default` | String or `"default"` |
| `toolOutputSummarizerThinking` | `low` | Enum: `default`/`off`/`minimal`/`low`/`medium`/`high`/`xhigh` |
| `toolOutputPruneExcludedTools` | `["read","read_hashed","hashline_edit","compact_plus_query_tool_output"]` | Comma-separated string from env |
| `toolOutputPruneIncludedTools` | `[]` | Comma-separated string from env |

## Threshold validation & fallback

**Percent thresholds:** If invalid, missing, or overlapping (e.g., standard < checkpoint), fall back to the entire default profile `65/70/90`.

**Token thresholds:** If invalid or overlapping, fall back to the entire default profile `185,000/200,000/260,000`. Token thresholds are clamped to `50,000`–`2,000,000`.

**Invariant:** Invalid settings never cause partial fallback — the entire percent profile or entire token profile falls back as a unit.

## Default-vs-runtime distinction

**Critical for agents:** `DEFAULT_*` exports (e.g., `DEFAULT_THRESHOLD_MODE`, `DEFAULT_STANDARD_THRESHOLD_PERCENT`) are the **frozen baseline** — they never read the environment or settings file. They exist only for compile-time constants and test baselines.

Runtime-resolved values **must** be obtained from `resolveCompactPlusSettings()`. The `types.ts` file re-exports some `DEFAULT_*` values as legacy names (e.g., `STANDARD_THRESHOLD_PERCENT`) for backward compatibility, but these are the frozen defaults, not runtime values.

**Naming convention:** Every frozen export is prefixed `DEFAULT_` to make the distinction obvious at the call site.

## Environment variable reference

| Variable | Maps to |
|---|---|
| `COMPACT_PLUS_THRESHOLD_MODE` | `thresholdMode` |
| `COMPACT_PLUS_CHECKPOINT_THRESHOLD` | `checkpointThresholdPercent` |
| `COMPACT_PLUS_STANDARD_THRESHOLD` | `standardThresholdPercent` |
| `COMPACT_PLUS_HARD_THRESHOLD` | `hardThresholdPercent` |
| `COMPACT_PLUS_CHECKPOINT_THRESHOLD_TOKENS` | `checkpointThresholdTokens` |
| `COMPACT_PLUS_STANDARD_THRESHOLD_TOKENS` | `standardThresholdTokens` |
| `COMPACT_PLUS_HARD_THRESHOLD_TOKENS` | `hardThresholdTokens` |
| `COMPACT_PLUS_COOLDOWN_MS` | `cooldownMs` |
| `COMPACT_PLUS_DISABLE_AUTO_COMPACTION` | `disableAutoCompaction` |
| `COMPACT_PLUS_SETTINGS_PATH` | Settings file path override |
| `COMPACT_PLUS_EXPERIMENTAL_TOOL_OUTPUT_PRUNING` | `experimentalToolOutputPruning` |
| `COMPACT_PLUS_TOOL_OUTPUT_PRUNING_MODE` | `toolOutputPruningMode` |
| `COMPACT_PLUS_TOOL_OUTPUT_SUMMARY_STRATEGY` | `toolOutputSummaryStrategy` |
| `COMPACT_PLUS_TOOL_OUTPUT_PRUNE_STRATEGY` | `toolOutputPruneStrategy` |
| `COMPACT_PLUS_TOOL_OUTPUT_PRUNE_MIN_CHARS` | `toolOutputPruneMinChars` |
| `COMPACT_PLUS_TOOL_OUTPUT_SUMMARY_MAX_CHARS` | `toolOutputSummaryMaxChars` |
| `COMPACT_PLUS_TOOL_OUTPUT_QUERY_MAX_CHARS` | `toolOutputQueryMaxChars` |
| `COMPACT_PLUS_TOOL_OUTPUT_SUMMARIZER_MODEL` | `toolOutputSummarizerModel` |
| `COMPACT_PLUS_TOOL_OUTPUT_SUMMARIZER_THINKING` | `toolOutputSummarizerThinking` |
| `COMPACT_PLUS_TOOL_OUTPUT_PRUNE_EXCLUDED_TOOLS` | `toolOutputPruneExcludedTools` |
| `COMPACT_PLUS_TOOL_OUTPUT_PRUNE_INCLUDED_TOOLS` | `toolOutputPruneIncludedTools` |

## State management

### `CompactionState` (`src/state.ts`)

Single mutable state container for all compaction and pruning state. See [architecture.md](architecture.md#state-lifecycle-srcstatets) for the full field list and reset triggers.

**Guard helpers:**
- `isOnCooldown(cooldownMs)`: `Date.now() - lastCompactTime < cooldownMs`
- `isRegrowthBelowThreshold(tokens, regrowthTokens)`: `lastCompactTokens > 0 && currentTokens - lastCompactTokens < regrowthTokens`
- `isSameTurn(turnIndex)`: `turnIndex === lastCompactTurnIndex`

### `ToolOutputPruningState` (`src/tool-output-pruning/state.ts`)

Sub-state for tool-output pruning. See [tool-output-pruning.md](tool-output-pruning.md#state-src-tool-output-pruningstatets).

## Telemetry persistence (`src/persist.ts`)

### File location

`~/.pi/agent/state/compact-plus-telemetry.json` (directory mode `0o700`, file mode `0o600`).

### Persisted fields (`PersistedTelemetry`)

| Field | Type |
|---|---|
| `lastCompaction` | `CompactionTelemetry \| null` |
| `lastFallbackReason` | `string \| null` |
| `lastInjectedEcho` | `string \| null` |
| `lastCompactTime` | `number` |
| `lastCompactTokens` | `number` |
| `lastModelKey` | `string \| null` |
| `version` | `number` (currently `3`) |

### Load (`loadTelemetryWithDiagnostics`)

On `session_start`:
1. Detect symlinks in the file path or parent directories (`detectSymlinkInPath`). If found → quarantine and report `symlink-detected`.
2. Read and parse JSON. If corrupt → quarantine and report `corrupt-json`.
3. Validate schema version. If unsupported → quarantine and report `unsupported-version`.
4. If invalid schema → report `invalid-schema`.
5. If permission error → report `permission-failed`.
6. If read error → report `read-failed`.

Returns `{ telemetry: PersistedTelemetry | null, issue: TelemetryPersistenceIssue | null }`.

### Save (`saveTelemetryWithDiagnostics`)

Called after every compaction, focus-echo injection, and model change:
1. Ensure directory exists (`mkdir -p`, mode `0o700`).
2. Write JSON atomically (write to temp + rename).
3. File mode `0o600`.
4. Report `write-failed` on error.

### Telemetry persistence issues

Issues are recorded in `state.telemetryPersistenceIssues` (capped at 5 most-recent). Each issue has: `operation` (load/save), `code`, `path`, `message`, `timestamp`, optional `quarantinePath`.

Issue codes: `corrupt-json`, `invalid-schema`, `permission-failed`, `read-failed`, `symlink-detected`, `unsupported-version`, `write-failed`.

## Session evidence extraction (`src/session-evidence.ts`)

This module extracts structured facts from session messages for focus extraction and snapshots.

### `extractCurrentFocus(messages)` → `CurrentFocus`

Scans the last `CURRENT_FOCUS_RECENT_WINDOW = 20` user/assistant messages:
- **Objective**: Most recent user message that isn't conversational filler.
- **Active files**: File paths from recent messages (capped `MAX_ACTIVE_FILES = 10`).
- **Blockers**: Extracted from tool errors and text patterns (capped `MAX_BLOCKERS = 5`).
- **Decisions**: From assistant messages with decision markers (capped `MAX_DECISIONS = 5`).
- **DependencyChain**: From structured heading sections (capped `MAX_DEPENDENCY_CHAIN = 5`).

### `extractSessionSnapshot(messages)` → `SessionSnapshot`

Extends `CurrentFocus` with: `completedWork`, `openProblems`, `currentErrors`, `constraints`, `failedAttempts`, `nextStep`. Uses wider windows (`SNAPSHOT_RECENT_WINDOW = 20`, `SNAPSHOT_FOCUS_RECENT_WINDOW = 30`) and per-list caps (`SNAPSHOT_MAX_ITEMS = 10`, `SNAPSHOT_MAX_LINE = 300`).

### `extractCurrentFocusFromBranch(branchView)`

Convenience wrapper that extracts focus from a `SessionBranchView`'s messages.

### Conversational filler filtering

`isConversationalFiller(text)` filters out short acknowledgments ("ok", "thanks", "done", "will do", etc.) so they don't become objectives.

## Branch view (`src/session-branch-view.ts`)

`SessionBranchView` is a read-only projection over Pi session branch entries. It provides:
- `messages()` — all message entries as `AgentMessage[]`.
- `messageEntries()` — typed message entries.
- `recentMessages(count)` / `recentMessageEntries(count)`.
- `entryIds()` — `Set<string>` of all entry IDs.
- `customEntries(customType, options)` — bounded scan for custom entries (default limit 50, max scan 500).

`createCurrentSessionBranchView(ctx)` creates a view from `ctx.sessionManager.getBranch()`.

## Test commands

```bash
npx vitest run test/persist.test.ts                    # Telemetry persistence + security
npx vitest run test/snapshot-evidence.test.ts           # Session evidence extraction
npx vitest run test/session-branch-view.test.ts         # Branch view projection
npx vitest run test/tool-output-pruning/settings.test.ts # Pruning settings resolution
```

## Safe-edit guidance

- **Adding a new setting**: Add to `CompactPlusSettingsFile`, `ResolvedCompactPlusSettings`, `DEFAULT_COMPACT_PLUS_SETTINGS`, and `resolveCompactPlusSettings()`. Add an env var mapping if needed. Add tests in `test/index.test.ts` and/or `test/tool-output-pruning/settings.test.ts`.
- **Changing defaults**: Update `DEFAULT_COMPACT_PLUS_SETTINGS`. The `DEFAULT_*` exports are derived from this object. Do not change individual `DEFAULT_*` exports independently.
- **Changing persistence format**: Bump `PERSIST_VERSION` in `persist.ts`. Add migration logic in the load path. Old versions will be quarantined as `unsupported-version`.
- **Adding a new telemetry field**: Add to `PersistedTelemetry`, update `save` and `load` functions, update `CompactionState` and `reset()`.
- **Do not read the settings file in hot paths.** Settings resolution reads the filesystem. The composition root caches threshold settings at load time.
