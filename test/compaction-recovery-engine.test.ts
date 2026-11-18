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
type Attempt = Awaited<ReturnType<Options["execute"]>>;
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

it("fits uneven chronological groups into four measured requests", async () => {
	const f = fixture();
	const weights = [8, 16, 4, 8, 16];
	f.setSource(
		weights.map((weight, index) =>
			user(`GROUP_${index}: ${"x".repeat(weight * 4000)}`),
		),
	);
	// Capture the exact SDK instruction overhead without duplicating prompt text.
	// This probe stops before any execute call, regardless of the partitioner.
	const realMeasure = budget.measureSummaryRequestTokens;
	const measure = vi
		.spyOn(budget, "measureSummaryRequestTokens")
		.mockResolvedValueOnce(undefined);
	await f.run();
	expect(f.execute).not.toHaveBeenCalled();
	const baseline = await realMeasure({
		...measure.mock.calls[0][0],
		messages: [],
	});
	if (!baseline) throw new Error("Unmeasurable fixture baseline");
	f.options.model.contextWindow = Math.ceil(
		(baseline.totalTokens + 21_000) / 0.95,
	);
	measure.mockClear();

	expect(await f.run()).toMatchObject({
		fallbackReason: RECOVERY_SUCCESS_REASON,
		recoveryRequests: 5,
	});
	expect(
		f
			.maps()
			.map((part) =>
				weights.flatMap((_, index) =>
					part.includes(`GROUP_${index}:`) ? [index] : [],
				),
			),
	).toEqual([[0], [1, 2], [3], [4]]);
	expect(f.execute).toHaveBeenCalledTimes(5);
});

it("preflights only the planned partial count on a smaller model", async () => {
	const f = fixture();
	f.options.model.contextWindow = 17_000;
	f.setSource(Array.from({ length: 2 }, () => user("x".repeat(45_000))));
	const measure = vi.spyOn(budget, "measureSummaryRequestTokens");
	expect(await f.run()).toMatchObject({
		fallbackReason: RECOVERY_SUCCESS_REASON,
		recoveryRequests: 3,
	});
	const reducerIndex = measure.mock.calls.findIndex(([request]) =>
		request.customInstructions?.includes("RECOVERY REDUCTION"),
	);
	const envelope = measure.mock.calls[reducerIndex][0].messages;
	expect(envelope).toHaveLength(2);
	for (const message of envelope) {
		expect(extractTextContent(message)).toContain("x".repeat(16_000));
	}
	expect(measure.mock.invocationCallOrder[reducerIndex]).toBeLessThan(
		f.execute.mock.invocationCallOrder[0],
	);
	expect(f.execute).toHaveBeenCalledTimes(3);
});

it("bounds measured-prefix planning for ten thousand groups", async () => {
	const f = fixture();
	f.setSource(
		Array.from({ length: 10_000 }, (_, index) =>
			user(`ROW_${index}: ${"x".repeat(40)}`),
		),
	);
	const measure = vi.spyOn(budget, "measureSummaryRequestTokens");
	expect(await f.run()).toMatchObject({
		cancel: true,
		fallbackReason: RECOVERY_LIMIT_REASON,
	});
	expect(measure).toHaveBeenCalled();
	expect(measure.mock.calls[0][0].messages).toHaveLength(10_000);
	expect(measure.mock.calls.length).toBeLessThanOrEqual(48);
	expect(f.execute).not.toHaveBeenCalled();
});

it("preserves the empty-source single-map behavior", async () => {
	const f = fixture();
	f.setSource([]);
	expect((await f.run()).recoveryRequests).toBe(2);
	expect(f.execute).toHaveBeenCalledTimes(2);
});

