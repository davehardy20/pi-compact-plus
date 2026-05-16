import { existsSync, promises as fs } from "node:fs";
import { join } from "node:path";
const PERSIST_DIR = join(process.env.HOME ?? process.env.USERPROFILE ?? ".", ".pi", "agent", "state");
const PERSIST_FILE = join(PERSIST_DIR, "compact-plus-telemetry.json");
const PERSIST_VERSION = 2;
async function ensureDir(path) {
    if (!existsSync(path)) {
        await fs.mkdir(path, { recursive: true });
    }
}
export async function loadTelemetry() {
    try {
        if (!existsSync(PERSIST_FILE))
            return null;
        const raw = await fs.readFile(PERSIST_FILE, "utf8");
        const data = JSON.parse(raw);
        if (data.version !== 1 && data.version !== PERSIST_VERSION)
            return null;
        return {
            lastCompaction: data.lastCompaction ?? null,
            lastFallbackReason: data.lastFallbackReason ?? null,
            lastInjectedEcho: data.lastInjectedEcho ?? null,
            lastCompactTime: data.lastCompactTime ?? 0,
            lastCompactTokens: data.lastCompactTokens ?? 0,
            version: PERSIST_VERSION,
        };
    }
    catch {
        return null;
    }
}
export async function saveTelemetry(data) {
    try {
        await ensureDir(PERSIST_DIR);
        const payload = {
            ...data,
            version: PERSIST_VERSION,
        };
        await fs.writeFile(PERSIST_FILE, JSON.stringify(payload, null, 2));
    }
    catch {
        // Silently ignore persistence failures
    }
}
