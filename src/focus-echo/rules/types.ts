export interface TextReplacementRule {
	readonly name: string;
	readonly pattern: RegExp;
	readonly replacement: string;
}

export function applyTextReplacementRules(
	value: string,
	rules: readonly TextReplacementRule[],
): string {
	let result = value;
	for (const rule of rules) {
		result = result.replace(rule.pattern, rule.replacement);
	}
	return result;
}
