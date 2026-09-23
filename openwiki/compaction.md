# Compaction Policy

> Threshold resolution, band computation, auto-compaction guard cascade, compatibility execution paths, summary generation, and validation.

## Threshold modes

Three threshold modes (`CompactPlusThresholdMode` in `src/settings.ts`):

| Mode | Behavior | Dispatch function |
|---|---|---|
| `percent` | Trigger by percentage of context window only | `getModeFromUsage(percent)` |
| `tokens` | Trigger by absolute token count only | `getModeFromTokenUsage(tokens)` |
| `effective_cap` | Trigger by whichever band reaches a more severe mode first | `highestSeverityMode(percentMode, tokenMode)` |

**Default:** `effective_cap`. This prevents very large context models (e.g., 1M tokens) from waiting until 70% (~700k tokens) to standard-compact; at 200k tokens, the token threshold fires standard compaction even though percent is only 20%.

**Source:** `src/policy.ts:getModeFromEffectiveUsage()` — the single dispatch function used by `maybeAutoCompact`.

## Band computation

Each metric (percent or tokens) maps to one of four bands:

| Band | Percent default | Token default | Compaction action |
|---|---|---|---|
| Normal | < 65% | < 185,000 | None |
| Checkpoint candidate | 65–69% | 185,000–199,999 | Eligible for `/checkpoint` (no auto-compact) |
| Standard | 70–89% | 200,000–259,999 | Auto standard compaction |
| Hard | ≥ 90% | ≥ 260,000 | Auto hard compaction (aggressive pruning) |

**Checkpoint candidates never trigger auto-compaction.** `maybeAutoCompact` returns early if mode is `null` or `"checkpoint"`.

**Severity ordering:** `null < checkpoint < standard < hard` (enforced by `modeSeverity()` in `policy.ts`).

## Auto-compaction guard cascade

`CompactionCoordinator.maybeAutoCompact()` (`src/compaction-coordinator.ts`) runs these guards in order. **Any guard that fails causes an early return — no compaction occurs:**

```
1. disableAutoCompaction                    → return (kill switch; manual compaction still allowed)
2. isEphemeralHeadlessChild                 → return (headless json/print/rpc mode AND no session file)
3. usage exists AND model exists            → else return
4. at least one metric available            → if percent===null && tokens===null, return
5. getModeFromEffectiveUsage()              → mode=null or "checkpoint" → return
6. isOnCooldown(cooldownMs)                 → return (default 120000ms = 2min)
7. isRegrowthBelowThreshold(tokens, 1000)   → return (only when tokens available)
8. isCompacting                             → return (prevent concurrent compaction)
9. toolOutputPruning.isFlushing             → return (prevent race with pruning flush)
10. isSameTurn(turnIndex)                   → return (prevent double-trigger in same turn)
```

If all guards pass, state is set (`selectedMode`, `isCompacting=true`, `lastCompactTime=now`, `lastTriggerAuto=true`) and `executeCompaction(mode, focus, ...)` is called.

**Change-entrypoint:** To add a new guard, add it to this cascade in `maybeAutoCompact`. Order matters — earlier guards short-circuit.

**Common failure mode:** If auto-compaction never triggers, check: (0) Is `disableAutoCompaction` set (env `COMPACT_PLUS_DISABLE_AUTO_COMPACTION` or settings file)? Is this an ephemeral headless child (json/print/rpc mode with no session file)? (1) is `getEffectiveUsage` returning valid data? (2) Is cooldown too long? (3) Is regrowth guard blocking because `lastCompactTokens` is close to current tokens? (4) Is pruning flush in progress?

## Usage resolution (`src/usage.ts`)

`getEffectiveUsage(ctx)` returns `EffectiveUsage | null`:

1. **Native** (`source: "native"`): If `ctx.getContextUsage()` returns a value, use it directly (percent + tokens).
2. **Estimated** (`source: "estimated"`): If native is unavailable, estimate tokens by summing `estimateTokens(msg)` across all branch messages. Percent = estimated / contextWindow × 100.
3. **Null**: If no model or `contextWindow <= 0`, returns null.

**Invariant:** After compaction, Pi intentionally reports unknown usage until the next assistant response. The estimator does NOT run in that case — status shows "unknown" instead. See `src/commands.ts` status handler.

