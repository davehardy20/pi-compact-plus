/**
 * Backward-compatible snapshot barrel for older Compact+ imports.
 * New callers should import session evidence from session-evidence.ts.
 */

export {
	extractCompletedWork,
	extractConstraints,
	extractCurrentErrors,
	extractCurrentFocus,
	extractCurrentFocusFromBranch,
	extractFailedAttempts,
	extractOpenProblems,
	extractSessionSnapshot,
	extractSessionSnapshotFromBranch,
} from "./session-evidence.js";
