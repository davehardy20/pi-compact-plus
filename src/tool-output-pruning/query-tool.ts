import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type Static, Type } from "typebox";
import { QUERY_TOOL_OUTPUT_TOOL_NAME } from "../types.js";
import {
	type BranchProviderContext,
	ToolOutputPruningCoordinator,
} from "./coordinator.js";
import { queryToolOutput } from "./recovery.js";
import type { ToolOutputPruningState } from "./state.js";
import type {
	QueryToolOutputResult,
	ToolOutputPruningSettings,
} from "./types.js";

export const queryToolOutputSchema = Type.Object(
	{
		query: Type.Optional(
			Type.String({
				description:
					"Case-insensitive search over tool name, summary, snippets, and bounded current-branch original text",
			}),
		),
		recordId: Type.Optional(Type.String({ description: "Exact record ID" })),
		ref: Type.Optional(Type.String({ description: "Short ref such as t1" })),
		toolCallId: Type.Optional(
			Type.String({ description: "Exact tool call ID" }),
		),
		toolName: Type.Optional(Type.String({ description: "Exact tool name" })),
		limit: Type.Optional(
			Type.Number({
				description: "Maximum matches to return (default 5, max 50)",
			}),
		),
		includeContent: Type.Optional(
			Type.Boolean({
				description:
					"Include bounded original content from the current session branch",
			}),
		),
	},
	{ additionalProperties: false },
);

export type QueryToolOutputInput = Static<typeof queryToolOutputSchema>;
export { queryToolOutput };

export interface QueryToolDefinitionDependencies {
	getState: () => ToolOutputPruningState;
	getSettings: () => ToolOutputPruningSettings;
}

/**
 * Create the Compact+ recovery query tool definition.
 *
 * The tool is registered unconditionally so context stubs can always point to
 * an available recovery affordance. The execute guard preserves strict
 * default-off behavior when pruning is not effectively enabled.
 */
export function createQueryToolDefinition(
	deps: QueryToolDefinitionDependencies,
): ToolDefinition<typeof queryToolOutputSchema, QueryToolOutputResult> {
	return {
		name: QUERY_TOOL_OUTPUT_TOOL_NAME,
		label: "Query pruned tool output",
		description:
			"Query the Compact+ tool-output pruning index to recover summaries and optionally bounded original content of previously pruned tool outputs. Only active when tool-output pruning is enabled.",
		promptSnippet:
			"Query pruned tool outputs by ref, toolCallId, or search text",
		parameters: queryToolOutputSchema,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const coordinator = new ToolOutputPruningCoordinator({
				state: deps.getState(),
				getSettings: deps.getSettings,
			});
			const result = coordinator.query(
				params,
				ctx as unknown as BranchProviderContext,
			);

			return {
				content: [{ type: "text", text: result.text }],
				details: result,
			};
		},
	};
}
