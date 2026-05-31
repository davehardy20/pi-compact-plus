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

export function extractCompletedWork(messages: AgentMessage[]): string[] {
	const items: string[] = [];
	for (const msg of messages) {
		const text = extractTextContent(msg);
		// Inline markdown checklist items: [x] ...
		const checklistPattern = /\[x\]\s*(.+)/g;
		let match: RegExpExecArray | null = checklistPattern.exec(text);
		while (match !== null) {
			const item = match[1].trim().slice(0, SNAPSHOT_MAX_LINE);
			if (item.length > 3) items.push(item);
			match = checklistPattern.exec(text);
		}
		// Prose patterns
		const prosePatterns = [
			/(?:completed|finished|done with|implemented|shipped|merged)\s+(.{10,})/gi,
			/(?:fixed|resolved|addressed|closed)\s+(.{10,})/gi,
		];
		for (const pattern of prosePatterns) {
			match = pattern.exec(text);
			while (match !== null) {
				const item = match[1].trim().slice(0, SNAPSHOT_MAX_LINE);
				if (item.length > 5) items.push(item);
				match = pattern.exec(text);
			}
		}
		// Structured sections: ## Completed Work / ## Done
		const sectionMatch = text.match(
			/##\s*(?:completed work|done|finished|implemented)\s*\n((?:[-*]\s+.+\n?)+)/i,
		);
		if (sectionMatch) {
			for (const line of sectionMatch[1].split(/\n/)) {
				const item = line.replace(/^[-*]\s+/, "").trim();
				if (item.length > 5) items.push(item.slice(0, SNAPSHOT_MAX_LINE));
			}
		}
	}
	return Array.from(new Set(items)).slice(-SNAPSHOT_MAX_ITEMS);
}

export function extractOpenProblems(messages: AgentMessage[]): string[] {
	const items: string[] = [];
	for (const msg of messages) {
		const text = extractTextContent(msg);
		// Inline patterns
		const patterns = [
			/(?:open problem|open issue|still (?:need|missing|todo|pending|outstanding))\s*:?\s*(.{5,})/gi,
			/(?:not yet (?:done|implemented|resolved|fixed))\s*:?\s*(.{5,})/gi,
		];
		let match: RegExpExecArray | null;
		for (const pattern of patterns) {
			match = pattern.exec(text);
			while (match !== null) {
				const item = match[1].trim().slice(0, SNAPSHOT_MAX_LINE);
				if (item.length > 5 && !isConversationalFiller(item)) items.push(item);
				match = pattern.exec(text);
			}
		}
		// Structured sections: ## Open Problems / ## TODO
		const sectionMatch = text.match(
			/##\s*(?:open problems?|todo|remaining|outstanding)\s*\n((?:[-*]\s+.+\n?)+)/i,
		);
		if (sectionMatch) {
			for (const line of sectionMatch[1].split(/\n/)) {
				const item = line.replace(/^[-*]\s+/, "").trim();
				if (item.length > 5) items.push(item.slice(0, SNAPSHOT_MAX_LINE));
			}
		}
	}
	return Array.from(new Set(items)).slice(-SNAPSHOT_MAX_ITEMS);
}

export function extractCurrentErrors(messages: AgentMessage[]): string[] {
	const errors: string[] = [];
	for (const msg of messages) {
		// Only tool results and assistant messages carry error info
		if (msg.role !== "toolResult" && msg.role !== "assistant") continue;

		const text = extractTextContent(msg);

		// Explicit isError flag on tool results
		if (msg.role === "toolResult") {
			const isError = (msg as { isError?: boolean }).isError ?? false;
			if (isError) {
				const line = text.split(/\n/)[0] ?? text;
				if (line.length > 5)
					errors.push(line.trim().slice(0, SNAPSHOT_MAX_LINE));
				continue;
			}
		}

		// Heuristic: error lines with codes or file paths
		const errorPatterns = [
			/error TS\d+:\s*(.{10,})/g,
			/error:\s*(.{10,})/gi,
			/(?:ENOENT|EPERM|EACCES|TypeError|ReferenceError|SyntaxError|RuntimeError):?\s*(.{10,})/gi,
		];
		let match: RegExpExecArray | null;
		for (const pattern of errorPatterns) {
			match = pattern.exec(text);
			while (match !== null) {
				const item = (match[1] ?? match[0]).trim().slice(0, SNAPSHOT_MAX_LINE);
				if (item.length > 3) errors.push(item);
				match = pattern.exec(text);
			}
		}
	}
	return Array.from(new Set(errors)).slice(-5);
}

export function extractConstraints(messages: AgentMessage[]): string[] {
	const items: string[] = [];
	for (const msg of messages) {
		const text = extractTextContent(msg);
		const patterns = [
			/(?:constraint|limitation|requirement|must (?:not|always|use|be))\s*:?\s*(.{5,})/gi,
			/(?:cannot|do not|should not|avoid)\s+(.{5,})/gi,
		];
		let match: RegExpExecArray | null;
		for (const pattern of patterns) {
			match = pattern.exec(text);
			while (match !== null) {
				const item = match[1].trim().slice(0, SNAPSHOT_MAX_LINE);
				if (item.length > 5 && !isConversationalFiller(item)) items.push(item);
				match = pattern.exec(text);
			}
		}
		// Structured sections: ## Constraints / ## Rules
		const sectionMatch = text.match(
			/##\s*(?:constraints?|rules?)\s*\n((?:[-*]\s+.+\n?)+)/i,
		);
		if (sectionMatch) {
			for (const line of sectionMatch[1].split(/\n/)) {
				const item = line.replace(/^[-*]\s+/, "").trim();
				if (item.length > 5) items.push(item.slice(0, SNAPSHOT_MAX_LINE));
			}
		}
	}
	return Array.from(new Set(items)).slice(-5);
}

export function extractFailedAttempts(messages: AgentMessage[]): string[] {
	const items: string[] = [];
	for (const msg of messages) {
		const text = extractTextContent(msg);
		const patterns = [
			/(?:failed|didn'?t work|rejected|abandoned|rolled back|reverted)\s*(.{5,})/gi,
			/(?:attempt \d+|try \d+)\s*:?\s*(.{5,})/gi,
		];
		let match: RegExpExecArray | null;
		for (const pattern of patterns) {
			match = pattern.exec(text);
			while (match !== null) {
				const item = match[1].trim().slice(0, SNAPSHOT_MAX_LINE);
				if (item.length > 5) items.push(item);
				match = pattern.exec(text);
			}
		}
		// Structured sections: ## Failed Attempts
		const sectionMatch = text.match(
			/##\s*(?:failed attempts?|failed paths?|rejected)\s*\n((?:[-*]\s+.+\n?)+)/i,
		);
		if (sectionMatch) {
			for (const line of sectionMatch[1].split(/\n/)) {
				const item = line.replace(/^[-*]\s+/, "").trim();
				if (item.length > 5) items.push(item.slice(0, SNAPSHOT_MAX_LINE));
			}
		}
	}
	return Array.from(new Set(items)).slice(-5);
}

function extractNextStep(messages: AgentMessage[]): string {
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
					return item.slice(0, SNAPSHOT_MAX_LINE);
				}
			}
		}
	}
	return "";
}
