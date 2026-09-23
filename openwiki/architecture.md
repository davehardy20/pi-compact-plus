# Architecture

> Extension composition root, event wiring, dependency injection, state lifecycle, module ownership seams.

## Composition root: `src/index.ts`

The default export `compactPlusExtension(pi: ExtensionAPI)` is the single function Pi calls when loading the extension. It:

1. **Resolves settings once** at module-load time: `resolveCompactPlusSettings()` → `thresholdSettings`. Threshold and cooldown values are frozen after load; changing them requires `/reload` or a Pi restart. See [settings-and-state.md](settings-and-state.md).

2. **Creates shared state**: A single `CompactionState` instance (module-level `const state`) holds all mutable compaction and tool-output-pruning state. This is the only mutable state container.

3. **Instantiates coordinators**:
   - `CompactionCoordinator` — receives `state`, `pi`, `thresholdSettings`, `getEffectiveUsage`, and `persistTelemetrySnapshot`.
   - `ToolOutputPruningCoordinator` — receives `state.toolOutputPruning` and `getSettings: () => resolveCompactPlusSettings()`.

4. **Registers a tool**: `pi.registerTool(createQueryToolDefinition(...))` — always registers `compact_plus_query_tool_output` (execution throws unless pruning is enabled; see [tool-output-pruning.md](tool-output-pruning.md)).

5. **Registers commands**: `registerCompactPlusCommands(pi, {...})` — wires `/compact-plus` and `/checkpoint` commands.

6. **Registers event handlers**: `registerCompactPlusEventHandlers(pi, {...})` — wires all lifecycle hooks.

**Change-entrypoint:** To add a new command or event, modify `src/commands.ts` or `src/events.ts`, not `index.ts`. The composition root should rarely change.

## Dependency injection pattern

The extension uses explicit constructor/parameter injection — **no service locator, no global singletons other than the single `CompactionState`**. Each coordinator receives its dependencies via an options object:

```typescript
// src/index.ts (simplified)
const state = new CompactionState();
const toolOutputPruning = new ToolOutputPruningCoordinator({
    state: state.toolOutputPruning,
    getSettings: resolveCompactPlusSettings,
});
const compactionCoordinator = new CompactionCoordinator({
    state, pi, thresholdSettings,
    getEffectiveUsage, persistTelemetrySnapshot,
});
```

**Test hook:** `index.ts` exports `__test__` with getters for internal state fields. Tests use `vi.mock` to replace Pi core packages (`@earendil-works/pi-coding-agent`, `@earendil-works/pi-agent-core`, `@earendil-works/pi-ai`) with mocks.

## Module ownership seams

| Seam | Owns | Key files |
|---|---|---|
| Composition root | Wiring only; no business logic | `src/index.ts` |
| Commands | Command argument parsing, status formatting, UI notify | `src/commands.ts`, `src/extension-status.ts` |
| Events | Pi lifecycle event registration; delegates to coordinators | `src/events.ts` |
| Compaction orchestration | Manual/auto trigger, guard cascade, telemetry | `src/compaction-coordinator.ts`, `src/lifecycle.ts` |
| Compaction execution | Custom summary generation, classification, normalization | `src/compact.ts` |
| Compatibility | Runtime feature detection, streamSimple shim, fallback | `src/compatibility.ts` |
| Policy | Threshold/band math, checkpoint data, status snapshots | `src/policy.ts` |
| Usage | Native vs estimated usage lookup | `src/usage.ts` |
| Session evidence | Message scanning, objective/blocker/file extraction | `src/session-evidence.ts` |
| Branch view | Pi session branch projection (read-only) | `src/session-branch-view.ts` |
| Message helpers | Role checking, content block extraction, tool-call parsing | `src/pi-messages.ts` |
| Prompts | Summary instruction building, focus block escaping | `src/prompts.ts` |
| Classification | Content-density scoring for hard-mode pruning | `src/classify.ts` |
| Settings | Env/file/default resolution, validation, fallbacks | `src/settings.ts` |
| Persistence | Telemetry JSON with security guards | `src/persist.ts` |
| Types | Shared type definitions, frozen constants | `src/types.ts` |
| State | Mutable state container, guard helpers | `src/state.ts` |
| Focus echo | See [focus-echo.md](focus-echo.md) | `src/focus-echo/*` |
| Tool-output pruning | See [tool-output-pruning.md](tool-output-pruning.md) | `src/tool-output-pruning/*` |

## Event lifecycle wiring (`src/events.ts`)

`registerCompactPlusEventHandlers` subscribes to these Pi events:

