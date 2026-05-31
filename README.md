# @davehardy20/pi-compact-plus

Advanced context compaction for [Pi](https://pi.dev) with mode-aware triggers,
structured summaries, current-focus extraction, content classification, and
lightweight checkpoints.

## What it adds

### Commands

| Command | Description |
| --- | --- |
| `/compact-plus` | Manual standard compaction |
| `/compact-plus hard` | Manual hard compaction (aggressive pruning) |
| `/compact-plus status` | Show usage, mode, cooldown state, and last compaction telemetry |
| `/compact-plus tool-prune status` | Show detailed tool-output pruning status |
| `/compact-plus tool-prune flush` | Manually flush pending tool-output batches |
| `/compact-plus-status` | Show package identity, version, and source path |
| `/checkpoint [note]` | Save a lightweight checkpoint without compacting |

### Auto-compaction triggers

Compact+ replaces Pi's single-threshold early-compaction trigger with a tiered policy:

| Band | Usage | Behavior |
| --- | --- | --- |
| Normal | < 65% | No auto-compaction |
| Checkpoint candidate | 65–69% | Eligible for checkpoint (no auto-compact) |
| Standard | 70–89% | Auto standard compaction |
| Hard | ≥ 90% | Auto hard compaction (aggressive pruning) |

Auto-compaction is triggered at `message_end` and `turn_end` with cooldown and regrowth guards to avoid thrashing.

### Structured summaries

Compact+ produces structured compaction summaries with these sections:

- Current Objective
- Current Task State
- Active File Set
- Repository State
- Decisions Made
- Completed Work
- Open Problems
- Current Errors
- Known Constraints
- Failed Attempts
- Next Best Step
- Continuity Instruction
- Dependency Chain

### Focus echo

After compaction, a compact "focus echo" is injected at the recency position
(before the last user message) to mitigate "lost in the middle" degradation.
The echo contains the objective, active files, blockers, decisions,
dependency chain, and next step.

Compact+ currently injects the echo as a synthetic user-context message because
Pi extension custom messages serialize to provider `user` messages, and the
`context` hook does not yet expose a provider-preserved lower-authority memory
role. The echo is therefore explicitly framed as generated, non-authoritative
memory and sanitized so it cannot masquerade as a fresh user request. Revisit
this fallback if Pi exposes a context/memory role that remains below user,
developer, and system authority across supported providers.

### Experimental tool-output pruning

Compact+ includes an experimental, default-off tool-output pruning subsystem.
It is inspired by the MIT-licensed `pi-context-prune` project and reuses or
adapts selected `pi-context-prune` ideas and implementation patterns where they
fit Compact+'s architecture.

When enabled, Compact+:

1. Captures eligible tool results after each assistant turn.
2. Summarizes them with an LLM call after the final assistant message.
3. Replaces the original text content with compact recovery stubs in future
   model context.
4. Persists bounded metadata-only summary entries for branch-safe recovery
   reconstruction after reloads.
5. Preserves recovery through a built-in query tool
   (`compact_plus_query_tool_output`).

**Safety defaults:**

- Off by default; requires explicit enablement.
- Only the safe `agent-message` mode is implemented. Summarization happens
  after the agent's final text response.
- Only text-only tool results are eligible; images, binaries, and mixed content
  are skipped.
- Protected exclusions are non-overridable: `read`, `read_hashed`,
  `hashline_edit`, `compact_plus_query_tool_output`, and Compact+ internal
  tools are never eligible, even if user include/exclude settings change.
- User excluded/included tool settings only apply after protected exclusions.
- Original `toolResult` messages are preserved in the session branch. Pruning
  only affects future context snapshots by stubbing content, not deleting
  messages.
- Durable pruning metadata never stores original tool output. It stores bounded
  record ids, entry ids, tool call ids, tool names, summaries, argument
  previews, and counters needed to reconstruct the runtime index safely.
- Capture, pending/finalized state, metadata reconstruction, summarizer inputs,
  query scanning, and query output are bounded with hard internal limits so long
  sessions degrade by trimming/skipping instead of growing without bound.
- Summarization is atomic: a flushed batch is indexed/pruned only when every
  pending record has a non-empty summary tied to its short ref.
- Metadata reconstruction is atomic: malformed active-version metadata,
  over-limit payloads, duplicates, excluded tools, stale branch entries, or
  mismatched `entryId`/`toolCallId`/tool-name pairs reconstruct no records.

**Attribution and reuse:** Batch capture, LLM semantic summarization, short
refs, branch-aware indexing, and recovery-query behavior were adapted from
`pi-context-prune` (MIT). Compact+ does not copy the standalone extension wiring;
it integrates the reused/adapted pieces into Compact+ settings, state,
telemetry/status, lifecycle hooks, and context composition. Source files that
closely follow or adapt `pi-context-prune` mechanics include attribution comments.

### Features

- **Content classification**: Messages are classified as critical, contextual, or ephemeral for hard-mode pruning.
- **Tool pair restoration**: Tool call/result pairs are kept atomic after pruning.
- **Summary normalization**: Compaction summaries are normalized and validated before injection.
- **Session persistence**: Telemetry state is persisted across sessions.
- **Model change reset**: State resets when the model changes.
- **Tool-output pruning** (experimental): LLM-summarized tool output stubs with recovery query tool.

## Install

From npm:

```bash
pi install npm:@davehardy20/pi-compact-plus
```

From git:

```bash
pi install git:github.com/davehardy20/pi-compact-plus
```

From a local checkout during development:

```bash
pi install /Users/dave/tools/pi-compact-plus
```

For one run only:

```bash
pi -e /Users/dave/tools/pi-compact-plus
```

## Settings

Compact+ supports threshold tuning through either environment variables or your
Pi agent `settings.json` file at `~/.pi/agent/settings.json`. Environment
variables take precedence over `settings.json` values.

Default profile: checkpoint candidate at `65%`, standard compaction at `70%`,
hard compaction at `90%`.

| Variable | Default | Description |
| --- | --- | --- |
| `COMPACT_PLUS_CHECKPOINT_THRESHOLD` | 65 | Checkpoint-candidate threshold |
| `COMPACT_PLUS_STANDARD_THRESHOLD` | 70 | Standard compaction threshold |
| `COMPACT_PLUS_HARD_THRESHOLD` | 90 | Hard compaction threshold |
| `COMPACT_PLUS_COOLDOWN_MS` | 120000 | Auto-compaction cooldown in ms |
| `COMPACT_PLUS_SETTINGS_PATH` | `~/.pi/agent/settings.json` | Optional JSON config path |
| `COMPACT_PLUS_EXPERIMENTAL_TOOL_OUTPUT_PRUNING` | `false` | Enable experimental tool-output pruning |
| `COMPACT_PLUS_TOOL_OUTPUT_PRUNING_MODE` | `off` | Pruning mode (`off` or `agent-message`) |
| `COMPACT_PLUS_TOOL_OUTPUT_SUMMARY_STRATEGY` | `llm` | Summary strategy (`llm` only for v1) |
| `COMPACT_PLUS_TOOL_OUTPUT_PRUNE_STRATEGY` | `stub` | Prune strategy (`stub` or `delete`; v1 uses `stub`) |
| `COMPACT_PLUS_TOOL_OUTPUT_PRUNE_MIN_CHARS` | (default) | Minimum tool output chars to be eligible |
| `COMPACT_PLUS_TOOL_OUTPUT_SUMMARY_MAX_CHARS` | (default) | Max chars per LLM summary |
| `COMPACT_PLUS_TOOL_OUTPUT_QUERY_MAX_CHARS` | (default) | Max chars returned by recovery query |
| `COMPACT_PLUS_TOOL_OUTPUT_SUMMARIZER_MODEL` | `default` | Summarizer model (`default` or `provider/model-id`) |
| `COMPACT_PLUS_TOOL_OUTPUT_SUMMARIZER_THINKING` | `low` | Thinking level; see notes below |
| `COMPACT_PLUS_TOOL_OUTPUT_PRUNE_EXCLUDED_TOOLS` | (comma list) | Additional user exclusions |
| `COMPACT_PLUS_TOOL_OUTPUT_PRUNE_INCLUDED_TOOLS` | (comma list) | User include allow-list |

Tool-output pruning notes:

- Summarizer thinking values: `default`, `off`, `minimal`, `low`, `medium`,
  `high`, or `xhigh`.
- User exclusions add tools to skip; protected exclusions still apply.
- User includes are evaluated after protected exclusions; empty means all
  eligible tools.

Example `settings.json`:

```json
{
  "thresholds": {
    "checkpoint": 65,
    "standard": 70,
    "hard": 90
  },
  "cooldownMs": 120000,
  "experimentalToolOutputPruning": true,
  "toolOutputPruningMode": "agent-message",
  "toolOutputSummaryStrategy": "llm",
  "toolOutputPruneStrategy": "stub"
}
```

Top-level keys are also supported: `checkpointThresholdPercent`,
`standardThresholdPercent`, `hardThresholdPercent`, and `cooldownMs`. Invalid,
missing, or overlapping thresholds fall back safely to the default `65 / 70 / 90`
threshold profile.

## Notes

- Compact+ hooks into Pi's `session_before_compact` event to provide custom summarization.
- On Pi runtimes that support stream-aware compaction but do not expose the
  live session `streamFn` to extensions, Compact+ uses the public
  `@earendil-works/pi-ai` `streamSimple` adapter so custom summaries can still
  run.
- If custom summarization still fails after that, Compact+ falls back to Pi's default compaction.
- The extension persists telemetry to `~/.pi/agent/state/compact-plus-telemetry.json`.
- State resets when the model changes to avoid stale compaction context from a different model.

### Tool-output pruning recovery

V1 appends `compact-plus-tool-prune-summary` entries for summary visibility,
observability, and metadata-only reconstruction. Legacy top-level fields
(`timestamp`, `refs`, `summaryChars`, `recordCount`) remain for status/history
compatibility. Newer entries also include a nested schema-versioned metadata
payload that is used only after it is validated against the current active
branch.

On reload or branch-tree updates, Compact+ reconstructs finalized pruning
records only when pruning is effectively enabled and metadata matches current
branch tool-result entries by `entryId`, `toolCallId`, tool name, tool-result
role, and text-only content. Older summary entries without metadata are skipped
safely. Active-version metadata that is malformed, oversized, duplicated,
excluded by protected/user policy, or stale fails closed and reconstructs no
records.

Compact+ always registers a recovery query tool so recovery stubs can point to
an available tool, but execution remains inactive and throws unless pruning is
effectively enabled:

- **Name:** `compact_plus_query_tool_output`
- **Parameters:** `query`, `recordId`, `ref`, `toolCallId`, `toolName`,
  `limit`, `includeContent`

Use this tool to recover original output by short ref or search terms. Query
results are bounded by record count, scanned record count, per-record original
text scan chars, total original text scan chars, and max returned chars. Full
content recovery requires `includeContent=true` and is limited by
`toolOutputQueryMaxChars` plus hard internal scan/result-size caps. Even after
metadata reconstruction, original content is read only from the current branch's
existing tool-result messages; it is not read from persisted metadata.

**Caveats:**

- LLM summarization adds latency and token cost per batch.
- Summaries may omit details; always verify against original output before
  relying on exact text, line numbers, diagnostics, or hashes.
- Stubbed content is labeled as historical data, not instructions, to reduce
  prompt-injection risk from captured tool output.
- Branch navigation (e.g., switching to a different session branch) removes
  stale index records automatically. Metadata from stale branches is rejected
  during reconstruction.
- Sub-agents currently run with `--no-extensions` and do not inherit pruning behavior.

## Troubleshooting

Run `/compact-plus-status` to confirm:

- package name and version
- loaded source path
- package root
- current compaction state
- a one-line tool-output pruning status when the experimental feature is enabled

Run `/compact-plus status` for detailed runtime state:

- current usage percent, tokens, and context window
- usage source (native or estimated)
- current band and thresholds
- when Pi has not produced a post-compaction assistant usage yet, status will
  show usage as unknown instead of estimating from the pre-compaction branch
- cooldown state
- last compaction telemetry including mode, trigger source, path, thinking
  level, compatibility notes, fallback reason, and focus files
- the latest persisted focus echo derived from the most recent custom
  compaction summary
- a one-line tool-output pruning status when the experimental feature is enabled

Run `/compact-plus tool-prune status` for detailed pruning state:

- enabled/mode/strategy
- indexed record count in the current branch
- pending batch/record counts
- whether a flush is in progress
- last summary status and time
- last metadata reconstruction status, scanned counts, skipped legacy entries,
  and a bounded non-sensitive error note when reconstruction fails
- protected exclusions plus user excluded/included tools
- summarizer model and thinking level

If commands appear twice, Pi may be loading both the package and the old local
extension. Disable or remove the old local auto-discovered extension before
reload verification.

## Update flow

1. Update the package repo
2. Push to GitHub
3. Run `pi update --extensions` or reinstall the package
4. Run `/reload`

`/reload` alone does not fetch newer package commits.

## Build and test

```bash
npm run typecheck
npm run build
npm test
```
