import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type { CompactionCoordinator } from "./compaction-coordinator.js";
import { extractCurrentFocus } from "./focus.js";
import { loadTelemetryWithDiagnostics } from "./persist.js";
import { isSessionMessageEntry } from "./pi-messages.js";
import { buildBranchInstructions } from "./prompts.js";
import { reorderForPositioning } from "./reorder.js";
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
	pi.on("session_start", async (_event, _ctx) => {
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
	});

	pi.on("agent_start", async (_event, _ctx) => {
		toolOutputPruning.onAgentStart();
	});

	pi.on("turn_end", async (event, ctx) => {
		toolOutputPruning.onTurnEnd({
			message: event.message,
			toolResults: event.toolResults as AgentMessage[],
			turnIndex: event.turnIndex,
		});

		// Let message_end flush captured tool-output batches before auto-compaction.
		if (toolOutputPruning.hasPendingFlush()) return;

		await compactionCoordinator.maybeAutoCompact(
			ctx,
			"turn_end",
			event.turnIndex,
		);
	});

	pi.on("message_end", async (event, ctx) => {
		if (event.message.role !== "assistant") return;

		const assistant = event.message as Extract<
			typeof event.message,
			{ role: "assistant" }
		>;

		// Flush pending tool-output batches for a completed assistant response.
		await toolOutputPruning.onMessageEnd(event, ctx, pi, {
			isCompacting: state.isCompacting,
		});

		// Only auto-compact on assistant messages that have valid usage.
		if (!assistant.usage) return;
		await compactionCoordinator.maybeAutoCompact(ctx, "message_end");
	});

	pi.on("session_before_compact", async (event, ctx) => {
		return compactionCoordinator.onSessionBeforeCompact(event, ctx);
	});

	pi.on("session_compact", async (event, ctx) => {
		await compactionCoordinator.onSessionCompact(event, ctx);
	});

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

	pi.on("model_select", async (event, _ctx) => {
		compactionCoordinator.onModelSelect(event);
	});
}
