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
| `/compact-plus-status` | Show package identity, version, and source path |
| `/checkpoint [note]` | Save a lightweight checkpoint without compacting |

### Auto-compaction triggers

Compact+ replaces Pi's single-threshold early-compaction trigger with a tiered policy:

| Band | Usage | Behavior |
| --- | --- | --- |
| Normal | < 75% | No auto-compaction |
| Checkpoint candidate | 75–79% | Eligible for checkpoint (no auto-compact) |
| Standard | 80–89% | Auto standard compaction |
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

### Features

- **Content classification**: Messages are classified as critical, contextual, or ephemeral for hard-mode pruning.
- **Tool pair restoration**: Tool call/result pairs are kept atomic after pruning.
- **Summary normalization**: Compaction summaries are normalized and validated before injection.
- **Session persistence**: Telemetry state is persisted across sessions.
- **Model change reset**: State resets when the model changes.

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

Compact+ supports these environment variables for threshold tuning:

| Variable | Default | Description |
| --- | --- | --- |
| `COMPACT_PLUS_STANDARD_THRESHOLD` | 80 | Percentage threshold for standard compaction |
| `COMPACT_PLUS_HARD_THRESHOLD` | 90 | Percentage threshold for hard compaction |
| `COMPACT_PLUS_COOLDOWN_MS` | 120000 | Cooldown between auto-compactions (ms) |

## Notes

- Compact+ hooks into Pi's `session_before_compact` event to provide custom summarization.
- On Pi runtimes that support stream-aware compaction but do not expose the
  live session `streamFn` to extensions, Compact+ uses the public
  `@earendil-works/pi-ai` `streamSimple` adapter so custom summaries can still
  run.
- If custom summarization still fails after that, Compact+ falls back to Pi's default compaction.
- The extension persists telemetry to `~/.pi/agent/state/compact-plus-telemetry.json`.
- State resets when the model changes to avoid stale compaction context from a different model.

## Troubleshooting

Run `/compact-plus-status` to confirm:

- package name and version
- loaded source path
- package root
- current compaction state

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
