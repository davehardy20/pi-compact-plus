import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	BoundaryResult,
	CompactionResult,
	ExtensionAPI,
	ExtensionCommandContext,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	TurnEndEvent,
} from "@earendil-works/pi-coding-agent";

import { prepareBoundaryCompaction } from "./boundary-preparation.js";
import { runCustomCompaction } from "./compact.js";
import { extractTriggerFocus } from "./compaction-intent.js";
import {
	type CompactionExecutionPath,
	resolveCompactionRuntimeCompatibility,
} from "./compatibility.js";
import { buildPersistedFocusEcho } from "./focus-echo/index.js";
import { type ExtensionEventContext, executeCompaction } from "./lifecycle.js";
import { isAssistantMessage } from "./pi-messages.js";
import { getModeFromEffectiveUsage, modelKey } from "./policy.js";
import { extractTextContent } from "./session-evidence.js";
import { currentProjectedMessages } from "./session-projection.js";
import type { CompactPlusThresholdSettings } from "./settings.js";
import type { CompactionState } from "./state.js";
import {
	SUMMARIZATION_CONTEXT_OVERFLOW_REASON,
	SUMMARIZATION_OUTPUT_CAP_REASON,
} from "./summarization-overflow.js";
import { measureSummaryRequestTokens } from "./summarization-request-budget.js";
import {
	type CompactionMode,
	type CompactionTelemetry,
	type EffectiveUsage,
	REGROWTH_TOKENS,
	type TriggerSource,
} from "./types.js";

const INTENT_OVERFLOW_WARNING =
	"Compact+ intent evidence exceeds the available safety budget; compaction cancelled to avoid losing retained user instructions. Save the current objective before attempting a different compaction path.";

const SUMMARIZATION_OVERFLOW_WARNING =
	"Compact+ cancelled compaction: the summarization request itself cannot fit the model context window. Native Pi compaction was skipped because it would send the same oversized transcript.";

const SUMMARIZATION_OUTPUT_CAP_WARNING =
	"Compact+ cancelled compaction: the summarization request left no room for the summary output. Native Pi compaction was skipped because it would repeat the same failed request.";

const NATIVE_SUMMARIZATION_OVERFLOW_WARNING =
	"Compact+ cancelled native Pi compaction: the summarization request cannot fit the model context window. Save the current objective, then start a fresh session or reduce the retained context.";

type ManualCompactionMode = Extract<CompactionMode, "standard" | "hard">;
type AutoTriggerSource = Extract<TriggerSource, "turn_end" | "message_end">;
type ModelSelectEventLike = {
	model: { provider: string; id: string } | undefined;
};
type SessionBeforeCompactResultLike = {
	cancel?: boolean;
	compaction?: CompactionResult;
};

export interface CompactionCoordinatorOptions {
	state: CompactionState;
	pi: ExtensionAPI;
	thresholdSettings: CompactPlusThresholdSettings;
	getEffectiveUsage: (ctx: ExtensionEventContext) => EffectiveUsage | null;
	persistTelemetrySnapshot: () => void | Promise<void>;
	/** Kill switch: skip all auto-compaction (manual /compact-plus still works). */
	disableAutoCompaction?: boolean;
}

export class CompactionCoordinator {
	private readonly state: CompactionState;
	private readonly pi: ExtensionAPI;
	private readonly thresholdSettings: CompactPlusThresholdSettings;
	private readonly getEffectiveUsage: (
		ctx: ExtensionEventContext,
	) => EffectiveUsage | null;
	private readonly persistTelemetrySnapshot: () => void | Promise<void>;
	private readonly disableAutoCompaction: boolean;
	/** Measured verdict for the last cut. Written only by the measurement. */
	private overflowVerdict: { key: string; reason: string | null } | null = null;
	/** Cut already warned about, so an oversized session is warned once. */
	private overflowNoticeKey: string | null = null;
	/** Epoch of an attempt started by a manual command, which always explains itself. */
	private manualAttemptEpoch: number | null = null;

	constructor({
		state,
		pi,
		thresholdSettings,
		getEffectiveUsage,
		persistTelemetrySnapshot,
		disableAutoCompaction = false,
	}: CompactionCoordinatorOptions) {
		this.state = state;
		this.pi = pi;
		this.thresholdSettings = thresholdSettings;
		this.getEffectiveUsage = getEffectiveUsage;
		this.persistTelemetrySnapshot = persistTelemetrySnapshot;
		this.disableAutoCompaction = disableAutoCompaction;
	}

