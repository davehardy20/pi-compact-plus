import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { getAssistantToolCallBlocks, getIsError } from "./pi-messages.js";
import { extractTextContent } from "./session-evidence.js";
import type { ClassifiedMessages, CompactionMode } from "./types.js";

/**
 * Compute a content-density score for a message.
 * Higher = more facts/information per unit length.
 */
function contentDensity(text: string): number {
	const lines = text.split(/\n/).filter((l) => l.trim().length > 0);
	if (lines.length === 0) return 0;

	let score = 0;
	// Code blocks are high-density
	if (text.includes("```")) score += 3;
	// File paths indicate actionable info
	const pathMatches = text.match(/[\w/-]+\.[a-z]{1,6}/g);
	if (pathMatches) score += Math.min(pathMatches.length, 5);
	// URLs / references
	if (text.match(/https?:\/\//)) score += 1;
	// Lists of items
	const listItems = text.match(/^[-*]\s+/gm);
	if (listItems) score += Math.min(listItems.length, 3);
	// Structured data (JSON, key-value)
	if (text.match(/["']?[\w-]+["']?\s*[:=]\s*/)) score += 1;

	return score;
}

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
export function classifyMessages(
	messages: AgentMessage[],
	_mode: CompactionMode,
): ClassifiedMessages {
	const critical: AgentMessage[] = [];
	const contextual: AgentMessage[] = [];
	const ephemeral: AgentMessage[] = [];

	for (const msg of messages) {
		const role = msg.role;
		const text = extractTextContent(msg);

		if (role === "user" || role === "bashExecution") {
			critical.push(msg);
			continue;
		}

		if (role === "toolResult") {
			const isError = getIsError(msg);
			if (isError) {
				critical.push(msg);
				continue;
			}
			const density = contentDensity(text);
			// High-density or long tool results are contextual (e.g. git diff, file reads)
			if (
				text.length > 1500 ||
				density >= 3 ||
				/error|fail|exception/i.test(text)
			) {
				contextual.push(msg);
			} else {
				ephemeral.push(msg);
			}
			continue;
		}

		if (role === "assistant") {
			const lower = text.toLowerCase();
			const hasToolUse = getAssistantToolCallBlocks(msg).length > 0;
			const density = contentDensity(text);

			if (hasToolUse) {
				// Keep assistant messages with tool calls to preserve tool pairs
				critical.push(msg);
			} else if (
				lower.includes("decision") ||
				lower.includes("conclusion") ||
				lower.includes("therefore") ||
				lower.includes("agreed ")
			) {
				critical.push(msg);
			} else if (
				lower.includes("error") ||
				lower.includes("fail") ||
				density >= 4
			) {
				contextual.push(msg);
			} else if (text.length < 200 && density < 2) {
				// Short, low-density acknowledgments are ephemeral
				ephemeral.push(msg);
			} else {
				contextual.push(msg);
			}
			continue;
		}

		contextual.push(msg);
	}

	return { critical, contextual, ephemeral };
}
