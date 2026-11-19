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

1. Read `state.selectedMode` — if null, run `guardNativeSummarizationRequest()` first: measure the exact request Pi is about to send and `{ cancel: true }` when it cannot fit the model context window, otherwise return `undefined` (Pi handles natively).
2. Extract focus from the active session projection (`currentProjectedMessages(ctx)` in `src/session-projection.ts`) — Pi omits retained messages from `preparation.messagesToSummarize`, and an empty projection is authoritative.
3. Abort check (`event.signal`/`ctx.signal`) → `cancelAbortedCompaction()`. Intent evidence that cannot be captured or measured within the budget → cancel with warning; evidence that is merely too large is capped newest-first (turns that cannot fit the remaining budget are skipped) and trimmed oldest-first, never cancelled.
4. Resolve compatibility: `resolveCompactionRuntimeCompatibility({ event, modelRegistry: ctx.modelRegistry })` (`src/compaction-coordinator.ts`).
5. Build telemetry base.
6. **If execution path is `native-fallback`**: measure the deferred payload first, resolve `headroomDefers` (`deferred.reason` present and provider usage reports bounded headroom), re-check the compaction epoch, then set and persist `pendingCompaction` with the single settled reason — `SUMMARIZATION_SUSPECT_ESTIMATE_REASON` when headroom outranks the estimate, otherwise the measured overflow reason when the deferred payload cannot fit, otherwise the compatibility reason (`compatibilityReason` still carries the original text) — notify the deferral warning, and `{ cancel: true }` only when the deferred payload cannot fit and headroom does not defer it. The overflow report that follows only warns (`kind: null`), because the verdict for this decision was already recorded. Otherwise return `undefined` (Pi does native compaction).
7. **Otherwise**: Call `runCustomCompaction(preparation, mode, ctx, compatibility, event.signal, { focus, customInstructions })`; a post-run abort check cancels before applying any result.
   - **Success**: Return `{ compaction: { ...result, details: { mode, triggerReason, ... } } }`.
   - **Failure**: Output-cap exhaustion cancels by default; disabling the optional native guard makes it eligible for fallback, not exempt from measurement. Before handing any eligible failure back to Pi, capture each native request independently and require every capture to fit. Missing captures and oversized requests cancel before recording a deferral. This check bypasses the optional native guard and its cache and never uses conversation usage as proof of fit. Recheck abort and freshness before and after awaiting telemetry persistence.

## Summarization request measurement (`src/summarization-request-budget.ts`)

