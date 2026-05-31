import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { describe, expect, it } from "vitest";
import { extractDependencyChain } from "../src/extract.js";
import {
  extractCompletedWork,
  extractConstraints,
  extractOpenProblems,
  extractSessionSnapshot,
} from "../src/snapshot.js";

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
