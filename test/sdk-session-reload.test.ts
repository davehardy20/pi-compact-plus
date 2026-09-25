import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { ToolOutputPruningCoordinator } from "../src/tool-output-pruning/coordinator.js";
import { buildToolPruneSummaryData } from "../src/tool-output-pruning/metadata.js";
import { ToolOutputPruningState } from "../src/tool-output-pruning/state.js";
import type { ToolOutputRecord } from "../src/tool-output-pruning/types.js";
import { TOOL_PRUNE_SUMMARY_CUSTOM_TYPE } from "../src/types.js";
import { makeToolOutputPruningSettings } from "./fixtures/tool-output-pruning.js";

it("real Pi SDK JSONL reload restores metadata only from the active A -> B -> A branch", () => {
	const root = mkdtempSync(join(tmpdir(), "compact-plus-sdk-"));
	try {
		const session = SessionManager.create(root, root);
		const settings = makeToolOutputPruningSettings({
			toolOutputPruneMinChars: 100,
		});
		const output = "original tool output ".repeat(12);
		const appendTool = (id: string, shortRef: string): ToolOutputRecord => {
			const callId = `call-${id}`;
			session.appendMessage({
				role: "assistant",
				api: "openai-completions",
				provider: "test",
				model: "local",
				stopReason: "toolUse",
				timestamp: Date.now(),
				content: [
					{
						type: "toolCall",
						id: callId,
						name: "bash",
						arguments: { command: "echo test" },
					},
				],
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			});
			const message: ToolResultMessage = {
				role: "toolResult",
				toolCallId: callId,
				toolName: "bash",
				content: [{ type: "text", text: output }],
				isError: false,
				timestamp: Date.now(),
			};
			const entryId = session.appendMessage(message);
			return {
				recordId: `rec-${id}`,
				entryId,
				toolCallId: callId,
				toolName: "bash",
				timestamp: Date.now(),
				chars: output.length,
				isError: false,
				summary: `summary ${id}`,
				shortRef,
				argsPreview: null,
				fallbackSnippets: null,
			};
		};
		const shared = appendTool("shared", "t1");
		const metadata = (
			records: ToolOutputRecord[],
			latest: ToolOutputRecord[],
		) =>
			buildToolPruneSummaryData({
				allRecords: records,
				metadataRecords: latest,
				settings,
				summaryChars: 20,
				timestamp: Date.now(),
			});
		const leafA = session.appendCustomEntry(
			TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
			metadata([shared], [shared]),
		);
		const specific = appendTool("specific", "t2");
		const leafB = session.appendCustomEntry(
			TOOL_PRUNE_SUMMARY_CUSTOM_TYPE,
			metadata([shared, specific], [specific]),
		);
		const file = session.getSessionFile();
		if (!file) throw new Error("Pi SDK did not create a session file");
		const restored = SessionManager.open(file, root, root);
		const state = new ToolOutputPruningState();
		const coordinator = new ToolOutputPruningCoordinator({
			state,
			getSettings: () => settings,
		});
		const ctx = { sessionManager: restored };
		coordinator.onSessionStart(ctx);
		expect(state.finalizedSnapshot().map((r) => r.shortRef)).toEqual([
			"t1",
			"t2",
		]);
		expect(
			state.finalizedSnapshot().every((r) => r.fallbackSnippets === null),
		).toBe(true);
		const recovered = coordinator.query(
			{ ref: "t2", includeContent: true },
			ctx,
		);
		expect(recovered.matches).toHaveLength(1);
		expect(recovered.matches[0]?.content).toBe(output);
		const durableMetadata = restored.getEntry(leafB);
		expect(JSON.stringify(durableMetadata)).not.toContain(output);
		restored.branch(leafA);
		coordinator.onSessionTree(ctx);
		expect(state.finalizedSnapshot().map((r) => r.shortRef)).toEqual(["t1"]);
		expect(coordinator.query({ ref: "t2" }, ctx).matches).toHaveLength(0);
		restored.branch(leafB);
		coordinator.onSessionTree(ctx);
		expect(state.finalizedSnapshot().map((r) => r.shortRef)).toEqual([
			"t1",
			"t2",
		]);
		expect(state.generateShortRef()).toBe("t3");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
