import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  extractMessageText,
  getAssistantToolCallBlocks,
  getIsError,
  getToolName,
  isToolCallArgumentsObject,
} from "./pi-messages.js";

/**
 * Text extraction and low-level content analysis helpers.
 * These are the foundational building blocks used by snapshot and classify.
 */

export function extractTextContent(msg: AgentMessage): string {
  return extractMessageText(msg, "\n");
}

export function isConversationalFiller(text: string): boolean {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "");
  const fillers = [
    "ok",
    "okay",
    "thanks",
    "thank you",
    "great",
    "good",
    "nice",
    "perfect",
    "sounds good",
    "will do",
    "done",
    "yes",
    "no",
    "sure",
    "got it",
    "makes sense",
    "agreed",
    "correct",
    "right",
    "exactly",
    "confirmed",
    "understood",
    "lets do it",
    "go ahead",
    "proceed",
    "continue",
    "looks good",
    "that works",
    "that work",
    "working now",
    "fixed",
    "resolved",
    "all good",
    "nice work",
    "well done",
    "lgtm",
  ];
  return fillers.includes(normalized);
}

export function extractObjective(allMessages: AgentMessage[]): string {
  const recent = allMessages.slice(-20);

  // 1. Prefer explicit objective markers in recent messages.
  const recentExplicit = findExplicitObjective(recent);
  if (recentExplicit) return recentExplicit;

  // 2. Prefer substantial non-filler user messages in recent messages.
  const recentSubstantial = findSubstantialObjective(recent);
  if (recentSubstantial) return recentSubstantial;

  // 3. Fall back to explicit markers in full history.
  const fullExplicit = findExplicitObjective(allMessages);
  if (fullExplicit) return fullExplicit;

  // 4. Fall back to substantial user messages in full history.
  const fullSubstantial = findSubstantialObjective(allMessages);
  if (fullSubstantial) return fullSubstantial;

  return "Continue current task.";
}

export function findExplicitObjective(
  messages: AgentMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const text = extractTextContent(msg);
      const firstLine = text.split(/\n/).find((l) => l.trim().length > 0) ?? "";
      const match = firstLine.match(
        /^(?:task|goal|objective|mission):\s*(.+)/i,
      );
      if (match) {
        return match[1].trim().slice(0, 200);
      }
    }
  }
  return undefined;
}

export function findSubstantialObjective(
  messages: AgentMessage[],
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "user") {
      const text = extractTextContent(msg);
      const firstLine = text.split(/\n/).find((l) => l.trim().length > 0) ?? "";
      if (firstLine.length > 5 && !isConversationalFiller(firstLine)) {
        return firstLine.slice(0, 200);
      }
    }
  }
  return undefined;
}

export function extractActiveFiles(messages: AgentMessage[]): string[] {
  const files = new Set<string>();
  for (const msg of messages) {
    if (msg.role === "assistant") {
      for (const block of getAssistantToolCallBlocks(msg)) {
        const args = block.arguments;
        if (!isToolCallArgumentsObject(args)) continue;
        if (typeof args.path === "string") files.add(args.path);
        if (typeof args.filePath === "string") files.add(args.filePath);
        if (Array.isArray(args.paths)) {
          for (const p of args.paths) {
            if (typeof p === "string") files.add(p);
          }
        }
      }
    }
  }
  return Array.from(files).slice(-10);
}

function hasValidationFailureEvidence(text: string): boolean {
  return (
    /\b[1-9]\d*\s+(?:failed|failures?|errors?)\b/i.test(text) ||
    /\b(?:failed|failures?|errors?)\s*[:=]\s*[1-9]\d*\b/i.test(text) ||
    /^\s*(?:FAIL|FAILED)\s+/im.test(text) ||
    /^\s*(?:error\s+(?:TS\d+|[A-Z_]+)|failure:)\b/im.test(text)
  );
}

