// Query state: QueryContext class + context stack.
//
// All per-query and per-turn mutable state lives here. Reentrant queries
// (subagents) push the parent context onto a stack and get a fresh instance.
// Adding a new field = one property on the class.
//
// Extracted from index.ts so tests can import without activating the extension.

import { AsyncLocalStorage } from "node:async_hooks";
import type { AssistantMessage, AssistantMessageEventStream, Model } from "@earendil-works/pi-ai";
import type { McpResult } from "./extract-tool-results.js";
import type { PromptInput } from "./prompt-input.js";

export interface PendingToolCall {
	toolName: string;
	resolve: (result: McpResult) => void;
}

export interface TurnToolCallRecord {
	id: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

export interface ClaimedToolCall {
	toolCallId?: string;
	match: "tool-args" | "tool-name" | "none";
	ambiguous: boolean;
	available: number;
}

export interface ToolResultProgress {
	expectedIds: string[];
	deliveredIds: string[];
	resolvedIds: string[];
	waitingIds: string[];
	queuedIds: string[];
	unmatchedResultIds: string[];
	missingDeliveredIds: string[];
	unresolvedIds: string[];
	toolNames: Array<{ name: string; count: number }>;
	expectedCount: number;
	deliveredCount: number;
	resolvedCount: number;
	waitingCount: number;
	queuedCount: number;
	unmatchedResultCount: number;
}

function normalizeForCompare(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeForCompare);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			const child = (value as Record<string, unknown>)[key];
			if (child !== undefined) out[key] = normalizeForCompare(child);
		}
		return out;
	}
	return value;
}

function argsKey(value: unknown): string {
	return JSON.stringify(normalizeForCompare(value ?? {}));
}

function sameArgs(left: unknown, right: unknown): boolean {
	return argsKey(left) === argsKey(right);
}

function unique(values: Iterable<string | undefined>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		if (!value || seen.has(value)) continue;
		seen.add(value);
		out.push(value);
	}
	return out;
}

export function createTurnOutput(model: Model<any>): AssistantMessage {
	return {
		role: "assistant", content: [],
		api: model.api, provider: model.provider, model: model.id,
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop", timestamp: Date.now(),
	};
}

export class QueryContext {
	// Query-scoped (fully isolated per query)
	activeQuery: unknown | null = null;
	// Open prompt stream of the active query; steering messages are pushed here.
	input: PromptInput | null = null;
	// Stops tracking the active query. Called before Pi is told a turn ended, so
	// Pi's next call starts a fresh query instead of reaching this one.
	release: (() => void) | null = null;
	currentPiStream: AssistantMessageEventStream | null = null;
	latestCursor = 0;
	pendingToolCalls = new Map<string, PendingToolCall>();
	pendingResults = new Map<string, McpResult>();
	turnToolCallIds: string[] = [];
	turnToolCalls: TurnToolCallRecord[] = [];
	assistantMessageId: string | null = null;
	claimedToolCallIds = new Set<string>();
	emittedToolCallIds = new Set<string>();
	deliveredToolResultIds = new Set<string>();
	resolvedToolResultIds = new Set<string>();
	unmatchedToolResultIds = new Set<string>();
	reportedToolResultMismatch = false;
	handledTerminalError = false;

	// Per-turn (reset together)
	turnOutput: AssistantMessage | null = null;
	turnStarted = false;
	turnSawStreamEvent = false;
	turnSawToolCall = false;
	// The API message whose stream events are arriving: message_start seen,
	// message_stop not yet.
	streamingMessageId: string | null = null;

	get turnBlocks(): Array<any> {
		if (!this.turnOutput) throw new Error("turnBlocks accessed before resetTurnState");
		return this.turnOutput.content;
	}

	resetTurnState(model: Model<any>): void {
		this.turnOutput = createTurnOutput(model);
		this.turnStarted = false;
		this.turnSawStreamEvent = false;
		this.turnSawToolCall = false;
		this.streamingMessageId = null;
		this.handledTerminalError = false;
		// Tool-call tracking is NOT reset here — it persists across the
		// tool-result delivery callback for the same assistant message. New
		// assistant messages call resetToolTracking() explicitly.
	}

	resetToolTracking(): void {
		this.turnToolCallIds = [];
		this.turnToolCalls = [];
		this.assistantMessageId = null;
		this.claimedToolCallIds.clear();
		this.emittedToolCallIds.clear();
		this.deliveredToolResultIds.clear();
		this.resolvedToolResultIds.clear();
		this.unmatchedToolResultIds.clear();
	}

	recordToolCall(id: string | undefined, toolName: string, args: Record<string, unknown> = {}): void {
		if (!id) return;
		if (!this.turnToolCallIds.includes(id)) this.turnToolCallIds.push(id);
		const existing = this.turnToolCalls.find((call) => call.id === id);
		if (existing) {
			existing.toolName = toolName;
			existing.arguments = args;
			return;
		}
		this.turnToolCalls.push({ id, toolName, arguments: args });
	}

	updateToolCallArgs(id: string | undefined, args: Record<string, unknown>): void {
		if (!id) return;
		const existing = this.turnToolCalls.find((call) => call.id === id);
		if (existing) existing.arguments = args;
	}

	hasRecordedToolCall(id: string | undefined): boolean {
		return Boolean(id && (this.turnToolCallIds.includes(id) || this.turnToolCalls.some((call) => call.id === id)));
	}

	markToolCallEmitted(id: string | undefined): void { if (id) this.emittedToolCallIds.add(id); }

