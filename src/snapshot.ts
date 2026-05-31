import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  extractActiveFiles,
  extractBlockers,
  extractDecisions,
  extractDependencyChain,
  extractObjective,
  extractTextContent,
  isConversationalFiller,
} from "./extract.js";
import { getIsError, getToolName } from "./pi-messages.js";
import type { CurrentFocus, SessionSnapshot } from "./types.js";

/**
 * Session snapshot and focus extraction.
 * Builds structured summaries of the current session state.
 */

const SNAPSHOT_MAX_ITEMS = 10;
const SNAPSHOT_MAX_LINE = 300;

export function extractCurrentFocus(messages: AgentMessage[]): CurrentFocus {
  const recent = messages.slice(-20);
  const objective = extractObjective(messages);
  // High-signal items that persist across the session: scan full history
  const decisions = extractDecisions(messages);
  const activeFiles = extractActiveFiles(messages);
  // Transient items: keep recent-only to avoid stale noise
  const blockers = extractBlockers(recent);
  const dependencyChain = extractDependencyChain(recent, decisions);
  return { objective, blockers, decisions, activeFiles, dependencyChain };
}

/**
 * Extract a full session snapshot from messages for richer checkpoints,
 * status reporting, and telemetry.
 *
 * Scans the full message history for completed work and failed attempts
 * (accumulated over the whole session), but restricts open problems, errors,
 * constraints, and next-step to recent messages to avoid stale noise.
 */
export function extractSessionSnapshot(
  messages: AgentMessage[],
): SessionSnapshot {
  const recent = messages.slice(-20);
  const focusRecent = messages.slice(-30);
  const objective = extractObjective(messages);
  const blockers = extractBlockers(recent);
  const decisions = extractDecisions(recent);
  const activeFiles = extractActiveFiles(recent);
  const dependencyChain = extractDependencyChain(recent, decisions);
  return {
    objective,
    blockers,
    decisions,
    activeFiles,
    dependencyChain,
    completedWork: extractCompletedWork(messages),
    openProblems: extractOpenProblems(focusRecent),
    currentErrors: extractCurrentErrors(focusRecent),
    constraints: extractConstraints(focusRecent),
    failedAttempts: extractFailedAttempts(messages),
    nextStep: extractNextStep(focusRecent),
  };
}

function truncateItem(item: string): string {
  return item.trim().slice(0, SNAPSHOT_MAX_LINE);
}

function pushItem(items: string[], item: string): void {
  const truncated = truncateItem(item);
  if (truncated.length > 5 && !isConversationalFiller(truncated)) {
    items.push(truncated);
  }
}

function uniqueLast(items: string[], maxItems: number): string[] {
  return Array.from(new Set(items)).slice(-maxItems);
}

function isAssistantMessage(msg: AgentMessage): boolean {
  return msg.role === "assistant";
}

function isUserMessage(msg: AgentMessage): boolean {
  return msg.role === "user";
}

function isStructuredStatusRole(msg: AgentMessage): boolean {
  return isUserMessage(msg) || isAssistantMessage(msg);
}

function isToolError(msg: AgentMessage): boolean {
  return msg.role === "toolResult" && getIsError(msg);
}

function firstSubstantialLine(text: string): string {
  return (
    text
      .split(/\n/)
      .find((line) => line.trim().length > 5)
      ?.trim() ?? text.trim()
  );
}

function headingMatches(heading: string, allowedHeadings: string[]): boolean {
  const normalized = heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
  return allowedHeadings.some((allowed) => normalized === allowed);
}

