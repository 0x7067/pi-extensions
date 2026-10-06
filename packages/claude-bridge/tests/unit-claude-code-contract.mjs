/**
 * Black-box behaviour of the bridge against the real Claude Code binary.
 *
 * Pi's side is driven through the registered provider exactly as Pi's agent
 * loop calls it. Claude Code is the Agent SDK's bundled CLI, talking to a
 * scripted fake Anthropic API, so these tests need no credentials or network.
 * Assertions look only at what Pi receives and what the API receives.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isContextOverflow } from "@earendil-works/pi-ai";
import { startFakeAnthropic } from "./lib/fake-anthropic.mjs";

// Each extension instance gets its own runtime, as in Aria Local Runtime.
globalThis.CLAUDE_BRIDGE_ISOLATED = true;
const { createClaudeBridgeExtension, formatResetTimestamp } = await import("../src/index.ts");

const require = createRequire(import.meta.url);
function bundledClaudeBinary() {
	try {
		const sdkRequire = createRequire(require.resolve("@anthropic-ai/claude-agent-sdk"));
		return sdkRequire.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/claude`);
	} catch {
		return undefined;
	}
}
const claudeBinary = bundledClaudeBinary();

const HAIKU = { id: "claude-haiku-4-5", name: "Claude Haiku 4.5", api: "claude-bridge", provider: "claude-bridge", contextWindow: 200_000, maxTokens: 64_000, reasoning: false, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const LOOKUP_TOOL = { name: "lookup", description: "Look something up.", parameters: { type: "object", properties: { topic: { type: "string" } }, required: ["topic"] } };
const LOOKUP_SDK_NAME = "mcp__custom-tools__lookup";
// A tool Pi bridges from another MCP server, with a schema Zod could not round-trip.
const APPLY_TOOL = {
	name: "mcp__aria__apply_change",
	description: "Apply one change.",
	parameters: {
		type: "object",
		properties: {
			change: {
				anyOf: [
					{ type: "object", properties: { operation: { type: "string", const: "delete_grant" }, grant_id: { type: "string" } }, required: ["operation", "grant_id"] },
					{ type: "object", properties: { operation: { type: "string", const: "merge_identity" }, kept_id: { type: "string" } }, required: ["operation", "kept_id"] },
				],
			},
		},
		required: ["change"],
	},
};
const DEFERRED_APPLY = { ...APPLY_TOOL, exposure: "deferred" }; // registered in Pi, not declared to its model
const APPLY_SDK_NAME = "mcp__custom-tools__mcp__aria__apply_change";
const TOOL_SEARCH = { ENABLE_TOOL_SEARCH: "true" }; // the fake endpoint is not first-party

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const userWithImage = (text) => ({ role: "user", content: [{ type: "text", text }, { type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }], timestamp: Date.now() });
const assistantReply = (text) => ({
	role: "assistant", provider: "claude-bridge", api: "claude-bridge", model: HAIKU.id, stopReason: "stop", timestamp: Date.now(),
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	content: [{ type: "text", text }],
});
const assistantToolCall = (name, args) => ({
	...assistantReply(""), stopReason: "toolUse",
	content: [{ type: "toolCall", id: `toolu_${name}_${Date.now()}`, name, arguments: args }],
});
const toolResult = (toolCall, text) => ({ role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() });
const toolCallsOf = (message) => message.content.filter((block) => block.type === "toolCall");
const textOf = (message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
const visibleParts = (message) => message.parts.map((part) => part.replace(/<system-reminder>[\s\S]*?<\/system-reminder>\n?/g, "").replace(/^\|/, "")).filter(Boolean);
/** What a request offers Claude: tools sent upfront, and tools only listed behind ToolSearch. */
const offeredTools = (request) => ({
	upfront: request.body.tools.filter((tool) => !tool.defer_loading).map((tool) => tool.name),
	deferred: request.messages.flatMap((message) => message.parts)
		.flatMap((part) => part.includes("deferred tools are now available") ? part.split("\n").filter((line) => line.startsWith("mcp__")) : []),
});
const hasFakeReply = (request) => request.messages.some((message) => message.parts.some((part) => /No response requested/.test(part)));

let workDir;
let fakeApi;
let respond;

