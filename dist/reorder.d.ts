import type { AgentMessage } from "@earendil-works/pi-agent-core";
/**
 * Position-aware context reordering to mitigate "lost in the middle" degradation.
 *
 * Strategy: inject a compact "focus echo" at the recency position (before the
 * last user message) so that the model sees critical information at both
 * primacy (start, from the summary) and recency (end, from the echo) positions.
 *
 * The echo is intentionally small (under ~200 tokens) to avoid eating into
 * the working context. It only duplicates the highest-signal fields:
 * objective, blockers, active files, decisions, dependency chain, next step.
 */
export interface FocusEcho {
    objective: string;
    blockers: string[];
    activeFiles: string[];
    decisions: string[];
    dependencyChain: string[];
    nextStep: string;
}
/**
 * Detect whether the messages array contains a Compact+ compaction summary.
 * Looks for assistant messages containing the "## Current Objective" heading
 * that Compact+ injects via buildSummaryInstructions().
 */
export declare function detectCompactionSummary(messages: AgentMessage[]): {
    found: true;
    summaryText: string;
    summaryIndex: number;
} | {
    found: false;
    summaryText?: undefined;
    summaryIndex?: undefined;
};
/**
 * Extract high-signal fields from a structured compaction summary.
 * Parses the known headings produced by buildSummaryInstructions().
 */
export declare function parseFocusEcho(summaryText: string): FocusEcho;
/**
 * Build a compact echo block to inject at the recency position.
 * Format:
 *   <focus-echo>
 *   Objective: ...
 *   Active files: ...
 *   Blockers: ...
 *   Next step: ...
 *   </focus-echo>
 */
export declare function buildFocusEchoBlock(echo: FocusEcho): string;
/**
 * Create a synthetic user message containing the focus echo.
 * Uses role "user" with a clear marker so it's distinguishable.
 */
export declare function createEchoMessage(echo: FocusEcho): AgentMessage;
/**
 * Main reordering function. If a compaction summary is detected:
 * 1. Parse the focus echo
 * 2. Inject it before the last user message (recency position)
 * 3. Return the reordered messages
 *
 * If no summary is detected, returns undefined (no-op).
 * If an existing <focus-echo> is found, returns undefined (dedup).
 * Pass `echoInjected=true` to skip the O(n) dedup scan (caller manages flag).
 */
export declare function reorderForPositioning(messages: AgentMessage[], echoInjected?: boolean): {
    messages: AgentMessage[];
    echoText: string;
} | undefined;
