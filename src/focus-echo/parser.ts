import { extractFocusEchoDraft } from "./draft.js";
import type { FocusEcho } from "./model.js";
import { normalizeFocusEchoDraft } from "./normalizer.js";

/**
 * Extract high-signal fields from a structured compaction summary.
 * Parses the known headings produced by buildSummaryInstructions().
 */
export function parseFocusEcho(summaryText: string): FocusEcho {
	return normalizeFocusEchoDraft(extractFocusEchoDraft(summaryText));
}
