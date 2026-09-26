import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type ExtensionContext,
	sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";

/**
 * Pi's active context is authoritative for intent. Raw branch entries may
 * contain superseded compaction segments or context-edited-away messages.
 * Pinned Pi 0.87 provides compaction-aware entries instead of a projection.
 */
export function currentProjectedMessages(
	ctx: Pick<ExtensionContext, "sessionManager">,
): AgentMessage[] {
	const sessionManager = ctx.sessionManager as typeof ctx.sessionManager & {
		buildSessionProjection?: () => { messages: AgentMessage[] };
	};
	if (typeof sessionManager.buildSessionProjection === "function") {
		return sessionManager.buildSessionProjection().messages;
	}
	return sessionManager
		.buildContextEntries()
		.flatMap(sessionEntryToContextMessages);
}
