import { describe, expect, it, vi } from "vitest";
import {
	NATIVE_FALLBACK_REASON,
	REGISTRY_STREAM_REASON,
	resolveCompactionRuntimeCompatibility,
} from "../src/compatibility.js";

describe("compaction stream routing", () => {
	it("uses the live session stream when Pi exposes one", async () => {
		const liveStream = vi.fn(async () => ({ result: vi.fn() }));
		const registryStream = vi.fn();
		const result = resolveCompactionRuntimeCompatibility({
			event: { streamFn: liveStream },
			modelRegistry: { streamSimple: registryStream },
			compactHelperArity: 12,
		});
		expect(result.executionPath).toBe("custom");
		expect(result.streamFn).toBe(liveStream);
		expect(result.streamRoute).toBe("session");
		expect(result.reason).toBeNull();
	});

	it("binds the registry stream to retain provider routing and transforms", async () => {
		const stream = { result: vi.fn() };
		const registry = {
			streamSimple: vi.fn(function (this: unknown) {
				expect(this).toBe(registry);
				return stream;
			}),
		};
		const result = resolveCompactionRuntimeCompatibility({
			event: {},
			modelRegistry: registry,
			compactHelperArity: 12,
		});
		expect(result.executionPath).toBe("custom");
		expect(result.reason).toBe(REGISTRY_STREAM_REASON);
		expect(result.streamRoute).toBe("registry");
		const model = { provider: "custom" };
		const context = { messages: [] };
		const options = { signal: new AbortController().signal };
		expect(await result.streamFn?.(model, context, options)).toBe(stream);
		expect(registry.streamSimple).toHaveBeenCalledWith(model, context, options);
	});

	it.each([
		{ modelRegistry: {}, compactHelperArity: 11 },
		{ modelRegistry: { streamSimple: vi.fn() }, compactHelperArity: 7 },
	])(
		"falls back natively when stream-aware routing is unavailable: %j",
		(args) => {
			const result = resolveCompactionRuntimeCompatibility({
				event: {},
				...args,
			});
			expect(result.executionPath).toBe("native-fallback");
			expect(result.streamFn).toBeUndefined();
			expect(result.reason).toBe(NATIVE_FALLBACK_REASON);
		},
	);
});
