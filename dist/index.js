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
import { estimateTokens } from "@earendil-works/pi-coding-agent";
import { runCustomCompaction } from "./compact.js";
import { classifyMessages, extractCurrentFocus, extractDependencyChain, extractSessionSnapshot, extractTextContent, } from "./focus.js";
import { executeCompaction } from "./lifecycle.js";
import { loadTelemetry, saveTelemetry } from "./persist.js";
import { buildCheckpointData, buildStatusSnapshot, formatCheckpointSummary, formatStatusLines, getModeFromUsage, getUsageBandText, modelKey, } from "./policy.js";
import { buildBranchInstructions, buildCurrentFocusBlock, buildSummaryInstructions, } from "./prompts.js";
import { reorderForPositioning } from "./reorder.js";
import { CompactionState } from "./state.js";
import { CHECKPOINT_CANDIDATE_PERCENT, CHECKPOINT_CUSTOM_TYPE, CONTINUATION_PROMPT, COOLDOWN_MS, HARD_THRESHOLD_PERCENT, REGROWTH_TOKENS, STANDARD_THRESHOLD_PERCENT, } from "./types.js";
export { classifyMessages, extractCurrentFocus, };
const sourcePath = fileURLToPath(import.meta.url);
const packageRoot = path.resolve(path.dirname(sourcePath), "..");
let cachedPackageMetadata = null;
function getPackageMetadata() {
    if (cachedPackageMetadata) {
        return cachedPackageMetadata;
    }
    let name = "pi-compact-plus";
    let version = "0.1.0";
    try {
        const packageJsonPath = path.join(packageRoot, "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
        name = packageJson.name ?? name;
        version = packageJson.version ?? version;
    }
    catch {
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
// ── Extension ────────────────────────────────────────────────────────
export default function compactPlusExtension(pi) {
    // ── Commands ───────────────────────────────────────────────────────
    pi.registerCommand("compact-plus", {
        description: "Compact+ context compaction. Usage: /compact-plus [hard|status]",
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
            const mode = trimmed === "hard" ? "hard" : "standard";
            state.lastTriggerAuto = false;
            const cmdEntries = ctx.sessionManager.getBranch();
            const cmdMessages = cmdEntries
                .filter((e) => e.type === "message")
                .map((e) => e.message);
            const cmdFocus = extractCurrentFocus(cmdMessages);
            ctx.ui.notify(`📦 Compact+ ${mode} compaction triggered manually.`, "info");
            executeCompaction(mode, cmdFocus, state, ctx, pi);
        },
    });
    pi.registerCommand("checkpoint", {
        description: "Save a lightweight checkpoint. Usage: /checkpoint [note]",
        handler: async (args, ctx) => {
            const note = args.trim() || undefined;
            const entries = ctx.sessionManager.getBranch();
            const messages = entries
                .filter((e) => e.type === "message")
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
    function getEffectiveUsage(ctx) {
        const model = ctx.model;
        if (!model)
            return null;
        const contextWindow = model.contextWindow ?? 0;
        if (contextWindow <= 0)
            return null;
        const native = ctx.getContextUsage();
        if (native && native.tokens !== null && native.percent !== null) {
            return {
                percent: native.percent,
                tokens: native.tokens,
                contextWindow,
                source: "native",
            };
        }
        // Fallback: estimate from branch entries when getContextUsage() is blind
        // (e.g. after compaction before next valid assistant usage)
        const entries = ctx.sessionManager.getBranch();
        const messages = entries
            .filter((e) => e.type === "message")
            .map((e) => e.message);
        let estimated = 0;
        for (const msg of messages) {
            estimated += estimateTokens(msg);
        }
        const percent = (estimated / contextWindow) * 100;
        return {
            percent,
            tokens: estimated,
            contextWindow,
            source: "estimated",
        };
    }
    async function maybeAutoCompact(ctx, triggerSource, turnIndex) {
        const usage = getEffectiveUsage(ctx);
        const model = ctx.model;
        if (!usage || !model)
            return;
        const mode = getModeFromUsage(usage.percent);
        if (!mode || mode === "checkpoint")
            return;
        const now = Date.now();
        if (state.isOnCooldown(COOLDOWN_MS))
            return;
        if (state.isRegrowthBelowThreshold(usage.tokens, REGROWTH_TOKENS))
            return;
        if (state.isCompacting)
            return;
        // Prevent double-triggering within the same turn
        if (state.isSameTurn(turnIndex))
            return;
        state.selectedMode = mode;
        state.isCompacting = true;
        state.lastCompactTime = now;
        state.lastTriggerAuto = true;
        if (turnIndex !== undefined)
            state.lastCompactTurnIndex = turnIndex;
        const autoEntries = ctx.sessionManager.getBranch();
        const autoMessages = autoEntries
            .filter((e) => e.type === "message")
            .map((e) => e.message);
        const autoFocus = extractCurrentFocus(autoMessages);
        ctx.ui.notify(`📦 Compact+ auto-compaction triggered at ${usage.percent.toFixed(0)}% (${usage.tokens.toLocaleString()} / ${model.contextWindow.toLocaleString()} tokens) — mode: ${mode} (${triggerSource})`, "info");
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
        if (event.message.role !== "assistant")
            return;
        // Only check on assistant messages that have valid usage (not errors/aborts)
        const assistant = event.message;
        if (assistant.stopReason === "error" || assistant.stopReason === "aborted")
            return;
        if (!assistant.usage)
            return;
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
        const triggerSource = state.lastTriggerAuto
            ? event.preparation.isSplitTurn
                ? "message_end"
                : "turn_end"
            : "command";
        const triggerReason = state.lastTriggerAuto
            ? "auto at threshold"
            : `manual /compact-plus ${mode}`;
        const previousSummaryPresent = event.preparation.messagesToSummarize.some((m) => m.role === "assistant" &&
            extractTextContent(m).includes("Compaction Summary"));
        const attempt = await runCustomCompaction(event.preparation, mode, ctx, event.signal);
        const telemetryBase = {
            mode: mode === "standard" || mode === "hard" ? mode : "standard",
            triggerSource,
            triggerReason,
            timestamp: Date.now(),
            focusTags: focus.activeFiles.map((f) => f.split("/").pop() ?? f),
            previousSummaryPresent,
            splitTurn: event.preparation.isSplitTurn,
            usageSource: getEffectiveUsage(ctx)?.source ?? "unknown",
            messagesSummarizedCount: event.preparation.messagesToSummarize.length,
        };
        if (attempt.result) {
            state.lastCompaction = {
                ...telemetryBase,
                classifiedCounts: attempt.classifiedCounts,
            };
            state.lastFallbackReason = attempt.fallbackReason;
            await saveTelemetry({
                lastCompaction: state.lastCompaction,
                lastFallbackReason: state.lastFallbackReason,
                lastInjectedEcho: state.lastInjectedEcho,
                lastCompactTime: state.lastCompactTime,
                lastCompactTokens: state.lastCompactTokens,
            });
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
                    },
                },
            };
        }
        state.lastFallbackReason =
            attempt.fallbackReason ?? "custom summarization unavailable";
        state.lastCompaction = {
            ...telemetryBase,
            fallbackReason: state.lastFallbackReason,
        };
        await saveTelemetry({
            lastCompaction: state.lastCompaction,
            lastFallbackReason: state.lastFallbackReason,
            lastInjectedEcho: state.lastInjectedEcho,
            lastCompactTime: state.lastCompactTime,
            lastCompactTokens: state.lastCompactTokens,
        });
        if (ctx.hasUI) {
            ctx.ui.notify("Compact+ custom summarization unavailable; falling back to default compaction.", "warning");
        }
        return undefined;
    });
    // ── session_before_tree ────────────────────────────────────────────
    pi.on("session_before_tree", async (event, _ctx) => {
        const entries = event.preparation.entriesToSummarize;
        const messages = entries
            .filter((e) => e.type === "message")
            .map((e) => e.message);
        const focus = messages.length > 0 ? extractCurrentFocus(messages) : undefined;
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
            await saveTelemetry({
                lastCompaction: state.lastCompaction,
                lastFallbackReason: state.lastFallbackReason,
                lastInjectedEcho: state.lastInjectedEcho,
                lastCompactTime: state.lastCompactTime,
                lastCompactTokens: state.lastCompactTokens,
            });
            return { messages: result.messages };
        }
        return undefined;
    });
    // ── model_select reset ─────────────────────────────────────────────
    pi.on("model_select", async (event, _ctx) => {
        const key = modelKey(event.model);
        if (key)
            state.resetOnModelChange(key);
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
