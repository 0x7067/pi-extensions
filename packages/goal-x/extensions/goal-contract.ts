import { Type, type Static } from "typebox";

export const GOAL_SCHEMA_VERSION = 1 as const;
export const GOAL_STATE_ENTRY = "pi-goal-state-v1";
export const GOAL_RECEIPT_ENTRY = "pi-goal-receipt-v1";
export const GOAL_PROPOSAL_REVISION_ENTRY = "pi-goal-proposal-revision-v1";
export const GOAL_STATE_EVENT = "pi-goal:state";
export const GOAL_STATE_REQUEST_EVENT = "pi-goal:request-state";
export const GOAL_PROPOSAL_EVENT = "pi-goal:proposal";
export const GOAL_AUDIT_EVENT = "pi-goal:audit";
export const GOAL_AUDIT_EVENT_VERSION = 1 as const;
export const GOAL_CONTINUATION_MESSAGE = "pi-goal-continuation-v1";
// Pi delivers custom messages in the user role, so the constant text must say it is not from the user.
export const GOAL_CONTINUATION_TEXT = [
	"<system_message source=\"goal_extension\">",
	"Automatic reprompt from the Goal extension, not a message from the user. It does not answer anything you asked the user, approve anything, or give permission; any decision you put to the user is still pending.",
	"Continue the Goal.",
	"</system_message>",
].join("\n");
// A model-chosen wake lives in its own entry so the Goal state shape never changes.
export const GOAL_WAKE_ENTRY = "pi-goal-wake-v1";
export const GOAL_WAIT_MIN_SECONDS = 60;
export const GOAL_WAIT_MAX_SECONDS = 3_600;
export const GOAL_WAITING_FOR_MAX_LENGTH = 600;
export const GOAL_ID_MAX_LENGTH = 256;
export const GOAL_OBJECTIVE_MAX_LENGTH = 128 * 1024;
export const GOAL_TIMESTAMP_MAX_LENGTH = 64;
export const GOAL_PAUSE_REASON_MAX_LENGTH = 2_048;
export const GOAL_PAUSE_SUGGESTED_ACTION_MAX_LENGTH = 2_048;
// These field bounds keep the complete structured proof inside the existing
// pause metadata and transcript-message contracts without truncation.
export const GOAL_BLOCKER_MAX_LENGTH = 600;
export const GOAL_BLOCK_EVIDENCE_MAX_LENGTH = 600;
export const GOAL_BLOCK_NO_AUTONOMOUS_PATH_MAX_LENGTH = 600;
export const GOAL_UNBLOCK_CONDITION_MAX_LENGTH = 2_000;
export const GOAL_BLOCK_REASON_PREFIX = "Blocker: ";
export const GOAL_BLOCK_EVIDENCE_SEPARATOR = "\nEvidence: ";
export const GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR = "\nWhy no autonomous path remains: ";
export const GOAL_AUDIT_REJECTION_REPORT_MAX_LENGTH = 12_000;
export const GOAL_COMPLETION_SUMMARY_MAX_LENGTH = 4_000;
export const GOAL_COMPLETION_AUDITOR_REPORT_MAX_LENGTH = 12_000;
export const GOAL_PROPOSAL_COMMENT_MAX_LENGTH = 4_000;

export const GoalUsageSchema = Type.Object({
	tokensUsed: Type.Number({ minimum: 0 }),
	activeSeconds: Type.Number({ minimum: 0 }),
}, { additionalProperties: false });

export const GoalPauseSchema = Type.Object({
	reason: Type.String({ minLength: 1, maxLength: GOAL_PAUSE_REASON_MAX_LENGTH }),
	suggestedAction: Type.Optional(Type.String({ minLength: 1, maxLength: GOAL_PAUSE_SUGGESTED_ACTION_MAX_LENGTH })),
}, { additionalProperties: false });

export const GoalAuditRejectionSchema = Type.Object({
	rejectedAt: Type.String({ minLength: 1, maxLength: GOAL_TIMESTAMP_MAX_LENGTH }),
	report: Type.String({ minLength: 1, maxLength: GOAL_AUDIT_REJECTION_REPORT_MAX_LENGTH }),
}, { additionalProperties: false });

