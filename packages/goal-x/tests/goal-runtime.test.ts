import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test, type TestContext } from "node:test";
import goalExtension from "../extensions/goal.ts";
import {
	GOAL_AUDIT_REJECTION_REPORT_MAX_LENGTH,
	GOAL_BLOCKER_MAX_LENGTH,
	GOAL_BLOCK_EVIDENCE_MAX_LENGTH,
	GOAL_BLOCK_NO_AUTONOMOUS_PATH_MAX_LENGTH,
	GOAL_COMPLETION_AUDITOR_REPORT_MAX_LENGTH,
	GOAL_COMPLETION_SUMMARY_MAX_LENGTH,
	GOAL_CONTINUATION_MESSAGE,
	GOAL_CONTINUATION_TEXT,
	GOAL_OBJECTIVE_MAX_LENGTH,
	GOAL_UNBLOCK_CONDITION_MAX_LENGTH,
	GOAL_WAIT_MIN_SECONDS,
	GOAL_WAIT_MAX_SECONDS,
	GOAL_WAKE_ENTRY,
	GOAL_PROPOSAL_EVENT,
	GOAL_AUDIT_EVENT,
	GOAL_STATE_EVENT,
	GOAL_STATE_REQUEST_EVENT,
	isGoalBlockedPause,
	parseGoalState,
} from "../extensions/goal-contract.ts";
import { GOAL_TRANSCRIPT_EVENT } from "../extensions/goal-transcript-events.ts";
import { createHarness, executeTool } from "./harness.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function harnessWithGoal(auditor: (args: unknown) => Promise<{ approved: boolean; output: string; error?: string }>) {
	const cwd = mkdtempSync(path.join(tmpdir(), "portable-goal-"));
	temporaryDirectories.push(cwd);
	const harness = createHarness([], cwd);
	goalExtension(harness.pi, { runCompletionAuditor: auditor as never });
	return harness;
}

function blockProof(blocker: string, unblockCondition = "The missing external condition is satisfied.") {
	return {
		blocker,
		evidence: "The current environment was checked and the prerequisite is absent.",
		whyNoAutonomousPathRemains: "Every remaining safe, in-scope action requires that prerequisite.",
		unblockCondition,
	};
}

function latestGoalState(entries: Array<Record<string, unknown>>) {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.customType !== "pi-goal-state-v1") continue;
		const parsed = parseGoalState(entry.data);
		if (parsed) return parsed;
	}
	throw new Error("No Goal state entry");
}

test("model tool surface exposes strict blocking and no discretionary pause", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
	const tool = harness.tools.get("set_goal_blocked");
	assert.ok(tool);
	assert.equal(harness.tools.has("pause_goal"), false);
	assert.equal(tool.label, "Set Goal Blocked");
	assert.match(tool.description ?? "", /only when no safe, in-scope action can materially advance/i);
	assert.doesNotMatch(`${tool.description}\n${tool.promptSnippet}\n${tool.promptGuidelines?.join("\n")}`, /pause_goal|Pause Goal/);
	const schema = tool.parameters as { required?: string[]; additionalProperties?: boolean };
	assert.deepEqual(schema.required, ["blocker", "evidence", "whyNoAutonomousPathRemains", "unblockCondition"]);
	assert.equal(schema.additionalProperties, false);
});

test("confirmed Goal sends one generic durable continuation at idle and blocked resume restarts it", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	const result = await executeTool(harness, "propose_goal", { objective: "Ship the portable Goal runtime" });
	assert.equal(result.terminate, true);
	assert.equal(latestGoalState(harness.entries).goal?.status, "active");
	assert.equal(harness.sent.length, 0, "Goal waits for Pi's idle boundary before sending");
	harness.runIdle();
	assert.deepEqual(harness.sent, [{
		message: {
			customType: GOAL_CONTINUATION_MESSAGE,
			content: GOAL_CONTINUATION_TEXT,
			display: false,
		},
		options: { deliverAs: "followUp", triggerTurn: true },
	}]);
	assert.match(GOAL_CONTINUATION_TEXT, /^<system_message source="goal_extension">\n[\s\S]*Continue the Goal\.\n<\/system_message>$/, "Pi delivers custom messages in the user role, so the continuation is tagged as a Goal extension message");
	assert.match(GOAL_CONTINUATION_TEXT, /not a message from the user\. It does not answer anything you asked the user, approve anything, or give permission/);

	await executeTool(harness, "set_goal_blocked", blockProof("The required API key is unavailable.", "API_KEY is configured."));
	const blocked = latestGoalState(harness.entries).goal;
	assert.equal(blocked?.status, "paused", "model-owned blocking maps to the existing internal paused state");
	assert.equal(isGoalBlockedPause(blocked?.pause), true);
	assert.match(blocked?.pause?.reason ?? "", /Blocker: The required API key is unavailable\.[\s\S]*Evidence:[\s\S]*Why no autonomous path remains:/);
	assert.equal(blocked?.pause?.suggestedAction, "API_KEY is configured.");
	const blockedReceipt = [...harness.events.emitted].reverse().find((event) => event.channel === GOAL_TRANSCRIPT_EVENT) as { data?: { kind?: string; message?: string; tuiMessage?: string } } | undefined;
	assert.equal(blockedReceipt?.data?.kind, "goal_blocked");
	assert.match(blockedReceipt?.data?.message ?? "", /Blocker:[\s\S]*Evidence:[\s\S]*Why no autonomous path remains:[\s\S]*Unblock condition:/);
	assert.match(blockedReceipt?.data?.tuiMessage ?? "", /^Goal blocked:/);
	const beforeRepeat = {
		entries: structuredClone(harness.entries),
		events: structuredClone(harness.events.emitted),
		sent: structuredClone(harness.sent),
	};
	await assert.rejects(
		() => executeTool(harness, "set_goal_blocked", blockProof("A second blocker claim must not mutate state.")),
		/The Goal is blocked, not active\./,
	);
	assert.deepEqual(harness.entries, beforeRepeat.entries, "repeat blocking leaves persisted state unchanged");
	assert.deepEqual(harness.events.emitted, beforeRepeat.events, "repeat blocking emits no additional receipt or state event");
	harness.runIdle();
	assert.deepEqual(harness.sent, beforeRepeat.sent, "repeat blocking schedules no continuation side effect");
	await harness.run("session_tree", {});
	assert.equal(isGoalBlockedPause(latestGoalState(harness.entries).goal?.pause), true, "blocked proof survives branch replay through the existing state shape");
	const blockedPrompt = await harness.run("before_agent_start", { systemPrompt: "BASE", initiator: "custom_message", prompt: "Continue the Goal.", systemPromptOptions: {} });
	assert.match((blockedPrompt[0] as { systemPrompt?: string }).systemPrompt ?? "", /\[PI GOAL BLOCKED\][\s\S]*The Goal is blocked[\s\S]*Evidence:[\s\S]*Unblock condition: API_KEY is configured\./);

	await executeTool(harness, "resume_goal", {});
	const resumed = latestGoalState(harness.entries).goal;
	assert.equal(resumed?.status, "active");
	assert.equal(Object.hasOwn(resumed ?? {}, "pause"), false, "optional snapshot fields are omitted rather than emitted as undefined");
	assert.equal(harness.sent.length, 1, "resume waits for the next idle boundary");
	harness.runIdle();
	assert.equal(harness.sent.length, 2, "resume starts exactly one continuation");
	assert.deepEqual(harness.sent[1], harness.sent[0], "generic continuation content never carries mutable Goal identity");
});

