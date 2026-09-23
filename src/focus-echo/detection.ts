import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { extractUserOrAssistantText } from "../pi-messages.js";
import { validateStructuredSummary } from "../summary-schema.js";

/** Only Pi's persisted compaction summary is memory, never assistant prose. */
export function detectCompactionSummary(messages: AgentMessage[]):
	| { found: true; summaryText: string; summaryIndex: number }
	| {
			found: false;
			summaryText?: undefined;
			summaryIndex?: undefined;
	  } {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role !== "compactionSummary" || typeof msg.summary !== "string") {
			continue;
		}
		if (!validateStructuredSummary(msg.summary).valid) continue;
		return { found: true, summaryText: msg.summary, summaryIndex: i };
	}
	return { found: false };
}

/** Text extraction for echo-marker dedupe across context message roles. */
export function extractSimpleText(msg: AgentMessage): string {
	return extractUserOrAssistantText(msg, "\n");
}
