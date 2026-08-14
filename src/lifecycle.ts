import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSummaryInstructions } from "./prompts.js";
import type { CompactionState } from "./state.js";
import type { CompactionMode, CurrentFocus } from "./types.js";
import { CONTINUATION_PROMPT } from "./types.js";

/** Event-context type passed to Pi extension event handlers. Shared with
 * compaction-coordinator.ts — import from here rather than re-aliasing. */
export type ExtensionEventContext = Parameters<
	Parameters<ExtensionAPI["on"]>[1]
>[1];

/**
 * Pi invalidates extension contexts after session replacement or reload.
 * Because ctx.compact() can replace/reload the session, callbacks passed to it
 * may observe a stale ctx or stale extension api. Guard the post-compaction
 * reads so a stale-context error is skipped rather than crashing the host
 * process (observed as /pr-review reviewer child exit-code 1 crashes).
 *
 * String-coupled to Pi's stale-context guard message emitted by
 * ExtensionRunner.invalidate() / assertActive() in
 * @earendil-works/pi-coding-agent (verified against 0.83.x;
 * "This extension ctx is stale after session replacement or reload. ...").
 * Re-verify this substring whenever the peer dependency is bumped;
 * switch to a typed/sentinel error if Pi ever exposes one.
 */
function isStaleExtensionContextError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/stale after session replacement or reload/i.test(error.message)
	);
}

/** Snapshot whether UI is available before compaction starts. */
function safeReadHasUI(ctx: ExtensionEventContext): boolean {
	try {
		return ctx.hasUI;
	} catch (error) {
		if (isStaleExtensionContextError(error)) return false;
		throw error;
	}
}

/** Read ctx.getContextUsage(); undefined when the ctx has gone stale. */
function safeGetContextUsage(
	ctx: ExtensionEventContext,
): ReturnType<ExtensionEventContext["getContextUsage"]> {
	try {
		return ctx.getContextUsage();
	} catch (error) {
		if (isStaleExtensionContextError(error)) return undefined;
		throw error;
	}
}

/** Send the continuation prompt; skip when the extension api has gone stale. */
function safeSendContinuation(pi: ExtensionAPI): void {
	try {
		pi.sendUserMessage(CONTINUATION_PROMPT, { deliverAs: "followUp" });
	} catch (error) {
		if (isStaleExtensionContextError(error)) return;
		throw error;
	}
}

/** Notify compaction failure via UI when UI is available; skip when stale. */
function safeNotifyCompactionFailure(
	ctx: ExtensionEventContext,
	hadUI: boolean,
	errorMessage: string,
): void {
	if (!hadUI) return;
	try {
		if (!ctx.hasUI) return;
		ctx.ui.notify(`Compact+ compaction failed: ${errorMessage}`, "error");
	} catch (notifyError) {
		if (isStaleExtensionContextError(notifyError)) return;
		throw notifyError;
	}
}

export interface LifecycleOptions {
	/** Whether to send the continuation prompt after successful auto-compaction. */
	sendContinuation?: boolean;
	/** Optional callback to persist state after onComplete/onError update lastCompactTokens. */
	persist?: () => void | Promise<void>;
}

/**
 * Unified compaction lifecycle for both manual and auto triggers.
 *
 * Handles state setup, ctx.compact() call, and onComplete/onError cleanup.
 * This replaces the 4 duplicated cleanup blocks that existed before.
 */
export function executeCompaction(
	mode: CompactionMode,
	focus: CurrentFocus,
	state: CompactionState,
	ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
	pi: ExtensionAPI,
	options?: LifecycleOptions,
): void {
	state.selectedMode = mode;
	state.isCompacting = true;
	const hadUI = safeReadHasUI(ctx);

	ctx.compact({
		customInstructions: buildSummaryInstructions(mode, focus),
		onComplete: () => {
			state.isCompacting = false;
			state.selectedMode = null;
			state.lastTriggerAuto = false;
			state.lastCompactTime = state.lastCompaction?.timestamp ?? Date.now();
			state.echoInjected = false;
			const postUsage = safeGetContextUsage(ctx);
			if (postUsage && typeof postUsage.tokens === "number") {
				state.lastCompactTokens = postUsage.tokens;
			}
			options?.persist?.();
			if (options?.sendContinuation) {
				safeSendContinuation(pi);
			}
		},
		onError: (error) => {
			state.isCompacting = false;
			state.selectedMode = null;
			state.lastTriggerAuto = false;
			state.lastCompactTokens = 0;
			state.echoInjected = false;
			state.clearPendingCompaction();
			options?.persist?.();
			safeNotifyCompactionFailure(ctx, hadUI, error.message);
		},
	});
}