function newBridge(env) {
	const handlers = new Map();
	const notifications = [];
	const registry = new Map(); // name -> { tool, exposure }
	let active = [];
	let provider;
	const cwd = mkdtempSync(join(workDir, "session-"));
	const pi = {
		registerCommand() {},
		on(event, handler) { handlers.set(event, handler); },
		registerProvider(_id, config) { provider = config; },
		appendEntry() {},
		events: { emit() {} },
		getAllTools: () => [...registry.values()].map(({ tool, exposure }) => ({ ...tool, exposure })),
		getActiveTools: () => [...active],
		setActiveTools(names) { active = [...new Set(names)].filter((name) => registry.has(name) && registry.get(name).exposure !== "hidden"); },
	};
	createClaudeBridgeExtension({ userDir: join(workDir, "user"), env })(pi);
	handlers.get("session_start")?.({ reason: "new" }, { cwd, ui: { notify: (message, level) => notifications.push({ message, level }) } });
	let declared; // tool names the transcript declares
	let initial; // tool names the leading system message declares
	const systemUpdates = []; // { after, message }: mid-transcript system messages, kept where Pi put them
	let snapshot = []; // tools the current turn can execute
	return {
		cwd,
		notifications,
		pi,
		/** Tool names Pi's transcript declares to the model (what another provider would see). */
		declaredTools: () => [...(declared ?? [])],
		/** Pi runs a tool call; a tool that was not active when the turn began is not found. */
		runTool(toolCall, text = "ok") {
			if (!snapshot.includes(toolCall.name)) {
				return { role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name, content: [{ type: "text", text: `Tool ${toolCall.name} not found` }], isError: true, timestamp: Date.now() };
			}
			return toolResult(toolCall, text);
		},
		/**
		 * One provider call, as Pi's agent loop makes it. Resolves with the final assistant message.
		 * `tools` sets the active tools on the first call and whenever given; `registered` adds tools
		 * with another exposure ({ ...tool, exposure }); `systemPrompt` is Pi's prompt for this call.
		 */
		async call(model, messages, { signal, onEvent, tools, registered = [], systemPrompt = "You are a test assistant." } = {}) {
			if (tools || !declared) {
				const direct = tools ?? [LOOKUP_TOOL];
				for (const tool of direct) registry.set(tool.name, { tool, exposure: "direct" });
				for (const { exposure, ...tool } of registered) registry.set(tool.name, { tool, exposure });
				active = direct.map((tool) => tool.name);
			}
			const toolOf = (name) => registry.get(name).tool;
			if (!declared) { declared = [...active]; initial = [...active]; }
			const added = active.filter((name) => !declared.includes(name));
			if (added.length) {
				// Pi declares newly active tools in a system message before its next request.
				// Pi inserts it before a new prompt, and after tool results otherwise.
				const after = messages.at(-1)?.role === "user" ? messages.length - 1 : messages.length;
				systemUpdates.push({ after, message: { role: "system", content: "", toolsAdded: added.map(toolOf), timestamp: Date.now() } });
				declared.push(...added);
			}
			snapshot = [...active];
			const transcript = [{ role: "system", content: systemPrompt, toolsAdded: initial.map(toolOf), timestamp: Date.now() }];
			messages.forEach((message, index) => {
				for (const update of systemUpdates) if (update.after === index) transcript.push(update.message);
				transcript.push(message);
			});
			for (const update of systemUpdates) if (update.after >= messages.length) transcript.push(update.message);
			// Pi passes no cwd to providers; the session cwd comes from session_start.
			const stream = provider.streamSimple(model, { messages: transcript }, { signal });
			let last;
			for await (const event of stream) {
				last = event;
				onEvent?.(event);
			}
			return last.type === "done" ? last.message : last.error;
		},
	};
}

