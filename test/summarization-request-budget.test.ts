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

describe("reserved output fractions", () => {
	it("names the two output fractions Pi uses for its summarization requests", () => {
		// Mirrors Pi's dist/core/compaction/compaction.js: generateSummaryWithUsage reserves
		// floor(0.8 * reserveTokens) and the private generateTurnPrefixSummary reserves
		// floor(0.5 * reserveTokens). Both are then min()'d against model.maxTokens, which
		// clampReservedOutput reproduces.
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

	it("measures a model whose output cap is zero", async () => {
		const measurement = await measureSummaryRequestTokens({
			messages: [user("Task: repair login.")],
			model: model(200_000, 0),
			reserveTokens: 16_384,
		});

		// Pi clamps the request rather than leaving it unmeasurable, so the guard
		// stays active for a model configured with maxTokens 0.
		expect(Number.isSafeInteger(measurement?.totalTokens)).toBe(true);
		expect(measurement?.totalTokens).toBe(
			(measurement?.transcriptTokens ?? 0) +
				(measurement?.reservedOutputTokens ?? 0),
		);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("reserves the same output budget Pi reserves for the summary", async () => {
		const measurement = await measureSummaryRequestTokens({
			messages: [user("short")],
			model: model(200_000, 8192),
			reserveTokens: 16_384,
		});

		// Pi's generateSummaryWithUsage sends min(floor(0.8 * reserveTokens), model.maxTokens).
		expect(measurement?.reservedOutputTokens).toBe(
			Math.min(Math.floor(0.8 * 16_384), 8192),
		);
	});

	it("clamps a caller-supplied output budget to the model cap Pi clamps to", async () => {
		const measurement = await measureSummaryRequestTokens({
			messages: [user("short")],
			model: model(200_000, 4096),
			reserveTokens: 16_384,
			reservedOutputTokens: 120_000,
		});

		// Pi sends min(fraction * reserveTokens, model.maxTokens); the measurement
		// must model that, not the unclamped fraction the caller named.
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