test("native human pause remains paused while model-owned blocking stays unavailable as pause_goal", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "Preserve human pause semantics" });
	const pauseCommand = harness.commands.get("goal-pause");
	assert.ok(pauseCommand);
	await pauseCommand.handler("Paused for a human decision.", harness.ctx);
	const paused = latestGoalState(harness.entries).goal;
	assert.equal(paused?.status, "paused");
	assert.equal(isGoalBlockedPause(paused?.pause), false);
	const receipt = [...harness.events.emitted].reverse().find((event) => event.channel === GOAL_TRANSCRIPT_EVENT) as { data?: { kind?: string; tuiMessage?: string } } | undefined;
	assert.equal(receipt?.data?.kind, "goal_paused");
	assert.match(receipt?.data?.tuiMessage ?? "", /^Goal paused:/);
	await assert.rejects(
		() => executeTool(harness, "set_goal_blocked", blockProof("A human pause is not a model block.")),
		/The Goal is paused, not active\./,
	);
	const prompt = await harness.run("before_agent_start", { systemPrompt: "BASE", initiator: "user", prompt: "Status", systemPromptOptions: {} });
	assert.match((prompt[0] as { systemPrompt?: string }).systemPrompt ?? "", /The Goal is paused by the user/);
	harness.runIdle();
	assert.equal(harness.sent.length, 0, "human pause also makes the activation callback harmless");
});

test("a confirmed revision resumes a blocked or human-paused Goal and a declined one leaves it paused", async (t) => {
	for (const [label, stop] of [
		["blocked", (harness: ReturnType<typeof harnessWithGoal>) => executeTool(harness, "set_goal_blocked", blockProof("The deploy target is wrong."))],
		["human-paused", async (harness: ReturnType<typeof harnessWithGoal>) => { await harness.commands.get("goal-pause")?.handler("Paused to rethink scope.", harness.ctx); }],
	] as const) {
		await t.test(label, async () => {
			const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
			await harness.run("session_start", { reason: "startup" });
			harness.confirmations.push(true);
			await executeTool(harness, "propose_goal", { objective: "Deploy to staging" });
			harness.runIdle();
			await stop(harness);
			assert.equal(latestGoalState(harness.entries).goal?.status, "paused");

			harness.confirmations.push(false);
			await executeTool(harness, "tweak_goal", { objective: "Deploy to production" });
			harness.runIdle();
			assert.equal(latestGoalState(harness.entries).goal?.status, "paused", "a declined revision changes nothing");
			assert.equal(harness.sent.length, 1);

			harness.confirmations.push(true);
			const result = await executeTool(harness, "tweak_goal", { objective: "Deploy to production" });
			assert.match(String(result.content?.[0]?.text), /Goal revision confirmed\. Autonomous continuation is active\./);
			const revised = latestGoalState(harness.entries).goal;
			assert.equal(revised?.objective, "Deploy to production");
			assert.equal(revised?.status, "active");
			assert.equal(revised?.autoContinue, true);
			assert.equal(Object.hasOwn(revised ?? {}, "pause"), false);
			const receipt = [...harness.events.emitted].reverse().find((event) => event.channel === GOAL_TRANSCRIPT_EVENT) as { data?: { kind?: string; changeSummary?: string } } | undefined;
			assert.equal(receipt?.data?.kind, "goal_updated");
			assert.match(receipt?.data?.changeSummary ?? "", /the Goal resumed/);
			harness.runIdle();
			assert.equal(harness.sent.length, 2, "the confirmed revision starts exactly one continuation");
		});
	}
});

