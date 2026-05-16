import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type {
  CompactionResult,
  ExtensionContext,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import { classifyMessages, extractCurrentFocus } from "./focus.js";
import { buildSummaryInstructions } from "./prompts.js";
import type { CompactionMode } from "./types.js";

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
const SECTION_BODY_LINE_LIMITS = new Map<string, number>([
  ["## Current Objective", 4],
  ["## Current Task State", 8],
  ["## Active File Set", 14],
  ["## Repository State", 8],
  ["## Decisions Made", 10],
  ["## Completed Work", 12],
  ["## Open Problems", 10],
  ["## Current Errors", 8],
  ["## Known Constraints", 8],
  ["## Failed Attempts", 8],
  ["## Next Best Step", 4],
  ["## Continuity Instruction", 6],
  ["## Dependency Chain", 8],
]);

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

function normalizeStructuredSummary(
  summary: string,
  maxTokens: number,
  targetTokens: number,
): string {
  if (estimateSummaryTokens(summary) <= maxTokens) {
    return summary.trimEnd();
  }

  const normalized = summary.replace(/\r/g, "").trim();
  const lines = normalized.split("\n");
  const sections: Array<{ heading: string; body: string[] }> = [];
  let current: { heading: string; body: string[] } | null = null;

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

  const rebuild = (multiplier: number): string => {
    const rendered: string[] = [];
    for (const section of sections) {
      rendered.push(section.heading);
      const bodyLimit = Math.max(
        2,
        Math.floor(
          (SECTION_BODY_LINE_LIMITS.get(section.heading) ?? 6) * multiplier,
        ),
      );
      const body: string[] = [];
      let previousBlank = false;
      for (const rawLine of section.body) {
        if (body.length >= bodyLimit) break;
        const trimmedLine = truncateLine(rawLine.trimEnd());
        const isBlank = trimmedLine.trim().length === 0;
        if (isBlank) {
          if (previousBlank || body.length === 0) continue;
          previousBlank = true;
          body.push("");
          continue;
        }
        previousBlank = false;
        body.push(trimmedLine);
      }
      while (body.length > 0 && body.at(-1) === "") {
        body.pop();
      }
      rendered.push(...body, "");
    }
    while (rendered.length > 0 && rendered.at(-1) === "") {
      rendered.pop();
    }
    return rendered.join("\n").trimEnd();
  };

  for (const multiplier of [1, 0.75, 0.5, 0.35]) {
    const candidate = rebuild(multiplier);
    if (estimateSummaryTokens(candidate) <= targetTokens) {
      return candidate;
    }
  }

  return truncateAtBoundary(rebuild(0.25), targetTokens * 4);
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

/**
 * Lightweight validation that the compaction summary is coherent.
 * Checks for expected headings, non-empty content, and reasonable size.
 */
function validateCompactionResult(result: CompactionResult): ValidationResult {
  const summary = result.summary ?? "";
  if (summary.length === 0) {
    return { valid: false, reason: "summary is empty" };
  }
  // Only enforce heading checks for substantial summaries (>100 chars)
  if (summary.length > 100) {
    const expectedHeadings = [
      "## Current Objective",
      "## Active File Set",
      "## Decisions Made",
      "## Next Best Step",
    ];
    const foundHeadings = expectedHeadings.filter((h) =>
      summary.includes(h),
    ).length;
    if (foundHeadings < 2) {
      return {
        valid: false,
        reason: `only ${foundHeadings}/${expectedHeadings.length} expected headings found`,
      };
    }
  }
  const estimatedTokens = estimateSummaryTokens(summary);
  if (estimatedTokens > MAX_VALID_SUMMARY_TOKENS) {
    return {
      valid: false,
      reason: `summary too large (~${Math.round(estimatedTokens)} tokens)`,
    };
  }
  return { valid: true };
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
  const originalById = new Map<string, AgentMessage>();
  const resultById = new Map<string, AgentMessage>();

  for (const msg of original) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          originalById.set(block.id, msg);
        }
      }
    }
    if (msg.role === "toolResult") {
      const id = (msg as { toolCallId?: string }).toolCallId;
      if (id) resultById.set(id, msg);
    }
  }

  const prunedSet = new Set(pruned);
  const restored = new Set<AgentMessage>(pruned);

  for (const msg of pruned) {
    if (msg.role === "assistant") {
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          const result = resultById.get(block.id);
          if (result && !prunedSet.has(result)) {
            restored.add(result);
          }
        }
      }
    }
    if (msg.role === "toolResult") {
      const id = (msg as { toolCallId?: string }).toolCallId;
      if (id) {
        const call = originalById.get(id);
        if (call && !prunedSet.has(call)) {
          restored.add(call);
        }
      }
    }
  }

  // Preserve original order
  return original.filter((m) => restored.has(m));
}

