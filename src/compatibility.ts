import { compact } from "@earendil-works/pi-coding-agent";

export type CompactionExecutionPath = "custom" | "native-fallback";

export interface CompactionRuntimeCompatibility {
	executionPath: CompactionExecutionPath;
	helperArity: number;
	helperSupportsThinkingLevel: boolean;
	helperSupportsStreamFn: boolean;
	thinkingLevel?: string;
	streamFn?: (...args: unknown[]) => Promise<{ result(): Promise<unknown> }>;
	reason: string | null;
}

export const STREAM_SIMPLE_SHIM_REASON =
	"Pi runtime does not expose the live compaction stream function to extensions; Compact+ is using the public @earendil-works/pi-ai/compat streamSimple adapter so custom summaries can still run with stream-aware compaction semantics.";

export const NATIVE_FALLBACK_REASON =
	"Pi runtime requires stream-aware compaction summaries but neither a session stream function nor the public streamSimple adapter is available; Compact+ is falling back to native Pi compaction.";

// Compact+ summaries should stay fast/cheap even when the active session is using high reasoning.
export const COMPACT_PLUS_COMPACTION_THINKING_LEVEL = "minimal" as const;

const PI_AI_ROOT_SPECIFIER = "@earendil-works/pi-ai";
const PI_AI_COMPAT_SPECIFIER = "@earendil-works/pi-ai/compat";

type StreamSimpleFn = (
	model: unknown,
	context: unknown,
	options: unknown,
) => Promise<{ result(): Promise<unknown> }>;

let cachedStreamSimple: StreamSimpleFn | null = null;

async function loadStreamSimple(): Promise<StreamSimpleFn> {
	if (cachedStreamSimple) return cachedStreamSimple;

	const dynamicImport = (specifier: string) =>
		import(specifier) as Promise<{ streamSimple?: StreamSimpleFn }>;

	const rootModule = await dynamicImport(PI_AI_ROOT_SPECIFIER);
	const compatModule = rootModule.streamSimple
		? null
		: await dynamicImport(PI_AI_COMPAT_SPECIFIER);
	const streamSimple = rootModule.streamSimple ?? compatModule?.streamSimple;

	if (!streamSimple) {
		throw new Error("Pi AI streamSimple API is unavailable.");
	}

	cachedStreamSimple = streamSimple;
	return streamSimple;
}

const PUBLIC_STREAM_SIMPLE_FN: CompactionRuntimeCompatibility["streamFn"] =
	async (...args: unknown[]) => {
		const [model, context, options] = args;
		const streamSimple = await loadStreamSimple();
		return streamSimple(
			model as Parameters<StreamSimpleFn>[0],
			context as Parameters<StreamSimpleFn>[1],
			options as Parameters<StreamSimpleFn>[2],
		);
	};

export function resolveCompactionRuntimeCompatibility(args: {
	event: unknown;
	compactHelperArity?: number;
}): CompactionRuntimeCompatibility {
	const helperArity = args.compactHelperArity ?? compact.length;
	const helperSupportsThinkingLevel = helperArity >= 7;
	const helperSupportsStreamFn = helperArity >= 8;
	const thinkingLevel = helperSupportsThinkingLevel
		? COMPACT_PLUS_COMPACTION_THINKING_LEVEL
		: undefined;
	const streamFn = (args.event as { streamFn?: unknown })?.streamFn;

	if (typeof streamFn === "function") {
		return {
			executionPath: "custom",
			helperArity,
			helperSupportsThinkingLevel,
			helperSupportsStreamFn,
			thinkingLevel,
			streamFn: streamFn as CompactionRuntimeCompatibility["streamFn"],
			reason: null,
		};
	}

	if (helperSupportsStreamFn) {
		return {
			executionPath: "custom",
			helperArity,
			helperSupportsThinkingLevel,
			helperSupportsStreamFn,
			thinkingLevel,
			streamFn: PUBLIC_STREAM_SIMPLE_FN,
			reason:
				typeof PUBLIC_STREAM_SIMPLE_FN === "function"
					? STREAM_SIMPLE_SHIM_REASON
					: NATIVE_FALLBACK_REASON,
		};
	}

	return {
		executionPath: "custom",
		helperArity,
		helperSupportsThinkingLevel,
		helperSupportsStreamFn,
		thinkingLevel,
		reason: null,
	};
}
