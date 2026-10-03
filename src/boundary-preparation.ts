import {
	findCutPoint,
	prepareBranchEntries,
	type SessionEntry,
	SettingsManager,
	type TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import type { ExtensionEventContext } from "./lifecycle.js";

type Preparation = Parameters<
	typeof import("@earendil-works/pi-coding-agent").compact
>[0];

/** Prepare only finalized, authoritative boundary messages via Pi's public cut policy. */
export function prepareBoundaryCompaction(
	event: TurnEndEvent,
	ctx: ExtensionEventContext,
	tokensBefore: number,
): Preparation | undefined {
	if (
		!event.context ||
		event.entries.length ||
		event.context.pendingMessages.length
	) {
		return undefined;
	}
	const entries: SessionEntry[] = [];
	let previousSummary: string | undefined;
	let previousFileEntries: SessionEntry[] = [];
	for (const projected of event.context.contextEntries) {
		// The supported host snapshots projected system content/sections onto
		// its compaction entry at commit; these instructions aren't summary data.
		const messages = projected.messages.filter((m) => m.role !== "system");
		if (!messages.length) continue;
		// A compaction can project system + memory together. Use projected
		// memory, never an edited-away source summary. Unknown edits defer.
		if (projected.sourceEntry.type === "compaction") {
			if (messages.length !== 1 || messages[0].role !== "compactionSummary") {
				return undefined;
			}
			previousSummary = messages[0].summary;
			if (previousSummary === projected.sourceEntry.summary) {
				previousFileEntries = [
					{
						...projected.sourceEntry,
						type: "branch_summary",
						fromId: projected.sourceEntry.id,
						fromHook: projected.sourceEntry.fromHook,
					},
				];
			}
			continue;
		}
		// Multiple messages sharing one retained ID cannot be cut independently.
		if (messages.length !== 1) return undefined;
		const message = messages[0];
		if (message.role === "compactionSummary") {
			previousSummary = message.summary;
			continue;
		}
		entries.push({ ...projected.sourceEntry, type: "message", message });
	}
	if (entries.length < 2) return undefined;
	const settings = SettingsManager.create(ctx.cwd).getCompactionSettings(
		ctx.model,
	);
	const cut = findCutPoint(
		entries,
		0,
		entries.length,
		settings.keepRecentTokens,
	);
	if (cut.firstKeptEntryIndex <= 0) return undefined;
	const keptId = entries[cut.firstKeptEntryIndex]?.id;
	// Never return a preview-only ID from a previous extension's draft.
	if (!keptId || !ctx.sessionManager.getEntry(keptId)) return undefined;
	const messagesToSummarize = entries
		.slice(0, cut.firstKeptEntryIndex)
		.flatMap((entry) => (entry.type === "message" ? [entry.message] : []));
	return {
		firstKeptEntryId: keptId,
		messagesToSummarize,
		turnPrefixMessages: [],
		isSplitTurn: cut.isSplitTurn,
		tokensBefore,
		previousSummary,
		// Reuse public Pi file tracking over authoritative projected tool calls
		// and eligible native memory metadata, without duplicating its parser.
		fileOps: prepareBranchEntries([
			...previousFileEntries,
			...entries.slice(0, cut.firstKeptEntryIndex),
		]).fileOps,
		settings,
	};
}