	private cancelAbortedCompaction(): { cancel: true } {
		this.state.selectedMode = null;
		this.state.isCompacting = false;
		this.state.lastTriggerAuto = false;
		this.state.clearPendingCompaction();
		this.state.lastFallbackReason = "compaction aborted";
		return { cancel: true };
	}

	/**
	 * Measure each request Pi would send and return the stable overflow reason when
	 * one cannot fit. Pure: no state or UI effects, so each call site owns its
	 * consequences. The verdict is cached per unchanged cut so a permanently
	 * oversized session is not re-serialized every attempt.
	 */
	private async detectSummarizationRequestOverflow(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionEventContext,
	): Promise<string | null> {
		const model = ctx.model;
		const preparation = event.preparation;
		const reserve = preparation?.settings?.reserveTokens;
		if (
			!model ||
			this.thresholdSettings.guardNativeCompaction === false ||
			!Number.isSafeInteger(reserve) ||
			(reserve as number) <= 0
		) {
			return null;
		}
		// Fail-open fast path before serializing: the cut is a subset of the live
		// session, so while Pi reports the whole session fitting inside
		// `contextWindow - reserveTokens` the guard is skipped. Sound only while
		// prompt + custom instructions stay under the remaining
		// `0.2 * reserveTokens`; it can skip the guard, never add a cancel.
		const usage = this.getEffectiveUsage(ctx);
		if (
			Number.isSafeInteger(usage?.tokens) &&
			(usage?.tokens ?? 0) > 0 &&
			(usage?.tokens ?? 0) + (reserve as number) <= model.contextWindow
		) {
			return null;
		}
		// Build the key only once a measurement is about to run: it walks the cut.
		const key = this.summarizationCutKey(event, ctx);
		if (this.overflowVerdict?.key === key) return this.overflowVerdict.reason;
		// Pi issues one request per preparation slice. On a split turn the prefix
		// request carries no custom instructions or previous summary and reserves
		// floor(0.5 * reserveTokens), matching Pi's budget for that request. Pi's
		// prefix prompt template is not reproduced, so that measurement is approximate.
		const requests: {
			messages: AgentMessage[];
			output?: number;
			wrapper: boolean;
		}[] = [];
		const history = preparation.messagesToSummarize ?? [];
		if (history.length > 0) requests.push({ messages: history, wrapper: true });
		const prefix = preparation.turnPrefixMessages ?? [];
		if (preparation.isSplitTurn && prefix.length > 0) {
			requests.push({
				messages: prefix,
				output: Math.min(
					Math.floor(0.5 * (reserve as number)),
					model.maxTokens > 0 ? model.maxTokens : Number.POSITIVE_INFINITY,
				),
				wrapper: false,
			});
		}
		const customInstructions =
			typeof event.customInstructions === "string"
				? event.customInstructions
				: undefined;
		const signal = event.signal ?? ctx.signal;
		let reason: string | null = null;
		for (const request of requests) {
			const measurement = await measureSummaryRequestTokens({
				messages: request.messages,
				model,
				reserveTokens: reserve,
				reservedOutputTokens: request.output,
				customInstructions: request.wrapper ? customInstructions : undefined,
				previousSummary: request.wrapper
					? preparation.previousSummary
					: undefined,
				signal,
			});
			// Fail open when a request cannot be measured: a missing measurement
			// must not silently disable compaction altogether.
			if (measurement && measurement.totalTokens > model.contextWindow) {
				reason = SUMMARIZATION_CONTEXT_OVERFLOW_REASON;
				break;
			}
		}
		this.overflowVerdict = { key, reason };
		return reason;
	}

	/** Content discriminator: message counts alone let an in-place shrink reuse a
	 * stale verdict. Cheap character totals only; never logged or persisted. */
	private cutContentChars(
		preparation: SessionBeforeCompactEvent["preparation"],
	): number {
		let chars = 0;
		for (const list of [
			preparation?.messagesToSummarize ?? [],
			preparation?.turnPrefixMessages ?? [],
		]) {
			for (const message of list) {
				const content = (message as { content?: unknown }).content;
				if (typeof content === "string") {
					chars += content.length;
					continue;
				}
				if (!Array.isArray(content)) continue;
				for (const part of content) {
					const text = (part as { text?: unknown })?.text;
					if (typeof text === "string") {
						chars += text.length;
						continue;
					}
					// Non-text parts (tool calls, images) still change the payload.
					try {
						chars += JSON.stringify(part)?.length ?? 0;
					} catch {
						chars += 1;
					}
				}
			}
		}
		return chars;
	}

