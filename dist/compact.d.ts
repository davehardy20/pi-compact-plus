import type { CompactionResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compact } from "@earendil-works/pi-coding-agent";
import type { CompactionMode } from "./types.js";
export interface CompactionAttemptResult {
    result: CompactionResult | undefined;
    fallbackReason: string | null;
    classifiedCounts?: {
        critical: number;
        contextual: number;
        ephemeral: number;
    };
}
export declare function runCustomCompaction(preparation: Parameters<typeof compact>[0], mode: CompactionMode, ctx: ExtensionContext, signal?: AbortSignal): Promise<CompactionAttemptResult>;
