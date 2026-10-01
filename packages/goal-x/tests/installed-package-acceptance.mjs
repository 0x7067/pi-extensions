import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const repository = process.cwd();
const root = mkdtempSync(path.join(tmpdir(), "portable-pi-installed-"));
const timeoutMs = Number(process.env.PI_ACCEPTANCE_TIMEOUT_MS ?? 30_000);
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
// Isolate the in-process faux-provider SDK checks as well as the RPC children.
process.env.PI_CODING_AGENT_DIR = path.join(root, "host-profile");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { encoding: "utf8", ...options });
	if (result.status !== 0) {
		throw new Error(`${command} ${args.join(" ")} failed (${result.status})\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
	}
	return result.stdout;
}

function piExecutable() {
	if (process.env.PI_ACCEPTANCE_BIN) return realpathSync(process.env.PI_ACCEPTANCE_BIN);
	for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
		try {
			return realpathSync(path.join(directory, process.platform === "win32" ? "pi.cmd" : "pi"));
		} catch {
			// Keep searching PATH.
		}
	}
	throw new Error("Could not find Pi. Set PI_ACCEPTANCE_BIN to the Pi executable under test.");
}

function findPackageRoot(start, packageName) {
	const segments = packageName.split("/");
	let current = path.resolve(start);
	for (let depth = 0; depth < 8; depth += 1) {
		const candidate = path.join(current, "node_modules", ...segments);
		if (existsSync(path.join(candidate, "package.json"))) return candidate;
		const parent = path.dirname(current);
		if (parent === current) break;
		current = parent;
	}
	throw new Error(`Could not resolve ${packageName} from ${start}`);
}

function pack(cwd, destination) {
	const output = run("npm", ["pack", "--json", "--pack-destination", destination], { cwd });
	const report = JSON.parse(output)[0];
	if (!report?.filename) throw new Error(`npm pack did not report a tarball for ${cwd}`);
	return { path: path.join(destination, report.filename), report };
}

function installAlone(tarball, profile, packageName, version, codingAgentPeer = "*", expectedPeerDependencies) {
	const installRoot = path.join(profile, "npm");
	mkdirSync(installRoot, { recursive: true });
	run("npm", ["install", "--prefix", installRoot, "--omit=dev", "--legacy-peer-deps", "--no-audit", "--no-fund", tarball]);
	const installed = path.join(installRoot, "node_modules", ...packageName.split("/"));
	const manifest = JSON.parse(readFileSync(path.join(installed, "package.json"), "utf8"));
	assert.equal(manifest.name, packageName);
	assert.equal(manifest.version, version);
	assert.deepEqual(manifest.peerDependencies, expectedPeerDependencies ?? {
		"@earendil-works/pi-ai": "*",
		"@earendil-works/pi-coding-agent": codingAgentPeer,
		"@earendil-works/pi-tui": "*",
		typebox: "*",
	});
	const scopedPackages = readdirSync(path.join(installRoot, "node_modules", "@fractaal"));
	assert.deepEqual(scopedPackages, [packageName.split("/")[1]], `${packageName} must be the only installed @fractaal package`);
	writeFileSync(path.join(profile, "settings.json"), JSON.stringify({
		packages: [`npm:${packageName}@${version}`],
		defaultProjectTrust: "never",
	}, null, 2));
	return installed;
}

function writeSession(directory, cwd, name, customType, data) {
	const sessionFile = path.join(directory, `${name}.jsonl`);
	const timestamp = new Date().toISOString();
	writeFileSync(sessionFile, [
		JSON.stringify({ type: "session", version: 3, id: randomUUID(), timestamp, cwd }),
		JSON.stringify({ type: "custom", id: randomUUID(), parentId: null, timestamp, customType, data }),
	].join("\n") + "\n");
	return sessionFile;
}

function runInstalledRpc({ label, pi, profile, workspace, sessionFile, requiredCommands, prompt, expectedNotification, installedRoot }) {
	return new Promise((resolve, reject) => {
		const child = spawn(pi, [
			"--offline",
			"--mode", "rpc",
			"--session", sessionFile,
			"--no-skills",
			"--no-prompt-templates",
			"--no-context-files",
		], {
			cwd: workspace,
			env: { ...process.env, PI_CODING_AGENT_DIR: profile },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let buffer = "";
		let stderr = "";
		const events = [];
		let finished = false;
		const watchdog = setTimeout(() => finish(`did not settle within the explicit ${timeoutMs}ms acceptance bound`), timeoutMs);

		function finish(error) {
			if (finished) return;
			finished = true;
			clearTimeout(watchdog);
			child.kill("SIGTERM");
			if (error) {
				reject(new Error(`${label}: ${error}\nstderr: ${stderr.trim() || "(empty)"}\nevents: ${JSON.stringify(events, null, 2)}`));
				return;
			}
			const commandResponse = events.find((event) => event.type === "response" && event.id === "commands");
			const commands = commandResponse?.data?.commands ?? [];
			resolve({
				label,
				commands: commands.filter((command) => requiredCommands.includes(command.name)).map((command) => command.name),
				extensionPaths: commands.filter((command) => requiredCommands.includes(command.name)).map((command) => command.path ?? command.sourceInfo?.path),
			});
		}

		function check() {
			if (events.some((event) => event.type === "extension_error")) return finish("Pi reported extension_error");
			const commandResponse = events.find((event) => event.type === "response" && event.id === "commands");
			if (!commandResponse) return;
			const commands = commandResponse.data?.commands ?? [];
			for (const required of requiredCommands) {
				const command = commands.find((candidate) => candidate.name === required);
				if (!command) return finish(`missing /${required}`);
				const commandPath = command.path ?? command.sourceInfo?.path;
				if (!String(commandPath).startsWith(installedRoot)) return finish(`/${required} loaded from source instead of isolated install: ${commandPath}`);
			}
			if (!events.some((event) => event.type === "response" && event.id === "state" && event.success)) return;
			if (!events.some((event) => event.type === "response" && event.id === "prompt" && event.success)) return;
			if (!events.some((event) => event.type === "extension_ui_request" && event.method === "notify" && String(event.message).includes(expectedNotification))) return;
			finish();
		}

		child.stdout.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			while (true) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				let line = buffer.slice(0, newline);
				buffer = buffer.slice(newline + 1);
				if (line.endsWith("\r")) line = line.slice(0, -1);
				if (!line.trim()) continue;
				try {
					events.push(JSON.parse(line));
					check();
				} catch (error) {
					finish(`non-JSON RPC stdout: ${line}\n${error}`);
				}
			}
		});
		child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
		child.on("error", (error) => finish(`could not launch Pi: ${error.message}`));
		child.on("exit", (code, signal) => { if (!finished) finish(`Pi exited early (code=${code}, signal=${signal})`); });
		child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
		child.stdin.write(`${JSON.stringify({ id: "state", type: "get_state" })}\n`);
		child.stdin.write(`${JSON.stringify({ id: "prompt", type: "prompt", message: prompt })}\n`);
	});
}

function blockArgs(blocker, unblockCondition = "The external prerequisite is satisfied.") {
	return {
		blocker,
		evidence: "The current environment was checked and the prerequisite is absent.",
		whyNoAutonomousPathRemains: "Every remaining safe, in-scope action requires that prerequisite.",
		unblockCondition,
	};
}

function latest(entries, customType) {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		if (entries[index]?.customType === customType) return entries[index].data;
	}
	throw new Error(`Missing ${customType}`);
}

async function loadHarness(loadExtensions, extensionPath, workspace, initialEntries = []) {
	const loaded = await loadExtensions([extensionPath], workspace);
	assert.deepEqual(loaded.errors, []);
	assert.equal(loaded.extensions.length, 1);
	const extension = loaded.extensions[0];
	const entries = structuredClone(initialEntries);
	const sent = [];
	const confirmations = [];
	const idleCallbacks = new Set();
	let contextUsage = { tokens: 0, contextWindow: 872_000, percent: 0 };
	const onIdle = (callback) => {
		const unsubscribe = () => idleCallbacks.delete(callback);
		if (idleCallbacks.has(callback)) return unsubscribe;
		idleCallbacks.add(callback);
		return unsubscribe;
	};
	const flushIdle = () => {
		const callbacks = [...idleCallbacks];
		idleCallbacks.clear();
		for (const callback of callbacks) callback();
	};
	const runtime = loaded.runtime;
	Object.assign(runtime, {
		appendEntry: (customType, data) => entries.push({ type: "custom", customType, data: structuredClone(data) }),
		sendMessage: (message, options) => sent.push({ message: structuredClone(message), options: structuredClone(options) }),
		sendUserMessage: () => {},
		setSessionName: () => {},
		getSessionName: () => undefined,
		setLabel: () => {},
		getActiveTools: () => [...extension.tools.keys()],
		getAllTools: () => [],
		setActiveTools: () => {},
		getCommands: () => [],
		setModel: async () => true,
		getThinkingLevel: () => "medium",
		setThinkingLevel: () => {},
	});
	const ctx = {
		cwd: workspace,
		hasUI: true,
		mode: "tui",
		model: { provider: "fixture", id: "fixture" },
		thinkingLevel: "medium",
		sessionManager: { getBranch: () => entries, getSessionId: () => "installed-acceptance" },
		ui: {
			confirm: async () => confirmations.shift() ?? false,
			select: async () => undefined,
			notify: () => {},
			setWidget: () => {},
			setEditorText: () => {},
		},
		abort: () => {},
		onIdle,
		getContextUsage: () => contextUsage,
		modelRegistry: { getAvailable: () => [] },
	};
	return {
		entries,
		sent,
		confirmations,
		setContextUsage(tokens, contextWindow = contextUsage.contextWindow) {
			contextUsage = { tokens, contextWindow, percent: tokens === null ? null : tokens / contextWindow * 100 };
		},
		async run(event, payload = {}) {
			const results = [];
			for (const handler of extension.handlers.get(event) ?? []) results.push(await handler(payload, ctx));
			return results;
		},
		async tool(name, params) {
			const tool = extension.tools.get(name)?.definition;
			if (!tool) throw new Error(`Installed extension did not register ${name}`);
			return tool.execute(`${name}-installed`, params, new AbortController().signal, undefined, ctx);
		},
		flushIdle,
		dispose() { runtime.invalidate("installed acceptance complete"); },
	};
}

async function exerciseInstalledGoal(loadExtensions, profile, workspace) {
	const driver = path.join(profile, "npm", "goal-acceptance-driver.ts");
	writeFileSync(driver, [
		'import goalExtension from "@fractaal/pi-goal-x";',
		'import { GOAL_AUDIT_REJECTION_REPORT_MAX_LENGTH, GOAL_BLOCKER_MAX_LENGTH, GOAL_BLOCK_EVIDENCE_MAX_LENGTH, GOAL_BLOCK_EVIDENCE_SEPARATOR, GOAL_BLOCK_NO_AUTONOMOUS_PATH_MAX_LENGTH, GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR, GOAL_COMPLETION_AUDITOR_REPORT_MAX_LENGTH, GOAL_COMPLETION_SUMMARY_MAX_LENGTH, GOAL_ID_MAX_LENGTH, GOAL_OBJECTIVE_MAX_LENGTH, GOAL_PAUSE_REASON_MAX_LENGTH, GOAL_PAUSE_SUGGESTED_ACTION_MAX_LENGTH, GOAL_TIMESTAMP_MAX_LENGTH, GOAL_UNBLOCK_CONDITION_MAX_LENGTH, goalBlockedPause, isGoalBlockedPause, parseGoalBlockedPause } from "@fractaal/pi-goal-x/contracts";',
		'import { createGoalTranscriptEvent, isGoalTranscriptEvent } from "@fractaal/pi-goal-x/transcript-events";',
		'if (JSON.stringify([GOAL_ID_MAX_LENGTH, GOAL_OBJECTIVE_MAX_LENGTH, GOAL_TIMESTAMP_MAX_LENGTH, GOAL_PAUSE_REASON_MAX_LENGTH, GOAL_PAUSE_SUGGESTED_ACTION_MAX_LENGTH, GOAL_BLOCKER_MAX_LENGTH, GOAL_BLOCK_EVIDENCE_MAX_LENGTH, GOAL_BLOCK_NO_AUTONOMOUS_PATH_MAX_LENGTH, GOAL_UNBLOCK_CONDITION_MAX_LENGTH, GOAL_AUDIT_REJECTION_REPORT_MAX_LENGTH, GOAL_COMPLETION_SUMMARY_MAX_LENGTH, GOAL_COMPLETION_AUDITOR_REPORT_MAX_LENGTH]) !== JSON.stringify([256, 131072, 64, 2048, 2048, 600, 600, 600, 2000, 12000, 4000, 12000])) throw new Error("Goal package contract bounds are unavailable.");',
		'const validPause = goalBlockedPause({ blocker: "b", evidence: "e", whyNoAutonomousPathRemains: "w", unblockCondition: "u" });',
		'if (!isGoalBlockedPause(validPause) || JSON.stringify(parseGoalBlockedPause(validPause)) !== JSON.stringify(validPause)) throw new Error("Goal blocked-state parser does not preserve exact canonical bytes.");',
		'const markerTokens = [',
		'  "plain",',
		'  `left${GOAL_BLOCK_EVIDENCE_SEPARATOR}right`,',
		'  `left${GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR}right`,',
		'  `left${GOAL_BLOCK_EVIDENCE_SEPARATOR}middle${GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR}right`,',
		'  `left${GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR}middle${GOAL_BLOCK_EVIDENCE_SEPARATOR}right`,',
		'  `left${GOAL_BLOCK_EVIDENCE_SEPARATOR}a${GOAL_BLOCK_EVIDENCE_SEPARATOR}right`,',
		'  `left${GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR}a${GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR}right`,',
		'];',
		'let canonicalCases = 0;',
		'for (const blocker of markerTokens) for (const evidence of markerTokens) for (const whyNoAutonomousPathRemains of markerTokens) {',
		'  const markerPause = goalBlockedPause({ blocker, evidence, whyNoAutonomousPathRemains, unblockCondition: "resume" });',
		'  if (JSON.stringify(parseGoalBlockedPause(markerPause)) !== JSON.stringify(markerPause)) throw new Error("Marker-placement matrix changed canonical pause bytes.");',
		'  canonicalCases += 1;',
		'}',
		'if (canonicalCases !== 343) throw new Error(`Expected 343 canonical marker cases, received ${canonicalCases}.`);',
		'const malformedPauses = [',
		'  { reason: "Blocker: \\nEvidence: \\nWhy no autonomous path remains: ", suggestedAction: "resume" },',
		'  { reason: "Blocker: blocker\\nWhy no autonomous path remains: why\\nEvidence: evidence", suggestedAction: "resume" },',
		'  { reason: "Blocker: blocker\\nEvidence: evidence", suggestedAction: "resume" },',
		'];',
		'if (!isGoalTranscriptEvent(createGoalTranscriptEvent({ kind: "goal_blocked", level: "warning", reason: validPause.reason, suggestedAction: validPause.suggestedAction, message: "Valid blocked receipt.", tuiMessage: "Goal blocked" }))) throw new Error("Valid blocked receipt was rejected.");',
		'for (const malformedPause of malformedPauses) {',
		'  if (isGoalBlockedPause(malformedPause) || parseGoalBlockedPause(malformedPause)) throw new Error("Malformed legacy pause was classified as blocked.");',
		'  if (isGoalTranscriptEvent({ version: 1, kind: "goal_blocked", emittedAt: new Date().toISOString(), level: "warning", reason: malformedPause.reason, suggestedAction: malformedPause.suggestedAction, message: "Malformed blocked receipt.", tuiMessage: "Goal blocked" })) throw new Error("Malformed blocked receipt was accepted.");',
		'}',
		"export default function (pi) {",
		"  goalExtension(pi, { runCompletionAuditor: async ({ completionSummary }) => completionSummary === 'approve'",
		"    ? ({ approved: true, output: 'Installed artifacts verified.\\n<approved/>' })",
		"    : ({ approved: false, output: 'Installed acceptance rejection.\\n<disapproved/>' }) });",
		"}",
	].join("\n"));
	const legacyHarness = await loadHarness(loadExtensions, driver, workspace, [{
		type: "custom",
		customType: "pi-goal-state-v1",
		data: {
			schemaVersion: 1,
			revision: 1,
			goal: {
				id: "legacy-malformed-pause",
				objective: "Preserve the historical human pause",
				status: "paused",
				autoContinue: false,
				usage: { tokensUsed: 0, activeSeconds: 0 },
				createdAt: "2026-08-28T00:00:00.000Z",
				updatedAt: "2026-08-28T00:00:00.000Z",
				pause: {
					reason: "Blocker: \nEvidence: \nWhy no autonomous path remains: ",
					suggestedAction: "Resume after the decision.",
				},
			},
		},
	}]);
	await legacyHarness.run("session_start", { reason: "startup" });
	const legacyPrompt = await legacyHarness.run("before_agent_start", { initiator: "user", prompt: "Status", systemPrompt: "INSTALLED BASE PROMPT", systemPromptOptions: {} });
	assert.match(legacyPrompt[0].systemPrompt, /\[PI GOAL PAUSED\][\s\S]*The Goal is paused by the user/);
	assert.doesNotMatch(legacyPrompt[0].systemPrompt, /\[PI GOAL BLOCKED\]/);
	await assert.rejects(() => legacyHarness.tool("set_goal_blocked", blockArgs("Malformed historical pause must stay human-owned.")), /The Goal is paused, not active\./);
	await legacyHarness.tool("resume_goal", {});
	assert.equal(latest(legacyHarness.entries, "pi-goal-state-v1").goal.status, "active");
	assert.equal(Object.hasOwn(latest(legacyHarness.entries, "pi-goal-state-v1").goal, "pause"), false);
	legacyHarness.flushIdle();
	assert.equal(legacyHarness.sent.length, 1, "packed legacy pause resumes with one continuation");
	legacyHarness.dispose();

	const harness = await loadHarness(loadExtensions, driver, workspace);
	await harness.run("session_start", { reason: "startup" });
	harness.confirmations.push(true);
	await harness.tool("propose_goal", { objective: "Exercise the packed Goal lifecycle" });
	assert.equal(latest(harness.entries, "pi-goal-state-v1").goal.status, "active");
	assert.equal(harness.sent.length, 0, "packed Goal waits for Pi's idle boundary");
	harness.flushIdle();
	assert.equal(harness.sent.length, 1);
	const { content: continuationText, ...continuation } = harness.sent[0].message;
	assert.deepEqual({ message: continuation, options: harness.sent[0].options }, {
		message: { customType: "pi-goal-continuation-v1", display: false },
		options: { deliverAs: "followUp", triggerTurn: true },
	}, "packed Goal queues the generic continuation as a hidden follow-up");
	assert.match(continuationText, /^<system_message source="goal_extension">[\s\S]*not a message from the user[\s\S]*Continue the Goal\.\n<\/system_message>$/, "packed continuation identifies itself as an automatic Goal reprompt");
	assert.doesNotMatch(continuationText, /Exercise the packed Goal lifecycle/, "continuation carries no Goal identity");
	await harness.tool("set_goal_blocked", blockArgs("Acceptance prerequisite is absent."));
	const blockedState = latest(harness.entries, "pi-goal-state-v1").goal;
	assert.equal(blockedState.status, "paused");
	assert.match(blockedState.pause.reason, /Blocker:[\s\S]*Evidence:[\s\S]*Why no autonomous path remains:/);
	assert.equal(harness.entries.filter((entry) => entry.customType === "pi-goal-receipt-v1" && entry.data.kind === "goal_blocked").length, 1);
	await harness.tool("resume_goal", {});
	assert.equal(latest(harness.entries, "pi-goal-state-v1").goal.status, "active");
	assert.equal(harness.sent.length, 1, "resume waits for Pi's idle boundary");
	harness.flushIdle();
	assert.deepEqual(harness.sent[1], harness.sent[0], "resume reuses the same generic continuation");
	const promptEvent = { initiator: "custom_message", prompt: "Continue the Goal.", systemPrompt: "INSTALLED BASE PROMPT", systemPromptOptions: {} };
	const promptResult = await harness.run("before_agent_start", promptEvent);
	assert.match(promptResult[0].systemPrompt, /^INSTALLED BASE PROMPT\n\n\[PI GOAL ACTIVE\]/);
	assert.match(promptResult[0].systemPrompt, /Exercise the packed Goal lifecycle/);
	assert.match(promptResult[0].systemPrompt, /"Continue the Goal\." messages are automatic reprompts from the Goal extension, not from the user/);
	assert.doesNotMatch(promptResult[0].systemPrompt, /revision=|goalId=|tokensUsed|activeSeconds/);
	assert.equal((await harness.run("context", { messages: [] })).length, 0, "packed Goal registers no per-provider context transform");
	await harness.run("agent_end", { messages: [{ role: "assistant", stopReason: "stop", content: [] }] });
	harness.flushIdle();
	assert.equal(harness.sent.length, 3, "normal no-tool settlement queues one next continuation");
	await harness.run("before_agent_start", promptEvent);
	await harness.run("agent_end", { messages: [{ role: "assistant", stopReason: "error", content: [] }] });
	harness.flushIdle();
	assert.equal(harness.sent.length, 3, "terminal provider error queues no Goal-owned retry");
	await harness.tool("complete_goal", { summary: "reject" });
	assert.match(latest(harness.entries, "pi-goal-state-v1").goal.lastAuditRejection.report, /Installed acceptance rejection/);
	await harness.tool("complete_goal", { summary: "approve" });
	assert.equal(latest(harness.entries, "pi-goal-state-v1").goal.status, "complete");
	const blocked = await harness.run("tool_call", { toolName: "bash" });
	assert.match(blocked[0].reason, /final user-facing response/);
	await harness.run("agent_settled", {});
	assert.equal(latest(harness.entries, "pi-goal-state-v1").goal, null);
	assert.equal(harness.entries.filter((entry) => entry.customType === "pi-goal-receipt-v1" && entry.data.kind === "goal_completed").length, 1);
	harness.dispose();
	return { contractBounds: "Protocol 6 subset loaded", markerMatrix: "343 exact canonical pause-byte cases", proposal: "accepted", continuationMessages: harness.sent.length, audit: "rejected then approved", settlement: "archived" };
}

function appendPausedGoal(sessionManager, id, objective, reason) {
	sessionManager.appendCustomEntry("pi-goal-state-v1", {
		schemaVersion: 1,
		revision: 1,
		goal: {
			id,
			objective,
			status: "paused",
			autoContinue: false,
			usage: { tokensUsed: 0, activeSeconds: 0 },
			createdAt: "2026-08-15T00:00:00.000Z",
			updatedAt: "2026-08-15T00:00:00.000Z",
			pause: { reason },
		},
	});
}

async function exerciseRealAgentSessionContinuation(piSdk, piAi, profile, workspace) {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = piSdk;
	const { fauxAssistantMessage, fauxProvider, fauxToolCall } = piAi;
	const results = {};

	for (const lifecycle of ["pause", "abandon", "complete"]) {
		const driver = path.join(profile, "npm", `goal-real-session-${lifecycle}.ts`);
		writeFileSync(driver, [
			'import goalExtension from "@fractaal/pi-goal-x";',
			"export default function (pi) {",
			"  goalExtension(pi, { runCompletionAuditor: async () => ({ approved: true, output: 'Real AgentSession evidence verified.\\n<approved/>' }) });",
			"}",
		].join("\n"));
		const sessionManager = SessionManager.inMemory(workspace);
		appendPausedGoal(sessionManager, `real-session-${lifecycle}`, `Do not run a queued wake after ${lifecycle}`, "Seed the real-session regression");
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		let session;
		let lifecycleApplied = false;
		const resourceLoader = new DefaultResourceLoader({
			cwd: workspace,
			agentDir: profile,
			settingsManager,
			additionalExtensionPaths: [driver],
			extensionFactories: [(pi) => {
				pi.on("tool_execution_end", async (event) => {
					if (lifecycle === "complete") {
						if (event.toolName === "complete_goal") lifecycleApplied = true;
						return;
					}
					if (event.toolName !== "resume_goal" || lifecycleApplied) return;
					lifecycleApplied = true;
					if (lifecycle === "pause") await session.prompt("/goal-pause Stop before queued continuation");
					else await session.prompt("/goal-abandon Stop before queued continuation");
				});
			}],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Exercise one deterministic Goal lifecycle transition.",
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);

		const faux = fauxProvider({ provider: `goal-real-session-${lifecycle}` });
		const finalProse = "FINAL_GOAL_PROSE";
		faux.setResponses(lifecycle === "complete" ? [
			fauxAssistantMessage(fauxToolCall("resume_goal", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("complete_goal", { summary: "Verified" }), { stopReason: "toolUse" }),
			fauxAssistantMessage(finalProse, { stopReason: "stop" }),
			fauxAssistantMessage("A duplicate Goal wake reached the provider.", { stopReason: "stop" }),
		] : [
			fauxAssistantMessage(fauxToolCall("resume_goal", {}), { stopReason: "toolUse" }),
			fauxAssistantMessage("A stale Goal continuation reached the provider.", { stopReason: "stop" }),
		]);
		const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null });
		modelRuntime.registerNativeProvider(faux.provider);
		({ session } = await createAgentSession({
			cwd: workspace,
			model: faux.getModel(),
			thinkingLevel: "off",
			modelRuntime,
			resourceLoader,
			sessionManager,
			settingsManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
			tools: ["resume_goal", "complete_goal"],
		}));
		await session.bindExtensions({ mode: "rpc" });
		try {
			await session.prompt(`Run the ${lifecycle} continuation regression.`);
			await waitForIdleCallbacks(session);
			assert.equal(lifecycleApplied, true, `${lifecycle} lifecycle mutation ran in the real Agent flow`);
			const entries = sessionManager.getEntries();
			const settledGoal = latest(entries, "pi-goal-state-v1").goal;
			if (lifecycle === "pause") assert.equal(settledGoal?.status, "paused");
			else assert.equal(settledGoal, null, `${lifecycle} removes the settled Goal`);
			const expectedCalls = lifecycle === "complete" ? 3 : 1;
			assert.equal(faux.state.callCount, expectedCalls, `${lifecycle} reaches exactly the intended provider turns`);
			if (lifecycle === "complete") {
				assert.equal(entries.filter((entry) => entry.customType === "pi-goal-receipt-v1" && entry.data.kind === "goal_completed").length, 1);
				assert.equal(entries.filter((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "text" && block.text === finalProse)).length, 1, "completion emits exactly one final-prose response");
				assert.equal(faux.getPendingResponseCount(), 1, "no duplicate Goal wake consumes the sentinel response");
			}
			results[lifecycle] = { providerCalls: faux.state.callCount };
		} finally {
			session.dispose();
		}
	}
	return results;
}

async function exerciseTerminalContinuationCancellation(piSdk, piAi, profile, workspace) {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = piSdk;
	const { fauxAssistantMessage, fauxProvider } = piAi;
	const results = {};

	for (const stopReason of ["error", "aborted"]) {
		const driver = path.join(profile, "npm", `goal-terminal-cancellation-${stopReason}.ts`);
		writeFileSync(driver, [
			'import goalExtension from "@fractaal/pi-goal-x";',
			"export default function (pi) {",
			"  goalExtension(pi);",
			"}",
		].join("\n"));
		const sessionManager = SessionManager.inMemory(workspace);
		appendPausedGoal(sessionManager, `terminal-cancellation-${stopReason}`, `Do not wake after terminal ${stopReason}`, "Seed terminal continuation regression");
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: workspace,
			agentDir: profile,
			settingsManager,
			additionalExtensionPaths: [driver],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Exercise terminal continuation cancellation.",
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);

		let session;
		const faux = fauxProvider({ provider: `goal-terminal-cancellation-${stopReason}` });
		const forbiddenWake = `FORBIDDEN_${stopReason}_GOAL_WAKE`;
		faux.setResponses([
			async () => {
				await session.prompt("/goal-resume");
				return fauxAssistantMessage("", { stopReason, errorMessage: `Terminal ${stopReason} regression` });
			},
			fauxAssistantMessage(forbiddenWake, { stopReason: "error" }),
		]);
		const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null });
		modelRuntime.registerNativeProvider(faux.provider);
		({ session } = await createAgentSession({
			cwd: workspace,
			model: faux.getModel(),
			thinkingLevel: "off",
			modelRuntime,
			resourceLoader,
			sessionManager,
			settingsManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
			tools: ["resume_goal"],
		}));
		try {
			await session.bindExtensions({ mode: "rpc" });
			await session.prompt(`Run terminal ${stopReason} continuation cancellation regression.`);
			await waitForIdleCallbacks(session);
			const entries = sessionManager.getEntries();
			assert.equal(faux.state.callCount, 1, `${stopReason} terminal run does not consume a hidden Goal wake`);
			assert.equal(faux.getPendingResponseCount(), 1, `${stopReason} leaves the forbidden wake sentinel untouched`);
			assert.equal(entries.some((entry) => entry.type === "message" && entry.message.role === "assistant" && entry.message.content.some((block) => block.type === "text" && block.text === forbiddenWake)), false, `${stopReason} does not expose the forbidden wake response`);
			results[stopReason] = { providerCalls: faux.state.callCount, pendingSentinel: faux.getPendingResponseCount() };
		} finally {
			session.dispose();
		}
	}
	return results;
}

function deferredGate() {
	let open;
	const promise = new Promise((resolve) => { open = resolve; });
	return { promise, open };
}

async function waitForIdleCallbacks(session) {
	await session.waitForIdle();
	await new Promise((resolve) => setImmediate(resolve));
	await session.waitForIdle();
}

async function exerciseManualCompactionContinuation(piSdk, piAi, profile, workspace) {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = piSdk;
	const { fauxAssistantMessage, fauxProvider, fauxToolCall } = piAi;
	const results = {};

	for (const scenario of ["pending-resume-pause", "active-resume"]) {
		const driver = path.join(profile, "npm", `goal-real-compaction-${scenario}.ts`);
		writeFileSync(driver, [
			'import goalExtension from "@fractaal/pi-goal-x";',
			"export default function (pi) {",
			"  goalExtension(pi);",
			"}",
		].join("\n"));
		const sessionManager = SessionManager.inMemory(workspace);
		sessionManager.appendMessage({ role: "user", content: [{ type: "text", text: "Historic compaction input." }], timestamp: Date.now() - 2 });
		sessionManager.appendMessage(fauxAssistantMessage("Historic compaction response.", { stopReason: "stop", timestamp: Date.now() - 1 }));
		appendPausedGoal(sessionManager, `real-compaction-${scenario}`, "Do not lose or stale a Goal continuation across manual compaction", "Seed manual-compaction regression");
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true, keepRecentTokens: 1 }, retry: { enabled: false } });
		const settlementGate = scenario === "pending-resume-pause" ? { entered: deferredGate(), release: deferredGate() } : null;
		const compactionGate = scenario === "active-resume" ? { entered: deferredGate(), release: deferredGate() } : null;
		let settlementBlocked = false;
		const resourceLoader = new DefaultResourceLoader({
			cwd: workspace,
			agentDir: profile,
			settingsManager,
			additionalExtensionPaths: [driver],
			extensionFactories: [(pi) => {
				pi.on("agent_settled", async () => {
					if (!settlementGate || settlementBlocked) return;
					settlementBlocked = true;
					settlementGate.entered.open();
					await settlementGate.release.promise;
				});
				pi.on("session_before_compact", async (event) => {
					if (compactionGate) {
						compactionGate.entered.open();
						await compactionGate.release.promise;
					}
					return { compaction: { summary: "Deterministic manual compaction.", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore } };
				});
			}],
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			systemPrompt: "Exercise deterministic manual-compaction Goal continuation behavior.",
		});
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);

		const faux = fauxProvider({ provider: `goal-real-compaction-${scenario}` });
		faux.setResponses(scenario === "pending-resume-pause" ? [
			fauxAssistantMessage("Reach the pending compaction window.", { stopReason: "stop" }),
			fauxAssistantMessage("A stale compaction wake reached the provider.", { stopReason: "stop" }),
		] : [
			async (_context, options) => {
				await new Promise((resolve) => {
					if (options?.signal?.aborted) resolve();
					else options?.signal?.addEventListener("abort", resolve, { once: true });
				});
				return fauxAssistantMessage("Interrupted by manual compaction.", { stopReason: "stop" });
			},
			fauxAssistantMessage(fauxToolCall("set_goal_blocked", blockArgs("Continuation reached the post-compaction verification boundary.")), { stopReason: "toolUse" }),
			fauxAssistantMessage("A duplicate post-compaction wake reached the provider.", { stopReason: "stop" }),
		]);
		const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null });
		modelRuntime.registerNativeProvider(faux.provider);
		const { session } = await createAgentSession({
			cwd: workspace,
			model: faux.getModel(),
			thinkingLevel: "off",
			modelRuntime,
			resourceLoader,
			sessionManager,
			settingsManager,
			sessionStartEvent: { type: "session_start", reason: "startup" },
			tools: ["set_goal_blocked"],
		});
		await session.bindExtensions({ mode: "rpc" });
		try {
			if (scenario === "pending-resume-pause") {
				const prompt = session.prompt("Open the manual-compaction pending window.");
				await settlementGate.entered.promise;
				const compaction = session.compact();
				assert.equal(session.isIdle, false, "manual compaction pending counts as busy before its active barrier");
				assert.equal(session.isCompactionIngressBlocked, true, "manual compaction already blocks ingress");
				await session.prompt("/goal-resume");
				await session.prompt("/goal-pause Pause before compaction releases ingress");
				settlementGate.release.open();
				await prompt;
				await compaction;
				await waitForIdleCallbacks(session);
				assert.equal(faux.state.callCount, 1, "resume then pause during pending compaction adds no stale provider call");
				assert.equal(faux.getPendingResponseCount(), 1);
			} else {
				const agentStarted = deferredGate();
				const unsubscribe = session.subscribe((event) => { if (event.type === "agent_start") agentStarted.open(); });
				const prompt = session.prompt("Begin an agent run that manual compaction interrupts.");
				await agentStarted.promise;
				const compaction = session.compact();
				await compactionGate.entered.promise;
				await session.prompt("/goal-resume");
				compactionGate.release.open();
				await prompt;
				await compaction;
				await waitForIdleCallbacks(session);
				unsubscribe();
				assert.equal(faux.state.callCount, 2, "an active Goal resumes once after compaction settlement");
				assert.equal(latest(sessionManager.getEntries(), "pi-goal-state-v1").goal?.status, "paused");
				assert.equal(faux.getPendingResponseCount(), 1);
			}
			results[scenario] = { providerCalls: faux.state.callCount };
		} finally {
			settlementGate?.release.open();
			compactionGate?.release.open();
			session.dispose();
		}
	}
	return results;
}

async function exerciseInstalledTodo(loadExtensions, clearExtensionCache, profile, workspace) {
	const driver = path.join(profile, "npm", "todo-acceptance-driver.ts");
	writeFileSync(driver, [
		'import todoExtension from "@fractaal/pi-todo";',
		'import { TODO_MAX_TASKS, TODO_PLAN_MAX_BYTES, TODO_SCHEMA_VERSION, TODO_TASK_DESCRIPTION_MAX_LENGTH, TODO_TASK_KEY_MAX_LENGTH, TODO_TASK_MAX_DEPENDENCIES, TODO_TASK_SUBJECT_MAX_LENGTH, parseTodoState } from "@fractaal/pi-todo/contracts";',
		'if (typeof todoExtension !== "function") throw new Error("Todo package default export is not an extension factory.");',
		'if (TODO_SCHEMA_VERSION !== 1 || !parseTodoState({ schemaVersion: 1, revision: 0, tasks: [] })) throw new Error("Todo package contracts export is unavailable.");',
		'if (JSON.stringify([TODO_MAX_TASKS, TODO_TASK_KEY_MAX_LENGTH, TODO_TASK_SUBJECT_MAX_LENGTH, TODO_TASK_DESCRIPTION_MAX_LENGTH, TODO_TASK_MAX_DEPENDENCIES, TODO_PLAN_MAX_BYTES]) !== JSON.stringify([200, 256, 2048, 16384, 100, 16384])) throw new Error("Todo package contract bounds are unavailable.");',
		"export default todoExtension;",
	].join("\n"));
	const first = await loadHarness(loadExtensions, driver, workspace);
	await first.run("session_start", { reason: "startup" });
	await first.tool("todo", { baseRevision: 0, tasks: [{ key: "install", subject: "Verify packed Todo", status: "in_progress" }] });
	const persisted = structuredClone(first.entries);
	assert.equal(latest(persisted, "pi-todo-state-v1").revision, 1);
	first.dispose();
	clearExtensionCache();
	const reloaded = await loadHarness(loadExtensions, driver, workspace, persisted);
	await reloaded.run("session_start", { reason: "resume" });
	assert.equal(latest(reloaded.entries, "pi-todo-state-v1").tasks[0].subject, "Verify packed Todo");
	const beforeRead = reloaded.entries.length;
	const read = await reloaded.tool("get_todo", {});
	assert.match(read.content[0].text, /Revision: 1/);
	assert.match(read.content[0].text, /install: Verify packed Todo/);
	assert.equal(reloaded.entries.length, beforeRead, "packed get_todo is read-only");
	await reloaded.tool("todo", { baseRevision: 1, tasks: [{ key: "install", subject: "Verify packed Todo", status: "completed" }] });
	assert.equal(latest(reloaded.entries, "pi-todo-state-v1").revision, 2);
	const context = await reloaded.run("context", { messages: [] });
	assert.deepEqual(context, [], "packed Todo registers no per-provider context transform");
	reloaded.dispose();
	return { contractBounds: "Protocol 6 subset loaded", packageImports: "default factory and contracts loaded", mutationRevision: 2, reload: "restored", completedReminder: "absent" };
}

async function exerciseRealAgentSessionTodoIdempotence(piSdk, piAi, profile, workspace) {
	const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = piSdk;
	const { fauxAssistantMessage, fauxProvider, fauxToolCall } = piAi;
	const driver = path.join(profile, "npm", "todo-real-session-driver.ts");
	writeFileSync(driver, [
		'import todoExtension from "@fractaal/pi-todo";',
		"export default todoExtension;",
	].join("\n"));

	const sessionManager = SessionManager.inMemory(workspace);
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd: workspace,
		agentDir: profile,
		settingsManager,
		additionalExtensionPaths: [driver],
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		systemPrompt: "Repeat the exact Todo replacement once, then stop.",
	});
	await resourceLoader.reload();
	assert.deepEqual(resourceLoader.getExtensions().errors, []);

	const faux = fauxProvider({ provider: "todo-real-session-idempotence" });
	const tasks = [{ key: "repeat", subject: "Verify unchanged Todo", status: "in_progress" }];
	faux.setResponses([
		fauxAssistantMessage(fauxToolCall("todo", { baseRevision: 0, tasks }), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("get_todo", {}), { stopReason: "toolUse" }),
		fauxAssistantMessage(fauxToolCall("todo", { baseRevision: 1, tasks }), { stopReason: "toolUse" }),
		fauxAssistantMessage("TODO_IDEMPOTENT_DONE", { stopReason: "stop" }),
	]);
	const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null });
	modelRuntime.registerNativeProvider(faux.provider);
	const { session } = await createAgentSession({
		cwd: workspace,
		model: faux.getModel(),
		thinkingLevel: "off",
		modelRuntime,
		resourceLoader,
		sessionManager,
		settingsManager,
		tools: ["todo", "get_todo"],
	});
	await session.bindExtensions({ mode: "rpc" });
	try {
		await session.prompt("Create the Todo plan, repeat the identical normalized replacement once, then finish.");
		const entries = sessionManager.getEntries();
		const todoStates = entries.filter((entry) => entry.customType === "pi-todo-state-v1");
		assert.equal(todoStates.length, 1, "the identical second Todo call appends no state entry");
		assert.equal(latest(entries, "pi-todo-state-v1").revision, 1, "the identical second Todo call keeps revision 1");
		const serialized = JSON.stringify(entries);
		assert.match(serialized, /Todo plan unchanged at revision 1\./, "the repeated call returns the factual acknowledgement");
		assert.doesNotMatch(serialized, /Use the todo tool with the current baseRevision/, "the repeated call adds no CTA");
		assert.match(serialized, /Your todo list, as you authored:/, "the read-only tool durably exposes the exact plan");
		assert.equal(faux.state.callCount, 4, "the real path reaches one update, one read, one no-op, and one final response");
		assert.equal(faux.getPendingResponseCount(), 0, "the real AgentSession consumes no repeated Todo response");
		return { providerCalls: faux.state.callCount, stateEntries: todoStates.length, unchangedRevision: 1, finalText: "TODO_IDEMPOTENT_DONE" };
	} finally {
		session.dispose();
	}
}

async function exerciseRealContextWindowLifecycleAndCompaction(piSdk, piAi, profile, workspace, installedRoot) {
	const {
		ModelRuntime,
		SessionManager,
		SettingsManager,
		createAgentSessionFromServices,
		createAgentSessionRuntime,
		createAgentSessionServices,
	} = piSdk;
	const { fauxAssistantMessage, registerFauxProvider } = piAi;
	const contextExtension = (await import(pathToFileURL(path.join(installedRoot, "dist", "context-window.js")))).default;
	writeFileSync(path.join(profile, "models.json"), "{}\n");

	async function createRuntime({ faux, settingsManager, sessionManager, sessionStartEvent, scenarioProfile }) {
		const createRuntime = async ({ cwd, sessionManager: nextSessionManager, sessionStartEvent: nextStartEvent }) => {
			const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, modelsPath: null });
			const services = await createAgentSessionServices({
				cwd,
				agentDir: scenarioProfile,
				settingsManager,
				modelRuntime,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi) => pi.registerProvider(faux.getModel().provider, {
							baseUrl: faux.getModel().baseUrl,
							apiKey: "faux-key",
							api: faux.api,
							models: faux.models.map((model) => ({
								id: model.id,
								name: model.name,
								api: model.api,
								reasoning: model.reasoning,
								input: model.input,
								cost: model.cost,
								contextWindow: model.contextWindow,
								maxTokens: model.maxTokens,
								baseUrl: model.baseUrl,
							})),
						}),
						contextExtension,
					],
					noExtensions: true,
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
					noContextFiles: true,
				},
			});
			assert.deepEqual(services.diagnostics, []);
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager: nextSessionManager,
					sessionStartEvent: nextStartEvent,
					model: faux.getModel(),
					thinkingLevel: "off",
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: workspace,
			agentDir: scenarioProfile,
			sessionManager,
			sessionStartEvent,
		});
		await runtime.session.bindExtensions({ mode: "rpc" });
		return runtime;
	}

	const lifecycleProfile = path.join(profile, "lifecycle");
	const lifecycleSessions = path.join(lifecycleProfile, "sessions");
	mkdirSync(lifecycleSessions, { recursive: true });
	writeFileSync(path.join(lifecycleProfile, "models.json"), "{}\n");
	const lifecycleFaux = registerFauxProvider({
		provider: "context-window-lifecycle",
		models: [{ id: "lifecycle", contextWindow: 200_000, maxTokens: 8_192 }],
	});
	lifecycleFaux.setResponses([fauxAssistantMessage("persisted lifecycle source", { stopReason: "stop" })]);
	const lifecycleSettings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	let runtime = await createRuntime({
		faux: lifecycleFaux,
		settingsManager: lifecycleSettings,
		sessionManager: SessionManager.create(workspace, lifecycleSessions),
		scenarioProfile: lifecycleProfile,
	});
	try {
		await runtime.session.prompt("create the persisted lifecycle source");
		await runtime.session.prompt("/context-window 128k");
		const branch128 = latest(runtime.session.sessionManager.getEntries(), "pi-context-window-state-v1");
		const branch128Entry = runtime.session.sessionManager.getEntries().find((entry) => entry.customType === "pi-context-window-state-v1" && entry.data.revision === branch128.revision);
		assert.equal(runtime.session.model?.contextWindow, 128_000);

		await runtime.session.prompt("/context-window 64k");
		const branch64 = latest(runtime.session.sessionManager.getEntries(), "pi-context-window-state-v1");
		const branch64Entry = runtime.session.sessionManager.getEntries().find((entry) => entry.customType === "pi-context-window-state-v1" && entry.data.revision === branch64.revision);
		assert.ok(branch128Entry?.id && branch64Entry?.id);
		assert.equal(runtime.session.model?.contextWindow, 64_000);

		await runtime.session.navigateTree(branch128Entry.id);
		assert.equal(latest(runtime.session.sessionManager.getBranch(), "pi-context-window-state-v1").sessionOverride, 128_000);
		assert.equal(runtime.session.model?.contextWindow, 128_000);
		await runtime.session.navigateTree(branch64Entry.id);
		assert.equal(latest(runtime.session.sessionManager.getBranch(), "pi-context-window-state-v1").sessionOverride, 64_000);
		assert.equal(runtime.session.model?.contextWindow, 64_000);

		const restartPath = runtime.session.sessionFile;
		assert.ok(restartPath);
		await runtime.dispose();
		runtime = await createRuntime({
			faux: lifecycleFaux,
			settingsManager: lifecycleSettings,
			sessionManager: SessionManager.open(restartPath, lifecycleSessions, workspace),
			sessionStartEvent: { type: "session_start", reason: "resume", previousSessionFile: restartPath },
			scenarioProfile: lifecycleProfile,
		});
		assert.equal(
			latest(runtime.session.sessionManager.getBranch(), "pi-context-window-state-v1").sessionOverride,
			64_000,
			"a fresh Pi runtime restores persisted active-branch state",
		);
		assert.equal(runtime.session.model?.contextWindow, 64_000, "a fresh Pi runtime restores the persisted active-branch cap");

		const cloneSource = runtime.session.sessionFile;
		const cloneLeaf = runtime.session.sessionManager.getLeafId();
		assert.ok(cloneSource && cloneLeaf);
		const cloneResult = await runtime.fork(cloneLeaf, { position: "at" });
		assert.equal(cloneResult.cancelled, false);
		await runtime.session.bindExtensions({ mode: "rpc" });
		assert.notEqual(runtime.session.sessionFile, cloneSource);
		assert.equal(runtime.session.model?.contextWindow, 64_000, "clone restores the copied active-branch cap");

		lifecycleFaux.setResponses([fauxAssistantMessage("fork source", { stopReason: "stop" })]);
		await runtime.session.prompt("fork this branch");
		const forkMessage = runtime.session.getUserMessagesForForking().at(-1);
		assert.ok(forkMessage?.entryId);
		const forkResult = await runtime.fork(forkMessage.entryId);
		assert.equal(forkResult.cancelled, false);
		await runtime.session.bindExtensions({ mode: "rpc" });
		assert.equal(runtime.session.model?.contextWindow, 64_000, "fork restores the ancestor context-window snapshot");
	} finally {
		await runtime.dispose();
		lifecycleFaux.unregister();
	}

	async function compactionScenario(label, cap) {
		const scenarioProfile = path.join(profile, label);
		const sessionDir = path.join(scenarioProfile, "sessions");
		mkdirSync(sessionDir, { recursive: true });
		writeFileSync(path.join(scenarioProfile, "models.json"), "{}\n");
		const faux = registerFauxProvider({
			provider: `context-window-${label}`,
			models: [{ id: label, contextWindow: 200_000, maxTokens: 8_192 }],
		});
		faux.setResponses([
			fauxAssistantMessage("x".repeat(160_000), { stopReason: "stop" }),
			fauxAssistantMessage("deterministic compacted summary", { stopReason: "stop" }),
		]);
		const settingsManager = SettingsManager.inMemory({
			compaction: { enabled: true, reserveTokens: 20_000, keepRecentTokens: 1 },
			retry: { enabled: false },
		});
		const scenarioRuntime = await createRuntime({
			faux,
			settingsManager,
			sessionManager: SessionManager.create(workspace, sessionDir),
			scenarioProfile,
		});
		const events = [];
		const unsubscribe = scenarioRuntime.session.subscribe((event) => events.push(event));
		try {
			if (cap !== null) {
				await scenarioRuntime.session.prompt(`/context-window ${cap}`);
				assert.equal(scenarioRuntime.session.model?.contextWindow, cap);
			}
			await scenarioRuntime.session.prompt("exercise Pi's existing threshold compaction");
			const compactions = scenarioRuntime.session.sessionManager.getEntries().filter((entry) => entry.type === "compaction");
			return {
				providerCalls: faux.state.callCount,
				compactions: compactions.length,
				thresholdStarts: events.filter((event) => event.type === "compaction_start" && event.reason === "threshold").length,
			};
		} finally {
			unsubscribe();
			await scenarioRuntime.dispose();
			faux.unregister();
		}
	}

	const control = await compactionScenario("control", null);
	const capped = await compactionScenario("capped", 50_000);
	assert.deepEqual(control, { providerCalls: 1, compactions: 0, thresholdStarts: 0 }, "the true 200k maximum stays below Pi's 180k threshold");
	assert.deepEqual(capped, { providerCalls: 2, compactions: 1, thresholdStarts: 1 }, "the lower 50k effective window crosses Pi's unchanged 30k threshold");
	return {
		lifecycle: { sessionTree: "restored", restart: "restored", clone: "restored", fork: "restored" },
		compaction: { control, capped },
	};
}

try {
	const pi = piExecutable();
	const piRoot = path.dirname(path.dirname(pi));
	const codingAgentRoot = piRoot;
	const piAiRoot = findPackageRoot(piRoot, "@earendil-works/pi-ai");
	const piSdk = await import(pathToFileURL(path.join(codingAgentRoot, "dist", "index.js")));
	const piAi = await import(pathToFileURL(path.join(piAiRoot, "dist", "index.js")));
	const piAiCompat = await import(pathToFileURL(path.join(piAiRoot, "dist", "compat.js")));
	const { loadExtensions, clearExtensionCache } = await import(pathToFileURL(path.join(codingAgentRoot, "dist", "core", "extensions", "loader.js")));
	const tarballs = path.join(root, "tarballs");
	const workspace = path.join(root, "workspace");
	const sessions = path.join(root, "sessions");
	mkdirSync(tarballs, { recursive: true });
	mkdirSync(workspace, { recursive: true });
	mkdirSync(sessions, { recursive: true });
	const goalPack = pack(repository, tarballs);
	const todoPack = pack(path.join(repository, "..", "todo"), tarballs);
	const contextPack = pack(path.join(repository, "..", "context-window"), tarballs);
	const goalProfile = path.join(root, "goal-profile");
	const todoProfile = path.join(root, "todo-profile");
	const contextProfile = path.join(root, "context-profile");
	mkdirSync(goalProfile, { recursive: true });
	mkdirSync(todoProfile, { recursive: true });
	mkdirSync(contextProfile, { recursive: true });
	const installedGoal = installAlone(goalPack.path, goalProfile, "@fractaal/pi-goal-x", goalPack.report.version, ">=0.84.1");
	const installedTodo = installAlone(todoPack.path, todoProfile, "@fractaal/pi-todo", todoPack.report.version);
	const installedContext = installAlone(
		contextPack.path,
		contextProfile,
		"@fractaal/pi-context-window",
		contextPack.report.version,
		">=0.84.1",
		{ "@earendil-works/pi-ai": "*", "@earendil-works/pi-coding-agent": ">=0.84.1" },
	);
	const goalSession = writeSession(sessions, workspace, "goal", "pi-goal-state-v1", {
		schemaVersion: 1,
		revision: 7,
		goal: {
			id: "installed-goal",
			objective: "Replay the installed Goal package",
			status: "paused",
			autoContinue: false,
			usage: { tokensUsed: 12, activeSeconds: 3 },
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:01.000Z",
			pause: { reason: "Installed package fixture" },
		},
	});
	const todoSession = writeSession(sessions, workspace, "todo", "pi-todo-state-v1", {
		schemaVersion: 1,
		revision: 4,
		tasks: [{ key: "installed", subject: "Replay the installed Todo package", status: "in_progress" }],
	});
	const rpc = await Promise.all([
		runInstalledRpc({ label: "Goal installed alone", pi, profile: goalProfile, workspace, sessionFile: goalSession, requiredCommands: ["goal", "goal-status", "goal-pause", "goal-resume", "goal-abandon", "goal-migrate"], prompt: "/goal-status", expectedNotification: "Replay the installed Goal package", installedRoot: installedGoal }),
		runInstalledRpc({ label: "Todo installed alone", pi, profile: todoProfile, workspace, sessionFile: todoSession, requiredCommands: ["todos"], prompt: "/todos", expectedNotification: "Replay the installed Todo package", installedRoot: installedTodo }),
	]);
	const lifecycle = await exerciseInstalledGoal(loadExtensions, goalProfile, workspace);
	clearExtensionCache();
	const realAgentSession = await exerciseRealAgentSessionContinuation(piSdk, piAi, goalProfile, workspace);
	clearExtensionCache();
	const terminalCancellation = await exerciseTerminalContinuationCancellation(piSdk, piAi, goalProfile, workspace);
	clearExtensionCache();
	const manualCompaction = await exerciseManualCompactionContinuation(piSdk, piAi, goalProfile, workspace);
	clearExtensionCache();
	const todo = await exerciseInstalledTodo(loadExtensions, clearExtensionCache, todoProfile, workspace);
	clearExtensionCache();
	const todoRealAgentSession = await exerciseRealAgentSessionTodoIdempotence(piSdk, piAi, todoProfile, workspace);
	clearExtensionCache();
	const contextWindow = await exerciseRealContextWindowLifecycleAndCompaction(piSdk, { ...piAi, ...piAiCompat }, contextProfile, workspace, installedContext);
	clearExtensionCache();
	console.log(JSON.stringify({
		pi: run(pi, ["--version"]).trim(),
		packs: [
			{ name: goalPack.report.name, version: goalPack.report.version, files: goalPack.report.files.length },
			{ name: todoPack.report.name, version: todoPack.report.version, files: todoPack.report.files.length },
			{ name: contextPack.report.name, version: contextPack.report.version, files: contextPack.report.files.length },
		],
		rpc,
		lifecycle,
		realAgentSession,
		terminalCancellation,
		manualCompaction,
		todo,
		todoRealAgentSession,
		contextWindow,
		deterministicBoundary: "Packed Goal runs through Pi's real AgentSession with a counting faux provider, including manual-compaction pending and active barriers plus real completion and final prose; packed Todo repeats an identical replacement through a real AgentSession without a second state entry; packed Context Window restores branch, restart, clone, and fork state and changes only the model metadata that Pi's existing threshold compaction consumes.",
	}, null, 2));
} finally {
	if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	rmSync(root, { recursive: true, force: true });
}