function extractStructuredItems(
  text: string,
  allowedHeadings: string[],
): string[] {
  const items: string[] = [];
  let inSection = false;
  for (const line of text.split(/\n/)) {
    const heading = line.match(/^#{1,6}\s*(.+?)\s*$/);
    if (heading) {
      inSection = headingMatches(heading[1], allowedHeadings);
      continue;
    }
    if (!inSection) continue;
    if (line.trim().length === 0) continue;
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (!bullet) continue;
    pushItem(items, bullet[1]);
  }
  return items;
}

function extractChecklistItems(text: string): string[] {
  const items: string[] = [];
  const checklistPattern = /\[x\]\s*(.+)/g;
  let match: RegExpExecArray | null = checklistPattern.exec(text);
  while (match !== null) {
    pushItem(items, match[1]);
    match = checklistPattern.exec(text);
  }
  return items;
}

function hasValidationFailureEvidence(text: string): boolean {
  return (
    /\b[1-9]\d*\s+(?:failed|failures?|errors?)\b/i.test(text) ||
    /\b(?:failed|failures?|errors?)\s*[:=]\s*[1-9]\d*\b/i.test(text) ||
    /^\s*(?:FAIL|FAILED)\s+/im.test(text) ||
    /^\s*(?:error\s+(?:TS\d+|[A-Z_]+)|failure:)\b/im.test(text)
  );
}

function outputLooksSuccessful(text: string): boolean {
  if (hasValidationFailureEvidence(text)) return false;
  return /(?:✓|\bpassed\b|\bsuccess\b|\bsucceeded\b|completed successfully|exit code:? 0)/i.test(
    text,
  );
}

function commandLooksLikeValidation(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  return (
    /^(?:\.\/node_modules\/\.bin\/)?(?:vitest|pytest|biome|tsc)(?:\s|$)/.test(
      normalized,
    ) ||
    /^(?:cargo|go)\s+test(?:\s|$)/.test(normalized) ||
    /^(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|build|verify)(?:\s|$)/.test(
      normalized,
    )
  );
}

function isValidationToolResult(msg: AgentMessage): boolean {
  const toolName = getToolName(msg);
  return [
    "run_biome",
    "run_cargo_test",
    "run_pytest",
    "run_typecheck",
    "run_vitest",
  ].includes(toolName ?? "");
}

function validationSuccessItem(msg: AgentMessage): string | undefined {
  if (msg.role === "bashExecution") {
    const command = (msg as { command?: unknown }).command;
    const output = (msg as { output?: unknown }).output;
    const exitCode = (msg as { exitCode?: unknown }).exitCode;
    const cancelled = (msg as { cancelled?: unknown }).cancelled;
    if (cancelled === true) return undefined;
    if (typeof exitCode === "number" && exitCode !== 0) return undefined;
    if (
      typeof command === "string" &&
      typeof output === "string" &&
      commandLooksLikeValidation(command) &&
      outputLooksSuccessful(output)
    ) {
      return `${command} passed`;
    }
  }
  if (
    msg.role === "toolResult" &&
    !isToolError(msg) &&
    isValidationToolResult(msg)
  ) {
    const text = extractTextContent(msg);
    if (outputLooksSuccessful(text)) {
      return firstSubstantialLine(text);
    }
  }
  return undefined;
}

function hasLaterValidationSuccess(
  messages: AgentMessage[],
  index: number,
): boolean {
  return messages.slice(index + 1).some((message) => {
    if (message.role !== "toolResult" && message.role !== "bashExecution") {
      return false;
    }
    return validationSuccessItem(message) !== undefined;
  });
}

export function extractCompletedWork(messages: AgentMessage[]): string[] {
  const items: string[] = [];
  for (const msg of messages) {
    const text = extractTextContent(msg);
    const validationItem = validationSuccessItem(msg);
    if (validationItem) pushItem(items, validationItem);

    if (!isStructuredStatusRole(msg)) continue;
    for (const item of extractChecklistItems(text)) pushItem(items, item);

    for (const item of extractStructuredItems(text, [
      "completed work",
      "done",
      "finished",
      "implemented",
    ])) {
      pushItem(items, item);
    }

    if (!isUserMessage(msg)) continue;
    const prosePatterns = [
      /(?:completed|finished|done with|implemented|shipped|merged)\s+(.{10,})/gi,
      /(?:fixed|resolved|addressed|closed)\s+(.{10,})/gi,
    ];
    for (const pattern of prosePatterns) {
      let match: RegExpExecArray | null = pattern.exec(text);
      while (match !== null) {
        pushItem(items, match[1]);
        match = pattern.exec(text);
      }
    }
  }
  return uniqueLast(items, SNAPSHOT_MAX_ITEMS);
}

function extractInlineOpenProblems(msg: AgentMessage, text: string): string[] {
  const items: string[] = [];
  const patterns = isAssistantMessage(msg)
    ? [/^(?:open problem|open issue)\s*:?\s*(.{5,})/gim]
    : [
        /(?:open problem|open issue|still (?:need|missing|todo|pending|outstanding))\s*:?\s*(.{5,})/gi,
        /(?:not yet (?:done|implemented|resolved|fixed))\s*:?\s*(.{5,})/gi,
      ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
      pushItem(items, match[1]);
      match = pattern.exec(text);
    }
  }
  return items;
}

export function extractOpenProblems(messages: AgentMessage[]): string[] {
  const items: string[] = [];
  for (const msg of messages) {
    if (!isStructuredStatusRole(msg)) continue;
    const text = extractTextContent(msg);
    for (const item of extractInlineOpenProblems(msg, text)) {
      pushItem(items, item);
    }
    for (const item of extractStructuredItems(text, [
      "open problem",
      "open problems",
      "todo",
      "remaining",
      "outstanding",
    ])) {
      pushItem(items, item);
    }
  }
  return uniqueLast(items, SNAPSHOT_MAX_ITEMS);
}

