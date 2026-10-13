/** Captured provider failure shapes for summarisation requests. */

/** Live Strata (llama.cpp-style server) rejection at a 262,144-token window. */
export const STRATA_CONTEXT_OVERFLOW =
	'400: {"type":"invalid_request_error","message":"prompt (300932 tokens) + max tokens (1) exceeds the context (262144); requests are never truncated. Send a smaller max_tokens (at most 0 here), or add \\"fit_max_tokens\\": true to the model\'s strata-<model>.json to shorten it to the room left (#545)"}';

/** Same server shape at a 65,536-token window (observed 2026-10-07). */
export const STRATA_CONTEXT_OVERFLOW_SMALL_WINDOW =
	'400: {"type":"invalid_request_error","message":"prompt (62899 tokens) + max tokens (4096) exceeds the context (65536); requests are never truncated. Send a smaller max_tokens (at most 2629 here), or add \\"fit_max_tokens\\": true to the model\'s strata-<model>.json to shorten it to the room left (#545)"}';

/** Pi's own failure when the clamped output budget left no room to answer. */
export const PI_OUTPUT_CAP_FAILURE =
	"Summarization failed: generation hit the token cap and the summary is incomplete";

export const TRANSIENT_FAILURES = [
	"terminated",
	"WebSocket closed 1000",
	"Connection error.",
	"429 Too Many Requests: rate limit",
	"502 Bad Gateway",
	"sentinel-secret",
];
