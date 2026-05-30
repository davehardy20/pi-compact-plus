import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	ExtensionContext,
	SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { isSessionMessageEntry } from "../pi-messages.js";
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
import {
	type ApplyPruningResult,
	applyToolOutputPruning,
	branchEntrySafelyMatchesToolOutputRecord,
	type ToolOutputBranchEntry,
} from "./pruner.js";
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
		getBranch: () => SessionEntry[];
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
		return this.state.pendingBatches.length > 0;
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

		return flushPendingBatches(
			this.state,
			settings,
			ctx,
			this.getBranchEntries(ctx as BranchProviderContext),
			pi,
		);
	}

	onSessionTree(ctx: BranchProviderContext): void {
		this.state.resetPending();
		const settings = this.getSettings();
		if (!isToolOutputPruningEnabled(settings)) {
			this.state.finalizedRecords = [];
			this.state.clearReconstructionResult();
			return;
		}

		const branch = ctx.sessionManager.getBranch();
		const branchEntries = this.getBranchEntriesFromBranch(branch);
		this.state.finalizedRecords = this.state.finalizedRecords.filter((record) =>
			branchEntries.some((entry) =>
				branchEntrySafelyMatchesToolOutputRecord(entry, record, settings),
			),
		);
		if (this.state.finalizedRecords.length === 0) {
			const result = reconstructToolOutputRecordsFromBranch(
				branch,
				branchEntries,
				settings,
			);
			this.state.recordReconstructionResult(result);
			if (result.ok) {
				this.state.finalizedRecords = result.records;
				this.state.advanceShortRefCounterFromRecords(result.records);
			} else {
				this.state.finalizedRecords = [];
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
		return applyToolOutputPruning(
			messages,
			this.getBranchEntries(ctx),
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
		return manualFlushPendingBatches({
			state: this.state,
			settings: this.getSettings(),
			ctx,
			branchEntries: this.getBranchEntries(ctx as BranchProviderContext),
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

		return queryToolOutput(
			params,
			this.state,
			settings,
			this.getBranchEntries(ctx),
		);
	}

	private getBranchEntries(
		ctx: BranchProviderContext,
	): ToolOutputBranchEntry[] {
		return this.getBranchEntriesFromBranch(ctx.sessionManager.getBranch());
	}

	private getBranchEntriesFromBranch(
		branch: SessionEntry[],
	): ToolOutputBranchEntry[] {
		return branch.filter(isSessionMessageEntry).map((entry) => ({
			type: entry.type,
			id: entry.id,
			message: entry.message,
		}));
	}
}
