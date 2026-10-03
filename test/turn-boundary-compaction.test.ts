import {
	type AssistantMessage,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	type CompactionEntryDraft,
	type ExtensionContext,
	SessionManager,
	SettingsManager,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { runCustomCompaction } from "../src/compact.js";
import { CompactionCoordinator } from "../src/compaction-coordinator.js";
import { resolveCompactionRuntimeCompatibility } from "../src/compatibility.js";
import { registerCompactPlusEventHandlers } from "../src/events.js";
import {
	DEFAULT_COMPACT_PLUS_SETTINGS,
	DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
} from "../src/settings.js";
import { CompactionState } from "../src/state.js";
import { ToolOutputPruningCoordinator } from "../src/tool-output-pruning/coordinator.js";
import { createMockPi } from "./fixtures/extension.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

function assistant(id: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "bash", arguments: {} }],
		stopReason: "toolUse",
		provider: "test",
		model: "test",
		api: "openai-completions",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 1,
	};
}

function fixture(enablePruning = false) {
	vi.spyOn(SettingsManager, "create").mockReturnValue(
		SettingsManager.inMemory({
			compaction: {
				enabled: true,
				keepRecentTokens: 100,
				reserveTokens: 4096,
			},
		}),
	);
	const session = SessionManager.inMemory();
	session.appendMessage({
		role: "user",
		content: "Task: repair login.",
		timestamp: 1,
	});
	session.appendMessage({
		...assistant("old-call"),
		content: [
			{
				type: "toolCall",
				id: "old-call",
				name: "write",
				arguments: { path: "old.ts", content: "historical change" },
			},
		],
	});
	session.appendMessage({
		role: "toolResult",
		toolCallId: "old-call",
		toolName: "write",
		content: [{ type: "text", text: "historical output ".repeat(1000) }],
		isError: false,
		timestamp: 2,
	});
	const message = assistant("latest-call");
	const messageEntryId = session.appendMessage(message);
	const result = {
		role: "toolResult" as const,
		toolCallId: "latest-call",
		toolName: "bash",
		content: [
			{
				type: "text" as const,
				text: "Latest result".repeat(enablePruning ? 100 : 1),
			},
		],
		isError: false,
		timestamp: 3,
	};
	const resultId = session.appendMessage(result);
	const stream = vi.fn(() => {
		const response = createAssistantMessageEventStream();
		response.end({
			...assistant("summary"),
			content: [{ type: "text", text: VALID_STRUCTURED_SUMMARY }],
			stopReason: "stop",
		});
		return response;
	});
	const ctx = {
		cwd: "/tmp/compact-plus-boundary-test",
		mode: "tui",
		hasUI: true,
		model: {
			id: "test",
			provider: "test",
			api: "openai-completions",
			contextWindow: 200_000,
			maxTokens: 4096,
		},
		modelRegistry: { streamSimple: stream },
		sessionManager: session,
		compact: vi.fn(),
		getContextUsage: vi.fn(() => ({ tokens: 160_000, percent: 80 })),
		ui: { notify: vi.fn() },
		signal: new AbortController().signal,
		isIdle: () => false,
		hasPendingMessages: () => false,
	} as unknown as ExtensionContext;
	const pi = createMockPi();
	const state = new CompactionState();
	const persist = vi.fn();
	const coordinator = new CompactionCoordinator({
		state,
		pi: pi as never,
		thresholdSettings: DEFAULT_COMPACT_PLUS_THRESHOLD_SETTINGS,
		getEffectiveUsage: () => ({
			percent: 80,
			tokens: 160_000,
			contextWindow: 200_000,
			source: "native",
		}),
		persistTelemetrySnapshot: persist,
	});
	const pruning = new ToolOutputPruningCoordinator({
		state: state.toolOutputPruning,
		getSettings: () => ({
			...DEFAULT_COMPACT_PLUS_SETTINGS,
			experimentalToolOutputPruning: enablePruning,
			toolOutputPruningMode: "agent-message",
			toolOutputPruneMinChars: 100,
			toolOutputPruneExcludedTools: [
				...DEFAULT_COMPACT_PLUS_SETTINGS.toolOutputPruneExcludedTools,
			],
			toolOutputPruneIncludedTools: [],
		}),
	});
	registerCompactPlusEventHandlers(pi as never, {
		state,
		compactionCoordinator: coordinator,
		toolOutputPruning: pruning,
		persistTelemetrySnapshot: async () => {
			persist();
		},
	});
	const projection = session.buildSessionProjection();
	const event = {
		type: "turn_end",
		turnIndex: 1,
		message,
		toolResults: [result],
		messageEntryId,
		toolResultEntryIds: [resultId],
		entries: [],
		continue: false,
		outcome: "completed",
		context: {
			contextEntries: projection.entries,
			contextMessages: projection.messages,
			pendingMessages: [],
			canContinue: true,
			llmMessages: [],
		},
	} as TurnEndEvent;
	return { ctx, pi, state, session, stream, event, persist };
}