function looksLikeSuccess(text: string): boolean {
  if (hasValidationFailureEvidence(text)) return false;
  return /(?:✓|passed|success|succeeded|completed successfully|exit code:? 0)/i.test(
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

function isValidationToolResult(message: AgentMessage): boolean {
  const toolName = getToolName(message);
  return [
    "run_biome",
    "run_cargo_test",
    "run_pytest",
    "run_typecheck",
    "run_vitest",
  ].includes(toolName ?? "");
}

function isValidationSuccess(message: AgentMessage): boolean {
  if (getIsError(message)) return false;
  if (message.role === "bashExecution") {
    const command = (message as { command?: unknown }).command;
    const output = (message as { output?: unknown }).output;
    const exitCode = (message as { exitCode?: unknown }).exitCode;
    const cancelled = (message as { cancelled?: unknown }).cancelled;
    if (cancelled === true) return false;
    if (typeof exitCode === "number" && exitCode !== 0) return false;
    return (
      typeof command === "string" &&
      typeof output === "string" &&
      commandLooksLikeValidation(command) &&
      looksLikeSuccess(output)
    );
  }
  return (
    message.role === "toolResult" &&
    isValidationToolResult(message) &&
    looksLikeSuccess(extractTextContent(message))
  );
}

function hasLaterSuccess(messages: AgentMessage[], index: number): boolean {
  return messages.slice(index + 1).some(isValidationSuccess);
}

function firstSubstantialLine(text: string): string {
  return (
    text
      .split(/\n/)
      .find((line) => line.trim().length > 5)
      ?.trim() ?? text
  );
}

export function extractBlockers(messages: AgentMessage[]): string[] {
  const blockers: string[] = [];
  for (let index = 0; index < messages.length; index++) {
    const msg = messages[index];
    const text = extractTextContent(msg);
    const lower = text.toLowerCase();
    const isError = msg.role === "toolResult" ? getIsError(msg) : false;
    if (isError) {
      if (hasLaterSuccess(messages, index)) continue;
      const line = firstSubstantialLine(text);
      if (line.length > 5) blockers.push(line.slice(0, 300));
      continue;
    }
    if (msg.role !== "assistant") continue;
    if (
      lower.includes("current blocker") ||
      lower.includes("blocked by") ||
      lower.includes("unable to proceed")
    ) {
      const line = firstSubstantialLine(text);
      if (line.length > 5) blockers.push(line.slice(0, 300));
    }
  }
  return Array.from(new Set(blockers)).slice(-5);
}

function pushDecision(decisions: string[], decision: string): void {
  const trimmed = decision.trim().slice(0, 300);
  if (trimmed.length > 5 && !isConversationalFiller(trimmed)) {
    decisions.push(trimmed);
  }
}

function extractStructuredDecisions(text: string): string[] {
  const decisions: string[] = [];
  let inDecisions = false;
  for (const line of text.split(/\n/)) {
    const heading = line.match(/^#{1,6}\s*(.+?)\s*$/);
    if (heading) {
      const normalized = heading[1]
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ");
      inDecisions = [
        "decision",
        "decisions",
        "decision made",
        "decisions made",
      ].includes(normalized);
      continue;
    }
    if (!inDecisions) continue;
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (bullet) pushDecision(decisions, bullet[1]);
  }
  return decisions;
}

export function extractDecisions(messages: AgentMessage[]): string[] {
  const decisions: string[] = [];
  for (const msg of messages) {
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = extractTextContent(msg);
    for (const decision of extractStructuredDecisions(text)) {
      pushDecision(decisions, decision);
    }

    const explicitPattern = /^\s*decision:\s*(.+)$/gim;
    let match: RegExpExecArray | null = explicitPattern.exec(text);
    while (match !== null) {
      pushDecision(decisions, match[1]);
      match = explicitPattern.exec(text);
    }

    if (msg.role !== "user") continue;
    const userPatterns = [
      /we (?:will|should|have decided to)\s*(.+)/i,
      /agreed (?:to|that)\s*(.+)/i,
      /going with\s*(.+)/i,
    ];
    for (const pattern of userPatterns) {
      const proseMatch = text.match(pattern);
      if (proseMatch) {
        pushDecision(decisions, proseMatch[1]);
      }
    }
  }
  return Array.from(new Set(decisions)).slice(-5);
}

function normalizeHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ");
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
      const normalized = normalizeHeading(heading[1]);
      inNextStepSection =
        normalized === "next step" || normalized === "next best step";
      continue;
    }
    if (!inNextStepSection || line.trim().length === 0) continue;
    const item = stripListMarker(line);
    if (item.length > 5 && !isConversationalFiller(item)) {
      return item.slice(0, 300);
    }
  }
  return undefined;
}

