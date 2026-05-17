import { streamSimple } from "@earendil-works/pi-ai";
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
  "Pi runtime does not expose the live compaction stream function to extensions; Compact+ is using the public @earendil-works/pi-ai streamSimple adapter so custom summaries can still run with stream-aware compaction semantics.";

export const NATIVE_FALLBACK_REASON =
  "Pi runtime requires stream-aware compaction summaries but neither a session stream function nor the public streamSimple adapter is available; Compact+ is falling back to native Pi compaction.";

const PUBLIC_STREAM_SIMPLE_FN: CompactionRuntimeCompatibility["streamFn"] =
  async (...args: unknown[]) => {
    const [model, context, options] = args;
    return streamSimple(
      model as Parameters<typeof streamSimple>[0],
      context as Parameters<typeof streamSimple>[1],
      options as Parameters<typeof streamSimple>[2],
    );
  };

export function inferThinkingLevelFromBranch(
  branchEntries: Array<unknown>,
): string | undefined {
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i] as {
      type?: string;
      thinkingLevel?: string;
    };
    if (
      entry?.type === "thinking_level_change" &&
      typeof entry.thinkingLevel === "string"
    ) {
      return entry.thinkingLevel;
    }
  }
  return undefined;
}

export function resolveCompactionRuntimeCompatibility(args: {
  event: unknown;
  branchEntries: Array<unknown>;
  compactHelperArity?: number;
}): CompactionRuntimeCompatibility {
  const helperArity = args.compactHelperArity ?? compact.length;
  const helperSupportsThinkingLevel = helperArity >= 7;
  const helperSupportsStreamFn = helperArity >= 8;
  const thinkingLevel = inferThinkingLevelFromBranch(args.branchEntries);
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
