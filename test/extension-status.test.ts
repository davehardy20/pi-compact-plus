import { describe, expect, it, vi } from "vitest";

import {
	buildCompactPlusDebugStatusMessage,
	registerCompactPlusStatusCommand,
} from "../src/extension-status.js";

describe("buildCompactPlusDebugStatusMessage", () => {
	it("preserves the compact-plus status message shape", () => {
		const message = buildCompactPlusDebugStatusMessage({
			metadata: {
				name: "@davehardy20/pi-compact-plus",
				version: "1.2.3",
				packageRoot: "/repo",
				sourcePath: "/repo/src/index.ts",
			},
			isCompacting: true,
			selectedMode: "hard",
			lastCompactTime: Date.parse("2026-05-30T12:34:56.000Z"),
			echoInjected: true,
			lastModelKey: "openai/gpt-4.1",
			pruningLine: "Tool-output pruning: off (experimental)",
		});

		expect(message).toEqual({
			customType: "compact-plus-status",
			display: true,
			content: [
				"@davehardy20/pi-compact-plus v1.2.3",
				"source: /repo/src/index.ts",
				"packageRoot: /repo",
				"updateFlow: package updates require pi update --extensions or reinstall, then /reload",
				"compacting: true",
				"selectedMode: hard",
				"lastCompactTime: 2026-05-30T12:34:56.000Z",
				"echoInjected: true",
				"lastModelKey: openai/gpt-4.1",
				"Tool-output pruning: off (experimental)",
			].join("\n"),
			details: {
				packageName: "@davehardy20/pi-compact-plus",
				version: "1.2.3",
				sourcePath: "/repo/src/index.ts",
				packageRoot: "/repo",
				isCompacting: true,
				selectedMode: "hard",
				lastCompactTime: Date.parse("2026-05-30T12:34:56.000Z"),
				echoInjected: true,
			},
		});
	});

	it("renders empty optional state consistently", () => {
		const message = buildCompactPlusDebugStatusMessage({
			metadata: {
				name: "pi-compact-plus",
				version: "0.1.0",
				packageRoot: "/repo",
				sourcePath: "/repo/src/index.ts",
			},
			isCompacting: false,
			selectedMode: null,
			lastCompactTime: 0,
			echoInjected: false,
			lastModelKey: null,
			pruningLine: "Tool-output pruning: off (experimental)",
		});

		expect(message.content).toContain("selectedMode: none");
		expect(message.content).toContain("lastCompactTime: never");
		expect(message.content).toContain("lastModelKey: none");
		expect(message.details).toMatchObject({
			selectedMode: null,
			lastCompactTime: 0,
			echoInjected: false,
		});
	});

	it("registers the compact-plus status command", async () => {
		const commands = new Map<
			string,
			{ description?: string; handler: () => Promise<void> }
		>();
		const pi = {
			registerCommand: vi.fn((name, definition) => {
				commands.set(name, definition);
			}),
			sendMessage: vi.fn(),
		};

		registerCompactPlusStatusCommand(pi as never, {
			getMetadata: () => ({
				name: "pi-compact-plus",
				version: "0.1.0",
				packageRoot: "/repo",
				sourcePath: "/repo/src/index.ts",
			}),
			getStatusState: () => ({
				isCompacting: false,
				selectedMode: null,
				lastCompactTime: 0,
				echoInjected: false,
				lastModelKey: null,
			}),
			getPruningLine: () => "Tool-output pruning: off (experimental)",
		});

		expect(pi.registerCommand).toHaveBeenCalledWith(
			"compact-plus-status",
			expect.objectContaining({
				description: "Show Compact+ package status and debug info",
			}),
		);

		const command = commands.get("compact-plus-status");
		expect(command).toBeDefined();
		if (!command) throw new Error("command not registered");
		await command.handler();

		expect(pi.sendMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "compact-plus-status",
				content: expect.stringContaining("source: /repo/src/index.ts"),
				display: true,
			}),
		);
	});
});
