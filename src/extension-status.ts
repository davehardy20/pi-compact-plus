import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import type {
	PackageMetadata,
	PackageMetadataResolver,
} from "./package-metadata.js";
import type { CompactionMode } from "./types.js";

export interface CompactPlusDebugStatusState {
	isCompacting: boolean;
	selectedMode: CompactionMode | null;
	lastCompactTime: number;
	echoInjected: boolean;
	lastModelKey: string | null;
}

export interface CompactPlusDebugStatusInput
	extends CompactPlusDebugStatusState {
	metadata: PackageMetadata;
	pruningLine: string;
}

export interface CompactPlusStatusCommandOptions {
	getMetadata: PackageMetadataResolver;
	getStatusState: () => CompactPlusDebugStatusState;
	getPruningLine: () => string;
}

export interface CompactPlusDebugStatusMessage {
	customType: "compact-plus-status";
	content: string;
	details: {
		packageName: string;
		version: string;
		sourcePath: string;
		packageRoot: string;
		isCompacting: boolean;
		selectedMode: CompactionMode | null;
		lastCompactTime: number;
		echoInjected: boolean;
	};
	display: true;
}

export function buildCompactPlusDebugStatusMessage({
	metadata,
	isCompacting,
	selectedMode,
	lastCompactTime,
	echoInjected,
	lastModelKey,
	pruningLine,
}: CompactPlusDebugStatusInput): CompactPlusDebugStatusMessage {
	return {
		customType: "compact-plus-status",
		content: [
			`${metadata.name} v${metadata.version}`,
			`source: ${metadata.sourcePath}`,
			`packageRoot: ${metadata.packageRoot}`,
			`compacting: ${isCompacting}`,
			`selectedMode: ${selectedMode ?? "none"}`,
			`lastCompactTime: ${lastCompactTime ? new Date(lastCompactTime).toISOString() : "never"}`,
			`echoInjected: ${echoInjected}`,
			`lastModelKey: ${lastModelKey ?? "none"}`,
			pruningLine,
		].join("\n"),
		details: {
			packageName: metadata.name,
			version: metadata.version,
			sourcePath: metadata.sourcePath,
			packageRoot: metadata.packageRoot,
			isCompacting,
			selectedMode,
			lastCompactTime,
			echoInjected,
		},
		display: true,
	};
}

export function registerCompactPlusStatusCommand(
	pi: ExtensionAPI,
	{
		getMetadata,
		getStatusState,
		getPruningLine,
	}: CompactPlusStatusCommandOptions,
): void {
	pi.registerCommand("compact-plus-status", {
		description: "Show Compact+ package status and debug info",
		handler: async () => {
			pi.sendMessage(
				buildCompactPlusDebugStatusMessage({
					metadata: getMetadata(),
					...getStatusState(),
					pruningLine: getPruningLine(),
				}),
			);
		},
	});
}
