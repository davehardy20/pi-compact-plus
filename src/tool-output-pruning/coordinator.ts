import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createCurrentSessionBranchView,
	type SessionBranchEntryLike,
} from "../session-branch-view.js";
import type { CaptureBatchResult } from "./capture.js";
import {
	buildPruningStatusDetail,
	manualFlushPendingBatches,
	type PruningStatusDetail,
} from "./commands.js";
import {
	captureTurnEndBatch,
	type FlushResult,
	flushPendingBatches,
	isFinalAssistantMessageForToolPrune,
	shouldFlushOnMessageEnd,
} from "./lifecycle.js";
import { reconstructToolOutputRecordsFromBranch } from "./metadata.js";
import { isToolOutputPruningEnabled } from "./policy.js";
import { type ApplyPruningResult, applyToolOutputPruning } from "./pruner.js";
import { recordMatchesBranchEntry } from "./record-identity.js";
import { queryToolOutput } from "./recovery.js";
import type { ToolOutputPruningState } from "./state.js";
import type {
	QueryToolOutputParams,
	QueryToolOutputResult,
	ToolOutputPruningSettings,
} from "./types.js";

export interface ToolOutputPruningCoordinatorDependencies {
	state: ToolOutputPruningState;
	getSettings: () => ToolOutputPruningSettings;
	now?: () => number;
}

export interface TurnEndPruningEvent {
	message: AgentMessage;
	toolResults: AgentMessage[];
	turnIndex: number;
}

export interface MessageEndPruningEvent {
	message: AgentMessage;
}

export interface MessageEndPruningOptions {
	isCompacting: boolean;
}

export interface BranchProviderContext {
	sessionManager: {
		getBranch: () => readonly SessionBranchEntryLike[];
	};
}

interface AppendEntryPort {
	appendEntry: (customType: string, data?: unknown) => void;
}

/**
 * Event-shaped facade for Compact+ tool-output pruning orchestration.
 *
 * Keeps Pi lifecycle/command/query sequencing local to the pruning module while
 * preserving the existing helper modules and their safety contract.
 */
export class ToolOutputPruningCoordinator {
	private readonly state: ToolOutputPruningState;
	private readonly getSettings: () => ToolOutputPruningSettings;
	private readonly now: () => number;

	constructor(deps: ToolOutputPruningCoordinatorDependencies) {
		this.state = deps.state;
		this.getSettings = deps.getSettings;
		this.now = deps.now ?? Date.now;
	}

	onAgentStart(): void {
		this.state.resetPending();
	}

	onTurnEnd(event: TurnEndPruningEvent): CaptureBatchResult | null {
		return captureTurnEndBatch(
			event.message,
			event.toolResults,
			event.turnIndex,
			this.now(),
			this.getSettings(),
			this.state,
		);
	}

	hasPendingFlush(): boolean {
		return this.state.hasPending();
	}

	async onMessageEnd(
		event: MessageEndPruningEvent,
		ctx: ExtensionContext,
		pi: AppendEntryPort,
		options: MessageEndPruningOptions,
	): Promise<FlushResult | null> {
		const settings = this.getSettings();
		if (
			!isFinalAssistantMessageForToolPrune(event.message) ||
			!shouldFlushOnMessageEnd(this.state, settings, options.isCompacting)
		) {
			return null;
		}

		const view = createCurrentSessionBranchView(ctx as BranchProviderContext);
		return flushPendingBatches(
			this.state,
			settings,
			ctx,
			view.messageEntries(),
			pi,
		);
	}

	onSessionTree(ctx: BranchProviderContext): void {
		this.state.resetPending();
		const settings = this.getSettings();
		if (!isToolOutputPruningEnabled(settings)) {
			this.state.replaceFinalizedRecords([]);
			this.state.clearReconstructionResult();
			return;
		}

		const view = createCurrentSessionBranchView(ctx);
		const branchEntries = view.messageEntries();
		const currentBranchRecords = this.state
			.finalizedSnapshot()
			.filter((record) =>
				branchEntries.some((entry) =>
					recordMatchesBranchEntry(entry, record, settings),
				),
			);
		this.state.replaceFinalizedRecords(currentBranchRecords);
		if (currentBranchRecords.length === 0) {
			const result = reconstructToolOutputRecordsFromBranch(view, settings);
			this.state.recordReconstructionResult(result);
			this.state.replaceFinalizedRecords(result.ok ? result.records : []);
			if (result.ok) {
				this.state.advanceShortRefCounterFromRecords(result.records);
			}
		}
	}

	onSessionShutdown(): void {
		this.state.reset();
	}

	transformContext(
		messages: AgentMessage[],
		ctx: BranchProviderContext,
	): ApplyPruningResult | undefined {
		const view = createCurrentSessionBranchView(ctx);
		return applyToolOutputPruning(
			messages,
			view.messageEntries(),
			this.state,
			this.getSettings(),
		);
	}

	buildStatusDetail(): PruningStatusDetail {
		return buildPruningStatusDetail({
			state: this.state,
			settings: this.getSettings(),
		});
	}

	async manualFlush(
		ctx: ExtensionContext,
		pi: AppendEntryPort,
	): Promise<FlushResult & { message: string }> {
		const view = createCurrentSessionBranchView(ctx as BranchProviderContext);
		return manualFlushPendingBatches({
			state: this.state,
			settings: this.getSettings(),
			ctx,
			branchEntries: view.messageEntries(),
			pi,
		});
	}

	query(
		params: QueryToolOutputParams,
		ctx: BranchProviderContext,
	): QueryToolOutputResult {
		const settings = this.getSettings();
		if (!isToolOutputPruningEnabled(settings)) {
			throw new Error(
				"compact_plus_query_tool_output is inactive because tool-output pruning is not enabled.",
			);
		}

		const view = createCurrentSessionBranchView(ctx);
		return queryToolOutput(params, this.state, settings, view.messageEntries());
	}
}
