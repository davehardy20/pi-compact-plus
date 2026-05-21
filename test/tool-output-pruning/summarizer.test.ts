import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock completeSimple before importing the module under test
vi.mock("@earendil-works/pi-ai", () => ({
	completeSimple: vi.fn(),
}));

import { completeSimple } from "@earendil-works/pi-ai";
const mockCompleteSimple = vi.mocked(completeSimple);

import {
	resolveSummarizerModel,
	buildSummarizerPrompt,
	summarizeBatch,
	SUMMARIZER_SYSTEM_PROMPT,
	SUMMARIZER_USER_PROMPT_PREFIX,
	type SummarizerInput,
} from "../../src/tool-output-pruning/summarizer.js";
import type { ExtensionContext, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";

function makeMockModel(id: string, provider: string): Model<Api> {
	return {
		id,
		name: id,
		api: "openai-completions" as Api,
		provider,
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function makeMockContext(
	model?: Model<Api>,
	registryOverrides?: Partial<ModelRegistry>,
): ExtensionContext {
	const registry = {
		find: vi.fn(),
		getApiKeyAndHeaders: vi.fn(async () => ({
			ok: true as const,
			apiKey: "test-key",
			headers: { "X-Test": "1" },
		})),
		...registryOverrides,
	} as unknown as ModelRegistry;

	return {
		model,
		modelRegistry: registry,
		hasUI: false,
		ui: {
			notify: vi.fn(),
		} as unknown as ExtensionContext["ui"],
	} as unknown as ExtensionContext;
}

describe("resolveSummarizerModel", () => {
	const currentModel = makeMockModel("current-model", "anthropic");

	it('returns current model for "default"', () => {
		const ctx = makeMockContext(currentModel);
		const result = resolveSummarizerModel(
			{ toolOutputSummarizerModel: "default" },
			ctx,
		);
		expect(result.model).toBe(currentModel);
		expect(result.isFallback).toBe(false);
		expect(result.warning).toBeUndefined();
	});

	it("looks up explicit provider/model-id in registry", () => {
		const explicitModel = makeMockModel("gpt-4", "openai");
		const ctx = makeMockContext(currentModel, {
			find: vi.fn(() => explicitModel),
		});
		const result = resolveSummarizerModel(
			{ toolOutputSummarizerModel: "openai/gpt-4" },
			ctx,
		);
		expect(ctx.modelRegistry.find).toHaveBeenCalledWith("openai", "gpt-4");
		expect(result.model).toBe(explicitModel);
		expect(result.isFallback).toBe(false);
	});

	it("falls back to current model when explicit model is not found", () => {
		const ctx = makeMockContext(currentModel, {
			find: vi.fn(() => undefined),
		});
		const result = resolveSummarizerModel(
			{ toolOutputSummarizerModel: "openai/gpt-missing" },
			ctx,
		);
		expect(result.model).toBe(currentModel);
		expect(result.isFallback).toBe(true);
		expect(result.warning).toContain("not found");
	});

	it("falls back for invalid model spec (no slash)", () => {
		const ctx = makeMockContext(currentModel);
		const result = resolveSummarizerModel(
			{ toolOutputSummarizerModel: "invalid" },
			ctx,
		);
		expect(result.model).toBe(currentModel);
		expect(result.isFallback).toBe(true);
		expect(result.warning).toContain("Invalid summarizer model spec");
	});

	it("falls back for empty provider or model id", () => {
		const ctx = makeMockContext(currentModel);
		const result = resolveSummarizerModel(
			{ toolOutputSummarizerModel: "/model" },
			ctx,
		);
		expect(result.isFallback).toBe(true);
	});
});

describe("buildSummarizerPrompt", () => {
	it("includes prefix and all inputs", () => {
		const inputs: SummarizerInput[] = [
			{
				recordId: "r1",
				shortRef: "t1",
				toolCallId: "tc1",
				toolName: "bash",
				text: "line1\nline2",
				isError: false,
				argsPreview: "ls -la",
			},
		];
		const prompt = buildSummarizerPrompt(inputs, 10000);
		expect(prompt).toContain(SUMMARIZER_USER_PROMPT_PREFIX);
		expect(prompt).toContain("t1");
		expect(prompt).toContain("bash");
		expect(prompt).toContain("tc1");
		expect(prompt).toContain("line1");
		expect(prompt).toContain("args: ls -la");
	});

	it("marks errors in headers", () => {
		const inputs: SummarizerInput[] = [
			{
				recordId: "r1",
				shortRef: "t1",
				toolCallId: "tc1",
				toolName: "bash",
				text: "error text",
				isError: true,
				argsPreview: null,
			},
		];
		const prompt = buildSummarizerPrompt(inputs, 10000);
		expect(prompt).toContain("| ERROR");
	});

	it("truncates text longer than maxCharsPerInput", () => {
		const inputs: SummarizerInput[] = [
			{
				recordId: "r1",
				shortRef: "t1",
				toolCallId: "tc1",
				toolName: "bash",
				text: "a".repeat(500),
				isError: false,
				argsPreview: null,
			},
		];
		const prompt = buildSummarizerPrompt(inputs, 100);
		expect(prompt).toContain("a".repeat(100));
		expect(prompt).toContain("…[truncated]");
	});

	it("includes multiple inputs separated by headers", () => {
		const inputs: SummarizerInput[] = [
			{
				recordId: "r1",
				shortRef: "t1",
				toolCallId: "tc1",
				toolName: "bash",
				text: "output1",
				isError: false,
				argsPreview: null,
			},
			{
				recordId: "r2",
				shortRef: "t2",
				toolCallId: "tc2",
				toolName: "read",
				text: "output2",
				isError: false,
				argsPreview: null,
			},
		];
		const prompt = buildSummarizerPrompt(inputs, 10000);
		const t1Count = (prompt.match(/t1/g) || []).length;
		const t2Count = (prompt.match(/t2/g) || []).length;
		expect(t1Count).toBeGreaterThanOrEqual(1);
		expect(t2Count).toBeGreaterThanOrEqual(1);
		expect(prompt).toContain("output1");
		expect(prompt).toContain("output2");
	});
});

describe("summarizeBatch", () => {
	beforeEach(() => {
		mockCompleteSimple.mockReset();
	});

	it("returns empty success for empty inputs", async () => {
		const ctx = makeMockContext(makeMockModel("m", "p"));
		const result = await summarizeBatch(
			[],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.summaries.size).toBe(0);
			expect(result.totalChars).toBe(0);
		}
	});

	it("returns failure when no model is available", async () => {
		const ctx = makeMockContext(undefined);
		const result = await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("No model available");
			expect(result.aborted).toBe(false);
		}
	});

	it("returns failure when auth is unavailable", async () => {
		const ctx = makeMockContext(makeMockModel("m", "p"), {
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: false as const,
				error: "no key",
			})),
		});
		const result = await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("Auth unavailable");
			expect(result.aborted).toBe(false);
		}
	});

	it("parses structured summaries from LLM response", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [
				{
					type: "text",
					text: "## t1\nSummary one.\n\n## t2\nSummary two.",
				},
			],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: { input: 10, output: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const ctx = makeMockContext(makeMockModel("m", "p"));
		const result = await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "long output 1",
					isError: false,
					argsPreview: null,
				},
				{
					recordId: "r2",
					shortRef: "t2",
					toolCallId: "tc2",
					toolName: "read",
					text: "long output 2",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.summaries.get("r1")).toBe("Summary one.");
			expect(result.summaries.get("r2")).toBe("Summary two.");
			expect(result.totalChars).toBeGreaterThan(0);
		}
	});

	it("falls back to assigning whole response to first input when parsing fails", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [{ type: "text", text: "Unstructured single summary." }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: { input: 10, output: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const ctx = makeMockContext(makeMockModel("m", "p"));
		const result = await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.summaries.get("r1")).toBe("Unstructured single summary.");
		}
	});

	it("truncates summaries exceeding maxChars", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [
				{
					type: "text",
					text: `## t1\n${"a".repeat(5000)}`,
				},
			],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: { input: 10, output: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const ctx = makeMockContext(makeMockModel("m", "p"));
		const result = await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 100,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			const summary = result.summaries.get("r1")!;
			expect(summary.length).toBeLessThanOrEqual(101); // 100 + "…"
			expect(summary.endsWith("…")).toBe(true);
		}
	});

	it("returns failure for aborted stopReason", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: { input: 10, output: 0, totalTokens: 10, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "aborted",
			 timestamp: Date.now(),
		});

		const ctx = makeMockContext(makeMockModel("m", "p"));
		const result = await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.aborted).toBe(true);
			expect(result.error).toContain("aborted");
		}
	});

	it("returns failure for error stopReason", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: { input: 10, output: 0, totalTokens: 10, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "error",
			errorMessage: "Rate limited",
			timestamp: Date.now(),
		});

		const ctx = makeMockContext(makeMockModel("m", "p"));
		const result = await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.aborted).toBe(false);
			expect(result.error).toContain("Rate limited");
		}
	});

	it("returns failure for empty response text", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [{ type: "text", text: "   " }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: { input: 10, output: 1, totalTokens: 11, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const ctx = makeMockContext(makeMockModel("m", "p"));
		const result = await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("empty response");
		}
	});

	it("returns failure when completeSimple throws", async () => {
		mockCompleteSimple.mockRejectedValueOnce(new Error("Network failure"));

		const ctx = makeMockContext(makeMockModel("m", "p"));
		const result = await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain("Network failure");
			expect(result.aborted).toBe(false);
		}
	});

	it("marks aborted true for thrown AbortError", async () => {
		const err = new Error("aborted");
		err.name = "AbortError";
		mockCompleteSimple.mockRejectedValueOnce(err);

		const ctx = makeMockContext(makeMockModel("m", "p"));
		const result = await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);

		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.aborted).toBe(true);
		}
	});

	it("uses correct thinking level when configured", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [{ type: "text", text: "## t1\nOK" }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: { input: 10, output: 1, totalTokens: 11, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const ctx = makeMockContext(makeMockModel("m", "p"));
		await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "high",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);

		expect(mockCompleteSimple).toHaveBeenCalledTimes(1);
		const callArgs = mockCompleteSimple.mock.calls[0];
		expect(callArgs[2]).toMatchObject({ reasoning: "high" });
	});

	it("does not pass reasoning for default/off thinking", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [{ type: "text", text: "## t1\nOK" }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: { input: 10, output: 1, totalTokens: 11, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const ctx = makeMockContext(makeMockModel("m", "p"));
		await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "off",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);

		const callArgs = mockCompleteSimple.mock.calls[0];
		expect(callArgs[2]).not.toHaveProperty("reasoning");
	});

	it("passes abort signal to completeSimple", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [{ type: "text", text: "## t1\nOK" }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: { input: 10, output: 1, totalTokens: 11, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const ctx = makeMockContext(makeMockModel("m", "p"));
		const controller = new AbortController();
		await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
			{ signal: controller.signal },
		);

		const callArgs = mockCompleteSimple.mock.calls[0]!;
		expect(callArgs[2]!.signal).toBe(controller.signal);
	});

	it("ignores unknown refs in LLM response", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [
				{
					type: "text",
					text: "## t1\nReal.\n\n## t99\nUnknown.",
				},
			],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: { input: 10, output: 5, totalTokens: 15, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const ctx = makeMockContext(makeMockModel("m", "p"));
		const result = await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);

		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.summaries.has("r1")).toBe(true);
			expect(result.summaries.has("t99")).toBe(false);
		}
	});

	it("prompt includes system prompt and user message with correct shape", async () => {
		mockCompleteSimple.mockResolvedValueOnce({
			role: "assistant",
			content: [{ type: "text", text: "## t1\nOK" }],
			api: "openai-completions",
			provider: "openai",
			model: "gpt-4",
			usage: { input: 10, output: 1, totalTokens: 11, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		});

		const ctx = makeMockContext(makeMockModel("m", "p"));
		await summarizeBatch(
			[
				{
					recordId: "r1",
					shortRef: "t1",
					toolCallId: "tc1",
					toolName: "bash",
					text: "text",
					isError: false,
					argsPreview: null,
				},
			],
			{
				toolOutputSummaryMaxChars: 1600,
				toolOutputSummarizerModel: "default",
				toolOutputSummarizerThinking: "default",
			} as Parameters<typeof summarizeBatch>[1],
			ctx,
		);

		const callArgs = mockCompleteSimple.mock.calls[0];
		const context = callArgs[1] as {
			systemPrompt?: string;
			messages: Array<{ role: string; content: Array<{ type: string; text: string }> }>;
		};
		expect(context.systemPrompt).toBe(SUMMARIZER_SYSTEM_PROMPT);
		expect(context.messages).toHaveLength(1);
		expect(context.messages[0]!.role).toBe("user");
		expect(context.messages[0]!.content[0]!.type).toBe("text");
		expect(context.messages[0]!.content[0]!.text).toContain(SUMMARIZER_USER_PROMPT_PREFIX);
	});
});