test("malformed legacy block-like pauses stay human-paused through replay and resume", async (t) => {
	for (const [label, pause] of [
		["empty sections", { reason: "Blocker: \nEvidence: \nWhy no autonomous path remains: ", suggestedAction: "Resume after the decision." }],
		["misordered sections", { reason: "Blocker: blocker\nWhy no autonomous path remains: why\nEvidence: evidence", suggestedAction: "resume" }],
		["incomplete sections", { reason: "Blocker: blocker\nEvidence: evidence", suggestedAction: "resume" }],
	] as const) {
		await t.test(label, async () => {
			const harness = createHarness([{
				type: "custom",
				customType: "pi-goal-state-v1",
				data: {
					schemaVersion: 1,
					revision: 1,
					goal: {
						id: `legacy-${label}`,
						objective: "Preserve and resume the legacy human pause",
						status: "paused",
						autoContinue: false,
						usage: { tokensUsed: 0, activeSeconds: 0 },
						createdAt: "2026-08-28T00:00:00.000Z",
						updatedAt: "2026-08-28T00:00:00.000Z",
						pause,
					},
				},
			}]);
			goalExtension(harness.pi, { runCompletionAuditor: async () => ({ approved: false, output: "not used\n<disapproved/>" }) });
			await harness.run("session_start", { reason: "startup" });
			assert.equal(isGoalBlockedPause(latestGoalState(harness.entries).goal?.pause), false);
			const prompt = await harness.run("before_agent_start", { systemPrompt: "BASE", initiator: "user", prompt: "Status", systemPromptOptions: {} });
			assert.match((prompt[0] as { systemPrompt?: string }).systemPrompt ?? "", /\[PI GOAL PAUSED\][\s\S]*The Goal is paused by the user/);
			assert.doesNotMatch((prompt[0] as { systemPrompt?: string }).systemPrompt ?? "", /\[PI GOAL BLOCKED\]/);
			await assert.rejects(
				() => executeTool(harness, "set_goal_blocked", blockProof("A malformed legacy pause must not become blocked.")),
				/The Goal is paused, not active\./,
			);
			await executeTool(harness, "resume_goal", {});
			assert.equal(latestGoalState(harness.entries).goal?.status, "active");
			assert.equal(Object.hasOwn(latestGoalState(harness.entries).goal ?? {}, "pause"), false);
			harness.runIdle();
			assert.equal(harness.sent.length, 1, "resume schedules one ordinary continuation");
		});
	}
});

test("an incompatible Pi runtime fails before Goal state mutation", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\\n<disapproved/>" }));
	delete (harness.ctx as unknown as { onIdle?: unknown }).onIdle;
	await assert.rejects(() => harness.run("session_start", { reason: "startup" }), /requires .*pi-coding-agent >= 0\.84\.1.*ctx\.onIdle/i);
	assert.equal(harness.entries.length, 0, "incompatible startup appends no Goal state or proposal revision");
	await assert.rejects(() => executeTool(harness, "propose_goal", { objective: "Must not partially persist" }), /requires .*pi-coding-agent >= 0\.84\.1.*ctx\.onIdle/i);
	assert.equal(harness.entries.length, 0, "incompatible proposal appends no Goal state or proposal revision");
});

test("missing idle support blocks migration and compaction without mutating Goal or Todo entries", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "portable-goal-missing-idle-write-"));
	temporaryDirectories.push(cwd);
	const harness = createHarness([
		{ type: "custom", customType: "pi-goal-state-v1", data: { schemaVersion: 1, revision: 1, goal: null } },
		{ type: "custom", customType: "pi-todo-state-v1", data: { schemaVersion: 1, revision: 1, tasks: [] } },
	], cwd);
	goalExtension(harness.pi);
	delete (harness.ctx as unknown as { onIdle?: unknown }).onIdle;
	const missingIdle = /requires .*pi-coding-agent >= 0\.84\.1.*ctx\.onIdle/i;
	const before = JSON.stringify(harness.entries);
	await assert.rejects(() => harness.run("session_start", { reason: "startup" }), missingIdle);
	const migrate = harness.commands.get("goal-migrate");
	assert.ok(migrate);
	await assert.rejects(() => migrate.handler("", harness.ctx), missingIdle);
	await assert.rejects(() => harness.run("session_compact", {}), missingIdle);
	assert.equal(JSON.stringify(harness.entries), before, "failed compatibility checks leave Goal and Todo entries byte-identical");
});

test("an absent Goal schedules no continuation at settlement", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	assert.equal(harness.sent.length, 0);
	await harness.run("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
	await harness.run("agent_settled", {});
	assert.equal(harness.sent.length, 0, "absent Goal schedules no continuation at settlement");
});

test("an active agent run defers Goal continuation until Pi reports idle", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "Do not queue an in-run follow-up" });
	assert.equal(harness.sent.length, 0, "Goal activation inside a run does not queue a follow-up before idle");

	await harness.run("agent_end", { messages: [{ role: "assistant", stopReason: "toolUse", content: [] }] });
	harness.runIdle();
	assert.equal(harness.sent.length, 1, "the fully settled active Goal starts one direct continuation");
});

test("threshold compaction keeps one Goal continuation pending until Pi reports idle", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "Continue after threshold compaction" });
	harness.runIdle();
	assert.equal(harness.sent.length, 1);

	await harness.run("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
	await harness.run("session_before_compact", { reason: "threshold" });
	await harness.run("session_compact", {});
	assert.equal(harness.sent.length, 1, "compaction does not receive a premature Goal wake");
	harness.runIdle();
	assert.equal(harness.sent.length, 2, "one wake is sent only after compaction and the full run are idle");
});