	private summarizationCutKey(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionEventContext,
	): string {
		const preparation = event.preparation;
		const instructions =
			typeof event.customInstructions === "string"
				? event.customInstructions
				: "";
		// Length alone would treat two guidance strings of the same size as the same
		// cut. Internal key: never logged or persisted.
		return [
			ctx.sessionManager.getSessionId(),
			ctx.sessionManager.getLeafId(),
			modelKey(ctx.model),
			preparation?.messagesToSummarize?.length ?? 0,
			preparation?.turnPrefixMessages?.length ?? 0,
			this.cutContentChars(preparation),
			preparation?.isSplitTurn ? "split" : "single",
			instructions.length,
			instructions.slice(0, 32),
			instructions.slice(-32),
		].join(":");
	}

	/** Record the decline, and warn at most once for an unchanged cut. */
	private reportSummarizationOverflow(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionEventContext,
		reason: string,
		warning: string,
	): void {
		this.state.lastFallbackReason = reason;
		this.state.lastOverflowReportedEpoch = this.state.currentCompactionEpoch;
		if (!ctx.hasUI) return;
		const key = this.summarizationCutKey(event, ctx);
		// A manual command always deserves the explanation. Only automatic repeats
		// of an unchanged cut are deduped.
		if (
			this.manualAttemptEpoch !== this.state.currentCompactionEpoch &&
			this.overflowNoticeKey === key
		) {
			return;
		}
		this.overflowNoticeKey = key;
		ctx.ui.notify(warning, "warning");
	}

	private async guardNativeSummarizationRequest(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionEventContext,
	): Promise<SessionBeforeCompactResultLike | undefined> {
		const reason = await this.detectSummarizationRequestOverflow(event, ctx);
		if (!reason) return undefined;
		this.reportSummarizationOverflow(
			event,
			ctx,
			reason,
			NATIVE_SUMMARIZATION_OVERFLOW_WARNING,
		);
		return { cancel: true };
	}

