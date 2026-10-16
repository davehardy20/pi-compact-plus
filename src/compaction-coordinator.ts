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
import { estimateTokens } from "@earendil-works/pi-coding-agent";

import { prepareBoundaryCompaction } from "./boundary-preparation.js";
import { runCustomCompaction } from "./compact.js";
import { extractTriggerFocus } from "./compaction-intent.js";
import {
	type CompactionVerdict,
	type CompactionVerdictEvidence,
	type CompactionVerdictKind,
	compactionVerdict,
	compactionVerdictKindForReason,
} from "./compaction-verdict.js";
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
	SUMMARIZATION_EVIDENCE_TRIMMED_REASON,
	SUMMARIZATION_INTENT_EVIDENCE_REASON,
	SUMMARIZATION_OUTPUT_CAP_REASON,
	SUMMARIZATION_SUSPECT_ESTIMATE_REASON,
} from "./summarization-overflow.js";
import {
	clampReservedOutput,
	measureSummaryRequestTokens,
	piReservedTurnPrefixOutputTokens,
} from "./summarization-request-budget.js";
import {
	type CompactionMode,
	type CompactionTelemetry,
	type EffectiveUsage,
	REGROWTH_TOKENS,
	type TriggerSource,
} from "./types.js";

const INTENT_OVERFLOW_WARNING =
	"Compact+ could not capture its additional intent evidence; compaction cancelled rather than sending an unmeasured summary request. Save the current objective before attempting a different compaction path.";

const SUMMARIZATION_OVERFLOW_WARNING =
	"Compact+ cancelled compaction: the summarization request itself cannot fit the model context window. Native Pi compaction was skipped because it would send the same oversized transcript.";

const SUMMARIZATION_OUTPUT_CAP_WARNING =
	"Compact+ cancelled compaction: the summary reached its output token limit before it was complete. Native Pi compaction was skipped to avoid repeating the failed attempt.";

const NATIVE_SUMMARIZATION_OVERFLOW_WARNING =
	"Compact+ cancelled native Pi compaction: the summarization request cannot fit the model context window. Save the current objective, then start a fresh session or reduce the retained context.";

const EVIDENCE_TRIMMED_WARNING =
	"Compact+ trimmed additional intent evidence so the summary request could fit.";

type ManualCompactionMode = Extract<CompactionMode, "standard" | "hard">;
type AutoTriggerSource = Extract<TriggerSource, "turn_end" | "message_end">;
type ModelSelectEventLike = {
	model: { provider: string; id: string } | undefined;
};
type SessionBeforeCompactResultLike = {
	cancel?: boolean;
	compaction?: CompactionResult;
};
/** Verdict for one measured cut. `key` is null when the guard stopped before it
 * needed to build one. Internal only: never logged or persisted. */
type OverflowVerdict = { reason: string | null; key: string | null };

/** Cap on container nodes walked per payload so a pathological tool call cannot make
 * key building unbounded. String lengths are O(1), so sibling payload is always counted
 * until this node cap is reached. Reaching the cap is reported: a partial walk is not a
 * complete key and must not be cached as one. */
const STRUCTURAL_NODE_BUDGET = 10_000;
/**
 * How far under the model window provider-reported usage must sit before an
 * over-window estimate stops being sufficient authority to decline compaction. Named
 * and bounded so the rule is auditable rather than an ad-hoc percentage.
 */
const SUSPECT_ESTIMATE_HEADROOM_TOKENS = 16_384;
const DIGEST_WINDOW = 256;
const DIGEST_MULTIPLIER = 31;

type StructuralWalk = { left: number; exhausted: boolean };

/** Length proxy for a non-text payload. Only node traversal is bounded, so growing an
 * object with more keys or an array with more items always changes the key while the
 * budget lasts. */
function structuralChars(value: unknown, walk: StructuralWalk): number {
	if (walk.exhausted) return 0;
	if (walk.left <= 0) {
		// Growth past this point is invisible to the key, so the caller must not treat
		// the partial total as a verdict it may reuse.
		walk.exhausted = true;
		return 0;
	}
	walk.left -= 1;
	if (typeof value === "string") return value.length;
	if (typeof value === "number" || typeof value === "boolean") return 8;
	if (Array.isArray(value)) {
		let total = 2;
		for (const item of value) total += structuralChars(item, walk);
		return total;
	}
	if (value && typeof value === "object") {
		let total = 2;
		for (const [key, item] of Object.entries(value)) {
			total += key.length + structuralChars(item, walk);
		}
		return total;
	}
	return 1;
}

