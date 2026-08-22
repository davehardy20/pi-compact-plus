import { afterEach, describe, expect, it, vi } from "vitest";
import { formatStatusLines } from "../src/policy.js";
import type { CompactPlusStatus } from "../src/types.js";

const baseStatus = (
	overrides: Partial<CompactPlusStatus> = {},
): CompactPlusStatus => ({
	usagePercent: null,
	usageTokens: null,
	contextWindow: null,
	usageSource: "unknown",
	band: "unknown",
	effectiveBand: null,
	selectedMode: null,
	isCompacting: false,
	cooldownActive: false,
	cooldownRemainingMs: 0,
	lastCompaction: null,
	lastFallbackReason: null,
	lastInjectedEcho: null,
	telemetryPersistenceIssues: [],
	...overrides,
});

describe("formatStatusLines characterization", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("renders the default unknown status in stable order", () => {
		expect(formatStatusLines(baseStatus())).toEqual([
			"📦 Compact+ status",
			"  Usage: unknown (unknown / unknown tokens)",
			"  Source: unknown",
			"  Threshold mode: effective_cap",
			"  Percent band: unknown",
			"  Token band: unknown",
			"  Effective band: none",
			"  Thresholds:",
			"    percent checkpoint=65% standard=70% hard=90%",
			"    tokens checkpoint=185,000 standard=200,000 hard=260,000",
			"    cooldown=120s",
			"  Config reload: threshold/cooldown changes require /reload or restart",
			"  Selected mode: none",
			"  Cooldown: ready",
			"  Compacting: idle",
			"  Last focus echo: (none — no compaction summary detected yet)",
		]);
	});

	it("renders configured thresholds, usage, cooldown, and active state", () => {
		expect(
			formatStatusLines(
				baseStatus({
					usagePercent: 12.34,
					usageTokens: 210_000,
					contextWindow: 1_000_000,
					usageSource: "estimated",
					band: "checkpoint custom",
					effectiveBand: "checkpoint",
					selectedMode: "hard",
					isCompacting: true,
					cooldownActive: true,
					cooldownRemainingMs: 1_501,
					thresholdSettings: {
						thresholdMode: "tokens",
						checkpointThresholdPercent: 50,
						standardThresholdPercent: 60,
						hardThresholdPercent: 80,
						checkpointThresholdTokens: 150_000,
						standardThresholdTokens: 220_000,
						hardThresholdTokens: 280_000,
						cooldownMs: 30_000,
					},
				}),
			),
		).toEqual([
			"📦 Compact+ status",
			"  Usage: 12.3% (210,000 / 1,000,000 tokens)",
			"  Source: estimated",
			"  Threshold mode: tokens",
			"  Percent band: checkpoint custom",
			"  Token band: checkpoint candidate (150,000-219,999 tokens)",
			"  Effective band: checkpoint",
			"  Thresholds:",
			"    percent checkpoint=50% standard=60% hard=80%",
			"    tokens checkpoint=150,000 standard=220,000 hard=280,000",
			"    cooldown=30s",
			"  Config reload: threshold/cooldown changes require /reload or restart",
			"  Selected mode: hard",
			"  Cooldown: 2s remaining",
			"  Compacting: in progress",
			"  Last focus echo: (none — no compaction summary detected yet)",
		]);
	});

	it("renders native unknown usage and telemetry persistence warnings", () => {
		expect(
			formatStatusLines(
				baseStatus({
					usageSource: "native",
					contextWindow: 272_000,
					telemetryPersistenceIssues: [
						{
							operation: "load",
							code: "corrupt-json",
							path: "/state/telemetry.json",
							message: "invalid JSON",
							timestamp: 1,
							quarantinePath: "/state/telemetry.json.corrupt",
						},
						{
							operation: "save",
							code: "write-failed",
							path: "/state/telemetry.json",
							message: "permission denied",
							timestamp: 2,
						},
					],
				}),
			),
		).toEqual([
			"📦 Compact+ status",
			"  Usage: unknown (unknown / 272,000 tokens)",
			"  Source: native",
			"  Threshold mode: effective_cap",
			"  Percent band: unknown",
			"  Token band: unknown",
			"  Effective band: none",
			"  Thresholds:",
			"    percent checkpoint=65% standard=70% hard=90%",
			"    tokens checkpoint=185,000 standard=200,000 hard=260,000",
			"    cooldown=120s",
			"  Config reload: threshold/cooldown changes require /reload or restart",
			"  Selected mode: none",
			"  Cooldown: ready",
			"  Compacting: idle",
			"  Usage detail: Pi reports usage as unknown until the next assistant response after compaction.",
			"  Telemetry persistence warnings:",
			"    load/corrupt-json: invalid JSON (/state/telemetry.json)",
			"      Quarantined: /state/telemetry.json.corrupt",
			"    save/write-failed: permission denied (/state/telemetry.json)",
			"  Last focus echo: (none — no compaction summary detected yet)",
		]);
	});

	it("explains native usage only when either metric is unknown", () => {
		const detail =
			"  Usage detail: Pi reports usage as unknown until the next assistant response after compaction.";
		const known = formatStatusLines(
			baseStatus({
				usagePercent: 10,
				usageTokens: 20_000,
				contextWindow: 200_000,
				usageSource: "native",
			}),
		);
		const tokensUnknown = formatStatusLines(
			baseStatus({
				usagePercent: 10,
				contextWindow: 200_000,
				usageSource: "native",
			}),
		);
		const percentUnknown = formatStatusLines(
			baseStatus({
				usageTokens: 20_000,
				contextWindow: 200_000,
				usageSource: "native",
			}),
		);

		expect(known).toHaveLength(16);
		expect(known).not.toContain(detail);
		expect(tokensUnknown).toContain(detail);
		expect(percentUnknown).toContain(detail);
	});

	it("renders every optional compaction detail and a multiline focus echo", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
		const timestamp = Date.now() - 4_600;

		const lines = formatStatusLines(
			baseStatus({
				lastCompaction: {
					mode: "hard",
					triggerSource: "turn_end",
					triggerReason: "threshold reached",
					timestamp,
					focusTags: ["policy.ts", "", "policy.ts", "types.ts"],
					previousSummaryPresent: true,
					splitTurn: true,
					usageSource: "native",
					fallbackReason: "custom summary rejected",
					messagesSummarizedCount: 12,
					executionPath: "custom",
					fromExtension: true,
					thinkingLevel: "minimal",
					compatibilityReason: "session stream unavailable",
				},
				lastFallbackReason: "top-level fallback",
				lastInjectedEcho: "Objective: preserve output\nNext: refactor safely",
			}),
		);

		expect(lines.slice(-13)).toEqual([
			"  Last compaction: hard mode, turn_end trigger, 5s ago",
			"    Reason: threshold reached",
			"    Path: custom (Compact+)",
			"    Thinking level: minimal",
			"    Focus files: policy.ts, types.ts",
			"    Prior summary: merged",
			"    Split-turn: yes",
			"    Compatibility: session stream unavailable",
			"    Fallback: custom summary rejected",
			"  Last fallback: top-level fallback",
			"  Last focus echo:",
			"    Objective: preserve output",
			"    Next: refactor safely",
		]);
	});

	it("suppresses duplicate fallback detail and identifies a native path", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
		const fallbackReason = "session streaming unavailable";
		const lines = formatStatusLines(
			baseStatus({
				lastCompaction: {
					mode: "standard",
					triggerSource: "command",
					triggerReason: "",
					timestamp: Date.now(),
					focusTags: [],
					previousSummaryPresent: false,
					splitTurn: false,
					usageSource: "unknown",
					fallbackReason,
					messagesSummarizedCount: 0,
					executionPath: "native-fallback",
					fromExtension: false,
					thinkingLevel: null,
					compatibilityReason: fallbackReason,
				},
				lastFallbackReason: fallbackReason,
			}),
		);

		expect(lines.slice(15)).toEqual([
			"  Last compaction: standard mode, command trigger, 0s ago",
			"    Path: native-fallback (native Pi)",
			`    Fallback: ${fallbackReason}`,
			"  Last focus echo: (none — last compaction fell back before a custom summary was injected)",
		]);
	});

	it("distinguishes missing persisted echo from a top-level fallback", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-22T12:00:00.000Z"));
		const completedWithoutEcho = formatStatusLines(
			baseStatus({
				lastCompaction: {
					mode: "standard",
					triggerSource: "message_end",
					triggerReason: "automatic threshold",
					timestamp: Date.now(),
					focusTags: [],
					previousSummaryPresent: false,
					splitTurn: false,
					usageSource: "estimated",
					messagesSummarizedCount: 3,
					executionPath: "custom",
					fromExtension: true,
				},
			}),
		);
		const topLevelFallback = formatStatusLines(
			baseStatus({ lastFallbackReason: "custom compaction failed" }),
		);

		expect(completedWithoutEcho.slice(15)).toEqual([
			"  Last compaction: standard mode, message_end trigger, 0s ago",
			"    Reason: automatic threshold",
			"    Path: custom (Compact+)",
			"  Last focus echo: (none — no persisted focus echo is available for the last compaction)",
		]);
		expect(topLevelFallback.slice(-2)).toEqual([
			"  Last fallback: custom compaction failed",
			"  Last focus echo: (none — last compaction fell back before a custom summary was injected)",
		]);
	});
});
