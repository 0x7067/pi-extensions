/**
 * Translation of Claude Agent SDK messages into Pi stream events, including
 * SDK orderings the real CLI produces only occasionally. Assertions look at
 * what Pi receives: stream events and the final assistant message.
 */
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { processAssistantMessage, processStreamEvent, streamClaudeAgentSdk } from "../src/index.ts";
import { ctx, resetStack } from "../src/query-state.ts";

const model = {
	api: "claude-bridge",
	provider: "claude-bridge",
	id: "claude-haiku-4-5",
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function installFakeStream() {
	const events = [];
	const stream = {
		push(event) { events.push(event); },
		end(result) { events.push({ type: "stream_end", result }); },
	};
	ctx().currentPiStream = stream;
	return events;
}

const streamEvent = (event) => ({ type: "stream_event", event });
const doneMessage = (events) => events.find((event) => event.type === "done")?.message;
const textDeltas = (events) => events.filter((event) => event.type === "text_delta").map((event) => event.delta).join("");

describe("assistant tool-use boundary", () => {
	beforeEach(() => resetStack());

	it("adds tool calls that only appear in the assistant message before ending the turn", () => {
		ctx().resetTurnState(model);
		const events = installFakeStream();
		ctx().turnSawStreamEvent = true;

		processAssistantMessage({
			type: "assistant",
			message: { content: [{ type: "tool_use", id: "toolu_missing", name: "mcp__custom-tools__read", input: { file_path: "README.md" } }] },
		}, model, new Map([["mcp__custom-tools__read", "read"]]));

		assert.deepEqual(events.map((event) => event.type), ["start", "toolcall_start", "toolcall_end", "done", "stream_end"]);
		assert.deepEqual(doneMessage(events).content, [{ type: "toolCall", id: "toolu_missing", name: "read", arguments: { path: "README.md" } }]);
	});

	it("delivers a late same-message tool call exactly once when its first result opens the next stream", async () => {
		const c = ctx();
		c.resetTurnState(model);
		installFakeStream();
		const names = new Map([["mcp__custom-tools__read", "read"]]);

		processStreamEvent(streamEvent({ type: "message_start", message: { id: "msg-1" } }), names, model);
		processStreamEvent(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-a", name: "mcp__custom-tools__read", input: {} } }), names, model);
		processStreamEvent(streamEvent({ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: "{\"file_path\":\"a.txt\"}" } }), names, model);
		processStreamEvent(streamEvent({ type: "content_block_stop", index: 0 }), names, model);
		processStreamEvent(streamEvent({ type: "message_stop" }), names, model);

		let resolved;
		c.activeQuery = {};
		c.pendingToolCalls.set("call-a", { toolName: "read", resolve(result) { resolved = result; } });
		const deliveryStream = streamClaudeAgentSdk(model, { messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "read", arguments: { path: "a.txt" } }] },
			{ role: "toolResult", toolCallId: "call-a", content: [{ type: "text", text: "A result" }] },
		] });

		processAssistantMessage({ type: "assistant", message: { id: "msg-1", content: [
			{ type: "tool_use", id: "call-a", name: "mcp__custom-tools__read", input: { file_path: "a.txt" } },
		] } }, model, names);
		processAssistantMessage({ type: "assistant", message: { id: "msg-1", content: [
			{ type: "tool_use", id: "call-a", name: "mcp__custom-tools__read", input: { file_path: "a.txt" } },
			{ type: "tool_use", id: "call-b", name: "mcp__custom-tools__read", input: { file_path: "b.txt" } },
		] } }, model, names);

		const events = [];
		for await (const event of deliveryStream) events.push(event);
		assert.deepEqual(events.filter((event) => event.type === "toolcall_end").map((event) => event.toolCall.id), ["call-b"]);
		assert.deepEqual(resolved.content, [{ type: "text", text: "A result" }]);
	});

	it("stops the turn with an error and emits no later tool calls after a result for an unknown call", async () => {
		const c = ctx();
		c.resetTurnState(model);
		let interrupted = false;
		let closed = false;
		c.activeQuery = {
			interrupt() { interrupted = true; return Promise.resolve(); },
			close() { closed = true; },
		};
		c.assistantMessageId = "msg-1";
		c.recordToolCall("call-b", "write", { path: "out.txt", content: "ok" });
		let stoppedResult;
		c.pendingToolCalls.set("call-b", { toolName: "write", resolve(result) { stoppedResult = result; } });

		const stoppedStream = streamClaudeAgentSdk(model, { messages: [
			{ role: "assistant", content: [{ type: "toolCall", id: "other", name: "read", arguments: {} }] },
			{ role: "toolResult", toolCallId: "unknown", content: "unexpected" },
		] });
		const stoppedEvents = [];
		for await (const event of stoppedStream) stoppedEvents.push(event);

		const names = new Map([["mcp__custom-tools__write", "write"]]);
		c.resetTurnState(model);
		const lateEvents = installFakeStream();
		processStreamEvent(streamEvent({ type: "message_start", message: { id: "msg-2" } }), names, model);
		processStreamEvent(streamEvent({ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "post-mismatch-write", name: "mcp__custom-tools__write", input: {} } }), names, model);
		processAssistantMessage({ type: "assistant", message: { id: "msg-2", content: [
			{ type: "tool_use", id: "post-mismatch-write", name: "mcp__custom-tools__write", input: { file_path: "out.txt", content: "bad" } },
		] } }, model, names);

		assert.equal(stoppedResult.isError, true, "the waiting handler must not report success");
		assert.equal(interrupted, true);
		assert.equal(closed, true);
		assert.deepEqual(stoppedEvents.map((event) => event.type), ["error"]);
		assert.deepEqual(lateEvents, [], "a tool call after the mismatch must never reach Pi");
	});

	it("still renders the assistant text after a late bare message_stop", () => {
		ctx().resetTurnState(model);
		const events = installFakeStream();

		processStreamEvent(streamEvent({ type: "message_stop" }), new Map(), model);
		processAssistantMessage({ type: "assistant", message: { content: [{ type: "text", text: "next turn text" }] } }, model, new Map());

		assert.equal(textDeltas(events), "next turn text");
	});

	it("ignores late unmatched content events and still renders the assistant text", () => {
		ctx().resetTurnState(model);
		const events = installFakeStream();

		processStreamEvent(streamEvent({ type: "content_block_delta", index: 7, delta: { type: "text_delta", text: "late" } }), new Map(), model);
		processStreamEvent(streamEvent({ type: "content_block_stop", index: 7 }), new Map(), model);
		processAssistantMessage({ type: "assistant", message: { content: [{ type: "text", text: "fallback after stale content event" }] } }, model, new Map());

		assert.equal(textDeltas(events), "fallback after stale content event");
	});

	it("labels the Pi assistant message with the model Claude Code switched to", () => {
		const c = ctx();
		c.resetTurnState({ ...model, id: "claude-fable-5" });
		installFakeStream();

		processStreamEvent(streamEvent({
			type: "message_start",
			message: { model: "claude-opus-4-8", usage: { input_tokens: 1, output_tokens: 0 } },
		}), new Map(), model);

		// turnOutput is the assistant message object Pi receives.
		assert.equal(c.turnOutput.model, "claude-opus-4-8");
	});

	it("records fallback assistant blocks without rendering them as text", () => {
		const c = ctx();
		c.resetTurnState({ ...model, id: "claude-fable-5" });
		const events = installFakeStream();

		processAssistantMessage({
			type: "assistant",
			message: {
				model: "claude-opus-4-8",
				content: [{ type: "fallback", from: { model: "claude-fable-5" }, to: { model: "claude-opus-4-8" } }],
			},
		}, model, new Map());

		assert.equal(c.turnOutput.model, "claude-opus-4-8");
		assert.deepEqual(c.turnOutput.content, []);
		assert.equal(textDeltas(events), "");
	});
});
