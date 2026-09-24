import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
	CompactionResult,
	ExtensionContext,
	ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { classifyMessages } from "./classify.js";
import type { CompactionRuntimeCompatibility } from "./compatibility.js";
import {
	getAssistantIdBearingToolCallBlocks,
	getToolCallId,
} from "./pi-messages.js";
import { buildSummaryInstructions } from "./prompts.js";
import { extractCurrentFocus } from "./session-evidence.js";
import {
	CRITICAL_HEADINGS,
	FENCED_EXAMPLE_OMISSION,
	isSubstantiveCriticalLine,
	parseSummaryFenceMarker,
	STRUCTURED_SUMMARY_HEADINGS,
	STRUCTURED_SUMMARY_TITLE,
	validateStructuredSummary,
} from "./summary-schema.js";
import type { CompactionMode, CurrentFocus } from "./types.js";

export interface CompactionAttemptResult {
	result: CompactionResult | undefined;
	fallbackReason: string | null;
	classifiedCounts?: {
		critical: number;
		contextual: number;
		ephemeral: number;
	};
}

function classifyCounts(classified: {
	critical: AgentMessage[];
	contextual: AgentMessage[];
	ephemeral: AgentMessage[];
}): { critical: number; contextual: number; ephemeral: number } {
	return {
		critical: classified.critical.length,
		contextual: classified.contextual.length,
		ephemeral: classified.ephemeral.length,
	};
}

interface ValidationResult {
	valid: boolean;
	reason?: string;
}

const MAX_VALID_SUMMARY_TOKENS = 4000;
const TARGET_NORMALIZED_SUMMARY_TOKENS = 3200;
const MAX_PREVIOUS_SUMMARY_TOKENS = 1600;
const TARGET_PREVIOUS_SUMMARY_TOKENS = 1200;
const MAX_SUMMARY_LINE_CHARS = 240;
const CRITICAL_HEADING_SET = new Set<string>(CRITICAL_HEADINGS);
const SECTION_BODY_LINE_LIMITS = new Map<string, number>(
	STRUCTURED_SUMMARY_HEADINGS.map(
		(heading, index) =>
			[heading, [4, 8, 14, 8, 10, 12, 10, 8, 8, 8, 4, 6, 8][index]] as const,
	),
);

function estimateSummaryTokens(text: string): number {
	return text.length / 4;
}

