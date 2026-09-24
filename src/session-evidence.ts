import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { detectCompactionSummary } from "./focus-echo/detection.js";
import { extractFocusEchoDraft } from "./focus-echo/draft.js";
import {
	extractMessageText,
	getAssistantToolCallBlocks,
	getIsError,
	getToolName,
	isToolCallArgumentsObject,
} from "./pi-messages.js";
import type { SessionBranchView } from "./session-branch-view.js";
import {
	CONTINUATION_PROMPT,
	type CurrentFocus,
	type IntentEvidence,
	type SessionSnapshot,
} from "./types.js";

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
const MAX_INTENT_TURNS = 4;
const MAX_INTENT_TURN_CHARS = 300;
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
	// Only a clear new request replaces an active objective. Unlabeled factual
	// replies remain context; without a prior task, the oldest substantive user
	// message is the best available starting objective.
	let initialUnlabeled: string | undefined;
	for (let i = allMessages.length - 1; i >= 0; i--) {
		const message = [allMessages[i]];
		const explicit = findExplicitObjective(message);
		if (explicit) return explicit;
		const substantial = findSubstantialObjective(message);
		if (!substantial) continue;
		if (isClearRequest(substantial)) return substantial;
		initialUnlabeled = substantial;
	}
	// On repeated compaction, no original user request may survive the active
	// projection. Only validated, persisted Pi memory can supply that objective.
	const persisted = detectCompactionSummary(allMessages);
	if (persisted.found) {
		const objective = extractFocusEchoDraft(persisted.summaryText).objective;
		if (objective) return objective.slice(0, MAX_OBJECTIVE_CHARS);
	}
	return initialUnlabeled ?? "Continue current task.";
}

function boundIntentTurn(text: string): string {
	if (text.length <= MAX_INTENT_TURN_CHARS) return text;
	// Retain both ends: a long user message may redirect only at its end.
	return `${text.slice(0, 140)} … ${text.slice(-140)}`;
}

function extractIntentEvidence(
	messages: AgentMessage[],
	priorObjective: string,
): IntentEvidence | undefined {
	const userTurns = messages
		.filter((message) => message.role === "user")
		.map((message) =>
			extractTextContent(message)
				.split(/\n/)
				.map((line) => line.trim())
				.filter((line) => line && line !== CONTINUATION_PROMPT)
				.join("\n"),
		)
		.filter(Boolean);
	const recentUserTurns = userTurns
		.slice(-MAX_INTENT_TURNS)
		.map(boundIntentTurn);
	if (recentUserTurns.length === 0) {
		return detectCompactionSummary(messages).found
			? { priorObjective, certainty: "memory", recentUserTurns }
			: undefined;
	}
	// The final projected user line controls certainty, not the last line
	// recognized by our finite verb vocabulary. Unknown redirects remain visible.
	const lastUserLine = userTurns.at(-1)?.split("\n").at(-1);
	const explicit = lastUserLine?.match(
		/^(?:task|goal|objective|mission):\s*(.+)/i,
	);
	return {
		priorObjective,
		certainty:
			explicit?.[1].trim() === priorObjective ? "confirmed" : "provisional",
		recentUserTurns,
	};
}

function objectiveLineContent(line: string): string {
	return (
		line.match(/^(?:task|goal|objective|mission):\s*(.*)/i)?.[1].trim() ?? line
	);
}

function firstObjectiveLine(msg: AgentMessage): string | undefined {
	if (msg.role !== "user") return undefined;
	// Prefer an actionable line even when a preceding status uses unfamiliar
	// wording. Ignore exact generated continuation and empty labels.
	const candidates = extractTextContent(msg)
		.split(/\n/)
		.map((line) => line.trim())
		.filter((line) => {
			if (!line || line === CONTINUATION_PROMPT) return false;
			const content = objectiveLineContent(line);
			return content.length > 0 && !isStatusOnlyReply(content);
		});
	const actionable = candidates.filter(
		(line) =>
			/^(?:task|goal|objective|mission):\s*\S/i.test(line) ||
			isClearRequest(objectiveLineContent(line)),
	);
	return actionable.at(-1) ?? candidates[0];
}

