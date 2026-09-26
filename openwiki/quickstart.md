# Quickstart — pi-compact-plus

> **Agent-optimized docs.** Read this page first, then follow links to the relevant subsystem pages. Every page includes change-entrypoints, invariants, test commands, and safe-edit guidance.

## What this repository is

`@davehardy20/pi-compact-plus` is a **Pi coding-agent extension** that replaces Pi's single-threshold auto-compaction with a tiered, mode-aware policy and adds structured summaries, a focus-echo injection, and an experimental tool-output pruning subsystem.

**Runtime characteristics:**
- TypeScript ESM module, zero runtime dependencies (only peer deps on `@earendil-works/pi-*`).
- Single entry point: `src/index.ts` → default export `compactPlusExtension(pi: ExtensionAPI)`.
- No server, no database, no CLI binary. It runs inside the Pi agent process.
- All mutable state is in-memory (`CompactionState`); telemetry persists to `~/.pi/agent/state/compact-plus-telemetry.json`.

**Package identity:**
- Name: `@davehardy20/pi-compact-plus`
- Version: `0.2.0` (see `package.json`)
- License: MIT
- npm: `pi install npm:@davehardy20/pi-compact-plus`

## Repository layout (top level)

| Path | Purpose |
|---|---|
| `src/index.ts` | Extension composition root — wires commands, events, tool registration, state |
| `src/compaction-coordinator.ts` | Orchestrates manual + auto compaction; produces telemetry |
| `src/focus-echo/` | Summary detection, parsing, normalization, sanitization, context injection |
| `src/tool-output-pruning/` | Experimental LLM-summarized tool-output stubbing with recovery query |
| `src/settings.ts` | Settings resolution (env → settings.json → defaults) |
| `src/policy.ts` | Threshold/band computation, checkpoint data |
| `src/commands.ts` | Command routing plus status snapshot assembly and formatting |
| `src/persist.ts` | Telemetry JSON persistence with symlink/security guards |
| `src/telemetry-validation.ts` | Pure persisted-telemetry schema validation and coercion |
| `src/session-evidence.ts` | Extracts objective, blockers, decisions, active files from session messages |
| `test/` | Vitest test suite (run `npm test` for the current count) |
| `scripts/` | Build verification, package checks, release scripts |
| `.github/workflows/pr-checks-node.yml` | CI: typecheck + test |

## Build, test, verify

```bash
npm run typecheck      # tsc --noEmit
npm test               # vitest run (all tests)
npm run build          # tsc -p tsconfig.build.json → dist/
npm run verify         # typecheck + test + build + live-path-check + package:check
npm run package:check  # fast package-content sanity check
```

**Full local validation before opening a PR:**

```bash
npm run typecheck && npm test && npm run build
```

CI runs: `npm ci`, `npm run typecheck`, `npm test`. See [testing-and-release.md](testing-and-release.md).

## User-facing commands

| Command | Handler location |
|---|---|
| `/compact-plus` | `src/commands.ts` → `CompactionCoordinator.handleManualCommand("standard")` |
| `/compact-plus hard` | `src/commands.ts` → `CompactionCoordinator.handleManualCommand("hard")` |
| `/compact-plus status` | `src/commands.ts` → `buildStatusSnapshot` + `formatStatusLines` (same module) |
| `/compact-plus tool-prune status` | `src/tool-output-pruning/commands.ts` → `buildPruningStatusDetail` |
| `/compact-plus tool-prune flush` | `src/tool-output-pruning/coordinator.ts` → `manualFlush` |
| `/compact-plus-status` | `src/extension-status.ts` → `buildCompactPlusDebugStatusMessage` |
| `/checkpoint [note]` | `src/commands.ts` → `buildCheckpointData` + `pi.appendEntry` |

## Five major subsystems

1. **[Architecture](architecture.md)** — composition root, event wiring, dependency injection, state lifecycle, module ownership seams.
2. **[Compaction policy](compaction.md)** — threshold modes (`percent`/`tokens`/`effective_cap`), band computation, auto-compaction guard cascade, compatibility execution paths, structured summary generation and validation.
3. **[Focus echo](focus-echo.md)** — post-compaction memory injection: detection → draft → normalization → sanitization → positioning. Mitigates "lost in the middle."
4. **[Tool-output pruning](tool-output-pruning.md)** — experimental LLM-summarized tool-output stubbing with branch-safe metadata reconstruction and recovery query tool.
5. **[Settings & state](settings-and-state.md)** — env/settings.json/defaults resolution, threshold validation fallbacks, telemetry persistence, state management.

## Key invariants (quick reference)

| Invariant | Where enforced |
|---|---|
| Settings precedence: env > settings.json > DEFAULT | `src/settings.ts:resolveCompactPlusSettings()` |
| DEFAULT constants never read env or settings file | `src/settings.ts` — `DEFAULT_*` exports |
| Pruning "enabled" requires all 4 conditions | `src/tool-output-pruning/policy.ts:isToolOutputPruningEnabled()` |
| Protected tool exclusions are non-overridable | `src/tool-output-pruning/record-identity.ts:PROTECTED_EXCLUDED_TOOLS` |
| Atomic summarization: all records or none | `src/tool-output-pruning/lifecycle.ts:flushPendingBatches()` |
| Focus echo deduped per context batch | `src/focus-echo/positioning.ts:reorderForPositioning()` |
| Echo fields sanitized against prompt injection | `src/focus-echo/sanitization.ts` |
| Model change resets model-scoped state | `src/state.ts:resetOnModelChange()` |
| Cooldown + regrowth guards | `src/compaction-coordinator.ts:maybeAutoCompact()` |

## Where to start making changes

| If you want to change… | Start here | Read next |
|---|---|---|
| Threshold values or modes | `src/settings.ts` | [settings-and-state.md](settings-and-state.md) |
| Auto-compaction trigger logic | `src/compaction-coordinator.ts` → `maybeAutoCompact` | [compaction.md](compaction.md) |
| Summary prompt structure | `src/prompts.ts` | [compaction.md](compaction.md) |
| Focus echo behavior | `src/focus-echo/index.ts` (barrel) | [focus-echo.md](focus-echo.md) |
| Tool-output pruning safety | `src/tool-output-pruning/policy.ts` | [tool-output-pruning.md](tool-output-pruning.md) |
| Event wiring | `src/events.ts` | [architecture.md](architecture.md) |
| Commands | `src/commands.ts` | [architecture.md](architecture.md) |
| Telemetry persistence | `src/persist.ts` | [settings-and-state.md](settings-and-state.md) |

## Full source map

See [source-map.md](source-map.md) for a complete file inventory with ownership, change-entrypoints, and test associations.
