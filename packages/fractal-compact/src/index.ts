import {
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionBeforeCompactEvent,
	serializeConversation,
} from "@earendil-works/pi-coding-agent";

const FRACTAL_COMPACT_SYSTEM_PROMPT = `You are a context compaction assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a high-fidelity structured summary for the SAME session to continue after compaction.

Do NOT continue the conversation. Do NOT answer questions from the conversation. Do NOT add preamble. ONLY output the requested numbered summary.`;

const FRACTAL_COMPACT_PROMPT = `Ben's personal compaction prompt. ("Fractal" is his handle — not a claim about the structure.) It replaces the stock /compact because the stock one preserves the task but loses the method: after a default compaction the agent keeps working the problem but does it a different way — different commands, different log format, different output style — and Ben has to re-establish the workflow he already approved. This prompt exists to kill that. Same session, same agent, same methodology — across the compaction boundary.

Produce a high-fidelity, structured summary of the current session. It must contain enough detail that THE RESUMED SESSION can pick up exactly where work left off — without asking clarifying questions, without redoing finished work, without drifting from intent, and without changing the way it works.

## The core obligation: preserve methodology, not just task

The standard failure this prompt fixes: a resumed agent understands what to do but forgets how it was doing it, and silently switches approach. That inconsistency — not incorrectness — is the problem. Ben still expects the work done right; he additionally demands it be done the same way it was being done before, with the same commands, tools, monitors, scripts, and output formats he already saw and approved. Consistency is what makes a compacted-context agent trustworthy. Reinventing the approach every compaction reads as schizophrenia and destroys that trust.

So: capturing the operating methodology (section 3 below) is not optional flavor — it is the primary reason this prompt exists. Give it as much care as the task itself.

## How to Produce the Summary

Think through the entire conversation chronologically. For each phase, identify: what the user asked for, what was done, what was decided, what changed, what remains — and the concrete way the work was carried out (the exact commands, tools, scripts, monitors, logging, and output conventions, especially any the user reacted to or approved). Then produce the summary below.

Respond with only the summary in the structure below. Do not acknowledge these instructions, do not add preamble, do not wrap the whole thing in code fences. Code fences around individual snippets/commands inside the summary are expected and encouraged.

## Summary Structure

1. Session at a Glance
   [3-5 lines: what this session is doing, where it currently stands, and the single next action. Orientation for the resumed agent before it reads the detail below.]

2. Primary Request and Intent
   [What the user actually wants, in full. Not a one-liner — capture the real scope, constraints, and any evolution of intent across the session. If the user changed direction, note what changed and why.]

3. Operating Methodology — CONTINUE USING THIS EXACTLY
   The way work is being done in this session. The resumed agent MUST keep using these same approaches rather than inventing new ones. Capture, with verbatim runnable detail wherever possible:
   - Exact commands / invocations that were used and worked — copy them so they can be re-run verbatim (build commands, search commands, monitors, one-liners, env exports, etc.). Include the precise flags.
   - Tools, scripts, monitors, or helpers created or adopted this session — where they live (paths) and exactly how they are invoked.
   - Session-continuity conventions in use — commands, scripts, status messages, handoff format, or \`read-agent-sessions\` lookups that matter going forward. Mention manual notes only if the user explicitly asked for them.
   - Output / response formats the user explicitly approved or asked for, and any style conventions observed (tone, structure, verbosity).
   - Verification rituals used — how "it works" was actually confirmed this session (which command, which check, what counted as proof).
   - Any approach the user blessed verbatim, and any constraint on HOW to work the user imposed. Quote these.
   If a method genuinely needs to change going forward, the resumed agent must flag it explicitly — never silently switch.

4. Working State
   The live environment the resumed agent inherits:
   - Repo / cwd, current branch, and worktree path (if working in one).
   - Uncommitted / modified files (what's dirty and why).
   - Last relevant commit(s): SHA + subject.
   - Background processes, servers, tmux windows, or workers running — and how to inspect / reattach / stop them.
   - Any session-established env quirks (exported vars, sudo timestamp primed, services started, ports in use).

5. Key Technical Concepts
   - [Technology, framework, pattern, or domain concept relevant to the work]
   - [...]

6. Files and Code
   For each file that was read, created, or modified — in order of relevance:
   - [file path]
     - Why it matters: [one line]
     - What changed: [description of edits, or "read-only" if just examined]
     - Key snippet (if the exact content matters for continuation):
       [code block]

7. Decisions Made
   - [Decision]: [Why it was made, and any alternatives that were rejected]
   - [...]

8. Errors Encountered and Fixes Applied
   - [Error description]:
     - Root cause: [what was actually wrong]
     - Fix: [what was done]
     - User feedback: [if the user corrected or redirected, note it verbatim]
   - [...]

9. User Messages and Corrections
   Capture the substantive user messages — quote verbatim wherever the exact wording carries signal a paraphrase would lose (corrections, hard constraints, intent pivots, explicit "don't do X", approvals of an approach). These are critical; a resumed agent that repeats a corrected mistake or drops an approved method is the worst failure mode.
   - [User message, quoted or closely paraphrased]
   - [...]

10. Work Written So Far — DO NOT REDO
    [What has already been written/changed and must NOT be re-done. Be explicit — this is the primary defense against the resumed agent re-treading ground. Distinguish, where it matters, work that was written-and-verified from work that was written-but-not-yet-verified, so the resumed agent knows what still needs checking versus what is settled.]

11. Pending / In-Progress Work
    - [Task]: [Current state — what's done, what remains]
    - [...]

12. Immediate Next Step
    [The single next action that continues the most recent line of work. Must be directly aligned with the user's latest explicit request. Include verbatim quotes from the conversation showing what was being worked on and where it left off, so there is zero drift in interpretation. If the last task was concluded and nothing is pending, state that explicitly rather than inventing follow-up work.]

13. Recall — the full transcript is the ground truth
    This summary is lossy. The complete session transcript is not. The user expects you to remember everything from before the compaction — so STRIVE to. If anything below is thin, ambiguous, or you are about to redo or re-approach something you handled before, STOP and read the raw transcript before acting, using the read-agent-sessions skill.
    - This session: [session id / transcript path if known — fill it in; otherwise instruct: find the most recent session for this project/topic via read-agent-sessions and read it.]
    - Do not make the user re-explain what you already knew. Pulling the transcript is cheaper than asking, and far cheaper than diverging.

## Rules

- Methodology is first-class. Section 3 is the reason this prompt exists. A resumed agent that finishes the task but uses different commands, tools, or output format than the user already approved has FAILED — consistency is what earns trust. Capture the how, verbatim and runnable, not just the what.
- NEVER SACRIFICE NUANCE FOR BREVITY. This is a handoff, not an abstract. Include file paths, function names, code snippets, exact commands, error messages, and exact user quotes wherever they matter.
- Written work is sacred (section 10). It exists to stop the resumed agent from redoing things. Be thorough — if something is written, say so clearly, and say whether it was verified.
- User corrections and approvals are high-priority. If the user told you to do something differently — or blessed a specific way of working — that must appear (quoted). A resumed agent that repeats a corrected mistake, or drops an approved method, is the worst failure mode.
- Point at the transcript (section 13). Always include the recall directive so the resumed agent knows to read the raw session via read-agent-sessions rather than guess or ask.
- No fabrication. Only summarize what actually happened. Do not infer next steps the user didn't ask for. Do not assume intent beyond what was stated. Do not invent a methodology that wasn't actually used.
- No meta-commentary. Do not say "Here is the summary" or "I've compiled the following." Just output the numbered sections.`;