| Event | Handler | Purpose |
|---|---|---|
| `session_start` | Load persisted telemetry, reset state | Restore cross-session compaction history |
| `agent_start` | Reset `lastCompactTurnIndex`, `toolOutputPruning.onAgentStart()` | Pi restarts `turnIndex` per run, so same-turn suppression is run-scoped |
| `turn_end` | Capture tool batch, record auto-compact candidate | Candidate only when assistant message has `stopReason: "stop"` |
| `message_end` | Flush pending pruning | Assistant messages only; never compacts |
| `agent_settled` | Maybe auto-compact — the **only** auto-compaction boundary | Requires recorded candidate, `ctx.isIdle()`, no pending messages, no pending pruning flush |
| `session_before_compact` | Clear pending auto-compact candidate, `compactionCoordinator.onSessionBeforeCompact()` | Manual/native compaction supersedes a queued auto candidate; custom summary generation or native fallback |
| `session_compact` | Clear pending auto-compact candidate, `compactionCoordinator.onSessionCompact()` | Record final telemetry |
| `session_before_tree` | Build branch instructions from focus | Custom instructions for session-tree compaction |
| `session_tree` | `toolOutputPruning.onSessionTree()` | Reconcile/reconstruct pruning records for new branch |
| `session_shutdown` | `toolOutputPruning.onSessionShutdown()` | Full pruning state reset |
| `context` | Pruning transform → focus-echo reorder | Applied to every context snapshot sent to the model |
| `model_select` | `compactionCoordinator.onModelSelect()` | Reset model-scoped state on model change |

**Key sequencing invariant:** Auto-compaction runs **only** in the `agent_settled` handler — never inside `message_end`/`turn_end`, where `ctx.compact()` would abort the active run and could discard or replay tool results. `turn_end` only records `state.pendingAutoCompactTurnIndex` for the final successful assistant turn (`stopReason: "stop"`); `agent_settled` consumes it and returns early unless `ctx.isIdle()` and `ctx.hasPendingMessages()` is false. If `toolOutputPruning.hasPendingFlush()` is true at settlement, auto-compaction is skipped. A manual or native compaction (`session_before_compact`/`session_compact`) clears the pending candidate.

**The `context` event pipeline:** Pruning stubs first (`toolOutputPruning.transformContext`), then focus-echo reordering (`reorderForPositioning`). Both are no-ops when their respective conditions aren't met.

## State lifecycle (`src/state.ts`)

`CompactionState` is a plain class with public mutable fields — no encapsulation beyond the class boundary. This is intentional for simplicity.

**State fields:**

| Field | Type | Reset by |
|---|---|---|
| `selectedMode` | `CompactionMode \| null` | `reset()`, `resetOnModelChange()`, compaction complete |
| `isCompacting` | `boolean` | Set true on trigger, false on complete/error |
| `lastCompactTime` | `number` | Updated after each compaction; used by cooldown |
| `lastCompactTokens` | `number` | Updated post-compaction; used by regrowth guard |
| `lastCompactTurnIndex` | `number` | Reset to -1 on `agent_start` (turnIndex is run-scoped); set on auto-compaction |
| `pendingAutoCompactTurnIndex` | `number \| null` | Set by `turn_end`; consumed by `agent_settled`; cleared on reset/model change/manual-native compaction |
| `lastModelKey` | `string \| null` | Set on model_select; never reset |
| `lastCompaction` | `CompactionTelemetry \| null` | Set on session_compact |
| `echoInjected` | `boolean` | Set true after context reorder; false on compaction |
| `toolOutputPruning` | `ToolOutputPruningState` | Own sub-state with its own reset |
| `telemetryPersistenceIssues` | `TelemetryPersistenceIssue[]` | Capped at 5 most-recent |

**Reset triggers:**
- `session_start` → full `reset()` + load persisted telemetry
- `model_select` (model change) → `resetOnModelChange(key)`: resets everything except `lastModelKey` and `telemetryPersistenceIssues`
- `session_shutdown` → `toolOutputPruning.reset()` only

**Guard helpers:**
- `isOnCooldown(cooldownMs)` — `Date.now() - lastCompactTime < cooldownMs`
- `isRegrowthBelowThreshold(tokens, regrowth)` — token growth since last compaction < 1000 tokens (`REGROWTH_TOKENS`)
- `isSameTurn(turnIndex)` — prevents double-trigger within same turn

## Common failure modes

| Failure | Symptom | Fix |
|---|---|---|
| Extension loaded twice | Commands appear twice in Pi | Remove old local auto-discovered extension; run `/compact-plus-status` to check loaded path |
| Settings not applied after edit | Threshold changes don't take effect | Run `/reload`; threshold settings are frozen at module-load time |
| `streamSimple` unavailable | Custom summary fails, native fallback | Ensure `@earendil-works/pi-ai` peer dep is installed at correct version |
| Telemetry persistence fails | `telemetryPersistenceIssues` populated | Check `~/.pi/agent/state/` permissions, symlinks, disk space |

## Safe-edit guidance

- **Do not add module-level mutable state.** All state goes through `CompactionState`.
- **Do not call `resolveCompactPlusSettings()` in hot paths** — it reads the filesystem. The composition root caches `thresholdSettings`; tool-output pruning re-resolves per-event by design.
- **New events go in `events.ts`**, new commands in `commands.ts`. Keep `index.ts` as pure wiring.
- **When adding a coordinator method**, thread it through the existing options-object pattern; do not reach into module-level `state` directly from new modules.
- **Test changes** by running the full suite: `npm test`. The `__test__` export in `index.ts` provides state introspection for tests.
