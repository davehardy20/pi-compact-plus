# Source Map

> File-by-file reference: ownership, change-entrypoint, what to touch for common tasks.

## Root files

| File | Purpose | Change when |
|---|---|---|
| `package.json` | Package metadata, scripts, peer deps, `files` allowlist, `pi.extensions` entry | Adding scripts, deps, changing published files |
| `tsconfig.json` | Typecheck config (strict, ES2022, NodeNext) | Changing TS target/module settings |
| `tsconfig.build.json` | Build config (emits to `dist/`) | Changing build output |
| `vitest.config.ts` | Test config (node environment) | Changing test environment |
| `biome.json` | Linting/formatting config | Changing lint rules |
| `README.md` | User-facing documentation | Feature changes, new settings, new commands |

## `src/` — Runtime source

### Composition root & wiring

| File | Ownership | Change-entrypoint for |
|---|---|---|
| `index.ts` | Extension composition root; registers commands, events, tool; creates state & coordinators | Adding new top-level wiring (rare); adding `__test__` getters |
| `commands.ts` | `/compact-plus` and `/checkpoint` command registration + argument parsing | New command subcommands; status formatting changes |
| `events.ts` | Pi lifecycle event registration; delegates to coordinators | New event subscriptions; event sequencing changes |
| `extension-status.ts` | `/compact-plus-status` command; package metadata display | Status output format changes |

### Compaction core

| File | Ownership | Change-entrypoint for |
|---|---|---|
| `compaction-coordinator.ts` | Manual/auto compaction orchestration; guard cascade; telemetry | New auto-compaction guards; telemetry fields; trigger logic |
| `lifecycle.ts` | `executeCompaction` — unified lifecycle for manual+auto | onComplete/onError behavior; continuation prompt |
| `compact.ts` | Custom summary generation, classification, normalization | Summary schema; normalization limits; validation |
| `compatibility.ts` | Runtime feature detection; streamSimple shim; fallback paths | Pi API changes; thinking level; streamFn resolution |
| `policy.ts` | Threshold/band math; checkpoint data; status snapshots | New threshold modes; band text; checkpoint schema |
| `usage.ts` | Native vs estimated usage lookup | Usage estimation changes |
| `prompts.ts` | Summary instruction building; focus block escaping | Summary prompt wording; focus block format |
| `classify.ts` | Content-density scoring; critical/contextual/ephemeral classification | Classification rules; density scoring |

### Shared infrastructure

| File | Ownership | Change-entrypoint for |
|---|---|---|
| `types.ts` | Shared types and frozen constants | New types; constant changes (also check `settings.ts`) |
| `state.ts` | `CompactionState` mutable container; guard helpers | New state fields; guard logic |
| `settings.ts` | Settings resolution; env/file/default; validation | New settings; default changes; validation rules |
| `persist.ts` | Telemetry persistence; symlink detection; schema versioning | Persistence format; security; new telemetry fields |
| `session-evidence.ts` | Message scanning; objective/blocker/file extraction | Extraction rules; scan windows; caps |
| `session-branch-view.ts` | Read-only Pi session branch projection | Branch entry handling; scan limits |
| `pi-messages.ts` | Message role checking; content block extraction; tool-call parsing | New message types; content block handling |
| `package-metadata.ts` | Package name/version/source-path resolution | Metadata format changes |

### `src/focus-echo/` — Focus echo subsystem

