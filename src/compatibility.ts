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

export const NATIVE_FALLBACK_REASON =
  "Pi runtime uses stream-aware compaction summaries but does not expose a public stream function to extensions; Compact+ is falling back to native Pi compaction to preserve routing/proxy behavior.";

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
      executionPath: "native-fallback",
      helperArity,
      helperSupportsThinkingLevel,
      helperSupportsStreamFn,
      thinkingLevel,
      reason: NATIVE_FALLBACK_REASON,
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