test("stale idle registrations cannot wake a paused, abandoned, or complete Goal", async () => {
	const scenarios = [
		{
			name: "blocked",
			mutate: async (harness: ReturnType<typeof harnessWithGoal>) => {
				await executeTool(harness, "set_goal_blocked", blockProof("Required user input is unavailable."));
			},
		},
		{
			name: "abandoned",
			mutate: async (harness: ReturnType<typeof harnessWithGoal>) => {
				await executeTool(harness, "abandon_goal", { reason: "No longer needed" });
			},
		},
		{
			name: "complete",
			mutate: async (harness: ReturnType<typeof harnessWithGoal>) => {
				await executeTool(harness, "complete_goal", { summary: "Verified complete" });
			},
		},
	] as const;

	for (const scenario of scenarios) {
		const harness = harnessWithGoal(async () => ({ approved: true, output: "Verified.\n<approved/>" }));
		await harness.run("session_start", { reason: "startup" });
		harness.confirmations.push(true);
		await executeTool(harness, "propose_goal", { objective: `Reach ${scenario.name} without a stale wake` });
		await scenario.mutate(harness);
		harness.runIdle();
		assert.equal(harness.sent.length, 0, `${scenario.name} Goal ignores a callback registered before the lifecycle change`);
		if (scenario.name === "complete") {
			await harness.run("agent_settled", {});
			harness.runIdle();
			assert.equal(harness.sent.length, 0, "archived completion remains inert after settlement");
		}
	}
});

test("Goal semantic state is byte-stable in the system prompt and never floated into provider messages", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	assert.equal(harness.handlers.has("context"), false, "Goal registers no per-provider context transform");
	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "Original objective" });

	const event = {
		initiator: "custom_message",
		prompt: "Continue the Goal.",
		systemPrompt: "BASE SYSTEM PROMPT",
		systemPromptOptions: {},
	};
	const first = await harness.run("before_agent_start", event);
	const firstPrompt = (first[0] as { systemPrompt?: string }).systemPrompt ?? "";
	assert.match(firstPrompt, /^BASE SYSTEM PROMPT\n\n\[PI GOAL ACTIVE\]/);
	assert.match(firstPrompt, /Original objective/);
	assert.match(firstPrompt, /An active Goal continues by default/);
	assert.match(firstPrompt, /set_goal_blocked is an exceptional factual claim/);
	assert.match(firstPrompt, /"Continue the Goal\." messages are automatic reprompts from the Goal extension, not from the user\. They never answer your questions, approve anything, or give permission/);
	assert.match(firstPrompt, /If nothing else can advance the Goal until the user replies to a decision you put to them, call wait_goal\./);
	assert.doesNotMatch(firstPrompt, /pause_goal|call pause|revision=|goalId=|tokensUsed|activeSeconds|updatedAt/);

	const revisionBeforeAccounting = latestGoalState(harness.entries).revision;
	await harness.run("turn_end", {
		message: { role: "assistant", content: [], stopReason: "toolUse", usage: { input: 10_000, output: 100 } },
		toolResults: [],
	});
	assert.ok(latestGoalState(harness.entries).revision > revisionBeforeAccounting, "accounting still advances producer state");
	const accountingOnly = await harness.run("before_agent_start", event);
	assert.equal((accountingOnly[0] as { systemPrompt?: string }).systemPrompt, firstPrompt, "accounting-only state changes preserve exact prompt bytes");

	harness.confirmations.push(true);
	await executeTool(harness, "tweak_goal", { objective: "Revised objective" });
	const revised = await harness.run("before_agent_start", event);
	const revisedPrompt = (revised[0] as { systemPrompt?: string }).systemPrompt ?? "";
	assert.notEqual(revisedPrompt, firstPrompt, "semantic Goal changes create one new prompt prefix");
	assert.match(revisedPrompt, /Revised objective/);
	assert.doesNotMatch(revisedPrompt, /Original objective/);
});

test("Goal proposals use Markdown confirmation with bounded comments and identical result wording", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	harness.confirmationForms.push({ confirmed: false, input: "Keep the scope narrower." });
	const declined = await executeTool(harness, "propose_goal", { objective: "# Ship it\n\n- Verify the release" });
	assert.match(String(declined.content?.[0]?.text), /Goal proposal declined/);
	assert.match(String(declined.content?.[0]?.text), /User comment: "Keep the scope narrower\."/);
	assert.equal(harness.confirmationRequests[0]?.messageFormat, "markdown");
	assert.equal(harness.confirmationRequests[0]?.inputLabel, "Comments or reservations (optional)");
	assert.equal(harness.confirmationRequests[0]?.inputPlaceholder, "Write additional comments or reservations here…");

	harness.confirmationForms.push({ confirmed: true, input: "Proceed with the documented criteria." });
	const accepted = await executeTool(harness, "propose_goal", { objective: "# Ship it" });
	assert.match(String(accepted.content?.[0]?.text), /Goal confirmed and started/);
	assert.match(String(accepted.content?.[0]?.text), /User comment: "Proceed with the documented criteria\."/);

	harness.confirmationForms.push({ confirmed: false });
	const revision = await executeTool(harness, "tweak_goal", { objective: "## Revised\n\nNew criteria" });
	assert.match(String(revision.content?.[0]?.text), /Goal revision declined/);
	assert.doesNotMatch(String(revision.content?.[0]?.text), /User comment/);
	assert.match(String(harness.confirmationRequests.at(-1)?.message), /## Current Goal[\s\S]*## Revised Goal/);
});