export const GoalCompletionSchema = Type.Object({
	approvedAt: Type.String({ minLength: 1, maxLength: GOAL_TIMESTAMP_MAX_LENGTH }),
	summary: Type.String({ minLength: 1, maxLength: GOAL_COMPLETION_SUMMARY_MAX_LENGTH }),
	auditorReport: Type.String({ minLength: 1, maxLength: GOAL_COMPLETION_AUDITOR_REPORT_MAX_LENGTH }),
}, { additionalProperties: false });

const GoalCommonProperties = {
	id: Type.String({ minLength: 1, maxLength: GOAL_ID_MAX_LENGTH }),
	objective: Type.String({ minLength: 1, maxLength: GOAL_OBJECTIVE_MAX_LENGTH }),
	usage: GoalUsageSchema,
	createdAt: Type.String({ minLength: 1, maxLength: GOAL_TIMESTAMP_MAX_LENGTH }),
	updatedAt: Type.String({ minLength: 1, maxLength: GOAL_TIMESTAMP_MAX_LENGTH }),
	pause: Type.Optional(GoalPauseSchema),
	lastAuditRejection: Type.Optional(GoalAuditRejectionSchema),
	completion: Type.Optional(GoalCompletionSchema),
};

export const GoalSchema = Type.Union([
	Type.Object({ ...GoalCommonProperties, status: Type.Literal("active"), autoContinue: Type.Literal(true) }, { additionalProperties: false }),
	Type.Object({ ...GoalCommonProperties, status: Type.Literal("paused"), autoContinue: Type.Literal(false) }, { additionalProperties: false }),
	Type.Object({ ...GoalCommonProperties, status: Type.Literal("complete"), autoContinue: Type.Literal(false) }, { additionalProperties: false }),
]);

export const GoalStateSchema = Type.Object({
	schemaVersion: Type.Literal(GOAL_SCHEMA_VERSION),
	revision: Type.Integer({ minimum: 0 }),
	goal: Type.Union([GoalSchema, Type.Null()]),
}, { additionalProperties: false });

export const GoalProposalSchema = Type.Object({
	schemaVersion: Type.Literal(GOAL_SCHEMA_VERSION),
	revision: Type.Integer({ minimum: 0 }),
	proposal: Type.Union([
		Type.Object({
			kind: Type.Union([Type.Literal("create"), Type.Literal("tweak")]),
			objective: Type.String({ minLength: 1, maxLength: GOAL_OBJECTIVE_MAX_LENGTH }),
			currentObjective: Type.Optional(Type.String({ minLength: 1, maxLength: GOAL_OBJECTIVE_MAX_LENGTH })),
		}, { additionalProperties: false }),
		Type.Null(),
	]),
}, { additionalProperties: false });

export type GoalUsage = Static<typeof GoalUsageSchema>;
export type GoalPause = Static<typeof GoalPauseSchema>;

export interface GoalBlockedProof {
	blocker: string;
	evidence: string;
	whyNoAutonomousPathRemains: string;
	unblockCondition: string;
}

export type GoalBlockedPause = GoalPause & { suggestedAction: string };

export function goalBlockedPause(proof: GoalBlockedProof): GoalBlockedPause {
	const blocker = proof.blocker.trim();
	const evidence = proof.evidence.trim();
	const whyNoAutonomousPathRemains = proof.whyNoAutonomousPathRemains.trim();
	const unblockCondition = proof.unblockCondition.trim();
	for (const [label, value, maxLength] of [
		["blocker", blocker, GOAL_BLOCKER_MAX_LENGTH],
		["evidence", evidence, GOAL_BLOCK_EVIDENCE_MAX_LENGTH],
		["whyNoAutonomousPathRemains", whyNoAutonomousPathRemains, GOAL_BLOCK_NO_AUTONOMOUS_PATH_MAX_LENGTH],
		["unblockCondition", unblockCondition, GOAL_UNBLOCK_CONDITION_MAX_LENGTH],
	] as const) {
		if (!value) throw new Error(`set_goal_blocked requires non-empty ${label}.`);
		if (value.length > maxLength) throw new Error(`${label} exceeds the ${maxLength}-character producer state bound.`);
	}
	const reason = `${GOAL_BLOCK_REASON_PREFIX}${blocker}${GOAL_BLOCK_EVIDENCE_SEPARATOR}${evidence}${GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR}${whyNoAutonomousPathRemains}`;
	if (reason.length > GOAL_PAUSE_REASON_MAX_LENGTH) {
		throw new Error(`Combined Goal block proof exceeds the ${GOAL_PAUSE_REASON_MAX_LENGTH}-character paused-state compatibility bound.`);
	}
	return { reason, suggestedAction: unblockCondition };
}