	async handleManualCommand(
		mode: ManualCompactionMode,
		ctx: ExtensionEventContext,
	): Promise<void> {
		if (this.state.isCompacting) {
			ctx.ui.notify("📦 A compaction is already in progress.", "warning");
			return;
		}

		const epoch = this.state.currentCompactionEpoch;
		const commandContext = ctx as ExtensionEventContext &
			Partial<Pick<ExtensionCommandContext, "waitForIdle">>;
		await commandContext.waitForIdle?.();
		if (this.state.currentCompactionEpoch !== epoch) return;
		if (this.state.isCompacting) return;
		if (typeof ctx.isIdle !== "function" || !ctx.isIdle()) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Compact+ is waiting for an idle session; retry after the current run.",
					"warning",
				);
			}
			return;
		}
		this.state.lastTriggerAuto = false;

		const cmdFocus = extractTriggerFocus(currentProjectedMessages(ctx));

		ctx.ui.notify(`📦 Compact+ ${mode} compaction triggered manually.`, "info");

		this.manualAttemptEpoch = this.state.currentCompactionEpoch;
		executeCompaction(mode, cmdFocus, this.state, ctx, this.pi, {
			persist: this.persistTelemetrySnapshot,
		});
	}

	/**
	 * Ephemeral headless children (e.g. the /pr-review reviewer child runs as
	 * `pi --mode json -p --no-session`, which can report mode "json",
	 * "print", or "rpc") gain nothing from auto-compaction: there is no
	 * long-lived conversation to preserve, and compacting can replace the
	 * session mid-review. Manual commands are still allowed.
	 */
	private isEphemeralHeadlessChild(ctx: ExtensionEventContext): boolean {
		const headless =
			ctx.mode === "json" || ctx.mode === "print" || ctx.mode === "rpc";
		return headless && !ctx.sessionManager.getSessionFile();
	}

	async maybeAutoCompact(
		ctx: ExtensionEventContext,
		triggerSource: AutoTriggerSource,
		turnIndex?: number,
	): Promise<void> {
		if (this.disableAutoCompaction) return;
		if (this.isEphemeralHeadlessChild(ctx)) return;

		const usage = this.getEffectiveUsage(ctx);
		const model = ctx.model;
		if (!usage || !model) return;

		// Token-aware thresholds mean a single usage metric can be enough: percent
		// mode needs percent, tokens mode needs tokens, and effective_cap can
		// trigger from either band. Only bail when no metric is available at all;
		// the selected-mode check below handles mode/metric mismatches.
		if (usage.percent === null && usage.tokens === null) return;

		const mode = getModeFromEffectiveUsage(usage, this.thresholdSettings);
		if (!mode || mode === "checkpoint") return;

		const now = Date.now();
		if (this.state.isOnCooldown(this.thresholdSettings.cooldownMs)) return;

		// Regrowth can only be measured against a token count; without one, rely
		// on the cooldown guard alone rather than blocking compaction.
		if (
			usage.tokens !== null &&
			this.state.isRegrowthBelowThreshold(usage.tokens, REGROWTH_TOKENS)
		) {
			return;
		}

		if (this.state.isCompacting) return;

		// Prevent competing with an in-flight tool-output pruning flush.
		if (this.state.toolOutputPruning.isFlushing) return;

		// Prevent double-triggering within the same turn.
		if (this.state.isSameTurn(turnIndex)) return;

		const autoFocus = extractTriggerFocus(currentProjectedMessages(ctx));

		this.state.selectedMode = mode;
		this.state.isCompacting = true;
		this.state.lastCompactTime = now;
		this.state.lastTriggerAuto = true;
		if (turnIndex !== undefined) {
			this.state.lastCompactTurnIndex = turnIndex;
		}

		const percentText =
			usage.percent === null ? "unknown" : `${usage.percent.toFixed(0)}%`;
		const tokensText =
			usage.tokens === null ? "unknown" : usage.tokens.toLocaleString();

		ctx.ui.notify(
			`📦 Compact+ auto-compaction triggered at ${percentText} (${tokensText} / ${model.contextWindow.toLocaleString()} tokens) — mode: ${mode}, thresholdMode: ${this.thresholdSettings.thresholdMode} (${triggerSource})`,
			"info",
		);

		executeCompaction(mode, autoFocus, this.state, ctx, this.pi, {
			sendContinuation: true,
			persist: this.persistTelemetrySnapshot,
		});
	}

	/** Pi 0.87's post-tool transaction; never abort an active run via ctx.compact. */
	async maybeAutoCompactAtBoundary(
		event: TurnEndEvent,
		ctx: ExtensionEventContext,
	): Promise<BoundaryResult | undefined> {
		if (
			!event.context ||
			event.outcome !== "completed" ||
			event.message.role !== "assistant" ||
			event.message.stopReason !== "toolUse" ||
			this.disableAutoCompaction ||
			this.isEphemeralHeadlessChild(ctx) ||
			this.state.isCompacting ||
			this.state.pendingBoundaryMarker ||
			this.state.toolOutputPruning.isFlushing ||
			this.state.isSameTurn(event.turnIndex) ||
			this.state.isOnCooldown(this.thresholdSettings.cooldownMs)
		) {
			return undefined;
		}
		const usage = this.getEffectiveUsage(ctx);
		if (!usage || !ctx.model) return undefined;
		const mode = getModeFromEffectiveUsage(usage, this.thresholdSettings);
		if (!mode || mode === "checkpoint") return undefined;
		if (
			usage.tokens !== null &&
			this.state.isRegrowthBelowThreshold(usage.tokens, REGROWTH_TOKENS)
		) {
			return undefined;
		}
		const compatibility = resolveCompactionRuntimeCompatibility({
			event,
			modelRegistry: ctx.modelRegistry as { streamSimple?: unknown },
		});
		if (compatibility.executionPath !== "custom") return undefined;
		const epoch = this.state.currentCompactionEpoch;
		const leaf = ctx.sessionManager.getLeafId();
		const sessionId = ctx.sessionManager.getSessionId();
		const selectedModel = modelKey(ctx.model);
		this.state.selectedMode = mode;
		this.state.isCompacting = true;
		this.state.lastTriggerAuto = true;
		try {
			const preparation = prepareBoundaryCompaction(
				event,
				ctx,
				usage.tokens ?? 0,
			);
			if (!preparation) return undefined;
			const attempt = await this.onSessionBeforeCompact(
				{
					type: "session_before_compact",
					preparation,
					branchEntries: ctx.sessionManager.getBranch(),
					reason: "threshold",
					willRetry: false,
					signal: ctx.signal ?? new AbortController().signal,
				} as SessionBeforeCompactEvent,
				ctx,
				false,
				{
					projected: event.context.contextMessages,
					isCurrent: () => event.context?.pendingMessages.length === 0,
				},
			);
			if (this.state.currentCompactionEpoch !== epoch) return undefined;
			if (
				!attempt?.compaction ||
				ctx.signal?.aborted ||
				ctx.sessionManager.getSessionId() !== sessionId ||
				modelKey(ctx.model) !== selectedModel ||
				ctx.sessionManager.getLeafId() !== leaf
			) {
				this.state.clearPendingCompaction();
				return undefined;
			}
			const marker = randomUUID();
			this.state.pendingBoundaryMarker = marker;
			this.state.lastCompactTurnIndex = event.turnIndex;
			return {
				entries: [
					{
						type: "compaction",
						summary: attempt.compaction.summary,
						firstKeptEntryId: attempt.compaction.firstKeptEntryId,
						usage: attempt.compaction.usage,
						details: {
							...(attempt.compaction.details as object),
							compactPlusBoundary: marker,
						},
					},
				],
			};
		} catch {
			if (this.state.currentCompactionEpoch === epoch) {
				this.state.clearPendingCompaction();
				this.state.lastFallbackReason =
					"safe turn-boundary compaction unavailable";
			}
			return undefined;
		} finally {
			if (this.state.currentCompactionEpoch === epoch) {
				this.state.selectedMode = null;
				this.state.isCompacting = false;
				this.state.lastTriggerAuto = false;
			}
		}
	}

	/** Draft generation is not success: reconcile only after Pi commits it. */
	async confirmBoundaryCompaction(
		ctx: ExtensionEventContext,
	): Promise<boolean> {
		const marker = this.state.pendingBoundaryMarker;
		if (!marker) return false;
		const epoch = this.state.currentCompactionEpoch;
		const entry = [...ctx.sessionManager.getBranch()]
			.reverse()
			.find((candidate) => candidate.type === "compaction");
		if (
			entry?.type !== "compaction" ||
			(entry.details as { compactPlusBoundary?: unknown } | undefined)
				?.compactPlusBoundary !== marker
		) {
			this.state.clearPendingCompaction();
			return false;
		}
		this.state.lastCompactTokens = 0;
		this.state.pendingBoundaryMarker = null;
		await this.onSessionCompact(
			{
				type: "session_compact",
				compactionEntry: entry,
				fromExtension: true,
				reason: "threshold",
				willRetry: false,
			},
			ctx,
		);
		if (this.state.currentCompactionEpoch !== epoch) return false;
		if (ctx.hasUI) {
			ctx.ui.notify(
				"📦 Compact+ auto-compacted safely between tool turns.",
				"info",
			);
		}
		return true;
	}

	async onSessionBeforeCompact(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionEventContext,
		nativeFallbackAvailable = true,
		boundary?: { projected: AgentMessage[]; isCurrent: () => boolean },
	): Promise<SessionBeforeCompactResultLike | undefined> {
		const mode = this.state.selectedMode;

		if (!mode) {
			return await this.guardNativeSummarizationRequest(event, ctx);
		}

		const epoch = this.state.currentCompactionEpoch;
		// Only the exact prompt this lifecycle issued is an SDK echo. Caller
		// guidance, even generated-looking or modified text, is not ours to drop.
		const customInstructions =
			event.customInstructions === this.state.lastIssuedCompactionInstructions
				? undefined
				: event.customInstructions;
		this.state.lastIssuedCompactionInstructions = null;
		if (event.signal?.aborted || ctx.signal?.aborted) {
			return this.cancelAbortedCompaction();
		}

		// Pi omits retained messages from preparation.messagesToSummarize.
		// The active projection includes them while honoring context edits and
		// prior compactions. An empty projection is authoritative: never revive
		// edited-away requests from raw branch entries or preparation messages.
		const usage = this.getEffectiveUsage(ctx);
		const compatibility = resolveCompactionRuntimeCompatibility({
			event,
			modelRegistry: ctx.modelRegistry as { streamSimple?: unknown },
		});
		const projected = boundary?.projected ?? currentProjectedMessages(ctx);
		const focus = extractTriggerFocus(projected);
		const triggerSource: TriggerSource = this.state.lastTriggerAuto
			? event.preparation.isSplitTurn
				? "message_end"
				: "turn_end"
			: "command";
		const triggerReason = this.state.lastTriggerAuto
			? `auto at ${this.thresholdSettings.thresholdMode} threshold`
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
			this.state.pendingCompaction = {
				...telemetryBase,
				executionPath: "native-fallback",
				fromExtension: false,
				fallbackReason: compatibility.reason ?? undefined,
			};
			this.state.lastFallbackReason = compatibility.reason;
			await this.persistTelemetrySnapshot();
			if (this.state.currentCompactionEpoch !== epoch) return { cancel: true };

			if (ctx.hasUI) {
				ctx.ui.notify(
					"Compact+ is deferring to native Pi compaction to preserve stream-aware routing.",
					"warning",
				);
			}

			// Deferring is still sending the same payload. Guard it too.
			const deferredOverflow = await this.detectSummarizationRequestOverflow(
				event,
				ctx,
			);
			if (deferredOverflow) {
				this.reportSummarizationOverflow(
					event,
					ctx,
					deferredOverflow,
					NATIVE_SUMMARIZATION_OVERFLOW_WARNING,
				);
				return { cancel: true };
			}

			return undefined;
		}

		const sessionId = ctx.sessionManager.getSessionId();
		const leaf = ctx.sessionManager.getLeafId();
		const selectedModel = modelKey(ctx.model);
		const isCurrent = (): boolean => {
			try {
				return (
					this.state.currentCompactionEpoch === epoch &&
					ctx.sessionManager.getSessionId() === sessionId &&
					ctx.sessionManager.getLeafId() === leaf &&
					modelKey(ctx.model) === selectedModel &&
					!ctx.hasPendingMessages() &&
					!this.state.toolOutputPruning.isFlushing &&
					(boundary?.isCurrent() ?? true)
				);
			} catch {
				return false;
			}
		};
		const cancelCustom = (reason: string): { cancel: true } => {
			this.state.selectedMode = null;
			this.state.isCompacting = false;
			this.state.lastTriggerAuto = false;
			this.state.clearPendingCompaction();
			this.state.lastFallbackReason = reason;
			return { cancel: true };
		};
		const attempt = await runCustomCompaction(
			event.preparation,
			mode,
			ctx,
			compatibility,
			event.signal,
			{ projected, customInstructions, isCurrent },
		);
		if (this.state.currentCompactionEpoch !== epoch) return { cancel: true };
		if (event.signal?.aborted || ctx.signal?.aborted) {
			return this.cancelAbortedCompaction();
		}
		if (!isCurrent()) return cancelCustom("compaction context changed");
		if (attempt.cancel) {
			const overflow =
				attempt.fallbackReason ===
				"additional intent evidence exceeds the summary request budget";
			if (overflow && ctx.hasUI)
				ctx.ui.notify(INTENT_OVERFLOW_WARNING, "warning");
			return cancelCustom(
				overflow
					? "intent evidence exceeds safety budget"
					: (attempt.fallbackReason ?? "custom compaction cancelled"),
			);
		}

		if (attempt.requestOverflow) {
			// Compact+ sends a superset of what Pi would send: its rendered
			// instructions carry intent evidence Pi never sends. On a split turn it
			// also merges slices Pi sends separately, so there the failure is only
			// authoritative after re-measuring Pi's own requests. For a single slice
			// the superset is treated as authoritative and the attempt is cancelled.
			let nativeOverflow: string | null;
			// Pi only sends separate requests when the split turn has a prefix. Compact+'
			// own boundary preparation reports isSplitTurn with an empty prefix, so the
			// gate must match the real split, not the flag alone.
			const splitsPayload =
				event.preparation?.isSplitTurn === true &&
				(event.preparation?.turnPrefixMessages?.length ?? 0) > 0;
			if (splitsPayload) {
				nativeOverflow = await this.detectSummarizationRequestOverflow(
					event,
					ctx,
				);
			} else {
				// The kill switch must restore native compaction even when Compact+
				// confirmed an overflow of a payload that contains Pi's unchanged cut.
				nativeOverflow =
					this.thresholdSettings.guardNativeCompaction === false
						? null
						: (attempt.fallbackReason ?? SUMMARIZATION_CONTEXT_OVERFLOW_REASON);
			}
			if (nativeOverflow) {
				this.reportSummarizationOverflow(
					event,
					ctx,
					nativeOverflow,
					nativeOverflow === SUMMARIZATION_OUTPUT_CAP_REASON
						? SUMMARIZATION_OUTPUT_CAP_WARNING
						: SUMMARIZATION_OVERFLOW_WARNING,
				);
				return cancelCustom(nativeOverflow);
			}
			// Otherwise Pi's separate requests are estimated to fit: fall through to
			// the native deferral below instead of discarding the compaction.
		}

		if (attempt.result) {
			this.state.pendingCompaction = {
				...telemetryBase,
				classifiedCounts: attempt.classifiedCounts,
				fallbackReason: attempt.fallbackReason ?? undefined,
			};
			this.state.lastFallbackReason = attempt.fallbackReason;
			await this.persistTelemetrySnapshot();
			if (this.state.currentCompactionEpoch !== epoch) return { cancel: true };
			if (!isCurrent()) return cancelCustom("compaction context changed");

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
						auto: this.state.lastTriggerAuto,
						timestamp: telemetryBase.timestamp,
						focusTags: telemetryBase.focusTags,
						executionPath: telemetryBase.executionPath,
						thinkingLevel: telemetryBase.thinkingLevel,
						compatibilityReason: telemetryBase.compatibilityReason,
					},
				},
			};
		}

		this.state.lastFallbackReason =
			attempt.fallbackReason ?? "custom summarization unavailable";
		this.state.pendingCompaction = {
			...telemetryBase,
			executionPath: "native-fallback",
			fromExtension: false,
			fallbackReason: this.state.lastFallbackReason,
			compatibilityReason:
				telemetryBase.compatibilityReason ?? this.state.lastFallbackReason,
		};
		await this.persistTelemetrySnapshot();
		if (this.state.currentCompactionEpoch !== epoch) return { cancel: true };
		if (!isCurrent()) return cancelCustom("compaction context changed");

		if (ctx.hasUI) {
			ctx.ui.notify(
				nativeFallbackAvailable
					? "Compact+ custom summarization unavailable; falling back to default compaction."
					: "Compact+ turn-boundary summary unavailable; session unchanged. Native Pi compaction remains available.",
				"warning",
			);
		}

		// Provider wording is not a reliable overflow signal: measure the payload
		// Pi is about to send before letting this deferral through. When the cut has
		// not changed since the measurement above, this is a cache hit, not a second
		// serialization.
		const fallbackOverflow = await this.detectSummarizationRequestOverflow(
			event,
			ctx,
		);
		if (fallbackOverflow) {
			this.reportSummarizationOverflow(
				event,
				ctx,
				fallbackOverflow,
				NATIVE_SUMMARIZATION_OVERFLOW_WARNING,
			);
			return cancelCustom(fallbackOverflow);
		}

		return undefined;
	}

	async onSessionCompact(
		event: SessionCompactEvent,
		ctx: ExtensionEventContext,
	): Promise<void> {
		const pending = this.state.pendingCompaction;
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

		this.state.lastCompaction = {
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
		this.state.lastFallbackReason = fallbackReason ?? null;
		this.state.lastCompactTime = this.state.lastCompaction.timestamp;
		this.state.lastInjectedEcho =
			executionPath === "custom" &&
			typeof event.compactionEntry.summary === "string"
				? buildPersistedFocusEcho(event.compactionEntry.summary)
				: null;
		this.state.echoInjected = false;
		this.state.clearPendingCompaction();
		const postUsage = ctx.getContextUsage();
		this.state.lastCompactTokens =
			typeof details.compactPlusBoundary !== "string" &&
			typeof postUsage?.tokens === "number" &&
			Number.isSafeInteger(postUsage.tokens) &&
			postUsage.tokens > 0
				? postUsage.tokens
				: 0;
		await this.persistTelemetrySnapshot();
	}

	onModelSelect(event: ModelSelectEventLike): void {
		const key = modelKey(event.model);
		if (key) this.state.resetOnModelChange(key);
	}
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