it.each(["abort", "stale"])(
	"stops measured-prefix planning after %s",
	async (kind) => {
		const f = fixture();
		const controller = new AbortController();
		f.options.signal = controller.signal;
		const realMeasure = budget.measureSummaryRequestTokens;
		const measure = vi.spyOn(budget, "measureSummaryRequestTokens");
		measure.mockImplementation(async (request) => {
			const result = await realMeasure(request);
			if (measure.mock.calls.length === 2) {
				if (kind === "abort") controller.abort();
				else f.options.isCurrent = () => false;
			}
			return result;
		});
		expect(await f.run()).toMatchObject({ cancel: true, result: undefined });
		expect(measure).toHaveBeenCalledTimes(2);
		expect(f.execute).not.toHaveBeenCalled();
	},
);

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

it.each(["sparse paths", "path getter", "index getter"])(
	"checks projected-only arguments: %s",
	async (kind) => {
		const f = fixture();
		const inspect = vi.fn(() => "retained.ts");
		const args: ToolArguments = {};
		if (kind === "sparse paths") args.paths = new Array(100_001);
		else if (kind === "path getter")
			Object.defineProperty(args, "path", { get: inspect });
		else args.paths = Object.defineProperty([], "0", { get: inspect });
		f.options.projected.push(call("retained-only", args));
		const measure = vi.spyOn(budget, "measureSummaryRequestTokens");
		const attempt = await f.run();
		expect(inspect).not.toHaveBeenCalled();
		expect(attempt).toMatchObject({
			cancel: true,
			result: undefined,
			fallbackReason:
				kind === "sparse paths"
					? RECOVERY_LIMIT_REASON
					: RECOVERY_UNSUPPORTED_REASON,
		});
		expect(measure).not.toHaveBeenCalled();
		expect(f.execute).not.toHaveBeenCalled();
	},
);

const metadataCases = [
	["branchSummary", "fromId"],
	["compactionSummary", "tokensBefore"],
	["bashExecution", "cancelled"],
	["bashExecution", "truncated"],
	["bashExecution", "exitCode"],
	["bashExecution", "fullOutputPath"],
	["toolResult", "isError"],
];
it.each(
	metadataCases.flatMap(([role, field]) => [
		[role, field, "hook"],
		[role, field, "getter"],
	]),
)("checks copied metadata %s.%s (%s)", async (role, field, kind) => {
	const f = fixture();
	const inspect = vi.fn(() => "synthetic");
	const message: Record<string, unknown> = {
		role,
		summary: "Historical memory.",
		fromId: null,
		tokensBefore: 100,
		command: "echo synthetic",
		output: "synthetic",
		cancelled: false,
		truncated: false,
		exitCode: 0,
		timestamp: 1,
		toolCallId: "orphan",
		toolName: "read",
		isError: false,
		content: [{ type: "text", text: "Synthetic tool evidence." }],
	};
	Object.defineProperty(
		message,
		field,
		kind === "getter"
			? { get: inspect }
			: { value: Object.defineProperty({}, "toJSON", { value: inspect }) },
	);
	f.preparation.messagesToSummarize.push(message as unknown as AgentMessage);
	const measure = vi.spyOn(budget, "measureSummaryRequestTokens");
	const attempt = await f.run();
	expect(inspect).not.toHaveBeenCalled();
	expect(attempt).toMatchObject({
		cancel: true,
		result: undefined,
		fallbackReason: RECOVERY_UNSUPPORTED_REASON,
	});
	expect(measure).not.toHaveBeenCalled();
	expect(f.execute).not.toHaveBeenCalled();
});

it("does not serialize an inherited sparse-array getter", async () => {
	const f = fixture();
	const inspect = vi.fn(() => "synthetic");
	const inherited = Object.getOwnPropertyDescriptor(Array.prototype, "9999");
	const paths = new Array(10_000);
	f.preparation.messagesToSummarize.push(call("inherited-slot", { paths }));
	let attempt: Awaited<ReturnType<typeof recoverCompaction>>;
	try {
		Object.defineProperty(Array.prototype, "9999", {
			get: inspect,
			configurable: true,
		});
		attempt = await f.run();
	} finally {
		if (inherited) Object.defineProperty(Array.prototype, "9999", inherited);
		else Reflect.deleteProperty(Array.prototype, "9999");
	}
	expect(inspect).not.toHaveBeenCalled();
	expect(attempt).toMatchObject({
		cancel: true,
		result: undefined,
		fallbackReason: RECOVERY_UNSUPPORTED_REASON,
	});
	expect(f.execute).not.toHaveBeenCalled();
});

