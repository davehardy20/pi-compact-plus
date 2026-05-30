export interface FocusEcho {
	objective: string;
	blockers: string[];
	activeFiles: string[];
	decisions: string[];
	dependencyChain: string[];
	nextStep: string;
}

export const FOCUS_ECHO_MARKER = "<focus-echo>";
export const MAX_ACTIVE_FILES = 4;
export const MAX_BLOCKERS = 3;
export const MAX_DECISIONS = 3;
export const MAX_DEPENDENCY_STEPS = 4;
export const MAX_ECHO_LINE_LENGTH = 120;