export function extractNextStep(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const text = extractTextContent(msg);

    const sectionItem = extractNextStepSection(text);
    if (sectionItem) return sectionItem;

    const pattern =
      /(?:next step|next action|then (?:we|I)\s+(?:should|will|need to|can))\s*:?\s*(.{5,})/i;
    const match = text.match(pattern);
    if (match) {
      const item = stripListMarker(match[1]);
      if (item.length > 5 && !isConversationalFiller(item)) {
        return item.slice(0, 300);
      }
    }
  }
  return "";
}

function shouldScanDependencyText(msg: AgentMessage, text: string): boolean {
  if (msg.role === "user") return true;
  if (msg.role !== "assistant") return false;
  return /##\s*(?:dependency chain|dependencies|blockers?|prerequisites?)/i.test(
    text,
  );
}

function extractStructuredDependencyItems(text: string): string[] {
  const chains: string[] = [];
  let inDependencySection = false;
  for (const line of text.split(/\n/)) {
    const heading = line.match(/^#{1,6}\s*(.+?)\s*$/);
    if (heading) {
      const normalized = heading[1]
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .replace(/\s+/g, " ");
      inDependencySection = [
        "dependency",
        "dependencies",
        "dependency chain",
        "prerequisite",
        "prerequisites",
      ].includes(normalized);
      continue;
    }
    if (!inDependencySection) continue;
    const bullet = line.match(/^\s*[-*]\s+(.+)/);
    if (!bullet) continue;
    const chain = bullet[1].trim().slice(0, 300);
    if (chain.length > 5 && !isConversationalFiller(chain)) {
      chains.push(chain);
    }
  }
  return chains;
}

export function extractDependencyChain(
  messages: AgentMessage[],
  knownDecisions: string[],
): string[] {
  const chains: string[] = [];
  const patterns = [
    /(?:depends? on|dependent on|blocked by|blocked on)\s*(.+)/i,
    /(?:because|since)\s*(.+)/i,
    /(?:therefore|thus|so|as a result|consequently)\s*(.+)/i,
    /(?:this requires|requires|prerequisite|precondition)\s*(.+)/i,
    /(?:after we|once we|following)\s*(.+)/i,
    /(?:links? to|relates? to|tied to)\s*(.+)/i,
  ];

  for (const msg of messages) {
    const text = extractTextContent(msg);
    if (msg.role === "user" || msg.role === "assistant") {
      for (const chain of extractStructuredDependencyItems(text)) {
        chains.push(chain);
      }
    }
    if (!shouldScanDependencyText(msg, text)) continue;
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      for (const pattern of patterns) {
        const match = sentence.match(pattern);
        if (match) {
          const link = match[1].trim().slice(0, 300);
          if (link.length > 5 && !isConversationalFiller(link)) {
            chains.push(link);
          }
        }
      }
    }
  }

  for (const decision of knownDecisions) {
    const decisionNorm = decision.toLowerCase().replace(/[^a-z0-9\s]/g, "");
    for (let i = 0; i < chains.length; i++) {
      const chainNorm = chains[i].toLowerCase().replace(/[^a-z0-9\s]/g, "");
      if (
        chainNorm.includes(decisionNorm) ||
        decisionNorm.includes(chainNorm) ||
        chainNorm
          .split(/\s+/)
          .some(
            (word) =>
              decisionNorm.split(/\s+/).includes(word) && word.length > 4,
          )
      ) {
        chains[i] = `${chains[i]} → Decision: ${decision}`;
      }
    }
  }

  return Array.from(new Set(chains)).slice(-5);
}