test("Goal falls back to the legacy boolean confirmation API", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\\n<disapproved/>" }));
	delete (harness.ctx.ui as unknown as { confirmWithInput?: unknown }).confirmWithInput;
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	const result = await executeTool(harness, "propose_goal", { objective: "Legacy confirmation" });
	assert.match(String(result.content?.[0]?.text), /Goal confirmed and started/);
	assert.equal(harness.confirmationRequests.length, 0);
});

test("Goal rejects comments over the bounded proposal comment limit", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	harness.confirmationForms.push({ confirmed: true, input: "x".repeat(4_001) });
	await assert.rejects(() => executeTool(harness, "propose_goal", { objective: "Bound this comment" }), /Goal proposal comment exceeds the 4000-character producer state bound/);
	assert.equal(harness.entries.some((entry) => entry.customType === "pi-goal-state-v1"), false);
});

test("declined proposals and tweaks do not mutate, confirmed tweaks replay, and abandonment archives without completion", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(false);
	await executeTool(harness, "propose_goal", { objective: "Declined objective" });
	assert.equal(harness.entries.some((entry) => entry.customType === "pi-goal-state-v1"), false);

	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "Original objective" });
	harness.runIdle();
	const originalBranchEnd = harness.entries.length;
	harness.confirmations.push(false);
	await executeTool(harness, "tweak_goal", { objective: "Declined revision" });
	assert.equal(latestGoalState(harness.entries).goal?.objective, "Original objective");

	harness.confirmations.push(true);
	await executeTool(harness, "tweak_goal", { objective: "Confirmed revision" });
	assert.equal(latestGoalState(harness.entries).goal?.objective, "Confirmed revision");
	harness.entries.splice(originalBranchEnd);
	await harness.run("session_tree", {});
	assert.equal(latestGoalState(harness.entries).goal?.objective, "Original objective", "tree navigation restores the branch's exact snapshot");

	await executeTool(harness, "abandon_goal", { reason: "User no longer wants this outcome" });
	assert.equal(latestGoalState(harness.entries).goal, null);
	const continuationsBeforeIdle = harness.sent.length;
	await harness.run("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
	harness.runIdle();
	assert.equal(harness.sent.length, continuationsBeforeIdle, "abandoned Goal schedules no continuation");
	const kinds = harness.events.emitted.filter((event) => event.channel === GOAL_TRANSCRIPT_EVENT).map((event) => (event.data as { kind?: string }).kind);
	assert.ok(kinds.includes("goal_abandoned"));
	assert.equal(kinds.includes("goal_completed"), false);
});

test("every normal agent end schedules one continuation without duplicating a wake", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "Inspect and improve the project" });
	harness.runIdle();
	await harness.run("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "No tools were needed." }] }] });
	await harness.run("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
	assert.equal(harness.sent.length, 1, "normal runs wait for the idle boundary");
	harness.runIdle();
	assert.equal(harness.sent.length, 2, "duplicate normal end signals produce one next continuation");

	await executeTool(harness, "set_goal_blocked", blockProof("Required user input is unavailable."));
	await harness.run("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
	harness.runIdle();
	assert.equal(harness.sent.length, 2, "blocked Goal schedules no continuation after normal settlement");
});

const NORMAL_END = { messages: [{ role: "assistant", stopReason: "stop", content: [] }] };

async function startedGoal(t: TestContext) {
	t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "Ship once CI is green" });
	harness.runIdle();
	await harness.run("before_agent_start", { systemPrompt: "BASE" });
	return harness;
}

test("wait_goal defers the next continuation until the chosen delay while the Goal stays active", async (t) => {
	const harness = await startedGoal(t);
	const result = await executeTool(harness, "wait_goal", { delaySeconds: 300, waitingFor: "CI run 42 to finish" });
	assert.equal(result.terminate, true);
	assert.equal(latestGoalState(harness.entries).goal?.status, "active", "waiting is not blocking or pausing");
	const receipt = [...harness.events.emitted].reverse().find((event) => event.channel === GOAL_TRANSCRIPT_EVENT)?.data as { kind?: string; reason?: string; message?: string };
	assert.equal(receipt.kind, "goal_waiting");
	assert.equal(receipt.reason, "CI run 42 to finish");
	assert.equal(receipt.message, "Waiting up to 5m: CI run 42 to finish");

	await harness.run("agent_end", NORMAL_END);
	harness.runIdle();
	t.mock.timers.tick(299_000);
	assert.equal(harness.sent.length, 1, "no continuation before the chosen wake");
	t.mock.timers.tick(1_000);
	assert.equal(harness.sent.length, 2, "the ordinary continuation fires at the chosen wake");
	assert.deepEqual(harness.sent[1], harness.sent[0]);

	await harness.run("before_agent_start", { systemPrompt: "BASE" });
	await harness.run("agent_end", NORMAL_END);
	harness.runIdle();
	assert.equal(harness.sent.length, 3, "without a new wait the Goal continues immediately");
});

