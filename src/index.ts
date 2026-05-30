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

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

import { runCustomCompaction } from "./compact.js";
import {
	type CompactionExecutionPath,
	resolveCompactionRuntimeCompatibility,
} from "./compatibility.js";
import { registerCompactPlusStatusCommand } from "./extension-status.js";
import {
	classifyMessages,
	extractCurrentFocus,
	extractDependencyChain,
	extractSessionSnapshot,
	extractTextContent,
} from "./focus.js";
import { executeCompaction } from "./lifecycle.js";
import { createPackageMetadataResolver } from "./package-metadata.js";
import {
	loadTelemetryWithDiagnostics,
	saveTelemetryWithDiagnostics,
} from "./persist.js";
import { isAssistantMessage, isSessionMessageEntry } from "./pi-messages.js";
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
import {
	buildPersistedFocusEcho,
	hasAdversarialPatterns,
	reorderForPositioning,
} from "./reorder.js";
import { resolveCompactPlusSettings } from "./settings.js";
import { CompactionState } from "./state.js";
import { formatPruningStatusLines } from "./tool-output-pruning/commands.js";
import { ToolOutputPruningCoordinator } from "./tool-output-pruning/coordinator.js";
import {
	formatToolOutputPruningStatusLine,
	isToolOutputPruningEnabled,
} from "./tool-output-pruning/policy.js";
import { createQueryToolDefinition } from "./tool-output-pruning/query-tool.js";
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

// ── State ────────────────────────────────────────────────────────────

const getPackageMetadata = createPackageMetadataResolver(import.meta.url);
const state = new CompactionState();
const toolOutputPruning = new ToolOutputPruningCoordinator({
	state: state.toolOutputPruning,
	getSettings: resolveCompactPlusSettings,
});

