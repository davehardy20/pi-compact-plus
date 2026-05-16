import type { AgentMessage } from "@earendil-works/pi-agent-core";

/**
 * Text extraction and low-level content analysis helpers.
 * These are the foundational building blocks used by snapshot and classify.
 */

export function extractTextContent(msg: AgentMessage): string {
  if (msg.role === "user") {
    if (typeof msg.content === "string") return msg.content;
    if (Array.isArray(msg.content)) {
      return msg.content
        .filter((c): c is { type: "text"; text: string } => c.type === "text")
        .map((c) => c.text)
        .join("\n");
    }
    return "";
  }
  if (msg.role === "assistant") {
    return msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (msg.role === "toolResult") {
    return msg.content
      .filter((c): c is { type: "text"; text: string } => c.type === "text")
      .map((c) => c.text)
      .join("\n");
  }
  if (msg.role === "bashExecution") {
    return `Command: ${(msg as { command: string }).command}\nOutput: ${(msg as { output: string }).output}`;
  }
  return "";
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
      for (const block of msg.content) {
        if (block.type === "toolCall") {
          const args = block.arguments as Record<string, unknown>;
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
  }
  return Array.from(files).slice(-10);
}

export function extractBlockers(messages: AgentMessage[]): string[] {
  const blockers: string[] = [];
  for (const msg of messages) {
    const text = extractTextContent(msg);
    const lower = text.toLowerCase();
    const isError =
      msg.role === "toolResult"
        ? ((msg as { isError?: boolean }).isError ?? false)
        : false;
    if (
      isError ||
      lower.includes("error") ||
      lower.includes("fail") ||
      lower.includes("cannot ") ||
      lower.includes("unable to")
    ) {
      const line = text.split(/\n/)[0] ?? text;
      if (line.length > 5) {
        blockers.push(line.slice(0, 300));
      }
    }
  }
  return Array.from(new Set(blockers)).slice(-5);
}

export function extractDecisions(messages: AgentMessage[]): string[] {
  const decisions: string[] = [];
  for (const msg of messages) {
    const text = extractTextContent(msg);
    const patterns = [
      /decision:\s*(.+)/i,
      /we (?:will|should|have decided to)\s*(.+)/i,
      /agreed (?:to|that)\s*(.+)/i,
      /going with\s*(.+)/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        decisions.push(match[1].trim().slice(0, 300));
      }
    }
  }
  return Array.from(new Set(decisions)).slice(-5);
}

export function extractNextStep(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const text = extractTextContent(msg);

    const patterns = [
      /(?:next step|next action|then (?:we|I)\s+(?:should|will|need to|can))\s*:?\s*(.{5,})/i,
      /##\s*next\s+(?:best\s+)?step\s*\n([-*]\s+.+)/i,
    ];
    for (const pattern of patterns) {
      const match = text.match(pattern);
      if (match) {
        const item = match[1].replace(/^[-*]\s+/, "").trim();
        if (item.length > 5 && !isConversationalFiller(item)) {
          return item.slice(0, 300);
        }
      }
    }
  }
  return "";
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
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      for (const pattern of patterns) {
        const match = sentence.match(pattern);
        if (match) {
          const link = match[1].trim().slice(0, 300);
          if (link.length > 5) {
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
