/**
 * Backward-compatible barrel for older Compact+ imports.
 * New focus/snapshot callers should import from session-evidence.ts; hard-mode
 * message classification remains in classify.ts.
 */

export { classifyMessages } from "./classify.js";

export {
	extractCompletedWork,
	extractConstraints,
	extractCurrentFocus,
	extractCurrentFocusFromBranch,
	extractDependencyChain,
	extractFailedAttempts,
	extractOpenProblems,
	extractSessionSnapshot,
	extractSessionSnapshotFromBranch,
	extractTextContent,
} from "./session-evidence.js";
