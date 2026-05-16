import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Position-aware context reordering to mitigate "lost in the middle" degradation.
 *
 * Strategy: inject a compact "focus echo" at the recency position (before the
 * last user message) so that the model sees critical information at both
 * primacy (start, from the summary) and recency (end, from the echo) positions.
 *
 * The echo is intentionally small (under ~200 tokens) to avoid eating into
 * the working context. It only duplicates the highest-signal fields:
 * objective, blockers, active files, decisions, dependency chain, next step.
 */

export interface FocusEcho {
  objective: string;
  blockers: string[];
  activeFiles: string[];
  decisions: string[];
  dependencyChain: string[];
  nextStep: string;
}

const FOCUS_ECHO_MARKER = "<focus-echo>";

/**
 * Headings that only appear together in a real Compact+ compaction summary.
 * Used to avoid false positives from chat messages that mention one heading.
 */
const SUMMARY_SIGNATURE_HEADINGS = [
  "## Current Objective",
  "## Active File Set",
  "## Decisions Made",
  "## Next Best Step",
];

const MIN_SIGNATURE_MATCHES = 2;

/** Pre-compiled regexes for summary signature detection. */
const SUMMARY_REGEXES = SUMMARY_SIGNATURE_HEADINGS.map(
  (h) => new RegExp(`^${escapeRegex(h)}`, "m"),
);

/**
 * Detect whether the messages array contains a Compact+ compaction summary.
 * Looks for assistant messages containing the "## Current Objective" heading
 * that Compact+ injects via buildSummaryInstructions().
 */
export function detectCompactionSummary(messages: AgentMessage[]):
  | { found: true; summaryText: string; summaryIndex: number }
  | {
      found: false;
      summaryText?: undefined;
      summaryIndex?: undefined;
    } {
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === "assistant") {
      const text = extractSimpleText(msg);
      const matchCount = SUMMARY_REGEXES.filter((re) => re.test(text)).length;
      if (matchCount >= MIN_SIGNATURE_MATCHES) {
        return { found: true, summaryText: text, summaryIndex: i };
      }
    }
  }
  return { found: false };
}

/**
 * Extract high-signal fields from a structured compaction summary.
 * Parses the known headings produced by buildSummaryInstructions().
 */
export function parseFocusEcho(summaryText: string): FocusEcho {
  const sectionHeadings = {
    objective: "## Current Objective",
    activeFiles: "## Active File Set",
    blockers: "## Open Problems",
    errors: "## Current Errors",
    decisions: "## Decisions Made",
    dependencyChain: "## Dependency Chain",
    nextStep: "## Next Best Step",
  };

  return {
    objective: extractSection(summaryText, sectionHeadings.objective),
    blockers: [
      ...extractListSection(summaryText, sectionHeadings.blockers),
      ...extractListSection(summaryText, sectionHeadings.errors),
    ],
    activeFiles: extractListSection(summaryText, sectionHeadings.activeFiles),
    decisions: extractListSection(summaryText, sectionHeadings.decisions),
    dependencyChain: extractListSection(
      summaryText,
      sectionHeadings.dependencyChain,
    ),
    nextStep: extractSection(summaryText, sectionHeadings.nextStep),
  };
}

/**
 * Build a compact echo block to inject at the recency position.
 * Format:
 *   <focus-echo>
 *   Objective: ...
 *   Active files: ...
 *   Blockers: ...
 *   Next step: ...
 *   </focus-echo>
 */