export function parseGoalBlockedPause(value: unknown): GoalBlockedPause | null {
	const pause = record(value);
	if (!pause || !hasOnlyKeys(pause, ["reason", "suggestedAction"])) return null;
	if (typeof pause.reason !== "string" || pause.reason.length > GOAL_PAUSE_REASON_MAX_LENGTH) return null;
	if (typeof pause.suggestedAction !== "string" || pause.suggestedAction.length > GOAL_PAUSE_SUGGESTED_ACTION_MAX_LENGTH) return null;
	if (!pause.reason.startsWith(GOAL_BLOCK_REASON_PREFIX)) return null;

	for (
		let evidenceIndex = pause.reason.indexOf(GOAL_BLOCK_EVIDENCE_SEPARATOR, GOAL_BLOCK_REASON_PREFIX.length);
		evidenceIndex >= 0;
		evidenceIndex = pause.reason.indexOf(GOAL_BLOCK_EVIDENCE_SEPARATOR, evidenceIndex + 1)
	) {
		for (
			let noPathIndex = pause.reason.indexOf(GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR, evidenceIndex + GOAL_BLOCK_EVIDENCE_SEPARATOR.length);
			noPathIndex >= 0;
			noPathIndex = pause.reason.indexOf(GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR, noPathIndex + 1)
		) {
			const proof = {
				blocker: pause.reason.slice(GOAL_BLOCK_REASON_PREFIX.length, evidenceIndex).trim(),
				evidence: pause.reason.slice(evidenceIndex + GOAL_BLOCK_EVIDENCE_SEPARATOR.length, noPathIndex).trim(),
				whyNoAutonomousPathRemains: pause.reason.slice(noPathIndex + GOAL_BLOCK_NO_AUTONOMOUS_PATH_SEPARATOR.length).trim(),
				unblockCondition: pause.suggestedAction.trim(),
			};
			try {
				const encoded = goalBlockedPause(proof);
				if (encoded.reason === pause.reason && encoded.suggestedAction === pause.suggestedAction) {
					return { reason: pause.reason, suggestedAction: pause.suggestedAction };
				}
			} catch {
				// This marker pair does not describe a complete producer-owned proof.
			}
		}
	}
	return null;
}

export function isGoalBlockedPause(pause: GoalPause | undefined): boolean {
	return parseGoalBlockedPause(pause) !== null;
}
export type GoalAuditRejection = Static<typeof GoalAuditRejectionSchema>;
export type GoalCompletion = Static<typeof GoalCompletionSchema>;
export const GoalAuditEventSchema = Type.Object({
	version: Type.Literal(GOAL_AUDIT_EVENT_VERSION),
	goalId: Type.String({ minLength: 1, maxLength: GOAL_ID_MAX_LENGTH }),
	active: Type.Boolean(),
	emittedAt: Type.String({ minLength: 1, maxLength: GOAL_TIMESTAMP_MAX_LENGTH }),
}, { additionalProperties: false });

export type Goal = Static<typeof GoalSchema>;
export type GoalState = Static<typeof GoalStateSchema>;
export type GoalProposal = Static<typeof GoalProposalSchema>;
export type GoalAuditEvent = Static<typeof GoalAuditEventSchema>;

function record(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: null;
}

function nonEmptyString(value: unknown, maxLength = Number.POSITIVE_INFINITY): value is string {
	return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength;
}

function hasOnlyKeys(raw: Record<string, unknown>, allowed: readonly string[]): boolean {
	const keys = new Set(allowed);
	return Object.keys(raw).every((key) => keys.has(key));
}

function validUsage(value: unknown): value is GoalUsage {
	const raw = record(value);
	return !!raw && hasOnlyKeys(raw, ["tokensUsed", "activeSeconds"])
		&& typeof raw.tokensUsed === "number" && Number.isFinite(raw.tokensUsed) && raw.tokensUsed >= 0
		&& typeof raw.activeSeconds === "number" && Number.isFinite(raw.activeSeconds) && raw.activeSeconds >= 0;
}

