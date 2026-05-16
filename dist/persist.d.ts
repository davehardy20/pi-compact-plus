import type { CompactionTelemetry } from "./types.js";
export interface PersistedTelemetry {
    lastCompaction: CompactionTelemetry | null;
    lastFallbackReason: string | null;
    lastInjectedEcho: string | null;
    lastCompactTime: number;
    lastCompactTokens: number;
    version: number;
}
export declare function loadTelemetry(): Promise<PersistedTelemetry | null>;
export declare function saveTelemetry(data: Omit<PersistedTelemetry, "version">): Promise<void>;
