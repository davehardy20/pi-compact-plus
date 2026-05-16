import type {
  CompactionMode,
  CurrentFocus,
  SummaryInstructionOptions,
} from "./types.js";

export function buildCurrentFocusBlock(focus: CurrentFocus): string {
  const parts = ["<current-focus>", `Objective: ${focus.objective}`];
  if (focus.blockers.length > 0) {
    parts.push("Active Blockers:");
    for (const b of focus.blockers) parts.push(`  - ${b}`);
  }
  if (focus.decisions.length > 0) {
    parts.push("Decisions in Force:");
    for (const d of focus.decisions) parts.push(`  - ${d}`);
  }
  if (focus.dependencyChain.length > 0) {
    parts.push("Dependency Chain:");
    for (const c of focus.dependencyChain) parts.push(`  - ${c}`);
  }
  if (focus.activeFiles.length > 0) {
    parts.push("Active Files:");
    for (const f of focus.activeFiles) parts.push(`  - ${f}`);
  }
  parts.push("</current-focus>");
  return parts.join("\n");
}

export function buildSummaryInstructions(
  mode: CompactionMode,
  focus: CurrentFocus,
  options?: SummaryInstructionOptions,
): string {
  const focusBlock = buildCurrentFocusBlock(focus);
  const isHard = mode === "hard";

  const schema = [
    "## Current Objective",
    "## Current Task State",
    "## Active File Set",
    "  - files read that still matter",
    "  - files modified",
    "  - likely next files to inspect/edit",
    "## Repository State",
    "## Decisions Made",
    "## Completed Work",
    "## Open Problems",
    "## Current Errors",
    "## Known Constraints",
    "## Failed Attempts",
    "## Next Best Step",
    "## Continuity Instruction",
    "## Dependency Chain",
  ];

  const hardInstructions = isHard
    ? "\nHard-mode constraints: use short bullets, fewer historical details, only critical failed attempts, only active/relevant files, one immediate next step.\n"
    : "\n";

  const continuityGuidance: string[] = [];

  if (options?.previousSummary) {
    continuityGuidance.push(
      "A previous compaction summary is provided below for continuity context.",
      "",
      "DIRECTION-CHANGE DETECTION (critical):",
      'Compare the previous summary\'s "Current Objective" and "Next Best Step" against the most recent user messages in the conversation being summarized.',
      'If the user has explicitly or implicitly changed direction (e.g., new task, "never mind", "actually", "instead", "let\'s focus on", abandoning prior work), you MUST:',
      "  1. Set Current Objective to the NEW direction, not the old one.",
      '  2. Drop old-direction goals from "Next Best Step" — only include steps relevant to the current direction.',
      '  3. Move old-direction work to "Completed Work" only if it affects the new direction\'s state; otherwise omit it entirely.',
      '  4. Drop old-direction "Open Problems" and "Failed Attempts" unless they block the current direction.',
      "  5. Keep cross-cutting facts (file paths explored, repo structure, constraints) since they may still be useful.",
      "",
      "PER-SECTION MERGING RULES:",
      "When carrying content forward from the previous summary, apply these rules:",
      "",
      "  Objective: Always use the objective from the CURRENT conversation. Never copy the previous summary's objective verbatim — it may be stale.",
      "",
      "  Decisions Made: Carry forward ALL decisions from the previous summary UNLESS the current conversation explicitly contradicts or supersedes them. Do not drop a decision just because it isn't mentioned again.",
      "",
      "  Failed Attempts: ACCUMULATE — never drop a failed attempt from the previous summary unless the current conversation shows it was actually resolved. New failures from the current conversation are appended, not replaced.",
      "",
      "  Open Problems / Blockers: Carry forward from the previous summary UNLESS the current conversation explicitly shows resolution. If a blocker is not mentioned in the current conversation, assume it is still unresolved.",
      "",
      "  Dependency Chain: MERGE chains from both sources. Do not replace the previous chain with only the current conversation's chain — earlier dependencies may still be in force.",
      "",
      "  Active File Set: Take the UNION of files from the previous summary and current conversation. Drop files only if they are clearly no longer relevant to the current direction.",
      "",
      "DO NOT blindly merge the previous summary's sections. The current conversation is the source of truth for what the user actually wants now.",
      "",
      "<previous-summary>",
      options.previousSummary,
      "</previous-summary>",
      "",
    );
  }

  if (options?.isSplitTurn) {
    continuityGuidance.push(
      `This compaction includes a split turn with ${options.turnPrefixCount} prefix message(s). The prefix messages are the beginning of a turn that was interrupted.`,
      "Preserve the prefix content as part of the active context — it may contain tool calls or decisions that are still relevant.",
      "",
    );
  }

  return [
    focusBlock,
    "",
    "Produce a structured summary using these exact headings:",
    ...schema,
    "",
    "Rules:",
    "- Use the exact headings above. Fill each section from the conversation and <current-focus>.",
    "- Explicitly list failed attempts and why they failed.",
    "- Link dependent decisions in the Dependency Chain section.",
    hardInstructions,
    ...continuityGuidance,
  ].join("\n");
}

export function buildBranchInstructions(focus?: CurrentFocus): string {
  const parts: string[] = [];
  if (focus) {
    parts.push(buildCurrentFocusBlock(focus));
    parts.push("");
  }
  parts.push("Produce a structured branch summary using these exact headings:");
  parts.push("## Branch Goal");
  parts.push("## Work Completed on This Branch");
  parts.push("## Key Findings");
  parts.push("## Files Touched or Investigated");
  parts.push("## Failed or Rejected Paths");
  parts.push("## Remaining Value to Carry Forward");
  parts.push("## Recommended Next Step");
  parts.push("");
  parts.push("Rules:");
  parts.push("- Preserve what was learned even if the branch is abandoned.");
  parts.push("- List rejected paths so they are not repeated.");
  parts.push("- Focus on carry-forward value.");
  return parts.join("\n");
}
