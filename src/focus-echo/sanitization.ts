/**
 * Patterns that attempt to inject new instructions via echoed content.
 * Matched substrings are quoted in backticks so the model reads them as
 * content rather than following them as directives.
 */
const QUOTE_PATTERNS: RegExp[] = [
	// Authority override against prior/current or named authority instructions
	/\b(ignore|disregard|forget)\s+(?:all\s+)?(?:(?:previous|prior|earlier|current|latest|new|system|developer|user|tool|safety|policy)\s+)+(?:instructions|directives|commands|prompts|rules|policies)\b/gi,
	// Meta-directives that try to preempt the next response
	/\b(before\s+answering\s+(?:the\s+)?user|before\s+responding|before\s+you\s+answer)\b/gi,
	// Role switching
	/\b(you\s+are\s+now|from\s+now\s+on\s+you\s+are|act\s+as|pretend\s+(?:to\s+be|that\s+you\s+are))\b/gi,
	// System / developer prompt injection
	/\b(system|developer)\s*(?:prompt|instruction|directive)s?\s*[:：]\s*/gi,
	// New / changed instructions
	/\b(?:new|updated|changed)\s+(?:instructions|directives|commands|rules)\s*[:：]\s*/gi,
	// Override / bypass safeguards
	/\b(override|bypass|disable)\s+(?:all\s+)?(?:restrictions|safeguards|constraints|rules|limitations|policies)\b/gi,
	// Stop / halt following instructions
	/\b(stop|halt|cease)\s+(?:following|obeying|executing)\s+(?:these\s+)?(?:instructions|commands|directives|rules)\b/gi,
];

/**
 * XML-style delimiter patterns that can break out of message framing.
 * These are stripped entirely rather than quoted, since they carry no
 * semantic value as content.
 */
const STRIP_PATTERNS: RegExp[] = [
	// Delimiter breakout beyond focus-echo
	/<\s*\/?\s*(?:focus-echo|system|user|assistant|developer|summary|current-focus|instructions|command)\b[^>]*>/gi,
	// XML-style instruction wrappers
	/<\s*\/?\s*(?:instruction|command|directive|override)\b[^>]*>/gi,
];

/** Detect whether a string contains known adversarial prompt-injection patterns. */
export function hasAdversarialPatterns(value: string): boolean {
	return [...QUOTE_PATTERNS, ...STRIP_PATTERNS].some((re) => {
		re.lastIndex = 0;
		return re.test(value);
	});
}

/**
 * Sanitize a single echo field value:
 * 1. Strip focus-echo delimiters to prevent nesting/breakout.
 * 2. Strip XML-style delimiter breakout tags entirely.
 * 3. Neutralize instruction-like patterns by quoting them in backticks.
 * 4. Normalize whitespace.
 *
 * If the field contains adversarial patterns, the entire value is wrapped in
 * backticks and prefixed with [QUOTED] so the model treats it as content,
 * preserving readability while denying instruction authority.
 */
export function sanitizeEchoField(value: string): string {
	if (!value) return "";

	// Strip focus-echo delimiters, including whitespace/attribute variants.
	let strippedAnyDelimiter = false;
	let cleaned = value.replace(/<\s*\/?\s*focus-echo\b[^>]*>/gi, () => {
		strippedAnyDelimiter = true;
		return " ";
	});

	// Strip XML breakout tags entirely (they have no semantic value as content).
	// Track whether any were stripped so breakout attempts are treated as adversarial.
	for (const pattern of STRIP_PATTERNS) {
		const before = cleaned;
		cleaned = cleaned.replace(pattern, " ");
		if (cleaned !== before) strippedAnyDelimiter = true;
	}

	// Detect adversarial patterns in the remaining text
	const hasAdversarialText = QUOTE_PATTERNS.some((re) => {
		re.lastIndex = 0;
		return re.test(cleaned);
	});

	const adversarial = strippedAnyDelimiter || hasAdversarialText;

	// Replace backticks with single quotes up-front to avoid nested/double
	// backtick boundaries when we quote below.
	cleaned = cleaned.replace(/`/g, "'");

	// Neutralize each matched instruction pattern by backtick-quoting the match.
	// This breaks the pattern while preserving the literal text.
	for (const pattern of QUOTE_PATTERNS) {
		cleaned = cleaned.replace(pattern, (match) => `\`${match}\``);
	}

	// Normalize whitespace
	cleaned = cleaned.replace(/\s+/g, " ").trim();

	if (adversarial && cleaned.length > 0) {
		// Prefix with [QUOTED] so the model treats it as content, not
		// instructions. Avoid outer backtick wrapping to prevent nested
		// backtick boundaries.
		return `[QUOTED] ${cleaned}`;
	}

	return cleaned;
}
