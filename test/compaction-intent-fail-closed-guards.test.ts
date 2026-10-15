import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";

const { fakeGenerate } = vi.hoisted(() => ({ fakeGenerate: vi.fn() }));

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return { ...actual, generateSummaryWithUsage: fakeGenerate };
});

import { prepareBudgetedCompactionFocus } from "../src/compaction-intent.js";
import { measureSummaryRequestTokens } from "../src/summarization-request-budget.js";

/**
 * Characterization tests for the fail-closed capture and trim-probe guards
 * (src/summarization-request-budget.ts:125-146, src/compaction-intent.ts:197-266).
 * These branches are the no-coverage mutants in the mutation report: today nothing
 * drives a capture failure or a probe failure through the public interface. The SDK
 * summary call is replaced with a controllable capture so each arm is reached
 * deliberately; the modules under test run unchanged.
 */

type SummaryModel = Parameters<
	typeof import("@earendil-works/pi-coding-agent").generateSummaryWithUsage
>[1];

function model(contextWindow = 1_000, maxTokens = 4_096): SummaryModel {
	return {
		id: "capture-model",
		provider: "capture-test",
		api: "openai-completions",
		contextWindow,
		maxTokens,
	} as SummaryModel;
}

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: 1 } as AgentMessage;
}

type CaptureBehaviour = {
	baseChars?: number;
	/** Call index that resolves normally instead of capturing. */
	resolveNormallyAt?: number;
	/** Call index that throws a foreign provider error. */
	foreignErrorAt?: number;
	/** Call index that captures a context with no system message. */
	noSystemMessageAt?: number;
	/** Call index that invokes the stream function twice. */
	doubleCaptureAt?: number;
	/** Run before the given call index (used to abort mid-search). */
	beforeCall?: (call: number) => void;
};

function armCapture(behaviour: CaptureBehaviour) {
	let calls = 0;
	fakeGenerate.mockImplementation(
		async (
			_messages: unknown,
			modelArg: { maxTokens: number },
			reserve: number,
			_signalHolder: unknown,
			_extra: unknown,
			_signal: unknown,
			customInstructions: string | undefined,
			_previousSummary: unknown,
			_thinkingLevel: unknown,
			streamFn: (
				m: unknown,
				context: { messages: { role: string; content: string }[] },
				options: { maxTokens: number },
			) => unknown,
		) => {
			calls++;
			behaviour.beforeCall?.(calls);
			if (behaviour.resolveNormallyAt === calls) {
				return { summary: "captured normally", usage: {} };
			}
			const transcriptChars =
				(behaviour.baseChars ?? 2_000) + (customInstructions?.length ?? 0);
			const output = Math.min(
				Math.floor(0.8 * reserve),
				modelArg.maxTokens ?? 0,
			);
			const context = {
				messages: [
					{
						role: behaviour.noSystemMessageAt === calls ? "user" : "system",
						content: "x".repeat(transcriptChars),
					},
				],
			};
			const options = { maxTokens: output };
			if (behaviour.foreignErrorAt === calls) {
				// Capture once, so the captured token fields are valid and marker identity
				// is the only remaining rejection condition.
				try {
					await streamFn(modelArg, context, options);
				} catch {
					// The capture marker is swallowed; the foreign failure replaces it.
				}
				throw new Error("provider transport failed");
			}
			if (behaviour.doubleCaptureAt === calls) {
				try {
					await streamFn(modelArg, context, options);
				} catch {
					// The capture marker is swallowed so the second invocation runs.
				}
				return await streamFn(modelArg, context, options);
			}
			return await streamFn(modelArg, context, options);
		},
	);
}

afterEach(() => {
	fakeGenerate.mockReset();
});