export function isGoal(value: unknown): value is Goal {
	const raw = record(value);
	if (!raw || !hasOnlyKeys(raw, ["id", "objective", "status", "autoContinue", "usage", "createdAt", "updatedAt", "pause", "lastAuditRejection", "completion"])) return false;
	if (!nonEmptyString(raw.id, GOAL_ID_MAX_LENGTH) || !nonEmptyString(raw.objective, GOAL_OBJECTIVE_MAX_LENGTH)) return false;
	if (raw.status !== "active" && raw.status !== "paused" && raw.status !== "complete") return false;
	if (raw.autoContinue !== (raw.status === "active") || !validUsage(raw.usage)) return false;
	if (!nonEmptyString(raw.createdAt, GOAL_TIMESTAMP_MAX_LENGTH) || !nonEmptyString(raw.updatedAt, GOAL_TIMESTAMP_MAX_LENGTH)) return false;
	const pause = raw.pause === undefined ? null : record(raw.pause);
	if (raw.pause !== undefined && (!pause || !hasOnlyKeys(pause, ["reason", "suggestedAction"]) || !nonEmptyString(pause.reason, GOAL_PAUSE_REASON_MAX_LENGTH) || (pause.suggestedAction !== undefined && !nonEmptyString(pause.suggestedAction, GOAL_PAUSE_SUGGESTED_ACTION_MAX_LENGTH)))) return false;
	const rejection = raw.lastAuditRejection === undefined ? null : record(raw.lastAuditRejection);
	if (raw.lastAuditRejection !== undefined && (!rejection || !hasOnlyKeys(rejection, ["rejectedAt", "report"]) || !nonEmptyString(rejection.rejectedAt, GOAL_TIMESTAMP_MAX_LENGTH) || !nonEmptyString(rejection.report, GOAL_AUDIT_REJECTION_REPORT_MAX_LENGTH))) return false;
	const completion = raw.completion === undefined ? null : record(raw.completion);
	if (raw.completion !== undefined && (!completion || !hasOnlyKeys(completion, ["approvedAt", "summary", "auditorReport"]) || !nonEmptyString(completion.approvedAt, GOAL_TIMESTAMP_MAX_LENGTH) || !nonEmptyString(completion.summary, GOAL_COMPLETION_SUMMARY_MAX_LENGTH) || !nonEmptyString(completion.auditorReport, GOAL_COMPLETION_AUDITOR_REPORT_MAX_LENGTH))) return false;
	return true;
}

export function isGoalState(value: unknown): value is GoalState {
	const raw = record(value);
	return !!raw && hasOnlyKeys(raw, ["schemaVersion", "revision", "goal"])
		&& raw.schemaVersion === GOAL_SCHEMA_VERSION
		&& typeof raw.revision === "number" && Number.isSafeInteger(raw.revision) && raw.revision >= 0
		&& (raw.goal === null || isGoal(raw.goal));
}

export function parseGoalState(value: unknown): GoalState | null {
	return isGoalState(value) ? structuredClone(value) : null;
}

export function isGoalProposal(value: unknown): value is GoalProposal {
	const raw = record(value);
	if (!raw || !hasOnlyKeys(raw, ["schemaVersion", "revision", "proposal"])) return false;
	if (raw.schemaVersion !== GOAL_SCHEMA_VERSION || typeof raw.revision !== "number" || !Number.isSafeInteger(raw.revision) || raw.revision < 0) return false;
	if (raw.proposal === null) return true;
	const proposal = record(raw.proposal);
	return !!proposal && hasOnlyKeys(proposal, ["kind", "objective", "currentObjective"])
		&& (proposal.kind === "create" || proposal.kind === "tweak")
		&& nonEmptyString(proposal.objective, GOAL_OBJECTIVE_MAX_LENGTH)
		&& (proposal.currentObjective === undefined || nonEmptyString(proposal.currentObjective, GOAL_OBJECTIVE_MAX_LENGTH));
}

export function parseGoalProposal(value: unknown): GoalProposal | null {
	return isGoalProposal(value) ? structuredClone(value) : null;
}

export function isGoalAuditEvent(value: unknown): value is GoalAuditEvent {
	const raw = record(value);
	return !!raw && hasOnlyKeys(raw, ["version", "goalId", "active", "emittedAt"])
		&& raw.version === GOAL_AUDIT_EVENT_VERSION
		&& nonEmptyString(raw.goalId, GOAL_ID_MAX_LENGTH)
		&& typeof raw.active === "boolean"
		&& nonEmptyString(raw.emittedAt, GOAL_TIMESTAMP_MAX_LENGTH);
}

export function parseGoalAuditEvent(value: unknown): GoalAuditEvent | null {
	return isGoalAuditEvent(value) ? structuredClone(value) : null;
}
