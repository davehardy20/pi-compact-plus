import type { CompactionMode, CurrentFocus, SummaryInstructionOptions } from "./types.js";
export declare function buildCurrentFocusBlock(focus: CurrentFocus): string;
export declare function buildSummaryInstructions(mode: CompactionMode, focus: CurrentFocus, options?: SummaryInstructionOptions): string;
export declare function buildBranchInstructions(focus?: CurrentFocus): string;