afterEach(() => vi.restoreAllMocks());

it("checks thresholds between tool turns without aborting or replaying the active run", async () => {
	const { ctx, pi, state, session, stream, event } = fixture();
	const handler = pi.events.get("turn_end")?.[0];
	type Draft = {
		type: string;
		summary: string;
		firstKeptEntryId: string;
		details: unknown;
	};
	const raw = await handler?.(event, ctx);
	const boundary = raw as { entries?: Draft[] } | undefined;
	expect(boundary?.entries).toHaveLength(1);
	expect(ctx.compact).not.toHaveBeenCalled();
	expect(stream).toHaveBeenCalledOnce();
	expect(state.lastCompaction).toBeNull();
	const draft = boundary?.entries?.[0];
	if (!draft) throw new Error("missing boundary compaction");
	expect(draft.details).toMatchObject({ modifiedFiles: ["old.ts"] });
	session.appendCompaction(
		draft.summary,
		draft.firstKeptEntryId,
		160_000,
		draft.details,
		true,
	);
	await pi.events.get("turn_start")?.[0]?.(
		{ type: "turn_start", turnIndex: 2, timestamp: 4 },
		ctx,
	);
	expect(state.lastCompaction?.executionPath).toBe("custom");
	const kept = session.buildSessionProjection().messages;
	expect(
		kept.some((m) => m.role === "toolResult" && m.toolCallId === "latest-call"),
	).toBe(true);
	expect(
		kept.some(
			(m) =>
				m.role === "assistant" &&
				m.content.some((b) => b.type === "toolCall" && b.id === "latest-call"),
		),
	).toBe(true);
	expect(pi.sendUserMessage).not.toHaveBeenCalled();
	expect(state.lastCompactTokens).toBe(0);
});

async function runBoundary(f: ReturnType<typeof fixture>) {
	return f.pi.events.get("turn_end")?.[0]?.(f.event, f.ctx);
}

it("does not count an uncommitted draft as compaction or start a cooldown", async () => {
	const f = fixture();
	expect(await runBoundary(f)).toBeDefined();
	await f.pi.events.get("turn_start")?.[0]?.(
		{ type: "turn_start", turnIndex: 2, timestamp: 4 },
		f.ctx,
	);
	expect(f.state.pendingBoundaryMarker).toBeNull();
	expect(f.state.lastCompactTime).toBe(0);
	expect(f.state.lastCompaction).toBeNull();
});

it("defers when queued user input is not in the summarized projection", async () => {
	const f = fixture();
	f.event.context.pendingMessages.push({
		role: "user",
		content: "A different objective instead.",
		timestamp: 4,
	});
	expect(await runBoundary(f)).toBeUndefined();
	expect(f.stream).not.toHaveBeenCalled();
	expect(f.ctx.compact).not.toHaveBeenCalled();
});

