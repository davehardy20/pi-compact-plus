import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import type { CompactionCoordinator } from "./compaction-coordinator.js";
import { registerCompactPlusStatusCommand } from "./extension-status.js";
import type { PackageMetadataResolver } from "./package-metadata.js";
import {
	buildCheckpointData,
	formatCheckpointSummary,
	getCooldownRemainingMs,
	getModeFromEffectiveUsage,
	getTokenBandText,
	getUsageBandText,
	resolveThresholdSettings,
} from "./policy.js";
import { extractSessionSnapshot } from "./session-evidence.js";
import { currentProjectedMessages } from "./session-projection.js";
import {
	type CompactPlusThresholdSettings,
	resolveCompactPlusSettings,
} from "./settings.js";
import type { CompactionState } from "./state.js";
import { formatPruningStatusLines } from "./tool-output-pruning/commands.js";
import type { ToolOutputPruningCoordinator } from "./tool-output-pruning/coordinator.js";
import {
	formatToolOutputPruningStatusLine,
	isToolOutputPruningEnabled,
} from "./tool-output-pruning/policy.js";
import {
	CHECKPOINT_CUSTOM_TYPE,
	type CompactionMode,
	type CompactionTelemetry,
	type CompactPlusStatus,
	type EffectiveUsage,
	type TelemetryPersistenceIssue,
} from "./types.js";

export interface CompactPlusCommandRegistryOptions {
	state: CompactionState;
	toolOutputPruning: ToolOutputPruningCoordinator;
	compactionCoordinator: CompactionCoordinator;
	thresholdSettings: CompactPlusThresholdSettings;
	getEffectiveUsage: (ctx: ExtensionContext) => EffectiveUsage | null;
	getMetadata: PackageMetadataResolver;
}

export function formatToolOutputPruningStatusForState(
	state: CompactionState,
): string {
	const pruningSettings = resolveCompactPlusSettings();
	return formatToolOutputPruningStatusLine({
		enabled: isToolOutputPruningEnabled(pruningSettings),
		mode: pruningSettings.toolOutputPruningMode,
		strategy: pruningSettings.toolOutputPruneStrategy,
		activeRecordCount: state.toolOutputPruning.activeRecordCount,
		lastPrunedCount: state.toolOutputPruning.lastPrunedCount,
		lastSummaryStatus: state.toolOutputPruning.lastSummaryStatus,
		lastSummaryTime: state.toolOutputPruning.lastSummaryTime,
	});
}

export function registerCompactPlusCommands(
	pi: ExtensionAPI,
	{
		state,
		toolOutputPruning,
		compactionCoordinator,
		thresholdSettings,
		getEffectiveUsage,
		getMetadata,
	}: CompactPlusCommandRegistryOptions,
): void {
	pi.registerCommand("compact-plus", {
		description:
			"Compact+ context compaction. Usage: /compact-plus [hard|status|tool-prune status|tool-prune flush]",
		handler: async (args, ctx) => {
			const trimmed = args.trim().toLowerCase();

			if (trimmed.startsWith("tool-prune ")) {
				const sub = trimmed.slice("tool-prune ".length).trim();

				if (sub === "status") {
					const detail = toolOutputPruning.buildStatusDetail();
					const lines = formatPruningStatusLines(detail);
					ctx.ui.notify(lines.join("\n"), "info");
					return;
				}

				if (sub === "flush") {
					const result = await toolOutputPruning.manualFlush(ctx, pi);
					ctx.ui.notify(result.message, result.ok ? "info" : "warning");
					return;
				}

				ctx.ui.notify(
					"Usage: /compact-plus tool-prune [status|flush]",
					"warning",
				);
				return;
			}

			if (trimmed === "status") {
				const usage = getEffectiveUsage(ctx);
				const status = buildStatusSnapshot({
					usage,
					selectedMode: state.selectedMode,
					isCompacting: state.isCompacting,
					lastCompactTime: state.lastCompactTime,
					lastCompaction: state.lastCompaction,
					lastFallbackReason: state.lastFallbackReason,
					lastInjectedEcho: state.lastInjectedEcho,
					telemetryPersistenceIssues: state.telemetryPersistenceIssues,
					settings: thresholdSettings,
				});
				const lines = formatStatusLines(status);
				lines.push(formatToolOutputPruningStatusForState(state));
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}

			const mode = trimmed === "hard" ? "hard" : "standard";
			await compactionCoordinator.handleManualCommand(mode, ctx);
		},
	});

	pi.registerCommand("checkpoint", {
		description: "Save a lightweight checkpoint. Usage: /checkpoint [note]",
		handler: async (args, ctx) => {
			const note = args.trim() || undefined;
			const snapshot = extractSessionSnapshot(currentProjectedMessages(ctx));
			const data = buildCheckpointData(note, snapshot);
			pi.appendEntry(CHECKPOINT_CUSTOM_TYPE, data);
			ctx.ui.notify(formatCheckpointSummary(data), "info");
		},
	});

	registerCompactPlusStatusCommand(pi, {
		getMetadata,
		getStatusState: () => ({
			isCompacting: state.isCompacting,
			selectedMode: state.selectedMode,
			lastCompactTime: state.lastCompactTime,
			echoInjected: state.echoInjected,
			lastModelKey: state.lastModelKey,
		}),
		getPruningLine: () => formatToolOutputPruningStatusForState(state),
	});
}