// Acknowledgements and successful status updates are evidence about progress,
// not replacements for the user's active request. All conjoined clauses must
// independently describe a status; an attached directive remains eligible.
function isStatusOnlyClause(text: string): boolean {
	const clause = text
		.trim()
		.replace(/[,.!?]+$/, "")
		.trim();
	if (isConversationalFiller(clause)) return true;
	return [
		/^(?:thanks|thank you),? (?:that|this|it) (?:helped|works?|is (?:great|good|fine|fixed|resolved))$/,
		/^(?:that|this|it|everything) works?(?: now)?$/,
		/^(?:that|this|it|everything) (?:is|was|looks?) (?:good|fine|okay|working|fixed|resolved|done|complete)(?: now)?$/,
		/^(?:the )?(?:checks?|tests?|build|ci) (?:is|are|was|were) (?:green|passing|working|done|complete|successful)(?: now)?$/,
		/^(?:the )?(?:checks?|tests?|build|ci) (?:passed|succeeded|completed)(?: now)?$/,
		/^i(?:'ve| have)? (?:finished|completed|fixed|resolved|done|merged|deployed) (?:(?:that|this|it)(?: part)?|the [a-z0-9 -]+)$/,
		/^i(?:'m| am) done(?: with (?:that|this|it))?$/,
	].some((pattern) => pattern.test(clause));
}

function isStatusOnlyReply(text: string): boolean {
	const normalized = text
		.trim()
		.toLowerCase()
		.replace(/\u2019/g, "'")
		.replace(/[.!?]+$/, "")
		.replace(/,?\s*(?:thanks|thank you)[.!?]*$/, "")
		.trim();
	return normalized
		.split(/,?\s+(?:and|but)\s+|;\s*/)
		.every((clause) => isStatusOnlyClause(clause));
}

// A cancellation overrides an active goal even below the usual length floor.
function isShortCancellation(text: string): boolean {
	return /^(?:stop|cancel|abort|never mind|scratch that|forget it|drop it)$/i.test(
		text.trim().replace(/[.!?]+$/, ""),
	);
}

// Conservative objective precedence: ambiguous declarative replies do not
// replace an existing task. A later clause can still introduce a clear request.
function isClearRequest(text: string): boolean {
	const normalized = text
		.trim()
		.toLowerCase()
		.replace(/\u2019/g, "'");
	if (isShortCancellation(normalized) || normalized.endsWith("?")) return true;
	return normalized
		.split(/[,;.!?:—–]\s*(?:and|but)?\s*|\s+(?:and|but)\s+/)
		.some((part) => {
			const clause = part.trim();
			if (isShortCancellation(clause)) return true;
			if (/^(?:please|kindly)\s+\S/.test(clause)) return true;
			return /^(?:(?:actually|instead|now|next|no)\b[,:]?\s*)*(?:(?:stop|cancel|abort|repair|fix|investigate|update|build|implement|run|test|check|add|remove|create|move|change|use|find|review|explain|help|research|write|deploy|start|continue|complete|summarize|show|tell|debug|improve|refactor|look|analyze|focus|switch|pivot|forget|drop|do|don't)\b|(?:can|could|would|will|shall)\s+(?:you|we|i)\b|(?:i|we)\s+(?:need|want|should|would like)\b|i(?:'d| would)\s+rather\b|(?:let's|let us|you\s+(?:should|need to))\b)/.test(
				clause,
			);
		});
}

export function findExplicitObjective(
	messages: AgentMessage[],
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const firstLine = firstObjectiveLine(messages[i]);
		const match = firstLine?.match(/^(?:task|goal|objective|mission):\s*(.+)/i);
		if (match && !isStatusOnlyReply(match[1])) {
			return match[1].trim().slice(0, MAX_OBJECTIVE_CHARS);
		}
	}
	return undefined;
}

export function findSubstantialObjective(
	messages: AgentMessage[],
): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const firstLine = firstObjectiveLine(messages[i]);
		if (!firstLine) continue;
		const content = objectiveLineContent(firstLine);
		if (
			isShortCancellation(content) ||
			(content.length > 5 && !isStatusOnlyReply(content))
		) {
			return firstLine.slice(0, MAX_OBJECTIVE_CHARS);
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
	return {
		objective,
		intentEvidence: extractIntentEvidence(messages, objective),
		blockers,
		decisions,
		activeFiles,
		dependencyChain,
	};
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
