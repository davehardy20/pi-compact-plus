import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	estimateTokens,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { extractCompactionFocus } from "../src/compaction-intent.js";

const sdkRoot = dirname(
	fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")),
);
const sdkCompaction = await import(
	/* @vite-ignore */ pathToFileURL(
		join(sdkRoot, "core/compaction/compaction.js"),
	).href
);

function user(text: string) {
	return { role: "user" as const, content: text, timestamp: 1 };
}
function preparation(messages: AgentMessage[], prefix: AgentMessage[] = []) {
	return {
		messagesToSummarize: messages,
		turnPrefixMessages: prefix,
		isSplitTurn: prefix.length > 0,
	};
}

it("budgets only omitted user intent against the actual summary request", () => {
	const old = user(`Task: repair login.\n${"old context ".repeat(3000)}`);
	const redirect = user(
		`Please investigate routing instead.\n${"detail ".repeat(2000)}`,
	);
	const focus = extractCompactionFocus(
		[old, redirect],
		preparation([old]),
		200_000,
	);
	expect(focus.intentEvidence?.overflow).toBeUndefined();
	expect(focus.intentEvidence?.recentUserTurns).toEqual([
		redirect.content.trim(),
	]);
});

it("native preparation includes users retained before a previous compaction entry", () => {
	const session = SessionManager.inMemory();
	session.appendMessage(user("Task: deploy the obsolete service."));
	const supplied = user(`Task: repair login.\n${"detail ".repeat(30_000)}`);
	const kept = session.appendMessage(supplied);
	session.appendCompaction("Prior memory.", kept, 60_000);
	const retained = user("Preserve the audit trail too.");
	session.appendMessage(retained);
	const projected = session.buildSessionContext().messages;
	const prepared = sdkCompaction.prepareCompaction(session.getBranch(), {
		enabled: true,
		reserveTokens: 2048,
		keepRecentTokens: 1,
	}) as Parameters<typeof extractCompactionFocus>[1] | undefined;
	expect(prepared).toBeDefined();
	if (!prepared) throw new Error("Native preparation was not generated");
	const source = prepared.isSplitTurn
		? [...prepared.messagesToSummarize, ...prepared.turnPrefixMessages]
		: prepared.messagesToSummarize;
	const suppliedUsers = source.filter((message) => message.role === "user");
	const projectedUsers = projected.filter((message) => message.role === "user");
	expect(suppliedUsers.length).toBe(1);
	expect(projectedUsers.slice(0, suppliedUsers.length)).toEqual(suppliedUsers);
	const focus = extractCompactionFocus(projected, prepared, 200_000);
	expect(focus.intentEvidence?.overflow).toBeUndefined();
	expect(focus.intentEvidence?.recentUserTurns).toEqual([retained.content]);
});

it("keeps later identical requests instead of deduplicating them as a text set", () => {
	const first = user("Please investigate login.");
	const repeated = user("Please investigate login.");
	const focus = extractCompactionFocus(
		[first, repeated],
		preparation([first]),
		200_000,
	);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([repeated.content]);
});

it("retains all evidence if the summary users do not match an authoritative prefix", () => {
	const current = user("The authorization paths, rather than login.");
	const obsolete = user("Task: deploy an obsolete service.");
	const focus = extractCompactionFocus(
		[current],
		preparation([obsolete]),
		200_000,
	);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([current.content]);
	expect(focus.intentEvidence?.recentUserTurns).not.toContain(obsolete.content);
});

it("does not revive edited-away users from preparation when the projection is empty", () => {
	const obsolete = user("Task: deploy an obsolete service.");
	const focus = extractCompactionFocus([], preparation([obsolete]), 200_000);
	expect(focus.intentEvidence).toBeUndefined();
	expect(focus.objective).toBe("Continue current task.");
});

it("counts split-prefix users as supplied to the unified structured request", () => {
	const first = user("Task: investigate login.");
	const prefix = user("Now the authorization paths instead.");
	const retained = user("Preserve the audit constraints too.");
	const focus = extractCompactionFocus(
		[first, prefix, retained],
		preparation([first], [prefix]),
		200_000,
	);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([retained.content]);
});

it("still fails closed for genuinely oversized retained UTF-8 intent", () => {
	const retained = user("約".repeat(100_000));
	const focus = extractCompactionFocus([retained], preparation([]), 1_000_000);
	expect(focus.intentEvidence?.overflow).toBe(true);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([]);
});

it("reports the independent byte cap even with model token headroom", () => {
	const retained = user("x".repeat(300_000));
	expect(estimateTokens(retained)).toBeLessThan(1_000_000 - 16_384);
	const focus = extractCompactionFocus([retained], preparation([]), 1_000_000);
	expect(focus.intentEvidence?.overflow).toBe(true);
	expect(focus.intentEvidence?.recentUserTurns).toEqual([]);
});

it("accepts large ASCII history that still fits the model token budget", () => {
	const source = user("x".repeat(190_000));
	const retained = user("Keep this entire latest instruction.".repeat(200));
	const focus = extractCompactionFocus(
		[source, retained],
		preparation([source]),
		200_000,
	);
	expect(focus.intentEvidence?.overflow).toBeUndefined();
});

it("allows bounded retained evidence on a small model with a fitting reserve", () => {
	const source = user("Task: repair login.");
	const retained = user("Keep the tests intact.");
	const focus = extractCompactionFocus(
		[source, retained],
		{ ...preparation([source]), settings: { reserveTokens: 2048 } },
		8192,
	);
	expect(focus.intentEvidence?.overflow).toBeUndefined();
	expect(focus.intentEvidence?.recentUserTurns).toEqual([retained.content]);
});

it("honors a large configured output reserve when budgeting additional evidence", () => {
	const source = user("x".repeat(600_000));
	const retained = user("Keep this instruction.".repeat(4000));
	const focus = extractCompactionFocus(
		[source, retained],
		{ ...preparation([source]), settings: { reserveTokens: 60_000 } },
		200_000,
	);
	expect(focus.intentEvidence?.overflow).toBe(true);
});
