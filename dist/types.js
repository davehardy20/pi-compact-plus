export function parseEnvInt(envVar, defaultValue) {
    if (envVar === undefined)
        return defaultValue;
    const parsed = parseInt(envVar, 10);
    return Number.isNaN(parsed) ? defaultValue : parsed;
}
export const CHECKPOINT_CANDIDATE_PERCENT = 75;
export const STANDARD_THRESHOLD_PERCENT = parseEnvInt(process.env.COMPACT_PLUS_STANDARD_THRESHOLD, 80);
export const HARD_THRESHOLD_PERCENT = parseEnvInt(process.env.COMPACT_PLUS_HARD_THRESHOLD, 90);
export const COOLDOWN_MS = parseEnvInt(process.env.COMPACT_PLUS_COOLDOWN_MS, 120_000);
export const CONTINUATION_PROMPT = "Continue with the current task.";
export const CHECKPOINT_CUSTOM_TYPE = "compact-plus-checkpoint";
export const REGROWTH_TOKENS = 1000;
export const CHECKPOINT_NOTE_MAX_LENGTH = 500;
export const CHECKPOINT_SCHEMA_VERSION = 2;