// --- Status snapshot assembly and formatting (presentation seam; moved from policy.ts) ---

export function buildStatusSnapshot(args: {
	usage: EffectiveUsage | null;
	selectedMode: CompactionMode | null;
	isCompacting: boolean;
	lastCompactTime: number;
	lastCompaction: CompactionTelemetry | null;
	lastFallbackReason: string | null;
	lastInjectedEcho: string | null;
	telemetryPersistenceIssues?: TelemetryPersistenceIssue[];
	settings?: CompactPlusThresholdSettings;
}): CompactPlusStatus {
	const settings = resolveThresholdSettings(args.settings);
	const now = Date.now();
	const cooldownRemainingMs = getCooldownRemainingMs(
		now,
		args.lastCompactTime,
		settings,
	);
	const usage = args.usage;
	const effectiveBand =
		usage === null
			? null
			: getModeFromEffectiveUsage(
					{
						percent: usage.percent,
						tokens: usage.tokens,
						contextWindow: usage.contextWindow,
						source: usage.source,
					},
					settings,
				);
	return {
		usagePercent: args.usage?.percent ?? null,
		usageTokens: args.usage?.tokens ?? null,
		contextWindow: args.usage?.contextWindow ?? null,
		usageSource: args.usage?.source ?? "unknown",
		band: getUsageBandText(args.usage?.percent ?? null, settings),
		effectiveBand,
		selectedMode: args.selectedMode,
		isCompacting: args.isCompacting,
		cooldownActive: cooldownRemainingMs > 0,
		cooldownRemainingMs,
		lastCompaction: args.lastCompaction,
		lastFallbackReason: args.lastFallbackReason,
		lastInjectedEcho: args.lastInjectedEcho,
		telemetryPersistenceIssues: args.telemetryPersistenceIssues ?? [],
		thresholdSettings: settings,
	};
}

function formatUsagePercent(percent: number | null): string {
	return percent === null ? "unknown" : `${percent.toFixed(1)}%`;
}

function formatNullableNumber(value: number | null): string {
	return value === null ? "unknown" : value.toLocaleString();
}

function formatOptionalMode(mode: CompactionMode | null): string {
	return mode ?? "none";
}

function formatCooldown(status: CompactPlusStatus): string {
	return status.cooldownActive
		? `${Math.ceil(status.cooldownRemainingMs / 1000)}s remaining`
		: "ready";
}

function formatCompacting(isCompacting: boolean): string {
	return isCompacting ? "in progress" : "idle";
}

function formatStatusCoreLines(
	status: CompactPlusStatus,
	settings: CompactPlusThresholdSettings,
): string[] {
	return [
		"📦 Compact+ status",
		`  Usage: ${formatUsagePercent(status.usagePercent)} (${formatNullableNumber(status.usageTokens)} / ${formatNullableNumber(status.contextWindow)} tokens)`,
		`  Source: ${status.usageSource}`,
		`  Threshold mode: ${settings.thresholdMode}`,
		`  Percent band: ${status.band}`,
		`  Token band: ${getTokenBandText(status.usageTokens, settings)}`,
		`  Effective band: ${formatOptionalMode(status.effectiveBand)}`,
		`  Thresholds:`,
		`    percent checkpoint=${settings.checkpointThresholdPercent}% standard=${settings.standardThresholdPercent}% hard=${settings.hardThresholdPercent}%`,
		`    tokens checkpoint=${settings.checkpointThresholdTokens.toLocaleString()} standard=${settings.standardThresholdTokens.toLocaleString()} hard=${settings.hardThresholdTokens.toLocaleString()}`,
		`    cooldown=${settings.cooldownMs / 1000}s`,
		"  Config reload: threshold/cooldown changes require /reload or restart",
		`  Selected mode: ${formatOptionalMode(status.selectedMode)}`,
		`  Cooldown: ${formatCooldown(status)}`,
		`  Compacting: ${formatCompacting(status.isCompacting)}`,
	];
}

function hasUnknownUsage(status: CompactPlusStatus): boolean {
	return status.usagePercent === null || status.usageTokens === null;
}

