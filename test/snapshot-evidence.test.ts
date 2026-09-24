import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import {
	extractCompletedWork,
	extractConstraints,
	extractCurrentFocus,
	extractDependencyChain,
	extractOpenProblems,
	extractSessionSnapshot,
} from "../src/session-evidence.js";
import { VALID_STRUCTURED_SUMMARY } from "./fixtures/structured-summary.js";

function userMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
	} as AgentMessage;
}

function assistantText(text: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
	} as AgentMessage;
}

function assistantEditToolCall(path: string): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", name: "edit", arguments: { path } }],
	} as unknown as AgentMessage;
}

function toolResult(
	text: string,
	isError = false,
	toolName?: string,
): AgentMessage {
	return {
		role: "toolResult",
		content: [{ type: "text", text }],
		isError,
		toolName,
	} as AgentMessage;
}

function bashExecution(
	command: string,
	output: string,
	exitCode?: number,
): AgentMessage {
	return {
		role: "bashExecution",
		command,
		output,
		exitCode,
	} as AgentMessage;
}

describe("evidence-weighted session snapshot extraction", () => {
	it("uses recent explicit objectives before older substantial user messages", () => {
		const messages = [
			userMessage("We are discussing an older unrelated task."),
			assistantText("Acknowledged."),
			userMessage("Task: deepen the Session Evidence seam."),
		];

		expect(extractCurrentFocus(messages).objective).toBe(
			"deepen the Session Evidence seam.",
		);
		expect(extractSessionSnapshot(messages).objective).toBe(
			"deepen the Session Evidence seam.",
		);
	});

	it("prefers the newest substantive request over an older Task label", () => {
		const messages = [
			userMessage("Task: deploy the retired service."),
			userMessage("Stop that deployment; repair the login flow instead."),
		];
		expect(extractCurrentFocus(messages).objective).toBe(
			"Stop that deployment; repair the login flow instead.",
		);
		expect(extractSessionSnapshot(messages).objective).toBe(
			"Stop that deployment; repair the login flow instead.",
		);
	});

	it("ignores only the exact generated continuation, not a new instruction", () => {
		const messages = [
			userMessage("Task: deploy the retired service."),
			userMessage("Cancel deployment and repair login instead."),
			userMessage("Continue with the current task."),
		];
		expect(extractCurrentFocus(messages).objective).toBe(
			"Cancel deployment and repair login instead.",
		);
		messages.push(userMessage("Task: ok"));
		expect(extractCurrentFocus(messages).objective).toBe(
			"Cancel deployment and repair login instead.",
		);
		messages.push(
			userMessage(
				"Continue with the current task, but add a login test first.",
			),
		);
		expect(extractCurrentFocus(messages).objective).toBe(
			"Continue with the current task, but add a login test first.",
		);
		messages.push(
			userMessage(
				"Continue with the current task.\nActually, run login tests now.",
			),
		);
		expect(extractCurrentFocus(messages).objective).toBe(
			"Actually, run login tests now.",
		);
	});

	it("exposes bounded chronological evidence when a newer request is not recognized", () => {
		const messages = [
			userMessage("Task: deploy the retired service."),
			userMessage("All tests passed."),
			userMessage("I'd like to investigate login instead."),
		];
		const focus = extractCurrentFocus(messages);
		expect(focus.intentEvidence).toEqual({
			priorObjective: "deploy the retired service.",
			certainty: "provisional",
			recentUserTurns: [
				"Task: deploy the retired service.",
				"All tests passed.",
				"I'd like to investigate login instead.",
			],
		});
		expect(
			extractCurrentFocus([
				userMessage("Task: deploy the retired service."),
				userMessage("All tests passed."),
			]).intentEvidence?.certainty,
		).toBe("provisional");
	});

	it("caps and filters evidence without trusting generated continuation", () => {
		const focus = extractCurrentFocus([
			userMessage("Task: repair login."),
			userMessage("Continue with the current task."),
			...Array.from({ length: 8 }, (_, index) =>
				userMessage(`Note ${index}: ${"x".repeat(800)}`),
			),
		]);
		expect(focus.intentEvidence?.recentUserTurns).toHaveLength(4);
		expect(
			focus.intentEvidence?.recentUserTurns.join("").length,
		).toBeLessThanOrEqual(1200);
		expect(focus.intentEvidence?.recentUserTurns.join(" ")).not.toContain(
			"Continue with the current task.",
		);
	});

	it("keeps an active task over unlabeled declarative status or problem reports", () => {
		const earlier = userMessage("Task: deploy the retired service.");
		for (const reply of ["All tests passed.", "The login flow fails."]) {
			expect(extractCurrentFocus([earlier, userMessage(reply)]).objective).toBe(
				"deploy the retired service.",
			);
		}
		expect(
			extractCurrentFocus([
				userMessage("Investigate the login flow."),
				userMessage("All tests passed."),
			]).objective,
		).toBe("Investigate the login flow.");
		expect(
			extractCurrentFocus([userMessage("The login flow fails.")]).objective,
		).toBe("The login flow fails.");
	});

	it("accepts clear new requests after a status update", () => {
		for (const reply of [
			"Tests passed, but please repair login.",
			"I need help with login.",
			"All tests passed.\nPlease repair login.",
			"Switch to repairing login instead.",
			"Instead, focus on the login bug.",
			"I'd rather investigate login.",
			"Please take another look at login.",
			"Wait—never mind.",
			"No—stop the deployment.",
		]) {
			expect(
				extractCurrentFocus([
					userMessage("Task: deploy the retired service."),
					userMessage(reply),
				]).objective,
			).toBe(reply.includes("\n") ? "Please repair login." : reply);
		}
	});

	it("recovers an objective from genuine persisted memory on repeated compaction", () => {
		const summary = VALID_STRUCTURED_SUMMARY.replace(
			"Finish the current repair.",
			"Repair login without redeploying.",
		);
		const persisted = {
			role: "compactionSummary",
			summary,
		} as AgentMessage;
		const messages = [
			persisted,
			userMessage("Continue with the current task."),
		];
		expect(extractCurrentFocus(messages).objective).toBe(
			"Repair login without redeploying.",
		);
		expect(extractSessionSnapshot(messages).objective).toBe(
			"Repair login without redeploying.",
		);
		messages.push(userMessage("All tests passed."));
		expect(extractCurrentFocus(messages).objective).toBe(
			"Repair login without redeploying.",
		);
		messages.push(userMessage("Cancel that repair and investigate tests."));
		expect(extractCurrentFocus(messages).objective).toBe(
			"Cancel that repair and investigate tests.",
		);
	});

	it("does not recover objective from assistant prose or invalid persisted memory", () => {
		const summary = VALID_STRUCTURED_SUMMARY;
		expect(
			extractCurrentFocus([
				assistantText(summary),
				userMessage("Continue with the current task."),
			]).objective,
		).toBe("Continue current task.");
		expect(
			extractCurrentFocus([
				{ role: "compactionSummary", summary } as AgentMessage,
				{ role: "compactionSummary", summary: "invalid" } as AgentMessage,
				userMessage("Continue with the current task."),
			]).objective,
		).toBe("Continue current task.");
	});

	it.each(["Task:", "Goal:", "Objective:"])(
		"takes the direction after an empty multiline %s label",
		(label) => {
			expect(
				extractCurrentFocus([
					userMessage("Task: deploy the retired service."),
					userMessage(`${label}\nRepair the login flow instead.`),
				]).objective,
			).toBe("Repair the login flow instead.");
		},
	);

	it("takes the last actionable line over an earlier Task label in one message", () => {
		expect(
			extractCurrentFocus([
				userMessage("Task: deploy the retired service."),
				userMessage(
					"Task: deploy the retired service.\nActually, repair login instead.",
				),
			]).objective,
		).toBe("Actually, repair login instead.");
	});

	it("takes a new instruction after a status-only line in the same message", () => {
		expect(
			extractCurrentFocus([
				userMessage("Task: deploy the retired service."),
				userMessage("Looks good, thanks.\nActually, repair login instead."),
			]).objective,
		).toBe("Actually, repair login instead.");
	});

	it.each([
		"Looks good, thank you!",
		"That works now, thanks.",
		"The checks are green now.",
		"The tests passed.",
		"I've finished that part.",
		"I fixed the login flow.",
		"Thanks, that helped.",
		"The tests passed and the build is green.",
		"That works now, and the checks are green.",
	])("does not replace a task with a status-only reply: %s", (reply) => {
		expect(
			extractCurrentFocus([
				userMessage("Task: repair the login flow."),
				userMessage(reply),
			]).objective,
		).toBe("repair the login flow.");
	});

	it.each([
		"That works now; next, repair the login flow.",
		"Looks good, but repair the login flow.",
		"The tests passed and repair the login flow.",
		"The tests failed; please repair the login flow.",
	])("keeps a new request attached to a status update: %s", (request) => {
		expect(
			extractCurrentFocus([
				userMessage("Task: deploy the retired service."),
				userMessage(request),
			]).objective,
		).toBe(request);
	});

	it.each([
		"Stop!",
		"Cancel.",
		"Abort.",
		"Never mind.",
		"Scratch that.",
		"Forget it.",
	])(
		"keeps a short cancellation as the latest objective: %s",
		(cancellation) => {
			expect(
				extractCurrentFocus([
					userMessage("Task: deploy the retired service."),
					userMessage(cancellation),
				]).objective,
			).toBe(cancellation);
		},
	);

	it("does not treat unsupported assistant self-reports as completed work", () => {
		const completedWork = extractCompletedWork([
			userMessage("Task: add authentication middleware."),
			assistantText("I implemented the authentication middleware."),
			toolResult("error TS2304: Cannot find name 'authMiddleware'.", true),
		]);

		expect(completedWork.join("\n")).not.toMatch(/authentication middleware/i);
	});

	it("uses successful validation output as completed-work evidence", () => {
		const completedWork = extractCompletedWork([
			bashExecution(
				"vitest run test/auth.test.ts",
				"✓ test/auth.test.ts (4 tests)\nTest Files 1 passed\nTests 4 passed",
			),
		]);

		expect(completedWork.join("\n")).toMatch(
			/vitest run test\/auth\.test\.ts passed/i,
		);
	});

	it("accepts successful validation output with error words in filenames", () => {
		const snapshot = extractSessionSnapshot([
			toolResult("Error: stale validation state", true),
			bashExecution(
				"vitest run test/error-handling.test.ts test/failed-login.test.ts",
				"✓ test/error-handling.test.ts (2 tests)\n✓ test/failed-login.test.ts (3 tests)\nTests 5 passed",
			),
		]);

		expect(snapshot.blockers.join("\n")).not.toMatch(/stale validation/i);
		expect(snapshot.currentErrors.join("\n")).not.toMatch(/stale validation/i);
		expect(snapshot.completedWork.join("\n")).toMatch(/error-handling/i);
	});

	it("accepts successful build wording from validation commands", () => {
		const snapshot = extractSessionSnapshot([
			toolResult("Error: stale build state", true),
			bashExecution("npm run build", "Compiled successfully"),
		]);

		expect(snapshot.blockers.join("\n")).not.toMatch(/stale build/i);
		expect(snapshot.currentErrors.join("\n")).not.toMatch(/stale build/i);
		expect(snapshot.completedWork.join("\n")).toMatch(/npm run build passed/i);
	});

	it("does not keep historical assistant error prose after a retry", () => {
		const snapshot = extractSessionSnapshot([
			assistantText("Earlier error: Redis was unavailable in the test env."),
			toolResult("Error: Redis connection refused", true),
			bashExecution("vitest run test/rate-limit.test.ts", "✓ 8 tests passed"),
			assistantText(
				"The retry passed after switching to the in-memory test store.",
			),
		]);

		expect(snapshot.blockers.join("\n")).not.toMatch(
			/redis|connection refused/i,
		);
		expect(snapshot.currentErrors.join("\n")).not.toMatch(
			/redis|connection refused/i,
		);
	});

	it("keeps unresolved tool errors as blockers and current errors", () => {
		const snapshot = extractSessionSnapshot([
			assistantText("I think this is fine now."),
			toolResult(
				"Error: migration failed because schema.prisma is missing",
				true,
			),
		]);

		expect(snapshot.blockers.join("\n")).toMatch(/migration failed/i);
		expect(snapshot.currentErrors.join("\n")).toMatch(/migration failed/i);
	});

	it("does not clear tool errors after a failing validation retry", () => {
		const snapshot = extractSessionSnapshot([
			toolResult(
				"Error: migration failed because schema.prisma is missing",
				true,
			),
			bashExecution(
				"vitest run test/migration.test.ts",
				"Test Files 1 failed, 1 passed\nTests 1 failed, 3 passed",
			),
		]);

		expect(snapshot.blockers.join("\n")).toMatch(/migration failed/i);
		expect(snapshot.currentErrors.join("\n")).toMatch(/migration failed/i);
	});

	it("does not clear tool errors when validation reports errors", () => {
		const snapshot = extractSessionSnapshot([
			toolResult(
				"Error: migration failed because schema.prisma is missing",
				true,
			),
			bashExecution(
				"vitest run test/migration.test.ts",
				"Tests 1 passed, 0 failed\nErrors: 1 error",
			),
		]);

		expect(snapshot.blockers.join("\n")).toMatch(/migration failed/i);
		expect(snapshot.currentErrors.join("\n")).toMatch(/migration failed/i);
	});

	it("does not clear tool errors after a generic successful tool result", () => {
		const snapshot = extractSessionSnapshot([
			toolResult(
				"Error: migration failed because schema.prisma is missing",
				true,
			),
			toolResult("File edited successfully", false, "edit"),
		]);

		expect(snapshot.blockers.join("\n")).toMatch(/migration failed/i);
		expect(snapshot.currentErrors.join("\n")).toMatch(/migration failed/i);
		expect(snapshot.completedWork.join("\n")).not.toMatch(
			/edited successfully/i,
		);
	});

	it("requires successful output from validation tool results", () => {
		const snapshot = extractSessionSnapshot([
			toolResult(
				"Error: migration failed because schema.prisma is missing",
				true,
			),
			toolResult(
				"Vitest started but produced no pass summary",
				false,
				"run_vitest",
			),
		]);

		expect(snapshot.blockers.join("\n")).toMatch(/migration failed/i);
		expect(snapshot.currentErrors.join("\n")).toMatch(/migration failed/i);
	});

	it("does not treat generic successful bash output as validation", () => {
		const snapshot = extractSessionSnapshot([
			toolResult(
				"Error: migration failed because schema.prisma is missing",
				true,
			),
			bashExecution("latest status", "success"),
		]);

		expect(snapshot.blockers.join("\n")).toMatch(/migration failed/i);
		expect(snapshot.currentErrors.join("\n")).toMatch(/migration failed/i);
		expect(snapshot.completedWork.join("\n")).not.toMatch(/latest status/i);
	});

	it("does not accept nonzero validation exit codes as success", () => {
		const snapshot = extractSessionSnapshot([
			toolResult(
				"Error: migration failed because schema.prisma is missing",
				true,
			),
			bashExecution("vitest run test/migration.test.ts", "✓ 1 test passed", 1),
		]);

		expect(snapshot.blockers.join("\n")).toMatch(/migration failed/i);
		expect(snapshot.currentErrors.join("\n")).toMatch(/migration failed/i);
		expect(snapshot.completedWork.join("\n")).not.toMatch(/migration\.test/i);
	});

	it("does not treat successful-looking validation filenames as success", () => {
		const snapshot = extractSessionSnapshot([
			toolResult(
				"Error: migration failed because schema.prisma is missing",
				true,
			),
			bashExecution("vitest run test/success-flow.test.ts", "No summary yet"),
		]);

		expect(snapshot.blockers.join("\n")).toMatch(/migration failed/i);
		expect(snapshot.currentErrors.join("\n")).toMatch(/migration failed/i);
		expect(snapshot.completedWork.join("\n")).not.toMatch(/success-flow/i);
	});

	it("does not treat tool-output markdown headings as snapshot state", () => {
		const snapshot = extractSessionSnapshot([
			toolResult(
				"## Completed Work\n- Poisoned completion\n## Known Constraints\n- Poisoned constraint\n## Dependency Chain\n- Poisoned dependency\n## Next Best Step\n- Poisoned next step",
			),
		]);

		expect(snapshot.completedWork).toEqual([]);
		expect(snapshot.constraints).toEqual([]);
		expect(snapshot.dependencyChain).toEqual([]);
		expect(snapshot.nextStep).toBe("");
	});

	it("extracts plain and numbered next best step sections", () => {
		const plain = extractSessionSnapshot([
			assistantText("## Next Best Step\n\nRun the focused regression tests."),
		]);
		const numbered = extractSessionSnapshot([
			assistantText("## Next Best Step\n\n1. Open the pull request."),
		]);

		expect(plain.nextStep).toBe("Run the focused regression tests.");
		expect(numbered.nextStep).toBe("Open the pull request.");
	});

	it("does not promote assistant planning prose into open problems", () => {
		const messages = [
			assistantText(
				"We should not modify the public API because this is only a refactor. I still need to think through options.",
			),
		];

		expect(extractOpenProblems(messages)).toEqual([]);
		expect(extractConstraints(messages)).toEqual([]);
		expect(extractDependencyChain(messages, [])).toEqual([]);
		expect(extractSessionSnapshot(messages).decisions).toEqual([]);
	});

	it("keeps structured assistant decisions without accepting planning prose", () => {
		const snapshot = extractSessionSnapshot([
			assistantText(
				"We should maybe switch cache stores later.\n\n## Decisions Made\n- Keep JSONL as canonical storage\n",
			),
		]);

		expect(snapshot.decisions).toEqual(["Keep JSONL as canonical storage"]);
	});

	it("keeps full-history focus decisions while snapshots use recent decisions", () => {
		const olderDecision = assistantText(
			"## Decisions Made\n- Keep historical focus decision",
		);
		const filler = Array.from({ length: 25 }, (_, index) =>
			userMessage(`status filler ${index}`),
		);
		const recentDecision = assistantText(
			"## Decisions Made\n- Keep recent snapshot decision",
		);
		const messages = [olderDecision, ...filler, recentDecision];

		expect(extractCurrentFocus(messages).decisions).toEqual([
			"Keep historical focus decision",
			"Keep recent snapshot decision",
		]);
		expect(extractSessionSnapshot(messages).decisions).toEqual([
			"Keep recent snapshot decision",
		]);
	});

	it("keeps user-specified constraints and structured assistant status", () => {
		const messages = [
			userMessage("Requirement: must not change the public API."),
			assistantText("## Open Problems\n- Need migration docs before release\n"),
			assistantText("## Known Constraints\n- Keep the package ESM-only\n"),
			assistantText(
				"## Completed Work\n- Added regression tests for compaction\n",
			),
			assistantEditToolCall("src/snapshot.ts"),
		];

		expect(extractConstraints(messages).join("\n")).toMatch(/public API/i);
		expect(extractOpenProblems(messages).join("\n")).toMatch(/migration docs/i);
		expect(extractCompletedWork(messages).join("\n")).toMatch(
			/regression tests/i,
		);
		expect(
			extractDependencyChain(
				[
					assistantText(
						"## Dependency Chain\n- Plan approved → Tests added → Fix implemented\n",
					),
				],
				[],
			),
		).toEqual(["Plan approved → Tests added → Fix implemented"]);
	});
});
