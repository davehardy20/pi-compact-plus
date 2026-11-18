import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { recoverCompaction } from "../src/compaction-recovery.js";
import { extractTextContent } from "../src/session-evidence.js";
import {
	RECOVERY_FAILED_REASON,
	RECOVERY_LIMIT_REASON,
	RECOVERY_SUCCESS_REASON,
	RECOVERY_UNSUPPORTED_REASON,
} from "../src/summarization-overflow.js";
import * as budget from "../src/summarization-request-budget.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

type Options = Parameters<typeof recoverCompaction>[0];
type ToolArguments = Extract<
	AssistantMessage["content"][number],
	{ type: "toolCall" }
>["arguments"];
const user = (content: string): AgentMessage => ({
	role: "user",
	content,
	timestamp: 1,
});
const usage = (): Usage => ({
	input: 10,
	output: 20,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 30,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});
function call(id: string, args: ToolArguments = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id, name: "read", arguments: args }],
		api: "openai-completions",
		provider: "offline",
		model: "offline",
		stopReason: "toolUse",
		timestamp: 1,
		usage: usage(),
	};
}
const result = (id: string): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	isError: true,
	content: [{ type: "text", text: `${"e".repeat(7000)}TOOL_TAIL_${id}` }],
	timestamp: 1,
});
function fixture() {
	const preparation: Options["preparation"] = {
		messagesToSummarize: [
			user(`OLDER ${"x".repeat(60_000)}`),
			call("a"),
			result("a"),
		],
		turnPrefixMessages: [user(`NEWER ${"y".repeat(60_000)}`)],
		isSplitTurn: true,
		firstKeptEntryId: "kept",
		tokensBefore: 28_000,
		settings: { enabled: true, reserveTokens: 4096, keepRecentTokens: 100 },
		fileOps: {
			read: new Set(["src/a.ts"]),
			written: new Set(),
			edited: new Set(),
		},
	};
	const complete = (prepared: Options["preparation"]) => ({
		result: {
			summary: VALID_STRUCTURED_SUMMARY,
			firstKeptEntryId: prepared.firstKeptEntryId,
			tokensBefore: prepared.tokensBefore,
			details: null,
			usage: usage(),
		},
		fallbackReason: null,
	});
	const execute = vi.fn<Options["execute"]>(async (prepared) =>
		complete(prepared),
	);
	const options: Options = {
		preparation,
		projected: [
			...preparation.messagesToSummarize,
			...preparation.turnPrefixMessages,
		],
		model: {
			id: "offline",
			name: "Offline",
			provider: "offline",
			api: "openai-completions",
			baseUrl: "https://offline.invalid/v1",
			contextWindow: 32_000,
			maxTokens: 2048,
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		},
		mode: "standard",
		isCurrent: () => true,
		execute,
	};
	return {
		options,
		preparation,
		execute,
		complete,
		setSource(messages: AgentMessage[]) {
			preparation.messagesToSummarize = messages;
			preparation.turnPrefixMessages = [];
			preparation.isSplitTurn = false;
			options.projected = [...messages];
		},
		run: () => recoverCompaction(options),
		maps: () =>
			execute.mock.calls
				.slice(0, -1)
				.map(([prepared]) => JSON.stringify(prepared.messagesToSummarize)),
	};
}

beforeEach(() => {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(
		new Error("Unexpected network"),
	);
});
afterEach(() => vi.restoreAllMocks());

