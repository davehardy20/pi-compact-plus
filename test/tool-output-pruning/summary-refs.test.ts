import { describe, expect, it } from "vitest";
import {
	buildRefMap,
	formatRefLine,
	formatRefList,
	lookupRef,
} from "../../src/tool-output-pruning/summary-refs.js";
import type { ToolOutputRecord } from "../../src/tool-output-pruning/types.js";

function makeRecord(
	shortRef: string,
	recordId: string,
	toolCallId: string,
	toolName: string,
): ToolOutputRecord {
	return {
		recordId,
		entryId: null,
		toolCallId,
		toolName,
		timestamp: Date.now(),
		chars: 100,
		isError: false,
		summary: null,
		shortRef,
		argsPreview: null,
		fallbackSnippets: null,
	};
}

describe("buildRefMap", () => {
	it("maps short refs to record metadata", () => {
		const records = [
			makeRecord("t1", "r1", "tc1", "bash"),
			makeRecord("t2", "r2", "tc2", "read"),
		];
		const map = buildRefMap(records);
		expect(map.get("t1")).toEqual({
			recordId: "r1",
			toolCallId: "tc1",
			toolName: "bash",
			shortRef: "t1",
		});
		expect(map.get("t2")).toEqual({
			recordId: "r2",
			toolCallId: "tc2",
			toolName: "read",
			shortRef: "t2",
		});
	});

	it("returns an empty map for empty records", () => {
		const map = buildRefMap([]);
		expect(map.size).toBe(0);
	});

	it("overwrites on duplicate short refs (last wins)", () => {
		const records = [
			makeRecord("t1", "r1", "tc1", "bash"),
			makeRecord("t1", "r2", "tc2", "grep"),
		];
		const map = buildRefMap(records);
		expect(map.get("t1")?.recordId).toBe("r2");
	});
});

describe("lookupRef", () => {
	it("returns the entry for an existing ref", () => {
		const map = buildRefMap([makeRecord("t1", "r1", "tc1", "bash")]);
		expect(lookupRef("t1", map)?.toolCallId).toBe("tc1");
	});

	it("returns undefined for a missing ref", () => {
		const map = buildRefMap([makeRecord("t1", "r1", "tc1", "bash")]);
		expect(lookupRef("t99", map)).toBeUndefined();
	});
});

describe("formatRefLine", () => {
	it("formats a single ref line", () => {
		const record = makeRecord("t3", "r3", "tc3", "edit");
		expect(formatRefLine(record)).toBe("t3: edit (toolCallId=tc3)");
	});
});

describe("formatRefList", () => {
	it("formats multiple refs on separate lines", () => {
		const records = [
			makeRecord("t1", "r1", "tc1", "bash"),
			makeRecord("t2", "r2", "tc2", "read"),
		];
		expect(formatRefList(records)).toBe(
			"t1: bash (toolCallId=tc1)\nt2: read (toolCallId=tc2)",
		);
	});

	it("returns empty string for empty records", () => {
		expect(formatRefList([])).toBe("");
	});
});
