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
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
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

const user = (text) => ({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
const ONE_PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const userWithImage = (text) => ({ role: "user", content: [{ type: "text", text }, { type: "image", data: ONE_PIXEL_PNG, mimeType: "image/png" }], timestamp: Date.now() });
const assistantReply = (text) => ({
	role: "assistant", provider: "claude-bridge", api: "claude-bridge", model: HAIKU.id, stopReason: "stop", timestamp: Date.now(),
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	content: [{ type: "text", text }],
});
const toolResult = (toolCall, text) => ({ role: "toolResult", toolCallId: toolCall.id, toolName: toolCall.name, content: [{ type: "text", text }], isError: false, timestamp: Date.now() });
const toolCallsOf = (message) => message.content.filter((block) => block.type === "toolCall");
const textOf = (message) => message.content.filter((block) => block.type === "text").map((block) => block.text).join("");
const hasFakeReply = (request) => request.messages.some((message) => message.parts.some((part) => /No response requested/.test(part)));

let workDir;
let fakeApi;
let respond;

function newBridge() {
	const handlers = new Map();
	const notifications = [];
	let provider;
	const cwd = mkdtempSync(join(workDir, "session-"));
	createClaudeBridgeExtension({ userDir: join(workDir, "user") })({
		registerCommand() {},
		on(event, handler) { handlers.set(event, handler); },
		registerProvider(_id, config) { provider = config; },
		appendEntry() {},
		events: { emit() {} },
	});
	handlers.get("session_start")?.({ reason: "new" }, { cwd, ui: { notify: (message, level) => notifications.push({ message, level }) } });
	return {
		cwd,
		notifications,
		/** One provider call, as Pi's agent loop makes it. Resolves with the final assistant message. */
		async call(model, messages, { signal, onEvent } = {}) {
			// Pi passes no cwd to providers; the session cwd comes from session_start.
			const stream = provider.streamSimple(model, { systemPrompt: "You are a test assistant.", messages, tools: [LOOKUP_TOOL] }, { signal });
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
			// A tool input that fails the tool schema never reaches Pi's handler, so
			// Claude Code carries on by itself; its next request then fails.
			if (index === start) return { toolUse: { id: "toolu_invalid_1", name: LOOKUP_SDK_NAME, input: { topic: 5 } } };
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
