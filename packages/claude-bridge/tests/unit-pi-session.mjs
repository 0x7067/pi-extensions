/**
 * The bridge inside a real Pi session (the pi-coding-agent SDK), with the real
 * bundled Claude Code binary talking to a scripted fake Anthropic API.
 *
 * Unlike the contract tests, which stand in for Pi, this uses Pi's own agent
 * loop, tool registry and transcript, so it shows what Pi really does with a
 * tool Claude loads through ToolSearch.
 */
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { startFakeAnthropic } from "./lib/fake-anthropic.mjs";

globalThis.CLAUDE_BRIDGE_ISOLATED = true;
const { createClaudeBridgeExtension } = await import("../src/index.ts");

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

const DEFERRED_NAME = "mcp__dev__apply";
const DEFERRED_SDK_NAME = `mcp__custom-tools__${DEFERRED_NAME}`;
const CODEMODE_NAME = "mcp__dev__scripted";
const CODEMODE_SDK_NAME = `mcp__custom-tools__${CODEMODE_NAME}`;

let workDir;
let fakeApi;
let respond;
let session;
const executed = [];

function devTools(pi) {
	pi.registerTool({
		name: DEFERRED_NAME,
		label: "Apply",
		description: "Apply a change.",
		parameters: Type.Object({ change: Type.String() }),
		exposure: "deferred",
		execute: async (_id, params) => {
			executed.push(params);
			return { content: [{ type: "text", text: `applied ${params.change}` }], details: {} };
		},
	});
}

function codemodeTool(pi) {
	pi.registerTool({
		name: CODEMODE_NAME,
		label: "Scripted",
		description: "A tool reached through codemode.",
		parameters: Type.Object({ step: Type.String() }),
		exposure: "codemode",
		execute: async (_id, params) => {
			executed.push(params);
			return { content: [{ type: "text", text: `scripted ${params.step}` }], details: {} };
		},
	});
}

describe("Claude bridge in a Pi session", { timeout: 90_000, skip: claudeBinary ? false : "bundled Claude Code binary not installed for this platform" }, () => {
	before(async () => {
		workDir = mkdtempSync(join(tmpdir(), "claude-bridge-pi-session-"));
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
			ENABLE_TOOL_SEARCH: "true", // the fake endpoint is not first-party
		});

		const agentDir = join(workDir, "agent");
		const cwd = join(workDir, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			extensionFactories: [createClaudeBridgeExtension({ userDir: agentDir }), devTools, codemodeTool],
		});
		await resourceLoader.reload();
		const modelRuntime = await ModelRuntime.create({ agentDir });
		({ session } = await createAgentSession({
			cwd,
			agentDir,
			resourceLoader,
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			sessionManager: SessionManager.inMemory(),
		}));
		await session.bindExtensions({});
		const model = modelRuntime.getModel("claude-bridge", "claude-haiku-4-5");
		assert.ok(model, "the bridge registers its models with Pi");
		await session.setModel(model);
	});

	after(async () => {
		session?.dispose();
		await fakeApi?.close();
		if (workDir) rmSync(workDir, { recursive: true, force: true });
	});

	it("a deferred tool Claude loads and calls runs in Pi and stays declared in Pi's transcript", async () => {
		const start = fakeApi.requests.length;
		assert.equal(session.getActiveToolNames().includes(DEFERRED_NAME), false, "Pi does not declare a deferred tool to its model");
		respond = (_request, index) => {
			if (index === start) return { toolUse: { id: "toolu_load", name: "ToolSearch", input: { query: `select:${DEFERRED_SDK_NAME}`, max_results: 1 } } };
			if (index === start + 1) return { toolUse: { id: "toolu_apply", name: DEFERRED_SDK_NAME, input: { change: "g1" } } };
			return { text: "Done." };
		};

		await session.prompt("Apply change g1.");

		assert.deepEqual(executed, [{ change: "g1" }], "Pi must run the tool exactly once");
		const toolResults = session.messages.filter((message) => message.role === "toolResult");
		assert.equal(toolResults.length, 1, "the first call runs; there is no not-found result to retry");
		assert.ok(session.getActiveToolNames().includes(DEFERRED_NAME), "the tool is active in Pi");
		const declared = getCurrentTools(session.messages).map((tool) => tool.name);
		assert.ok(declared.includes(DEFERRED_NAME), "Pi's transcript declares it, so another model sees it after a model switch");
		assert.equal(toolResults[0].isError, false);
		assert.equal(toolResults[0].content[0].text, "applied g1");
		const last = session.messages.at(-1);
		assert.equal(last.role, "assistant");
		assert.equal(last.content.map((block) => block.text ?? "").join(""), "Done.");
	});

	it("a later prompt continues the same session with system messages in Pi's transcript", async () => {
		const start = fakeApi.requests.length;
		respond = () => ({ text: "Still here." });

		await session.prompt("And again?");

		const last = session.messages.at(-1);
		assert.equal(last.content.map((block) => block.text ?? "").join(""), "Still here.");
		const sent = fakeApi.requests[start].messages.map((message) => message.parts.join("|"));
		assert.ok(sent.some((part) => part.includes("Apply change g1.")), "Claude still has the earlier conversation");
		assert.ok(sent.at(-1).includes("And again?"));
		assert.equal(fakeApi.requests.length - start, 1);
	});

	it("a codemode-exposed tool Claude loads and calls also runs in the same turn", async () => {
		const start = fakeApi.requests.length;
		const before = executed.length;
		respond = (_request, index) => {
			if (index === start) return { toolUse: { id: "toolu_load_cm", name: "ToolSearch", input: { query: `select:${CODEMODE_SDK_NAME}`, max_results: 1 } } };
			if (index === start + 1) return { toolUse: { id: "toolu_cm", name: CODEMODE_SDK_NAME, input: { step: "one" } } };
			return { text: "Scripted." };
		};

		await session.prompt("Run the scripted step.");

		assert.deepEqual(executed.slice(before), [{ step: "one" }]);
		const result = session.messages.filter((message) => message.role === "toolResult").at(-1);
		assert.equal(result.isError, false);
		assert.equal(result.content[0].text, "scripted one");
		assert.ok(getCurrentTools(session.messages).some((tool) => tool.name === CODEMODE_NAME));
	});
});
