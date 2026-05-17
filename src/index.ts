/**
 * Compact+ — Advanced context compaction for Pi.
 *
 * Features:
 *   - Mode-aware compaction triggers (checkpoint candidate, standard, hard)
 *   - Structured summaries with current-focus extraction
 *   - Content classification and lightweight checkpoints
 *   - Position-aware focus echo for "lost in the middle" mitigation
 *
 * Commands:
 *   /compact-plus          — manual standard compaction
 *   /compact-plus hard     — manual hard compaction
 *   /compact-plus status   — show usage, mode, cooldown state
 *   /checkpoint [note]     — persist a checkpoint without compacting
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  ExtensionAPI,
  SessionMessageEntry,
} from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

import { runCustomCompaction } from "./compact.js";
import {
  type CompactionExecutionPath,
  resolveCompactionRuntimeCompatibility,
} from "./compatibility.js";
import {
  classifyMessages,
  extractCurrentFocus,
  extractDependencyChain,
  extractSessionSnapshot,
  extractTextContent,
} from "./focus.js";
import { executeCompaction } from "./lifecycle.js";
import { loadTelemetry, saveTelemetry } from "./persist.js";
import {
  buildCheckpointData,
  buildStatusSnapshot,
  formatCheckpointSummary,
  formatStatusLines,
  getModeFromUsage,
  getUsageBandText,
  modelKey,
} from "./policy.js";
import {
  buildBranchInstructions,
  buildCurrentFocusBlock,
  buildSummaryInstructions,
} from "./prompts.js";
import { reorderForPositioning } from "./reorder.js";
import { CompactionState } from "./state.js";
import {
  CHECKPOINT_CANDIDATE_PERCENT,
  CHECKPOINT_CUSTOM_TYPE,
  CONTINUATION_PROMPT,
  COOLDOWN_MS,
  type CompactionTelemetry,
  type EffectiveUsage,
  HARD_THRESHOLD_PERCENT,
  REGROWTH_TOKENS,
  STANDARD_THRESHOLD_PERCENT,
  type SummaryInstructionOptions,
  type TriggerSource,
} from "./types.js";

export {
  classifyMessages,
  type EffectiveUsage,
  extractCurrentFocus,
  type SummaryInstructionOptions,
};

// ── Package metadata ────────────────────────────────────────────────

interface PackageMetadata {
  name: string;
  version: string;
  packageRoot: string;
  sourcePath: string;
}

const sourcePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(sourcePath), "..");
let cachedPackageMetadata: PackageMetadata | null = null;

function getPackageMetadata(): PackageMetadata {
  if (cachedPackageMetadata) {
    return cachedPackageMetadata;
  }

  let name = "pi-compact-plus";
  let version = "0.1.0";

  try {
    const packageJsonPath = path.join(packageRoot, "package.json");
    const packageJson = JSON.parse(
      fs.readFileSync(packageJsonPath, "utf8"),
    ) as {
      name?: string;
      version?: string;
    };
    name = packageJson.name ?? name;
    version = packageJson.version ?? version;
  } catch {
    // Best-effort metadata only.
  }

  cachedPackageMetadata = {
    name,
    version,
    packageRoot,
    sourcePath,
  };
  return cachedPackageMetadata;
}

// ── State ────────────────────────────────────────────────────────────

const state = new CompactionState();

async function persistTelemetrySnapshot(): Promise<void> {
  await saveTelemetry({
    lastCompaction: state.lastCompaction,
    lastFallbackReason: state.lastFallbackReason,
    lastInjectedEcho: state.lastInjectedEcho,
    lastCompactTime: state.lastCompactTime,
    lastCompactTokens: state.lastCompactTokens,
  });
}

function parseTelemetryTimestamp(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return Date.now();
}

function coerceStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter(
    (item): item is string => typeof item === "string",
  );
  return strings.length > 0 ? strings : undefined;
}

// ── Extension ────────────────────────────────────────────────────────

export default function compactPlusExtension(pi: ExtensionAPI) {
  // ── Commands ───────────────────────────────────────────────────────

  pi.registerCommand("compact-plus", {
    description:
      "Compact+ context compaction. Usage: /compact-plus [hard|status]",
    handler: async (args, ctx) => {
      const trimmed = args.trim().toLowerCase();
      if (trimmed === "status") {
        const usage = getEffectiveUsage(ctx);
        const status = buildStatusSnapshot({
          usage,
          selectedMode: state.selectedMode,
          isCompacting: state.isCompacting,
          lastCompactTime: state.lastCompactTime,
          lastCompaction: state.lastCompaction,
          lastFallbackReason: state.lastFallbackReason,
          lastInjectedEcho: state.lastInjectedEcho,
        });
        const lines = formatStatusLines(status);
        ctx.ui.notify(lines.join("\n"), "info");
        return;
      }

      if (state.isCompacting) {
        ctx.ui.notify("📦 A compaction is already in progress.", "warning");
        return;
      }

      const mode =
        trimmed === "hard" ? ("hard" as const) : ("standard" as const);
      state.lastTriggerAuto = false;

      const cmdEntries = ctx.sessionManager.getBranch();
      const cmdMessages = cmdEntries
        .filter((e): e is SessionMessageEntry => e.type === "message")
        .map((e) => e.message);
      const cmdFocus = extractCurrentFocus(cmdMessages);

      ctx.ui.notify(
        `📦 Compact+ ${mode} compaction triggered manually.`,
        "info",
      );

      executeCompaction(mode, cmdFocus, state, ctx, pi);
    },
  });

  pi.registerCommand("checkpoint", {
    description: "Save a lightweight checkpoint. Usage: /checkpoint [note]",
    handler: async (args, ctx) => {
      const note = args.trim() || undefined;
      const entries = ctx.sessionManager.getBranch();
      const messages = entries
        .filter((e): e is SessionMessageEntry => e.type === "message")
        .map((e) => e.message);
      const snapshot = extractSessionSnapshot(messages);
      const data = buildCheckpointData(note, snapshot);
      pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, data);
      ctx.ui.notify(formatCheckpointSummary(data), "info");
    },
  });

  pi.registerCommand("compact-plus-status", {
    description: "Show Compact+ package status and debug info",
    handler: async (_args, _ctx) => {
      const metadata = getPackageMetadata();
      pi.sendMessage({
        customType: "compact-plus-status",
        content: [
          `${metadata.name} v${metadata.version}`,
          `source: ${metadata.sourcePath}`,
          `packageRoot: ${metadata.packageRoot}`,
          `compacting: ${state.isCompacting}`,
          `selectedMode: ${state.selectedMode ?? "none"}`,
          `lastCompactTime: ${state.lastCompactTime ? new Date(state.lastCompactTime).toISOString() : "never"}`,
          `echoInjected: ${state.echoInjected}`,
          `lastModelKey: ${state.lastModelKey ?? "none"}`,
        ].join("\n"),
        details: {
          packageName: metadata.name,
          version: metadata.version,
          sourcePath: metadata.sourcePath,
          packageRoot: metadata.packageRoot,
          isCompacting: state.isCompacting,
          selectedMode: state.selectedMode,
          lastCompactTime: state.lastCompactTime,
          echoInjected: state.echoInjected,
        },
        display: true,
      });
    },
  });

  // ── Shared auto-compact logic ──────────────────────────────────────

  function getEffectiveUsage(
    ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  ): EffectiveUsage | null {
    const model = ctx.model;
    if (!model) return null;
    const contextWindow = model.contextWindow ?? 0;
    if (contextWindow <= 0) return null;

    const native = ctx.getContextUsage();
    if (native) {
      return {
        percent: native.percent,
        tokens: native.tokens,
        contextWindow,
        source: "native",
      };
    }

    // Fallback: estimate from branch entries only when Pi does not expose
    // context usage at all. Do not estimate after compaction when Pi
    // intentionally reports unknown usage until the next assistant response.
    const entries = ctx.sessionManager.getBranch();
    const messages = entries
      .filter((e): e is SessionMessageEntry => e.type === "message")
      .map((e) => e.message);
    let estimated = 0;
    for (const msg of messages) {
      estimated += estimateTokens(msg as AgentMessage);
    }
    const percent = (estimated / contextWindow) * 100;
    return {
      percent,
      tokens: estimated,
      contextWindow,
      source: "estimated",
    };
  }

  async function maybeAutoCompact(
    ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
    triggerSource: string,
    turnIndex?: number,
  ) {
    const usage = getEffectiveUsage(ctx);
    const model = ctx.model;
    if (!usage || !model) return;

    if (usage.percent === null || usage.tokens === null) return;

    const mode = getModeFromUsage(usage.percent);
    if (!mode || mode === "checkpoint") return;

    const now = Date.now();
    if (state.isOnCooldown(COOLDOWN_MS)) return;

    if (state.isRegrowthBelowThreshold(usage.tokens, REGROWTH_TOKENS)) return;

    if (state.isCompacting) return;

    // Prevent double-triggering within the same turn
    if (state.isSameTurn(turnIndex)) return;

    state.selectedMode = mode;
    state.isCompacting = true;
    state.lastCompactTime = now;
    state.lastTriggerAuto = true;
    if (turnIndex !== undefined) state.lastCompactTurnIndex = turnIndex;

    const autoEntries = ctx.sessionManager.getBranch();
    const autoMessages = autoEntries
      .filter((e): e is SessionMessageEntry => e.type === "message")
      .map((e) => e.message);
    const autoFocus = extractCurrentFocus(autoMessages);

    ctx.ui.notify(
      `📦 Compact+ auto-compaction triggered at ${usage.percent.toFixed(0)}% (${usage.tokens.toLocaleString()} / ${model.contextWindow.toLocaleString()} tokens) — mode: ${mode} (${triggerSource})`,
      "info",
    );

    executeCompaction(mode, autoFocus, state, ctx, pi, {
      sendContinuation: true,
    });
  }

  // ── session_start: load persisted telemetry ───────────────────────

  pi.on("session_start", async (_event, _ctx) => {
    const persisted = await loadTelemetry();
    if (persisted) {
      state.lastCompactTime = persisted.lastCompactTime;
      state.lastCompactTokens = persisted.lastCompactTokens;
      state.lastCompaction = persisted.lastCompaction;
      state.lastFallbackReason = persisted.lastFallbackReason;
      state.lastInjectedEcho = persisted.lastInjectedEcho;
    }
  });

  // ── Auto-trigger on assistant message_end (catches mid-turn growth) ─

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    // Only check on assistant messages that have valid usage (not errors/aborts)
    const assistant = event.message as Extract<
      typeof event.message,
      { role: "assistant" }
    >;
    if (assistant.stopReason === "error" || assistant.stopReason === "aborted")
      return;
    if (!assistant.usage) return;
    await maybeAutoCompact(ctx, "message_end");
  });

  // ── Auto-trigger on turn_end (fallback / final check) ──────────────

  pi.on("turn_end", async (event, ctx) => {
    await maybeAutoCompact(ctx, "turn_end", event.turnIndex);
  });

  // ── session_before_compact ─────────────────────────────────────────

  pi.on("session_before_compact", async (event, ctx) => {
    const mode = state.selectedMode;

    if (!mode) {
      return;
    }

    const focusMessages = event.preparation.isSplitTurn
      ? [
          ...event.preparation.messagesToSummarize,
          ...event.preparation.turnPrefixMessages,
        ]
      : event.preparation.messagesToSummarize;
    const focus = extractCurrentFocus(focusMessages);
    const usage = getEffectiveUsage(ctx);
    const compatibility = resolveCompactionRuntimeCompatibility({
      event,
      branchEntries: event.branchEntries,
    });

    const triggerSource: TriggerSource = state.lastTriggerAuto
      ? event.preparation.isSplitTurn
        ? "message_end"
        : "turn_end"
      : "command";
    const triggerReason = state.lastTriggerAuto
      ? "auto at threshold"
      : `manual /compact-plus ${mode}`;
    const previousSummaryPresent = event.preparation.messagesToSummarize.some(
      (m) =>
        m.role === "assistant" &&
        extractTextContent(m).includes("Compaction Summary"),
    );

    const telemetryBase: CompactionTelemetry = {
      mode: mode === "standard" || mode === "hard" ? mode : "standard",
      triggerSource,
      triggerReason,
      timestamp: Date.now(),
      focusTags: focus.activeFiles.map((f) => f.split("/").pop() ?? f),
      previousSummaryPresent,
      splitTurn: event.preparation.isSplitTurn,
      usageSource: usage?.source ?? "unknown",
      messagesSummarizedCount: event.preparation.messagesToSummarize.length,
      usagePercentAtTrigger: usage?.percent ?? undefined,
      usageTokensAtTrigger: usage?.tokens ?? undefined,
      executionPath: compatibility.executionPath,
      fromExtension: compatibility.executionPath === "custom",
      thinkingLevel: compatibility.thinkingLevel ?? null,
      compatibilityReason: compatibility.reason,
    };

    if (compatibility.executionPath === "native-fallback") {
      state.pendingCompaction = {
        ...telemetryBase,
        executionPath: "native-fallback",
        fromExtension: false,
        fallbackReason: compatibility.reason ?? undefined,
      };
      state.lastFallbackReason = compatibility.reason;
      await persistTelemetrySnapshot();

      if (ctx.hasUI) {
        ctx.ui.notify(
          "Compact+ is deferring to native Pi compaction to preserve stream-aware routing.",
          "warning",
        );
      }

      return undefined;
    }

    const attempt = await runCustomCompaction(
      event.preparation,
      mode,
      ctx,
      compatibility,
      event.signal,
    );

    if (attempt.result) {
      state.pendingCompaction = {
        ...telemetryBase,
        classifiedCounts: attempt.classifiedCounts,
        fallbackReason: attempt.fallbackReason ?? undefined,
      };
      state.lastFallbackReason = attempt.fallbackReason;
      await persistTelemetrySnapshot();

      return {
        compaction: {
          ...attempt.result,
          details: {
            ...(typeof attempt.result.details === "object" &&
            attempt.result.details !== null
              ? attempt.result.details
              : {}),
            mode,
            triggerReason,
            auto: state.lastTriggerAuto,
            timestamp: telemetryBase.timestamp,
            focusTags: telemetryBase.focusTags,
            executionPath: telemetryBase.executionPath,
            thinkingLevel: telemetryBase.thinkingLevel,
            compatibilityReason: telemetryBase.compatibilityReason,
          },
        },
      };
    }

    state.lastFallbackReason =
      attempt.fallbackReason ?? "custom summarization unavailable";
    state.pendingCompaction = {
      ...telemetryBase,
      executionPath: "native-fallback",
      fromExtension: false,
      fallbackReason: state.lastFallbackReason,
      compatibilityReason:
        telemetryBase.compatibilityReason ?? state.lastFallbackReason,
    };
    await persistTelemetrySnapshot();

    if (ctx.hasUI) {
      ctx.ui.notify(
        "Compact+ custom summarization unavailable; falling back to default compaction.",
        "warning",
      );
    }

    return undefined;
  });

  pi.on("session_compact", async (event, _ctx) => {
    const pending = state.pendingCompaction;
    if (!pending) {
      return;
    }

    const details =
      typeof event.compactionEntry.details === "object" &&
      event.compactionEntry.details !== null
        ? (event.compactionEntry.details as Record<string, unknown>)
        : {};
    const executionPath: CompactionExecutionPath = event.fromExtension
      ? pending.executionPath
      : "native-fallback";
    const fallbackReason =
      typeof details.fallbackReason === "string"
        ? details.fallbackReason
        : pending.fallbackReason;

    state.lastCompaction = {
      ...pending,
      mode: details.mode === "hard" ? "hard" : pending.mode,
      triggerReason:
        typeof details.triggerReason === "string"
          ? details.triggerReason
          : pending.triggerReason,
      timestamp: parseTelemetryTimestamp(
        details.timestamp ?? event.compactionEntry.timestamp,
      ),
      focusTags: coerceStringArray(details.focusTags) ?? pending.focusTags,
      executionPath,
      fromExtension: event.fromExtension,
      fallbackReason,
      thinkingLevel:
        typeof details.thinkingLevel === "string"
          ? details.thinkingLevel
          : (pending.thinkingLevel ?? null),
      compatibilityReason:
        typeof details.compatibilityReason === "string"
          ? details.compatibilityReason
          : (pending.compatibilityReason ?? null),
    };
    state.lastFallbackReason = fallbackReason ?? null;
    state.lastCompactTime = state.lastCompaction.timestamp;
    state.clearPendingCompaction();
    await persistTelemetrySnapshot();
  });

  // ── session_before_tree ────────────────────────────────────────────

  pi.on("session_before_tree", async (event, _ctx) => {
    const entries = event.preparation.entriesToSummarize;
    const messages = entries
      .filter((e): e is SessionMessageEntry => e.type === "message")
      .map((e) => e.message);
    const focus =
      messages.length > 0 ? extractCurrentFocus(messages) : undefined;

    return {
      customInstructions: buildBranchInstructions(focus),
      replaceInstructions: true,
    };
  });

  // ── Position-aware reordering (focus echo) ──────────────────────

  pi.on("context", async (event) => {
    const result = reorderForPositioning(event.messages, state.echoInjected);
    if (result) {
      state.lastInjectedEcho = result.echoText;
      state.echoInjected = true;
      await persistTelemetrySnapshot();
      return { messages: result.messages };
    }
    return undefined;
  });

  // ── model_select reset ─────────────────────────────────────────────

  pi.on("model_select", async (event, _ctx) => {
    const key = modelKey(event.model);
    if (key) state.resetOnModelChange(key);
  });
}

// ── Test exports ─────────────────────────────────────────────────────

export const __test__ = {
  resetState: () => state.reset(),
  getSelectedMode: () => state.selectedMode,
  getLastCompactTime: () => state.lastCompactTime,
  getIsCompacting: () => state.isCompacting,
  getLastTriggerAuto: () => state.lastTriggerAuto,
  getLastCompactTokens: () => state.lastCompactTokens,
  getLastModelKey: () => state.lastModelKey,
  getLastCompaction: () => state.lastCompaction,
  getLastFallbackReason: () => state.lastFallbackReason,
  CHECKPOINT_CANDIDATE_PERCENT,
  STANDARD_THRESHOLD_PERCENT,
  HARD_THRESHOLD_PERCENT,
  COOLDOWN_MS,
  REGROWTH_TOKENS,
  CONTINUATION_PROMPT,
  CHECKPOINT_CUSTOM_TYPE,
  getModeFromUsage,
  getUsageBandText,
  modelKey,
  extractDependencyChain,
  buildCurrentFocusBlock,
  buildSummaryInstructions,
  buildBranchInstructions,
  buildCheckpointData,
};
