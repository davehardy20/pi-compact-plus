import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { extractUserOrAssistantText } from "../pi-messages.js";

/**
 * Headings that only appear together in a real Compact+ compaction summary.
 * Used to avoid false positives from chat messages that mention one heading.
 */
const SUMMARY_SIGNATURE_HEADINGS = [
	"## Current Objective",
	"## Active File Set",
	"## Decisions Made",
	"## Next Best Step",
];

const MIN_SIGNATURE_MATCHES = SUMMARY_SIGNATURE_HEADINGS.length;

/** Pre-compiled regexes for summary signature detection. */
const SUMMARY_REGEXES = SUMMARY_SIGNATURE_HEADINGS.map(
	(h) => new RegExp(`^${escapeRegex(h)}`, "m"),
);

/**
 * Detect whether the messages array contains a Compact+ compaction summary.
 * Looks for the newest assistant message with enough Compact+ summary headings
 * so the recency echo is built from current memory rather than stale memory.
 */
export function detectCompactionSummary(messages: AgentMessage[]):
	| { found: true; summaryText: string; summaryIndex: number }
	| {
			found: false;
			summaryText?: undefined;
			summaryIndex?: undefined;
	  } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const text = extractSimpleText(msg);
			const summaryCandidateText = stripFencedBlocks(text);
			const matchCount = SUMMARY_REGEXES.filter((re) =>
				re.test(summaryCandidateText),
			).length;
			// Require a top-level Compact+ summary title plus schema headings
			// outside fenced/example blocks, so pasted examples do not spoof memory.
			if (
				matchCount >= MIN_SIGNATURE_MATCHES &&
				/^\s*Compaction Summary — Compact\+ memory\s*$/im.test(
					summaryCandidateText,
				)
			) {
				return {
					found: true,
					summaryText: summaryCandidateText,
					summaryIndex: i,
				};
			}
		}
	}
	return { found: false };
}

// ── Internal helpers ────────────────────────────────────────────────

export function extractSimpleText(msg: AgentMessage): string {
	return extractUserOrAssistantText(msg, "\n");
}

function stripFencedBlocks(text: string): string {
	const withoutClosedFences = text.replace(
		/(^|\n)[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*(?:```|~~~)[^\n]*(?=\n|$)/g,
		"\n",
	);
	return withoutClosedFences.replace(
		/(^|\n)[ \t]*(?:```|~~~)[^\n]*\n[\s\S]*$/g,
		"\n",
	);
}

function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