## Manual compaction flow

`CompactionCoordinator.handleManualCommand(mode, ctx)`:

1. Guard: if `isCompacting`, notify warning and return.
2. Set `lastTriggerAuto = false`.
3. Extract current focus from the branch: `extractCurrentFocusFromBranch(cmdBranchView)`.
4. Notify user.
5. Call `executeCompaction(mode, focus, ...)`.

**No cooldown or regrowth guards for manual compaction.** Only the `isCompacting` guard applies.

## Compaction lifecycle (`src/lifecycle.ts`)

`executeCompaction()` is the unified entry for both manual and auto triggers:

1. Set `state.selectedMode = mode`, `state.isCompacting = true`.
2. Call `ctx.compact({ customInstructions, onComplete, onError })`.
3. **`onComplete`**: Reset `isCompacting`, `selectedMode`, `lastTriggerAuto`; set `lastCompactTime` from the compaction telemetry timestamp (fallback: now); reset `echoInjected`; resolve the regrowth baseline `lastCompactTokens`; persist telemetry; optionally send continuation prompt (`"Continue with the current task."`).

   Baseline resolution — first valid positive safe integer wins, else 0: (a) native `ctx.getContextUsage().tokens` (Pi may report unknown usage just after compaction); (b) `result.estimatedTokensAfter` from the compaction result; (c) `0`. A stale/invalid native reading never retains a pre-compaction baseline from a previous run. `0` disables the regrowth guard (`isRegrowthBelowThreshold` requires `lastCompactTokens > 0`); the cooldown guard still applies.
4. **`onError`**: Same cleanup but `lastCompactTokens = 0`; call `clearPendingCompaction()`; notify error.

**Auto-compaction sends a continuation prompt** (`sendContinuation: true`) so Pi resumes the task automatically after compaction. Manual compaction does not.

## `session_before_compact` → custom summary generation

`CompactionCoordinator.onSessionBeforeCompact(event, ctx)` (`src/compaction-coordinator.ts`):

1. Read `state.selectedMode` — if null, return `undefined` (let Pi handle natively).
2. Extract focus from `event.preparation.messagesToSummarize` (plus turn prefix if split turn).
3. Resolve compatibility: `resolveCompactionRuntimeCompatibility({ event })`.
4. Build telemetry base.
5. **If execution path is `native-fallback`**: Set `pendingCompaction` with fallback reason, persist, notify warning, return `undefined` (Pi does native compaction).
6. **Otherwise**: Call `runCustomCompaction(preparation, mode, ctx, compatibility, signal)`.
   - **Success**: Return `{ compaction: { ...result, details: { mode, triggerReason, ... } } }`.
   - **Failure**: Fall back to native, set `lastFallbackReason`, notify warning.

## Compatibility resolution (`src/compatibility.ts`)