test("any other run preempts a pending wait and continuation falls back to immediate", async (t) => {
	const harness = await startedGoal(t);
	await executeTool(harness, "wait_goal", { delaySeconds: 3_600, waitingFor: "the deploy to finish" });
	await harness.run("agent_end", NORMAL_END);
	harness.runIdle();

	await harness.run("before_agent_start", { systemPrompt: "BASE" });
	assert.deepEqual([...harness.entries].reverse().find((entry) => entry.customType === GOAL_WAKE_ENTRY)?.data, {
		schemaVersion: 1,
		goalId: latestGoalState(harness.entries).goal?.id,
		wakeAt: null,
	}, "the ended wait is durable");
	await harness.run("agent_end", NORMAL_END);
	harness.runIdle();
	assert.equal(harness.sent.length, 2, "the preempting run continues immediately when it settles");
	t.mock.timers.tick(3_600_000);
	assert.equal(harness.sent.length, 2, "the preempted timer never fires a second continuation");
});

test("a pending wait survives restart and an elapsed or ended wait continues immediately", async (t) => {
	const harness = await startedGoal(t);
	await executeTool(harness, "wait_goal", { delaySeconds: 600, waitingFor: "the review to land" });
	await harness.run("session_shutdown", {});

	t.mock.timers.tick(200_000);
	const restarted = createHarness(structuredClone(harness.entries));
	goalExtension(restarted.pi);
	await restarted.run("session_start", { reason: "startup" });
	restarted.runIdle();
	t.mock.timers.tick(399_000);
	assert.equal(restarted.sent.length, 0, "restart keeps the original wake time");
	t.mock.timers.tick(1_000);
	assert.equal(restarted.sent.length, 1);

	const late = createHarness(structuredClone(harness.entries));
	goalExtension(late.pi);
	await late.run("session_start", { reason: "startup" });
	late.runIdle();
	assert.equal(late.sent.length, 1, "a wake that elapsed while the host was down continues at once");
});

test("wait_goal rejects out-of-bound delays and inactive Goals without side effects", async (t) => {
	const harness = await startedGoal(t);
	const before = structuredClone(harness.entries);
	await assert.rejects(() => executeTool(harness, "wait_goal", { delaySeconds: GOAL_WAIT_MIN_SECONDS - 1, waitingFor: "too short" }), /delaySeconds/);
	await assert.rejects(() => executeTool(harness, "wait_goal", { delaySeconds: GOAL_WAIT_MAX_SECONDS + 1, waitingFor: "too long" }), /delaySeconds/);
	await assert.rejects(() => executeTool(harness, "wait_goal", { delaySeconds: 60, waitingFor: "   " }), /requires non-empty text/);
	assert.deepEqual(harness.entries, before);

	await executeTool(harness, "wait_goal", { delaySeconds: 600, waitingFor: "the build" });
	await executeTool(harness, "set_goal_blocked", blockProof("Credentials were revoked."));
	await assert.rejects(() => executeTool(harness, "wait_goal", { delaySeconds: 60, waitingFor: "the build" }), /The Goal is blocked, not active\./);
	await executeTool(harness, "resume_goal", {});
	harness.runIdle();
	assert.equal(harness.sent.length, 2, "leaving the active state ends the wait, so resume continues immediately");
});

test("Pi retry outcomes converge at idle and terminal failures do not loop", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "Survive native provider recovery" });
	harness.runIdle();

	await harness.run("agent_end", { messages: [{ role: "assistant", stopReason: "error", content: [] }] });
	await harness.run("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
	assert.equal(harness.sent.length, 1, "a retrying error does not wake before the successful retry settles");
	harness.runIdle();
	assert.equal(harness.sent.length, 2, "a successful Pi-owned retry schedules one continuation");

	for (const stopReason of ["error", "aborted"] as const) {
		await harness.run("agent_end", { messages: [{ role: "assistant", stopReason, content: [] }] });
		harness.runIdle();
	}
	assert.equal(harness.sent.length, 2, "terminal provider error and explicit abort schedule no Goal-owned retry");
});

test("terminal agent outcomes cancel callbacks armed by activation or resume", async () => {
	for (const arm of ["activation", "resume"] as const) {
		for (const stopReason of ["error", "aborted"] as const) {
			const harness = harnessWithGoal(async () => ({ approved: true, output: "Verified.\n<approved/>" }));
			await harness.run("session_start", { reason: "startup" });
			harness.confirmations.push(true);
			await executeTool(harness, "propose_goal", { objective: `${arm} terminal ${stopReason} must not wake` });
			if (arm === "resume") {
				harness.runIdle();
				await executeTool(harness, "set_goal_blocked", blockProof("The resume regression is waiting at its lifecycle boundary."));
				await executeTool(harness, "resume_goal", {});
			}
			const beforeTerminal = harness.sent.length;
			await harness.run("agent_end", { messages: [{ role: "assistant", stopReason, content: [] }] });
			harness.runIdle();
			assert.equal(harness.sent.length, beforeTerminal, `${arm} ${stopReason} cancels the pending hidden wake`);
		}
	}
});

