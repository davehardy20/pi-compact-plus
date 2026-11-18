import { isProxy } from "node:util/types";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { compact } from "@earendil-works/pi-coding-agent";
import {
	RECOVERY_LIMIT_REASON,
	RECOVERY_UNSUPPORTED_REASON,
} from "./summarization-overflow.js";

export interface RecoveryCopyBudget {
	chars: number;
	nodes: number;
}

export function createRecoveryCopyBudget(): RecoveryCopyBudget {
	return { chars: 8_000_000, nodes: 100_000 };
}

export function spendRecoveryText(
	value: string,
	budget: RecoveryCopyBudget,
): void {
	if (typeof value !== "string") unsupported();
	budget.chars -= value.length;
	if (budget.chars < 0) throw new Error(RECOVERY_LIMIT_REASON);
}

function unsupported(): never {
	throw new Error(RECOVERY_UNSUPPORTED_REASON);
}

function node(budget: RecoveryCopyBudget, depth = 0): void {
	if (--budget.nodes < 0 || depth > 256) throw new Error(RECOVERY_LIMIT_REASON);
}

/** Read only own data. Never invoke an accessor or inherit a requested field. */
function own(value: object, key: string): unknown {
	if (isProxy(value)) unsupported();
	const descriptor = Object.getOwnPropertyDescriptor(value, key);
	if (descriptor) {
		if (!("value" in descriptor)) unsupported();
		return descriptor.value;
	}
	let depth = 0;
	for (let owner = Object.getPrototypeOf(value); owner; ) {
		if (++depth > 8 || isProxy(owner)) unsupported();
		if (Object.getOwnPropertyDescriptor(owner, key)) unsupported();
		owner = Object.getPrototypeOf(owner);
	}
	return undefined;
}

function noJsonHook(value: object): void {
	let depth = 0;
	for (let owner: object | null = value; owner; ) {
		if (++depth > 8 || isProxy(owner)) unsupported();
		const descriptor = Object.getOwnPropertyDescriptor(owner, "toJSON");
		if (descriptor) {
			if (!("value" in descriptor) || typeof descriptor.value === "function")
				unsupported();
			return;
		}
		owner = Object.getPrototypeOf(owner);
	}
}

function record(value: unknown): Record<string, unknown> {
	if (
		value === null ||
		typeof value !== "object" ||
		isProxy(value) ||
		Array.isArray(value)
	)
		unsupported();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Object.prototype && prototype !== null) unsupported();
	noJsonHook(value);
	return value as Record<string, unknown>;
}

function arrayLength(value: unknown, budget: RecoveryCopyBudget): number {
	if (isProxy(value) || !Array.isArray(value)) unsupported();
	const prototype = Object.getPrototypeOf(value);
	if (prototype !== Array.prototype && prototype !== null) unsupported();
	noJsonHook(value);
	if (Object.getOwnPropertyDescriptor(value, Symbol.iterator)) unsupported();
	const length = own(value, "length");
	if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0)
		unsupported();
	if (length > budget.nodes) throw new Error(RECOVERY_LIMIT_REASON);
	return length;
}

/** Define indices, rather than assigning through a potentially polluted prototype. */
function append(array: unknown[], value: unknown): void {
	Object.defineProperty(array, String(array.length), {
		value,
		enumerable: true,
		writable: true,
		configurable: true,
	});
}

