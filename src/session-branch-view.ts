import type { AgentMessage } from "@earendil-works/pi-agent-core";

import { isSessionMessageEntry } from "./pi-messages.js";

export interface SessionBranchEntryLike {
	readonly type: string;
	readonly id: string;
	readonly customType?: string;
	readonly data?: unknown;
	readonly message?: AgentMessage;
}

export interface SessionBranchMessageEntry extends SessionBranchEntryLike {
	readonly type: "message";
	readonly message: AgentMessage;
}

export interface SessionBranchCustomEntry extends SessionBranchEntryLike {
	readonly type: "custom";
	readonly customType: string;
	readonly data?: unknown;
}

export interface SessionBranchViewContext {
	readonly sessionManager: {
		getBranch(): readonly SessionBranchEntryLike[];
	};
}

export interface CustomEntryScanOptions {
	/** Maximum matching entries to return. Defaults to 50. */
	readonly limit?: number;
	/** Maximum raw branch entries to inspect from the start of the branch. Defaults to 500. */
	readonly maxScanEntries?: number;
}

export interface CustomEntryScanResult {
	readonly entries: readonly SessionBranchCustomEntry[];
	readonly scannedEntries: number;
	readonly matchedEntries: number;
	readonly hitResultLimit: boolean;
	readonly hitScanLimit: boolean;
}

export interface SessionBranchView {
	messageEntries(): SessionBranchMessageEntry[];
	messages(): AgentMessage[];
	recentMessageEntries(count: number): SessionBranchMessageEntry[];
	recentMessages(count: number): AgentMessage[];
	entryIds(): ReadonlySet<string>;
	hasEntry(id: string): boolean;
	messageEntryById(id: string): SessionBranchMessageEntry | undefined;
	customEntries(
		customType: string,
		options?: CustomEntryScanOptions,
	): CustomEntryScanResult;
}

const DEFAULT_CUSTOM_ENTRY_LIMIT = 50;
const DEFAULT_CUSTOM_ENTRY_MAX_SCAN_ENTRIES = 500;

function isSessionBranchMessageEntry(
	entry: SessionBranchEntryLike,
): entry is SessionBranchMessageEntry {
	return isSessionMessageEntry(entry);
}

function isSessionBranchCustomEntry(
	entry: SessionBranchEntryLike,
): entry is SessionBranchCustomEntry {
	return (
		entry.type === "custom" &&
		typeof (entry as { customType?: unknown }).customType === "string"
	);
}

function normalizeBoundedCount(
	value: number | undefined,
	fallback: number,
): number {
	if (value === undefined) return fallback;
	if (!Number.isFinite(value)) return fallback;
	return Math.max(0, Math.floor(value));
}

function sliceRecent<T>(entries: readonly T[], count: number): T[] {
	const normalizedCount = normalizeBoundedCount(count, 0);
	if (normalizedCount <= 0) return [];
	return entries.slice(-normalizedCount);
}

export function createSessionBranchView(
	entries: readonly SessionBranchEntryLike[],
): SessionBranchView {
	const branchEntries = Object.freeze([...entries]);
	const messageEntries = Object.freeze(
		branchEntries.filter(isSessionBranchMessageEntry),
	);
	const messages = Object.freeze(messageEntries.map((entry) => entry.message));
	const entryIds = new Set(branchEntries.map((entry) => entry.id));
	const messageEntriesById = new Map(
		messageEntries.map((entry) => [entry.id, entry] as const),
	);

	return Object.freeze({
		messageEntries: () => [...messageEntries],
		messages: () => [...messages],
		recentMessageEntries: (count: number) => sliceRecent(messageEntries, count),
		recentMessages: (count: number) => sliceRecent(messages, count),
		entryIds: () => new Set(entryIds),
		hasEntry: (id: string) => entryIds.has(id),
		messageEntryById: (id: string) => messageEntriesById.get(id),
		customEntries: (
			customType: string,
			options: CustomEntryScanOptions = {},
		): CustomEntryScanResult => {
			const limit = normalizeBoundedCount(
				options.limit,
				DEFAULT_CUSTOM_ENTRY_LIMIT,
			);
			const maxScanEntries = normalizeBoundedCount(
				options.maxScanEntries,
				DEFAULT_CUSTOM_ENTRY_MAX_SCAN_ENTRIES,
			);
			const scanCount = Math.min(branchEntries.length, maxScanEntries);
			const matches: SessionBranchCustomEntry[] = [];

			for (const entry of branchEntries.slice(0, scanCount)) {
				if (!isSessionBranchCustomEntry(entry)) continue;
				if (entry.customType !== customType) continue;
				if (matches.length < limit) {
					matches.push(entry);
				}
			}

			return {
				entries: Object.freeze(matches),
				scannedEntries: scanCount,
				matchedEntries: matches.length,
				hitResultLimit: matches.length >= limit,
				hitScanLimit: scanCount < branchEntries.length,
			};
		},
	});
}

export function createCurrentSessionBranchView(
	ctx: SessionBranchViewContext,
): SessionBranchView {
	return createSessionBranchView(ctx.sessionManager.getBranch());
}
