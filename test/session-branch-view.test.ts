import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it, vi } from "vitest";
import { buildCheckpointData } from "../src/policy.js";
import {
	createCurrentSessionBranchView,
	createSessionBranchView,
} from "../src/session-branch-view.js";
import {
	extractCurrentFocusFromBranch,
	extractSessionSnapshot,
	extractSessionSnapshotFromBranch,
} from "../src/session-evidence.js";

function userMessage(text: string): AgentMessage {
	return { role: "user", content: [{ type: "text", text }] } as AgentMessage;
}

function assistantMessage(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	} as AgentMessage;
}

function toolResultMessage(
	text: string,
	options: { isError?: boolean; toolName?: string; toolCallId?: string } = {},
): AgentMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text }],
		isError: options.isError,
		toolName: options.toolName,
		toolCallId: options.toolCallId,
	} as AgentMessage;
}

function bashExecution(
	command: string,
	output: string,
	exitCode = 0,
): AgentMessage {
	return { role: "bashExecution", command, output, exitCode } as AgentMessage;
}

function messageEntry(id: string, message: AgentMessage) {
	return { type: "message", id, message };
}

function customEntry(id: string, customType: string, data: unknown = {}) {
	return { type: "custom", id, customType, data };
}

function customMessageEntry(
	id: string,
	customType: string,
	message: AgentMessage,
) {
	return { type: "custom_message", id, customType, message };
}