/** Copy JSON data in one bounded pass; later readers never see the original graph. */
function copyJson(
	value: unknown,
	budget: RecoveryCopyBudget,
	ancestors = new WeakSet<object>(),
	depth = 0,
): unknown {
	node(budget, depth);
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		spendRecoveryText(value, budget);
		return value;
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) unsupported();
		return value;
	}
	if (typeof value !== "object" || isProxy(value) || ancestors.has(value))
		unsupported();
	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			const length = arrayLength(value, budget);
			const copy: unknown[] = [];
			for (let index = 0; index < length; index++) {
				const item = own(value, String(index));
				// Holes are JSON nulls, but inherited indices were rejected by own().
				const present = Object.hasOwn(value, String(index));
				append(
					copy,
					copyJson(present ? item : null, budget, ancestors, depth + 1),
				);
			}
			return copy;
		}
		const source = record(value);
		const copy: Record<string, unknown> = Object.create(null);
		const keys = Object.getOwnPropertyNames(source);
		if (keys.length > budget.nodes) throw new Error(RECOVERY_LIMIT_REASON);
		for (const key of keys) {
			// Account for descriptor inspection even when JSON omits the field.
			node(budget);
			const descriptor = Object.getOwnPropertyDescriptor(source, key);
			if (!descriptor || !("value" in descriptor)) unsupported();
			// Hidden accessors are unsafe even though JSON would omit their fields.
			if (!descriptor.enumerable) continue;
			spendRecoveryText(key, budget);
			copy[key] = copyJson(descriptor.value, budget, ancestors, depth + 1);
		}
		return copy;
	} finally {
		ancestors.delete(value);
	}
}

function field(
	source: object,
	target: Record<string, unknown>,
	key: string,
	kind: "string" | "boolean" | "integer",
	budget: RecoveryCopyBudget,
	required = false,
	nullable = false,
): void {
	const value = own(source, key);
	if (value === undefined && !required) return;
	if (value === null && nullable) {
		target[key] = null;
		return;
	}
	if (kind === "integer") {
		if (typeof value !== "number" || !Number.isSafeInteger(value))
			unsupported();
	} else if (typeof value !== kind) unsupported();
	if (typeof value === "string") spendRecoveryText(value, budget);
	target[key] = value;
}

function content(
	value: unknown,
	budget: RecoveryCopyBudget,
	readerOnly: boolean,
): unknown[] {
	if (typeof value === "string") {
		spendRecoveryText(value, budget);
		return [{ type: "text", text: value }];
	}
	if (!Array.isArray(value)) unsupported();
	const length = arrayLength(value, budget);
	const copy: unknown[] = [];
	for (let index = 0; index < length; index++) {
		node(budget);
		const block = record(own(value, String(index)));
		const type = own(block, "type");
		if (type === "thinking") continue;
		// Evidence readers ignore non-text blocks in retained (not summarized) turns.
		if (readerOnly && type !== "text" && type !== "toolCall") continue;
		const safe: Record<string, unknown> = Object.create(null);
		field(block, safe, "type", "string", budget, true);
		if (type === "text") field(block, safe, "text", "string", budget, true);
		else if (type === "toolCall") {
			field(block, safe, "id", "string", budget, true);
			field(block, safe, "name", "string", budget, true);
			const args = record(own(block, "arguments"));
			safe.arguments = copyJson(args, budget);
		} else unsupported();
		append(copy, safe);
	}
	return copy;
}

/**
 * Reader-only projections, not SDK transport messages. The controlled assertion
 * adapts the existing evidence-reader signatures; transport metadata is omitted.
 * Source records are later JSON-encoded as user data before any SDK request.
 */
