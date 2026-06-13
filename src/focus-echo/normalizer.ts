import type { FocusEchoDraft } from "./draft.js";
import type { FocusEcho } from "./model.js";
import {
	normalizeActiveFiles,
	normalizeBlockers,
	normalizeDecisions,
	normalizeDependencyChain,
	normalizeNextStep,
	normalizeObjective,
} from "./normalization-rules.js";

/**
 * Normalize raw Compact+ summary fields into the rendered focus-echo model.
 *
 * Field cleanup, rule-family application, path shortening, truncation,
 * source-of-truth wording cleanup, and list caps live behind semantic helpers
 * so parsing stays limited to extracting raw section data.
 */
export function normalizeFocusEchoDraft(draft: FocusEchoDraft): FocusEcho {
	return {
		objective: normalizeObjective(draft.objective),
		blockers: normalizeBlockers(draft.blockers, draft.errors),
		activeFiles: normalizeActiveFiles(draft.activeFiles),
		decisions: normalizeDecisions(draft.decisions),
		dependencyChain: normalizeDependencyChain(draft.dependencyChain),
		nextStep: normalizeNextStep(draft.nextStep),
	};
}