| File | Ownership | Change-entrypoint for |
|---|---|---|
| `index.ts` | Barrel re-exports | Adding new exports |
| `positioning.ts` | `reorderForPositioning` — main entry from context event | Insertion logic; dedup |
| `detection.ts` | `detectCompactionSummary` — signature matching | Detection signatures; fenced block stripping |
| `draft.ts` | `extractFocusEchoDraft` — raw section extraction | Section headings; extraction logic |
| `normalizer.ts` | `normalizeFocusEchoDraft` — delegates to rules | Normalization delegation |
| `model.ts` | `FocusEcho` type; field caps; `FOCUS_ECHO_MARKER` | Caps; marker text |
| `parser.ts` | `parseFocusEcho` — summary → FocusEcho | Parsing logic |
| `rendering.ts` | `buildFocusEchoBlock`, `buildPersistedFocusEcho`, `createEchoMessage` | Echo block format; framing text |
| `sanitization.ts` | `sanitizeEchoField`, `hasAdversarialPatterns` — security-critical | **Sanitization patterns (high-risk changes)** |
| `context-injection.ts` | `createFocusEchoContextMessage` — message creation | Injection strategy |
| `rules/types.ts` | `TextReplacementRule` type; `applyTextReplacementRules` | Rule application logic |
| `rules/shared.ts` | Shared normalization helpers | Shared cleanup logic |
| `rules/index.ts` | Barrel re-exports for rule modules | Adding new rule exports |
| `rules/objective-rules.ts` | Objective normalization | Objective cleanup rules |
| `rules/active-file-rules.ts` | Active files normalization | File path cleanup rules |
| `rules/blocker-rules.ts` | Blockers normalization (merges errors) | Blocker/error merge logic |
| `rules/decision-rules.ts` | Decisions normalization | Decision cleanup rules |
| `rules/dependency-rules.ts` | Dependency chain normalization | Dependency cleanup rules |
| `rules/next-step-rules.ts` | Next step normalization | Next-step cleanup rules |

### `src/tool-output-pruning/` — Tool-output pruning subsystem

| File | Ownership | Change-entrypoint for |
|---|---|---|
| `coordinator.ts` | `ToolOutputPruningCoordinator` — event-shaped facade | New lifecycle methods; query methods |
| `lifecycle.ts` | Flush lifecycle; atomicity; message-end detection | Flush logic; atomicity guards |
| `capture.ts` | Batch capture; eligibility; args preview; snippets | Capture rules; preview/snippet limits |
| `summarizer.ts` | LLM summarization via `completeSimple`; model resolution | Summarizer prompt; model resolution; thinking level |
| `summary-response-parser.ts` | JSON/markdown response parsing | Response format; parsing logic |
| `indexer.ts` | `indexToolResultsFromBranch` — reconcile with branch | Indexing logic |
| `pruner.ts` | `applyToolOutputPruning` — context stubbing | Stub format; matching logic |
| `recovery.ts` | `queryToolOutput` — bounded recovery query | Query logic; limits |
| `query-tool.ts` | `createQueryToolDefinition` — tool registration | Tool definition; parameters |
| `metadata.ts` | Durable metadata; reconstruction; validation | Metadata schema; reconstruction logic; limits |
| `record-identity.ts` | Eligibility; protected exclusions; branch matching | **Exclusion list (high-risk)**; matching logic |
| `state.ts` | `ToolOutputPruningState` — mutable sub-state | State fields; bounded add |
| `policy.ts` | `isToolOutputPruningEnabled` — 4-condition gate | **Enablement gate (high-risk)** |
| `commands.ts` | Status detail; manual flush | Status formatting |
| `summary-refs.ts` | Short ref generation | Ref format |
| `types.ts` | Pruning types; bounded limits | **Bounded limits (high-risk)** |
| `index.ts` | Barrel re-exports | Adding new exports |

## `test/` — Test files