test("audit phase is producer-owned and clears on every terminal auditor path", async () => {
	const scenarios = [
		{
			name: "approved",
			auditor: async () => ({ approved: true, output: "Evidence checked.\\n<approved/>" }),
		},
		{
			name: "rejected",
			auditor: async () => ({ approved: false, output: "Missing evidence.\\n<disapproved/>" }),
		},
		{
			name: "exception",
			auditor: async () => { throw new Error("auditor failed"); },
		},
		{
			name: "cancelled",
			auditor: async () => { throw new DOMException("Auditor aborted", "AbortError"); },
		},
	] as const;

	for (const scenario of scenarios) {
		const harness = harnessWithGoal(scenario.auditor);
		await harness.run("session_start", { reason: "startup" });
		harness.confirmations.push(true);
		await executeTool(harness, "propose_goal", { objective: `Audit ${scenario.name}` });
		if (scenario.name === "exception" || scenario.name === "cancelled") {
			await assert.rejects(() => executeTool(harness, "complete_goal", { summary: "Attempted completion" }));
		} else {
			await executeTool(harness, "complete_goal", { summary: "Attempted completion" });
		}
		const auditEvents = harness.events.emitted
			.filter((event) => event.channel === GOAL_AUDIT_EVENT)
			.map((event) => event.data as { active?: boolean; goalId?: string });
		assert.deepEqual(auditEvents.map((event) => event.active), [true, false], `${scenario.name} clears the audit phase`);
		assert.equal(auditEvents[0]?.goalId, auditEvents[1]?.goalId, `${scenario.name} keeps one Goal identity across the phase`);
	}
});

test("session shutdown clears a pending audit phase", async () => {
	let releaseAudit!: (result: { approved: boolean; output: string }) => void;
	let auditStarted!: () => void;
	const started = new Promise<void>((resolve) => { auditStarted = resolve; });
	const pendingAudit = new Promise<{ approved: boolean; output: string }>((resolve) => { releaseAudit = resolve; });
	const harness = harnessWithGoal(async () => {
		auditStarted();
		return await pendingAudit;
	});
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "Clear audit on shutdown" });
	const completion = executeTool(harness, "complete_goal", { summary: "Attempted completion" });
	await started;
	await harness.run("session_shutdown", {});
	releaseAudit({ approved: false, output: "Cancelled.\\n<disapproved/>" });
	await completion;
	const auditEvents = harness.events.emitted
		.filter((event) => event.channel === GOAL_AUDIT_EVENT)
		.map((event) => event.data as { active?: boolean });
	assert.deepEqual(auditEvents.map((event) => event.active), [true, false]);
});

test("auditor rejection keeps the Goal active with actionable objections", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "Missing end-to-end evidence.\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "Deliver a verified feature" });
	const result = await executeTool(harness, "complete_goal", { summary: "Implemented the feature" });
	assert.match(result.content?.[0]?.text ?? "", /Missing end-to-end evidence/);
	const state = latestGoalState(harness.entries);
	assert.equal(state.goal?.status, "active");
	assert.match(state.goal?.lastAuditRejection?.report ?? "", /Missing end-to-end evidence/);
	const rejected = harness.events.emitted.filter((event) => event.channel === GOAL_TRANSCRIPT_EVENT && (event.data as { kind?: string }).kind === "goal_completion_rejected");
	assert.equal(rejected.length, 1);
});

test("approved audit clears an earlier rejection from completed Goal state", async () => {
	let approved = false;
	const harness = harnessWithGoal(async () => approved
		? { approved: true, output: "Evidence checked.\\n<approved/>" }
		: { approved: false, output: "Still missing evidence.\\n<disapproved/>" });
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "Deliver a verified feature" });
	await executeTool(harness, "complete_goal", { summary: "First attempt" });
	assert.match(latestGoalState(harness.entries).goal?.lastAuditRejection?.report ?? "", /Still missing evidence/);
	approved = true;
	await executeTool(harness, "complete_goal", { summary: "Second attempt" });
	const completed = latestGoalState(harness.entries).goal;
	assert.equal(completed?.status, "complete");
	assert.equal(Object.hasOwn(completed ?? {}, "lastAuditRejection"), false, "a completed Goal does not present an earlier rejection as current");
});

test("auditor approval allows final prose, blocks tools, then archives once at settlement", async () => {
	const harness = harnessWithGoal(async () => ({ approved: true, output: "Verified the actual artifacts.\n<approved/>" }));
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "Deliver a verified feature" });
	const result = await executeTool(harness, "complete_goal", { summary: "Implemented and tested" });
	assert.equal(result.terminate, undefined, "approved completion leaves one normal prose turn");
	assert.equal(latestGoalState(harness.entries).goal?.status, "complete");
	const blocked = await harness.run("tool_call", { toolName: "bash" });
	assert.match((blocked[0] as { reason: string }).reason, /write the final user-facing response/i);
	assert.equal(harness.events.emitted.some((event) => event.channel === GOAL_TRANSCRIPT_EVENT && (event.data as { kind?: string }).kind === "goal_completed"), false);

	const continuationsBeforeSettlement = harness.sent.length;
	await harness.run("agent_settled", {});
	assert.equal(latestGoalState(harness.entries).goal, null);
	harness.runIdle();
	assert.equal(harness.sent.length, continuationsBeforeSettlement, "completed Goal settles without another continuation");
	await harness.run("agent_settled", {});
	const completed = harness.events.emitted.filter((event) => event.channel === GOAL_TRANSCRIPT_EVENT && (event.data as { kind?: string }).kind === "goal_completed");
	assert.equal(completed.length, 1, "provider success or failure settles one durable completion receipt");
});

