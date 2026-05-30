import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { estimateTokens } from "@earendil-works/pi-coding-agent";

import { isSessionMessageEntry } from "./pi-messages.js";
import type { EffectiveUsage } from "./types.js";

export function getEffectiveUsage(
	ctx: ExtensionContext,
): EffectiveUsage | null {
	const model = ctx.model;
	if (!model) return null;
	const contextWindow = model.contextWindow ?? 0;
	if (contextWindow <= 0) return null;

	const native = ctx.getContextUsage();
	if (native) {
		return {
			percent: native.percent,
			tokens: native.tokens,
			contextWindow,
			source: "native",
		};
	}

	// Fallback: estimate from branch entries only when Pi does not expose
	// context usage at all. Do not estimate after compaction when Pi
	// intentionally reports unknown usage until the next assistant response.
	const entries = ctx.sessionManager.getBranch();
	const messages = entries.filter(isSessionMessageEntry).map((e) => e.message);
	let estimated = 0;
	for (const msg of messages) {
		estimated += estimateTokens(msg as AgentMessage);
	}
	const percent = (estimated / contextWindow) * 100;
	return {
		percent,
		tokens: estimated,
		contextWindow,
		source: "estimated",
	};
}
