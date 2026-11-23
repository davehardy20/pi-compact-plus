import { isDeepStrictEqual } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type SelectedModel = NonNullable<ExtensionContext["model"]>;
type RequestModel = Omit<SelectedModel, "name" | "cost">;

function requestModel(model: SelectedModel): RequestModel {
	// Display labels and accounting prices do not change the request. Keep every
	// other field, including future SDK routing/compatibility options, fail-closed.
	const { name: _name, cost: _cost, ...request } = model;
	return request;
}

/** Attempt-local only: may include authorization headers. Never persist or log. */
export function captureModelSnapshot(
	model: ExtensionContext["model"],
): RequestModel | null {
	try {
		return model ? structuredClone(requestModel(model)) : null;
	} catch {
		return null;
	}
}

export function modelMatchesSnapshot(
	snapshot: RequestModel | null,
	model: ExtensionContext["model"],
): boolean {
	try {
		return (
			snapshot !== null &&
			!!model &&
			isDeepStrictEqual(snapshot, requestModel(model))
		);
	} catch {
		return false;
	}
}

const FRESHNESS_CHECKS = [
	"epoch",
	"session",
	"branch",
	"model",
	"settings",
	"pending-input",
	"pruning-flush",
	"pruning-generation",
	"boundary",
	"context",
	"context-unavailable",
] as const;

/** Only bounded labels cross the verdict/status boundary, never model values. */
export interface FreshnessFailure {
	readonly check: (typeof FRESHNESS_CHECKS)[number];
	readonly phase: "before-dispatch" | "after-summary";
}

export function isFreshnessFailure(value: unknown): value is FreshnessFailure {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<FreshnessFailure>;
	return (
		FRESHNESS_CHECKS.includes(candidate.check as FreshnessFailure["check"]) &&
		(candidate.phase === "before-dispatch" ||
			candidate.phase === "after-summary")
	);
}
