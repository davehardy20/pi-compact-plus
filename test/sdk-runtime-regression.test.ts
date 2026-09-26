import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	createAssistantMessageEventStream,
	type ToolResultMessage,
	type UserMessage,
} from "@earendil-works/pi-ai";
import {
	type CompactionResult,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import { registerCompactPlusEventHandlers } from "../src/events.js";
import { CompactionState } from "../src/state.js";
import { ToolOutputPruningCoordinator } from "../src/tool-output-pruning/coordinator.js";
import { getEffectiveUsage } from "../src/usage.js";
import { createMockPi } from "./fixtures/extension.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

// Resolve the installed, lockfile-controlled SDK; never use a global Pi path.
const sdkRoot = dirname(
	fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const sdkCompaction = await import(
	/* @vite-ignore */ pathToFileURL(
		join(sdkRoot, "core/compaction/compaction.js"),
	).href
);
function installedVersion(specifier: string): string {
	const entry = fileURLToPath(import.meta.resolve(specifier));
	return (
		JSON.parse(
			readFileSync(join(dirname(entry), "../package.json"), "utf8"),
		) as { version: string }
	).version;
}

function user(text: string): UserMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
		timestamp: Date.now(),
	};
}
function assistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		stopReason,
		api: "openai-completions",
		provider: "local-test",
		model: "local-test",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

it("Pi 0.87.1: real SDK tool turn -> safe cut -> streamed summary -> echo -> continuation, with retained redirect", async () => {
	const manifest = JSON.parse(
		readFileSync(new URL("../package.json", import.meta.url), "utf8"),
	) as { devDependencies: Record<string, string> };
	for (const pkg of [
		"@earendil-works/pi-coding-agent",
		"@earendil-works/pi-agent-core",
		"@earendil-works/pi-ai",
	]) {
		expect(manifest.devDependencies[pkg], pkg).toBe("0.87.1");
		expect(installedVersion(pkg), pkg).toBe("0.87.1");
	}
	const session = SessionManager.inMemory();
	session.appendMessage(user("Investigate the old issue."));
	session.appendMessage(
		assistant(
			[
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: { path: "src/compact.ts" },
				},
			],
			"toolUse",
		),
	);
	const toolResult: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: "Historical output ".repeat(90) }],
		isError: false,
		timestamp: Date.now(),
	};
	session.appendMessage(toolResult);
	session.appendMessage(
		assistant([{ type: "text", text: "The tool completed." }]),
	);
	const redirect = "Stop investigating; finish the approved repair instead.";
	const keptId = session.appendMessage(user(redirect));
	session.appendMessage(
		assistant([{ type: "text", text: "Proceeding with the repair." }]),
	);
	const preparation = sdkCompaction.prepareCompaction(session.getBranch(), {
		enabled: true,
		reserveTokens: 1024,
		keepRecentTokens: 16,
	}) as { firstKeptEntryId: string; messagesToSummarize: AgentMessage[] };
	expect(preparation).toBeDefined();
	expect(preparation.firstKeptEntryId).toBe(keptId);
	expect(
		preparation.messagesToSummarize.some((m) => m.role === "toolResult"),
	).toBe(true);
	const routed = vi.fn(() => {
		const stream = createAssistantMessageEventStream();
		stream.end(assistant([{ type: "text", text: VALID_STRUCTURED_SUMMARY }]));
		return stream;
	});
	const result = (await sdkCompaction.compact(
		preparation,
		{
			id: "local-test",
			provider: "local-test",
			api: "openai-completions",
			maxTokens: 4096,
		},
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		routed,
	)) as CompactionResult;
	expect(routed).toHaveBeenCalledTimes(1);
	expect(result.firstKeptEntryId).toBe(keptId);
	expect(result.summary).toContain("## Current Objective");
	// Pi owns the entry and the post-compaction projection; neither is mocked.
	session.appendCompaction(
		result.summary,
		result.firstKeptEntryId,
		result.tokensBefore,
		result.details,
		false,
		result.usage,
	);
	const projected = session.buildSessionContext().messages;
	expect(projected[0]?.role).toBe("compactionSummary");
	// Pi's explicit unknown post-compaction usage must not resurrect stale estimates.
	expect(
		getEffectiveUsage({
			sessionManager: session,
			model: { contextWindow: 8192 },
			getContextUsage: () => ({ tokens: null, percent: null }),
		} as unknown as ExtensionContext),
	).toMatchObject({ source: "native", tokens: null, percent: null });
	expect(
		projected.some(
			(m) => m.role === "user" && JSON.stringify(m.content).includes(redirect),
		),
	).toBe(true);

	const pi = createMockPi();
	const state = new CompactionState();
	const pruning = new ToolOutputPruningCoordinator({
		state: state.toolOutputPruning,
		getSettings: () => ({ experimentalToolOutputPruning: false }) as never,
	});
	const coordinator = new CompactionCoordinator({
		state,
		pi: pi as never,
		thresholdSettings: { thresholdMode: "percent", cooldownMs: 0 } as never,
		getEffectiveUsage: () => null,
		persistTelemetrySnapshot: async () => {},
	});
	registerCompactPlusEventHandlers(pi as never, {
		state,
		toolOutputPruning: pruning,
		compactionCoordinator: coordinator,
		persistTelemetrySnapshot: async () => {},
	});
	const ctx = {
		sessionManager: session,
		model: { id: "local-test", provider: "local-test", contextWindow: 8192 },
		modelRegistry: {},
		hasUI: false,
	} as unknown as ExtensionContext;
	// Delivery of the real preparation is simulated; no Pi agent run or network occurs.
	state.selectedMode = "standard";
	const before = await pi.events.get("session_before_compact")?.[0]?.(
		{ preparation, signal: new AbortController().signal },
		ctx,
	);
	expect(before).toBeUndefined();
	expect(state.lastFallbackReason).toContain("No stream-aware provider route");
	expect(routed).toHaveBeenCalledTimes(1); // only the explicit native SDK call above streamed
	const onContext = pi.events.get("context")?.[0];
	expect(onContext).toBeDefined();
	const echo = (await onContext?.({ messages: projected }, ctx)) as
		| { messages: AgentMessage[] }
		| undefined;
	expect(echo?.messages).toHaveLength(projected.length + 1);
	const echoIndex = echo?.messages.findIndex((m) =>
		JSON.stringify(m).includes("<focus-echo>"),
	);
	expect(echoIndex).toBe(1);
	expect(JSON.stringify(echo?.messages[echoIndex ?? -1])).toContain(
		"Finish the current repair",
	);
	expect(echo?.messages[(echoIndex ?? -1) + 1]).toBe(projected[1]);
	// A new turn remains after the compaction boundary and an echo is injected only once.
	session.appendMessage(user("Continue the approved repair."));
	const continuation = session.buildSessionContext().messages;
	expect(continuation.at(-1)?.role).toBe("user");
	const nextEcho = (await onContext?.({ messages: continuation }, ctx)) as {
		messages: AgentMessage[];
	};
	expect(nextEcho.messages.at(-1)?.role).toBe("user");
	expect(
		nextEcho.messages.filter((m) => JSON.stringify(m).includes("<focus-echo>")),
	).toHaveLength(1);
	// Message-local dedup prevents a second copy in the same context batch.
	expect(
		await onContext?.({ messages: nextEcho.messages }, ctx),
	).toBeUndefined();
});
