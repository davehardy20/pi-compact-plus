import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { createFocusEchoContextMessage } from "./context-injection.js";
import { detectCompactionSummary, extractSimpleText } from "./detection.js";
import { FOCUS_ECHO_MARKER } from "./model.js";
import { buildPersistedFocusEcho } from "./rendering.js";

/**
 * Main reordering function. If a compaction summary is detected:
 * 1. Parse the focus echo
 * 2. Inject it before the last user message (recency position)
 * 3. Return the reordered messages
 *
 * If no summary is detected, returns undefined (no-op).
 * If an existing <focus-echo> is found anywhere in the current messages,
 * returns undefined (message-local dedup).
 *
 * `echoInjected` is retained for API compatibility/telemetry callers, but the
 * current message array is always scanned so already-transformed messages do
 * not receive duplicate echoes.
 */
export function reorderForPositioning(
	messages: AgentMessage[],
	_echoInjected = false,
): { messages: AgentMessage[]; echoText: string } | undefined {
	const detection = detectCompactionSummary(messages);
	if (!detection.found) {
		return undefined;
	}

	// Dedup: skip if an existing focus-echo is already present in this batch.
	const alreadyHasEcho = messages.some((msg) =>
		extractSimpleText(msg).includes(FOCUS_ECHO_MARKER),
	);
	if (alreadyHasEcho) return undefined;

	const echoText = buildPersistedFocusEcho(detection.summaryText);
	if (!echoText) {
		return undefined;
	}

	const echoMessage = createFocusEchoContextMessage(echoText);

	// Inject before the last user message for recency positioning
	const lastUserIndex = findLastUserMessageIndex(messages);
	if (lastUserIndex === -1) return undefined;

	const result = [...messages];
	result.splice(lastUserIndex, 0, echoMessage);
	return { messages: result, echoText };
}

// ── Internal helpers ────────────────────────────────────────────────

function findLastUserMessageIndex(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === "user") return i;
	}
	return -1;
}
