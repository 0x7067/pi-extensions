import { randomUUID } from "node:crypto";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { runGoalCompletionAuditor } from "./goal-auditor.ts";
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
	GOAL_PROPOSAL_COMMENT_MAX_LENGTH,
	GOAL_PAUSE_REASON_MAX_LENGTH,
	GOAL_PAUSE_SUGGESTED_ACTION_MAX_LENGTH,
	GOAL_UNBLOCK_CONDITION_MAX_LENGTH,
	GOAL_WAIT_MIN_SECONDS,
	GOAL_WAIT_MAX_SECONDS,
	GOAL_WAITING_FOR_MAX_LENGTH,
	GOAL_WAKE_ENTRY,
	GOAL_PROPOSAL_EVENT,
	GOAL_AUDIT_EVENT,
	GOAL_AUDIT_EVENT_VERSION,
	GOAL_PROPOSAL_REVISION_ENTRY,
	GOAL_RECEIPT_ENTRY,
	GOAL_SCHEMA_VERSION,
	GOAL_STATE_ENTRY,
	GOAL_STATE_EVENT,
	GOAL_STATE_REQUEST_EVENT,
	goalBlockedPause,
	isGoalBlockedPause,
	isGoalState,
	parseGoalState,
	type Goal,
	type GoalBlockedProof,
	type GoalProposal,
	type GoalState,
} from "./goal-contract.ts";
import {
	LEGACY_MIGRATION_ENTRY,
	findLegacyGoalCandidates,
	planLegacyMigration,
	writeLegacyMigration,
	type LegacyGoalCandidate,
} from "./legacy-migration.ts";
import {
	GOAL_TRANSCRIPT_EVENT,
	GOAL_TRANSCRIPT_MESSAGE_MAX_LENGTH,
	createGoalTranscriptEvent,
	type GoalTranscriptEvent,
	type GoalTranscriptEventInput,
} from "./goal-transcript-events.ts";
import { GoalWidget } from "./goal-widget.ts";

export * from "./goal-contract.ts";
export * from "./goal-transcript-events.ts";
export * from "./legacy-migration.ts";

const REQUIRED_PI_CODING_AGENT_VERSION = "0.84.1";

type IdleExtensionContext = ExtensionContext & {
	onIdle(callback: () => void): () => void;
};

function requireIdleSupport(ctx: ExtensionContext): asserts ctx is IdleExtensionContext {
	if (typeof (ctx as ExtensionContext & { onIdle?: unknown }).onIdle !== "function") {
		throw new Error(`@fractaal/pi-goal-x requires @earendil-works/pi-coding-agent >= ${REQUIRED_PI_CODING_AGENT_VERSION}; this runtime does not provide ctx.onIdle.`);
	}
}

function nowIso(): string {
	return new Date().toISOString();
}

function boundedRequiredText(value: string, label: string, maxLength: number): string {
	const trimmed = value.trim();
	if (!trimmed) throw new Error(`${label} requires non-empty text.`);
	if (trimmed.length > maxLength) throw new Error(`${label} exceeds the ${maxLength}-character producer state bound.`);
	return trimmed;
}

function boundedOptionalText(value: string | undefined, label: string, maxLength: number): string | undefined {
	const trimmed = value?.trim();
	if (!trimmed) return undefined;
	if (trimmed.length > maxLength) throw new Error(`${label} exceeds the ${maxLength}-character producer state bound.`);
	return trimmed;
}

function emptyState(): GoalState {
	return { schemaVersion: GOAL_SCHEMA_VERSION, revision: 0, goal: null };
}

function loadProposalRevision(ctx: ExtensionContext): number {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== GOAL_PROPOSAL_REVISION_ENTRY) continue;
		const revision = entry.data !== null && typeof entry.data === "object" ? (entry.data as { revision?: unknown }).revision : undefined;
		if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 0) {
			throw new Error(`Invalid ${GOAL_PROPOSAL_REVISION_ENTRY} at the active branch leaf; refusing to reset the event revision.`);
		}
		return revision;
	}
	return 0;
}

function loadGoalState(ctx: ExtensionContext): GoalState | null {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== GOAL_STATE_ENTRY) continue;
		const parsed = parseGoalState(entry.data);
		if (!parsed) throw new Error(`Invalid ${GOAL_STATE_ENTRY} snapshot at the active branch leaf; refusing to fall back to older Goal state.`);
		return parsed;
	}
	return null;
}

type GoalWake = { goalId: string; wakeAt: number };

/** The newest wake entry on the branch wins; a null wakeAt records that the wait ended. */
function loadGoalWake(ctx: ExtensionContext): GoalWake | null {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index -= 1) {
		const entry = branch[index] as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== GOAL_WAKE_ENTRY) continue;
		const data = entry.data !== null && typeof entry.data === "object" ? entry.data as { goalId?: unknown; wakeAt?: unknown } : {};
		const wakeAt = typeof data.wakeAt === "string" ? Date.parse(data.wakeAt) : Number.NaN;
		return typeof data.goalId === "string" && Number.isFinite(wakeAt) ? { goalId: data.goalId, wakeAt } : null;
	}
	return null;
}

