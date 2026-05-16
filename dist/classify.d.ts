import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ClassifiedMessages, CompactionMode } from "./types.js";
/**
 * Content classification for compaction prioritization.
 * Categorizes messages as critical, contextual, or ephemeral.
 *
 * Improvements over basic version:
 * - Considers content density (code blocks, file paths, structured data)
 * - Assistant messages with tool_use parts are critical (preserve tool pairs)
 * - Tool results with high-density content are contextual, not ephemeral
 * - Short low-density tool results remain ephemeral
 */
export declare function classifyMessages(messages: AgentMessage[], _mode: CompactionMode): ClassifiedMessages;