it("cancels before streaming when the parent run is aborted", async () => {
	const f = fixture();
	const abort = new AbortController();
	abort.abort();
	Object.defineProperty(f.ctx, "signal", { value: abort.signal });
	expect(await runBoundary(f)).toBeUndefined();
	expect(f.stream).not.toHaveBeenCalled();
	expect(f.state.isCompacting).toBe(false);
	expect(f.state.pendingBoundaryMarker).toBeNull();
});

it("declines a result when the authoritative branch changes during the summary", async () => {
	const f = fixture();
	f.stream.mockImplementation(() => {
		f.session.appendMessage({
			role: "user",
			content: "A different objective instead.",
			timestamp: 4,
		});
		const stream = createAssistantMessageEventStream();
		stream.end({
			...assistant("summary"),
			content: [{ type: "text", text: VALID_STRUCTURED_SUMMARY }],
			stopReason: "stop",
		});
		return stream;
	});
	expect(await runBoundary(f)).toBeUndefined();
	expect(f.state.pendingBoundaryMarker).toBeNull();
	expect(f.state.lastCompactTime).toBe(0);
});

it("leaves the context unchanged when structured summary validation fails", async () => {
	const f = fixture();
	const before = f.session.buildSessionProjection().messages;
	f.stream.mockImplementation(() => {
		const stream = createAssistantMessageEventStream();
		stream.end({
			...assistant("summary"),
			content: [{ type: "text", text: "## Original Request\nA native prefix" }],
			stopReason: "stop",
		});
		return stream;
	});
	expect(await runBoundary(f)).toBeUndefined();
	expect(f.state.lastCompaction).toBeNull();
	expect(f.state.lastCompactTime).toBe(0);
	expect(f.session.buildSessionProjection().messages).toEqual(before);
	expect(f.ctx.compact).not.toHaveBeenCalled();
});

it("uses one structured request for a real Pi split-turn helper", async () => {
	const f = fixture();
	const source = f.session.buildSessionProjection().messages;
	const preparation = {
		messagesToSummarize: source.slice(0, 3),
		turnPrefixMessages: source.slice(3),
		isSplitTurn: true,
		firstKeptEntryId: f.event.messageEntryId,
		tokensBefore: 160_000,
		fileOps: {
			read: new Set<string>(),
			written: new Set<string>(),
			edited: new Set<string>(),
		},
		settings: { enabled: true, keepRecentTokens: 100, reserveTokens: 4096 },
	};
	const compatibility = resolveCompactionRuntimeCompatibility({
		event: {},
		modelRegistry: f.ctx.modelRegistry,
	});
	const attempt = await runCustomCompaction(
		preparation,
		"standard",
		f.ctx,
		compatibility,
	);
	expect(attempt.fallbackReason).toBeNull();
	expect(attempt.result?.summary).toContain("## Current Objective");
	expect(attempt.result?.firstKeptEntryId).toBe(f.event.messageEntryId);
	expect(f.stream).toHaveBeenCalledOnce();
});

it("rejects stale completion without touching replacement-session state", async () => {
	const f = fixture();
	f.stream.mockImplementation(() => {
		f.state.reset();
		f.state.lastFallbackReason = "replacement session";
		f.state.pendingBoundaryMarker = "replacement marker";
		const stream = createAssistantMessageEventStream();
		stream.end({
			...assistant("summary"),
			content: [{ type: "text", text: VALID_STRUCTURED_SUMMARY }],
			stopReason: "stop",
		});
		return stream;
	});
	expect(await runBoundary(f)).toBeUndefined();
	expect(f.state.pendingBoundaryMarker).toBe("replacement marker");
	expect(f.state.lastFallbackReason).toBe("replacement session");
});

