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
2. Extract focus from the active session projection (`currentProjectedMessages(ctx)` in `src/session-projection.ts`) — Pi omits retained messages from `preparation.messagesToSummarize`, and an empty projection is authoritative.
3. Abort check (`event.signal`/`ctx.signal`) → `cancelAbortedCompaction()`. Intent-evidence overflow → cancel with warning.
4. Resolve compatibility: `resolveCompactionRuntimeCompatibility({ event, modelRegistry: ctx.modelRegistry })` (`src/compaction-coordinator.ts`).
5. Build telemetry base.
6. **If execution path is `native-fallback`**: Set `pendingCompaction` with fallback reason, persist, notify warning, return `undefined` (Pi does native compaction).
7. **Otherwise**: Call `runCustomCompaction(preparation, mode, ctx, compatibility, event.signal, { focus, customInstructions })`; a post-run abort check cancels before applying any result.
   - **Success**: Return `{ compaction: { ...result, details: { mode, triggerReason, ... } } }`.
   - **Failure**: Fall back to native, set `lastFallbackReason`, notify warning.

## Compatibility resolution (`src/compatibility.ts`)

`resolveCompactionRuntimeCompatibility({ event, modelRegistry, compactHelperArity })` detects Pi runtime capabilities by inspecting `compact.length` (the Pi helper's arity, overridable via `compactHelperArity` in tests):

| Helper arity | Supports | Effect |
|---|---|---|
| ≥ 7 | `thinkingLevel` parameter | Compact+ passes `"minimal"` (cheap summaries regardless of session reasoning level) |
| ≥ 8 | `streamFn` + `env` parameters | Compact+ can supply a stream-aware provider route; without stream-fn support the routes below are irrelevant and Pi's own routing is used |

### Stream routes

> **Removed:** an earlier revision routed through a public `@earendil-works/pi-ai/compat` `streamSimple` adapter (`PUBLIC_STREAM_SIMPLE_FN`, dynamic import, `STREAM_SIMPLE_SHIM_REASON`). That shim was removed because it bypassed Pi's configured provider routes and request-time auth; do not reintroduce it.

| Route | Condition | `streamRoute` | `reason` |
|---|---|---|---|
| **Live session stream** | `helperSupportsStreamFn` and `event.streamFn` is a function | `"session"` | `null` |
| **Registry streamSimple** | No session `streamFn`, but `modelRegistry.streamSimple` is a function | `"registry"` | `REGISTRY_STREAM_REASON` |
| **Native fallback** | No safe stream route exists | — | `NATIVE_FALLBACK_REASON` |

1. **Live session stream (preferred):** the `session_before_compact` event's `streamFn` is Pi's own live stream for the session, so provider routing and auth stay exactly as the session configured them.
2. **Registry streamSimple:** Compact+ wraps `modelRegistry.streamSimple` in an arrow function that forwards all arguments and preserves the registry as `this`, keeping provider routing, request transforms, and request-time authentication inside Pi's registry. Reason string: `"Pi does not expose the live session stream function; Compact+ is using the registry streamSimple route to preserve provider routing and request transforms."`
3. **Native fallback:** when the helper predates stream support or neither stream source is available — including Pi 0.83.0, whose `ModelRegistry` exposes `getApiKeyAndHeaders` but no `streamSimple` and whose `SessionBeforeCompactEvent` carries no `streamFn` — Compact+ returns `undefined` from `onSessionBeforeCompact` instead of sending credentials through a generic stream adapter that may bypass custom provider routes. Telemetry records `executionPath: "native-fallback"` and the reason; the user sees a warning ("Compact+ is deferring to native Pi compaction to preserve stream-aware routing.").

### Auth and request fields per route (`src/compact.ts:runCustomCompaction`)

| Field | Session route | Registry route |
|---|---|---|
| `apiKey` / `headers` / `baseUrl` / `env` | Resolved once via `ctx.modelRegistry.getApiKeyAndHeaders(model)` and forwarded to `compact()` | Not resolved — the registry stream resolves provider auth at request time, so forwarding an earlier snapshot could override rotated credentials or routing |
| `model` | Copied with `baseUrl` spread onto the copy (never mutated) when auth supplies one | Passed through unchanged |
| `headers` | Null-valued entries filtered out; only string values forwarded | — |
| Auth failure (`auth.ok === false`) | `fallbackReason: "auth unavailable"`, `compact()` never called | n/a |
| `env` | Resolved auth's `env` (e.g. provider-scoped environment), appended as the final helper argument only when `helperSupportsStreamFn` | `undefined` at that argument position — the registry resolves environment with auth at request time |

The registry contract is asserted in `test/compaction-runtime-contract.test.ts`: with a registry-route compatibility the request carries no `apiKey`/`headers`/`env` and `getApiKeyAndHeaders` is never called, while the session route's forwarding behavior is asserted in `test/compact-run-custom-compaction.test.ts`.

### Abort handling

- **Signal selection:** `selectCompactionSignal(signal, ctx.signal)` — the coordinator passes `event.signal`; when both signals exist and are distinct they are combined with `AbortSignal.any([signal, contextSignal])` so aborting *either* one cancels the compaction, otherwise whichever exists is used; `undefined` if neither exists.
- **Checked before auth resolution, again after auth, and once more after argument construction** (before `compact()` is called): an aborted combined signal returns `{ result: undefined, fallbackReason: "compaction aborted" }` without resolving credentials or streaming — a context-signal abort during a pending auth resolution cancels even while the event signal is still live.
- **During streaming:** if the request throws, `requestSignal?.aborted` distinguishes cancellation (`"compaction aborted"`) from a provider failure (`"compact error: provider request failed"`).
- **Coordinator level:** `onSessionBeforeCompact` re-checks `event.signal?.aborted || ctx.signal?.aborted` after `runCustomCompaction` and calls `cancelAbortedCompaction()` — resets `selectedMode`/`isCompacting`/`lastTriggerAuto`, clears pending compaction, records `lastFallbackReason = "compaction aborted"`, and returns `{ cancel: true }` so Pi does not apply a half-finished summary.

**Invariant:** `COMPACT_PLUS_COMPACTION_THINKING_LEVEL = "minimal"` — Compact+ summaries always run at minimal thinking regardless of the session's reasoning level, to keep compaction fast and cheap. Failure paths never include provider error text or credentials in `fallbackReason` or telemetry.

**Change-entrypoint:** If Pi changes the `compact()` helper signature, update the arity checks in `resolveCompactionRuntimeCompatibility`. If Pi exposes the live session stream or a registry stream on new runtimes, prefer those over any direct pi-ai adapter import — the compat shim removal was deliberate.

## Summary generation (`src/compact.ts`, `src/prompts.ts`, `src/summary-schema.ts`)

### Summary instruction structure

`buildSummaryInstructions(mode, focus, options?)` in `src/prompts.ts` produces the prompt sent to the LLM during compaction. It includes:

1. **Current focus block** — XML-delimited `<current-focus>` with objective, blockers, decisions, dependency chain, active files. All values are escaped via `escapePromptData()` to prevent XML breakout.
2. **Structured schema** — the exact title line and all 13 section headings come from `STRUCTURED_SUMMARY_TITLE` / `STRUCTURED_SUMMARY_HEADINGS` in `src/summary-schema.ts`, the single source of truth shared with validation and focus-echo detection. Optional sections may use `None`; the `CRITICAL_HEADINGS` sections (Objective, Task State, Next Best Step, Continuity Instruction) must always be filled.
3. **Hard-mode constraints** — For `mode === "hard"`: short bullets, fewer historical details, only critical failed attempts, one next step.
4. **Direction-change detection** — When `options.previousSummary` is provided, detailed merging rules for each section (objective always from current conversation; decisions accumulate; failed attempts accumulate; open problems carry forward unless resolved).

### Summary schema and validation (`src/summary-schema.ts`)

Both validation and focus-echo draft extraction (`src/focus-echo/draft.ts`) parse summaries through the shared fence-aware `parseSummarySections()`: it normalizes newlines, skips the title line, tracks ``` and ~~~ fences (a fence closes only on the same marker kind with at least the opening length), and returns top-level `## ` headings, per-section body lines, a `contentBeforeFirstSection` flag, and an `unterminatedFence` flag. Only out-of-fence lines are collected — fenced lines (and the fence-marker lines themselves) are neither headings nor section body.

`validateStructuredSummary(summary)` enforces the full schema on one string:

- **Title**: line 1 must equal `STRUCTURED_SUMMARY_TITLE` exactly (`Compaction Summary — Compact+ memory`).
- **Headings**: every one of the 13 `STRUCTURED_SUMMARY_HEADINGS` must appear exactly once at top level; unknown or duplicate `## ` headings are rejected. Headings inside code fences never count, so quoted example summaries cannot spoof or duplicate schema sections.
- **Structure**: out-of-fence content before the first section, or an unterminated fence, is rejected.
- **Critical sections**: the four `CRITICAL_HEADINGS` exported from `src/summary-schema.ts` (`## Current Objective`, `## Current Task State`, `## Next Best Step`, `## Continuity Instruction`) require substantive text outside fences — their out-of-fence section lines, joined and trimmed, must be non-empty, not just `None`/`N/A` (an optional list marker is tolerated), and not solely the `FENCED_EXAMPLE_OMISSION` marker. A critical section whose only content sits inside a fence, or whose entire body is the omission marker, fails validation.

### Summary normalization (`src/compact.ts`)

`runCustomCompaction` validates the raw summary **before** normalizing (`finalizeCompactionAttempt`), then normalizes, then re-validates the normalized result with the same schema — a lossy rewrite can never drop a required heading and still be accepted.

An oversized but otherwise valid summary is normalized rather than rejected: the title and all section headings are preserved, and fenced code examples are dropped atomically — never cut mid-fence, which would turn an example heading into a duplicate schema heading. `omitFencedExamples()` (`src/compact.ts`) replaces each dropped fence with the `FENCED_EXAMPLE_OMISSION` marker string (`"[Code example omitted during normalization]"`, exported from `src/summary-schema.ts`) **only in non-critical sections**; in a `CRITICAL_HEADINGS` section the fence is dropped without any placeholder, so the section's line budget is spent exclusively on the real objective / task state / next step / continuity content rather than on a marker. `renderSummarySectionBody()` additionally skips bare marker lines in critical sections as a belt-and-braces guard. Because a critical section left with only the marker would be rejected by `validateStructuredSummary` (marker-only critical content is invalid), normalization cannot silently hollow out critical sections. After fence omission, body lines are truncated per line and section body line counts are progressively reduced via multipliers `[1, 0.75, 0.5, 0.35]` until the target fits (final fallback: multiplier `0.25`). Result metadata (`firstKeptEntryId`, `tokensBefore`, `details`) is retained across normalization.

| Constant | Value | Purpose |
|---|---|---|
| `MAX_VALID_SUMMARY_TOKENS` | 4000 | Reject if above (estimated as chars/4) |
| `TARGET_NORMALIZED_SUMMARY_TOKENS` | 3200 | Target after normalization |
| `MAX_PREVIOUS_SUMMARY_TOKENS` | 1600 | Max for carried-forward previous summary |
| `MAX_SUMMARY_LINE_CHARS` | 240 | Per-line truncation |

**Section body line limits** (`SECTION_BODY_LINE_LIMITS`): derived positionally from `STRUCTURED_SUMMARY_HEADINGS` (4–14 lines per section). Changing the heading list in `summary-schema.ts` requires updating the parallel limits array in `compact.ts`.

Any invalid summary — missing title, missing/unknown/duplicate heading, empty critical section, unterminated fence, content before the first section, empty summary, or still oversized after normalization — yields `result: undefined` with `fallbackReason: "compaction summary invalid: …"` (or `"summary too large"`), and `onSessionBeforeCompact` falls back to native Pi compaction with a warning notification.

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
npx vitest run test/index.test.ts              # policy, settings, compaction, focus-echo, usage
npx vitest run test/classify-extract.test.ts    # Classification
npx vitest run test/lifecycle.test.ts           # executeCompaction lifecycle
npx vitest run test/compatibility.test.ts       # stream route selection (session/registry/native fallback)
npx vitest run test/compaction-runtime-contract.test.ts  # real compact() helper through the registry route
npx vitest run test/provider-boundary-087.test.ts  # skipUnless a host Pi 0.87 install exists: routes the real Pi 0.87 compact() helper through runCustomCompaction to a custom provider with request-time auth, no network
npx vitest run test/compact-run-custom-compaction.test.ts  # runCustomCompaction: auth forwarding, aborts, schema validation, normalization, native fallback
npx vitest run test/summary-provenance.test.ts  # persisted-summary detection + schema provenance
npx vitest run test/snapshot-evidence.test.ts   # Session evidence extraction
npx vitest run test/session-branch-view.test.ts # Branch view projection
```

## Safe-edit guidance

- **Changing thresholds**: Update defaults in `src/settings.ts:DEFAULT_COMPACT_PLUS_SETTINGS`. Invalid/overlapping values fall back to the default profile automatically.
- **Changing the guard cascade**: Edit `maybeAutoCompact` in `src/compaction-coordinator.ts`. Document the guard order — it is intentional.
- **Changing summary schema**: Edit `STRUCTURED_SUMMARY_HEADINGS` / `STRUCTURED_SUMMARY_TITLE` / `CRITICAL_HEADINGS` in `src/summary-schema.ts` (single source of truth for prompts, validation, and focus-echo detection). Also update the parallel `SECTION_BODY_LINE_LIMITS` array in `compact.ts` — it is derived positionally from the heading list, so length/order mismatches shift limits onto the wrong sections.
- **Changing thinking level**: Edit `COMPACT_PLUS_COMPACTION_THINKING_LEVEL` in `compatibility.ts`.
- **Adding a new compaction mode**: Add to `CompactionMode` type, update `modeSeverity()`, `getModeFromUsage`/`getModeFromTokenUsage`, and the guard cascade.