`resolveCompactionRuntimeCompatibility()` detects Pi runtime capabilities by inspecting `compact.length` (the Pi helper's arity):

| Helper arity | Supports | Thinking level |
|---|---|---|
| ≥ 7 | `thinkingLevel` parameter | `"minimal"` (Compact+ forces cheap summaries) |
| ≥ 8 | `streamFn` parameter | Uses session's `streamFn` if available |

**Execution paths:**
1. **Custom with session streamFn**: If `event.streamFn` is a function → use it directly. Reason: null.
2. **Custom with streamSimple shim**: If no session streamFn but helper supports it (arity ≥ 8) → use `PUBLIC_STREAM_SIMPLE_FN` which dynamically imports `@earendil-works/pi-ai/compat`'s `streamSimple`. Reason: `STREAM_SIMPLE_SHIM_REASON`.
3. **Native fallback**: If neither streamFn nor streamSimple available → reason: `NATIVE_FALLBACK_REASON`, return undefined from `onSessionBeforeCompact`.

**Invariant:** `COMPACT_PLUS_COMPACTION_THINKING_LEVEL = "minimal"` — Compact+ summaries always run at minimal thinking regardless of the session's reasoning level, to keep compaction fast and cheap.

**Change-entrypoint:** If Pi changes the `compact()` helper signature, update the arity checks in `resolveCompactionRuntimeCompatibility`. The cached `streamSimple` import avoids repeated dynamic imports.

## Summary generation (`src/compact.ts`, `src/prompts.ts`)

### Summary instruction structure

`buildSummaryInstructions(mode, focus, options?)` in `src/prompts.ts` produces the prompt sent to the LLM during compaction. It includes:

1. **Current focus block** — XML-delimited `<current-focus>` with objective, blockers, decisions, dependency chain, active files. All values are escaped via `escapePromptData()` to prevent XML breakout.
2. **Structured schema** — 13 required section headings (see `quickstart.md`).
3. **Hard-mode constraints** — For `mode === "hard"`: short bullets, fewer historical details, only critical failed attempts, one next step.
4. **Direction-change detection** — When `options.previousSummary` is provided, detailed merging rules for each section (objective always from current conversation; decisions accumulate; failed attempts accumulate; open problems carry forward unless resolved).

### Summary normalization (`src/compact.ts`)

After the LLM produces a summary, `normalizeStructuredSummary()` enforces size limits:

| Constant | Value | Purpose |
|---|---|---|
| `MAX_VALID_SUMMARY_TOKENS` | 4000 | Reject if above (estimated as chars/4) |
| `TARGET_NORMALIZED_SUMMARY_TOKENS` | 3200 | Target after normalization |
| `MAX_PREVIOUS_SUMMARY_TOKENS` | 1600 | Max for carried-forward previous summary |
| `MAX_SUMMARY_LINE_CHARS` | 240 | Per-line truncation |

**Section body line limits** (`SECTION_BODY_LINE_LIMITS`): Each of the 13 sections has a max body line count (4–14). When the summary exceeds token limits, the normalizer progressively reduces body line counts via multipliers `[1, 0.75, 0.5, 0.35]` until it fits.

## Content classification (`src/classify.ts`)

`classifyMessages(messages, mode)` categorizes messages for hard-mode pruning:

| Category | Criteria | Pruning |
|---|---|---|
| **Critical** | User messages, bash execution, tool errors, assistant with tool calls, decisions/conclusions | Never pruned |
| **Contextual** | Long tool results (>1500 chars), high-density tool results, assistant with errors/failures | Pruned in hard mode |
| **Ephemeral** | Short low-density tool results, short low-density assistant acknowledgments | Pruned in standard+hard |

**Content density score** (`contentDensity()`): +3 for code blocks, up to +5 for file paths, +1 for URLs, up to +3 for list items, +1 for structured data.

## Telemetry

`CompactionTelemetry` records: mode, triggerSource (`message_end`/`turn_end`/`command`), triggerReason, timestamp, focusTags (active file basenames), previousSummaryPresent, splitTurn, usageSource, fallbackReason, classifiedCounts, usagePercentAtTrigger, usageTokensAtTrigger, executionPath (`custom`/`native-fallback`), fromExtension, thinkingLevel, compatibilityReason.

See [settings-and-state.md](settings-and-state.md) for persistence details.

## Test commands

```bash
npx vitest run test/index.test.ts              # 139 tests: policy, settings, compaction, focus-echo, usage
npx vitest run test/classify-extract.test.ts    # Classification
npx vitest run test/lifecycle.test.ts           # executeCompaction lifecycle
npx vitest run test/snapshot-evidence.test.ts   # Session evidence extraction
npx vitest run test/session-branch-view.test.ts # Branch view projection
```

## Safe-edit guidance

- **Changing thresholds**: Update defaults in `src/settings.ts:DEFAULT_COMPACT_PLUS_SETTINGS`. Invalid/overlapping values fall back to the default profile automatically.
- **Changing the guard cascade**: Edit `maybeAutoCompact` in `src/compaction-coordinator.ts`. Document the guard order — it is intentional.
- **Changing summary schema**: Update both `SECTION_BODY_LINE_LIMITS` in `compact.ts` and the schema array in `buildSummaryInstructions` in `prompts.ts`. Also update `SUMMARY_SIGNATURE_HEADINGS` in `focus-echo/detection.ts` (at minimum the 4 required headings).
- **Changing thinking level**: Edit `COMPACT_PLUS_COMPACTION_THINKING_LEVEL` in `compatibility.ts`.
- **Adding a new compaction mode**: Add to `CompactionMode` type, update `modeSeverity()`, `getModeFromUsage`/`getModeFromTokenUsage`, and the guard cascade.