it("compacts again after a system-bearing prior compaction", async () => {
	const f = fixture();
	f.session.appendMessage({
		role: "system",
		content: "System instructions",
		timestamp: 4,
	});
	f.session.appendCompaction(
		VALID_STRUCTURED_SUMMARY,
		f.event.messageEntryId,
		160_000,
		{ readFiles: ["prior.ts"], modifiedFiles: ["earlier.ts"] },
		false,
	);
	const message = assistant("next-call");
	const id = f.session.appendMessage(message);
	const result = {
		role: "toolResult" as const,
		toolCallId: "next-call",
		toolName: "bash",
		content: [{ type: "text" as const, text: "next output".repeat(100) }],
		isError: false,
		timestamp: 5,
	};
	const resultId = f.session.appendMessage(result);
	const projection = f.session.buildSessionProjection();
	expect(
		projection.entries.some(
			(entry) =>
				entry.sourceEntry.type === "compaction" && entry.messages.length === 2,
		),
	).toBe(true);
	f.event = {
		...f.event,
		message,
		messageEntryId: id,
		toolResults: [result],
		toolResultEntryIds: [resultId],
		turnIndex: 2,
		context: {
			...f.event.context,
			contextEntries: projection.entries,
			contextMessages: projection.messages,
		},
	};
	const boundary = (await runBoundary(f)) as
		| { entries: CompactionEntryDraft[] }
		| undefined;
	expect(boundary?.entries[0].details).toMatchObject({
		readFiles: ["prior.ts"],
		modifiedFiles: ["earlier.ts"],
	});
	expect(f.stream).toHaveBeenCalledOnce();
});

it("reconciles pending pruning captures against the committed projection", async () => {
	const f = fixture(true);
	const boundary = (await runBoundary(f)) as
		| { entries: CompactionEntryDraft[] }
		| undefined;
	const draft = boundary?.entries[0];
	expect(draft).toBeDefined();
	expect(f.state.toolOutputPruning.hasPending()).toBe(true);
	if (!draft) throw new Error("missing boundary draft");
	f.state.toolOutputPruning.addPendingBatch(
		{
			batchId: "historical",
			turnIndex: 0,
			timestamp: 0,
			recordIds: ["historical"],
		},
		[
			{
				...f.state.toolOutputPruning.pendingRecords[0],
				recordId: "historical",
				toolCallId: "old-call",
				shortRef: "t2",
			},
		],
	);
	f.session.appendCompaction(
		draft.summary,
		draft.firstKeptEntryId,
		160_000,
		draft.details,
		true,
	);
	await f.pi.events.get("turn_start")?.[0]?.({ type: "turn_start" }, f.ctx);
	expect(f.state.toolOutputPruning.pendingRecords).toEqual([
		expect.objectContaining({
			toolCallId: "latest-call",
			entryId: f.event.toolResultEntryIds[0],
		}),
	]);
	expect(f.state.toolOutputPruning.pendingBatches[0]?.recordIds).toEqual([
		f.state.toolOutputPruning.pendingRecords[0].recordId,
	]);
});

it("drops pending originals when a context edit replaces retained tool output", async () => {
	const f = fixture(true);
	const boundary = (await runBoundary(f)) as
		| { entries: CompactionEntryDraft[] }
		| undefined;
	const draft = boundary?.entries[0];
	if (!draft) throw new Error("missing boundary draft");
	expect(
		f.state.toolOutputPruning.pendingRecords[0]?.fallbackSnippets,
	).toContain("Latest result");
	f.session.appendCompaction(
		draft.summary,
		draft.firstKeptEntryId,
		160_000,
		draft.details,
		true,
	);
	f.session.appendContextEdit(f.event.toolResultEntryIds[0], {
		content: [{ type: "text", text: "Replacement output".repeat(100) }],
	});
	await f.pi.events.get("turn_start")?.[0]?.({ type: "turn_start" }, f.ctx);
	expect(f.state.toolOutputPruning.pendingRecords).toEqual([]);
	expect(f.state.toolOutputPruning.hasPending()).toBe(false);
});

it("does not race a tool-output pruning flush", async () => {
	const f = fixture();
	f.state.toolOutputPruning.isFlushing = true;
	expect(await runBoundary(f)).toBeUndefined();
	expect(f.stream).not.toHaveBeenCalled();
});