describe("measureSummaryRequestTokens capture rejects", () => {
	it("returns no measurement when the SDK summarizes without ever capturing the request", async () => {
		armCapture({ resolveNormallyAt: 1 });

		const measurement = await measureSummaryRequestTokens({
			messages: [user("Task: repair login.")],
			model: model(),
			reserveTokens: 100,
		});

		expect(measurement).toBeUndefined();
	});

	it("returns no measurement when the request is captured more than once", async () => {
		armCapture({ doubleCaptureAt: 1 });

		const measurement = await measureSummaryRequestTokens({
			messages: [user("Task: repair login.")],
			model: model(),
			reserveTokens: 100,
		});

		expect(measurement).toBeUndefined();
	});

	it("returns no measurement when the captured request carries no system message", async () => {
		armCapture({ noSystemMessageAt: 1 });

		const measurement = await measureSummaryRequestTokens({
			messages: [user("Task: repair login.")],
			model: model(),
			reserveTokens: 100,
		});

		expect(measurement).toBeUndefined();
	});

	it("swallows a foreign provider failure as an unmeasurable request", async () => {
		// The capture succeeds first, so the only reason this measurement can fail is
		// that the thrown error is not the capture marker.
		armCapture({ foreignErrorAt: 1 });

		const measurement = await measureSummaryRequestTokens({
			messages: [user("Task: repair login.")],
			model: model(),
			reserveTokens: 100,
		});

		expect(measurement).toBeUndefined();
		expect(fakeGenerate).toHaveBeenCalledTimes(1);
	});

	it("ignores an invalid reserved-output override and keeps the SDK-reported output budget", async () => {
		armCapture({});

		const measurement = await measureSummaryRequestTokens({
			messages: [user("Task: repair login.")],
			model: model(),
			reserveTokens: 100,
			reservedOutputTokens: -5,
		});

		// The production guarantee is the arithmetic and the fallback to the captured
		// output budget, not any particular estimator result for the synthetic context.
		expect(measurement?.reservedOutputTokens).toBe(80);
		expect(measurement?.totalTokens).toBe(
			(measurement?.transcriptTokens ?? 0) + 80,
		);
	});
});

describe("prepareBudgetedCompactionFocus trim-probe guards", () => {
	const projected = [
		user("First retained request."),
		user("Second retained request."),
		user("Third retained request."),
		user("Fourth retained request."),
	];

	function preparation() {
		return {
			messagesToSummarize: [],
			turnPrefixMessages: [],
			isSplitTurn: false,
			settings: { enabled: true, keepRecentTokens: 100, reserveTokens: 100 },
		};
	}

	/**
	 * Arithmetic for a 1,000-token window with a 100-token reserve (80 reserved output):
	 * the transcript alone is 500 tokens and fits; each admitted evidence turn adds 150
	 * tokens, so four turns overflow and a two-turn trim fits.
	 */
	function renderInstructions(focus: {
		intentEvidence?: { recentUserTurns?: string[] };
	}) {
		return (
			`base prompt ${"y".repeat(100)} ` +
			(focus.intentEvidence?.recentUserTurns ?? [])
				.map((turn) => `evidence ${"z".repeat(500)} ${turn}`)
				.join("\n")
		);
	}

	it("stops probing and rejects as evidence-driven when the signal aborts mid-search", async () => {
		const controller = new AbortController();
		// The first measurement (with evidence) and the baseline (without evidence) both
		// run; the abort lands before the first probe.
		armCapture({ beforeCall: (call) => call >= 2 && controller.abort() });

		const result = await prepareBudgetedCompactionFocus(
			projected,
			preparation(),
			{
				model: model(),
				renderInstructions,
				signal: controller.signal,
			},
		);

		expect(result.renderedInstructions).toBeUndefined();
		expect(result.transcriptOverflow).toBeUndefined();
		expect(result.evidenceTrimmed).toBeUndefined();
		expect(result.focus.intentEvidence?.overflow).toBe(true);
	});

	it("rejects as evidence-driven when a probe cannot render its instructions", async () => {
		let renders = 0;
		armCapture({});

		const result = await prepareBudgetedCompactionFocus(
			projected,
			preparation(),
			{
				model: model(),
				renderInstructions: (focus) => {
					renders++;
					if (renders > 1) throw new Error("focus rendering failed");
					return renderInstructions(focus);
				},
			},
		);

		expect(result.renderedInstructions).toBeUndefined();
		expect(result.transcriptOverflow).toBeUndefined();
		expect(result.focus.intentEvidence?.overflow).toBe(true);
	});

	it("rejects as evidence-driven when a probe cannot measure its trimmed request", async () => {
		// Call 1: full evidence (overflows). Call 2: baseline (fits). Call 3: probe, which
		// fails to capture and must fail closed rather than send an unchecked cut.
		armCapture({ resolveNormallyAt: 3 });

		const result = await prepareBudgetedCompactionFocus(
			projected,
			preparation(),
			{
				model: model(),
				renderInstructions,
			},
		);

		expect(result.renderedInstructions).toBeUndefined();
		expect(result.transcriptOverflow).toBeUndefined();
		expect(result.focus.intentEvidence?.overflow).toBe(true);
	});

	it("trims the oldest evidence and returns the fitted request when a probe fits", async () => {
		armCapture({});

		const result = await prepareBudgetedCompactionFocus(
			projected,
			preparation(),
			{
				model: model(),
				renderInstructions,
			},
		);

		expect(result.renderedInstructions).toBeDefined();
		expect(result.evidenceTrimmed).toBe(2);
		expect(result.transcriptOverflow).toBeUndefined();
		expect(result.focus.intentEvidence?.recentUserTurns).toHaveLength(2);
	});
});