function formatNativeUsageDetail(status: CompactPlusStatus): string[] {
	if (status.usageSource !== "native") return [];
	if (!hasUnknownUsage(status)) return [];
	return [
		"  Usage detail: Pi reports usage as unknown until the next assistant response after compaction.",
	];
}

function pushWhen(lines: string[], condition: boolean, line: string): void {
	if (condition) lines.push(line);
}

function formatTelemetryIssueLines(
	issues: TelemetryPersistenceIssue[],
): string[] {
	if (issues.length === 0) return [];
	const lines = ["  Telemetry persistence warnings:"];
	for (const issue of issues) {
		lines.push(
			`    ${issue.operation}/${issue.code}: ${issue.message} (${issue.path})`,
		);
		pushWhen(
			lines,
			Boolean(issue.quarantinePath),
			`      Quarantined: ${issue.quarantinePath}`,
		);
	}
	return lines;
}

function formatCompactionPath(compaction: CompactionTelemetry): string {
	return `${compaction.executionPath}${compaction.fromExtension ? " (Compact+)" : " (native Pi)"}`;
}

function isDistinctCompatibilityReason(
	compaction: CompactionTelemetry,
): boolean {
	return (
		Boolean(compaction.compatibilityReason) &&
		compaction.compatibilityReason !== compaction.fallbackReason
	);
}

function formatLastCompactionLines(
	compaction: CompactionTelemetry | null,
): string[] {
	if (!compaction) return [];
	const ago = Math.round((Date.now() - compaction.timestamp) / 1000);
	const focusTags = Array.from(new Set(compaction.focusTags.filter(Boolean)));
	const lines = [
		`  Last compaction: ${compaction.mode} mode, ${compaction.triggerSource} trigger, ${ago}s ago`,
	];
	pushWhen(
		lines,
		Boolean(compaction.triggerReason),
		`    Reason: ${compaction.triggerReason}`,
	);
	lines.push(`    Path: ${formatCompactionPath(compaction)}`);
	pushWhen(
		lines,
		Boolean(compaction.thinkingLevel),
		`    Thinking level: ${compaction.thinkingLevel}`,
	);
	pushWhen(
		lines,
		focusTags.length > 0,
		`    Focus files: ${focusTags.join(", ")}`,
	);
	pushWhen(
		lines,
		compaction.previousSummaryPresent,
		"    Prior summary: merged",
	);
	pushWhen(lines, compaction.splitTurn, "    Split-turn: yes");
	pushWhen(
		lines,
		isDistinctCompatibilityReason(compaction),
		`    Compatibility: ${compaction.compatibilityReason}`,
	);
	pushWhen(
		lines,
		Boolean(compaction.fallbackReason),
		`    Fallback: ${compaction.fallbackReason}`,
	);
	return lines;
}

function getCompactionFallback(
	compaction: CompactionTelemetry | null,
): string | null {
	return compaction?.fallbackReason ?? null;
}

function getTopLevelFallback(
	status: CompactPlusStatus,
	compactionFallback: string | null,
): string | null {
	return status.lastFallbackReason &&
		status.lastFallbackReason !== compactionFallback
		? status.lastFallbackReason
		: null;
}

function formatTopLevelFallback(fallback: string | null): string[] {
	return fallback ? [`  Last fallback: ${fallback}`] : [];
}

function formatEchoLine(line: string): string {
	return `    ${line}`;
}

function hasFallback(
	compactionFallback: string | null,
	topLevelFallback: string | null,
): boolean {
	return Boolean(compactionFallback || topLevelFallback);
}

function formatLastFocusEchoLines(
	status: CompactPlusStatus,
	compactionFallback: string | null,
): string[] {
	if (status.lastInjectedEcho) {
		return [
			"  Last focus echo:",
			...status.lastInjectedEcho.split("\n").map(formatEchoLine),
		];
	}
	if (hasFallback(compactionFallback, status.lastFallbackReason)) {
		return [
			"  Last focus echo: (none — last compaction fell back before a custom summary was injected)",
		];
	}
	if (status.lastCompaction) {
		return [
			"  Last focus echo: (none — no persisted focus echo is available for the last compaction)",
		];
	}
	return ["  Last focus echo: (none — no compaction summary detected yet)"];
}

export function formatStatusLines(status: CompactPlusStatus): string[] {
	const settings = resolveThresholdSettings(status.thresholdSettings);
	const compactionFallback = getCompactionFallback(status.lastCompaction);
	const topLevelFallback = getTopLevelFallback(status, compactionFallback);
	return [
		...formatStatusCoreLines(status, settings),
		...formatNativeUsageDetail(status),
		...formatTelemetryIssueLines(status.telemetryPersistenceIssues),
		...formatLastCompactionLines(status.lastCompaction),
		...formatTopLevelFallback(topLevelFallback),
		...formatLastFocusEchoLines(status, compactionFallback),
	];
}