export function snapshotRecoveryMessages(
	messages: AgentMessage[],
	budget: RecoveryCopyBudget,
	readerOnly = false,
): AgentMessage[] {
	const length = arrayLength(messages, budget);
	if (length > 10_000) throw new Error(RECOVERY_LIMIT_REASON);
	const snapshots: AgentMessage[] = [];
	for (let index = 0; index < length; index++) {
		node(budget);
		const raw = record(own(messages, String(index)));
		const role = own(raw, "role");
		if (typeof role !== "string" || !role) unsupported();
		if (role === "bashExecution") {
			const excluded = own(raw, "excludeFromContext");
			if (excluded !== undefined && typeof excluded !== "boolean")
				unsupported();
			if (excluded === true) continue;
		}
		const safe: Record<string, unknown> = Object.create(null);
		field(raw, safe, "role", "string", budget, true);
		if (role === "bashExecution") {
			field(raw, safe, "command", "string", budget, true);
			field(raw, safe, "output", "string", budget, true);
			field(raw, safe, "exitCode", "integer", budget);
			field(raw, safe, "cancelled", "boolean", budget);
			field(raw, safe, "truncated", "boolean", budget);
			field(raw, safe, "fullOutputPath", "string", budget);
		} else if (role === "branchSummary" || role === "compactionSummary") {
			field(raw, safe, "summary", "string", budget, true);
			if (role === "branchSummary")
				field(raw, safe, "fromId", "string", budget, false, true);
			else {
				field(raw, safe, "tokensBefore", "integer", budget);
				if (typeof safe.tokensBefore === "number" && safe.tokensBefore < 0)
					unsupported();
			}
		} else {
			if (role === "toolResult") {
				field(raw, safe, "toolName", "string", budget, true);
				field(raw, safe, "toolCallId", "string", budget, true);
				field(raw, safe, "isError", "boolean", budget);
			}
			safe.content = content(own(raw, "content"), budget, readerOnly);
		}
		append(snapshots, safe as unknown as AgentMessage);
	}
	return snapshots;
}

type Preparation = Parameters<typeof compact>[0];

/**
 * Capture evidence and SDK preparation data once. Model, signal and execution
 * callbacks are trusted control inputs, owned separately by the caller.
 */
export function snapshotRecoveryInputs(options: {
	preparation: Preparation;
	projected?: AgentMessage[];
	customInstructions?: string;
}) {
	const budget = createRecoveryCopyBudget();
	const input = record(options);
	const raw = record(own(input, "preparation"));
	const preparation: Record<string, unknown> = Object.create(null);
	field(raw, preparation, "firstKeptEntryId", "string", budget, true);
	field(raw, preparation, "tokensBefore", "integer", budget, true);
	field(raw, preparation, "isSplitTurn", "boolean", budget, true);
	field(raw, preparation, "previousSummary", "string", budget);
	if (preparation.firstKeptEntryId === "") unsupported();

	const rawSettings = record(own(raw, "settings"));
	const settings: Record<string, unknown> = Object.create(null);
	field(rawSettings, settings, "enabled", "boolean", budget, true);
	field(rawSettings, settings, "reserveTokens", "integer", budget, true);
	field(rawSettings, settings, "keepRecentTokens", "integer", budget, true);
	for (const value of [
		preparation.tokensBefore,
		settings.reserveTokens,
		settings.keepRecentTokens,
	]) {
		if (typeof value !== "number" || value < 0) unsupported();
	}
	preparation.settings = settings;
	// SDK-owned Sets are not evidence text. Preserve the exact fileOps identity.
	preparation.fileOps = record(own(raw, "fileOps"));
	const supplemental: Record<string, unknown> = Object.create(null);
	field(input, supplemental, "customInstructions", "string", budget);

	const history = own(raw, "messagesToSummarize");
	const prefix = own(raw, "turnPrefixMessages");
	if (arrayLength(history, budget) + arrayLength(prefix, budget) > 10_000)
		throw new Error(RECOVERY_LIMIT_REASON);
	const messages = snapshotRecoveryMessages(history as AgentMessage[], budget);
	const turnPrefix = preparation.isSplitTurn
		? snapshotRecoveryMessages(prefix as AgentMessage[], budget)
		: [];
	preparation.messagesToSummarize = messages;
	preparation.turnPrefixMessages = turnPrefix;
	const source = messages.concat(turnPrefix);
	const projected = own(input, "projected");
	return {
		preparation: preparation as unknown as Preparation,
		source,
		projected:
			projected === undefined
				? source
				: snapshotRecoveryMessages(projected as AgentMessage[], budget, true),
		customInstructions: supplemental.customInstructions as string | undefined,
		budget,
	};
}