function truncateLine(line: string, maxChars = MAX_SUMMARY_LINE_CHARS): string {
	if (line.length <= maxChars) return line;
	return `${line.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function truncateAtBoundary(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text.trimEnd();
	const slice = text.slice(0, maxChars);
	const newlineIdx = slice.lastIndexOf("\n");
	if (newlineIdx > maxChars * 0.6) {
		return `${slice.slice(0, newlineIdx).trimEnd()}\n…`;
	}
	return `${slice.trimEnd()}…`;
}

interface SummarySection {
	heading: string;
	body: string[];
}

/** Oversized structured summaries drop fenced examples atomically, not mid-fence. */
function omitFencedExamples(lines: string[]): string[] {
	const retained: string[] = [];
	let fence: "`" | "~" | undefined;
	let fenceLength = 0;
	let currentHeading: string | undefined;
	for (const line of lines) {
		if (!fence && /^##\s+/.test(line)) currentHeading = line.trimEnd();
		const marker = parseSummaryFenceMarker(line);
		if (marker && !fence) {
			fence = marker.kind;
			fenceLength = marker.length;
			// Never spend a critical section's line budget on a placeholder.
			if (!currentHeading || !CRITICAL_HEADING_SET.has(currentHeading)) {
				retained.push(FENCED_EXAMPLE_OMISSION);
			}
			continue;
		}
		if (
			marker &&
			fence === marker.kind &&
			marker.length >= fenceLength &&
			marker.canClose
		) {
			fence = undefined;
			continue;
		}
		if (!fence) retained.push(line);
	}
	return retained;
}

function renderSummarySectionBody(
	section: SummarySection,
	multiplier: number,
): string[] {
	const bodyLimit = Math.max(
		2,
		Math.floor(
			(SECTION_BODY_LINE_LIMITS.get(section.heading) ?? 6) * multiplier,
		),
	);
	const critical = CRITICAL_HEADING_SET.has(section.heading);
	const isNonSubstantiveCritical = (line: string): boolean =>
		critical && line.trim().length > 0 && !isSubstantiveCriticalLine(line);
	const realLineCount = section.body.filter(
		(line) =>
			line.trim().length > 0 &&
			line.trim() !== FENCED_EXAMPLE_OMISSION &&
			!isNonSubstantiveCritical(line),
	).length;
	// Decorative blanks and an informational marker never displace real lines.
	let blankSlots = Math.max(0, bodyLimit - realLineCount);
	const body: string[] = [];
	let realLinesIncluded = 0;
	let pendingBlank = false;
	let markerIncluded = false;

	for (const rawLine of section.body) {
		if (isNonSubstantiveCritical(rawLine)) continue;
		const isMarker = rawLine.trim() === FENCED_EXAMPLE_OMISSION;
		if (isMarker) {
			if (markerIncluded) continue;
			markerIncluded = true;
			pendingBlank = false;
			body.push(FENCED_EXAMPLE_OMISSION);
			continue;
		}
		const line = truncateLine(rawLine.trimEnd());
		if (line.length === 0) {
			pendingBlank = body.length > 0 && body.at(-1) !== FENCED_EXAMPLE_OMISSION;
			continue;
		}
		if (realLinesIncluded >= bodyLimit) break;
		if (pendingBlank && blankSlots > 0) {
			body.push("");
			blankSlots--;
		}
		pendingBlank = false;
		body.push(line);
		realLinesIncluded++;
	}

	return body;
}

function renderSummarySection(
	section: SummarySection,
	multiplier: number,
): string {
	return [
		section.heading,
		...renderSummarySectionBody(section, multiplier),
	].join("\n");
}

function normalizeStructuredSummary(
	summary: string,
	maxTokens: number,
	targetTokens: number,
): string {
	if (estimateSummaryTokens(summary) <= maxTokens) {
		return summary.trimEnd();
	}

	const normalized = summary.replace(/\r/g, "").trim();
	const title = normalized.startsWith(`${STRUCTURED_SUMMARY_TITLE}\n`)
		? `${STRUCTURED_SUMMARY_TITLE}\n\n`
		: "";
	const lines = title
		? omitFencedExamples(normalized.split("\n"))
		: normalized.split("\n");
	const sections: SummarySection[] = [];
	let current: SummarySection | null = null;

	for (const line of lines) {
		if (/^##\s+/.test(line)) {
			current = { heading: line.trimEnd(), body: [] };
			sections.push(current);
			continue;
		}
		if (!current) continue;
		current.body.push(line);
	}

	if (sections.length === 0) {
		return truncateAtBoundary(normalized, targetTokens * 4);
	}

	const rebuild = (multiplier: number): string =>
		title +
		sections
			.map((section) => renderSummarySection(section, multiplier))
			.join("\n\n");

	for (const multiplier of [1, 0.75, 0.5, 0.35]) {
		const candidate = rebuild(multiplier);
		if (estimateSummaryTokens(candidate) <= targetTokens) {
			return candidate;
		}
	}

	const minimal = rebuild(0.25);
	return title ? minimal : truncateAtBoundary(minimal, targetTokens * 4);
}

function normalizePreviousSummary(
	previousSummary?: string,
): string | undefined {
	if (!previousSummary) return previousSummary;
	return normalizeStructuredSummary(
		previousSummary,
		MAX_PREVIOUS_SUMMARY_TOKENS,
		TARGET_PREVIOUS_SUMMARY_TOKENS,
	);
}

function normalizeCompactionResult(result: CompactionResult): CompactionResult {
	const summary = result.summary ?? "";
	const normalizedSummary = normalizeStructuredSummary(
		summary,
		MAX_VALID_SUMMARY_TOKENS,
		TARGET_NORMALIZED_SUMMARY_TOKENS,
	);
	if (normalizedSummary === summary) return result;
	return {
		...result,
		summary: normalizedSummary,
	};
}

/** Enforce the same full schema before and after lossy normalization. */
function validateCompactionResult(result: CompactionResult): ValidationResult {
	const summary = result.summary ?? "";
	if (summary.length === 0) {
		return { valid: false, reason: "summary is empty" };
	}
	const structure = validateStructuredSummary(summary);
	if (!structure.valid) return structure;
	const estimatedTokens = estimateSummaryTokens(summary);
	if (estimatedTokens > MAX_VALID_SUMMARY_TOKENS) {
		return {
			valid: false,
			reason: `summary too large (~${Math.round(estimatedTokens)} tokens)`,
		};
	}
	return { valid: true };
}

type ToolPairIndex = {
	callById: Map<string, AgentMessage>;
	resultById: Map<string, AgentMessage>;
};

function indexToolPairs(original: AgentMessage[]): ToolPairIndex {
	const callById = new Map<string, AgentMessage>();
	const resultById = new Map<string, AgentMessage>();

	for (const message of original) {
		for (const block of getAssistantIdBearingToolCallBlocks(message)) {
			callById.set(block.id, message);
		}
		if (message.role !== "toolResult") continue;

		const id = getToolCallId(message);
		if (id) resultById.set(id, message);
	}

	return { callById, resultById };
}

function findToolPairCounterparts(
	message: AgentMessage,
	index: ToolPairIndex,
): AgentMessage[] {
	const counterparts: AgentMessage[] = [];

	for (const block of getAssistantIdBearingToolCallBlocks(message)) {
		const result = index.resultById.get(block.id);
		if (result) counterparts.push(result);
	}

	if (message.role === "toolResult") {
		const id = getToolCallId(message);
		const call = id ? index.callById.get(id) : undefined;
		if (call) counterparts.push(call);
	}

	return counterparts;
}

/**
 * Ensure tool call/result pairs remain atomic after pruning.
 * If a toolResult is kept but its matching assistant toolCall was pruned
 * (or vice versa), restore the missing message from the original list.
 */
function restoreToolPairs(
	pruned: AgentMessage[],
	original: AgentMessage[],
): AgentMessage[] {
	const index = indexToolPairs(original);
	const restored = new Set<AgentMessage>(pruned);

	for (const message of pruned) {
		for (const counterpart of findToolPairCounterparts(message, index)) {
			restored.add(counterpart);
		}
	}

	// Preserve original order
	return original.filter((message) => restored.has(message));
}

export const __test__ = { normalizeStructuredSummary, restoreToolPairs };

type CompactionPreparation = Parameters<typeof compact>[0];

interface PreparedCompactionContext {
	preparation: CompactionPreparation;
	focusSource: AgentMessage[];
	customInstructions: string;
}

interface CompactionIntent {
	focus?: CurrentFocus;
	customInstructions?: string;
}

function getCompactionFocusSource(
	preparation: CompactionPreparation,
): AgentMessage[] {
	return preparation.isSplitTurn
		? [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
		: preparation.messagesToSummarize;
}

function retainHardModeMessages(
	messages: AgentMessage[],
	mode: CompactionMode,
): AgentMessage[] {
	const classified = classifyMessages(messages, mode);
	return restoreToolPairs(
		[...classified.critical, ...classified.contextual],
		messages,
	);
}

function retainHardModePrefix(
	preparation: CompactionPreparation,
	mode: CompactionMode,
): AgentMessage[] {
	const original = preparation.turnPrefixMessages;
	if (!preparation.isSplitTurn || original.length === 0) return original;

	const pruned = retainHardModeMessages(original, mode);
	// The prefix may contain the only useful clue about the interrupted turn.
	return pruned.length > 0 ? pruned : original;
}

function applyHardModePruning(
	preparation: CompactionPreparation,
	mode: CompactionMode,
): CompactionPreparation {
	if (mode !== "hard") return preparation;
	return {
		...preparation,
		messagesToSummarize: retainHardModeMessages(
			preparation.messagesToSummarize,
			mode,
		),
		turnPrefixMessages: retainHardModePrefix(preparation, mode),
	};
}

function prepareCompactionContext(
	preparation: CompactionPreparation,
	mode: CompactionMode,
	intent?: CompactionIntent,
): PreparedCompactionContext {
	const focusSource = getCompactionFocusSource(preparation);
	const prunedPreparation = applyHardModePruning(preparation, mode);
	const normalizedPreviousSummary = normalizePreviousSummary(
		prunedPreparation.previousSummary,
	);
	const normalizedPreparation = {
		...prunedPreparation,
		previousSummary: normalizedPreviousSummary,
	};
	const customInstructions = buildSummaryInstructions(
		mode,
		intent?.focus ?? extractCurrentFocus(focusSource),
		{
			previousSummary: normalizedPreviousSummary,
			customInstructions: intent?.customInstructions,
			isSplitTurn: normalizedPreparation.isSplitTurn,
			turnPrefixCount: normalizedPreparation.turnPrefixMessages?.length ?? 0,
		},
	);

	return {
		preparation: normalizedPreparation,
		focusSource,
		customInstructions,
	};
}

function createCompactArguments(args: {
	prepared: PreparedCompactionContext;
	model: unknown;
	auth: {
		apiKey?: string;
		headers?: Record<string, string | null>;
		baseUrl?: string;
		env?: Record<string, string>;
	};
	compatibility: CompactionRuntimeCompatibility;
	signal?: AbortSignal;
}): unknown[] {
	const compactArgs: unknown[] = [
		args.prepared.preparation,
		args.auth.baseUrl
			? { ...(args.model as object), baseUrl: args.auth.baseUrl }
			: args.model,
		args.auth.apiKey,
		args.auth.headers
			? Object.fromEntries(
					Object.entries(args.auth.headers).filter(
						(entry): entry is [string, string] => typeof entry[1] === "string",
					),
				)
			: undefined,
		args.prepared.customInstructions,
		args.signal,
	];

	if (args.compatibility.helperSupportsThinkingLevel) {
		compactArgs.push(args.compatibility.thinkingLevel ?? undefined);
	}
	if (args.compatibility.helperSupportsStreamFn) {
		compactArgs.push(args.compatibility.streamFn);
		compactArgs.push(args.auth.env);
	}
	return compactArgs;
}

function getCompactionClassifiedCounts(
	prepared: PreparedCompactionContext,
	mode: CompactionMode,
): NonNullable<CompactionAttemptResult["classifiedCounts"]> {
	const messages =
		mode === "hard"
			? prepared.preparation.messagesToSummarize
			: prepared.focusSource;
	return classifyCounts(classifyMessages(messages, mode));
}

function finalizeCompactionAttempt(
	result: CompactionResult | undefined,
	classifiedCounts: NonNullable<CompactionAttemptResult["classifiedCounts"]>,
): CompactionAttemptResult {
	if (!result) {
		return {
			result: undefined,
			fallbackReason: "compact returned undefined",
			classifiedCounts,
		};
	}

	const initialValidation = result.summary
		? validateStructuredSummary(result.summary)
		: { valid: false as const, reason: "summary is empty" };
	if (!initialValidation.valid) {
		return {
			result: undefined,
			fallbackReason: `compaction summary invalid: ${initialValidation.reason}`,
			classifiedCounts,
		};
	}
	const normalizedResult = normalizeCompactionResult(result);
	const validation = validateCompactionResult(normalizedResult);
	if (!validation.valid) {
		return {
			result: undefined,
			fallbackReason: `compaction summary invalid: ${validation.reason}`,
			classifiedCounts,
		};
	}
	return { result: normalizedResult, fallbackReason: null, classifiedCounts };
}

function authUnavailableResult(): CompactionAttemptResult {
	return { result: undefined, fallbackReason: "auth unavailable" };
}

function selectCompactionSignal(
	signal: AbortSignal | undefined,
	contextSignal: AbortSignal | undefined,
): AbortSignal | undefined {
	return signal ?? contextSignal ?? undefined;
}

function compactErrorResult(): CompactionAttemptResult {
	return {
		result: undefined,
		fallbackReason: "compact error: provider request failed",
	};
}

export async function runCustomCompaction(
	preparation: CompactionPreparation,
	mode: CompactionMode,
	ctx: ExtensionContext,
	compatibility: CompactionRuntimeCompatibility,
	signal?: AbortSignal,
	intent?: CompactionIntent,
): Promise<CompactionAttemptResult> {
	const requestSignal = selectCompactionSignal(signal, ctx.signal);
	try {
		const model = ctx.model;
		if (!model) {
			return { result: undefined, fallbackReason: "model unavailable" };
		}

		const focus =
			intent?.focus ??
			extractCurrentFocus(getCompactionFocusSource(preparation));
		if (focus.intentEvidence?.overflow) {
			return {
				result: undefined,
				fallbackReason: "intent evidence exceeds the 8 KiB safety budget",
			};
		}

		if (requestSignal?.aborted) {
			return { result: undefined, fallbackReason: "compaction aborted" };
		}
		const registry = ctx.modelRegistry as ModelRegistry;
		// The registry stream resolves provider auth at request time. Forwarding an
		// earlier key/header snapshot could override rotated credentials or routing.
		const auth: Awaited<ReturnType<ModelRegistry["getApiKeyAndHeaders"]>> =
			compatibility.streamRoute === "registry"
				? { ok: true }
				: await registry.getApiKeyAndHeaders(model);
		if (requestSignal?.aborted) {
			return { result: undefined, fallbackReason: "compaction aborted" };
		}
		if (!auth.ok) return authUnavailableResult();

		const prepared = prepareCompactionContext(preparation, mode, {
			...intent,
			focus,
		});
		const compactArgs = createCompactArguments({
			prepared,
			model,
			auth,
			compatibility,
			signal: requestSignal,
		});
		const compactRunner = compact as unknown as (
			...args: unknown[]
		) => Promise<CompactionResult | undefined>;
		const result = await compactRunner(...compactArgs);
		return finalizeCompactionAttempt(
			result,
			getCompactionClassifiedCounts(prepared, mode),
		);
	} catch {
		return requestSignal?.aborted
			? { result: undefined, fallbackReason: "compaction aborted" }
			: compactErrorResult();
	}
}
