import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { createUserTextMessage } from "../pi-messages.js";

export const FOCUS_ECHO_CONTEXT_INJECTION_STRATEGY = {
	strategy: "synthetic-user-message",
	lowerAuthorityRoleAvailable: false,
	reason:
		"Pi extension custom messages currently serialize to provider user messages, and the context hook exposes AgentMessage transforms without a provider-preserved lower-authority memory role.",
	revisitWhen:
		"Pi exposes a context or memory role that is preserved below user, developer, and system authority across supported providers.",
} as const;

/**
 * Create the provider-facing focus-echo context message.
 *
 * Compatibility note: Pi supports extension custom messages for persistence and
 * rendering, but the current `convertToLlm` path serializes them as provider
 * `user` messages. Until Pi exposes a provider-safe lower-authority memory role,
 * Compact+ keeps the explicit synthetic-user path and relies on hardened
 * non-authoritative focus-echo framing plus sanitization to prevent the echo
 * from masquerading as a fresh user request.
 */
export function createFocusEchoContextMessage(echoText: string): AgentMessage {
	return createUserTextMessage(echoText);
}
