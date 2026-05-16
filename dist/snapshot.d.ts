import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CurrentFocus, SessionSnapshot } from "./types.js";
export declare function extractCurrentFocus(messages: AgentMessage[]): CurrentFocus;
/**
 * Extract a full session snapshot from messages for richer checkpoints,
 * status reporting, and telemetry.
 *
 * Scans the full message history for completed work and failed attempts
 * (accumulated over the whole session), but restricts open problems, errors,
 * constraints, and next-step to recent messages to avoid stale noise.
 */
export declare function extractSessionSnapshot(messages: AgentMessage[]): SessionSnapshot;
export declare function extractCompletedWork(messages: AgentMessage[]): string[];
export declare function extractOpenProblems(messages: AgentMessage[]): string[];
export declare function extractCurrentErrors(messages: AgentMessage[]): string[];
export declare function extractConstraints(messages: AgentMessage[]): string[];
export declare function extractFailedAttempts(messages: AgentMessage[]): string[];