export function extractCurrentErrors(messages: AgentMessage[]): string[] {
  const errors: string[] = [];
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    const text = extractTextContent(msg);

    if (isToolError(msg)) {
      if (hasLaterValidationSuccess(messages, index)) continue;
      pushItem(errors, firstSubstantialLine(text));
      continue;
    }

    if (!isStructuredStatusRole(msg)) continue;
    for (const item of extractStructuredItems(text, [
      "current error",
      "current errors",
      "errors",
    ])) {
      pushItem(errors, item);
    }
    const explicitErrorPattern =
      /^(?:current error|current errors)\s*:?\s*(.{5,})/gim;
    let match: RegExpExecArray | null = explicitErrorPattern.exec(text);
    while (match !== null) {
      pushItem(errors, match[1]);
      match = explicitErrorPattern.exec(text);
    }
  }
  return uniqueLast(errors, 5);
}

function extractInlineConstraints(msg: AgentMessage, text: string): string[] {
  const items: string[] = [];
  const patterns = isAssistantMessage(msg)
    ? [/^(?:constraint|limitation|requirement)\s*:?\s*(.{5,})/gim]
    : [
        /(?:constraint|limitation|requirement|must (?:not|always|use|be))\s*:?\s*(.{5,})/gi,
        /(?:cannot|do not|should not|avoid)\s+(.{5,})/gi,
      ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match !== null) {
      pushItem(items, match[1]);
      match = pattern.exec(text);
    }
  }
  return items;
}

export function extractConstraints(messages: AgentMessage[]): string[] {
  const items: string[] = [];
  for (const msg of messages) {
    if (!isStructuredStatusRole(msg)) continue;
    const text = extractTextContent(msg);
    for (const item of extractInlineConstraints(msg, text)) {
      pushItem(items, item);
    }
    for (const item of extractStructuredItems(text, [
      "constraint",
      "constraints",
      "known constraint",
      "known constraints",
      "rule",
      "rules",
    ])) {
      pushItem(items, item);
    }
  }
  return uniqueLast(items, 5);
}

export function extractFailedAttempts(messages: AgentMessage[]): string[] {
  const items: string[] = [];
  for (const msg of messages) {
    const text = extractTextContent(msg);
    if (isToolError(msg)) {
      pushItem(items, firstSubstantialLine(text));
    }
    if (!isStructuredStatusRole(msg)) continue;
    for (const item of extractStructuredItems(text, [
      "failed attempt",
      "failed attempts",
      "failed paths",
      "rejected",
    ])) {
      pushItem(items, item);
    }
    if (!isUserMessage(msg)) continue;
    const patterns = [
      /(?:failed|didn'?t work|rejected|abandoned|rolled back|reverted)\s*(.{5,})/gi,
      /(?:attempt \d+|try \d+)\s*:?\s*(.{5,})/gi,
    ];
    for (const pattern of patterns) {
      let match: RegExpExecArray | null = pattern.exec(text);
      while (match !== null) {
        pushItem(items, match[1]);
        match = pattern.exec(text);
      }
    }
  }
  return uniqueLast(items, 5);
}

function stripListMarker(line: string): string {
  return line
    .replace(/^[-*]\s+/, "")
    .replace(/^\d+[.)]\s+/, "")
    .trim();
}

function extractNextStepSection(text: string): string | undefined {
  let inNextStepSection = false;
  for (const line of text.split(/\n/)) {
    const heading = line.match(/^#{1,6}\s*(.+?)\s*$/);
    if (heading) {
      const normalized = headingMatches(heading[1], ["next step"])
        ? "next step"
        : headingMatches(heading[1], ["next best step"])
          ? "next best step"
          : "";
      inNextStepSection = normalized.length > 0;
      continue;
    }
    if (!inNextStepSection || line.trim().length === 0) continue;
    const item = stripListMarker(line);
    if (item.length > 5 && !isConversationalFiller(item)) {
      return item.slice(0, SNAPSHOT_MAX_LINE);
    }
  }
  return undefined;
}

function extractNextStep(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isStructuredStatusRole(msg)) continue;
    const text = extractTextContent(msg);

    const sectionItem = extractNextStepSection(text);
    if (sectionItem) return sectionItem;

    const pattern =
      /(?:next step|next action|then (?:we|I)\s+(?:should|will|need to|can))\s*:?\s*(.{5,})/i;
    const match = text.match(pattern);
    if (match) {
      const item = stripListMarker(match[1]);
      if (item.length > 5 && !isConversationalFiller(item)) {
        return item.slice(0, SNAPSHOT_MAX_LINE);
      }
    }
  }
  return "";
}