it("partitions chronological evidence and returns only one complete result with aggregate usage", async () => {
	const f = fixture();
	const original = structuredClone(f.preparation);
	const attempt = await f.run();
	expect(attempt.fallbackReason).toBe(RECOVERY_SUCCESS_REASON);
	expect(attempt.recoveryRequests).toBe(f.execute.mock.calls.length);
	expect(f.execute).toHaveBeenCalledTimes(3);
	expect(attempt.result).toMatchObject({
		firstKeptEntryId: "kept",
		tokensBefore: 28_000,
		usage: { input: 30, output: 60, totalTokens: 90 },
	});
	expect(f.preparation).toEqual(original);
	const maps = f.maps();
	expect(maps[0]).toContain("OLDER");
	expect(maps[maps.length - 1]).toContain("NEWER");
	expect(maps.join("\n")).toContain("TOOL_TAIL_a");
	for (const [prepared] of f.execute.mock.calls.slice(0, -1)) {
		expect(prepared.fileOps.read.size).toBe(0);
		expect(prepared.previousSummary).toBeUndefined();
	}
	expect(f.execute.mock.calls.at(-1)?.[0].fileOps).toBe(f.preparation.fileOps);
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

it("preserves previous memory, caller guidance and repeated retained users exactly once", async () => {
	const f = fixture();
	f.preparation.previousSummary = `${"p".repeat(2000)}PREVIOUS_TAIL`;
	f.options.customInstructions = `${"g".repeat(2000)}GUIDANCE_TAIL`;
	f.options.projected.push(
		user(`${"r".repeat(20_000)}RETAINED_TAIL`),
		user("REPEAT_TURN"),
		user("REPEAT_TURN"),
	);
	expect((await f.run()).result).toBeDefined();
	const maps = f.maps().join("\n");
	expect(maps).toContain("RETAINED_TAIL");
	expect(maps.split("PREVIOUS_TAIL")).toHaveLength(2);
	expect(maps.split("GUIDANCE_TAIL")).toHaveLength(2);
	expect(maps.split("REPEAT_TURN")).toHaveLength(3);
});

it("keeps interleaved call/result intervals atomic", async () => {
	const f = fixture();
	f.setSource([
		user("x".repeat(60_000)),
		call("a"),
		call("b"),
		result("b"),
		result("a"),
		user("y".repeat(60_000)),
	]);
	expect((await f.run()).result).toBeDefined();
	const span = f.maps().filter((text) => text.includes("TOOL_TAIL_a"));
	expect(span).toHaveLength(1);
	expect(span[0]).toContain("TOOL_TAIL_b");
	expect(span[0].indexOf("TOOL_TAIL_b")).toBeLessThan(
		span[0].indexOf("TOOL_TAIL_a"),
	);
});

it("omits thinking and excluded bash without modifying originals", async () => {
	const f = fixture();
	f.preparation.messagesToSummarize.push(
		{
			...call("hidden"),
			content: [{ type: "thinking", thinking: "PRIVATE_REASONING" }],
		},
		{
			role: "bashExecution",
			command: "PRIVATE_COMMAND",
			output: "PRIVATE_OUTPUT",
			exitCode: 0,
			cancelled: false,
			truncated: false,
			excludeFromContext: true,
			timestamp: 1,
		},
	);
	const original = structuredClone(f.preparation);
	expect((await f.run()).result).toBeDefined();
	expect(f.maps().join("\n")).not.toMatch(
		/PRIVATE_REASONING|PRIVATE_COMMAND|PRIVATE_OUTPUT/,
	);
	expect(f.preparation).toEqual(original);
});

it.each([1, 5])(
	"refuses an indivisible oversized input or a fifth partial: %s groups",
	async (count) => {
		const f = fixture();
		f.setSource(
			Array.from({ length: count }, () =>
				user("x".repeat(count === 1 ? 200_000 : 60_000)),
			),
		);
		expect(await f.run()).toMatchObject({
			cancel: true,
			fallbackReason: RECOVERY_LIMIT_REASON,
			result: undefined,
		});
		expect(f.execute).not.toHaveBeenCalled();
	},
);

it("supports four partials plus one reducer", async () => {
	const f = fixture();
	f.setSource(Array.from({ length: 4 }, () => user("x".repeat(60_000))));
	expect((await f.run()).recoveryRequests).toBe(5);
	expect(f.execute).toHaveBeenCalledTimes(5);
});

it.each(["invalid", "oversized", "provider failure"])(
	"stops after a failed partial: %s",
	async (kind) => {
		const f = fixture();
		f.execute.mockImplementationOnce(async (prepared) => {
			if (kind === "provider failure") throw new Error("synthetic failure");
			const attempt = f.complete(prepared);
			attempt.result.summary =
				kind === "oversized"
					? `${VALID_STRUCTURED_SUMMARY}\n${"z".repeat(16_001)}`
					: "OK";
			return attempt;
		});
		expect(await f.run()).toMatchObject({
			cancel: true,
			fallbackReason: RECOVERY_FAILED_REASON,
			result: undefined,
		});
		expect(f.execute).toHaveBeenCalledOnce();
	},
);

it.each(["abort", "stale"])(
	"does not dispatch another request after %s",
	async (kind) => {
		const f = fixture();
		const controller = new AbortController();
		f.options.signal = controller.signal;
		f.execute.mockImplementationOnce(async (prepared) => {
			if (kind === "abort") controller.abort();
			else f.options.isCurrent = () => false;
			return f.complete(prepared);
		});
		expect(await f.run()).toMatchObject({
			cancel: true,
			result: undefined,
			fallbackReason:
				kind === "abort" ? "compaction aborted" : "compaction context changed",
		});
		expect(f.execute).toHaveBeenCalledOnce();
	},
);

it("preflights the worst-case reducer before executing any partial", async () => {
	const f = fixture();
	f.options.model.contextWindow = 17_000;
	f.setSource(Array.from({ length: 4 }, () => user("x".repeat(45_000))));
	expect((await f.run()).fallbackReason).toBe(RECOVERY_LIMIT_REASON);
	expect(f.execute).not.toHaveBeenCalled();
});

it("remeasures the actual reducer and discards all partials if it cannot fit", async () => {
	const f = fixture();
	const measure = budget.measureSummaryRequestTokens;
	vi.spyOn(budget, "measureSummaryRequestTokens").mockImplementation(
		async (request) => {
			const captured = await measure(request);
			return captured && f.execute.mock.calls.length === 2
				? { ...captured, totalTokens: 32_000 }
				: captured;
		},
	);
	expect(await f.run()).toMatchObject({
		cancel: true,
		result: undefined,
		fallbackReason: RECOVERY_LIMIT_REASON,
	});
	expect(f.execute).toHaveBeenCalledTimes(2);
});

it("never returns partial checkpoints when the final reducer fails validation", async () => {
	const f = fixture();
	f.execute.mockImplementation(async (prepared) => {
		const attempt = f.complete(prepared);
		if (f.execute.mock.calls.length === 3) attempt.result.summary = "OK";
		return attempt;
	});
	expect(await f.run()).toMatchObject({
		cancel: true,
		result: undefined,
		fallbackReason: RECOVERY_FAILED_REASON,
	});
	expect(f.execute).toHaveBeenCalledTimes(3);
});

it.each([
	["unclosed call", [call("unclosed")]],
	["unmatched result", [result("unmatched")]],
	["duplicate id", [call("a"), call("a"), result("a")]],
] satisfies Array<[string, AgentMessage[]]>)(
	"preserves incomplete labelled tool data: %s",
	async (_name, messages) => {
		const f = fixture();
		f.setSource([
			user("x".repeat(60_000)),
			...messages,
			user("y".repeat(60_000)),
		]);
		expect((await f.run()).result).toBeDefined();
		const body = f.execute.mock.calls
			.slice(0, -1)
			.flatMap(([prepared]) => prepared.messagesToSummarize)
			.map(extractTextContent)
			.join("\n");
		const calls = messages.filter((message) => message.role === "assistant");
		expect(body.split('"type":"toolCall"')).toHaveLength(calls.length + 1);
		for (const message of messages) {
			if (message.role === "toolResult")
				expect(body).toContain(`TOOL_TAIL_${message.toolCallId}`);
		}
	},
);

it("refuses an unmeasurable request before execution", async () => {
	const f = fixture();
	vi.spyOn(budget, "measureSummaryRequestTokens").mockResolvedValueOnce(
		undefined,
	);
	expect((await f.run()).cancel).toBe(true);
	expect(f.execute).not.toHaveBeenCalled();
});

it.each([
	"object hook",
	"array hook",
	"inherited hook",
	"sparse array",
	"hidden index",
])("rejects unsafe argument serialization: %s", async (kind) => {
	const f = fixture();
	const inspect = vi.fn(() => () => "unsafe");
	const parent = Object.defineProperty({}, "toJSON", { get: inspect });
	const value =
		kind === "object hook"
			? {}
			: kind === "inherited hook"
				? Object.create(parent)
				: [];
	if (kind === "sparse array") value.length = 2_000_001;
	else if (kind !== "inherited hook")
		Object.defineProperty(value, kind === "hidden index" ? "0" : "toJSON", {
			get: inspect,
		});
	f.preparation.messagesToSummarize.push(call("unsafe", { value }));
	const measure = vi.spyOn(budget, "measureSummaryRequestTokens");
	expect(await f.run()).toMatchObject({
		cancel: true,
		result: undefined,
		fallbackReason:
			kind === "sparse array"
				? RECOVERY_LIMIT_REASON
				: RECOVERY_UNSUPPORTED_REASON,
	});
	expect(inspect).not.toHaveBeenCalled();
	expect(measure).not.toHaveBeenCalled();
	expect(f.execute).not.toHaveBeenCalled();
});

it.each(["toolName", "toolCallId"] as const)(
	"bounds tool-result %s before serialization",
	async (field) => {
		const f = fixture();
		f.preparation.messagesToSummarize.push({
			...result("large"),
			[field]: "m".repeat(8_000_001),
		});
		const measure = vi.spyOn(budget, "measureSummaryRequestTokens");
		expect((await f.run()).fallbackReason).toBe(RECOVERY_LIMIT_REASON);
		expect(measure).not.toHaveBeenCalled();
		expect(f.execute).not.toHaveBeenCalled();
	},
);