async function persistTelemetrySnapshot(): Promise<void> {
	const result = await saveTelemetryWithDiagnostics({
		lastCompaction: state.lastCompaction,
		lastFallbackReason: state.lastFallbackReason,
		lastInjectedEcho: state.lastInjectedEcho,
		lastCompactTime: state.lastCompactTime,
		lastCompactTokens: state.lastCompactTokens,
		lastModelKey: state.lastModelKey,
	});
	state.recordTelemetryPersistenceIssue(result.issue);
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
	// ── Register recovery query tool (inactive unless pruning enabled) ─

	pi.registerTool(
		createQueryToolDefinition({
			getState: () => state.toolOutputPruning,
			getSettings: () => resolveCompactPlusSettings(),
		}),
	);

	// ── Commands ───────────────────────────────────────────────────────

	pi.registerCommand("compact-plus", {
		description:
			"Compact+ context compaction. Usage: /compact-plus [hard|status|tool-prune status|tool-prune flush]",
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();

			// Handle tool-prune subcommands
			if (trimmed.startsWith("tool-prune ")) {
				const sub = trimmed.slice("tool-prune ".length).trim();

				if (sub === "status") {
					const detail = toolOutputPruning.buildStatusDetail();
					const lines = formatPruningStatusLines(detail);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				if (sub === "flush") {
					const result = await toolOutputPruning.manualFlush(ctx, pi);
					ctx.ui.notify(result.message, result.ok ? "info" : "warning");
					return;
				}

				ctx.ui.notify(
					"Usage: /compact-plus tool-prune [status|flush]",
					"warning",
				);
				return;
			}

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
					telemetryPersistenceIssues: state.telemetryPersistenceIssues,
				});
				const lines = formatStatusLines(status);
				const pruningSettings = resolveCompactPlusSettings();
				lines.push(
					formatToolOutputPruningStatusLine({
						enabled: isToolOutputPruningEnabled(pruningSettings),
						mode: pruningSettings.toolOutputPruningMode,
						strategy: pruningSettings.toolOutputPruneStrategy,
						activeRecordCount: state.toolOutputPruning.activeRecordCount,
						lastPrunedCount: state.toolOutputPruning.lastPrunedCount,
						lastSummaryStatus: state.toolOutputPruning.lastSummaryStatus,
						lastSummaryTime: state.toolOutputPruning.lastSummaryTime,
					}),
				);
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
				.filter(isSessionMessageEntry)
				.map((e) => e.message);
			const cmdFocus = extractCurrentFocus(cmdMessages);

			ctx.ui.notify(
				`📦 Compact+ ${mode} compaction triggered manually.`,
				"info",
			);

			executeCompaction(mode, cmdFocus, state, ctx, pi, {
				persist: persistTelemetrySnapshot,
			});
		},
	});

	pi.registerCommand("checkpoint", {
		description: "Save a lightweight checkpoint. Usage: /checkpoint [note]",
		handler: async (args, ctx) => {
			const note = args.trim() || undefined;
			const entries = ctx.sessionManager.getBranch();
			const messages = entries
				.filter(isSessionMessageEntry)
				.map((e) => e.message);
			const snapshot = extractSessionSnapshot(messages);
			const data = buildCheckpointData(note, snapshot);
			pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, data);
			ctx.ui.notify(formatCheckpointSummary(data), "info");
		},
	});

	registerCompactPlusStatusCommand(pi, {
		getMetadata: getPackageMetadata,
		getStatusState: () => ({
			isCompacting: state.isCompacting,
			selectedMode: state.selectedMode,
			lastCompactTime: state.lastCompactTime,
			echoInjected: state.echoInjected,
			lastModelKey: state.lastModelKey,
		}),
		getPruningLine: () => {
			const pruningSettings = resolveCompactPlusSettings();
			return formatToolOutputPruningStatusLine({
				enabled: isToolOutputPruningEnabled(pruningSettings),
				mode: pruningSettings.toolOutputPruningMode,
				strategy: pruningSettings.toolOutputPruneStrategy,
				activeRecordCount: state.toolOutputPruning.activeRecordCount,
				lastPrunedCount: state.toolOutputPruning.lastPrunedCount,
				lastSummaryStatus: state.toolOutputPruning.lastSummaryStatus,
				lastSummaryTime: state.toolOutputPruning.lastSummaryTime,
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
			.filter(isSessionMessageEntry)
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

		// Prevent competing with an in-flight tool-output pruning flush
		if (state.toolOutputPruning.isFlushing) return;

		// Prevent double-triggering within the same turn
		if (state.isSameTurn(turnIndex)) return;

		state.selectedMode = mode;
		state.isCompacting = true;
		state.lastCompactTime = now;
		state.lastTriggerAuto = true;
		if (turnIndex !== undefined) state.lastCompactTurnIndex = turnIndex;

		const autoEntries = ctx.sessionManager.getBranch();
		const autoMessages = autoEntries
			.filter(isSessionMessageEntry)
			.map((e) => e.message);
		const autoFocus = extractCurrentFocus(autoMessages);

		ctx.ui.notify(
			`📦 Compact+ auto-compaction triggered at ${usage.percent.toFixed(0)}% (${usage.tokens.toLocaleString()} / ${model.contextWindow.toLocaleString()} tokens) — mode: ${mode} (${triggerSource})`,
			"info",
		);

		executeCompaction(mode, autoFocus, state, ctx, pi, {
			sendContinuation: true,
			persist: persistTelemetrySnapshot,
		});
	}

	// ── session_start: load persisted telemetry ───────────────────────

	pi.on("session_start", async (_event, _ctx) => {
		const result = await loadTelemetryWithDiagnostics();
		state.recordTelemetryPersistenceIssue(result.issue);
		const persisted = result.telemetry;
		if (persisted) {
			state.lastCompactTime = persisted.lastCompactTime;
			state.lastCompactTokens = persisted.lastCompactTokens;
			state.lastCompaction = persisted.lastCompaction;
			state.lastFallbackReason = persisted.lastFallbackReason;
			state.lastInjectedEcho = persisted.lastInjectedEcho;
			state.lastModelKey = persisted.lastModelKey;
		}
		// Runtime tool-output indexes are branch/session-scoped and are not yet
		// persisted; clear them at session boundaries to avoid stale status or
		// recovery matches in long-lived extension instances.
		state.toolOutputPruning.reset();
	});

	// ── agent_start: reset pending tool-output captures ───────────────

	pi.on("agent_start", async (_event, _ctx) => {
		toolOutputPruning.onAgentStart();
	});

	// ── turn_end: capture eligible tool results into pending batches ───

	pi.on("turn_end", async (event, ctx) => {
		toolOutputPruning.onTurnEnd({
			message: event.message,
			toolResults: event.toolResults as AgentMessage[],
			turnIndex: event.turnIndex,
		});
		await maybeAutoCompact(ctx, "turn_end", event.turnIndex);
	});

	// ── message_end: auto-compact + flush pending tool-output batches ─

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const assistant = event.message as Extract<
			typeof event.message,
			{ role: "assistant" }
		>;

		// Flush pending tool-output batches for a completed assistant response
		await toolOutputPruning.onMessageEnd(event, ctx, pi, {
			isCompacting: state.isCompacting,
		});

		// Only auto-compact on assistant messages that have valid usage
		if (!assistant.usage) return;
		await maybeAutoCompact(ctx, "message_end");
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
				isAssistantMessage(m) &&
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
		state.lastInjectedEcho =
			executionPath === "custom" &&
			typeof event.compactionEntry.summary === "string"
				? buildPersistedFocusEcho(event.compactionEntry.summary)
				: null;
		state.echoInjected = false;
		state.clearPendingCompaction();
		const postUsage = _ctx.getContextUsage();
		if (postUsage && typeof postUsage.tokens === "number") {
			state.lastCompactTokens = postUsage.tokens;
		}
		await persistTelemetrySnapshot();
	});

	// ── session_before_tree ────────────────────────────────────────────

	pi.on("session_before_tree", async (event, _ctx) => {
		const entries = event.preparation.entriesToSummarize;
		const messages = entries
			.filter(isSessionMessageEntry)
			.map((e) => e.message);
		const focus =
			messages.length > 0 ? extractCurrentFocus(messages) : undefined;

		return {
			customInstructions: buildBranchInstructions(focus),
			replaceInstructions: true,
		};
	});

	// ── session_tree: reconcile finalized records with new branch ─────

	pi.on("session_tree", async (_event, ctx) => {
		toolOutputPruning.onSessionTree(ctx);
	});

	// ── session_shutdown: clear runtime tool-output state ────────────────

	pi.on("session_shutdown", async (_event, _ctx) => {
		toolOutputPruning.onSessionShutdown();
	});

	// ── Position-aware reordering (focus echo) + tool-output pruning ──

	pi.on("context", async (event, ctx) => {
		const pruningResult = toolOutputPruning.transformContext(
			event.messages,
			ctx,
		);
		const messagesAfterPruning = pruningResult?.messages ?? event.messages;

		// Then apply focus echo reordering
		const reorderResult = reorderForPositioning(
			messagesAfterPruning,
			state.echoInjected,
		);

		if (reorderResult) {
			state.lastInjectedEcho = reorderResult.echoText;
			state.echoInjected = true;
			await persistTelemetrySnapshot();
			return { messages: reorderResult.messages };
		}

		if (pruningResult) {
			return { messages: pruningResult.messages };
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
	getLastInjectedEcho: () => state.lastInjectedEcho,
	getTelemetryPersistenceIssues: () => state.telemetryPersistenceIssues,
	getToolOutputPruningState: () => state.toolOutputPruning,
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
	hasAdversarialPatterns,
	isToolOutputPruningEnabled,
};
