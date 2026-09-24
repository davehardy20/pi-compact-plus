import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CompactionCoordinator } from "./compaction-coordinator.js";
import { reorderForPositioning } from "./focus-echo/index.js";
import { loadTelemetryWithDiagnostics } from "./persist.js";
import { buildBranchInstructions } from "./prompts.js";
import { createSessionBranchView } from "./session-branch-view.js";
import { extractCurrentFocusFromBranch } from "./session-evidence.js";
import type { CompactionState } from "./state.js";
import type { ToolOutputPruningCoordinator } from "./tool-output-pruning/coordinator.js";

export interface CompactPlusEventRegistryOptions {
	state: CompactionState;
	toolOutputPruning: ToolOutputPruningCoordinator;
	compactionCoordinator: CompactionCoordinator;
	persistTelemetrySnapshot: () => Promise<void>;
}

export function registerCompactPlusEventHandlers(
	pi: ExtensionAPI,
	{
		state,
		toolOutputPruning,
		compactionCoordinator,
		persistTelemetrySnapshot,
	}: CompactPlusEventRegistryOptions,
): void {
	pi.on("session_start", async (_event, ctx) => {
		const result = await loadTelemetryWithDiagnostics();
		state.reset();
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
		toolOutputPruning.onSessionStart(ctx);
	});

	pi.on("agent_start", async (_event, _ctx) => {
		// Pi restarts turnIndex at zero for every run. Scope the same-turn
		// suppression to this run, not the entire session.
		state.lastCompactTurnIndex = -1;
		toolOutputPruning.onAgentStart();
	});

	pi.on("turn_end", async (event, _ctx) => {
		toolOutputPruning.onTurnEnd({
			message: event.message,
			toolResults: event.toolResults as AgentMessage[],
			turnIndex: event.turnIndex,
		});

		// turn_end follows tool execution, but the agent may still have another
		// turn. Only the final successful assistant turn is eligible at idle.
		state.pendingAutoCompactTurnIndex =
			event.message.role === "assistant" && event.message.stopReason === "stop"
				? event.turnIndex
				: null;
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		// Flush pending tool-output batches for a completed assistant response.
		await toolOutputPruning.onMessageEnd(event, ctx, pi, {
			isCompacting: state.isCompacting,
		});
	});

	pi.on("agent_settled", async (_event, ctx) => {
		// Pi emits this only after the run's tools, retries, and queued messages
		// have settled. Never call ctx.compact() inside message_end/turn_end: it
		// aborts the active run and can discard or replay tool results.
		const turnIndex = state.pendingAutoCompactTurnIndex;
		state.pendingAutoCompactTurnIndex = null;
		if (turnIndex === null || !ctx.isIdle() || ctx.hasPendingMessages()) return;
		if (toolOutputPruning.hasPendingFlush()) return;
		await compactionCoordinator.maybeAutoCompact(ctx, "turn_end", turnIndex);
	});

	pi.on("session_before_compact", async (event, ctx) => {
		// A manual or native compaction supersedes any queued auto candidate.
		state.pendingAutoCompactTurnIndex = null;
		return compactionCoordinator.onSessionBeforeCompact(event, ctx);
	});

	pi.on("session_compact", async (event, ctx) => {
		state.pendingAutoCompactTurnIndex = null;
		await compactionCoordinator.onSessionCompact(event, ctx);
	});

	pi.on("session_before_tree", async (event, _ctx) => {
		const branchView = createSessionBranchView(
			event.preparation.entriesToSummarize,
		);
		const focus =
			branchView.messages().length > 0
				? extractCurrentFocusFromBranch(branchView)
				: undefined;

		return {
			customInstructions: buildBranchInstructions(focus),
			replaceInstructions: true,
		};
	});

	pi.on("session_tree", async (_event, ctx) => {
		toolOutputPruning.onSessionTree(ctx);
	});

	pi.on("session_shutdown", async (_event, _ctx) => {
		toolOutputPruning.onSessionShutdown();
	});

	pi.on("context", async (event, ctx) => {
		const pruningResult = toolOutputPruning.transformContext(
			event.messages,
			ctx,
		);
		const messagesAfterPruning = pruningResult?.messages ?? event.messages;

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

	pi.on("model_select", async (event, ctx) => {
		const previousModelKey = state.lastModelKey;
		compactionCoordinator.onModelSelect(event);
		// Only a change from a known model resets model-scoped pruning state.
		// Recover the branch before the next context transform or query.
		if (previousModelKey !== null && state.lastModelKey !== previousModelKey) {
			toolOutputPruning.onSessionTree(ctx);
		}
	});
}
