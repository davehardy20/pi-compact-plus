import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { classifyMessages } from "../src/classify.js";
import { extractActiveFiles } from "../src/extract.js";

function assistantWithIdlessToolCall(
	args: Record<string, unknown>,
): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name: "read", arguments: args }],
	} as unknown as AgentMessage;
}

describe("idless assistant tool calls", () => {
	it("keeps assistant messages with idless tool calls critical", () => {
		const message = assistantWithIdlessToolCall({ path: "src/index.ts" });

		const classified = classifyMessages([message], "standard");

		expect(classified.critical).toEqual([message]);
		expect(classified.contextual).toHaveLength(0);
		expect(classified.ephemeral).toHaveLength(0);
	});

	it("extracts active files from safe object arguments without a call id", () => {
		const files = extractActiveFiles([
			assistantWithIdlessToolCall({
				path: "src/index.ts",
				filePath: "src/extract.ts",
				paths: ["test/index.test.ts", 123],
			}),
		]);

		expect(files).toEqual([
			"src/index.ts",
			"src/extract.ts",
			"test/index.test.ts",
		]);
	});
});
