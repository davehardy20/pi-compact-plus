import { compact } from "@earendil-works/pi-coding-agent";

export type CompactionExecutionPath = "custom" | "native-fallback";

type StreamFn = (...args: unknown[]) => Promise<{ result(): Promise<unknown> }>;

export interface CompactionRuntimeCompatibility {
	executionPath: CompactionExecutionPath;
	helperArity: number;
	helperSupportsThinkingLevel: boolean;
	helperSupportsStreamFn: boolean;
	thinkingLevel?: string;
	streamFn?: StreamFn;
	streamRoute?: "session" | "registry";
	reason: string | null;
}

export const REGISTRY_STREAM_REASON =
	"Pi does not expose the live session stream function; Compact+ is using the registry streamSimple route to preserve provider routing and request transforms.";

export const NATIVE_FALLBACK_REASON =
	"No stream-aware provider route is available to the extension; Compact+ is falling back to native Pi compaction.";

// Compact+ summaries should stay fast/cheap even when the active session is using high reasoning.
export const COMPACT_PLUS_COMPACTION_THINKING_LEVEL = "minimal" as const;

export function resolveCompactionRuntimeCompatibility(args: {
	event: unknown;
	modelRegistry?: { streamSimple?: unknown };
	compactHelperArity?: number;
}): CompactionRuntimeCompatibility {
	const helperArity = args.compactHelperArity ?? compact.length;
	const helperSupportsThinkingLevel = helperArity >= 7;
	const helperSupportsStreamFn = helperArity >= 8;
	const thinkingLevel = helperSupportsThinkingLevel
		? COMPACT_PLUS_COMPACTION_THINKING_LEVEL
		: undefined;
	const base = {
		helperArity,
		helperSupportsThinkingLevel,
		helperSupportsStreamFn,
		thinkingLevel,
	};

	if (helperSupportsStreamFn) {
		const liveStream = (args.event as { streamFn?: unknown })?.streamFn;
		if (typeof liveStream === "function") {
			return {
				...base,
				executionPath: "custom",
				streamFn: liveStream as StreamFn,
				streamRoute: "session",
				reason: null,
			};
		}

		const registry = args.modelRegistry;
		if (registry && typeof registry.streamSimple === "function") {
			const streamFn: StreamFn = async (...streamArgs: unknown[]) =>
				(registry.streamSimple as StreamFn)(...streamArgs);
			return {
				...base,
				executionPath: "custom",
				streamFn,
				streamRoute: "registry",
				reason: REGISTRY_STREAM_REASON,
			};
		}
	}

	return {
		...base,
		executionPath: "native-fallback",
		reason: NATIVE_FALLBACK_REASON,
	};
}