test("Goal mutations accept exact bounds and reject max+1 atomically", async () => {
	let auditCalls = 0;
	let auditResult = { approved: false, output: "not used\n<disapproved/>" };
	const harness = harnessWithGoal(async () => {
		auditCalls += 1;
		return auditResult;
	});
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "x".repeat(GOAL_OBJECTIVE_MAX_LENGTH) });
	assert.equal(latestGoalState(harness.entries).goal?.objective.length, GOAL_OBJECTIVE_MAX_LENGTH);

	async function rejectsAtomically(action: () => Promise<unknown>, pattern: RegExp, expectedAuditEvents = 0): Promise<void> {
		const beforeEntries = harness.entries.length;
		const beforeEvents = harness.events.emitted.length;
		const beforeSent = harness.sent.length;
		const beforeState = structuredClone(latestGoalState(harness.entries));
		await assert.rejects(action, pattern);
		assert.equal(harness.entries.length, beforeEntries, "rejection appends no durable state");
		assert.equal(harness.events.emitted.length, beforeEvents + expectedAuditEvents, "rejection emits only the expected transient audit lifecycle");
		assert.equal(harness.sent.length, beforeSent, "rejection queues no continuation");
		assert.deepEqual(latestGoalState(harness.entries), beforeState, "rejection leaves the current Goal exact");
	}

	await rejectsAtomically(
		() => executeTool(harness, "tweak_goal", { objective: "x".repeat(GOAL_OBJECTIVE_MAX_LENGTH + 1) }),
		/objective exceeds/i,
	);
	for (const [field, maxLength] of [
		["blocker", GOAL_BLOCKER_MAX_LENGTH],
		["evidence", GOAL_BLOCK_EVIDENCE_MAX_LENGTH],
		["whyNoAutonomousPathRemains", GOAL_BLOCK_NO_AUTONOMOUS_PATH_MAX_LENGTH],
		["unblockCondition", GOAL_UNBLOCK_CONDITION_MAX_LENGTH],
	] as const) {
		await rejectsAtomically(
			() => executeTool(harness, "set_goal_blocked", { ...blockProof("blocked"), [field]: "x".repeat(maxLength + 1) }),
			new RegExp(`${field} exceeds`, "i"),
		);
	}
	await rejectsAtomically(
		() => executeTool(harness, "complete_goal", { summary: "x".repeat(GOAL_COMPLETION_SUMMARY_MAX_LENGTH + 1) }),
		/completion summary exceeds/i,
	);
	assert.equal(auditCalls, 0, "an oversized summary never starts the auditor");

	auditResult = { approved: false, output: "x".repeat(GOAL_AUDIT_REJECTION_REPORT_MAX_LENGTH + 1) };
	await rejectsAtomically(
		() => executeTool(harness, "complete_goal", { summary: "complete" }),
		/audit rejection report exceeds/i,
		2,
	);
	auditResult = { approved: true, output: "x".repeat(GOAL_COMPLETION_AUDITOR_REPORT_MAX_LENGTH + 1) };
	await rejectsAtomically(
		() => executeTool(harness, "complete_goal", { summary: "complete" }),
		/completion auditor report exceeds/i,
		2,
	);

	await executeTool(harness, "set_goal_blocked", {
		blocker: "b".repeat(GOAL_BLOCKER_MAX_LENGTH),
		evidence: "e".repeat(GOAL_BLOCK_EVIDENCE_MAX_LENGTH),
		whyNoAutonomousPathRemains: "w".repeat(GOAL_BLOCK_NO_AUTONOMOUS_PATH_MAX_LENGTH),
		unblockCondition: "u".repeat(GOAL_UNBLOCK_CONDITION_MAX_LENGTH),
	});
	const blocked = latestGoalState(harness.entries).goal;
	assert.equal(isGoalBlockedPause(blocked?.pause), true);
	assert.ok((blocked?.pause?.reason.length ?? 0) <= 2_048, "all exact-max proof fields fit the existing pause reason bound");
	assert.equal(blocked?.pause?.suggestedAction?.length, GOAL_UNBLOCK_CONDITION_MAX_LENGTH);
});

test("an invalid newest Goal snapshot fails loud instead of resurrecting older work", async () => {
	const cwd = mkdtempSync(path.join(tmpdir(), "portable-goal-corrupt-"));
	temporaryDirectories.push(cwd);
	const valid = {
		type: "custom",
		customType: "pi-goal-state-v1",
		data: {
			schemaVersion: 1,
			revision: 1,
			goal: {
				id: "old",
				objective: "Must not be resurrected",
				status: "active",
				autoContinue: true,
				usage: { tokensUsed: 0, activeSeconds: 0 },
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		},
	};
	const harness = createHarness([valid, { type: "custom", customType: "pi-goal-state-v1", data: { schemaVersion: 1, revision: 2, goal: { broken: true } } }], cwd);
	goalExtension(harness.pi);
	await assert.rejects(() => harness.run("session_start", {}), /refusing to fall back to older Goal state/);
});

test("late consumers request the complete current Goal snapshot", async () => {
	const harness = harnessWithGoal(async () => ({ approved: false, output: "not used\n<disapproved/>" }));
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	await executeTool(harness, "propose_goal", { objective: "Keep late consumers correct" });
	const received: unknown[] = [];
	const proposals: Array<{ revision?: number }> = [];
	harness.events.on(GOAL_STATE_EVENT, (data) => received.push(structuredClone(data)));
	harness.events.on(GOAL_PROPOSAL_EVENT, (data) => proposals.push(structuredClone(data) as { revision?: number }));
	harness.events.emit(GOAL_STATE_REQUEST_EVENT, {});
	assert.equal(received.length, 1);
	const replayed = parseGoalState(received[0]);
	assert.equal(replayed?.goal?.objective, "Keep late consumers correct");
	const proposalRevision = proposals[0]?.revision ?? 0;
	assert.ok(proposalRevision >= 2, "proposal replay restores its durable monotonic event revision");
	await harness.run("session_start", { reason: "resume" });
	assert.equal(proposals.at(-1)?.revision, proposalRevision, "restart does not reset proposal revisions within the branch");
});
