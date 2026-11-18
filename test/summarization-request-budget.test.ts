import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { generateSummaryWithUsage } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	clampReservedOutput,
	measureSummaryRequestTokens,
	piReservedOutputTokens,
	piReservedTurnPrefixOutputTokens,
} from "../src/summarization-request-budget.js";

type SummaryModel = Parameters<typeof generateSummaryWithUsage>[1];

function model(contextWindow = 200_000, maxTokens = 4096): SummaryModel {
	return {
		id: "budget-model",
		provider: "budget-test",
		api: "openai-completions",
		contextWindow,
		maxTokens,
	} as SummaryModel;
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}

const fetchSpy = vi.spyOn(globalThis, "fetch");

afterEach(() => {
	fetchSpy.mockClear();
});

describe("legacy reserved output fractions", () => {
	// Real 0.87.1/1.0.1 requests are pinned in provider-boundary-087.test.ts.
	it("names the legacy fractions without imposing them on the current SDK", () => {
		expect(piReservedOutputTokens(16_384)).toBe(13_107);
		expect(piReservedTurnPrefixOutputTokens(16_384)).toBe(8_192);
		expect(clampReservedOutput({ maxTokens: 4096 }, 13_107)).toBe(4096);
		expect(clampReservedOutput({ maxTokens: 4096 }, 8_192)).toBe(4096);
		expect(clampReservedOutput({ maxTokens: 0 }, 8_192)).toBe(8_192);
	});
});

describe("measureSummaryRequestTokens", () => {
	it("measures the whole summarisation request without any network call", async () => {
		const measurement = await measureSummaryRequestTokens({
			messages: [user(`Task: repair login.\n${"detail ".repeat(500)}`)],
			model: model(),
			reserveTokens: 16_384,
		});

		expect(measurement).toBeDefined();
		const total = measurement?.totalTokens ?? 0;
		const transcript = measurement?.transcriptTokens ?? 0;
		const output = measurement?.reservedOutputTokens ?? 0;
		expect(Number.isSafeInteger(total)).toBe(true);
		expect(total).toBe(transcript + output);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("declines an unspecified request cap when the model ceiling is zero", async () => {
		const measurement = await measureSummaryRequestTokens({
			messages: [user("Task: repair login.")],
			model: model(200_000, 0),
			reserveTokens: 16_384,
		});

		// Pi 1.5.2 omits the request cap; zero is not a usable default ceiling.
		expect(measurement).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("does not measure image payload the summarization request never sends", async () => {
		const transcript = [user(`Task: repair login.\n${"detail ".repeat(500)}`)];
		const imageMessage = {
			role: "assistant",
			content: [
				{ type: "image", data: "x".repeat(1_000_000), mimeType: "image/png" },
			],
			timestamp: 2,
		} as unknown as AgentMessage;

		const without = await measureSummaryRequestTokens({
			messages: transcript,
			model: model(),
			reserveTokens: 16_384,
		});
		const withImage = await measureSummaryRequestTokens({
			messages: [...transcript, imageMessage],
			model: model(),
			reserveTokens: 16_384,
		});

		// Pi renders the summarization conversation through serializeConversation, which drops
		// image blocks (it keeps user and assistant text, thinking, tool calls, and truncated tool
		// results), so a megabyte of image data is not part of the request being measured and must
		// not move the guard's numbers.
		expect(without).toBeDefined();
		expect(withImage).toBeDefined();
		expect(withImage?.transcriptTokens).toBe(without?.transcriptTokens);
		expect(withImage?.totalTokens).toBe(without?.totalTokens);
	});

	it("reserves the same output budget Pi reserves for the summary", async () => {
		const measurement = await measureSummaryRequestTokens({
			messages: [user("short")],
			model: model(200_000, 8192),
			reserveTokens: 16_384,
		});

		// Pi 1.5.2 omits an explicit cap, so use the configured model ceiling.
		expect(measurement?.reservedOutputTokens).toBe(8192);
	});

	it("clamps a caller-supplied output budget to the model cap Pi clamps to", async () => {
		const measurement = await measureSummaryRequestTokens({
			messages: [user("short")],
			model: model(200_000, 4096),
			reserveTokens: 16_384,
			reservedOutputTokens: 120_000,
		});

		// A legacy override cannot exceed the configured model ceiling.
		expect(measurement?.reservedOutputTokens).toBe(4096);
		expect(measurement?.totalTokens).toBe(
			(measurement?.transcriptTokens ?? 0) + 4096,
		);
	});

	it("grows with the transcript it has to summarise", async () => {
		const small = await measureSummaryRequestTokens({
			messages: [user("short task")],
			model: model(),
			reserveTokens: 16_384,
		});
		const large = await measureSummaryRequestTokens({
			messages: [user(`Task: repair login.\n${"old context ".repeat(60_000)}`)],
			model: model(),
			reserveTokens: 16_384,
		});

		expect(small?.totalTokens).toBeLessThan(large?.totalTokens ?? 0);
	});

	it("counts the carried-forward previous summary", async () => {
		const without = await measureSummaryRequestTokens({
			messages: [user("short task")],
			model: model(),
			reserveTokens: 16_384,
		});
		const withSummary = await measureSummaryRequestTokens({
			messages: [user("short task")],
			model: model(),
			reserveTokens: 16_384,
			previousSummary: "## Prior summary\n".repeat(400),
		});

		expect(withSummary?.totalTokens).toBeGreaterThan(without?.totalTokens ?? 0);
	});

	it("returns undefined when the request cannot be measured", async () => {
		const messages = [user("short task")];
		const unusable: Array<{
			model: SummaryModel | null;
			reserveTokens: unknown;
		}> = [
			{ model: null, reserveTokens: 16_384 },
			{ model: model(), reserveTokens: 0 },
			{ model: model(), reserveTokens: undefined },
			{ model: model(), reserveTokens: 1.5 },
			{ model: { ...model(), contextWindow: 0 }, reserveTokens: 16_384 },
			{ model: { ...model(), maxTokens: -1 }, reserveTokens: 16_384 },
		];
		for (const entry of unusable) {
			await expect(
				measureSummaryRequestTokens({
					messages,
					model: entry.model,
					reserveTokens: entry.reserveTokens,
				}),
			).resolves.toBeUndefined();
		}
	});
});