const sourceLists = [
	"messagesToSummarize",
	"turnPrefixMessages",
	"projected",
] as const;
it.each(
	sourceLists.flatMap((list) =>
		["index getter", "inherited index", "iterator", "iterator getter"].map(
			(kind) => [list, kind] as const,
		),
	),
)("checks original outer array %s (%s)", async (list, kind) => {
	const f = fixture();
	const array =
		list === "projected" ? f.options.projected : f.preparation[list];
	const item = array[0];
	const inspect = vi.fn(() => item);
	const iterator = function* () {
		inspect();
		yield item;
	};
	if (kind === "index getter")
		Object.defineProperty(array, "0", { get: inspect });
	else if (kind === "inherited index") {
		const prototype = Object.create(Array.prototype);
		Object.defineProperty(prototype, "0", { get: inspect });
		Reflect.deleteProperty(array, "0");
		Object.setPrototypeOf(array, prototype);
	} else if (kind === "iterator")
		Object.defineProperty(array, Symbol.iterator, { value: iterator });
	else
		Object.defineProperty(array, Symbol.iterator, {
			get: () => {
				inspect();
				return iterator;
			},
		});
	const measure = vi.spyOn(budget, "measureSummaryRequestTokens");
	const attempt = await f.run();
	expect(inspect).not.toHaveBeenCalled();
	expect(attempt).toMatchObject({
		cancel: true,
		result: undefined,
		fallbackReason: RECOVERY_UNSUPPORTED_REASON,
	});
	expect(measure).not.toHaveBeenCalled();
	expect(f.execute).not.toHaveBeenCalled();
});

it.each(
	["previousSummary", "customInstructions"].flatMap((field) =>
		["number", "getter", "coercion", "length getter"].map(
			(kind) => [field, kind] as const,
		),
	),
)("checks supplemental text %s (%s)", async (field, kind) => {
	const f = fixture();
	const target = field === "previousSummary" ? f.preparation : f.options;
	const inspect = vi.fn(() => "Synthetic memory.");
	if (kind === "getter") Object.defineProperty(target, field, { get: inspect });
	else {
		const value = kind === "number" ? 7 : { length: 1, toString: inspect };
		if (kind === "length getter")
			Object.defineProperty(value, "length", { get: inspect });
		Object.defineProperty(target, field, { value });
	}
	const measure = vi.spyOn(budget, "measureSummaryRequestTokens");
	const attempt = await f.run();
	expect(inspect).not.toHaveBeenCalled();
	expect(attempt).toMatchObject({
		cancel: true,
		result: undefined,
		fallbackReason: RECOVERY_UNSUPPORTED_REASON,
	});
	expect(measure).not.toHaveBeenCalled();
	expect(f.execute).not.toHaveBeenCalled();
});

it.each([
	"messagesToSummarize",
	"turnPrefixMessages",
	"settings",
	"tokensBefore",
	"firstKeptEntryId",
	"fileOps",
	"isSplitTurn",
] as const)("rejects preparation.%s accessors", async (field) => {
	const f = fixture();
	const value = f.preparation[field];
	const inspect = vi.fn(() => value);
	Object.defineProperty(f.preparation, field, { get: inspect });
	const measure = vi.spyOn(budget, "measureSummaryRequestTokens");
	const attempt = await f.run();
	expect(inspect).not.toHaveBeenCalled();
	expect(attempt).toMatchObject({
		cancel: true,
		result: undefined,
		fallbackReason: RECOVERY_UNSUPPORTED_REASON,
	});
	expect(measure).not.toHaveBeenCalled();
	expect(f.execute).not.toHaveBeenCalled();
});

it("does not spread unconsumed preparation fields into requests", async () => {
	const f = fixture();
	const inspect = vi.fn(() => "not consumed");
	Object.defineProperty(f.preparation, "unused", {
		get: inspect,
		enumerable: true,
	});
	const attempt = await f.run();
	expect(inspect).not.toHaveBeenCalled();
	expect(attempt.result).toBeDefined();
});

