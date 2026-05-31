/**
 * Barrel re-export for backward compatibility.
 * Functions are now split across extract.ts, snapshot.ts, and classify.ts.
 */

export { classifyMessages } from "./classify.js";

export {
	extractDependencyChain,
	extractTextContent,
} from "./extract.js";

export {
	extractCompletedWork,
	extractConstraints,
	extractCurrentFocus,
	extractFailedAttempts,
	extractOpenProblems,
	extractSessionSnapshot,
} from "./snapshot.js";
