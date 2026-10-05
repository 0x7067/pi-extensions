import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { CLAUDE_BRIDGE_TOOL_ISOLATION, DISALLOWED_BUILTIN_TOOLS } from "../src/index.ts";

describe("Claude Code tool isolation", () => {
	it("keeps only Claude Code's tool search from the built-in base tool set", () => {
		assert.deepEqual(CLAUDE_BRIDGE_TOOL_ISOLATION.tools, ["ToolSearch"]);
		assert.equal(DISALLOWED_BUILTIN_TOOLS.includes("ToolSearch"), false);
		assert.deepEqual(CLAUDE_BRIDGE_TOOL_ISOLATION.allowedTools, ["mcp__custom-tools__*"]);
	});

	it("guards against native Claude Code tools observed leaking into bridge context", () => {
		for (const name of ["CronList", "SendMessage", "Skill", "TaskOutput", "TaskStop", "TodoWrite", "ScheduleWakeup"]) {
			assert.ok(DISALLOWED_BUILTIN_TOOLS.includes(name), `${name} should be disallowed`);
		}
	});
});