function textContent(parts: Array<{ type: string; text?: string }>): string {
	return parts
		.filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("\n");
}

function fileLists(fileOps: { read: Set<string>; written: Set<string>; edited: Set<string> }) {
	const modified = new Set([...fileOps.written, ...fileOps.edited]);
	return {
		readFiles: [...fileOps.read].filter((file) => !modified.has(file)).sort(),
		modifiedFiles: [...modified].sort(),
	};
}

function fileTagAppendix(readFiles: string[], modifiedFiles: string[]): string {
	const sections: string[] = [];
	if (readFiles.length > 0) sections.push(`<read-files>\n${readFiles.join("\n")}\n</read-files>`);
	if (modifiedFiles.length > 0) sections.push(`<modified-files>\n${modifiedFiles.join("\n")}\n</modified-files>`);
	return sections.length > 0 ? `\n\n${sections.join("\n\n")}` : "";
}

function activeReasoning(pi: ExtensionAPI) {
	const thinkingLevel = pi.getThinkingLevel();
	return thinkingLevel === "off" ? undefined : thinkingLevel;
}

const OPENAI_TEXT_PART_LIMIT = 10_485_760;
const DEFAULT_SAFE_TEXT_PART_LIMIT = 9_500_000;

function safeTextPartLimit(): number {
	const raw = process.env.PI_FRACTAL_COMPACT_MAX_TEXT_CHARS;
	if (!raw) return DEFAULT_SAFE_TEXT_PART_LIMIT;
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_SAFE_TEXT_PART_LIMIT;
	return Math.min(parsed, OPENAI_TEXT_PART_LIMIT - 1_000);
}