export async function runCustomCompaction(
  preparation: Parameters<typeof compact>[0],
  mode: CompactionMode,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<CompactionAttemptResult> {
  try {
    const model = ctx.model;
    if (!model)
      return { result: undefined, fallbackReason: "model unavailable" };

    const registry = ctx.modelRegistry as ModelRegistry;
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok)
      return {
        result: undefined,
        fallbackReason: `auth unavailable: ${auth.error ?? "unknown"}`,
      };

    // Combine for focus extraction so split-turn prefixes contribute
    const focusSource = preparation.isSplitTurn
      ? [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages]
      : preparation.messagesToSummarize;
    const focus = extractCurrentFocus(focusSource);

    if (mode === "hard") {
      // Prune ephemeral from main history
      const classifiedHistory = classifyMessages(
        preparation.messagesToSummarize,
        mode,
      );
      const prunedHistory = [
        ...classifiedHistory.critical,
        ...classifiedHistory.contextual,
      ];
      const historyOrderMap = new Map<AgentMessage, number>(
        preparation.messagesToSummarize.map((m, i) => [m, i]),
      );
      prunedHistory.sort((a, b) => {
        const idxA = historyOrderMap.get(a);
        const idxB = historyOrderMap.get(b);
        return (idxA ?? 0) - (idxB ?? 0);
      });
      const historyWithPairs = restoreToolPairs(
        prunedHistory,
        preparation.messagesToSummarize,
      );

      // Prune ephemeral from turn prefix when splitting
      let prunedPrefix: AgentMessage[] | undefined;
      if (
        preparation.isSplitTurn &&
        preparation.turnPrefixMessages.length > 0
      ) {
        const classifiedPrefix = classifyMessages(
          preparation.turnPrefixMessages,
          mode,
        );
        const pruned = [
          ...classifiedPrefix.critical,
          ...classifiedPrefix.contextual,
        ];
        const prefixOrderMap = new Map<AgentMessage, number>(
          preparation.turnPrefixMessages.map((m, i) => [m, i]),
        );
        pruned.sort((a, b) => {
          const idxA = prefixOrderMap.get(a);
          const idxB = prefixOrderMap.get(b);
          return (idxA ?? 0) - (idxB ?? 0);
        });
        // Guard: never prune the prefix to empty — it may contain the only
        // useful clue about what the current turn is doing.
        prunedPrefix = pruned.length > 0 ? pruned : undefined;
      }

      const prefixWithPairs =
        prunedPrefix && preparation.turnPrefixMessages.length > 0
          ? restoreToolPairs(prunedPrefix, preparation.turnPrefixMessages)
          : prunedPrefix;

      preparation = {
        ...preparation,
        messagesToSummarize: historyWithPairs,
        turnPrefixMessages: prefixWithPairs ?? preparation.turnPrefixMessages,
      };
    }

    const normalizedPreviousSummary = normalizePreviousSummary(
      preparation.previousSummary,
    );
    preparation = {
      ...preparation,
      previousSummary: normalizedPreviousSummary,
    };

    const customInstructions = buildSummaryInstructions(mode, focus, {
      previousSummary: normalizedPreviousSummary,
      isSplitTurn: preparation.isSplitTurn,
      turnPrefixCount: preparation.turnPrefixMessages?.length ?? 0,
    });

    const result = await compact(
      preparation,
      model,
      auth.apiKey ?? "",
      auth.headers,
      customInstructions,
      signal ?? ctx.signal ?? undefined,
    );

    // Compute classified counts for telemetry
    const classified = classifyMessages(
      mode === "hard" ? preparation.messagesToSummarize : focusSource,
      mode,
    );
    const classifiedCounts = classifyCounts(classified);

    if (!result) {
      return {
        result: undefined,
        fallbackReason: "compact returned undefined",
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { result: undefined, fallbackReason: `compact error: ${message}` };
  }
}