function durationText(seconds: number): string {
	if (seconds < 60) return `${seconds}s`;
	return seconds % 60 === 0 ? `${seconds / 60}m` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function hasMigrationMarker(ctx: ExtensionContext, status?: string): boolean {
	return ctx.sessionManager.getBranch().some((item) => {
		const entry = item as { type?: string; customType?: string; data?: unknown };
		if (entry.type !== "custom" || entry.customType !== LEGACY_MIGRATION_ENTRY) return false;
		if (!status) return true;
		return entry.data !== null && typeof entry.data === "object" && (entry.data as { status?: unknown }).status === status;
	});
}

function assistantTokens(message: unknown): number {
	if (message === null || typeof message !== "object") return 0;
	const raw = message as { role?: unknown; usage?: { input?: unknown; output?: unknown } };
	if (raw.role !== "assistant") return 0;
	const input = typeof raw.usage?.input === "number" && Number.isFinite(raw.usage.input) ? raw.usage.input : 0;
	const output = typeof raw.usage?.output === "number" && Number.isFinite(raw.usage.output) ? raw.usage.output : 0;
	return Math.max(0, Math.trunc(input)) + Math.max(0, Math.trunc(output));
}

function renderGoalSystemPrompt(state: GoalState): string {
	const goal = state.goal;
	if (!goal) return "";
	const promptStatus = goal.status === "paused" && isGoalBlockedPause(goal.pause) ? "BLOCKED" : goal.status.toUpperCase();
	const lines = [
		`[PI GOAL ${promptStatus}]`,
		"<goal_objective>",
		goal.objective.replace(/<\/?goal_objective>/gi, (tag) => tag.replaceAll("<", "&lt;").replaceAll(">", "&gt;")),
		"</goal_objective>",
		"\"Continue the Goal.\" messages are automatic reprompts from the Goal extension, not from the user. They never answer your questions, approve anything, or give permission; a decision you put to the user stays pending until the user replies.",
	];
	if (goal.status === "active") {
		lines.push("An active Goal continues by default. Do not stop at a progress report: if any safe, in-scope action can materially advance any part of the objective, take it.");
		lines.push("When the only remaining progress depends on external state that takes time, call wait_goal instead of polling or stopping.");
		lines.push("If nothing else can advance the Goal until the user replies to a decision you put to them, call wait_goal.");
		lines.push("set_goal_blocked is an exceptional factual claim that autonomous progress is currently impossible. It is not a way to defer work, request review, or hand back an unfinished objective.");
		lines.push("Call abandon_goal only when the Goal should be abandoned, or complete_goal only after the objective is genuinely complete.");
	} else if (goal.status === "paused" && isGoalBlockedPause(goal.pause)) {
		lines.push("The Goal is blocked. Do not resume substantive Goal work until resume_goal is called.");
		lines.push(goal.pause?.reason ?? "No block proof recorded.");
		lines.push(`Unblock condition: ${goal.pause?.suggestedAction ?? "not recorded"}`);
	} else if (goal.status === "paused") {
		lines.push(`The Goal is paused by the user: ${goal.pause?.reason ?? "no reason recorded"}. Do not resume substantive Goal work until resume_goal is called.`);
		if (goal.pause?.suggestedAction) lines.push(`Suggested resume action: ${goal.pause.suggestedAction}`);
	} else {
		lines.push("The Goal passed its independent audit. Write one normal final response now and do not call tools.");
	}
	if (goal.lastAuditRejection) lines.push(`Latest auditor objection: ${goal.lastAuditRejection.report}`);
	return lines.join("\n");
}

function stateText(state: GoalState): string {
	const goal = state.goal;
	if (!goal) return "No Goal is active on this branch.";
	const blocked = goal.status === "paused" && isGoalBlockedPause(goal.pause);
	const status = blocked ? "blocked" : goal.status;
	const lines = [`Goal ${status}: ${goal.objective}`, `Revision: ${state.revision}`, `Auto-continue: ${goal.autoContinue ? "on" : "off"}`];
	if (goal.pause) lines.push(`${blocked ? "Block proof" : "Pause reason"}: ${goal.pause.reason}`);
	if (goal.pause?.suggestedAction) lines.push(`${blocked ? "Unblock condition" : "Suggested action"}: ${goal.pause.suggestedAction}`);
	if (goal.lastAuditRejection) lines.push(`Latest audit rejection: ${goal.lastAuditRejection.report}`);
	return lines.join("\n");
}

export default function goalExtension(
	pi: ExtensionAPI,
	dependencies: { runCompletionAuditor?: typeof runGoalCompletionAuditor } = {},
): void {
	let state = emptyState();
	let proposal: GoalProposal = { schemaVersion: GOAL_SCHEMA_VERSION, revision: 0, proposal: null };
	let proposalSequence = 0;
	let lastAccountedAt: number | null = null;
	let auditing = false;
	let auditingGoalId: string | null = null;
	let widget: GoalWidget | null = null;
	let widgetContext: ExtensionContext | null = null;
	let migrationCandidates: LegacyGoalCandidate[] = [];
	let idleContinuationCancel: (() => void) | undefined;
	let wake: GoalWake | null = null;
	let wakeTimer: ReturnType<typeof setTimeout> | undefined;

	function emitState(): void {
		pi.events.emit(GOAL_STATE_EVENT, structuredClone(state));
	}

	function emitProposal(): void {
		pi.events.emit(GOAL_PROPOSAL_EVENT, structuredClone(proposal));
	}

	function emitAuditState(active: boolean, goalId: string): void {
		if (auditing === active && (!active || auditingGoalId === goalId)) return;
		auditing = active;
		auditingGoalId = active ? goalId : null;
		pi.events.emit(GOAL_AUDIT_EVENT, {
			version: GOAL_AUDIT_EVENT_VERSION,
			goalId,
			active,
			emittedAt: nowIso(),
		});
		widget?.update();
	}

	function updateWidget(ctx: ExtensionContext): void {
		widgetContext = ctx;
		if (!ctx.hasUI || !state.goal) {
			ctx.ui.setWidget("pi-goal", undefined);
			widget = null;
			return;
		}
		if (widget) {
			widget.update();
			return;
		}
		ctx.ui.setWidget("pi-goal", (tui, theme) => {
			widget = new GoalWidget(tui, theme, () => state, () => auditing);
			return widget;
		}, { placement: "aboveEditor" });
	}

	function persist(nextGoal: Goal | null, ctx: ExtensionContext): void {
		requireIdleSupport(ctx);
		const nextState = {
			schemaVersion: GOAL_SCHEMA_VERSION,
			revision: state.revision + 1,
			goal: nextGoal ? structuredClone(nextGoal) : null,
		};
		if (!isGoalState(nextState)) throw new Error("Goal mutation exceeds the exported producer state contract.");
		if (nextState.goal?.status !== "active") endWait();
		state = nextState;
		pi.appendEntry(GOAL_STATE_ENTRY, state);
		emitState();
		updateWidget(ctx);
	}

	function publishReceipt(input: GoalTranscriptEventInput): GoalTranscriptEvent {
		const receipt = createGoalTranscriptEvent(input, nowIso());
		pi.appendEntry(GOAL_RECEIPT_ENTRY, receipt);
		pi.events.emit(GOAL_TRANSCRIPT_EVENT, receipt);
		return receipt;
	}

	function goalFields(goal: Goal | null): Pick<GoalTranscriptEventInput, "goalId" | "objective" | "autoContinue"> {
		return goal ? { goalId: goal.id, objective: goal.objective, autoContinue: goal.autoContinue } : {};
	}

	function nextProposalRevision(): number {
		proposalSequence += 1;
		pi.appendEntry(GOAL_PROPOSAL_REVISION_ENTRY, { schemaVersion: GOAL_SCHEMA_VERSION, revision: proposalSequence });
		return proposalSequence;
	}

	function setProposal(kind: "create" | "tweak", objective: string, currentObjective?: string): void {
		const boundedObjective = boundedRequiredText(objective, "Goal objective", GOAL_OBJECTIVE_MAX_LENGTH);
		const boundedCurrentObjective = boundedOptionalText(currentObjective, "Current Goal objective", GOAL_OBJECTIVE_MAX_LENGTH);
		proposal = {
			schemaVersion: GOAL_SCHEMA_VERSION,
			revision: nextProposalRevision(),
			proposal: { kind, objective: boundedObjective, ...(boundedCurrentObjective ? { currentObjective: boundedCurrentObjective } : {}) },
		};
		emitProposal();
	}

	function clearProposal(): void {
		proposal = { schemaVersion: GOAL_SCHEMA_VERSION, revision: nextProposalRevision(), proposal: null };
		emitProposal();
	}

	function cancelContinuation(): void {
		idleContinuationCancel?.();
		idleContinuationCancel = undefined;
	}

	function continueGoal(): void {
		const goal = state.goal;
		if (!goal || goal.status !== "active" || !goal.autoContinue) return;
		pi.sendMessage({
			customType: GOAL_CONTINUATION_MESSAGE,
			content: GOAL_CONTINUATION_TEXT,
			display: false,
		}, { deliverAs: "followUp", triggerTurn: true });
	}

	function cancelWakeTimer(): void {
		if (wakeTimer) clearTimeout(wakeTimer);
		wakeTimer = undefined;
	}

	/** Ends a model-chosen wait durably, so a restart never re-arms a wait that already ended. */
	function endWait(): void {
		cancelWakeTimer();
		if (!wake) return;
		pi.appendEntry(GOAL_WAKE_ENTRY, { schemaVersion: GOAL_SCHEMA_VERSION, goalId: wake.goalId, wakeAt: null });
		wake = null;
	}

	function requestContinuation(ctx: ExtensionContext): void {
		if (!state.goal || state.goal.status !== "active" || !state.goal.autoContinue || idleContinuationCancel) return;
		requireIdleSupport(ctx);
		idleContinuationCancel = ctx.onIdle(() => {
			idleContinuationCancel = undefined;
			if (wakeTimer) return;
			const remaining = wake && wake.goalId === state.goal?.id ? wake.wakeAt - Date.now() : 0;
			if (remaining <= 0) {
				endWait();
				continueGoal();
				return;
			}
			wakeTimer = setTimeout(() => {
				wakeTimer = undefined;
				endWait();
				continueGoal();
			}, Math.min(remaining, GOAL_WAIT_MAX_SECONDS * 1000));
			wakeTimer.unref?.();
		});
	}

	function currentGoal(requiredStatus?: "active" | "paused-or-active"): Goal {
		const goal = state.goal;
		if (!goal) throw new Error("No Goal is active on this branch.");
		if (requiredStatus === "active" && goal.status !== "active") {
			const status = goal.status === "paused" && isGoalBlockedPause(goal.pause) ? "blocked" : goal.status;
			throw new Error(`The Goal is ${status}, not active.`);
		}
		if (requiredStatus === "paused-or-active" && goal.status === "complete") throw new Error("The Goal is already complete and awaiting final settlement.");
		return goal;
	}

	type GoalProposalDecision = { confirmed: boolean; comment?: string };
	type ConfirmWithInputUI = {
		confirmWithInput?: (options: {
			title: string;
			message: string;
			messageFormat: "markdown";
			inputLabel: string;
			inputPlaceholder: string;
		}) => Promise<{ confirmed: boolean; input?: string }>;
	};

	function proposalResultText(text: string, comment?: string): string {
		return comment ? `${text}\n\nUser comment: "${comment}"` : text;
	}

	async function confirmProposal(ctx: ExtensionContext, title: string, objective: string): Promise<GoalProposalDecision> {
		if (!ctx.hasUI) throw new Error("Goal proposal requires an interactive user confirmation surface.");
		const ui = ctx.ui as typeof ctx.ui & ConfirmWithInputUI;
		if (ui.confirmWithInput) {
			const result = await ui.confirmWithInput({
				title,
				message: objective,
				messageFormat: "markdown",
				inputLabel: "Comments or reservations (optional)",
				inputPlaceholder: "Write additional comments or reservations here…",
			});
			return {
				confirmed: result.confirmed,
				comment: boundedOptionalText(result.input, "Goal proposal comment", GOAL_PROPOSAL_COMMENT_MAX_LENGTH),
			};
		}
		return { confirmed: await ctx.ui.confirm(title, objective) };
	}

	function persistPaused(ctx: ExtensionContext, pause: NonNullable<Goal["pause"]>): Goal {
		const goal = currentGoal("active");
		const next: Goal = {
			...goal,
			status: "paused",
			autoContinue: false,
			updatedAt: nowIso(),
			pause,
		};
		persist(next, ctx);
		return next;
	}

	function setBlocked(ctx: ExtensionContext, proof: GoalBlockedProof): Goal {
		const pause = goalBlockedPause(proof);
		const message = boundedRequiredText(
			`${pause.reason}\nUnblock condition: ${pause.suggestedAction}`,
			"Goal blocked receipt",
			GOAL_TRANSCRIPT_MESSAGE_MAX_LENGTH,
		);
		const next = persistPaused(ctx, pause);
		publishReceipt({
			kind: "goal_blocked",
			level: "warning",
			...goalFields(next),
			reason: pause.reason,
			suggestedAction: pause.suggestedAction,
			message,
			tuiMessage: `Goal blocked: ${proof.blocker.trim()}`,
		});
		return next;
	}

	function pauseByUser(ctx: ExtensionContext, reason: string, suggestedAction?: string): Goal {
		const trimmedReason = boundedRequiredText(reason, "Goal pause reason", GOAL_PAUSE_REASON_MAX_LENGTH);
		const trimmedSuggestedAction = boundedOptionalText(suggestedAction, "Goal pause suggested action", GOAL_PAUSE_SUGGESTED_ACTION_MAX_LENGTH);
		const next = persistPaused(ctx, { reason: trimmedReason, ...(trimmedSuggestedAction ? { suggestedAction: trimmedSuggestedAction } : {}) });
		publishReceipt({ kind: "goal_paused", level: "warning", ...goalFields(next), reason: trimmedReason, suggestedAction: trimmedSuggestedAction, tuiMessage: `Goal paused: ${trimmedReason}` });
		return next;
	}

	function resume(ctx: ExtensionContext): Goal {
		requireIdleSupport(ctx);
		const goal = currentGoal("paused-or-active");
		if (goal.status === "active") throw new Error("The Goal is already active.");
		const { pause: _pause, ...resumedGoal } = goal;
		const next: Goal = { ...resumedGoal, status: "active", autoContinue: true, updatedAt: nowIso() };
		persist(next, ctx);
		publishReceipt({ kind: "goal_resumed", level: "info", ...goalFields(next), tuiMessage: "Goal resumed." });
		requestContinuation(ctx);
		return next;
	}

	function abandon(ctx: ExtensionContext, reason: string): Goal {
		const goal = currentGoal("paused-or-active");
		const trimmedReason = reason.trim();
		if (!trimmedReason) throw new Error("abandon_goal requires a non-empty reason.");
		persist(null, ctx);
		publishReceipt({ kind: "goal_abandoned", level: "warning", ...goalFields(goal), reason: trimmedReason, tuiMessage: `Goal abandoned: ${trimmedReason}` });
		return goal;
	}

	function loadOrMigrate(ctx: ExtensionContext): void {
		const loaded = loadGoalState(ctx);
		if (loaded) {
			state = loaded;
			migrationCandidates = [];
			return;
		}
		state = emptyState();
		if (hasMigrationMarker(ctx, "complete")) return;
		const plan = planLegacyMigration(ctx);
		if (plan.kind === "migrate") {
			writeLegacyMigration(pi, plan);
			state = plan.goal;
			migrationCandidates = [];
			return;
		}
		if (plan.kind === "ambiguous") {
			migrationCandidates = plan.candidates;
			if (!hasMigrationMarker(ctx, "selection_required")) {
				pi.appendEntry(LEGACY_MIGRATION_ENTRY, {
					schemaVersion: 1,
					status: "selection_required",
					candidateIds: plan.candidates.map((item) => item.id),
					sourcePreserved: true,
				});
			}
		}
	}

	pi.events.on(GOAL_STATE_REQUEST_EVENT, () => {
		emitState();
		emitProposal();
	});

	const currentPi = pi as unknown as {
		registerEntryRenderer<T>(customType: string, renderer: (entry: { data: T }, options: { expanded: boolean }, theme: Theme) => Text): void;
	};
	currentPi.registerEntryRenderer<GoalTranscriptEvent>(GOAL_RECEIPT_ENTRY, (entry, _options, theme) => {
		const receipt = entry.data;
		const label = receipt.kind.replace(/^goal_/, "Goal ").replaceAll("_", " ");
		const message = receipt.message ?? receipt.reason ?? receipt.changeSummary ?? receipt.completionSummary ?? receipt.objective ?? "";
		return new Text(`${theme.fg(receipt.level === "error" ? "error" : receipt.level === "warning" ? "warning" : "accent", theme.bold(label))}${message ? `\n${theme.fg("muted", message)}` : ""}`, 0, 0);
	});

	pi.registerTool({
		name: "propose_goal",
		label: "Propose Goal",
		description: "Propose one Goal after ordinary conversation has made the objective clear. User confirmation creates and starts it.",
		promptSnippet: "Propose one confirmed Goal from an aligned objective.",
		promptGuidelines: ["Use Markdown to create your Goal proposal.", "Use propose_goal only after normal conversation has made a concrete objective clear enough for user confirmation."],
		parameters: Type.Object({ objective: Type.String({ minLength: 1, maxLength: GOAL_OBJECTIVE_MAX_LENGTH, description: "The complete Goal contract. Markdown is allowed." }) }, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			requireIdleSupport(ctx);
			if (state.goal) throw new Error("A Goal already exists. Use tweak_goal, set_goal_blocked, abandon_goal, or complete_goal.");
			const objective = boundedRequiredText(params.objective, "Goal objective", GOAL_OBJECTIVE_MAX_LENGTH);
			setProposal("create", objective);
			let decision: GoalProposalDecision;
			try {
				decision = await confirmProposal(ctx, "Confirm Goal", objective);
			} finally {
				clearProposal();
			}
			if (!decision.confirmed) return { content: [{ type: "text", text: proposalResultText("Goal proposal declined. Continue the ordinary conversation and propose again only after the user asks for a change.", decision.comment) }], details: state };
			const timestamp = nowIso();
			const goal: Goal = { id: randomUUID(), objective, status: "active", autoContinue: true, usage: { tokensUsed: 0, activeSeconds: 0 }, createdAt: timestamp, updatedAt: timestamp };
			persist(goal, ctx);
			publishReceipt({ kind: "goal_started", level: "info", ...goalFields(goal), tuiMessage: "Goal started." });
			requestContinuation(ctx);
			return { content: [{ type: "text", text: proposalResultText("Goal confirmed and started. Autonomous continuation is active.", decision.comment) }], details: state, terminate: true };
		},
	});

	pi.registerTool({
		name: "tweak_goal",
		label: "Tweak Goal",
		description: "Propose a complete revised objective for the current Goal. The revision applies only after user confirmation, which also resumes a blocked or paused Goal.",
		promptSnippet: "Propose a confirmed revision to the current Goal objective.",
		promptGuidelines: ["Use Markdown to create your Goal proposal.", "Use tweak_goal when user feedback changes the current Goal contract; pass the complete revised objective, not a patch."],
		parameters: Type.Object({ objective: Type.String({ minLength: 1, maxLength: GOAL_OBJECTIVE_MAX_LENGTH }) }, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			requireIdleSupport(ctx);
			const goal = currentGoal("paused-or-active");
			const objective = boundedRequiredText(params.objective, "Goal objective", GOAL_OBJECTIVE_MAX_LENGTH);
			setProposal("tweak", objective, goal.objective);
			let decision: GoalProposalDecision;
			try {
				decision = await confirmProposal(ctx, "Confirm Goal revision", `## Current Goal\n\n${goal.objective}\n\n## Revised Goal\n\n${objective}`);
			} finally {
				clearProposal();
			}
			if (!decision.confirmed) return { content: [{ type: "text", text: proposalResultText("Goal revision declined. The current Goal is unchanged.", decision.comment) }], details: state };
			// The user's confirmation of the revised contract is also the go-ahead, so a blocked or paused Goal resumes.
			const resumed = goal.status !== "active";
			const { lastAuditRejection: _lastAuditRejection, pause: _pause, ...revisedGoal } = goal;
			const next: Goal = { ...revisedGoal, objective, status: "active", autoContinue: true, updatedAt: nowIso() };
			persist(next, ctx);
			publishReceipt({
				kind: "goal_updated",
				level: "info",
				...goalFields(next),
				changeSummary: resumed ? "Goal objective revised with user confirmation; the Goal resumed." : "Goal objective revised with user confirmation.",
				tuiMessage: resumed ? "Goal updated and resumed." : "Goal updated.",
			});
			requestContinuation(ctx);
			return { content: [{ type: "text", text: proposalResultText("Goal revision confirmed. Autonomous continuation is active.", decision.comment) }], details: state, terminate: true };
		},
	});

	pi.registerTool({
		name: "set_goal_blocked",
		label: "Set Goal Blocked",
		description: "Set an active Goal blocked only when no safe, in-scope action can materially advance any part of the objective. Requires evidence that no autonomous path remains.",
		promptSnippet: "Exceptionally set the Goal blocked with complete proof that autonomous progress is impossible.",
		promptGuidelines: [
			"Do not use set_goal_blocked for progress reporting, uncertainty, inconvenience, a failed attempt, desire for review, or the end of the current plan while another concrete action remains.",
			"For asynchronous work, arrange the available monitor or reminder before blocking and name the exact unblock condition.",
		],
		parameters: Type.Object({
			blocker: Type.String({ minLength: 1, maxLength: GOAL_BLOCKER_MAX_LENGTH, description: "The concrete fact currently preventing progress." }),
			evidence: Type.String({ minLength: 1, maxLength: GOAL_BLOCK_EVIDENCE_MAX_LENGTH, description: "Observed evidence that the blocker is real now." }),
			whyNoAutonomousPathRemains: Type.String({ minLength: 1, maxLength: GOAL_BLOCK_NO_AUTONOMOUS_PATH_MAX_LENGTH, description: "Why no other safe, in-scope action can materially advance any part of the Goal." }),
			unblockCondition: Type.String({ minLength: 1, maxLength: GOAL_UNBLOCK_CONDITION_MAX_LENGTH, description: "The exact factual condition that permits autonomous work to resume." }),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			const next = setBlocked(ctx, params);
			return { content: [{ type: "text", text: `Goal blocked.\n\n${next.pause?.reason}\nUnblock condition: ${next.pause?.suggestedAction}` }], details: state, terminate: true };
		},
	});

	pi.registerTool({
		name: "wait_goal",
		label: "Wait Goal",
		description: `Choose when the active Goal next continues, from ${GOAL_WAIT_MIN_SECONDS} to ${GOAL_WAIT_MAX_SECONDS} seconds from now, instead of continuing immediately. The Goal stays active; any user message or event before then wakes you sooner.`,
		promptSnippet: "Wait for external state before the Goal continues.",
		promptGuidelines: [
			"Use wait_goal only when no safe, in-scope action can advance the Goal until external state changes, such as a build, deploy, review, long-running process, or the user's reply to a decision you put to them. It is not a way to defer work that can be done now.",
			"Match delaySeconds to what you are waiting for: one check when it should be done beats many short polls. If it is still not ready when you wake, wait again.",
		],
		parameters: Type.Object({
			delaySeconds: Type.Integer({ minimum: GOAL_WAIT_MIN_SECONDS, maximum: GOAL_WAIT_MAX_SECONDS, description: "Seconds from now until the Goal continues." }),
			waitingFor: Type.String({ minLength: 1, maxLength: GOAL_WAITING_FOR_MAX_LENGTH, description: "The concrete external condition being waited on. Shown to the user." }),
		}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			requireIdleSupport(ctx);
			const goal = currentGoal("active");
			const waitingFor = boundedRequiredText(params.waitingFor, "Goal wait condition", GOAL_WAITING_FOR_MAX_LENGTH);
			if (!Number.isInteger(params.delaySeconds) || params.delaySeconds < GOAL_WAIT_MIN_SECONDS || params.delaySeconds > GOAL_WAIT_MAX_SECONDS) {
				throw new Error(`delaySeconds must be an integer from ${GOAL_WAIT_MIN_SECONDS} to ${GOAL_WAIT_MAX_SECONDS}.`);
			}
			cancelWakeTimer();
			wake = { goalId: goal.id, wakeAt: Date.now() + params.delaySeconds * 1000 };
			const wakeAt = new Date(wake.wakeAt).toISOString();
			pi.appendEntry(GOAL_WAKE_ENTRY, { schemaVersion: GOAL_SCHEMA_VERSION, goalId: goal.id, wakeAt });
			const detail = `up to ${durationText(params.delaySeconds)}: ${waitingFor}`;
			publishReceipt({ kind: "goal_waiting", level: "info", ...goalFields(goal), reason: waitingFor, message: `Waiting ${detail}`, tuiMessage: `Goal waiting ${detail}` });
			return { content: [{ type: "text", text: `The Goal continues at ${wakeAt} (in ${durationText(params.delaySeconds)}). Any user message or event before then wakes you sooner. End your turn now.` }], details: state, terminate: true };
		},
	});

	pi.registerTool({
		name: "resume_goal",
		label: "Resume Goal",
		description: "Resume the blocked or human-paused Goal from its exact current state and restart autonomous continuation.",
		promptSnippet: "Resume the blocked Goal.",
		parameters: Type.Object({}, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, _params, _signal, _update, ctx) {
			resume(ctx);
			return { content: [{ type: "text", text: "Goal resumed. Autonomous continuation is active." }], details: state, terminate: true };
		},
	});

	pi.registerTool({
		name: "abandon_goal",
		label: "Abandon Goal",
		description: "Abandon the active, blocked, or human-paused Goal without marking it complete.",
		promptSnippet: "Abandon the Goal with a concrete reason.",
		parameters: Type.Object({ reason: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, params, _signal, _update, ctx) {
			abandon(ctx, params.reason);
			return { content: [{ type: "text", text: `Goal abandoned: ${params.reason.trim()}` }], details: state, terminate: true };
		},
	});

	pi.registerTool({
		name: "complete_goal",
		label: "Complete Goal",
		description: "Request independent audit of the active, blocked, or human-paused Goal. Approval permits one final prose response, then archival.",
		promptSnippet: "Submit genuinely complete Goal work for independent audit.",
		promptGuidelines: ["Use complete_goal only when the complete Goal objective is satisfied; the summary is an audit claim, not proof."],
		parameters: Type.Object({ summary: Type.String({ minLength: 1, maxLength: GOAL_COMPLETION_SUMMARY_MAX_LENGTH, description: "Concise completion claim and available verification evidence." }) }, { additionalProperties: false }),
		executionMode: "sequential",
		async execute(_id, params, signal, _update, ctx) {
			const target = structuredClone(currentGoal("paused-or-active"));
			const summary = boundedRequiredText(params.summary, "Goal completion summary", GOAL_COMPLETION_SUMMARY_MAX_LENGTH);
			const auditor = await (async () => {
				try {
					emitAuditState(true, target.id);
					return await (dependencies.runCompletionAuditor ?? runGoalCompletionAuditor)({ ctx, goal: target, completionSummary: summary, signal });
				} finally {
					emitAuditState(false, target.id);
				}
			})();
			if (state.goal?.id !== target.id || state.goal.updatedAt !== target.updatedAt) throw new Error("Goal changed while the completion audit was running; audit result discarded.");
			if (!auditor.approved) {
				const report = boundedRequiredText(
					auditor.output.trim() || auditor.error || "The independent auditor did not approve completion.",
					"Goal audit rejection report",
					GOAL_AUDIT_REJECTION_REPORT_MAX_LENGTH,
				);
				const { pause: _pause, ...rejectedGoal } = target;
				const next: Goal = { ...rejectedGoal, status: "active", autoContinue: true, updatedAt: nowIso(), lastAuditRejection: { rejectedAt: nowIso(), report } };
				persist(next, ctx);
				publishReceipt({ kind: "goal_completion_rejected", level: auditor.error ? "error" : "warning", ...goalFields(next), reason: auditor.error ?? "Rejected by independent auditor.", auditorReport: report, message: "Goal completion rejected by independent auditor.", tuiMessage: `Goal completion rejected.\n${report}` });
				return { content: [{ type: "text", text: `Goal completion rejected. Address these objections before retrying:\n\n${report}` }], details: state };
			}
			const auditorReport = boundedRequiredText(auditor.output, "Goal completion auditor report", GOAL_COMPLETION_AUDITOR_REPORT_MAX_LENGTH);
			const { pause: _pause, lastAuditRejection: _lastAuditRejection, ...auditedGoal } = target;
			const completed: Goal = {
				...auditedGoal,
				status: "complete",
				autoContinue: false,
				updatedAt: nowIso(),
				completion: { approvedAt: nowIso(), summary, auditorReport },
			};
			persist(completed, ctx);
			return {
				content: [{ type: "text", text: `Goal audit approved.\n\n${auditor.output}\n\nWrite one normal final response now: explain what was completed, what changed or was produced, what was verified, and the final state or relevant next step. Do not call tools.` }],
				details: state,
			};
		},
	});

	pi.registerCommand("goal", {
		description: "Discuss a Goal in normal conversation; the model proposes it once aligned.",
		handler: async (args, ctx) => {
			const topic = args.trim();
			if (!topic) {
				ctx.ui.setEditorText(state.goal ? "I want to revise the current Goal: " : "I want to set a Goal: ");
				return;
			}
			pi.sendUserMessage(state.goal
				? `I want to revise the current Goal: ${topic}. Discuss this with me normally, then use tweak_goal once we are aligned.`
				: `I want to set a Goal: ${topic}. Discuss this with me normally, then use propose_goal once we are aligned.`);
		},
	});
	pi.registerCommand("goal-status", { description: "Show the current Goal state.", handler: async (_args, ctx) => ctx.ui.notify(stateText(state), "info") });
	pi.registerCommand("goal-pause", {
		description: "Pause the active Goal.",
		handler: async (args, ctx) => { pauseByUser(ctx, args.trim() || "Paused by user."); },
	});
	pi.registerCommand("goal-resume", { description: "Resume the paused Goal.", handler: async (_args, ctx) => { resume(ctx); } });
	pi.registerCommand("goal-abandon", {
		description: "Abandon the active or paused Goal.",
		handler: async (args, ctx) => { abandon(ctx, args.trim() || "Abandoned by user."); },
	});
	pi.registerCommand("goal-migrate", {
		description: "Choose a legacy Goal when migration found multiple open candidates.",
		handler: async (_args, ctx) => {
			requireIdleSupport(ctx);
			if (loadGoalState(ctx) || hasMigrationMarker(ctx, "complete")) {
				ctx.ui.notify("Legacy migration is already complete or this branch already has new Goal state.", "info");
				return;
			}
			if (migrationCandidates.length === 0) migrationCandidates = findLegacyGoalCandidates(ctx).candidates;
			if (migrationCandidates.length === 0) {
				ctx.ui.notify("No legacy Goals require migration.", "info");
				return;
			}
			if (!ctx.hasUI) {
				ctx.ui.notify(`Legacy Goal selection required: ${migrationCandidates.map((item) => item.id).join(", ")}`, "warning");
				return;
			}
			const labels = migrationCandidates.map((item) => `${item.id}: ${item.objective.replace(/\s+/g, " ").slice(0, 100)}`);
			const selected = await ctx.ui.select("Migrate which legacy Goal?", labels);
			const selectedIndex = selected ? labels.indexOf(selected) : -1;
			if (selectedIndex < 0) return;
			const plan = planLegacyMigration(ctx, migrationCandidates[selectedIndex]?.id);
			if (plan.kind !== "migrate") throw new Error("Legacy Goal selection could not be migrated.");
			writeLegacyMigration(pi, plan);
			state = plan.goal;
			migrationCandidates = [];
			emitState();
			updateWidget(ctx);
			requestContinuation(ctx);
		},
	});

	pi.on("before_agent_start", (event) => {
		// Any run preempts a pending wait; the model waits again if it still needs to.
		endWait();
		lastAccountedAt = state.goal?.status === "active" ? Date.now() : null;
		const goalPrompt = renderGoalSystemPrompt(state);
		if (!goalPrompt) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${goalPrompt}` };
	});

	pi.on("tool_call", () => {
		if (state.goal?.status === "complete") return { block: true, reason: "The Goal is complete. Write the final user-facing response without calling tools." };
	});

	pi.on("agent_end", (event, ctx) => {
		const assistant = [...event.messages].reverse().find((message) => message.role === "assistant");
		if (!assistant) return;
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			cancelContinuation();
			return;
		}
		const goal = state.goal;
		if (!goal || goal.status !== "active" || !goal.autoContinue) return;
		if (assistant.stopReason !== "stop" && assistant.stopReason !== "length" && assistant.stopReason !== "toolUse") return;
		requestContinuation(ctx);
	});

	pi.on("turn_end", (event, ctx) => {
		const goal = state.goal;
		if (!goal || goal.status !== "active") return;
		const now = Date.now();
		const elapsed = lastAccountedAt === null ? 0 : Math.max(0, Math.floor((now - lastAccountedAt) / 1000));
		lastAccountedAt = now;
		const tokens = assistantTokens(event.message);
		if (elapsed === 0 && tokens === 0) return;
		persist({ ...goal, usage: { tokensUsed: goal.usage.tokensUsed + tokens, activeSeconds: goal.usage.activeSeconds + elapsed }, updatedAt: nowIso() }, ctx);
	});

	pi.on("session_start", (_event, ctx) => {
		requireIdleSupport(ctx);
		loadOrMigrate(ctx);
		cancelWakeTimer();
		wake = loadGoalWake(ctx);
		proposalSequence = loadProposalRevision(ctx);
		proposal = { schemaVersion: GOAL_SCHEMA_VERSION, revision: proposalSequence, proposal: null };
		emitState();
		emitProposal();
		updateWidget(ctx);
		if (migrationCandidates.length > 1) ctx.ui.notify("Multiple legacy Goals need selection. Run /goal-migrate; no Goal was guessed and all legacy sources remain unchanged.", "warning");
		requestContinuation(ctx);
	});
	pi.on("session_tree", (_event, ctx) => {
		requireIdleSupport(ctx);
		loadOrMigrate(ctx);
		cancelWakeTimer();
		wake = loadGoalWake(ctx);
		proposalSequence = loadProposalRevision(ctx);
		proposal = { schemaVersion: GOAL_SCHEMA_VERSION, revision: proposalSequence, proposal: null };
		emitState();
		emitProposal();
		updateWidget(ctx);
		requestContinuation(ctx);
	});
	pi.on("session_compact", (_event, ctx) => {
		requireIdleSupport(ctx);
		pi.appendEntry(GOAL_STATE_ENTRY, state);
		emitState();
		updateWidget(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		const completed = state.goal?.status === "complete" ? state.goal : null;
		if (!completed) return;
		persist(null, ctx);
		publishReceipt({
			kind: "goal_completed",
			level: "info",
			...goalFields(completed),
			completionSummary: completed.completion?.summary,
			auditorReport: completed.completion?.auditorReport,
			message: "Goal completed.",
			tuiMessage: "Goal completed.",
		});
	});

	pi.on("session_shutdown", () => {
		cancelContinuation();
		cancelWakeTimer();
		if (auditing && auditingGoalId) emitAuditState(false, auditingGoalId);
		widget = null;
		widgetContext = null;
	});
}
