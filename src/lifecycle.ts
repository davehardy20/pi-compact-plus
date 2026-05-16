import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { buildSummaryInstructions } from "./prompts.js";
import type { CompactionState } from "./state.js";
import type { CompactionMode, CurrentFocus } from "./types.js";
import { CONTINUATION_PROMPT } from "./types.js";

export interface LifecycleOptions {
  /** Whether to send the continuation prompt after successful auto-compaction. */
  sendContinuation: boolean;
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

  ctx.compact({
    customInstructions: buildSummaryInstructions(mode, focus),
    onComplete: () => {
      state.isCompacting = false;
      state.selectedMode = null;
      state.lastTriggerAuto = false;
      state.lastCompactTime = Date.now();
      state.echoInjected = false;
      const postUsage = ctx.getContextUsage();
      if (postUsage && typeof postUsage.tokens === "number") {
        state.lastCompactTokens = postUsage.tokens;
      } else {
        state.lastCompactTokens = 0;
      }
      if (options?.sendContinuation) {
        pi.sendUserMessage(CONTINUATION_PROMPT, { deliverAs: "followUp" });
      }
    },
    onError: (error) => {
      state.isCompacting = false;
      state.selectedMode = null;
      state.lastTriggerAuto = false;
      state.lastCompactTokens = 0;
      state.echoInjected = false;
      if (ctx.hasUI) {
        ctx.ui.notify(`Compact+ compaction failed: ${error.message}`, "error");
      }
    },
  });
}