type MaybeTextContentMessage = {
	role?: string;
	customType?: string;
	content?: string | Array<{ type: string; text?: string }>;
};

function textFromMessage(message: MaybeTextContentMessage): string | undefined {
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return undefined;
	const textParts = message.content
		.filter((part): part is { type: string; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text);
	return textParts.length > 0 ? textParts.join("\n") : undefined;
}

function withStringContent<T extends MaybeTextContentMessage>(message: T, content: string): T {
	return { ...message, content };
}

function goalContinuationKey(message: MaybeTextContentMessage): string | undefined {
	if (message.role !== "custom" || message.customType !== "pi-goal-event") return undefined;
	const text = textFromMessage(message);
	if (!text?.startsWith("<pi_goal_continuation ")) return undefined;
	const match = text.match(/^<pi_goal_continuation\s+goal_id="([^"]+)"\s+kind="([^"]+)"/);
	return match ? `${match[1]}:${match[2]}` : undefined;
}

function compactRepeatedGoalContinuations<T extends MaybeTextContentMessage>(messages: T[]) {
	const groups = new Map<string, { firstIndex: number; lastIndex: number; count: number; chars: number }>();
	messages.forEach((message, index) => {
		const key = goalContinuationKey(message);
		if (!key) return;
		const chars = textFromMessage(message)?.length ?? 0;
		const group = groups.get(key);
		if (group) {
			group.lastIndex = index;
			group.count += 1;
			group.chars += chars;
		} else {
			groups.set(key, { firstIndex: index, lastIndex: index, count: 1, chars });
		}
	});

	let collapsedCount = 0;
	let collapsedChars = 0;
	const compacted = messages.flatMap((message, index): T[] => {
		const key = goalContinuationKey(message);
		const group = key ? groups.get(key) : undefined;
		if (!key || !group || group.count <= 1) return [message];
		if (index === group.firstIndex) {
			const [goalId, kind] = key.split(":", 2);
			const omittedCount = group.count - 1;
			const omittedChars = group.chars - (textFromMessage(messages[group.lastIndex])?.length ?? 0);
			collapsedCount += omittedCount;
			collapsedChars += omittedChars;
			return [
				withStringContent(
					message,
					`<pi_goal_continuation_compaction_note goal_id="${goalId}" kind="${kind}">\n[COMPACTION NOTE]\nCollapsed ${omittedCount} repeated active-goal continuation checkpoint message(s), totaling ${omittedChars} characters before compaction. These were Pi goal-system reminders, not user-authored task changes. The latest full checkpoint for this goal/kind is kept later in the transcript slice; the active goal file and raw session transcript remain authoritative if exact checkpoint text is needed.\n</pi_goal_continuation_compaction_note>`,
				),
			];
		}
		if (index === group.lastIndex) return [message];
		return [];
	});

	return { messages: compacted, collapsedCount, collapsedChars };
}

async function generateFractalSummary(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	event: SessionBeforeCompactEvent,
): Promise<string> {
	if (!ctx.model) throw new Error("No model selected");

	const { preparation, customInstructions, signal } = event;
	const { messagesToSummarize, turnPrefixMessages, previousSummary, tokensBefore, settings } = preparation;
	const goalCompaction = compactRepeatedGoalContinuations([...messagesToSummarize, ...turnPrefixMessages]);
	const conversationText = serializeConversation(convertToLlm(goalCompaction.messages));
	const sessionFile = ctx.sessionManager.getSessionFile() ?? "unpersisted/unknown session file";
	const sessionId = ctx.sessionManager.getSessionId();
	const previousContext = previousSummary ? `<previous-summary>\n${previousSummary}\n</previous-summary>\n\n` : "";
	const customFocus = customInstructions
		? `\n\nAdditional /compact instructions from the user:\n${customInstructions}\n`
		: "";
	const splitTurnNote =
		turnPrefixMessages.length > 0
			? "\n\nNote: part of the most recent oversized turn is retained outside this summary. Summarize the retained prefix so the kept suffix remains understandable."
			: "";

	const prompt = `<session-metadata>\nSession ID: ${sessionId}\nSession transcript path: ${sessionFile}\nCurrent cwd: ${ctx.cwd}\nTokens before compaction: ${tokensBefore}\n</session-metadata>\n\n${previousContext}<conversation>\n${conversationText}\n</conversation>${splitTurnNote}${customFocus}\n\n${FRACTAL_COMPACT_PROMPT}`;
	const textPartLimit = safeTextPartLimit();
	if (prompt.length > textPartLimit) {
		throw new Error(
			`Fractal compaction prompt is ${prompt.length} characters after collapsing ${goalCompaction.collapsedCount} repeated goal checkpoint(s) (${goalCompaction.collapsedChars} chars); safe text-part limit is ${textPartLimit}. Compaction cancelled before provider call.`,
		);
	}

	const maxTokens = Math.min(
		Math.floor(0.9 * settings.reserveTokens),
		ctx.model.maxTokens > 0 ? ctx.model.maxTokens : Number.POSITIVE_INFINITY,
	);
	if (event.summarizeNativeContext) {
		const response = await event.summarizeNativeContext({
			systemPrompt: FRACTAL_COMPACT_SYSTEM_PROMPT,
			messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
		}, { maxTokens });
		if (response.stopReason !== "stop") throw new Error("Native-to-text summary is incomplete");
		return textContent(response.content).trim();
	}

	// Summarize through the model registry, which is the same route a normal turn
	// takes: it resolves auth, normalizes the Context (folding the system prompt
	// into the transcript) and dispatches to the registered provider. Going direct
	// to pi-ai's completeSimple only reaches providers backed by a real api module,
	// so extension-registered providers with a synthetic api would fail.
	const response = await ctx.modelRegistry
		.streamSimple(
			ctx.model,
			{
				systemPrompt: FRACTAL_COMPACT_SYSTEM_PROMPT,
				messages: [{ role: "user", content: [{ type: "text", text: prompt }], timestamp: Date.now() }],
			},
			{
				maxTokens,
				signal,
				reasoning: ctx.model.reasoning ? activeReasoning(pi) : undefined,
				sessionId,
			},
		)
		.result();

	if (response.stopReason === "error") throw new Error(response.errorMessage || "Compaction summarization failed");
	if (response.stopReason === "aborted") throw new Error("Compaction summarization aborted");

	return textContent(response.content).trim();
}

function emitCompactionUpdate(pi: ExtensionAPI, status: "running" | "completed"): void {
	pi.events?.emit?.("aria-local:compaction-update", { status });
}

export default function fractalCompactExtension(pi: ExtensionAPI) {
	pi.on("session_before_compact", async (event, ctx) => {
		emitCompactionUpdate(pi, "running");
		ctx.ui.setStatus("fcompact", "fractal compacting…");
		try {
			const summary = await generateFractalSummary(pi, ctx, event);
			if (!summary) {
				ctx.ui.notify("Fractal compaction returned an empty summary; compaction cancelled", "error");
				return { cancel: true };
			}

			const { readFiles, modifiedFiles } = fileLists(event.preparation.fileOps);
			ctx.ui.notify("Fractal compaction summary generated", "info");
			return {
				compaction: {
					summary: `${summary}${fileTagAppendix(readFiles, modifiedFiles)}`,
					firstKeptEntryId: event.preparation.firstKeptEntryId,
					tokensBefore: event.preparation.tokensBefore,
					details: { readFiles, modifiedFiles },
				},
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (!event.signal.aborted)
				ctx.ui.notify(
					`Fractal compaction failed; compaction cancelled instead of using Pi default: ${message}`,
					"error",
				);
			return { cancel: true };
		} finally {
			ctx.ui.setStatus("fcompact", undefined);
		}
	});

	pi.on("session_compact", async () => {
		emitCompactionUpdate(pi, "completed");
	});
}
