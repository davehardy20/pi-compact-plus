import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createCurrentSessionBranchView,
	createSessionBranchView,
	type SessionBranchEntryLike,
} from "../session-branch-view.js";
import { TOOL_PRUNE_SUMMARY_CUSTOM_TYPE } from "../types.js";
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
import {
	MAX_RECONSTRUCTION_BRANCH_SCAN_ENTRIES,
	reconstructToolOutputRecordsFromBranch,
} from "./metadata.js";
import { isToolOutputPruningEnabled } from "./policy.js";
import { type ApplyPruningResult, applyToolOutputPruning } from "./pruner.js";
import { recordMatchesBranchEntry } from "./record-identity.js";
import { queryToolOutput } from "./recovery.js";
import type { ToolOutputPruningState } from "./state.js";
import type {
	QueryToolOutputParams,
	QueryToolOutputResult,
	ToolOutputPruningSettings,
	ToolOutputRecord,
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

function reconcileBranchRecords(
	persisted: ToolOutputRecord[],
	inMemory: ToolOutputRecord[],
	branchEntries: SessionBranchEntryLike[],
): ToolOutputRecord[] {
	const records = [...persisted];
	const persistedIndexById = new Map(
		records.map((record, index) => [record.recordId, index]),
	);
	const recordIds = new Set(records.map((record) => record.recordId));
	const entryIds = new Set(records.map((record) => record.entryId));
	const refs = new Set(records.map((record) => record.shortRef));
	for (const record of inMemory) {
		const persistedIndex = persistedIndexById.get(record.recordId);
		const matching =
			persistedIndex === undefined ? undefined : records[persistedIndex];
		if (
			persistedIndex !== undefined &&
			matching &&
			matching.entryId === record.entryId &&
			matching.toolCallId === record.toolCallId &&
			matching.toolName === record.toolName &&
			matching.shortRef === record.shortRef &&
			record.fallbackSnippets !== null
		) {
			// Only live memory keeps bounded original-output snippets. Preserve
			// that search affordance without writing snippets to durable metadata.
			records[persistedIndex] = {
				...matching,
				fallbackSnippets: record.fallbackSnippets,
			};
		}
		// Durable metadata wins on an identity collision. Legacy records have
		// no durable counterpart, but still represent valid live branch output.
		if (
			recordIds.has(record.recordId) ||
			entryIds.has(record.entryId) ||
			refs.has(record.shortRef)
		) {
			continue;
		}
		records.push(record);
		recordIds.add(record.recordId);
		entryIds.add(record.entryId);
		refs.add(record.shortRef);
	}
	// Retain the newest records if the combined index exceeds its state cap.
	const order = new Map(branchEntries.map((entry, index) => [entry.id, index]));
	return records.sort(
		(a, b) =>
			(order.get(a.entryId ?? "") ?? -1) - (order.get(b.entryId ?? "") ?? -1),
	);
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

	/** Reject an append if the resulting branch could not restore its index. */
	private guardedAppendEntry(
		ctx: BranchProviderContext,
		pi: AppendEntryPort,
		settings: ToolOutputPruningSettings,
	): AppendEntryPort {
		return {
			appendEntry: (customType, data) => {
				if (customType !== TOOL_PRUNE_SUMMARY_CUSTOM_TYPE) {
					throw new Error("unexpected pruning metadata entry type");
				}
				const entries = ctx.sessionManager.getBranch();
				if (entries.length >= MAX_RECONSTRUCTION_BRANCH_SCAN_ENTRIES) {
					throw new Error("pruning metadata branch scan limit reached");
				}
				// Simulate the append against a fresh branch: this enforces the
				// entry/byte limits, identity and duplicate rules atomically before
				// persistence. A failed flush rolls back its in-memory additions.
				const candidate = createSessionBranchView([
					...entries,
					{
						type: "custom",
						id: "compact-plus-pending-prune-summary",
						customType,
						data,
					},
				]);
				const result = reconstructToolOutputRecordsFromBranch(
					candidate,
					settings,
				);
				if (!result.ok) {
					throw new Error(`pruning metadata admission failed: ${result.error}`);
				}
				pi.appendEntry(customType, data);
			},
		};
	}

	/** Hydrate the active branch after the session state has been reset. */
	onSessionStart(ctx: BranchProviderContext): void {
		this.onSessionTree(ctx);
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
			this.guardedAppendEntry(ctx as BranchProviderContext, pi, settings),
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
		// Shared ancestors may survive a branch switch while branch-specific
		// records exist only in durable metadata. Validate the whole active branch
		// before exposing any records; a malformed entry invalidates all of them.
		const result = reconstructToolOutputRecordsFromBranch(view, settings);
		this.state.recordReconstructionResult(result);
		const records = result.ok
			? reconcileBranchRecords(
					result.records,
					currentBranchRecords,
					branchEntries,
				)
			: [];
		this.state.replaceFinalizedRecords(records);
		if (result.ok) {
			this.state.advanceShortRefCounterFromRecords(
				records,
				result.maxValidatedShortRefNumber,
			);
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
		const branchCtx = ctx as BranchProviderContext;
		const view = createCurrentSessionBranchView(branchCtx);
		const settings = this.getSettings();
		return manualFlushPendingBatches({
			state: this.state,
			settings,
			ctx,
			branchEntries: view.messageEntries(),
			pi: this.guardedAppendEntry(branchCtx, pi, settings),
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
