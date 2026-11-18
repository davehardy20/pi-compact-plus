import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { expect, it, vi } from "vitest";
import {
	createRecoveryCopyBudget,
	snapshotRecoveryMessages,
} from "../src/compaction-recovery-evidence.js";
import { extractCurrentFocus } from "../src/session-evidence.js";
import {
	RECOVERY_LIMIT_REASON,
	RECOVERY_UNSUPPORTED_REASON,
} from "../src/summarization-overflow.js";

// Deliberately malformed/untyped historical data exercises the runtime boundary.
const snapshot = (messages: unknown[], readerOnly = false) =>
	snapshotRecoveryMessages(
		messages as AgentMessage[],
		createRecoveryCopyBudget(),
		readerOnly,
	);
const tool = (args: unknown) => ({
	role: "assistant",
	content: [{ type: "toolCall", id: "a", name: "read", arguments: args }],
});

it("copies complete JSON data, materializes holes and isolates subsequent readers", () => {
	const paths = new Array(3);
	paths[0] = "a.ts";
	paths[2] = "c.ts";
	const args = { path: "a.ts", filePath: "b.ts", paths };
	const input = [tool(args)];
	const copy = snapshot(input);
	expect(JSON.stringify(copy)).toBe(JSON.stringify(input));
	paths[0] = "mutated.ts";
	args.path = "mutated.ts";
	expect(extractCurrentFocus(copy).activeFiles).toEqual([
		"a.ts",
		"b.ts",
		"c.ts",
	]);
	expect(JSON.stringify(copy)).not.toContain("mutated.ts");
});

it("keeps null/zero/false metadata and omits legitimate optional undefined values", () => {
	const input = [
		{ role: "branchSummary", summary: "Branch.", fromId: null },
		{ role: "compactionSummary", summary: "Checkpoint.", tokensBefore: 0 },
		{
			role: "bashExecution",
			command: "",
			output: "",
			exitCode: undefined,
			cancelled: undefined,
			truncated: false,
			fullOutputPath: undefined,
		},
	];
	expect(JSON.stringify(snapshot(input))).toBe(JSON.stringify(input));
});

it("does not inspect ignored thinking or excluded bash payloads", () => {
	const inspect = vi.fn(() => "not visible");
	const thinking = Object.defineProperty({ type: "thinking" }, "thinking", {
		get: inspect,
	});
	const bash = Object.defineProperty(
		{ role: "bashExecution", excludeFromContext: true },
		"output",
		{ get: inspect },
	);
	const input = [{ role: "assistant", content: [thinking] }, bash];
	const copy = snapshotRecoveryMessages(input as unknown as AgentMessage[], {
		chars: 32,
		nodes: 10,
	});
	expect(JSON.stringify(copy)).toBe('[{"role":"assistant","content":[]}]');
	expect(inspect).not.toHaveBeenCalled();
});

it("omits retained images only from reader projections, never from source recovery", () => {
	const input = [
		{
			role: "user",
			content: [
				{ type: "text", text: "Visible direction." },
				{ type: "image", data: "AA==", mimeType: "image/png" },
			],
		},
	];
	expect(() => snapshot(input)).toThrow(RECOVERY_UNSUPPORTED_REASON);
	expect(snapshot(input, true)).toEqual([
		{ role: "user", content: [{ type: "text", text: "Visible direction." }] },
	]);
});

it.each(["role", "content", "type", "text", "arguments"])(
	"rejects an accessor-backed %s field without reading it",
	(key) => {
		const inspect = vi.fn(() => "not allowed");
		const block: Record<string, unknown> =
			key === "arguments"
				? { type: "toolCall", id: "a", name: "read" }
				: { type: "text", text: "Visible." };
		const message = { role: "assistant", content: [block] };
		Object.defineProperty(
			key === "role" || key === "content" ? message : block,
			key,
			{ get: inspect },
		);
		expect(() => snapshot([message])).toThrow(RECOVERY_UNSUPPORTED_REASON);
		expect(inspect).not.toHaveBeenCalled();
	},
);

it("rejects cycles but preserves repeated non-cyclic JSON values", () => {
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	expect(() => snapshot([tool(cycle)])).toThrow(RECOVERY_UNSUPPORTED_REASON);
	const shared = { path: "a.ts" };
	const input = [tool({ left: shared, right: shared })];
	expect(JSON.stringify(snapshot(input))).toBe(JSON.stringify(input));
});

it("rejects excessive argument depth before recursion becomes unsafe", () => {
	const root: Record<string, unknown> = {};
	let cursor = root;
	for (let index = 0; index < 258; index++) {
		const next = {};
		cursor.next = next;
		cursor = next;
	}
	expect(() => snapshot([tool(root)])).toThrow(RECOVERY_LIMIT_REASON);
});

it("enforces the shared text budget before evidence readers run", () => {
	expect(() =>
		snapshotRecoveryMessages(
			[{ role: "user", content: "Visible.", timestamp: 1 }],
			{ chars: 3, nodes: 10 },
		),
	).toThrow(RECOVERY_LIMIT_REASON);
});

it("copies prototype-like JSON keys into null-prototype objects without pollution", () => {
	const args = JSON.parse('{"__proto__":{"polluted":"synthetic"}}');
	const copy = snapshot([tool(args)]);
	expect(JSON.stringify(copy)).toBe(JSON.stringify([tool(args)]));
	expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false);
});