it.each(["preparation", "projected"] as const)(
	"rejects options.%s accessors before reading data",
	async (key) => {
		const f = fixture();
		const value = f.options[key];
		const inspect = vi.fn(() => value);
		Object.defineProperty(f.options, key, { get: inspect });
		const measure = vi.spyOn(budget, "measureSummaryRequestTokens");
		const attempt = await f.run();
		expect(inspect).not.toHaveBeenCalled();
		expect(attempt).toMatchObject({
			cancel: true,
			result: undefined,
			fallbackReason: RECOVERY_UNSUPPORTED_REASON,
		});
		expect(measure).not.toHaveBeenCalled();
		expect(f.execute).not.toHaveBeenCalled();
	},
);

it.each(["enabled", "reserveTokens", "keepRecentTokens"] as const)(
	"rejects preparation.settings.%s accessors",
	async (key) => {
		const f = fixture();
		const value = f.preparation.settings[key];
		const inspect = vi.fn(() => value);
		Object.defineProperty(f.preparation.settings, key, { get: inspect });
		const measure = vi.spyOn(budget, "measureSummaryRequestTokens");
		const attempt = await f.run();
		expect(inspect).not.toHaveBeenCalled();
		expect(attempt).toMatchObject({
			cancel: true,
			result: undefined,
			fallbackReason: RECOVERY_UNSUPPORTED_REASON,
		});
		expect(measure).not.toHaveBeenCalled();
		expect(f.execute).not.toHaveBeenCalled();
	},
);

it("rejects array-like source objects before reading their length", async () => {
	const f = fixture();
	const inspect = vi.fn(() => 1);
	f.preparation.messagesToSummarize = Object.defineProperty({}, "length", {
		get: inspect,
	}) as AgentMessage[];
	const measure = vi.spyOn(budget, "measureSummaryRequestTokens");
	const attempt = await f.run();
	expect(inspect).not.toHaveBeenCalled();
	expect(attempt).toMatchObject({
		cancel: true,
		result: undefined,
		fallbackReason: RECOVERY_UNSUPPORTED_REASON,
	});
	expect(measure).not.toHaveBeenCalled();
	expect(f.execute).not.toHaveBeenCalled();
});

const unsuccessfulFlags = [
	"cancel",
	"requestOverflow",
	"providerConfirmed",
	"evidenceTrimmedTurns",
] as const;
it.each(
	unsuccessfulFlags.flatMap((flag) =>
		["partial", "final"].map((stage) => [stage, flag] as const),
	),
)("rejects %s mixed attempt (%s)", async (stage, flag) => {
	const f = fixture();
	const invalid: Partial<Attempt> = {};
	if (flag === "evidenceTrimmedTurns") invalid.evidenceTrimmedTurns = 1;
	else invalid[flag] = true;
	f.execute.mockImplementation(async (prepared) => ({
		...f.complete(prepared),
		...((stage === "final") === (prepared.fileOps === f.preparation.fileOps)
			? invalid
			: {}),
	}));
	const attempt = await f.run();
	expect(attempt).toMatchObject({
		cancel: true,
		result: undefined,
		fallbackReason: RECOVERY_FAILED_REASON,
	});
});

it("keeps captured metadata stable across requests", async () => {
	const f = fixture();
	const fileOps = f.preparation.fileOps;
	f.execute.mockImplementation(async (prepared) => {
		f.preparation.firstKeptEntryId = "changed";
		f.preparation.tokensBefore = 1;
		f.preparation.settings.reserveTokens = 0;
		return f.complete(prepared);
	});
	const attempt = await f.run();
	expect(attempt.result).toMatchObject({
		firstKeptEntryId: "kept",
		tokensBefore: 28_000,
	});
	const finalPreparation = f.execute.mock.calls.at(-1)?.[0];
	expect(finalPreparation?.settings.reserveTokens).toBe(4096);
	expect(finalPreparation?.fileOps).toBe(fileOps);
});