The API description below is runtime-aware. The detailed native-path and intent-evidence walkthroughs use the **legacy Pi 0.87.1/1.0.1** reserve fractions and prefix serialization. For Pi 1.5.2, use [SDK output allowances and prefix measurement](#sdk-output-allowances-and-prefix-measurement) instead of those legacy fractions and no-prefix-guidance assumptions. Guard, cache and lifecycle rules remain shared.

`measureSummaryRequestTokens({ messages, model, reserveTokens, reservedOutputTokens, turnPrefix, signal, customInstructions, previousSummary, thinkingLevel })` returns `{ transcriptTokens, reservedOutputTokens, totalTokens }` for the SDK-built request, or `undefined` when it cannot be measured safely. It captures the assembled context and output allowance through an injected stream function that throws before any registry, credential, transport, or network work (tests assert `fetch` is never called). History uses the public `generateSummaryWithUsage()`; `turnPrefix: true` drives the private prefix builder through a prefix-only public `compact()` call. A captured explicit cap, including zero, is authoritative. If the SDK omits the cap, a positive model ceiling supplies the allowance; an omitted cap with no positive ceiling is unmeasurable. The optional legacy `reservedOutputTokens` override is clamped to the positive model ceiling.

`totalTokens` is what the provider must fit in one request: transcript plus the clamped reserved output. Estimates come from `estimateTokens` (characters / 4) and can err in either direction — base64 and minified JSON tokenize denser than 4 chars/token, prose and markup sparser. The guard trips only above the full `contextWindow`, not above Pi's `contextWindow - reserveTokens` trigger. The same primitive backs the intent-evidence budget in `src/compaction-intent.ts` and the native-path guard in `src/compaction-coordinator.ts`.

The native-path guard measures each request Pi would actually send: the history cut (`messagesToSummarize`) with the standard output budget, and on a split turn the turn prefix (`turnPrefixMessages`) as a separate request carrying no custom instructions or previous summary and reserving `floor(0.5 * reserveTokens)`, matching Pi's private `generateTurnPrefixSummary()`. Only an individual request that cannot fit is a cancel; merging the slices would over-cancel because Pi never sends them as one request. Before serializing, the guard skips measurement only when `usage.tokens + reserveTokens + model.maxTokens <= contextWindow`, the model window and output ceiling are positive safe integers, **and no caller guidance is present**. The ceiling bounds the SDK output before capture; the existing reserve remains padding for rendering. An unknown ceiling or any `customInstructions` (a guided `/compact`, for example) forces real measurement. The verdict is cached per unchanged cut (session, leaf, model identity, context window, output ceiling, `reserveTokens`, slice counts, slice content character totals including tool arguments and image data, split flag, instruction length, its first and last 32 characters, and a bounded content digest of the guidance) and written only by the measurement, so a cached measurement never masquerades as a provider-classified reason and a payload that grows without changing any message count or text length re-measures rather than reusing a stale verdict. Image payload is a discriminator only: Pi renders the summarization conversation through `serializeConversation`, which drops image blocks (it keeps user and assistant text, thinking, tool calls, and truncated tool results), so image bytes never count toward `totalTokens` even though their length changes the cut key. Traversal is bounded twice per tool-call payload: by node count (`STRUCTURAL_NODE_BUDGET`) and by nesting depth (`STRUCTURAL_DEPTH_BUDGET`, because deep nesting would hit the call stack before the node budget), and the walk stops entirely once either is exhausted, so sibling growth in a tool-call object always changes the key while the budget lasts. Key building is also wrapped: a traversal that throws (a getter that throws, for example) yields **no key**, which makes the guard measure that cut from scratch instead of letting the failure escape a Pi event handler. A walk that ran out of budget or depth is not a complete key: the key keeps its stable `partial` marker so the notice dedupe still recognizes the cut and warns about it once, while the verdict cache marks it `partial` so a partial total can never carry or match a verdict — an unchanged cut that exhausts the budget is re-measured every attempt. A cut whose key building throws entirely is measured with **no key**: it is never cached, and it never dedupes against the "nothing warned about yet" state, so it cannot lose its first warning. The guidance digest covers three windows of `DIGEST_WINDOW` characters and is a discriminator beyond them, not a guarantee. All coordinator guard state is session-scoped and cleared on `session_start`. `guardNativeCompaction: false` disables the optional estimation guard on the native path before a custom attempt. It does not skip the separate check after a custom attempt fails. Set it via `"guardNativeCompaction": false` in settings or `COMPACT_PLUS_GUARD_NATIVE_COMPACTION=false`; `/compact-plus` status shows `guard-native-compaction=on|off`.

`attempt.requestOverflow` from the custom path is always judged against Pi's own requests through `detectSummarizationRequestOverflow()`: Compact+ merges both split slices into one request and its rendered instructions carry intent evidence Pi never sends, so an overflow of Compact+'s superset is not authority to decline a compaction Pi could still perform. That is what the earlier superset-is-authoritative rule broke: a session at 69% of its window was estimated over 100% by characters/4 and declined, so nothing compacted. Deferring also releases `selectedMode`/`isCompacting`/`lastTriggerAuto`, so a deferred attempt cannot block later automatic triggers. A post-custom handoff requires fresh measurements for all native requests. A missing or oversized capture cancels. An exhausted output cap cancels unless the optional guard is disabled and the new request fits. The intent-evidence budget separates transcript-driven from evidence-driven rejection: when the merged cut cannot fit, `prepareBudgetedCompactionFocus()` re-measures it carrying no custom instructions, and a baseline that also cannot fit marks `transcriptOverflow`, which `runCustomCompaction()` reports as `requestOverflow` with the context-overflow reason. Evidence collection also accumulates newest-first and skips any turn that does not fit the remaining budget, where that budget is `model.contextWindow - min(floor(0.8 * reserveTokens), model.maxTokens)` — the reserved output clamped exactly as Pi clamps it, because evidence alone can never cost more than that — so a retained paste bigger than the window drops itself while older turns that still fit are kept; the surviving set is chronological but not necessarily a contiguous newest suffix. Turns the cap never admits are reported through `evidenceTrimmed` alongside the trim search's own drops; that reporting is user-facing, and the summary model sees only the surviving evidence. Counting stays conservative when the native prefix cannot be verified: containment is not inferable from position, so no drop is subtracted and the reported count may include a turn the cut is summarizing anyway. When the baseline does fit, the evidence Compact+ added itself is trimmed oldest-turn-first by binary search over the drop count (the smallest trim that fits, in `log2(n)` re-measurements) and re-measured, and the attempt proceeds with `evidenceTrimmed` reported as `SUMMARIZATION_EVIDENCE_TRIMMED_REASON` and a UI notice; only a request that still cannot fit with all added evidence dropped is an evidence-driven rejection, and that alone gets the intent-evidence warning. On the optional native guard path or compatibility deferral before a custom attempt, provider-reported usage (`source: "native"`) can outrank a transcript estimate by the bounded allowance in `estimateDiscrepancy()`. Those paths record `SUMMARIZATION_SUSPECT_ESTIMATE_REASON` instead of the estimate or compatibility reason (`compatibilityReason` still carries the original text). This override never applies after a custom attempt fails. The bound uses `max(reserveTokens, capturedOutputAllowance)` plus `SUSPECT_ESTIMATE_HEADROOM_TOKENS`, and also counts Compact+'s own issued prompt because Pi appends it verbatim on the deferral path. Provider usage may contradict the transcript estimate, never the SDK's output commitment. Both split requests are captured before an override: the largest captured allowance applies, and any unmeasurable request disables an override of a measured overflow. An incomplete capture also prevents verdict reuse, so a later successful capture can restore a justified legacy-cap deferral. Before capture, only a positive model ceiling can supply a conservative allowance. Actual legacy explicit caps remain authoritative instead of being replaced with a larger registry ceiling. The override speaks only for an estimate: `runCustomCompaction()` marks a provider rejection `providerConfirmed: true`, and a proven rejection is never relabelled as a suspect estimate. The bounded constant is named so the rule is auditable rather than an ad-hoc percentage. Compact+'s own issued prompt is the payload under examination, so it is not guidance for this comparison; third-party `customInstructions` are additive to reported usage and disable it entirely. The comparison fails closed when usage is unknown, non-native, non-positive, or near the window, and it never excuses an exhausted output budget. `executeCompaction`'s `onError` suppresses its own `Compact+ compaction failed: …` notice when a summarization overflow was already reported for that attempt: `executeCompaction()` clears `state.lastOverflowReportedEpoch` at attempt start and `reportSummarizationOverflow()` re-stamps it only when the guard declines during the attempt. The epoch moves only on a session transition, so clearing it is what stops an earlier attempt's overflow from silencing later failure notices; a steady-state session declining the same cut still suppresses because the guard reports the decline every attempt. A manual `/compact-plus` decline always explains itself; that bypass is attempt-scoped — `executeCompaction` reports the attempt as settled through `onSettled`, called from `onComplete`, `onError`, and a synchronous throw from `ctx.compact()`, and the coordinator clears the bypass there, when the attempt is classified, and only for the epoch that attempt belongs to. A synchronous throw also runs the full lifecycle cleanup, so the session is never left "compacting".

## Summarization overflow classification (`src/summarization-overflow.ts`)

`classifySummarizationFailure(error)` returns `"context-overflow"`, `"output-cap"`, or `"provider-error"`, and `summarizationFailureReason()` maps the first two to stable reason constants. Pi's `OVERFLOW_PATTERNS` missed the captured llama.cpp-style wording (`prompt (300932 tokens) + max tokens (1) exceeds the context (262144)`) and the error is not retryable, so unclassified it flattens to a generic provider error and the identical oversized payload goes straight back to native Pi compaction.

Both Strata forms are recognised: `prompt (...) + max tokens (...) exceeds the context (...)` and `request exceeds the context window: prompt (...) leaves no room to answer in the context (...)`. Unrelated provider errors still use the generic failure path.

Classification only: reason strings are stable constants carrying no provider text, digits, or credentials, so they stay safe for telemetry and UI. `runCustomCompaction()` marks the attempt `requestOverflow: true`; the coordinator measures the payload Pi would actually send before choosing between cancelling and deferring, and picks the warning from the classified reason, so an output-cap exhaustion is not reported as a context-window overflow.

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
- **Coordinator level:** `onSessionBeforeCompact` re-checks `event.signal?.aborted || ctx.signal?.aborted` after `runCustomCompaction` and calls `cancelAbortedCompaction()` — resets `selectedMode`/`isCompacting`/`lastTriggerAuto`, clears pending compaction, records the `cancelled` verdict with reason `"compaction aborted"`, and returns `{ cancel: true }` so Pi does not apply a half-finished summary.

**Invariant:** `COMPACT_PLUS_COMPACTION_THINKING_LEVEL = "minimal"` — Compact+ summaries always run at minimal thinking regardless of the session's reasoning level, to keep compaction fast and cheap. Failure paths never include provider error text or credentials in `fallbackReason` or telemetry.

**Change-entrypoint:** If Pi changes the `compact()` helper signature, update the arity checks in `resolveCompactionRuntimeCompatibility`. If Pi exposes the live session stream or a registry stream on new runtimes, prefer those over any direct pi-ai adapter import — the compat shim removal was deliberate.

## Compaction verdict (`src/compaction-verdict.ts`)

Every compaction decision Compact+ makes is recorded as a `CompactionVerdict`: `kind` (the closed set `accepted | trimmed | deferred | declined | cancelled`), the unchanged prose `reason`, and optional `evidenceTrimmedTurns` / `usageTokens` measured at the decision.

- **Single writer:** `CompactionCoordinator.recordVerdict()` is the only writer of the verdict. The old `state.lastFallbackReason` mirror is gone: the persisted telemetry field `lastFallbackReason` is written from `state.lastVerdict?.reason`, so prose exists only as the shape of the persisted record, never as a second source of truth.
- **Read path:** `coordinator.getLastVerdict()` returns a frozen copy. It is the newest decision, which can be older than the newest compaction: a Pi-native compaction Compact+ did not settle records nothing, so the previous verdict remains. `/compact-plus` status builds its snapshot from the accessor and renders the fallback line from `verdict.reason`.
- **Turn-boundary drafts:** returning a draft does not record success, warn about trimmed evidence, or write a telemetry snapshot. The coordinator waits for Pi to commit a checkpoint with the matching boundary marker. If the summary is unavailable, the coordinator reports a deferral in memory without staging a native fallback for that turn.
- **SDK recovery drafts:** a recovered summary returned through `session_before_compact` is provisional. On `session_compact`, the coordinator checks that the latest checkpoint on the same session branch carries the matching recovery marker before reporting acceptance or writing telemetry. An abort before Pi saves the draft, or a saved replacement without that marker, does not report success for the draft.
- **Restore:** at `session_start`, `src/events.ts` maps the persisted `lastFallbackReason` with `compactionVerdictFromReason()`, guards the shape with `isCompactionVerdict()`, then hands the verdict to `coordinator.restoreVerdict()`. A persisted record with no reason restores no verdict.
- **Evidence:** `usageTokens` is attached at every write site that had a measurement in scope (guard cascade, attempt cancel, deferral, settled attempt, overflow report, safe-boundary failure). An attempt aborted before any usage was computed carries no usage.
- **Known divergences between a live kind and a restored kind** (pinned in `test/compaction-verdict-interface.test.ts`): `SUMMARIZATION_CONTEXT_OVERFLOW_REASON` (live `declined`, `cancelled` or `deferred`; mapper says `declined`), `SUMMARIZATION_OUTPUT_CAP_REASON` (live `cancelled`, or `deferred` when `guardNativeCompaction` is false; mapper says `cancelled`), and any deferral reason Pi later settles (live `accepted`, restored `deferred`). An unmeasurable native fallback is `cancelled` both live and when its reason is restored. Persisting the kind would require a telemetry schema change.

## Summary generation (`src/compact.ts`, `src/prompts.ts`, `src/summary-schema.ts`)

### Bounded recovery (opt-in)

Recovery is off by default. Set `COMPACT_PLUS_ENABLE_RECOVERY=1` in the environment of the Pi process when loading Compact+ to opt in. Only the exact value `1` enables it; this is not a `settings.json` key. The opt-in applies to Compact+ custom summaries on the SDK compaction hook. It does not enable recovery for native Pi compaction, the separate turn-boundary transaction, or runtimes without a stream-aware custom route. The runner requires a current compaction context and either measured transcript overflow or a provider-confirmed context overflow on the initial custom request. A request that fits and succeeds still takes the usual single-call path.

The coordinator checks that the preparation's compaction settings still match and that no pruning flush has started since the custom attempt began. A flush invalidates the attempt even if it settles before the next check without moving the session leaf. These checks guard custom requests and results as well as the independent native fallback measurement after a custom failure.

The runner captures recovery inputs before the initial budget await. It dispatches the measured payloads without re-pruning or re-rendering, uses the usual request-time authentication route, and validates, normalizes and revalidates each result. The native summary limit and recovery envelope share the same size constants.

The coordinator cancels a recovery attempt that yields no result, even if the runner omits its generic cancellation flag. It does not replay the cut through native compaction. A provider rejection cannot be overridden by a local estimate for the same transcript, even with the native guard off. Pi's genuinely separate split-turn requests can still be measured for fallback when recovery did not run. Unrelated custom failures can still hand off to Pi if an independent measurement shows that Pi's request fits.

After a provider rejection, the planner budgets each recovery request at most 75% of the exact rejected request's local estimate, still capped at 95% of the model window. It allows at most three partials plus one reducer, so the rejected initial request counts toward the same five-request limit. This adds headroom; it does not guarantee that the provider will agree with the estimate. Recovery success is reported only after Pi commits the matching checkpoint.

The engine preserves chronological visible evidence and balanced tool intervals, including interleaved calls/results. It carries previous memory, omitted user turns (including repeats) and caller guidance as complete records; excludes historical thinking and explicitly excluded bash; and rejects unsupported evidence instead of truncating it. `src/compaction-recovery-evidence.ts` captures evidence, primitive preparation/settings metadata, previous memory and caller guidance before readers, interpolation or asynchronous work. Original source arrays are checked separately before combining copies; custom iterators are rejected without invocation. Unknown preparation fields are not spread, and SDK-owned file-operation Sets retain their original identity. Retained arguments pass through the same bounded snapshots before focus extraction. Copied metadata must have the expected primitive types. JSON hooks, field/index accessors, cycles and inherited sparse indices are rejected without invocation; valid sparse holes become explicit nulls in independent copies. Work is bounded to four partial requests plus one reducer, 10,000 messages/groups, eight million text characters, 100,000 structural visits (including inspected property descriptors) and depth 256. It measures every planned request and a worst-case reducer through the public SDK before execution, then remeasures the actual reducer at a 95% window limit. Only a validated final result escapes, with original checkpoint metadata/file operations and aggregate usage. Abort, stale work, malformed outputs or exceeded bounds return no checkpoint; the caller must not replay failed recovery natively.

Planning takes the longest measured chronological prefix that fits, preserving atomic groups. Binary search relies on the SDK's monotonic character-based estimate for nonempty user-data wrappers; partial labels 1–4 have identical overhead. Recheck this assumption when updating the SDK. With at most 10,000 groups, three searches of at most 14 probes, four whole-remainder checks and two reducer checks cap measurement work at 48 calls. The worst-case reducer reserves 16,000 characters for each **actually planned** partial, not four unconditionally. All planned maps and that reducer must fit before any execution; the actual reducer is still measured separately.

### Historical thinking and request size

`normalizeCompactionPreparation()` removes assistant `thinking` blocks from copies of both summary slices before hard-mode classification, budget measurement and sending. Older Pi helpers (including the 1.0.1 helper covered by compatibility fixtures) otherwise serialize historical reasoning as plain text, even when the provider omits it from live requests. Visible text, tool calls/results, message order and the kept boundary are preserved; the session transcript is unchanged. Newer helpers, including the locked 1.5.2 SDK, already omit thinking, so this preparation is compatible with either behavior. This is separate from the summary model's own `thinkingLevel` setting.

### SDK output allowances and prefix measurement

For Pi 1.5.2, prefix guidance is included by the native builder and the evidence admission bound is `model.contextWindow - baseline.reservedOutputTokens`, not a legacy reserve fraction. Retention of transcript content, including historical thinking, also depends on the SDK version.

The budget includes the captured helper output allowance. Pi 1.5.2 omits an explicit cap and defaults downstream to the positive model ceiling; older helpers expose reserve-derived caps. An absent cap with no positive ceiling is unmeasurable, not zero output. Native split-prefix checks capture the private builder through a prefix-only public `compact()` call, preserving that SDK's prompt, guidance and allowance. Counts remain helper-level estimates before provider reductions/transforms, not provider-tokenizer measurements. Native fallback is measured against the native helper's own payload, not the modified custom preparation. Regression coverage intercepts real-SDK requests without a network call; it does not prove the exact cause of a particular live provider failure.

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

`CompactionTelemetry` records: mode, triggerSource (`message_end`/`turn_end`/`command`), triggerReason, timestamp, focusTags (active file basenames), previousSummaryPresent, splitTurn, usageSource, fallbackReason, classifiedCounts, usagePercentAtTrigger, usageTokensAtTrigger, executionPath (`custom`/`native-fallback`), fromExtension, thinkingLevel, compatibilityReason, intentEvidenceTrimmedTurns (retained turns dropped from Compact+'s own intent evidence so the request could fit, counting both the turns the size cap never admitted and the turns the trim search removed). Optional numbers are validated on load (`telemetry-validation.ts`) — a trimmed-turn count must be a positive safe integer within the message bound — so a trim stays visible to `/compact-plus status` after a reload rather than being silently dropped.

See [settings-and-state.md](settings-and-state.md) for persistence details.

## Test commands

```bash
npx vitest run test/index.test.ts              # policy, settings, compaction, focus-echo, usage
npx vitest run test/classify-extract.test.ts    # Classification
npx vitest run test/lifecycle.test.ts           # executeCompaction lifecycle
npx vitest run test/compatibility.test.ts       # stream route selection (session/registry/native fallback)
npx vitest run test/compaction-runtime-contract.test.ts  # real compact() helper through the registry route
npx vitest run test/provider-boundary-087.test.ts  # skipUnless a host Pi 0.87 install exists: routes the real Pi 0.87 compact() helper through runCustomCompaction to a custom provider with request-time auth, no network
npx vitest run test/compact-run-custom-compaction.test.ts  # runCustomCompaction: auth forwarding, aborts, schema validation, normalization, native fallback, summarization overflow classification
npx vitest run test/summarization-overflow.test.ts  # provider failure classification (context overflow, output cap, provider error)
npx vitest run test/summarization-request-budget.test.ts  # network-free measurement of the exact summarization request
npx vitest run test/compaction-overflow-recovery.test.ts  # coordinator: overflow cancels instead of deferring to native, native payload guard
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