describe("session branch view characterization", () => {
	it("projects only type=message entries into messageEntries() and messages()", () => {
		const user = messageEntry("m-user", userMessage("current user message"));
		const assistant = messageEntry(
			"m-assistant",
			assistantMessage("current assistant message"),
		);
		const view = createSessionBranchView([
			customEntry("custom-status", "compact-plus-status", { text: "status" }),
			user,
			customMessageEntry(
				"custom-message",
				"compact-plus-focus-echo",
				assistantMessage("custom message should stay out of windows"),
			),
			{ type: "compaction", id: "compaction-1", data: {} },
			{ type: "branch_summary", id: "branch-summary-1", data: {} },
			assistant,
		]);

		expect(view.messageEntries()).toEqual([user, assistant]);
		expect(view.messages()).toEqual([user.message, assistant.message]);
	});

	it("excludes custom, custom_message, compaction, and branch_summary entries from recent message windows", () => {
		const first = messageEntry("m-1", userMessage("first message"));
		const second = messageEntry("m-2", assistantMessage("second message"));
		const third = messageEntry("m-3", userMessage("third message"));
		const view = createSessionBranchView([
			first,
			customEntry("custom-1", "compact-plus-status"),
			customMessageEntry(
				"custom-message-1",
				"custom-ui",
				assistantMessage("ui"),
			),
			{ type: "compaction", id: "compaction-1" },
			second,
			{ type: "branch_summary", id: "branch-summary-1" },
			third,
		]);

		expect(view.recentMessages(2)).toEqual([second.message, third.message]);
		expect(view.recentMessageEntries(2)).toEqual([second, third]);
	});

	it("counts recentMessages(n) over filtered messages, not raw branch entries", () => {
		const messages = Array.from({ length: 4 }, (_, index) =>
			messageEntry(`m-${index + 1}`, userMessage(`message ${index + 1}`)),
		);
		const view = createSessionBranchView([
			messages[0],
			customEntry("custom-between-1", "noise"),
			customEntry("custom-between-2", "noise"),
			messages[1],
			{ type: "compaction", id: "compaction-between" },
			messages[2],
			{ type: "branch_summary", id: "summary-between" },
			messages[3],
		]);

		expect(view.recentMessages(3)).toEqual(
			messages.slice(1).map((entry) => entry.message),
		);
	});

	it("scans bounded current-branch custom entries by customType with counters and limits", () => {
		const matchingA = customEntry(
			"summary-a",
			"compact-plus/tool-prune-summary",
			{
				recordCount: 1,
			},
		);
		const matchingB = customEntry(
			"summary-b",
			"compact-plus/tool-prune-summary",
			{
				recordCount: 2,
			},
		);
		const staleMatching = customEntry(
			"stale-summary",
			"compact-plus/tool-prune-summary",
		);
		const view = createSessionBranchView([
			customEntry("other-1", "other"),
			matchingA,
			messageEntry("m-1", userMessage("message")),
			matchingB,
			customEntry("other-2", "other"),
			staleMatching,
		]);

		expect(
			view.customEntries("compact-plus/tool-prune-summary", {
				limit: 2,
				maxScanEntries: 5,
			}),
		).toEqual({
			entries: [matchingA, matchingB],
			scannedEntries: 5,
			matchedEntries: 2,
			hitResultLimit: true,
			hitScanLimit: true,
		});
	});

	it("distinguishes current branch ids from stale ids in messageEntryById() and hasEntry()", () => {
		const current = messageEntry("current-entry", userMessage("current"));
		const view = createSessionBranchView([
			current,
			customEntry("current-custom", "compact-plus-status"),
		]);

		expect(Array.from(view.entryIds())).toEqual([
			"current-entry",
			"current-custom",
		]);
		expect(view.hasEntry("current-entry")).toBe(true);
		expect(view.hasEntry("current-custom")).toBe(true);
		expect(view.hasEntry("stale-entry")).toBe(false);
		expect(view.messageEntryById("current-entry")).toEqual(current);
		expect(view.messageEntryById("current-custom")).toBeUndefined();
		expect(view.messageEntryById("stale-entry")).toBeUndefined();
	});

	it("captures getBranch() once so later session mutations do not change the view", () => {
		const original = [
			messageEntry("m-original", userMessage("original branch")),
		];
		const replacement = [
			messageEntry("m-replacement", userMessage("later branch")),
		];
		const getBranch = vi
			.fn()
			.mockReturnValueOnce(original)
			.mockReturnValue(replacement);
		const view = createCurrentSessionBranchView({
			sessionManager: { getBranch },
		} as never);

		expect(getBranch).toHaveBeenCalledTimes(1);
		expect(view.messages()).toEqual([original[0].message]);
		expect(view.hasEntry("m-replacement")).toBe(false);
	});

	it("feeds checkpoint and snapshot extraction with message-only branch paths", () => {
		const view = createSessionBranchView([
			customEntry("custom-poison", "compact-plus-status", {
				text: "## Completed Work\n- Poisoned custom entry",
			}),
			messageEntry("m-task", userMessage("Task: preserve snapshot filtering.")),
			messageEntry(
				"m-structured",
				assistantMessage("## Completed Work\n- Added branch view tests"),
			),
			customMessageEntry(
				"custom-message-poison",
				"compact-plus-focus-echo",
				assistantMessage("## Completed Work\n- Poisoned custom message"),
			),
		]);

		const snapshot = extractSessionSnapshotFromBranch(view);
		const checkpoint = buildCheckpointData("branch view", snapshot);

		expect(checkpoint.note).toBe("branch view");
		expect(checkpoint.completedWork).toContain("Added branch view tests");
		expect(snapshot.completedWork).toContain("Added branch view tests");
		expect(snapshot.completedWork.join("\n")).not.toMatch(/Poisoned custom/i);
	});

	it("uses only message entries for session_before_tree focus extraction", () => {
		const view = createSessionBranchView([
			customEntry("custom-objective", "compact-plus-status", {
				text: "Objective: poisoned custom objective",
			}),
			messageEntry("m-user", userMessage("We need branch focus extraction.")),
			messageEntry(
				"m-assistant",
				assistantMessage("## Decisions Made\n- Use message-only focus windows"),
			),
		]);

		const focus = extractCurrentFocusFromBranch(view);

		expect(focus.decisions).toEqual(["Use message-only focus windows"]);
		expect(focus.objective).not.toMatch(/poisoned custom objective/i);
	});

	it("keeps usage fallback inputs limited to current-branch messages", () => {
		const counted = messageEntry("m-counted", userMessage("counted message"));
		const view = createSessionBranchView([
			customEntry("custom-token-heavy", "compact-plus-status", {
				text: "custom entry should not be token-estimated",
			}),
			counted,
		]);

		expect(view.messages()).toEqual([counted.message]);
	});

	it("exposes current-branch-only tool-output data for pruning and recovery", () => {
		const staleToolResult = messageEntry(
			"stale-tool-result",
			toolResultMessage("stale output", {
				toolCallId: "tc-stale",
				toolName: "bash",
			}),
		);
		const currentToolResult = messageEntry(
			"current-tool-result",
			toolResultMessage("current output", {
				toolCallId: "tc-current",
				toolName: "bash",
			}),
		);
		const view = createSessionBranchView([currentToolResult]);

		expect(view.messageEntryById(currentToolResult.id)).toEqual(
			currentToolResult,
		);
		expect(view.messageEntryById(staleToolResult.id)).toBeUndefined();
		expect(view.hasEntry(staleToolResult.id)).toBe(false);
	});

	it("preserves PR #16 evidence weighting through branch message projection", () => {
		const view = createSessionBranchView([
			messageEntry(
				"m-claim",
				assistantMessage("I implemented authentication."),
			),
			messageEntry(
				"m-tool-heading",
				toolResultMessage(
					"## Completed Work\n- Poisoned heading from tool output",
				),
			),
			messageEntry(
				"m-error",
				toolResultMessage("Error: stale migration failed", { isError: true }),
			),
			messageEntry(
				"m-validation",
				bashExecution(
					"vitest run test/session-branch-view.test.ts",
					"✓ test/session-branch-view.test.ts (11 tests)\nTests 11 passed",
				),
			),
			messageEntry(
				"m-structured",
				assistantMessage(
					"## Known Constraints\n- Keep branch view policy-free",
				),
			),
		]);
		const snapshot = extractSessionSnapshot(view.messages());

		expect(snapshot.completedWork.join("\n")).toMatch(/session-branch-view/i);
		expect(snapshot.completedWork.join("\n")).not.toMatch(/authentication/i);
		expect(snapshot.completedWork.join("\n")).not.toMatch(/Poisoned heading/i);
		expect(snapshot.currentErrors.join("\n")).not.toMatch(/stale migration/i);
		expect(snapshot.constraints).toEqual(["Keep branch view policy-free"]);
	});
});
