import type {
	CompactionResult,
	ExtensionAPI,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
} from "@earendil-works/pi-coding-agent";

import { runCustomCompaction } from "./compact.js";
import {
	type CompactionExecutionPath,
	resolveCompactionRuntimeCompatibility,
} from "./compatibility.js";
import { buildPersistedFocusEcho } from "./focus-echo/index.js";
import { executeCompaction } from "./lifecycle.js";
import { isAssistantMessage } from "./pi-messages.js";
import { getModeFromEffectiveUsage, modelKey } from "./policy.js";
import { createCurrentSessionBranchView } from "./session-branch-view.js";
import {
	extractCurrentFocus,
	extractCurrentFocusFromBranch,
	extractTextContent,
} from "./session-evidence.js";
import type { CompactionState } from "./state.js";
import {
	COOLDOWN_MS,
	type CompactionMode,
	type CompactionTelemetry,
	type EffectiveUsage,
	REGROWTH_TOKENS,
	THRESHOLD_MODE,
	type TriggerSource,
} from "./types.js";

type ExtensionEventContext = Parameters<Parameters<ExtensionAPI["on"]>[1]>[1];
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
	getEffectiveUsage: (ctx: ExtensionEventContext) => EffectiveUsage | null;
	persistTelemetrySnapshot: () => void | Promise<void>;
}

export class CompactionCoordinator {
	private readonly state: CompactionState;
	private readonly pi: ExtensionAPI;
	private readonly getEffectiveUsage: (
		ctx: ExtensionEventContext,
	) => EffectiveUsage | null;
	private readonly persistTelemetrySnapshot: () => void | Promise<void>;

	constructor({
		state,
		pi,
		getEffectiveUsage,
		persistTelemetrySnapshot,
	}: CompactionCoordinatorOptions) {
		this.state = state;
		this.pi = pi;
		this.getEffectiveUsage = getEffectiveUsage;
		this.persistTelemetrySnapshot = persistTelemetrySnapshot;
	}

	async handleManualCommand(
		mode: ManualCompactionMode,
		ctx: ExtensionEventContext,
	): Promise<void> {
		if (this.state.isCompacting) {
			ctx.ui.notify("📦 A compaction is already in progress.", "warning");
			return;
		}

		this.state.lastTriggerAuto = false;

		const cmdBranchView = createCurrentSessionBranchView(ctx);
		const cmdFocus = extractCurrentFocusFromBranch(cmdBranchView);

		ctx.ui.notify(`📦 Compact+ ${mode} compaction triggered manually.`, "info");

		executeCompaction(mode, cmdFocus, this.state, ctx, this.pi, {
			persist: this.persistTelemetrySnapshot,
		});
	}

	async maybeAutoCompact(
		ctx: ExtensionEventContext,
		triggerSource: AutoTriggerSource,
		turnIndex?: number,
	): Promise<void> {
		const usage = this.getEffectiveUsage(ctx);
		const model = ctx.model;
		if (!usage || !model) return;

		// Token-aware thresholds mean a single usage metric can be enough: percent
		// mode needs percent, tokens mode needs tokens, and effective_cap can
		// trigger from either band. Only bail when no metric is available at all;
		// the selected-mode check below handles mode/metric mismatches.
		if (usage.percent === null && usage.tokens === null) return;

		const mode = getModeFromEffectiveUsage(usage);
		if (!mode || mode === "checkpoint") return;

		const now = Date.now();
		if (this.state.isOnCooldown(COOLDOWN_MS)) return;

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

		this.state.selectedMode = mode;
		this.state.isCompacting = true;
		this.state.lastCompactTime = now;
		this.state.lastTriggerAuto = true;
		if (turnIndex !== undefined) {
			this.state.lastCompactTurnIndex = turnIndex;
		}

		const autoBranchView = createCurrentSessionBranchView(ctx);
		const autoFocus = extractCurrentFocusFromBranch(autoBranchView);

		const percentText =
			usage.percent === null ? "unknown" : `${usage.percent.toFixed(0)}%`;
		const tokensText =
			usage.tokens === null ? "unknown" : usage.tokens.toLocaleString();

		ctx.ui.notify(
			`📦 Compact+ auto-compaction triggered at ${percentText} (${tokensText} / ${model.contextWindow.toLocaleString()} tokens) — mode: ${mode}, thresholdMode: ${THRESHOLD_MODE} (${triggerSource})`,
			"info",
		);

		executeCompaction(mode, autoFocus, this.state, ctx, this.pi, {
			sendContinuation: true,
			persist: this.persistTelemetrySnapshot,
		});
	}

	async onSessionBeforeCompact(
		event: SessionBeforeCompactEvent,
		ctx: ExtensionEventContext,
	): Promise<SessionBeforeCompactResultLike | undefined> {
		const mode = this.state.selectedMode;

		if (!mode) {
			return undefined;
		}

		const focusMessages = event.preparation.isSplitTurn
			? [
					...event.preparation.messagesToSummarize,
					...event.preparation.turnPrefixMessages,
				]
			: event.preparation.messagesToSummarize;
		const focus = extractCurrentFocus(focusMessages);
		const usage = this.getEffectiveUsage(ctx);
		const compatibility = resolveCompactionRuntimeCompatibility({
			event,
		});

		const triggerSource: TriggerSource = this.state.lastTriggerAuto
			? event.preparation.isSplitTurn
				? "message_end"
				: "turn_end"
			: "command";
		const triggerReason = this.state.lastTriggerAuto
			? `auto at ${THRESHOLD_MODE} threshold`
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
			this.state.pendingCompaction = {
				...telemetryBase,
				classifiedCounts: attempt.classifiedCounts,
				fallbackReason: attempt.fallbackReason ?? undefined,
			};
			this.state.lastFallbackReason = attempt.fallbackReason;
			await this.persistTelemetrySnapshot();

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

		if (ctx.hasUI) {
			ctx.ui.notify(
				"Compact+ custom summarization unavailable; falling back to default compaction.",
				"warning",
			);
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
		if (postUsage && typeof postUsage.tokens === "number") {
			this.state.lastCompactTokens = postUsage.tokens;
		}
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
