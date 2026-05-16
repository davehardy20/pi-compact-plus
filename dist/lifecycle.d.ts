import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompactionState } from "./state.js";
import type { CompactionMode, CurrentFocus } from "./types.js";
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
export declare function executeCompaction(mode: CompactionMode, focus: CurrentFocus, state: CompactionState, ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1], pi: ExtensionAPI, options?: LifecycleOptions): void;
