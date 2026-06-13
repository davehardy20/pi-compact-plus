import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	extractMessageText,
	getAssistantToolCallBlocks,
	getIsError,
	getToolName,
	isToolCallArgumentsObject,
} from "./pi-messages.js";
import type { SessionBranchView } from "./session-branch-view.js";
import type { CurrentFocus, SessionSnapshot } from "./types.js";

/**
 * Session Evidence is the caller-facing seam for facts recovered from session
 * messages. It owns message-role parsing, scan windows, heading/regex rules,
 * validation evidence, stale/resolved interpretation, and dedupe. Callers own
 * policy decisions such as compaction timing, prompt wording, and UI rendering.
 */

const SNAPSHOT_MAX_ITEMS = 10;
const SNAPSHOT_MAX_LINE = 300;
const CURRENT_FOCUS_RECENT_WINDOW = 20;
const SNAPSHOT_RECENT_WINDOW = 20;
const SNAPSHOT_FOCUS_RECENT_WINDOW = 30;
const MAX_OBJECTIVE_CHARS = 200;
const MAX_ACTIVE_FILES = 10;
const MAX_BLOCKERS = 5;
const MAX_DECISIONS = 5;
const MAX_DEPENDENCY_CHAIN = 5;

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

function normalizeHeading(heading: string): string {
	return heading
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9\s]/g, "")
		.replace(/\s+/g, " ");
}

function headingMatches(heading: string, allowedHeadings: string[]): boolean {
	const normalized = normalizeHeading(heading);
	return allowedHeadings.some((allowed) => normalized === allowed);
}

function stripListMarker(line: string): string {
	return line
		.replace(/^[-*]\s+/, "")
		.replace(/^\d+[.)]\s+/, "")
		.trim();
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
	return /(?:✓|\bpassed\b|\bsuccess\b|\bsuccessful(?:ly)?\b|\bsucceeded\b|completed successfully|exit code:? 0)/i.test(
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

function isValidationSuccess(msg: AgentMessage): boolean {
	return validationSuccessItem(msg) !== undefined;
}

function hasLaterValidationSuccess(
	messages: AgentMessage[],
	index: number,
): boolean {
	return messages.slice(index + 1).some((message) => {
		if (message.role !== "toolResult" && message.role !== "bashExecution") {
			return false;
		}
		return isValidationSuccess(message);
	});
}

export function extractObjective(allMessages: AgentMessage[]): string {
	const recent = allMessages.slice(-CURRENT_FOCUS_RECENT_WINDOW);

	const recentExplicit = findExplicitObjective(recent);
	if (recentExplicit) return recentExplicit;

	const recentSubstantial = findSubstantialObjective(recent);
	if (recentSubstantial) return recentSubstantial;

	const fullExplicit = findExplicitObjective(allMessages);
	if (fullExplicit) return fullExplicit;

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
				return match[1].trim().slice(0, MAX_OBJECTIVE_CHARS);
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
				return firstLine.slice(0, MAX_OBJECTIVE_CHARS);
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
	return Array.from(files).slice(-MAX_ACTIVE_FILES);
}

export function extractBlockers(messages: AgentMessage[]): string[] {
	const blockers: string[] = [];
	for (let index = 0; index < messages.length; index++) {
		const msg = messages[index];
		const text = extractTextContent(msg);
		const lower = text.toLowerCase();
		if (isToolError(msg)) {
			if (hasLaterValidationSuccess(messages, index)) continue;
			const line = firstSubstantialLine(text);
			if (line.length > 5) blockers.push(line.slice(0, SNAPSHOT_MAX_LINE));
			continue;
		}
		if (msg.role !== "assistant") continue;
		if (
			lower.includes("current blocker") ||
			lower.includes("blocked by") ||
			lower.includes("unable to proceed")
		) {
			const line = firstSubstantialLine(text);
			if (line.length > 5) blockers.push(line.slice(0, SNAPSHOT_MAX_LINE));
		}
	}
	return uniqueLast(blockers, MAX_BLOCKERS);
}

function pushDecision(decisions: string[], decision: string): void {
	const trimmed = decision.trim().slice(0, SNAPSHOT_MAX_LINE);
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
			const normalized = normalizeHeading(heading[1]);
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
	return uniqueLast(decisions, MAX_DECISIONS);
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
			return item.slice(0, SNAPSHOT_MAX_LINE);
		}
	}
	return undefined;
}

export function extractNextStep(messages: AgentMessage[]): string {
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
			const normalized = normalizeHeading(heading[1]);
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
		const chain = bullet[1].trim().slice(0, SNAPSHOT_MAX_LINE);
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
					const link = match[1].trim().slice(0, SNAPSHOT_MAX_LINE);
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

	return uniqueLast(chains, MAX_DEPENDENCY_CHAIN);
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
	return uniqueLast(errors, MAX_BLOCKERS);
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
	return uniqueLast(items, MAX_BLOCKERS);
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
	return uniqueLast(items, MAX_BLOCKERS);
}

export function extractCurrentFocus(messages: AgentMessage[]): CurrentFocus {
	const recent = messages.slice(-CURRENT_FOCUS_RECENT_WINDOW);
	const objective = extractObjective(messages);
	const decisions = extractDecisions(messages);
	const activeFiles = extractActiveFiles(messages);
	const blockers = extractBlockers(recent);
	const dependencyChain = extractDependencyChain(recent, decisions);
	return { objective, blockers, decisions, activeFiles, dependencyChain };
}

export function extractCurrentFocusFromBranch(
	view: SessionBranchView,
): CurrentFocus {
	return extractCurrentFocus(view.messages());
}

export function extractSessionSnapshot(
	messages: AgentMessage[],
): SessionSnapshot {
	const recent = messages.slice(-SNAPSHOT_RECENT_WINDOW);
	const focusRecent = messages.slice(-SNAPSHOT_FOCUS_RECENT_WINDOW);
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

export function extractSessionSnapshotFromBranch(
	view: SessionBranchView,
): SessionSnapshot {
	return extractSessionSnapshot(view.messages());
}