describe("Claude Code contract", { timeout: 60_000, skip: claudeBinary ? false : "bundled Claude Code binary not installed for this platform" }, () => {
	before(async () => {
		workDir = mkdtempSync(join(tmpdir(), "claude-bridge-contract-"));
		const bin = join(workDir, "bin");
		mkdirSync(bin);
		symlinkSync(claudeBinary, join(bin, "claude"));
		fakeApi = await startFakeAnthropic((request, index) => respond(request, index));
		for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) delete process.env[key];
		Object.assign(process.env, {
			PATH: `${bin}:${process.env.PATH}`,
			CLAUDE_CONFIG_DIR: join(workDir, "claude-config"),
			ANTHROPIC_API_KEY: "sk-ant-test-only",
			ANTHROPIC_BASE_URL: fakeApi.url,
			CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		});
	});

	after(async () => {
		await fakeApi?.close();
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it("a message sent while a tool runs reaches Claude with the tool result, in the same turn", async () => {
		const bridge = newBridge();
		const start = fakeApi.requests.length;
		respond = (_request, index) => index === start
			? { toolUse: { id: "toolu_steer_1", name: LOOKUP_SDK_NAME, input: { topic: "sky" } } }
			: { text: "The sky is blue, and 17 × 3 = 51." };

		const history = [user("Look up the colour of the sky.")];
		const toolTurn = await bridge.call(HAIKU, history);
		const [toolCall] = toolCallsOf(toolTurn);
		assert.equal(toolCall.name, "lookup");

		// Pi drains the steering queue after the tool batch and appends it after the results.
		history.push(toolTurn, toolResult(toolCall, "blue"), user("Also, what is 17 * 3?"));
		const reply = await bridge.call(HAIKU, history);

		assert.equal(reply.stopReason, "stop");
		assert.equal(textOf(reply), "The sky is blue, and 17 × 3 = 51.");
		const requests = fakeApi.requests.slice(start);
		assert.equal(requests.length, 2, "the steer must not start a second query");
		const last = requests[1].messages.at(-1);
		assert.equal(last.role, "user");
		assert.ok(last.parts.some((part) => part.startsWith("tool_result:blue")));
		assert.ok(last.parts.some((part) => part.includes("Also, what is 17 * 3?")));
		assert.equal(requests.some(hasFakeReply), false);
	});

	it("each turn reaches Pi with the output tokens Claude generated for it, including a tool-call turn", async () => {
		const bridge = newBridge();
		const start = fakeApi.requests.length;
		respond = (_request, index) => index === start
			? { toolUse: { id: "toolu_usage_1", name: LOOKUP_SDK_NAME, input: { topic: "sky" } }, outputTokens: 1333 }
			: { text: "The sky is blue.", outputTokens: 7 };

		const history = [user("Look up the colour of the sky.")];
		const toolTurn = await bridge.call(HAIKU, history);
		assert.equal(toolTurn.stopReason, "toolUse");
		assert.equal(toolTurn.usage.output, 1333);

		history.push(toolTurn, toolResult(toolCallsOf(toolTurn)[0], "blue"));
		const reply = await bridge.call(HAIKU, history);
		assert.equal(reply.usage.output, 7);
	});

	it("tool calls Claude makes together reach Pi as one turn with that message's output tokens, and Claude receives every result", async () => {
		const bridge = newBridge();
		const start = fakeApi.requests.length;
		respond = (_request, index) => index === start
			? { toolUses: [
				{ id: "toolu_pair_1", name: LOOKUP_SDK_NAME, input: { topic: "sky" } },
				{ id: "toolu_pair_2", name: LOOKUP_SDK_NAME, input: { topic: "sea" } },
			], outputTokens: 2400 }
			: { text: "Both are blue." };

		const history = [user("Look up the sky and the sea.")];
		const toolTurn = await bridge.call(HAIKU, history);
		const toolCalls = toolCallsOf(toolTurn);
		assert.deepEqual(toolCalls.map((call) => call.arguments.topic), ["sky", "sea"]);
		assert.equal(toolTurn.usage.output, 2400);

		history.push(toolTurn, ...toolCalls.map((call) => toolResult(call, `${call.arguments.topic} is blue`)));
		const reply = await bridge.call(HAIKU, history);

		assert.equal(textOf(reply), "Both are blue.");
		const results = fakeApi.requests.at(-1).messages.at(-1).parts.filter((part) => part.startsWith("tool_result:"));
		assert.equal(results.length, 2);
		for (const expected of ["tool_result:sky is blue", "tool_result:sea is blue"]) {
			assert.ok(results.some((part) => part.startsWith(expected)), expected);
		}
	});

	it("after Stop, the flushed message reaches Claude without a fake reply and the stopped tool is shown as aborted", async () => {
		const bridge = newBridge();
		const start = fakeApi.requests.length;
		respond = (_request, index) => index === start
			? { toolUse: { id: "toolu_stop_1", name: LOOKUP_SDK_NAME, input: { topic: "auth" } } }
			: { text: "Switching to login first." };

		const stop = new AbortController();
		const history = [user("Refactor the auth module.")];
		const toolTurn = await bridge.call(HAIKU, history, { signal: stop.signal });
		const [toolCall] = toolCallsOf(toolTurn);
		stop.abort();

		// Pi records the stopped tool and calls once more with the aborted signal.
		history.push(toolTurn, { ...toolResult(toolCall, "Operation aborted"), isError: true });
		const leftover = await bridge.call(HAIKU, history, { signal: stop.signal });
		assert.equal(leftover.stopReason, "aborted");
		assert.equal(fakeApi.requests.length, start + 1, "the aborted leftover call must not reach Claude");

		// The queued message is flushed as a new run.
		history.push(leftover, user("Wait, do login first."));
		const reply = await bridge.call(HAIKU, history);

		assert.equal(textOf(reply), "Switching to login first.");
		const request = fakeApi.requests.at(-1);
		assert.equal(hasFakeReply(request), false);
		const last = request.messages.at(-1);
		assert.equal(last.role, "user");
		assert.ok(last.parts.some((part) => part.startsWith("tool_result:Operation aborted")));
		assert.ok(last.parts.some((part) => part.includes("Wait, do login first.")));
	});

	it("continuing from tool results after compaction produces Claude's answer", async () => {
		const bridge = newBridge();
		respond = () => ({ text: "Here is the ticket draft." });
		const toolTurn = {
			role: "assistant", provider: "claude-bridge", api: "claude-bridge", model: HAIKU.id, stopReason: "toolUse", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			content: [{ type: "toolCall", id: "toolu_compact_1", name: "lookup", arguments: { topic: "screenshot" } }],
		};

		const reply = await bridge.call(HAIKU, [
			user("[Summary of the earlier conversation]"),
			user("Make the Jira ticket."),
			toolTurn,
			toolResult(toolTurn.content[0], "screenshot contents"),
		]);

		assert.equal(reply.stopReason, "stop");
		assert.equal(textOf(reply), "Here is the ticket draft.");
		const request = fakeApi.requests.at(-1);
		assert.equal(hasFakeReply(request), false);
		assert.ok(request.messages.at(-1).parts.some((part) => part.startsWith("tool_result:screenshot contents")));
	});

	it("a message queued during Claude's final reply starts the next turn instead of being lost", async () => {
		const bridge = newBridge();
		respond = (request) => request.messages.at(-1).parts.some((part) => part.includes("second question"))
			? { text: "second answer" }
			: { text: "first answer" };

		const history = [user("first question")];
		let next;
		const first = await bridge.call(HAIKU, history, {
			// Pi can call again the moment it sees the reply end.
			onEvent: (event) => {
				if (event.type === "done") next = bridge.call(HAIKU, [...history, event.message, user("second question")]);
			},
		});

		assert.equal(textOf(first), "first answer");
		assert.equal(textOf(await next), "second answer");
	});

	it("an over-long prompt reaches Pi as a context overflow it can compact and retry", async () => {
		const bridge = newBridge();
		respond = () => ({ status: 400, message: "prompt is too long: 250000 tokens > 200000 maximum" });

		const reply = await bridge.call(HAIKU, [user("hello")]);

		assert.equal(reply.stopReason, "error");
		assert.equal(isContextOverflow(reply, HAIKU.contextWindow), true);
		assert.equal(textOf(reply), "", "the error must not also appear as assistant text");
	});

	it("a Claude error while Pi runs a tool leaves Pi's tool call intact, and the turn continues after the result", async () => {
		const bridge = newBridge();
		const start = fakeApi.requests.length;
		respond = (_request, index) => {
			// A call to a tool the bridge does not serve never reaches Pi's handler, so
			// Claude Code carries on by itself; its next request then fails.
			if (index === start) return { toolUse: { id: "toolu_unserved_1", name: "mcp__custom-tools__unserved", input: {} } };
			if (index === start + 1) return { status: 400, message: "invalid_request_error: upstream rejected the request" };
			return { text: "Continuing after the lookup." };
		};

		const history = [user("Look something up.")];
		const toolTurn = await bridge.call(HAIKU, history);
		assert.equal(toolTurn.stopReason, "toolUse");
		while (fakeApi.requests.length < start + 2) await new Promise((resolve) => setTimeout(resolve, 20));
		await new Promise((resolve) => setTimeout(resolve, 300));
		assert.equal(toolTurn.stopReason, "toolUse", "the message Pi already holds must not be rewritten");

		const [toolCall] = toolCallsOf(toolTurn);
		history.push(toolTurn, toolResult(toolCall, "looked up"));
		const reply = await bridge.call(HAIKU, history);

		assert.equal(textOf(reply), "Continuing after the lookup.");
		assert.equal(hasFakeReply(fakeApi.requests.at(-1)), false);
	});

	it("with tool search, tools Pi declares load upfront and deferred tools registered in Pi wait to be searched", async () => {
		const bridge = newBridge(TOOL_SEARCH);
		const start = fakeApi.requests.length;
		respond = () => ({ text: "ok" });

		await bridge.call(HAIKU, [user("hi")], { tools: [LOOKUP_TOOL], registered: [DEFERRED_APPLY] });

		const upfront = fakeApi.requests[start].body.tools.filter((tool) => !tool.defer_loading).map((tool) => tool.name);
		assert.ok(upfront.includes("ToolSearch"));
		assert.ok(upfront.includes(LOOKUP_SDK_NAME), "Pi's own tools must never need a search");
		assert.equal(upfront.includes(APPLY_SDK_NAME), false);
	});

	it("Claude can search for a bridged tool and call it in the same turn; Pi sees only that call", async () => {
		const bridge = newBridge(TOOL_SEARCH);
		const start = fakeApi.requests.length;
		respond = (_request, index) => {
			if (index === start) return { toolUse: { id: "toolu_search_1", name: "ToolSearch", input: { query: `select:${APPLY_SDK_NAME}`, max_results: 1 } } };
			if (index === start + 1) return { toolUse: { id: "toolu_apply_1", name: APPLY_SDK_NAME, input: { change: { operation: "delete_grant", grant_id: "g1" } } } };
			return { text: "Grant removed." };
		};

		const history = [user("Remove grant g1.")];
		const toolTurn = await bridge.call(HAIKU, history, { tools: [LOOKUP_TOOL], registered: [DEFERRED_APPLY] });
		const toolCalls = toolCallsOf(toolTurn);
		assert.deepEqual(toolCalls.map((call) => call.name), ["mcp__aria__apply_change"]);
		assert.deepEqual(toolCalls[0].arguments, { change: { operation: "delete_grant", grant_id: "g1" } });

		const loaded = fakeApi.requests[start + 1].body.tools.find((tool) => tool.name === APPLY_SDK_NAME);
		assert.deepEqual(loaded.input_schema, APPLY_TOOL.parameters, "the API must receive the tool's schema unchanged");

		history.push(toolTurn, toolResult(toolCalls[0], "removed"));
		const reply = await bridge.call(HAIKU, history);
		assert.equal(textOf(reply), "Grant removed.");
	});

	it("after a session is rebuilt from Pi history, Claude can search for a bridged tool it used before and call it again", async () => {
		const bridge = newBridge(TOOL_SEARCH);
		const start = fakeApi.requests.length;
		respond = (_request, index) => {
			if (index === start) return { toolUse: { id: "toolu_search_2", name: "ToolSearch", input: { query: `select:${APPLY_SDK_NAME}`, max_results: 1 } } };
			if (index === start + 1) return { toolUse: { id: "toolu_apply_2", name: APPLY_SDK_NAME, input: { change: { operation: "delete_grant", grant_id: "g2" } } } };
			return { text: "Grant g2 removed." };
		};
		const earlier = assistantToolCall("mcp__aria__apply_change", { change: { operation: "delete_grant", grant_id: "g1" } });
		const history = [user("Remove grant g1."), earlier, toolResult(earlier.content[0], "removed"), user("And g2?")];

		const toolTurn = await bridge.call(HAIKU, history, { tools: [LOOKUP_TOOL], registered: [DEFERRED_APPLY] });
		const toolCalls = toolCallsOf(toolTurn);
		assert.deepEqual(toolCalls.map((call) => call.arguments), [{ change: { operation: "delete_grant", grant_id: "g2" } }]);

		history.push(toolTurn, toolResult(toolCalls[0], "removed"));
		const reply = await bridge.call(HAIKU, history);
		assert.equal(textOf(reply), "Grant g2 removed.");
	});

	it("without tool search, every tool loads upfront with its schema unchanged", async () => {
		const bridge = newBridge();
		const start = fakeApi.requests.length;
		respond = () => ({ text: "ok" });

		await bridge.call(HAIKU, [user("hi")], { tools: [LOOKUP_TOOL], registered: [DEFERRED_APPLY] });

		const tools = fakeApi.requests[start].body.tools;
		assert.equal(tools.some((tool) => tool.name === "ToolSearch" || tool.defer_loading), false);
		assert.deepEqual(tools.find((tool) => tool.name === APPLY_SDK_NAME).input_schema, APPLY_TOOL.parameters);
	});

	it("tools Pi declares load upfront; deferred and codemode tools wait behind ToolSearch; Pi's own search tools and hidden tools are not offered", async () => {
		const bridge = newBridge(TOOL_SEARCH);
		const start = fakeApi.requests.length;
		respond = () => ({ text: "ok" });
		const tool = (name) => ({ name, description: `The ${name} tool.`, parameters: { type: "object", properties: {} } });

		await bridge.call(HAIKU, [user("hi")], {
			tools: [LOOKUP_TOOL, tool("tool_search"), tool("codemode")],
			registered: [
				{ ...tool("mcp__dev__deferred_one"), exposure: "deferred" },
				{ ...tool("mcp__dev__codemode_one"), exposure: "codemode" },
				{ ...tool("mcp__dev__hidden_one"), exposure: "hidden" },
			],
		});

		const sdk = (name) => `mcp__custom-tools__${name}`;
		const { upfront, deferred } = offeredTools(fakeApi.requests[start]);
		assert.ok(upfront.includes("ToolSearch"), "Claude Code's ToolSearch is the only search mechanism");
		assert.ok(upfront.includes(sdk("lookup")), "a declared tool loads upfront");
		assert.deepEqual(deferred.sort(), [sdk("mcp__dev__codemode_one"), sdk("mcp__dev__deferred_one")]);
		const everything = JSON.stringify(fakeApi.requests[start]);
		for (const name of ["tool_search", "codemode", "hidden_one"]) assert.equal(everything.includes(sdk(name)), false, `${name} must not reach Claude`);
	});

	it("Pi's system prompt reaches Claude in pi mode", async () => {
		const userDir = join(workDir, "user");
		mkdirSync(userDir, { recursive: true });
		writeFileSync(join(userDir, "claude-bridge.json"), JSON.stringify({ provider: { systemPromptMode: "pi" } }));
		try {
			const bridge = newBridge();
			const start = fakeApi.requests.length;
			respond = () => ({ text: "ok" });
			await bridge.call(HAIKU, [user("hi")], { systemPrompt: "You are PiPromptMarker-7731, Pi's own prompt." });
			const system = JSON.stringify(fakeApi.requests[start].body.system);
			assert.match(system, /PiPromptMarker-7731/);
			assert.doesNotMatch(system, /Claude Code, Anthropic's official CLI/);
		} finally {
			rmSync(join(userDir, "claude-bridge.json"), { force: true });
		}
	});

	it("a deferred tool Claude loads and calls runs in Pi and is recorded there as active", async () => {
		const bridge = newBridge(TOOL_SEARCH);
		const start = fakeApi.requests.length;
		const input = { change: { operation: "delete_grant", grant_id: "g1" } };
		respond = (_request, index) => {
			if (index === start) return { toolUse: { id: "toolu_load_1", name: "ToolSearch", input: { query: `select:${APPLY_SDK_NAME}`, max_results: 1 } } };
			if (index === start + 1) return { toolUse: { id: "toolu_apply_a", name: APPLY_SDK_NAME, input } };
			if (index === start + 2) return { toolUse: { id: "toolu_apply_b", name: APPLY_SDK_NAME, input } };
			return { text: "Grant removed." };
		};
		const history = [user("Remove grant g1.")];

		// Claude's call reaches Pi; Pi's turn was fixed before the tool was active, so it cannot run it yet.
		const first = await bridge.call(HAIKU, history, { tools: [LOOKUP_TOOL], registered: [DEFERRED_APPLY] });
		const [firstCall] = toolCallsOf(first);
		assert.equal(firstCall.name, APPLY_TOOL.name);
		assert.ok(bridge.pi.getActiveTools().includes(APPLY_TOOL.name), "the call must activate the tool in Pi");
		const notRun = bridge.runTool(firstCall);
		assert.equal(notRun.isError, true);

		// Claude is told to call again, and the next Pi turn runs that call.
		history.push(first, notRun);
		const second = await bridge.call(HAIKU, history);
		const toldToRetry = fakeApi.requests.at(-1).messages.at(-1).parts.find((part) => part.startsWith("tool_result:"));
		assert.match(toldToRetry, /just loaded into Pi.*Call it again/s);
		assert.doesNotMatch(toldToRetry, /not found/);
		const [secondCall] = toolCallsOf(second);
		assert.equal(secondCall.name, APPLY_TOOL.name);
		const ran = bridge.runTool(secondCall, "removed");
		assert.equal(ran.isError, false, "Pi runs the call once the tool is active");

		history.push(second, ran);
		const reply = await bridge.call(HAIKU, history);
		assert.equal(textOf(reply), "Grant removed.");
		assert.ok(fakeApi.requests.at(-1).messages.at(-1).parts.some((part) => part.startsWith("tool_result:removed")));
		// What Pi's transcript declares, and so what another model (for example Codex) is offered.
		assert.deepEqual(bridge.declaredTools().sort(), ["lookup", APPLY_TOOL.name].sort());
	});

	it("Pi system messages in the transcript do not disturb the shared Claude session between turns", async () => {
		const bridge = newBridge();
		const start = fakeApi.requests.length;
		respond = (_request, index) => ({ text: index === start ? "CLAUDE-VERSION" : "second answer" });
		const first = await bridge.call(HAIKU, [user("one")], { tools: [LOOKUP_TOOL], registered: [DEFERRED_APPLY] });
		assert.equal(textOf(first), "CLAUDE-VERSION");

		// Pi activates a tool between turns: a system message lands between the turns' messages.
		bridge.pi.setActiveTools(["lookup", APPLY_TOOL.name]);
		// Pi's history differs from Claude's copy in wording only; reuse keeps Claude's own, a rebuild would use Pi's.
		const history = [user("one"), assistantReply("PI-VERSION"), user("two")];
		await bridge.call(HAIKU, history);
		const sent = fakeApi.requests.at(-1).messages.map((message) => visibleParts(message).join("|"));
		assert.deepEqual(sent, ["one", "CLAUDE-VERSION", "two"]);

		// A third turn with another system message is still a reuse.
		bridge.pi.setActiveTools(["lookup"]);
		await bridge.call(HAIKU, [...history, assistantReply("PI-VERSION-2"), user("three")]);
		assert.deepEqual(fakeApi.requests.at(-1).messages.map((message) => visibleParts(message).join("|")), ["one", "CLAUDE-VERSION", "two", "second answer", "three"]);
	});

	it("Claude Code runs in the Pi session's working directory, not the host process's", async () => {
		const bridge = newBridge();
		respond = () => ({ text: "ok" });

		await bridge.call(HAIKU, [user("Where are you?")]);

		const parts = fakeApi.requests.at(-1).messages.flatMap((message) => message.parts);
		assert.ok(parts.some((part) => part.includes(`Primary working directory: ${bridge.cwd}`)), "Claude Code must describe the session workspace");
		assert.equal(parts.some((part) => part.includes(`Primary working directory: ${process.cwd()}\n`)), false);
	});

	it("two sessions in one process keep their Claude turns separate", async () => {
		respond = (request) => ({ text: `answer to ${request.messages.at(-1).parts.at(-1)}`, delayMs: 50 });
		const first = newBridge();
		const second = newBridge();

		const [firstReply, secondReply] = await Promise.all([
			first.call(HAIKU, [user("alpha")]),
			second.call(HAIKU, [user("beta")]),
		]);

		assert.equal(textOf(firstReply), "answer to alpha");
		assert.equal(textOf(secondReply), "answer to beta");
	});

	it("sibling runtimes use their own endpoint, credential and native profile without changing the parent", async () => {
		const inherited = { endpoint: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY, profile: process.env.CLAUDE_CONFIG_DIR };
		const firstApi = await startFakeAnthropic(() => ({ text: "first runtime reply", delayMs: 40 }), {
			authorize: headers => headers.authorization === "Bearer synthetic-first-authority" && headers["x-api-key"] === undefined,
		});
		const secondApi = await startFakeAnthropic(() => ({ text: "second runtime reply", delayMs: 40 }), {
			authorize: headers => headers.authorization === "Bearer synthetic-second-authority" && headers["x-api-key"] === undefined,
		});
		const firstProfile = join(workDir, "first-profile");
		const secondProfile = join(workDir, "second-profile");
		try {
			const first = newBridge({ ANTHROPIC_BASE_URL: firstApi.url, ANTHROPIC_AUTH_TOKEN: "synthetic-first-authority", ANTHROPIC_API_KEY: undefined, CLAUDE_CONFIG_DIR: firstProfile });
			const second = newBridge({ ANTHROPIC_BASE_URL: secondApi.url, ANTHROPIC_AUTH_TOKEN: "synthetic-second-authority", ANTHROPIC_API_KEY: undefined, CLAUDE_CONFIG_DIR: secondProfile });
			// Prior history requires the bridge and native subprocess to agree on the profile path.
			const [firstReply, secondReply] = await Promise.all([
				first.call(HAIKU, [user("first history"), assistantReply("first earlier answer"), user("first follow-up")]),
				second.call(HAIKU, [user("second history"), assistantReply("second earlier answer"), user("second follow-up")]),
			]);
			assert.equal(textOf(firstReply), "first runtime reply");
			assert.equal(textOf(secondReply), "second runtime reply");
			const firstText = firstApi.requests.flatMap(request => request.messages.flatMap(message => message.parts)).join("\n");
			const secondText = secondApi.requests.flatMap(request => request.messages.flatMap(message => message.parts)).join("\n");
			assert.ok(firstText.includes("first history") && !firstText.includes("second history"));
			assert.ok(secondText.includes("second history") && !secondText.includes("first history"));
			assert.ok(readdirSync(firstProfile, { recursive: true }).some(file => file.endsWith(".jsonl")));
			assert.ok(readdirSync(secondProfile, { recursive: true }).some(file => file.endsWith(".jsonl")));
			assert.equal(process.env.ANTHROPIC_BASE_URL, inherited.endpoint);
			assert.equal(process.env.ANTHROPIC_API_KEY, inherited.key);
			assert.equal(process.env.CLAUDE_CONFIG_DIR, inherited.profile);
		} finally {
			await Promise.all([firstApi.close(), secondApi.close()]);
		}
	});

	it("after a reply that was only thinking, the next message reaches Claude without a fake reply", async () => {
		const bridge = newBridge();
		let answer;
		respond = () => answer === undefined ? { thinking: "I should look at the screenshot first." } : { text: answer };

		const history = [user("Simplify the copy on this screen.")];
		const silent = await bridge.call(HAIKU, history);
		assert.equal(textOf(silent), "", "precondition: Claude ended the turn without a visible reply");

		answer = "Here is the plan for the copy and the notices.";
		history.push(silent, user("I also mean the notices at the top."));
		const reply = await bridge.call(HAIKU, history);

		assert.equal(textOf(reply), "Here is the plan for the copy and the notices.");
		const request = fakeApi.requests.at(-1);
		assert.equal(hasFakeReply(request), false);
		const parts = request.messages.flatMap((message) => message.parts);
		assert.ok(parts.some((part) => part.includes("Simplify the copy on this screen.")));
		assert.ok(request.messages.at(-1).parts.some((part) => part.includes("I also mean the notices at the top.")));
	});

	it("a screenshot in a prompt Claude picks up from rebuilt history reaches Claude", async () => {
		const bridge = newBridge();
		respond = () => ({ text: "Simplified." });

		// A settings notice between the last reply and the prompt means the prompt
		// is answered from the rebuilt history rather than sent as a new message.
		const reply = await bridge.call(HAIKU, [
			user("Show me the connectors screen."),
			assistantReply("Here it is."),
			user("The user changed this session's reasoning settings to xhigh effort."),
			userWithImage("Can we simplify this screen?"),
		]);

		assert.equal(textOf(reply), "Simplified.");
		const request = fakeApi.requests.at(-1);
		assert.equal(hasFakeReply(request), false);
		const last = request.messages.at(-1);
		assert.ok(last.parts.some((part) => part.includes("Can we simplify this screen?")));
		assert.ok(last.parts.includes("[image]"), "the screenshot must reach Claude with the prompt");
	});

	it("a stopped turn's unexecuted tool calls are not replayed or reported as lost output", async () => {
		const bridge = newBridge();
		respond = () => ({ text: "Explaining Y." });
		const stoppedTurn = {
			role: "assistant", provider: "claude-bridge", api: "claude-bridge", model: HAIKU.id, stopReason: "aborted", errorMessage: "Operation aborted", timestamp: Date.now(),
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			content: [{ type: "text", text: "Let me look" }, { type: "toolCall", id: "toolu_never_ran", name: "lookup", arguments: { topic: "x" } }],
		};

		const reply = await bridge.call(HAIKU, [user("Explain X."), stoppedTurn, user("Actually, explain Y.")]);

		assert.equal(textOf(reply), "Explaining Y.");
		const request = fakeApi.requests.at(-1);
		assert.equal(request.messages.some((message) => message.parts.some((part) => part.startsWith("tool_use"))), false);
		assert.equal(hasFakeReply(request), false);
	});
});

describe("rate-limit reset time", () => {
	it("reads the SDK's Unix-seconds reset time as a present-day date", () => {
		const formatted = formatResetTimestamp(1_790_000_000);
		assert.match(formatted, /2026/);
		assert.doesNotMatch(formatted, /1970/);
	});
});
