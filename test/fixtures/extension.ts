import { vi } from "vitest";

export interface MockCtx {
	hasUI: boolean;
	model: {
		contextWindow: number;
		maxTokens: number;
		provider: string;
		id: string;
		api?: string;
	} | null;
	modelRegistry: {
		getApiKeyAndHeaders: ReturnType<typeof vi.fn>;
		streamSimple?: ReturnType<typeof vi.fn>;
	};
	compact: ReturnType<typeof vi.fn>;
	getContextUsage: ReturnType<typeof vi.fn>;
	isIdle: ReturnType<typeof vi.fn>;
	hasPendingMessages: ReturnType<typeof vi.fn>;
	sessionManager: {
		getSessionId: ReturnType<typeof vi.fn>;
		getLeafId: ReturnType<typeof vi.fn>;
		getBranch: ReturnType<typeof vi.fn>;
		buildSessionProjection: ReturnType<typeof vi.fn>;
		buildContextEntries: ReturnType<typeof vi.fn>;
	};
	ui: {
		notify: ReturnType<typeof vi.fn>;
	};
	signal: AbortSignal;
}

export interface CommandDefinition {
	description?: string;
	handler: (args: string, ctx: MockCtx) => Promise<void>;
}

export type EventHandler = (...args: unknown[]) => unknown;
export type TestAgentMessage = {
	role: string;
	content: Array<{ type?: string; text?: string }>;
	[key: string]: unknown;
};
export type ContextHandlerResult = { messages: TestAgentMessage[] } | undefined;

export interface MockPi {
	registerCommand: ReturnType<typeof vi.fn>;
	registerTool: ReturnType<typeof vi.fn>;
	registerShortcut: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	sendUserMessage: ReturnType<typeof vi.fn>;
	commands: Map<string, CommandDefinition>;
	events: Map<string, EventHandler[]>;
}

export function createMockPi(): MockPi {
	const commands = new Map<string, CommandDefinition>();
	const events = new Map<string, EventHandler[]>();

	return {
		registerCommand: vi.fn((name: string, definition: CommandDefinition) => {
			commands.set(name, definition);
		}),
		registerTool: vi.fn(),
		registerShortcut: vi.fn(),
		on: vi.fn((event: string, handler: EventHandler) => {
			// Native events always contain settings. Supply explicitly configured
			// test settings for terse synthetic events, never for real SDK tests.
			// An explicitly invalid/undefined settings field is preserved.
			const testHandler: EventHandler = (...args) => {
				if (event !== "session_before_compact") return handler(...args);
				const beforeCompact = args[0] as {
					preparation?: Record<string, unknown>;
				};
				const preparation = beforeCompact?.preparation;
				if (!preparation || "settings" in preparation) return handler(...args);
				return handler(
					{
						...beforeCompact,
						preparation: {
							...preparation,
							settings: {
								enabled: true,
								keepRecentTokens: 100,
								reserveTokens: 4096,
							},
						},
					},
					...args.slice(1),
				);
			};
			events.set(event, [...(events.get(event) ?? []), testHandler]);
		}),
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		sendUserMessage: vi.fn(),
		commands,
		events,
	};
}

export function createMockCtx(options?: {
	contextWindow?: number;
	messages?: TestAgentMessage[];
	contextUsage?: { tokens: number | null; percent: number | null } | undefined;
}): MockCtx {
	return {
		hasUI: true,
		model: options?.contextWindow
			? {
					contextWindow: options.contextWindow,
					maxTokens: 4096,
					provider: "test",
					id: "test-model",
					api: "openai-completions",
				}
			: null,
		modelRegistry: {
			getApiKeyAndHeaders: vi.fn(async () => ({
				ok: true,
				apiKey: "test-key",
				headers: {},
			})),
			streamSimple: vi.fn(() => ({ result: vi.fn() })),
		},
		compact: vi.fn(),
		getContextUsage: vi.fn(() =>
			options && "contextUsage" in options
				? options.contextUsage
				: {
						tokens: 50000,
						percent: 50,
					},
		),
		isIdle: vi.fn(() => true),
		hasPendingMessages: vi.fn(() => false),
		sessionManager: {
			getSessionId: vi.fn(() => "fixture-session"),
			getLeafId: vi.fn(() => "fixture-leaf"),
			getBranch: vi.fn(
				() =>
					options?.messages?.map((m, i) => ({
						type: "message",
						id: `entry-${i}`,
						message: m,
					})) ?? [],
			),
			buildSessionProjection: vi.fn(() => ({
				messages: options?.messages ?? [],
			})),
			buildContextEntries: vi.fn(
				() =>
					options?.messages?.map((m, i) => ({
						type: "message",
						id: `entry-${i}`,
						message: m,
					})) ?? [],
			),
		},
		ui: {
			notify: vi.fn(),
		},
		signal: new AbortController().signal,
	};
}