	unemittedToolCalls(): TurnToolCallRecord[] { return this.turnToolCalls.filter((call) => !this.emittedToolCallIds.has(call.id)); }

	claimToolCall(toolName: string, args: Record<string, unknown> = {}): ClaimedToolCall {
		const unclaimed = this.turnToolCalls.filter((call) => !this.claimedToolCallIds.has(call.id));
		const byName = unclaimed.filter((call) => call.toolName === toolName);
		const exact = byName.filter((call) => sameArgs(call.arguments, args));
		let chosen: TurnToolCallRecord | undefined;
		let match: ClaimedToolCall["match"] = "none";
		let ambiguous = false;

		if (exact.length > 0) {
			chosen = exact[0];
			match = "tool-args";
			ambiguous = exact.length > 1;
		} else if (byName.length === 1) {
			// Exact-args matching exists to disambiguate PARALLEL calls of the same
			// tool. With a single unclaimed call of this name there is nothing else
			// the handler could belong to, so claim it even when the arguments
			// differ. They legitimately differ in two ways:
			//   1. The SDK can invoke the handler after content_block_start but
			//      before input_json_delta/content_block_stop finalizes arguments.
			//   2. MCP validates handler input against the tool's declared Zod
			//      schema, which STRIPS keys the schema does not declare. The
			//      recorded tool_use block keeps the model's raw arguments, so any
			//      undeclared-but-sent key leaves the two sides permanently unequal.
			// Refusing to claim here strands the real tool result in pendingResults
			// and hands the model a bridge internal error instead of its output.
			chosen = byName[0];
			match = "tool-name";
		}

		if (!chosen) return { match: "none", ambiguous: false, available: unclaimed.length };
		this.claimedToolCallIds.add(chosen.id);
		return { toolCallId: chosen.id, match, ambiguous, available: unclaimed.length };
	}

	markToolResultDelivered(id: string | undefined): void {
		if (id) this.deliveredToolResultIds.add(id);
	}

	markToolResultResolved(id: string | undefined): void {
		if (id) this.resolvedToolResultIds.add(id);
	}

	markToolResultUnmatched(id: string | undefined): void {
		if (id) this.unmatchedToolResultIds.add(id);
	}

	toolResultProgress(): ToolResultProgress {
		const expectedIds = unique([
			...this.turnToolCalls.map((call) => call.id),
			...this.turnToolCallIds,
		]);
		const deliveredIds = unique(this.deliveredToolResultIds);
		const resolvedIds = unique(this.resolvedToolResultIds);
		const waitingIds = unique(this.pendingToolCalls.keys());
		const queuedIds = unique(this.pendingResults.keys());
		const unmatchedResultIds = unique(this.unmatchedToolResultIds);
		const missingDeliveredIds = expectedIds.filter((id) => !this.deliveredToolResultIds.has(id));
		const unresolvedIds = expectedIds.filter((id) => !this.resolvedToolResultIds.has(id));
		const affectedIds = new Set([...missingDeliveredIds, ...unresolvedIds, ...waitingIds, ...queuedIds, ...unmatchedResultIds]);
		const counts = new Map<string, number>();
		for (const call of this.turnToolCalls) {
			if (affectedIds.size > 0 && !affectedIds.has(call.id)) continue;
			counts.set(call.toolName, (counts.get(call.toolName) ?? 0) + 1);
		}
		return {
			expectedIds,
			deliveredIds,
			resolvedIds,
			waitingIds,
			queuedIds,
			unmatchedResultIds,
			missingDeliveredIds,
			unresolvedIds,
			toolNames: [...counts.entries()]
				.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
				.map(([name, count]) => ({ name, count })),
			expectedCount: expectedIds.length,
			deliveredCount: deliveredIds.length,
			resolvedCount: resolvedIds.length,
			waitingCount: waitingIds.length,
			queuedCount: queuedIds.length,
			unmatchedResultCount: unmatchedResultIds.length,
		};
	}
}

export function assertInitialQuerySucceeded(queryCtx: QueryContext): void {
	if (!queryCtx.reportedToolResultMismatch && !queryCtx.handledTerminalError && queryCtx.turnOutput?.stopReason !== "error") return;
	throw new Error(queryCtx.turnOutput?.errorMessage ?? "Claude bridge initial query failed");
}

export interface QueryRuntimeState {
	current: QueryContext;
	stack: QueryContext[];
}

export function createQueryRuntimeState(): QueryRuntimeState {
	return { current: new QueryContext(), stack: [] };
}

const defaultState = createQueryRuntimeState();
const queryRuntimeStorage = new AsyncLocalStorage<QueryRuntimeState>();

export function runWithQueryRuntime<T>(state: QueryRuntimeState, callback: () => T): T {
	return queryRuntimeStorage.run(state, callback);
}

function state(): QueryRuntimeState {
	return queryRuntimeStorage.getStore() ?? defaultState;
}

export function ctx(): QueryContext { return state().current; }

export function stackDepth(): number { return state().stack.length; }

export function pushContext(): void {
	const runtime = state();
	if (!runtime.current.activeQuery) throw new Error("pushContext() called with no active query");
	runtime.stack.push(runtime.current);
	runtime.current = new QueryContext();
}

export function popContext(): void {
	const runtime = state();
	if (runtime.stack.length === 0) throw new Error("popContext() called with empty stack");
	runtime.current = runtime.stack.pop()!;
}

// Test-only: drop all state so test files can start from a clean module.
// Not called from production.
export function resetStack(): void {
	const runtime = state();
	runtime.current = new QueryContext();
	runtime.stack.length = 0;
}
