/**
 * Backward-compatible extraction barrel for older Compact+ imports.
 * New callers should import session evidence from session-evidence.ts.
 */

export {
	extractActiveFiles,
	extractBlockers,
	extractDecisions,
	extractDependencyChain,
	extractNextStep,
	extractObjective,
	extractTextContent,
	findExplicitObjective,
	findSubstantialObjective,
	isConversationalFiller,
} from "./session-evidence.js";
