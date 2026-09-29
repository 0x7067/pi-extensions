/**
 * Scripted stand-in for the Anthropic Messages API, for running the real
 * Claude Code binary without credentials or network access.
 *
 * Every request is recorded. `respond(request)` decides the reply:
 *   { text }                       stream an assistant text reply
 *   { thinking }                   stream a reply that is only a thinking block
 *   { toolUse: { id, name, input } } stream a single tool call
 *   { status, message }            return an API error
 */
import { createServer } from "node:http";

function sse(res, events) {
	res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
	for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
	res.end();
}

let nextMessageId = 1;

function streamReply(res, model, reply) {
	const id = `msg_fake_${nextMessageId++}`;
	const usage = { input_tokens: 100, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
	const events = [{ type: "message_start", message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage } }];
	if (reply.toolUse) {
		const { id: toolId, name, input } = reply.toolUse;
		events.push(
			{ type: "content_block_start", index: 0, content_block: { type: "tool_use", id: toolId, name, input: {} } },
			{ type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify(input ?? {}) } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 10 } },
		);
	} else if (reply.thinking) {
		events.push(
			{ type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: reply.thinking } },
			{ type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fake-signature" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
		);
	} else {
		events.push(
			{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
			{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: reply.text ?? "" } },
			{ type: "content_block_stop", index: 0 },
			{ type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } },
		);
	}
	events.push({ type: "message_stop" });
	sse(res, events);
}

/** A message from a recorded request, flattened for assertions: role plus readable parts. */
export function describeMessage(message) {
	const content = typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
	return {
		role: message.role,
		parts: content.map((block) => {
			if (block.type === "text") return block.text;
			if (block.type === "tool_use") return `tool_use:${block.name}`;
			if (block.type === "tool_result") {
				const text = typeof block.content === "string"
					? block.content
					: (block.content ?? []).map((part) => part.text ?? `[${part.type}]`).join("");
				return `tool_result:${text}`;
			}
			return `[${block.type}]`;
		}),
	};
}

export async function startFakeAnthropic(respond, { authorize } = {}) {
	const requests = [];
	const server = createServer((req, res) => {
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			if (req.method !== "POST" || !req.url?.startsWith("/v1/messages")) {
				res.writeHead(404).end();
				return;
			}
			if (authorize && !authorize(req.headers)) {
				res.writeHead(401, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "Synthetic test credentials were rejected." } }));
				return;
			}
			const parsed = JSON.parse(body || "{}");
			const request = { body: parsed, beta: String(req.headers["anthropic-beta"] ?? ""), messages: (parsed.messages ?? []).map(describeMessage) };
			requests.push(request);
			const reply = respond(request, requests.length - 1) ?? { text: "ok" };
			if (reply.status) {
				res.writeHead(reply.status, { "content-type": "application/json" });
				res.end(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: reply.message ?? "error" } }));
				return;
			}
			if (reply.delayMs) setTimeout(() => streamReply(res, parsed.model, reply), reply.delayMs);
			else streamReply(res, parsed.model, reply);
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address();
	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}