export function buildFocusEchoBlock(echo: FocusEcho): string {
  const lines: string[] = [FOCUS_ECHO_MARKER];

  if (echo.objective) {
    lines.push(`Objective: ${echo.objective}`);
  }
  if (echo.activeFiles.length > 0) {
    lines.push(`Active files: ${echo.activeFiles.join(", ")}`);
  }
  if (echo.blockers.length > 0) {
    lines.push(`Blockers: ${echo.blockers.join("; ")}`);
  }
  if (echo.decisions.length > 0) {
    lines.push(`Decisions: ${echo.decisions.join("; ")}`);
  }
  if (echo.dependencyChain && echo.dependencyChain.length > 0) {
    lines.push(`Dependency chain: ${echo.dependencyChain.join(" → ")}`);
  }
  if (echo.nextStep) {
    lines.push(`Next step: ${echo.nextStep}`);
  }

  lines.push("</focus-echo>");
  return lines.join("\n");
}

/**
 * Create a synthetic user message containing the focus echo.
 * Uses role "user" with a clear marker so it's distinguishable.
 */
export function createEchoMessage(echo: FocusEcho): AgentMessage {
  return {
    role: "user",
    content: [{ type: "text", text: buildFocusEchoBlock(echo) }],
  } as AgentMessage;
}

/**
 * Main reordering function. If a compaction summary is detected:
 * 1. Parse the focus echo
 * 2. Inject it before the last user message (recency position)
 * 3. Return the reordered messages
 *
 * If no summary is detected, returns undefined (no-op).
 * If an existing <focus-echo> is found, returns undefined (dedup).
 * Pass `echoInjected=true` to skip the O(n) dedup scan (caller manages flag).
 */
export function reorderForPositioning(
  messages: AgentMessage[],
  echoInjected = false,
): { messages: AgentMessage[]; echoText: string } | undefined {
  const detection = detectCompactionSummary(messages);
  if (!detection.found) {
    return undefined;
  }

  // Dedup: skip if an existing focus-echo is already present
  if (!echoInjected) {
    const alreadyHasEcho = messages.some((msg) => {
      if (msg.role === "user") {
        const text = extractSimpleText(msg);
        return text.includes(FOCUS_ECHO_MARKER);
      }
      return false;
    });
    if (alreadyHasEcho) return undefined;
  }

  const echo = parseFocusEcho(detection.summaryText);

  // Skip if echo has no useful content
  if (
    !echo.objective &&
    echo.blockers.length === 0 &&
    echo.activeFiles.length === 0 &&
    echo.decisions.length === 0 &&
    echo.dependencyChain.length === 0 &&
    !echo.nextStep
  ) {
    return undefined;
  }

  const echoMessage = createEchoMessage(echo);

  // Inject before the last user message for recency positioning
  const lastUserIndex = findLastUserMessageIndex(messages);
  if (lastUserIndex === -1) return undefined;

  const echoText = extractSimpleText(echoMessage);

  const result = [...messages];
  result.splice(lastUserIndex, 0, echoMessage);
  return { messages: result, echoText };
}

// ── Internal helpers ────────────────────────────────────────────────

function extractSimpleText(msg: AgentMessage): string {
  if (msg.role === "assistant") {
    return msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (msg.role === "user") {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    }
  }
  return "";
}

function extractSection(text: string, heading: string): string {
  const headingIndex = text.indexOf(heading);
  if (headingIndex === -1) return "";

  const afterHeading = text.slice(headingIndex + heading.length).trimStart();
  // Read until the next ## heading or end of text
  const nextHeading = afterHeading.search(/^## /m);
  const content =
    nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);

  // Take first non-empty line
  const firstLine = content
    .split(/\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  return firstLine ?? "";
}

function extractListSection(text: string, heading: string): string[] {
  const headingIndex = text.indexOf(heading);
  if (headingIndex === -1) return [];

  const afterHeading = text.slice(headingIndex + heading.length).trimStart();
  const nextHeading = afterHeading.search(/^## /m);
  const content =
    nextHeading === -1 ? afterHeading : afterHeading.slice(0, nextHeading);

  return content
    .split(/\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- ") || l.startsWith("* "))
    .map((l) => l.replace(/^[-*]\s+/, ""))
    .filter((l) => l.length > 0)
    .slice(0, 5);
}

function findLastUserMessageIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") return i;
  }
  return -1;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