/** Content discriminator for guidance text. Fully covered up to three windows of
 * DIGEST_WINDOW characters (~768 in total: head, centred middle, tail). Beyond that it
 * is a discriminator, not a guarantee: a difference outside all three windows can still
 * share a key. */
export function guidanceDigest(text: string): number {
	const middle = Math.max(0, Math.floor(text.length / 2) - DIGEST_WINDOW / 2);
	const tail = Math.max(0, text.length - DIGEST_WINDOW);
	let digest = 0;
	for (const start of [0, middle, tail]) {
		const end = Math.min(text.length, start + DIGEST_WINDOW);
		for (let index = start; index < end; index++) {
			digest = (digest * DIGEST_MULTIPLIER + text.charCodeAt(index)) | 0;
		}
	}
	return digest;
}

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
	private overflowVerdict: OverflowVerdict | null = null;
	/** Distinguishes key walks that ran out of budget, so a partial walk never matches
	 * a later cut. Bounded by the number of compaction attempts in a session, and it
	 * resets with the session. Internal only: never logged or persisted. */
	private cutKeyNonce = 0;
	/** Cut already warned about, so an oversized session is warned once. */
	private overflowNoticeKey: string | null = null;
	/** True only for the attempt a manual command started, which explains itself. */
	private manualAttemptInFlight = false;
	/** Epoch that bypass belongs to, so it cannot outlive a session transition. */
	private manualAttemptEpoch = -1;

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

	/** Guard state is session-scoped, so it resets with the session. */
	resetOverflowState(): void {
		this.overflowVerdict = null;
		this.overflowNoticeKey = null;
		this.manualAttemptInFlight = false;
		this.manualAttemptEpoch = -1;
		this.cutKeyNonce = 0;
	}

	/**
	 * Rebuild the session verdict from a reason restored from telemetry at `session_start`.
	 * The persisted reason is the only decision Compact+ keeps across a restart, so the
	 * restored verdict is classified from it and `getLastVerdict()` cannot disagree with the
	 * reason the status output shows. No reason means no recorded decision: the verdict stays
	 * null rather than claiming one.
	 *
	 * The kind is the mapper's, not the live decision's. Two reasons reach Compact+ on more than
	 * one path: the context-overflow reason (guard decline, cancelled attempt, or a deferral that
	 * still reports the overflow) and the output-cap reason (cancelled attempt, or a deferral after
	 * the provider confirmed the failure). For those, this restore reports the mapper's kind, which
	 * is one of the live kinds but not necessarily the one that decision had, because the path is
	 * not persisted. Persisting the kind would need a telemetry schema change, which this slice
	 * deliberately does not make. The mapper docstring in src/compaction-verdict.ts names the same
	 * set.
	 */
	restoreVerdictFromPersistedReason(reason: string | null): void {
		if (reason === null) return;
		this.recordVerdictFromReason(reason);
	}

	/**
	 * The single writer of the session verdict. `lastFallbackReason` stays the prose view of
	 * the same decision, so every existing consumer keeps reading the same string.
	 */
	private recordVerdict(
		kind: CompactionVerdictKind,
		reason: string | null,
		evidence?: CompactionVerdictEvidence,
	): CompactionVerdict {
		const verdict = compactionVerdict(kind, reason, evidence);
		this.state.lastVerdict = verdict;
		this.state.lastFallbackReason = verdict.reason;
		return verdict;
	}

	/** Record a decision whose kind follows from the reason Compact+ wrote. */
	private recordVerdictFromReason(
		reason: string | null,
		evidence?: CompactionVerdictEvidence,
	): CompactionVerdict {
		return this.recordVerdict(
			compactionVerdictKindForReason(reason),
			reason,
			evidence,
		);
	}

	private cancelAbortedCompaction(): { cancel: true } {
		this.state.selectedMode = null;
		this.state.isCompacting = false;
		this.state.lastTriggerAuto = false;
		this.state.clearPendingCompaction();
		this.recordVerdict("cancelled", "compaction aborted");
		return { cancel: true };
	}

	/** Caller guidance Pi will really append, normalized once for the fast path, the
	 * measurement, and the verdict key. */
	private callerGuidance(event: SessionBeforeCompactEvent): string {
		return typeof event.customInstructions === "string"
			? event.customInstructions
			: "";
	}

	/**
	 * Measure each request Pi would send and return the stable overflow reason plus the
	 * key it was measured under, or null values when the guard stopped before measuring.
	 * Pure: no state or UI effects, so each call site owns its consequences. The verdict
	 * is cached per unchanged cut so a permanently oversized session is not re-serialized
	 * every attempt.
	 */
	private async detectSummarizationRequestOverflow(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionEventContext,
	): Promise<OverflowVerdict> {
		const model = ctx.model;
		const preparation = event.preparation;
		const reserve = preparation?.settings?.reserveTokens;
		if (
			!model ||
			this.thresholdSettings.guardNativeCompaction === false ||
			!Number.isSafeInteger(reserve) ||
			(reserve as number) <= 0
		) {
			return { reason: null, key: null };
		}
		// Fail-open fast path before serializing: the cut is a subset of the live
		// session, so while Pi reports the whole session fitting inside
		// `contextWindow - reserveTokens` the guard is skipped. That bound covers the
		// transcript only, so it is not trusted when caller guidance adds tokens Pi
		// will actually send, which means it never applies to Compact+'s own attempts:
		// those always issue instructions. It applies to Pi-triggered and boundary cuts,
		// and it can skip the guard but never add a cancel.
		const guidance = this.callerGuidance(event);
		const usage = this.getEffectiveUsage(ctx);
		if (
			guidance.length === 0 &&
			Number.isSafeInteger(usage?.tokens) &&
			(usage?.tokens ?? 0) > 0 &&
			(usage?.tokens ?? 0) + (reserve as number) <= model.contextWindow
		) {
			return { reason: null, key: null };
		}
		const key = this.summarizationCutKey(event, ctx);
		if (this.overflowVerdict?.key === key) {
			return { reason: this.overflowVerdict.reason, key };
		}
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
				output: clampReservedOutput(
					model,
					piReservedTurnPrefixOutputTokens(reserve as number),
				),
				wrapper: false,
			});
		}
		const customInstructions = guidance || undefined;
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
		return { reason, key };
	}

	/** Content discriminator: message counts alone let an in-place shrink reuse a
	 * stale verdict. Cheap character totals only; never logged or persisted. */
	private cutContentChars(
		preparation: SessionBeforeCompactEvent["preparation"],
	): { chars: number; exhausted: boolean } {
		let chars = 0;
		let exhausted = false;
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
					// Tool arguments and image data are payload too: ignoring them let a grown
					// tool call reuse a stale verdict. Only the container walk is bounded.
					const partLike = part as {
						type?: unknown;
						name?: unknown;
						text?: unknown;
						arguments?: unknown;
						data?: unknown;
						mimeType?: unknown;
					};
					chars += 1;
					if (typeof partLike.type === "string") chars += partLike.type.length;
					if (typeof partLike.name === "string") chars += partLike.name.length;
					if (typeof partLike.mimeType === "string") {
						chars += partLike.mimeType.length;
					}
					if (typeof partLike.text === "string") chars += partLike.text.length;
					if (typeof partLike.data === "string") chars += partLike.data.length;
					if (partLike.arguments !== undefined) {
						const walk: StructuralWalk = {
							left: STRUCTURAL_NODE_BUDGET,
							exhausted: false,
						};
						chars += structuralChars(partLike.arguments, walk);
						exhausted ||= walk.exhausted;
					}
				}
			}
		}
		return { chars, exhausted };
	}

	private summarizationCutKey(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionEventContext,
	): string {
		const preparation = event.preparation;
		const instructions = this.callerGuidance(event);
		const content = this.cutContentChars(preparation);
		// A walk that ran out of nodes saw only part of the payload, so its total is
		// not a key another cut may match. The nonce forces a fresh measurement instead
		// of letting a partial key reuse a verdict.
		const contentKey = content.exhausted
			? `partial:${++this.cutKeyNonce}`
			: content.chars;
		// Length alone would treat two guidance strings of the same size as the same
		// cut. Internal key: never logged or persisted.
		return [
			ctx.sessionManager.getSessionId(),
			ctx.sessionManager.getLeafId(),
			modelKey(ctx.model),
			preparation?.settings?.reserveTokens ?? 0,
			preparation?.messagesToSummarize?.length ?? 0,
			preparation?.turnPrefixMessages?.length ?? 0,
			contentKey,
			preparation?.isSplitTurn ? "split" : "single",
			instructions.length,
			instructions.slice(0, 32),
			instructions.slice(-32),
			guidanceDigest(instructions),
		].join(":");
	}

	/**
	 * Provider-anchored usage (exact for the last reported request, chars/4-estimated for
	 * anything newer) is the best available reading of the live session, and an ungated cut
	 * is a subset of it. The guard's payload estimate and the trailing part of that reading
	 * run the same chars/4 estimator over the same messages, while the anchored part of the
	 * reading is provider-exact, so a usage figure that still sits comfortably under the
	 * window means the payload estimate is the inflated side: an estimate above the window is
	 * not sufficient authority to decline compaction. Compact+'s own issued prompt is the
	 * payload under examination, so it is not guidance here; only a prompt someone else
	 * supplied makes the comparison incomparable, because those tokens are additive to
	 * reported usage. Fails closed when usage is unknown, non-native, non-positive, or near
	 * the window.
	 */
	private estimateDiscrepancy(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionEventContext,
		reserve: number,
		issuedInstructions: string | null,
	): boolean {
		// Compact+'s own issued prompt is the payload under examination, so it is not
		// guidance Pi will additionally send. Any other prompt is additive to reported
		// usage and makes the comparison meaningless.
		if (
			event.customInstructions !== issuedInstructions &&
			this.callerGuidance(event).length > 0
		)
			return false;
		const model = ctx.model;
		if (!model || !Number.isSafeInteger(model.contextWindow)) return false;
		if (!Number.isSafeInteger(reserve) || reserve <= 0) return false;
		const usage = this.getEffectiveUsage(ctx);
		if (usage?.source !== "native") return false;
		const tokens = usage.tokens;
		if (typeof tokens !== "number" || !Number.isSafeInteger(tokens))
			return false;
		if (tokens <= 0) return false;
		// On the deferral path Pi appends Compact+'s own prompt verbatim, so the prompt is
		// part of what must fit. Omitting it would let a large prompt defer a genuinely
		// oversized request.
		const promptTokens = issuedInstructions
			? estimateTokens({
					role: "user",
					content: issuedInstructions,
					timestamp: 0,
				})
			: 0;
		return (
			tokens + reserve + promptTokens + SUSPECT_ESTIMATE_HEADROOM_TOKENS <
			model.contextWindow
		);
	}

	/** The notice dedupe must stay deterministic across attempts, so a key whose walk
	 * ran out of budget is compared in its stable partial form. The verdict cache keeps
	 * the nonce, because a partial total cannot identify a cut. */
	private noticeKey(key: string): string {
		return key.replace(/partial:\d+/, "partial");
	}

	/**
	 * Warn at most once for an unchanged cut, and record the decision the report belongs to.
	 * `kind` is the caller's own decision: `null` means the caller writes the verdict itself
	 * (the cancel paths do), so exactly one verdict is written per decision instead of a
	 * transient kind that the decision never had.
	 */
	private reportSummarizationOverflow(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionEventContext,
		reason: string,
		warning: string,
		manualAttempt: boolean,
		measuredKey: string | null,
		kind: CompactionVerdictKind | null,
	): void {
		if (kind !== null) this.recordVerdict(kind, reason);
		this.state.lastOverflowReportedEpoch = this.state.currentCompactionEpoch;
		if (!ctx.hasUI) return;
		const key = this.noticeKey(
			measuredKey ?? this.summarizationCutKey(event, ctx),
		);
		// A manual command always explains itself. Only automatic repeats of an
		// unchanged cut are deduped.
		if (!manualAttempt && this.overflowNoticeKey === key) return;
		this.overflowNoticeKey = key;
		ctx.ui.notify(warning, "warning");
	}

	private async guardNativeSummarizationRequest(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionEventContext,
		manualAttempt: boolean,
	): Promise<SessionBeforeCompactResultLike | undefined> {
		const { reason, key } = await this.detectSummarizationRequestOverflow(
			event,
			ctx,
		);
		if (!reason) return undefined;
		// The measured reason is always a request estimate here: an exhausted output budget
		// is a provider response failure and never reaches this guard. Comfortable provider
		// usage on a cut Pi sends without foreign guidance outranks the estimate, so Pi
		// compacts and the discrepancy is recorded instead of a decline.
		if (
			this.estimateDiscrepancy(
				event,
				ctx,
				event.preparation?.settings?.reserveTokens ?? 0,
				this.state.lastIssuedCompactionInstructions,
			)
		) {
			this.recordVerdictFromReason(SUMMARIZATION_SUSPECT_ESTIMATE_REASON);
			return undefined;
		}
		this.reportSummarizationOverflow(
			event,
			ctx,
			reason,
			NATIVE_SUMMARIZATION_OVERFLOW_WARNING,
			manualAttempt,
			key,
			"declined",
		);
		return { cancel: true };
	}

	/**
	 * The typed outcome of the most recent compaction decision made in this session, on any
	 * path: Compact+'s own guard, a boundary attempt, or Pi's compaction that Compact+ settled.
	 * Null until this session records one. A session restored from telemetry restores a
	 * persisted reason as a verdict; a persisted session that recorded no reason starts with no
	 * verdict, because inventing `accepted` would claim a decision the telemetry never made.
	 */
	getLastVerdict(): Readonly<CompactionVerdict> | null {
		return this.state.lastVerdict;
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

		this.manualAttemptInFlight = true;
		const attemptEpoch = this.state.currentCompactionEpoch;
		this.manualAttemptEpoch = attemptEpoch;
		try {
			executeCompaction(mode, cmdFocus, this.state, ctx, this.pi, {
				persist: this.persistTelemetrySnapshot,
				// The bypass belongs to this attempt only, and only an attempt from this
				// attempt's epoch may clear it: a late settle from an earlier epoch must not
				// suppress a newer attempt's decline warning.
				onSettled: () => {
					if (this.manualAttemptEpoch === attemptEpoch) {
						this.manualAttemptInFlight = false;
					}
				},
			});
		} catch (error) {
			if (this.manualAttemptEpoch === attemptEpoch) {
				this.manualAttemptInFlight = false;
			}
			throw error;
		}
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
				this.recordVerdictFromReason(
					"safe turn-boundary compaction unavailable",
				);
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
		// Only the attempt a manual command started bypasses the notice dedupe, and only
		// for the epoch that attempt belongs to: a bypass left set by an attempt Pi never
		// settled expires here rather than leaking into a later session's automatic runs.
		const manualAttempt =
			this.manualAttemptInFlight &&
			this.manualAttemptEpoch === this.state.currentCompactionEpoch;
		this.manualAttemptInFlight = false;
		const mode = this.state.selectedMode;

		if (!mode) {
			return await this.guardNativeSummarizationRequest(
				event,
				ctx,
				manualAttempt,
			);
		}

		const epoch = this.state.currentCompactionEpoch;
		// Only the exact prompt this lifecycle issued is an SDK echo. Caller
		// guidance, even generated-looking or modified text, is not ours to drop.
		// The echo is transient, so capture it here: later overflow decisions in this
		// attempt still need to know which prompt was ours.
		const issuedPrompt = this.state.lastIssuedCompactionInstructions;
		const customInstructions =
			event.customInstructions === issuedPrompt
				? undefined
				: event.customInstructions;
		this.state.lastIssuedCompactionInstructions = null;
		// Computed once for this attempt: bounded provider usage headroom that contradicts
		// an over-window estimate. It decides whether a decline is justified, and it is the
		// reason recorded when the decline is not.
		const usageDiscrepancy = this.estimateDiscrepancy(
			event,
			ctx,
			event.preparation?.settings?.reserveTokens ?? 0,
			issuedPrompt,
		);
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
			// Deferring is still sending the same payload. Measure before recording why, so the
			// headroom case needs no second write: the persisted telemetry already carries the
			// reason the deferral settled on.
			const deferred = await this.detectSummarizationRequestOverflow(
				event,
				ctx,
			);
			// The measurement awaits, so re-check the epoch before writing: a superseded
			// attempt must not clobber the telemetry of the attempt that replaced it.
			if (this.state.currentCompactionEpoch !== epoch) return { cancel: true };
			// Bounded provider usage headroom outranks the estimate here too: a runtime that
			// resolves to native fallback must not reproduce the failure this change exists to
			// fix.
			const headroomDefers = Boolean(deferred.reason) && usageDiscrepancy;
			this.state.pendingCompaction = {
				...telemetryBase,
				executionPath: "native-fallback",
				fromExtension: false,
				fallbackReason: headroomDefers
					? SUMMARIZATION_SUSPECT_ESTIMATE_REASON
					: (compatibility.reason ?? undefined),
			};
			this.recordVerdict(
				"deferred",
				headroomDefers
					? SUMMARIZATION_SUSPECT_ESTIMATE_REASON
					: compatibility.reason,
			);
			await this.persistTelemetrySnapshot();
			if (this.state.currentCompactionEpoch !== epoch) return { cancel: true };

			if (ctx.hasUI) {
				ctx.ui.notify(
					"Compact+ is deferring to native Pi compaction to preserve stream-aware routing.",
					"warning",
				);
			}

			if (deferred.reason && !headroomDefers) {
				this.reportSummarizationOverflow(
					event,
					ctx,
					deferred.reason,
					NATIVE_SUMMARIZATION_OVERFLOW_WARNING,
					manualAttempt,
					deferred.key,
					"deferred",
				);
				return { cancel: true };
			}
			// Pi is about to compact on its own on a `ctx.compact()` path; the turn-boundary
			// caller treats the same deferral as no compaction this turn. Either way release
			// Compact+'s attempt state, or a deferred attempt blocks later automatic triggers.
			this.state.selectedMode = null;
			this.state.isCompacting = false;
			this.state.lastTriggerAuto = false;
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
			this.recordVerdict("cancelled", reason);
			return { cancel: true };
		};
		// The lifecycle clears the issued prompt when the attempt settles, so the echo
		// identity is captured with the SDK echo above.
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
		// A trimmed attempt is a success with a smaller payload, not a decline. Say so, and
		// say how much was dropped, so a live session can tell the two apart.
		if (
			attempt.fallbackReason === SUMMARIZATION_EVIDENCE_TRIMMED_REASON &&
			ctx.hasUI
		) {
			const turns = attempt.evidenceTrimmedTurns;
			ctx.ui.notify(
				typeof turns === "number"
					? `${EVIDENCE_TRIMMED_WARNING} Dropped ${turns} retained ${turns === 1 ? "turn" : "turns"}.`
					: EVIDENCE_TRIMMED_WARNING,
				"warning",
			);
		}
		if (attempt.cancel) {
			const overflow =
				attempt.fallbackReason === SUMMARIZATION_INTENT_EVIDENCE_REASON;
			if (overflow && ctx.hasUI)
				ctx.ui.notify(INTENT_OVERFLOW_WARNING, "warning");
			return cancelCustom(
				overflow
					? SUMMARIZATION_INTENT_EVIDENCE_REASON
					: (attempt.fallbackReason ?? "custom compaction cancelled"),
			);
		}

		// The discrepancy only speaks for an estimate. A provider-confirmed rejection is
		// proven: Pi would re-send the identical oversized cut, so headroom cannot excuse it.
		const headroomOverride = usageDiscrepancy && !attempt.providerConfirmed;

		if (attempt.requestOverflow) {
			// Compact+ sends a superset of what Pi would send: its rendered instructions
			// carry intent evidence Pi never sends, and on a split turn it merges slices
			// Pi sends separately. An overflow of Compact+'s own request is therefore not
			// an overflow of Pi's. Measure the payload Pi would actually send and cancel
			// only when that cannot fit either; assuming the superset is authoritative is
			// what left a session at 69% of its window unable to compact at all.
			let nativeOverflow: string | null;
			let nativeOverflowKey: string | null = null;
			if (attempt.fallbackReason === SUMMARIZATION_OUTPUT_CAP_REASON) {
				// An exhausted output budget is about the response, not the request: Pi
				// would hit the same cap on the same cut, so this stays a cancel unless
				// the kill switch has restored native compaction.
				nativeOverflow =
					this.thresholdSettings.guardNativeCompaction === false
						? null
						: SUMMARIZATION_OUTPUT_CAP_REASON;
			} else {
				const measured = await this.detectSummarizationRequestOverflow(
					event,
					ctx,
				);
				nativeOverflow = measured.reason;
				nativeOverflowKey = measured.key;
				// Provider-anchored usage is the best reading of the live session and the cut is
				// a subset of it. Comfortable bounded headroom outranks an over-window estimate of
				// Pi's own payload: defer to Pi instead of declining.
				if (nativeOverflow && headroomOverride) nativeOverflow = null;
			}
			if (nativeOverflow) {
				this.reportSummarizationOverflow(
					event,
					ctx,
					nativeOverflow,
					nativeOverflow === SUMMARIZATION_OUTPUT_CAP_REASON
						? SUMMARIZATION_OUTPUT_CAP_WARNING
						: SUMMARIZATION_OVERFLOW_WARNING,
					manualAttempt,
					nativeOverflowKey,
					null,
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
				intentEvidenceTrimmedTurns: attempt.evidenceTrimmedTurns,
			};
			this.recordVerdictFromReason(
				attempt.fallbackReason ?? null,
				attempt.evidenceTrimmedTurns === undefined
					? undefined
					: { evidenceTrimmedTurns: attempt.evidenceTrimmedTurns },
			);
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

		// The discrepancy only speaks for a context-overflow decline. An exhausted output
		// budget is about the response, and any other fallback reason stays exactly as the
		// attempt reported it.
		const overflowDecline =
			attempt.fallbackReason === SUMMARIZATION_CONTEXT_OVERFLOW_REASON;
		const deferralReason =
			headroomOverride && overflowDecline
				? SUMMARIZATION_SUSPECT_ESTIMATE_REASON
				: (attempt.fallbackReason ?? "custom summarization unavailable");
		this.recordVerdict("deferred", deferralReason);
		this.state.pendingCompaction = {
			...telemetryBase,
			executionPath: "native-fallback",
			fromExtension: false,
			fallbackReason: deferralReason,
			compatibilityReason: telemetryBase.compatibilityReason ?? deferralReason,
		};
		// Pi is about to compact on its own on a `ctx.compact()` path; the turn-boundary
		// caller treats the same deferral as no compaction this turn. Either way release
		// Compact+'s attempt state, or a deferred attempt blocks later automatic triggers.
		await this.persistTelemetrySnapshot();
		if (this.state.currentCompactionEpoch !== epoch) return { cancel: true };
		this.state.selectedMode = null;
		this.state.isCompacting = false;
		this.state.lastTriggerAuto = false;
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
		// Pi is about to send before letting this deferral through. When the attempt already
		// measured this cut (the `requestOverflow` branch above), this is a cache hit rather
		// than a second serialization; otherwise it is the first measurement for the attempt.
		// Headroom contradicts the measurement itself, so it suppresses the decline here
		// regardless of why the attempt fell back: a session with comfortable provider
		// headroom must not be left unable to compact. Only the relabelling above is scoped
		// to an estimate-driven context overflow.
		const fallback = await this.detectSummarizationRequestOverflow(event, ctx);
		if (fallback.reason && !headroomOverride) {
			this.reportSummarizationOverflow(
				event,
				ctx,
				fallback.reason,
				NATIVE_SUMMARIZATION_OVERFLOW_WARNING,
				manualAttempt,
				fallback.key,
				null,
			);
			return cancelCustom(fallback.reason);
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
		// Pi committed a compaction entry, so the session's outcome is a compaction that
		// happened. Classifying this from the reason alone would flip a deferral recorded
		// earlier in the same attempt into a contradictory kind; the reason stays as prose.
		const trimmedTurns = pending.intentEvidenceTrimmedTurns;
		this.recordVerdict(
			trimmedTurns === undefined ? "accepted" : "trimmed",
			fallbackReason ?? null,
			{
				evidenceTrimmedTurns: trimmedTurns,
				usageTokens: pending.usageTokensAtTrigger,
			},
		);
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
