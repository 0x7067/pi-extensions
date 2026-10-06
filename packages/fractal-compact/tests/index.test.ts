import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import fractalCompactExtension from "../src/index.ts";

// Use this package's SDK types, not the root fixture's older Pi dependency.
// The partial mock implements only the hooks and thinking level this extension consumes.
function createExtensionApiMock() {
	type Handler = (event: unknown, context: ExtensionContext) => unknown;
	const handlers = new Map<string, Handler[]>();
	const api = {
		on(name: string, handler: Handler) {
			handlers.set(name, [...(handlers.get(name) ?? []), handler]);
		},
		getThinkingLevel: () => "off",
	} as unknown as ExtensionAPI;
	return { api, getHandlers: (name: string) => handlers.get(name) ?? [] };
}

type EventBusMock = {
	emits: Array<{ name: string; data: unknown }>;
};

function installEventBus(api: { api: unknown }): EventBusMock {
	const eventBus: EventBusMock = { emits: [] };
	Object.assign(api.api as object, {
		events: {
			emit(name: string, data: unknown) {
				eventBus.emits.push({ name, data });
			},
		},
	});
	return eventBus;
}

describe("fractal compact extension", () => {
	it("registers compaction hooks", () => {
		const apiMock = createExtensionApiMock();
		fractalCompactExtension(apiMock.api);

		expect(apiMock.getHandlers("session_before_compact")).toHaveLength(1);
		expect(apiMock.getHandlers("session_compact")).toHaveLength(1);
	});

	it("summarizes through the registered provider so extension-backed models work", async () => {
		// Extension providers (the Claude bridge) declare a synthetic api and supply
		// their own streamSimple. Only the composed provider can route that, so going
		// straight to pi-ai threw "No API provider registered for api: claude-bridge"
		// and cancelled compaction outright.
		const apiMock = createExtensionApiMock();
		installEventBus(apiMock);
		fractalCompactExtension(apiMock.api);

		const streamSimpleCalls: Array<{ modelId: string; systemPrompt?: string; userText: string }> = [];
		const model = { id: "claude-sonnet-5", provider: "claude-bridge", api: "claude-bridge", maxTokens: 64_000, reasoning: false };

		const ctx = {
			hasUI: true,
			ui: { notify: () => undefined, setStatus: () => undefined },
			cwd: "/tmp/example",
			model,
			sessionManager: { getSessionFile: () => "/tmp/session.jsonl", getSessionId: () => "session-1" },
			modelRegistry: {
				streamSimple: (
					streamModel: { id: string },
					context: { systemPrompt?: string; messages: Array<{ content: Array<{ text: string }> }> },
				) => {
					streamSimpleCalls.push({
						modelId: streamModel.id,
						systemPrompt: context.systemPrompt,
						userText: context.messages[0]!.content[0]!.text,
					});
					return {
						result: async () => ({
							stopReason: "stop",
							content: [{ type: "text", text: "compacted summary" }],
						}),
					};
				},
			},
		} as unknown as ExtensionContext;

		const before = apiMock.getHandlers("session_before_compact")[0];
		if (!before) throw new Error("compaction hook missing");
		const result = (await before(
			{
				signal: new AbortController().signal,
				preparation: {
					messagesToSummarize: [],
					turnPrefixMessages: [],
					previousSummary: undefined,
					tokensBefore: 0,
					settings: { reserveTokens: 1000 },
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
					firstKeptEntryId: "entry-1",
				},
			},
			ctx,
		)) as { compaction?: { summary: string } };

		expect(streamSimpleCalls).toHaveLength(1);
		expect(streamSimpleCalls[0]!.modelId).toBe("claude-sonnet-5");
		// The system prompt must reach the registry as Context.systemPrompt; the
		// registry folds it into the transcript the provider receives.
		expect(streamSimpleCalls[0]!.systemPrompt).toBeTruthy();
		expect(streamSimpleCalls[0]!.userText).toContain("<conversation>");
		expect(result.compaction?.summary).toContain("compacted summary");
	});

	it("uses the checkpoint-aware summary seam without a tail-only provider request", async () => {
		const apiMock = createExtensionApiMock();
		installEventBus(apiMock);
		fractalCompactExtension(apiMock.api);
		let prompt = '';
		const before = apiMock.getHandlers('session_before_compact')[0]!;
		const result = await before({
			signal: new AbortController().signal,
			summarizeNativeContext: async (context: { messages: Array<{ content: Array<{ text: string }> }> }) => {
				prompt = context.messages[0]!.content[0]!.text;
				return { stopReason: 'stop', content: [{ type: 'text', text: 'Prior checkpoint and tail preserved' }] };
			},
			preparation: { messagesToSummarize: [{ role: 'user', content: 'Keep this new constraint', timestamp: 1 }], turnPrefixMessages: [], tokensBefore: 200000, settings: { reserveTokens: 1000 }, fileOps: { read: new Set(), written: new Set(), edited: new Set() }, firstKeptEntryId: 'tail' },
		}, {
			cwd: '/tmp/example', model: { id: 'native-model', maxTokens: 64000 },
			ui: { notify: () => undefined, setStatus: () => undefined },
			sessionManager: { getSessionFile: () => '/tmp/session', getSessionId: () => 'session' },
			modelRegistry: { streamSimple: () => { throw new Error('Tail-only provider path must not run'); } },
		} as unknown as ExtensionContext) as { compaction: { summary: string } };
		expect(result.compaction.summary).toContain('Prior checkpoint and tail preserved');
		expect(prompt).toContain('Keep this new constraint');
		expect(prompt).toContain('preserve methodology');
	});

	it("emits ALR-compatible compaction status events", async () => {
		const apiMock = createExtensionApiMock();
		const events = installEventBus(apiMock);
		fractalCompactExtension(apiMock.api);

		const before = apiMock.getHandlers("session_before_compact")[0];
		const compact = apiMock.getHandlers("session_compact")[0];
		if (!before || !compact) throw new Error("compaction hooks missing");

		const notify = () => undefined;
		const setStatus = () => undefined;
		const result = await before(
			{
				signal: new AbortController().signal,
				preparation: {
					messagesToSummarize: [],
					turnPrefixMessages: [],
					previousSummary: undefined,
					tokensBefore: 0,
					settings: { reserveTokens: 1000 },
					fileOps: { read: new Set(), written: new Set(), edited: new Set() },
					firstKeptEntryId: "entry-1",
				},
			},
			{ hasUI: true, ui: { notify, setStatus } } as unknown as ExtensionContext,
		);
		await compact({}, { hasUI: true, ui: { notify, setStatus } } as unknown as ExtensionContext);

		expect(result).toEqual({ cancel: true });
		expect(events.emits).toEqual([
			{ name: "aria-local:compaction-update", data: { status: "running" } },
			{ name: "aria-local:compaction-update", data: { status: "completed" } },
		]);
	});
});