| File | Tests | Source under test |
|---|---|---|
| `index.test.ts` | ~139 | `src/index.ts`, `policy.ts`, `settings.ts`, `focus-echo/*`, `prompts.ts`, `usage.ts` |
| `persist.test.ts` | — | `src/persist.ts` |
| `sdk-runtime-regression.test.ts` | — | Real Pi 0.84.4 SDK (`compaction-coordinator.ts`, `events.ts`, `usage.ts`, `focus-echo/*`) |
| `sdk-session-reload.test.ts` | — | `tool-output-pruning/coordinator.ts`, `metadata.ts`, `state.ts` via real Pi JSONL reload |
| `lifecycle.test.ts` | — | `src/lifecycle.ts` |
| `classify-extract.test.ts` | — | `src/classify.ts`, `src/session-evidence.ts` |
| `snapshot-evidence.test.ts` | — | `src/session-evidence.ts` |
| `session-branch-view.test.ts` | — | `src/session-branch-view.ts` |
| `pi-messages.test.ts` | — | `src/pi-messages.ts` |
| `package-metadata.test.ts` | — | `src/package-metadata.ts` |
| `extension-status.test.ts` | — | `src/extension-status.ts` |
| `release.test.ts` | — | `scripts/release.sh` |
| `focus-echo-goldens.test.ts` | 10 | `src/focus-echo/*` (end-to-end) |
| `focus-echo-normalizer-characterization.test.ts` | 2 | `src/focus-echo/normalizer.ts` |
| `focus-echo-normalization-rules.test.ts` | 2 | `src/focus-echo/rules/*` |
| `focus-echo-draft.test.ts` | — | `src/focus-echo/draft.ts` |
| `tool-output-pruning/*.test.ts` | 15 files | `src/tool-output-pruning/*` |
| `fixtures/extension.ts` | — | Mock helpers (`createMockCtx`, `createMockPi`) |
| `fixtures/focus-echo-goldens.ts` | — | Golden input/expected pairs |
| `fixtures/tool-output-pruning.ts` | — | Mock tool results and branch entries |

## `scripts/` — Build/release tooling

| File | Purpose |
|---|---|
| `verify.sh` | Full local verification (typecheck + test + build + custom checks) |
| `release-check.sh` | Pre-release validation (clean tree, verify, npm whoami, pack dry-run) |
| `release.sh` | Version bump + commit + tag + publish |
| `check-package-contents.js` | Fast package content sanity check |
| `live-custom-path-check.mjs` | Live custom path verification |

## `agent/` — Development plans

| Path | Purpose |
|---|---|
| `agent/plans/` | Architecture refactoring plans and characterization baselines |
| `agent/state/` | Agent state (not part of the published package) |

## `/.github/workflows/`

| File | Purpose |
|---|---|
| `pr-checks-node.yml` | CI: typecheck + test + build + lockfile check on PRs |

## Common change tasks — where to start

| Task | Start here | Also touch | Tests to run |
|---|---|---|---|
| Add a new `/compact-plus` subcommand | `src/commands.ts` | — | `test/index.test.ts` |
| Change auto-compaction threshold defaults | `src/settings.ts` (`DEFAULT_COMPACT_PLUS_SETTINGS`) | `src/types.ts` (legacy re-exports) | `test/index.test.ts` |
| Add a new auto-compaction guard | `src/compaction-coordinator.ts` (`maybeAutoCompact`) | — | `test/index.test.ts` |
| Change summary section headings | `src/prompts.ts` (`buildSummaryInstructions`) | `src/compact.ts` (`SECTION_BODY_LINE_LIMITS`), `src/focus-echo/detection.ts` (`SUMMARY_SIGNATURE_HEADINGS`), `src/focus-echo/draft.ts` (`FOCUS_ECHO_SECTION_HEADINGS`) | `test/index.test.ts`, `test/focus-echo-goldens.test.ts` |
| Add a new echo field | `src/focus-echo/model.ts`, `draft.ts`, `rules/`, `rendering.ts` | Golden fixtures | `test/focus-echo-goldens.test.ts` |
| Change sanitization patterns | `src/focus-echo/sanitization.ts` | — | `test/index.test.ts` (hasAdversarialPatterns tests) |
| Change pruning eligibility | `src/tool-output-pruning/record-identity.ts` | `src/tool-output-pruning/policy.ts` | `test/tool-output-pruning/capture.test.ts` |
| Change bounded limits | `src/tool-output-pruning/types.ts` | `src/tool-output-pruning/state.ts`, `metadata.ts` | `test/tool-output-pruning/state.test.ts` |
| Add a new setting | `src/settings.ts` | `src/types.ts` (if needed) | `test/index.test.ts` |
| Change telemetry persistence format | `src/persist.ts` (bump `PERSIST_VERSION`) | `src/types.ts` | `test/persist.test.ts` |
| Change CI checks | `.github/workflows/pr-checks-node.yml` | — | — |
