import { calculateCost, type AssistantMessage, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions, type Tool } from "@earendil-works/pi-ai";
import * as piAi from "@earendil-works/pi-ai";
import { transformMessages } from "@earendil-works/pi-ai/api/transform-messages";
import { type ExtensionAPI, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { query, type EffortLevel, type McpSdkServerConfigWithInstance, type SDKMessage, type SDKUserMessage, type SettingSource, type SpawnOptions, type SpawnedProcess } from "@anthropic-ai/claude-agent-sdk";
import type { Base64ImageSource, ContentBlockParam, MessageParam } from "@anthropic-ai/sdk/resources";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { createSession, deleteSession, openSession, repairToolPairing } from "cc-session-io";
import { AsyncLocalStorage } from "node:async_hooks";
import { spawn as spawnProcess } from "child_process";
import { createHash } from "crypto";
import { accessSync, appendFileSync, chmodSync, constants as fsConstants, mkdirSync, readFileSync, realpathSync, statSync } from "fs";
import { resolve as pathResolve } from "path";
import { homedir } from "os";
import { dirname, join } from "path";
import { PROVIDER_ID, messageContentToText, convertPiMessages } from "./convert.js";
import { resolveClaudeCodeExecutable } from "./executable-resolution.js";
import { FABLE_FALLBACK_MODEL_ID, FABLE_MODEL_ID, buildModels, fallbackModelForPrimaryModel } from "./models.js";
import { createClaudeModelCatalog, discoverClaudeModels } from "./model-discovery.js";
import { PromptInput } from "./prompt-input.js";
import { CLAUDE_USAGE_EVENT, createClaudeUsageReader, type ClaudeUsageReader } from "./usage.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX, extractSkillsBlock } from "./skills.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { extractAllToolResults as _extractAllToolResults, type McpResult } from "./extract-tool-results.js";
import { QueryContext, assertInitialQuerySucceeded, createQueryRuntimeState, createTurnOutput, runWithQueryRuntime, ctx, stackDepth, pushContext, popContext, type QueryRuntimeState } from "./query-state.js";
import { findUnpairedToolUses, summarizeMissingToolNames, type MissingToolResult } from "./tool-pairing-audit.js";
import { loadConfig, normalizeEffortLevel, recordProjectTrust, type Config } from "./config.js";
import { extractAgentsAppend } from "./agents-md.js";
import { buildPromptContextAppend } from "./prompt-context.js";
import { resolveGetModels } from "./pi-ai-compat.js";

// Compat (#2): use factory if available (pi-ai ≥0.66), else fall back to constructor (gsd-pi etc.)
const _piAi = piAi as any;
const getModels = await resolveGetModels(_piAi) as (provider: string) => Array<Model<any>>;
const newAssistantMessageEventStream: () => AssistantMessageEventStream =
	typeof _piAi.createAssistantMessageEventStream === "function"
		? _piAi.createAssistantMessageEventStream
		: () => new _piAi.AssistantMessageEventStream();

// --- Debug logging ---
// CLAUDE_BRIDGE_DEBUG=1 enables debug logging to ~/.pi/agent/claude-bridge.log

const DEBUG = process.env.CLAUDE_BRIDGE_DEBUG === "1";
const DEBUG_LOG_PATH = process.env.CLAUDE_BRIDGE_DEBUG_PATH || join(homedir(), ".pi", "agent", "claude-bridge.log");
const DEFAULT_DIAG_LOG_PATH = join(homedir(), ".pi", "agent", "claude-bridge-diag.log");

function diagLogPath(): string {
	return process.env.CLAUDE_BRIDGE_DIAG_PATH || DEFAULT_DIAG_LOG_PATH;
}

// Ensure log directories exist when debug is enabled
if (DEBUG) {
	try {
		mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
		mkdirSync(dirname(diagLogPath()), { recursive: true, mode: 0o700 });
	} catch {
		// If directory creation fails, debug functions will throw on first use
	}
}

declare const CLAUDE_BRIDGE_ISOLATED: boolean;

// Unique per module evaluation — confirms whether subagents share module state.
const moduleInstanceId = Math.random().toString(36).slice(2, 8);
const isolatedModule = typeof CLAUDE_BRIDGE_ISOLATED !== "undefined" && CLAUDE_BRIDGE_ISOLATED;

function debug(...args: unknown[]) {
	if (!DEBUG) return;
	const ts = new Date().toISOString();
	const fmt = (a: unknown): string => {
		if (typeof a === "string") return a;
		if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? "\n" + a.stack : ""}`;
		return JSON.stringify(a);
	};
	const msg = args.map(fmt).join(" ");
	try { appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`); } catch { /* debug is best effort */ }
}

export type ClaudeExecutableFileType = "elf" | "mach-o" | "pe" | "shebang-script" | "empty" | "unknown";

export interface ClaudeExecutablePreflightResult {
	path: string;
	realPath: string;
	cwd: string;
	realCwd: string;
	fileType: ClaudeExecutableFileType;
}

function errnoValue(err: unknown): string | number | undefined {
	return typeof (err as NodeJS.ErrnoException)?.errno === "number" ? (err as NodeJS.ErrnoException).errno : undefined;
}

function syscallValue(err: unknown): string | undefined {
	return typeof (err as NodeJS.ErrnoException)?.syscall === "string" ? (err as NodeJS.ErrnoException).syscall : undefined;
}

function pathValue(err: unknown): string | undefined {
	const value = (err as NodeJS.ErrnoException)?.path;
	return typeof value === "string" ? value : undefined;
}

function codeValue(err: unknown, fallback: string): string {
	const value = (err as NodeJS.ErrnoException)?.code;
	return typeof value === "string" ? value : fallback;
}

function displayValue(value: unknown): string {
	return value === undefined || value === null || value === "" ? "<none>" : String(value);
}

function makeClaudePreflightError(
	summary: string,
	details: { code: string; errno?: string | number; syscall?: string; path: string; cwd: string; fileType?: ClaudeExecutableFileType; realPath?: string; cause?: unknown },
): Error & NodeJS.ErrnoException & { cwd: string; fileType?: ClaudeExecutableFileType; realPath?: string } {
	const detail = [
		`code=${details.code}`,
		`errno=${displayValue(details.errno)}`,
		`syscall=${displayValue(details.syscall)}`,
		`path=${details.path}`,
		`cwd=${details.cwd}`,
		...(details.fileType ? [`fileType=${details.fileType}`] : []),
		...(details.realPath ? [`realPath=${details.realPath}`] : []),
	].join(" ");
	const error = new Error(`${summary} (${detail})`) as Error & NodeJS.ErrnoException & { cwd: string; fileType?: ClaudeExecutableFileType; realPath?: string };
	error.name = "ClaudeExecutablePreflightError";
	error.code = details.code;
	if (details.errno !== undefined) error.errno = typeof details.errno === "number" ? details.errno : Number(details.errno);
	if (details.syscall) error.syscall = details.syscall;
	error.path = details.path;
	error.cwd = details.cwd;
	if (details.fileType) error.fileType = details.fileType;
	if (details.realPath) error.realPath = details.realPath;
	if (details.cause !== undefined) (error as Error & { cause?: unknown }).cause = details.cause;
	return error;
}

export function classifyClaudeExecutableBytes(bytes: Uint8Array): ClaudeExecutableFileType {
	if (bytes.length === 0) return "empty";
	if (bytes.length >= 2 && bytes[0] === 0x23 && bytes[1] === 0x21) return "shebang-script";
	if (bytes.length >= 4 && bytes[0] === 0x7f && bytes[1] === 0x45 && bytes[2] === 0x4c && bytes[3] === 0x46) return "elf";
	if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return "pe";
	if (bytes.length >= 4) {
		const magic = bytes[0] * 0x1000000 + bytes[1] * 0x10000 + bytes[2] * 0x100 + bytes[3];
		if (
			magic === 0xfeedface ||
			magic === 0xfeedfacf ||
			magic === 0xcefaedfe ||
			magic === 0xcffaedfe ||
			magic === 0xcafebabe ||
			magic === 0xbebafeca
		) return "mach-o";
	}
	return "unknown";
}

export function preflightClaudeExecutable(path: string, cwd: string): ClaudeExecutablePreflightResult {
	let realCwd = cwd;
	try {
		const cwdStat = statSync(cwd);
		if (!cwdStat.isDirectory()) {
			throw makeClaudePreflightError("Claude Code spawn cwd preflight failed: cwd is not a directory.", {
				code: "ENOTDIR",
				syscall: "chdir",
				path: cwd,
				cwd,
			});
		}
		accessSync(cwd, fsConstants.X_OK);
		realCwd = realpathSync(cwd);
	} catch (err) {
		if ((err as Error).name === "ClaudeExecutablePreflightError") throw err;
		throw makeClaudePreflightError("Claude Code spawn cwd preflight failed: cwd is not reachable before spawning Claude Code.", {
			code: codeValue(err, "EACCES"),
			errno: errnoValue(err),
			syscall: syscallValue(err),
			path: pathValue(err) ?? cwd,
			cwd,
			cause: err,
		});
	}

	let realPath = path;
	try {
		const stat = statSync(path);
		if (!stat.isFile()) {
			throw makeClaudePreflightError("Claude Code executable preflight failed: resolved path is not a file.", {
				code: "EACCES",
				syscall: "exec",
				path,
				cwd,
			});
		}
		accessSync(path, fsConstants.X_OK);
		realPath = realpathSync(path);
	} catch (err) {
		if ((err as Error).name === "ClaudeExecutablePreflightError") throw err;
		throw makeClaudePreflightError("Claude Code executable preflight failed: cannot access resolved executable before spawning Claude Code.", {
			code: codeValue(err, "ENOENT"),
			errno: errnoValue(err),
			syscall: syscallValue(err),
			path: pathValue(err) ?? path,
			cwd,
			cause: err,
		});
	}

	let fileType: ClaudeExecutableFileType;
	try {
		fileType = classifyClaudeExecutableBytes(readFileSync(realPath).subarray(0, 16));
	} catch (err) {
		throw makeClaudePreflightError("Claude Code executable preflight failed: cannot read executable header before spawning Claude Code.", {
			code: codeValue(err, "EACCES"),
			errno: errnoValue(err),
			syscall: syscallValue(err),
			path: pathValue(err) ?? realPath,
			cwd,
			realPath,
			cause: err,
		});
	}

	if (!["elf", "mach-o", "pe", "shebang-script"].includes(fileType)) {
		throw makeClaudePreflightError("Claude Code executable preflight failed: executable header is not an ELF, Mach-O, PE, or shebang script.", {
			code: "ENOEXEC",
			syscall: "exec",
			path,
			cwd,
			fileType,
			realPath,
		});
	}

	return { path, realPath, cwd, realCwd, fileType };
}

function envFlagEnabled(value: string | undefined): boolean {
	return value === "1" || value?.toLowerCase() === "true";
}

export function wrapClaudeSpawnErrorForSdk(err: Error, options: SpawnOptions): Error & NodeJS.ErrnoException & { cwd: string; originalCode?: string; originalMessage?: string } {
	const originalCode = codeValue(err, "SPAWN_ERROR");
	const originalMessage = err.message;
	const spawnPath = pathValue(err) ?? options.command;
	const cwd = options.cwd ?? process.cwd();
	const detail = [
		`code=${originalCode}`,
		`errno=${displayValue(errnoValue(err))}`,
		`syscall=${displayValue(syscallValue(err))}`,
		`path=${spawnPath}`,
		`cwd=${cwd}`,
		`command=${options.command}`,
	].join(" ");
	const wrapped = new Error(`Claude Code spawn failed: ${originalMessage} (${detail})`) as Error & NodeJS.ErrnoException & { cwd: string; originalCode?: string; originalMessage?: string };
	wrapped.name = "ClaudeSpawnDiagnosticError";
	// The SDK special-cases code === ENOENT and replaces the message with its
	// generic "native binary not found" text. Preserve the original code in the
	// message/originalCode while using a bridge code so the SDK surfaces context.
	wrapped.code = originalCode === "ENOENT" ? "CLAUDE_BRIDGE_SPAWN_FAILED" : originalCode;
	wrapped.originalCode = originalCode;
	wrapped.originalMessage = originalMessage;
	const errno = errnoValue(err);
	if (errno !== undefined) wrapped.errno = typeof errno === "number" ? errno : Number(errno);
	const syscall = syscallValue(err);
	if (syscall) wrapped.syscall = syscall;
	wrapped.path = spawnPath;
	wrapped.cwd = cwd;
	// Do not set `cause` here: the listener copies these structured fields back
	// onto the original Error. A cause reference to that same object would become
	// `err.cause === err`, making JSON.stringify throw on a circular structure.
	// originalMessage plus code/errno/syscall/path/cwd preserve the useful data.
	return wrapped;
}

export function spawnClaudeCodeWithDiagnostics(options: SpawnOptions): SpawnedProcess {
	const pipeStderr = DEBUG || envFlagEnabled(options.env.DEBUG_CLAUDE_AGENT_SDK);
	const child = spawnProcess(options.command, options.args, {
		cwd: options.cwd,
		env: options.env,
		signal: options.signal,
		stdio: ["pipe", "pipe", pipeStderr ? "pipe" : "ignore"],
		windowsHide: true,
	});
	if (pipeStderr) {
		child.stderr?.on("data", (data) => {
			for (const line of data.toString().split(/\r?\n/)) {
				if (line) debug(`[cli-stderr spawn] ${line}`);
			}
		});
	}
	child.prependListener("error", (err) => {
		const originalStack = err.stack;
		const wrapped = wrapClaudeSpawnErrorForSdk(err, options);
		Object.assign(err, wrapped);
		err.name = wrapped.name;
		err.message = wrapped.message;
		// Keep V8's stack from the actual Node spawn failure, not the wrapper
		// construction site. Diagnostic fields above remain enumerable and
		// JSON-serializable; stack stays the spawn-time breadcrumb for operators.
		if (originalStack) err.stack = originalStack;
	});
	return {
		stdin: child.stdin,
		stdout: child.stdout,
		get killed() { return child.killed; },
		get exitCode() { return child.exitCode; },
		kill: child.kill.bind(child),
		on: child.on.bind(child),
		once: child.once.bind(child),
		off: child.off.bind(child),
	};
}

// Per-query CLI debug capture. When CLAUDE_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
function makeCliDebugOptions(tag: string): { debug?: boolean; debugFile?: string; stderr?: (data: string) => void } {
	if (!DEBUG) return {};
	const seq = nextCliDebugSeq++;
	const ts = new Date().toISOString().replace(/[:.]/g, "-");
	const logDir = join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
	try { mkdirSync(logDir, { recursive: true }); } catch { /* ignore */ }
	const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
	debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
	return {
		debug: true,
		debugFile,
		stderr: (data: string) => {
			for (const line of data.split(/\r?\n/)) {
				if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
			}
		},
	};
}

/** Unconditional diagnostic dump — for "should never happen" paths */
function diagDump(label: string, data: Record<string, unknown>) {
	try {
		const ts = new Date().toISOString();
		const entry = { ts, moduleInstanceId, label, ...data };
		const path = diagLogPath();
		try { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); } catch { /* best effort */ }
		appendFileSync(path, JSON.stringify(entry) + "\n", { mode: 0o600 });
		try { chmodSync(path, 0o600); } catch { /* best effort */ }
		debug(`DIAG: ${label} (see ${path})`);
	} catch (error) {
		debug(`DIAG FAILED: ${label}`, error);
	}
}

function safeNotify(message: string, level: "info" | "warning" | "error" = "warning"): void {
	try { bridgeRuntime().piUI?.notify(message, level); }
	catch (error) { debug("notify failed:", error); }
}

function argKeys(args: Record<string, unknown> | undefined): string[] {
	return Object.keys(args ?? {}).sort();
}

function safeToolCallSummary(calls: Array<{ id: string; toolName: string; arguments?: Record<string, unknown> }>): Array<{ id: string; toolName: string; argKeys: string[] }> {
	return calls.map((call) => ({ id: call.id, toolName: call.toolName, argKeys: argKeys(call.arguments) }));
}

function compactToolNameSummary(names: Array<{ name: string; count: number }>, limit = 12): string[] {
	const shown = names.slice(0, limit).map(({ name, count }) => count > 1 ? `${name}×${count}` : name);
	if (names.length > limit) shown.push(`+${names.length - limit} more`);
	return shown;
}

function reportSyntheticToolResultRepair(missing: MissingToolResult[], context: Record<string, unknown>): void {
	try {
		if (missing.length === 0) return;
		const toolNames = summarizeMissingToolNames(missing);
		const toolNameSummary = compactToolNameSummary(toolNames);
		const sampledToolCallIds = missing.slice(0, 50).map((item) => item.id);
		diagDump("repair_tool_pairing_synthetic_results", {
			count: missing.length,
			toolNames,
			sampledToolCallIds,
			missing: missing.slice(0, 50),
			...context,
		});
		debug(`convertAndImportMessages: repaired ${missing.length} unpaired tool call(s)${toolNameSummary.length ? ` for ${toolNameSummary.join(", ")}` : ""}`);
	} catch (error) {
		debug("reportSyntheticToolResultRepair failed:", error);
	}
}

export function reportToolResultMismatch(queryCtx: QueryContext, reason: string, cwd: string | undefined, opts: { forceRotate?: boolean } = {}): boolean {
	try {
		if (queryCtx.reportedToolResultMismatch) return false;
		const progress = queryCtx.toolResultProgress();
		const hasMismatch = progress.expectedCount > 0
			? progress.unresolvedIds.length > 0 || progress.waitingCount > 0 || progress.queuedCount > 0 || progress.unmatchedResultCount > 0
			: progress.waitingCount > 0 || progress.queuedCount > 0 || progress.unmatchedResultCount > 0;
		if (!hasMismatch) return false;
		queryCtx.reportedToolResultMismatch = true;
		if (bridgeRuntime().sharedSession) {
			bridgeRuntime().sharedSession = { ...bridgeRuntime().sharedSession, needsRebuild: true, ...(opts.forceRotate ? { forceRotate: true } : {}) };
		}
		diagDump("tool_result_delivery_mismatch", {
			reason,
			cwd,
			progress,
			activeQueryExists: queryCtx.activeQuery !== null,
			sharedSession: bridgeRuntime().sharedSession ? {
				sessionId: bridgeRuntime().sharedSession.sessionId.slice(0, 8),
				cursor: bridgeRuntime().sharedSession.cursor,
				needsRebuild: bridgeRuntime().sharedSession.needsRebuild === true,
				forceRotate: bridgeRuntime().sharedSession.forceRotate === true,
			} : null,
		});
		return true;
	} catch (error) {
		debug("reportToolResultMismatch failed:", error);
		return false;
	}
}

export function __testSetBridgeIntegrityState(state: { ui?: Pick<ExtensionUIContext, "notify"> | null; sharedSession?: SessionState | null }): void {
	if ("ui" in state) bridgeRuntime().piUI = state.ui as ExtensionUIContext | undefined;
	if ("sharedSession" in state) bridgeRuntime().sharedSession = state.sharedSession ?? null;
}

export function __testGetBridgeIntegrityState(): { sharedSession: SessionState | null } {
	return { sharedSession: bridgeRuntime().sharedSession };
}

// --- Constants ---

// Global key to preserve the first stateful stream when personal Pi reloads the
// extension for nested agents that share one ModelRegistry. Embedding hosts with
// sibling registries load the package's isolated entrypoint instead.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");
const COMMANDS_REGISTERED_KEY = Symbol.for("claude-bridge:commandsRegistered");

const SDK_TO_PI_TOOL_NAME: Record<string, string> = {
	read: "read", write: "write", edit: "edit", bash: "bash",
};

// MODELS is buildModels(getModels("anthropic")) — projection kept in models.js.
const MODELS = buildModels(getModels("anthropic"));

// Disable Claude Code built-ins in the provider path. Pi owns tool execution;
// Claude reaches Pi tools through the bridged MCP server instead. The one
// built-in kept is ToolSearch: Claude Code runs it itself to load deferred MCP
// tools on demand (see buildMcpServers), so Pi never executes it.
//
// `allowedTools` is a permission auto-allow list in the Claude Agent SDK, not a
// visibility allowlist. `tools` names the built-in tool set to keep, and this
// disallow list is a belt-and-suspenders guard for SDK/CLI built-ins that may
// otherwise leak into the model context (e.g. TodoWrite, CronList, SendMessage).
const CLAUDE_CODE_TOOL_SEARCH = "ToolSearch";

export const DISALLOWED_BUILTIN_TOOLS = [
	"Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "Agent", "Task",
	"NotebookEdit", "EnterWorktree", "ExitWorktree",
	"CronList", "CronCreate", "CronDelete", "TeamCreate", "TeamDelete",
	"TaskOutput", "TaskStop", "SendMessage", "Skill",
	"TodoRead", "TodoWrite",
	"ListMcpResources", "ReadMcpResource",
	"WebFetch", "WebSearch",
	"AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
	"ScheduleWakeup",
];

export const CLAUDE_BRIDGE_TOOL_ISOLATION = {
	tools: [CLAUDE_CODE_TOOL_SEARCH],
	disallowedTools: DISALLOWED_BUILTIN_TOOLS,
	allowedTools: [`mcp__${MCP_SERVER_NAME}__*`],
} satisfies Pick<NonNullable<Parameters<typeof query>[0]["options"]>, "tools" | "allowedTools" | "disallowedTools">;

// --- Session persistence ---

interface SessionState {
	sessionId: string;
	cursor: number;
	cwd: string;
	// Force the next syncSharedSession call down the REBUILD path. Set when
	// pi has mutated its messages array out from under us (compact, tree
	// navigation) or after an abort left the JSONL in an indeterminate state.
	// REBUILD wipes and rewrites the file to match pi's current history.
	needsRebuild?: boolean;
	// Set ONLY after an abort. The killed CC subprocess may still be flushing
	// a late "[Request interrupted by user]" record to the session JSONL.
	// Reusing the same sessionId/path would race that orphan write into our
	// fresh file and break CC's parent-uuid chain on the next resume. When
	// this flag is set, REBUILD takes a fresh UUID and skips deleteSession
	// so the orphan writes land on a dead inode. Compact/tree do NOT set
	// this — there's no concurrent CC writer during those events, so
	// in-place rebuild (preserve UUID, deleteSession + createSession) is safe.
	forceRotate?: boolean;
}

interface BridgeRuntimeState {
	sharedSession: SessionState | null;
	extensionApi: ExtensionAPI | undefined;
	piUI: ExtensionUIContext | undefined;
	extraUsageHelperInFlight: Promise<string> | null;
	query: QueryRuntimeState;
	userDir: string | undefined;
	envOverrides: NodeJS.ProcessEnv | undefined;
	// The Pi session's working directory. Pi passes no cwd to providers, and the
	// host process's cwd (e.g. Symphony's launch directory) is not the workspace.
	sessionCwd: string | undefined;
	usage: ClaudeUsageReader;
}

function createBridgeRuntimeState(userDir?: string, env?: NodeJS.ProcessEnv): BridgeRuntimeState {
	const runtime: BridgeRuntimeState = {
		sharedSession: null,
		extensionApi: undefined,
		piUI: undefined,
		extraUsageHelperInFlight: null,
		query: createQueryRuntimeState(),
		userDir,
		envOverrides: env ? { ...env } : undefined,
		sessionCwd: undefined,
		usage: createClaudeUsageReader({
			// Hosts (e.g. Aria Local Runtime) listen for this to show plan quota.
			publish: (report) => runtime.extensionApi?.events?.emit?.(CLAUDE_USAGE_EVENT, report),
			onDisabled: (reason) => debug(`usage: reads disabled (${reason})`),
		}),
	};
	return runtime;
}

const defaultBridgeRuntime = createBridgeRuntimeState();
const bridgeRuntimeStorage = new AsyncLocalStorage<BridgeRuntimeState>();

function bridgeRuntime(): BridgeRuntimeState {
	return bridgeRuntimeStorage.getStore() ?? defaultBridgeRuntime;
}

function claudeEnvironment(): NodeJS.ProcessEnv {
	return { ...process.env, ...bridgeRuntime().envOverrides, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" };
}

function claudeConfigDirectory(): string | undefined {
	const env = claudeEnvironment();
	const home = process.platform === "win32" ? env.USERPROFILE : env.HOME;
	return env.CLAUDE_CONFIG_DIR || (home ? join(home, ".claude") : undefined);
}

function loadBridgeConfig(cwd: string): Config {
	return loadConfig(cwd, bridgeRuntime().userDir);
}

function runWithBridgeRuntime<T>(runtime: BridgeRuntimeState, callback: () => T): T {
	return bridgeRuntimeStorage.run(runtime, () => runWithQueryRuntime(runtime.query, callback));
}

const RATE_LIMIT_AUTO_RESUME_EVENT = "vstack:rate-limit";
const RATE_LIMIT_TOKEN = "[rate-limit]";
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000;
export const STREAM_IDLE_BACKOFF_HINT_MS = 60_000;
export const STREAM_IDLE_TIMEOUT_ENV = "CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT";

type TimerHandle = ReturnType<typeof setTimeout>;

export interface StreamIdleWatchdogState {
	activeQuery: unknown | null;
	currentPiStream: AssistantMessageEventStream | null;
	turnOutput: AssistantMessage | null;
	turnSawStreamEvent: boolean;
	turnStarted: boolean;
}

export interface StreamIdleTimeoutInfo {
	idleMs: number;
	timeoutMs: number;
}

export interface StreamIdleWatchdog {
	dispose: () => void;
	noteChunk: () => void;
	refresh: () => void;
	timedOut: () => boolean;
}

const activeStreamIdleWatchdogs = new WeakMap<QueryContext, StreamIdleWatchdog>();

function parseDurationLiteralMs(value: string, defaultUnit: "ms" | "s" = "s"): number | undefined {
	const text = value.trim().toLowerCase();
	if (!text) return undefined;
	if (["off", "false", "disabled", "disable"].includes(text)) return 0;
	const match = text.match(/^(\d+(?:\.\d+)?)\s*(ms|msec|msecs|milliseconds?|s|sec|secs|seconds?|m|min|mins|minutes?)?$/i);
	if (!match) return undefined;
	const amount = Number(match[1]);
	if (!Number.isFinite(amount) || amount < 0) return undefined;
	const unit = (match[2] ?? defaultUnit).toLowerCase();
	const multiplier = ["ms", "msec", "msecs", "millisecond", "milliseconds"].includes(unit)
		? 1
		: ["s", "sec", "secs", "second", "seconds"].includes(unit)
			? 1000
			: ["m", "min", "mins", "minute", "minutes"].includes(unit)
				? 60_000
				: undefined;
	if (multiplier === undefined) return undefined;
	const ms = Math.round(amount * multiplier);
	return Number.isFinite(ms) ? ms : undefined;
}

export function streamIdleTimeoutMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[STREAM_IDLE_TIMEOUT_ENV]?.trim();
	if (!raw) return DEFAULT_STREAM_IDLE_TIMEOUT_MS;
	return parseDurationLiteralMs(raw, "s") ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
}

function formatDurationShort(ms: number): string {
	if (ms < 180_000 && ms % 1000 === 0) return `${ms / 1000}s`;
	if (ms % 60_000 === 0) return `${ms / 60_000}m`;
	if (ms % 1000 === 0) return `${ms / 1000}s`;
	return `${ms}ms`;
}

export function buildStreamIdleTimeoutErrorMessage(timeoutMs: number): string {
	return `Claude Code stream idle timeout after ${formatDurationShort(timeoutMs)} with no assistant/tool output; treating stalled stream as retryable 529 overloaded/rate limit condition. Retry after ${formatDurationShort(STREAM_IDLE_BACKOFF_HINT_MS)}.`;
}

export function createStreamIdleWatchdog({
	clearTimer = (timer: TimerHandle) => clearTimeout(timer),
	getState,
	now = () => Date.now(),
	onTimeout,
	setTimer = (fn: () => void, delayMs: number) => setTimeout(fn, delayMs),
	timeoutMs,
}: {
	clearTimer?: (timer: TimerHandle) => void;
	getState: () => StreamIdleWatchdogState;
	now?: () => number;
	onTimeout: (info: StreamIdleTimeoutInfo) => void;
	setTimer?: (fn: () => void, delayMs: number) => TimerHandle;
	timeoutMs: number;
}): StreamIdleWatchdog {
	let disposed = false;
	let lastChunkAt = now();
	let timer: TimerHandle | null = null;
	let didTimeout = false;

	const clear = () => {
		if (!timer) return;
		try { clearTimer(timer); } catch { /* best effort */ }
		timer = null;
	};

	const shouldMonitor = (state: StreamIdleWatchdogState): boolean => Boolean(
		timeoutMs > 0
		&& state.activeQuery
		&& state.currentPiStream
		&& state.turnOutput
		&& !state.turnStarted
		&& !state.turnSawStreamEvent,
	);

	const schedule = () => {
		clear();
		if (disposed || didTimeout || timeoutMs <= 0) return;
		const state = getState();
		if (!shouldMonitor(state)) return;
		const turnStartedAt = typeof state.turnOutput?.timestamp === "number" ? state.turnOutput.timestamp : 0;
		const idleStartedAt = Math.max(lastChunkAt, turnStartedAt);
		const idleMs = Math.max(0, now() - idleStartedAt);
		if (idleMs >= timeoutMs) {
			didTimeout = true;
			onTimeout({ idleMs, timeoutMs });
			return;
		}
		timer = setTimer(schedule, Math.max(1, timeoutMs - idleMs));
		(timer as { unref?: () => void }).unref?.();
	};

	return {
		dispose: () => {
			disposed = true;
			clear();
		},
		noteChunk: () => {
			lastChunkAt = now();
			schedule();
		},
		refresh: schedule,
		timedOut: () => didTimeout,
	};
}

export function isExtraUsageRequiredMessage(value: unknown): boolean {
	let text: string;
	if (typeof value === "string") text = value;
	else if (value instanceof Error) text = value.message;
	else {
		try { text = JSON.stringify(value ?? ""); }
		catch { text = String(value); }
	}
	return /extra[-\s]?usage|overage|extra usage billing|extra usage credits|1M context/i.test(text);
}

export function uniqueNonEmptyLines(values: unknown[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const value of values) {
		const text = typeof value === "string" ? value.trim() : value == null ? "" : String(value).trim();
		if (!text || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
	}
	return out;
}

// The SDK reports rate-limit resets as Unix seconds; strings are ISO dates.
export function resetTimestampMs(value: unknown): number | undefined {
	const ms = typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : Number.NaN;
	return Number.isFinite(ms) ? ms : undefined;
}

export function formatResetTimestamp(value: unknown): string {
	const ms = resetTimestampMs(value);
	if (ms === undefined) return "unknown";
	return new Date(ms).toLocaleString(undefined, {
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
		month: "short",
		second: "2-digit",
		timeZoneName: "short",
		year: "numeric",
	});
}

export const ALLOWED_RATE_LIMIT_WARNING_UTILIZATION_THRESHOLD = 80;

export function normalizeRateLimitUtilization(value: unknown): number | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	if (value === 0) return 0;
	// Claude SDK payloads have appeared as both fractions and percentages.
	// Exact 1 is unit-ambiguous (1% vs 100%), so do not use it for allowed-warning copy.
	if (value > 0 && value < 1) return value * 100;
	if (value > 1 && value <= 100) return value;
	return undefined;
}

function rateLimitTypeLabel(value: unknown): string {
	const text = typeof value === "string" ? value.trim() : "";
	return text || "unknown";
}

export function formatAllowedRateLimitWarning(info: { status?: unknown; utilization?: unknown; rateLimitType?: unknown } | null | undefined): string | undefined {
	if (info?.status !== "allowed_warning") return undefined;
	const utilization = normalizeRateLimitUtilization(info.utilization);
	if (utilization === undefined || utilization < ALLOWED_RATE_LIMIT_WARNING_UTILIZATION_THRESHOLD) return undefined;
	return `Claude rate limit warning: nearing ${rateLimitTypeLabel(info.rateLimitType)} limit; check Claude Code /usage for exact utilization.`;
}

function emitRateLimitEvent(payload: Record<string, unknown>): void {
	try {
		bridgeRuntime().extensionApi?.events?.emit?.(RATE_LIMIT_AUTO_RESUME_EVENT, payload);
	} catch {
		// Cross-extension broker is best-effort only.
	}
}

function extraUsageAllowed(config: Config): boolean {
	return config.provider?.allowExtraUsage === true;
}

function sdkTextFromMessage(message: SDKMessage): string | undefined {
	if (message.type === "result") return (message as any).result;
	if (message.type === "assistant") {
		const content = (message as any).message?.content;
		if (!Array.isArray(content)) return undefined;
		return content
			.map((block) => block?.type === "text" && typeof block.text === "string" ? block.text : "")
			.filter(Boolean)
			.join("\n");
	}
	return undefined;
}

async function runExtraUsageHelper(cwd: string, config = loadBridgeConfig(cwd)): Promise<string> {
	const providerSettings = config.provider ?? {};
	const env = claudeEnvironment();
	const claudeExecutable = resolveClaudeCodeExecutable({ configuredPath: providerSettings.pathToClaudeCodeExecutable, env })?.executablePath;
	if (claudeExecutable) preflightClaudeExecutable(claudeExecutable, cwd);

	const helperQuery = query({
		prompt: "/extra-usage",
		options: {
			cwd,
			env: { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: "0", DISABLE_AUTO_COMPACT: "1" },
			maxTurns: 1,
			...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
			spawnClaudeCodeProcess: spawnClaudeCodeWithDiagnostics,
			...makeCliDebugOptions("extra-usage"),
		},
	});
	const outputs: string[] = [];
	try {
		for await (const message of helperQuery) {
			const text = sdkTextFromMessage(message)?.trim();
			if (text && outputs[outputs.length - 1] !== text) outputs.push(text);
		}
	} finally {
		helperQuery.close();
	}
	return outputs.join("\n").trim() || "Claude Code /extra-usage completed.";
}

function launchExtraUsageHelperIfAllowed(cwd: string, config: Config, reason: string): boolean {
	if (!extraUsageAllowed(config)) return false;
	if (bridgeRuntime().extraUsageHelperInFlight) return true;
	bridgeRuntime().extraUsageHelperInFlight = runExtraUsageHelper(cwd, config)
		.then((message) => {
			bridgeRuntime().piUI?.notify(`Claude extra usage helper: ${message}`, "info");
			return message;
		})
		.catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			bridgeRuntime().piUI?.notify(`Claude extra usage helper failed after ${reason}: ${message}`, "error");
			throw error;
		})
		.finally(() => { bridgeRuntime().extraUsageHelperInFlight = null; });
	void bridgeRuntime().extraUsageHelperInFlight.catch(() => {});
	return true;
}

const BRIDGE_SESSION_CUSTOM_TYPE = "claude-bridge-session";

interface PersistedBridgeSessionState extends SessionState {
	fingerprint: string;
	piSessionId?: string;
	updatedAt: string;
}

function fingerprintMessages(messages: Context["messages"]): string {
	const normalized = messages.map((message) => {
		if (message.role === "assistant") {
			return {
				role: message.role,
				provider: (message as AssistantMessage).provider,
				model: (message as AssistantMessage).model,
				content: (message as AssistantMessage).content,
			};
		}
		return message;
	});
	return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

function readBuiltSessionContext(sessionManager: unknown): { messages: Context["messages"] } | undefined {
	const built = typeof (sessionManager as any)?.buildSessionContext === "function" ? (sessionManager as any).buildSessionContext() : undefined;
	return Array.isArray(built?.messages) ? built as { messages: Context["messages"] } : undefined;
}

function latestPersistedBridgeSession(sessionManager: unknown): PersistedBridgeSessionState | undefined {
	const entries = typeof (sessionManager as any)?.getEntries === "function" ? (sessionManager as any).getEntries() : [];
	if (!Array.isArray(entries)) return undefined;
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (entry?.type !== "custom" || entry.customType !== BRIDGE_SESSION_CUSTOM_TYPE) continue;
		const data = entry.data as Partial<PersistedBridgeSessionState> | undefined;
		if (!data || typeof data.sessionId !== "string" || typeof data.cursor !== "number" || typeof data.cwd !== "string" || typeof data.fingerprint !== "string") continue;
		return data as PersistedBridgeSessionState;
	}
	return undefined;
}

function claudeSessionExists(sessionId: string, cwd: string): boolean {
	try {
		const session = openSession({ sessionId, projectPath: cwd, claudeDir: claudeConfigDirectory() });
		statSync(session.jsonlPath);
		return true;
	} catch {
		return false;
	}
}

function canonicalize(p: string | undefined): string | undefined {
	if (!p) return undefined;
	try { return realpathSync.native(p); } catch { return pathResolve(p); }
}

// Decides whether a persisted bridge-session marker is safe to restore.
//
// The fork case is the load-bearing one: pi/core's createBranchedSession copies
// every non-label entry from root→leaf into the new session file. That includes
// our claude-bridge-session markers from the parent. Restoring from them would
// --resume parent's Claude jsonl on the fork's first turn, leaking conversation
// past the fork point.
//
// Returns undefined when the entry is safe to use, or a short rejection reason
// for diagnostic logging. Old entries without piSessionId always reject, which
// degrades safely to the rebuild path.
export function shouldRestorePersistedBridgeEntry(
	persisted: { piSessionId?: string; cwd: string },
	currentPiSessionId: string | undefined,
	currentCwd: string | undefined,
): string | undefined {
	if (!persisted.piSessionId) return "missing piSessionId";
	if (currentPiSessionId && persisted.piSessionId !== currentPiSessionId) {
		return `piSessionId mismatch (persisted=${persisted.piSessionId} current=${currentPiSessionId})`;
	}
	if (currentCwd && canonicalize(persisted.cwd) !== canonicalize(currentCwd)) {
		return `cwd mismatch (persisted=${persisted.cwd} current=${currentCwd})`;
	}
	return undefined;
}

export function restoreSharedSessionFromPi(ctx: { sessionManager?: unknown; cwd?: string }): void {
	const persisted = latestPersistedBridgeSession(ctx.sessionManager);
	if (!persisted) return;
	const currentPiSessionId = typeof (ctx.sessionManager as any)?.getSessionId === "function" ? (ctx.sessionManager as any).getSessionId() : undefined;
	const currentCwd = typeof (ctx.sessionManager as any)?.getCwd === "function" ? (ctx.sessionManager as any).getCwd() : ctx.cwd;
	const rejection = shouldRestorePersistedBridgeEntry(persisted, currentPiSessionId, currentCwd);
	if (rejection) {
		debug(`restoreSharedSession: ${rejection} — forcing rebuild`);
		return;
	}
	const built = readBuiltSessionContext(ctx.sessionManager);
	if (!built) return;
	const cursor = Math.max(0, Math.min(persisted.cursor, built.messages.length));
	const fingerprint = fingerprintMessages(built.messages.slice(0, cursor));
	if (fingerprint !== persisted.fingerprint) {
		debug(`restoreSharedSession: fingerprint mismatch for ${persisted.sessionId.slice(0, 8)}`);
		return;
	}
	if (!claudeSessionExists(persisted.sessionId, persisted.cwd)) {
		debug(`restoreSharedSession: Claude session missing for ${persisted.sessionId.slice(0, 8)}`);
		return;
	}
	bridgeRuntime().sharedSession = { sessionId: persisted.sessionId, cursor, cwd: persisted.cwd };
	debug(`restoreSharedSession: restored ${persisted.sessionId.slice(0, 8)}, cursor=${cursor}`);
}

function schedulePersistSharedSession(ctxLike?: { sessionManager?: unknown }): void {
	if (!bridgeRuntime().extensionApi || !bridgeRuntime().sharedSession || !ctxLike?.sessionManager) return;
	const snapshot = { ...bridgeRuntime().sharedSession };
	const timer = setTimeout(() => {
		try {
			const built = readBuiltSessionContext(ctxLike.sessionManager);
			if (!built) return;
			const cursor = Math.max(0, Math.min(snapshot.cursor, built.messages.length));
			const data: PersistedBridgeSessionState = {
				...snapshot,
				cursor,
				fingerprint: fingerprintMessages(built.messages.slice(0, cursor)),
				piSessionId: typeof (ctxLike.sessionManager as any)?.getSessionId === "function" ? (ctxLike.sessionManager as any).getSessionId() : undefined,
				updatedAt: new Date().toISOString(),
			};
			bridgeRuntime().extensionApi?.appendEntry(BRIDGE_SESSION_CUSTOM_TYPE, data);
			debug(`persistSharedSession: saved ${data.sessionId.slice(0, 8)}, cursor=${data.cursor}`);
		} catch (error) {
			debug("persistSharedSession failed:", error);
		}
	}, 0);
	timer.unref?.();
}

// Convert Pi messages (already normalized by transformMessages) to Anthropic API
// format for session import. Thinking without a Claude signature is dropped;
// user and tool-result image blocks are preserved when possible. If assistant
// blocks are otherwise incompatible, convertPiMessages emits a text placeholder
// so the record sequence stays valid before repairToolPairing runs.
function convertAndImportMessages(
	session: ReturnType<typeof createSession>,
	messages: Context["messages"],
	customToolNameToSdk?: Map<string, string>,
	cwd?: string,
): void {
	const { anthropicMessages, sanitizedIds } = convertPiMessages(messages, customToolNameToSdk);

	debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
	debug(`convertAndImportMessages: imported roles:`, anthropicMessages.map((m, i) => {
		const c = m.content;
		if (typeof c === "string") return `[${i}]${m.role}:text`;
		if (Array.isArray(c)) return `[${i}]${m.role}:${(c).map((b) => b.type).join("+")}`;
		return `[${i}]${m.role}:?`;
	}).join(" "));
	if (sanitizedIds.size > 0) {
		debug(`convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
			[...sanitizedIds.entries()].map(([orig, clean]) => orig === clean ? orig : `${orig}→${clean}`).join(", "));
	}
	// Pre-repair for debug logging; importMessages also repairs internally (idempotent).
	const missingToolResults = findUnpairedToolUses(anthropicMessages);
	const repaired = repairToolPairing(anthropicMessages);
	if (missingToolResults.length > 0) {
		reportSyntheticToolResultRepair(missingToolResults, {
			cwd,
			messageCount: messages.length,
			anthropicMessageCount: anthropicMessages.length,
			sessionId: session.sessionId,
			jsonlPath: session.jsonlPath,
		});
	}
	if (repaired.length !== anthropicMessages.length) {
		debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
	}
	if (repaired.length) session.importMessages(repaired);
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
function extractAllToolResults(context: Context): McpResult[] {
	const { results, stopIdx } = _extractAllToolResults(context.messages as unknown as Array<{ role: string; [key: string]: unknown }>);
	debug(`extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`);
	debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
	for (let r = 0; r < results.length; r++) {
		debug(`extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`, JSON.stringify(results[r].content).slice(0, 150));
	}
	return results;
}

/** A Pi user message as Claude Code prompt content: text, or blocks when images are attached. */
function userMessageToPromptContent(message: Context["messages"][number]): string | ContentBlockParam[] {
	if (message.role !== "user") return "";
	if (typeof message.content === "string") return message.content;
	if (!Array.isArray(message.content)) return "";
	let hasImage = false;
	const blocks: ContentBlockParam[] = [];
	for (const block of message.content) {
		if (block.type === "text" && block.text) {
			blocks.push({ type: "text", text: block.text });
		} else if (block.type === "image" && block.data && block.mimeType) {
			hasImage = true;
			blocks.push({
				type: "image",
				source: { type: "base64", media_type: block.mimeType as Base64ImageSource["media_type"], data: block.data },
			});
		}
	}
	return hasImage ? blocks : messageContentToText(message.content);
}

function sdkUserMessage(content: string | ContentBlockParam[]): SDKUserMessage {
	return { type: "user", message: { role: "user", content } as MessageParam, parent_tool_use_id: null };
}

/** User messages Pi appended after `startIndex`: steering or follow-ups delivered with tool results. */
function newUserMessages(messages: Context["messages"], startIndex: number): SDKUserMessage[] {
	const out: SDKUserMessage[] = [];
	for (const message of messages.slice(Math.max(0, startIndex))) {
		if (message.role !== "user") continue;
		const content = userMessageToPromptContent(message);
		if (content.length > 0) out.push(sdkUserMessage(content));
	}
	return out;
}

interface SyncResult {
	sessionId: string | null;
	// The written copy ends on a user-role message (an unanswered prompt or
	// tool results). Claude Code answers it itself via
	// CLAUDE_CODE_RESUME_INTERRUPTED_TURN, so the bridge sends no prompt.
	rescue: boolean;
}

// Read the session file we just wrote and sanity-check it. Records problems
// instead of throwing — CC may be more tolerant than our checks, so a false
// positive shouldn't block the user. Pure logic is in session-verify.js; this
// wrapper writes each warning to the debug log and the diagnostic log.
function verifyWrittenSession(
	jsonlPath: string,
	expectedSessionId: string,
	expectedRecordCount: number,
	cwd: string,
): void {
	const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
	for (const msg of warnings) {
		debug(`WARNING session verify: ${msg}`);
		diagDump("session_verify_fail", { msg, jsonlPath, cwd, realpath: safeRealpath(cwd), claudeConfigDir: claudeConfigDirectory() ?? null });
	}
}

function safeRealpath(p: string): string {
	try { return realpathSync(p); } catch (e) { return `<failed: ${(e as Error).message}>`; }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
	const realCwd = safeRealpath(cwd);
	let fileSize: number | null = null;
	let fileExists = false;
	try {
		const st = statSync(jsonlPath);
		fileExists = true;
		fileSize = st.size;
	} catch { /* file may not exist yet */ }
	debug(`${label}: cwd=${cwd}`);
	if (realCwd !== cwd) debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
	debug(`${label}: jsonlPath=${jsonlPath}`);
	debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
	debug(`${label}: CLAUDE_CONFIG_DIR=${claudeConfigDirectory() ?? "(unset)"}`);
}

// Two semantic paths:
//   REUSE — pi's history is in sync with the existing shared session (or drifted
//     only by the trailing final-assistant message that pi appends after
//     streamSimple returns, which CC's own persisted session already has).
//     Returns the existing sessionId. Keeps CC's prompt cache warm.
//   REBUILD — no session yet, or pi's history has diverged (non-trailing
//     missed messages, e.g. another provider took a turn). Wipes the existing
//     session file (if any) and writes a fresh one containing all prior
//     messages, reusing the same sessionId across rebuilds so UUIDs stay
//     stable for the lifetime of pi's session.
//
// Why a full rebuild rather than patching:
//   Injecting deltas into an existing session creates a branch that CC's
//   --resume doesn't follow (documented attempt prior to this). A complete
//   overwrite at the same path is simpler and correct.
//
// Why reuse the sessionId across rebuilds:
//   CC re-reads the JSONL on every --resume call — no in-process UUID
//   caching. Validated in tests/exp-session-clear.mjs, including the case
//   where CC had appended its own tool_use/tool_result records between
//   rebuilds. Preserving the UUID means stable log correlation across
//   provider switches and no orphaned session files.
//
// Log strings still say "Case 1/2/3/4" so existing diagnostics (int-cache.sh,
// int-session-resume.mjs) keep grepping the same anchors.
//
// A reply with no text and no tool call (Claude ended the turn after thinking
// only) is not a reply to Claude Code: it drops such messages when it loads a
// session, so a copy ending on one ends on the message before it.
function isVisibleReply(message: Context["messages"][number]): boolean {
	return message.role === "assistant" && message.content.some((block) =>
		block.type === "toolCall" || (block.type === "text" && block.text.trim() !== ""));
}

function syncSharedSession(
	messages: Context["messages"],
	cwd: string,
	model: Model<any>,
	customToolNameToSdk?: Map<string, string>,
): SyncResult {
	const priorMessages = messages.slice(0, -1); // everything before the new user prompt
	const endsWithUserPrompt = messages[messages.length - 1]?.role === "user";

	// REUSE path
	if (endsWithUserPrompt && bridgeRuntime().sharedSession && !bridgeRuntime().sharedSession.needsRebuild) {
		const missed = priorMessages.slice(bridgeRuntime().sharedSession.cursor);
		const trailingAssistantOnly = missed.length === 1 && isVisibleReply(missed[0]);
		if (missed.length === 0 || trailingAssistantOnly) {
			if (trailingAssistantOnly) {
				bridgeRuntime().sharedSession = { ...bridgeRuntime().sharedSession, cursor: priorMessages.length, cwd };
			}
			debug(`Case 3: ${trailingAssistantOnly ? "advanced cursor past trailing assistant, " : ""}resuming session ${bridgeRuntime().sharedSession.sessionId.slice(0, 8)}, cursor=${bridgeRuntime().sharedSession.cursor}`);
			debug(`syncResult: path=reuse sessionId=${bridgeRuntime().sharedSession.sessionId} cursor=${bridgeRuntime().sharedSession.cursor}`);
			return { sessionId: bridgeRuntime().sharedSession.sessionId, rescue: false };
		}
	}

	// REBUILD path. Normalize exactly as Pi does for every other provider:
	// aborted/errored assistant turns are dropped and unanswered tool calls get
	// an error result. Replies Claude Code would drop are left out, so the
	// prompt they did not answer counts as unanswered. Pi's own history is
	// never modified.
	const history = transformMessages(messages, model).filter((message) => message.role !== "assistant" || isVisibleReply(message));
	let lastAssistant = history.length - 1;
	while (lastAssistant >= 0 && history[lastAssistant].role !== "assistant") lastAssistant--;
	const tail = history.slice(lastAssistant + 1);
	// Resuming a copy that ends on a user-role message makes Claude Code insert
	// a fake "No response requested." reply. The ordinary case (the copy ends
	// on Claude's reply, the new prompt follows) never does. Anything else — a
	// prompt left unanswered by an abort or error, or tool results Pi continues
	// from after compaction — is written into the copy in full and answered by
	// Claude Code's interrupted-turn resume instead.
	const rescue = !(tail.length === 1 && tail[0].role === "user");
	const imported = rescue ? history : history.slice(0, -1);

	if (imported.length === 0) {
		debug(`Case 1: clean start, ${messages.length} total messages`);
		debug(`syncResult: path=clean-start`);
		return { sessionId: null, rescue: false };
	}
	const previousSessionId = bridgeRuntime().sharedSession?.sessionId;
	const previousCursor = bridgeRuntime().sharedSession?.cursor ?? 0;
	// preserveId: rebuild in place (deleteSession + createSession with the
	// existing UUID), so prompt-cache UUIDs stay stable for log correlation
	// and for any tools that key off them. Skipped only when there's a
	// concurrent writer we shouldn't race — see forceRotate docs above.
	const preserveId = previousSessionId !== undefined && !bridgeRuntime().sharedSession?.forceRotate;
	if (preserveId) {
		// Wipe prior jsonl + companion dir (no-op if nothing to wipe).
		deleteSession(previousSessionId!, cwd, claudeConfigDirectory());
	}
	const session = createSession({
		projectPath: cwd,
		claudeDir: claudeConfigDirectory(),
		...(preserveId ? { sessionId: previousSessionId } : {}),
		model: model.id,
	});
	convertAndImportMessages(session, imported, customToolNameToSdk, cwd);
	session.save();
	verifyWrittenSession(session.jsonlPath, session.sessionId, session.messages.length, cwd);
	const cursor = rescue ? messages.length : priorMessages.length;
	bridgeRuntime().sharedSession = { sessionId: session.sessionId, cursor, cwd };
	if (previousSessionId === undefined) {
		debug(`Case 2: first turn with ${cursor} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.messages.length} records`);
	} else if (preserveId) {
		const missedCount = cursor - previousCursor;
		debug(`Case 4: ${missedCount} missed messages, ${cursor} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.messages.length} records`);
	} else {
		debug(`Case 4 post-abort: ${cursor} total → new session ${session.sessionId.slice(0, 8)} (was ${previousSessionId.slice(0, 8)}, rotated to avoid race with orphan writer), ${session.messages.length} records`);
	}
	debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath);
	debug(`syncResult: path=rebuild sessionId=${session.sessionId} imported=${imported.length} rescue=${rescue} ${previousSessionId === undefined ? "first" : preserveId ? "preserved" : "rotated-post-abort"}`);
	return { sessionId: session.sessionId, rescue };
}

// --- Provider helpers: tool name mapping ---

export function mapToolName(name: string, customToolNameToPi?: Map<string, string>): string {
	const normalized = name.toLowerCase();
	const builtin = SDK_TO_PI_TOOL_NAME[normalized];
	if (builtin) return builtin;
	if (customToolNameToPi) {
		const mapped = customToolNameToPi.get(name) ?? customToolNameToPi.get(normalized);
		if (mapped) return mapped;
	}
	for (const prefix of [
		MCP_TOOL_PREFIX,
		`mcp__${MCP_SERVER_NAME.replace(/-/g, "_")}__`,
		`mcp/${MCP_SERVER_NAME}/`,
		`mcp/${MCP_SERVER_NAME.replace(/-/g, "_")}/`,
	]) {
		if (normalized.startsWith(prefix)) return normalized.slice(prefix.length);
	}
	return name;
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
	read:  { file_path: "path" },
	write: { file_path: "path" },
	edit:  { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
export function mapToolArgs(
	toolName: string, args: Record<string, unknown> | undefined,
): Record<string, unknown> {
	const input = args ?? {};
	const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
	const result: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		const piKey = renames?.[key] ?? key;
		if (!(piKey in result)) result[piKey] = value; // first alias wins
	}
	// Pi owns Bash foreground/background timing; do not inject a legacy timeout field.
	return result;
}

// --- Provider helpers: tool resolution ---

// --- Provider helpers: tool bridge ---

// --- Query state ---
// QueryContext + context stack live in query-state.js so tests can import
// them without activating the extension. `ctx()`, `pushContext()`, `popContext()`
// are imported at the top of this file.

function resolveMcpTools(context: Context, excludeToolName?: string): {
	mcpTools: Tool[];
	customToolNameToSdk: Map<string, string>;
	customToolNameToPi: Map<string, string>;
} {
	const mcpTools: Tool[] = [];
	const customToolNameToSdk = new Map<string, string>();
	const customToolNameToPi = new Map<string, string>();

	if (!context.tools) return { mcpTools, customToolNameToSdk, customToolNameToPi };

	for (const tool of context.tools) {
		if (tool.name === excludeToolName) continue;
		const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
		mcpTools.push(tool);
		customToolNameToSdk.set(tool.name, sdkName);
		customToolNameToSdk.set(tool.name.toLowerCase(), sdkName);
		customToolNameToPi.set(sdkName, tool.name);
		customToolNameToPi.set(sdkName.toLowerCase(), tool.name);
	}

	return { mcpTools, customToolNameToSdk, customToolNameToPi };
}

// Tools Pi itself provides always load. Tools Pi bridges from other MCP servers
// (`mcp__<server>__<tool>`) wait behind Claude Code's ToolSearch, as Claude Code
// treats its own built-ins and MCP tools.
function isDeferredTool(name: string): boolean {
	return name.startsWith("mcp__");
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool call
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Calls claim their tool_call id by matching the actual MCP call
// (tool name + arguments) against the recorded tool_use blocks, then results
// are matched by ID. The handler closes over the captured `queryCtx`, ensuring it
// operates on the correct query's state even across pushContext/popContext calls.
// Pi tool parameters are JSON Schema and are served unchanged; converting them
// through Zod for createSdkMcpServer loses unions and references.
function buildMcpServers(tools: Tool[], queryCtx: QueryContext): Record<string, McpSdkServerConfigWithInstance> | undefined {
	if (!tools.length) return undefined;
	const callTool = async (toolName: string, args?: Record<string, unknown>): Promise<McpResult> => {
		const mappedArgs = mapToolArgs(toolName, args);
		const claim = queryCtx.claimToolCall(toolName, mappedArgs);
		const toolCallId = claim.toolCallId;
		if (!toolCallId) {
			debug(`WARNING: mcp handler ${toolName} has no toolCallId (available=${claim.available})`);
			diagDump("tool_handler_unmatched", {
				toolName,
				argKeys: argKeys(mappedArgs),
				available: claim.available,
				turnToolCallIds: queryCtx.turnToolCallIds,
				turnToolCalls: safeToolCallSummary(queryCtx.turnToolCalls),
			});
			return { content: [{ type: "text", text: `Claude bridge internal error: no matching tool_call id for ${toolName}` }], isError: true } satisfies McpResult;
		}
		if (claim.match !== "tool-args" || claim.ambiguous) {
			debug(`mcp handler: ${toolName} [${toolCallId}] claimed by ${claim.match}${claim.ambiguous ? " (ambiguous)" : ""}`);
		}
		if (toolCallId && queryCtx.pendingResults.has(toolCallId)) {
			const result = queryCtx.pendingResults.get(toolCallId)!;
			queryCtx.pendingResults.delete(toolCallId);
			queryCtx.markToolResultResolved(toolCallId);
			debug(`mcp handler: ${toolName} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`);
			return result;
		}
		debug(`mcp handler: ${toolName} [${toolCallId}] → waiting`);
		return new Promise<McpResult>((resolve) => {
			queryCtx.pendingToolCalls.set(toolCallId, {
				toolName,
				resolve: (result) => {
					queryCtx.markToolResultResolved(toolCallId);
					resolve(result);
				},
			});
		});
	};
	const server = new McpServer({ name: MCP_SERVER_NAME, version: "1.0.0" }, { capabilities: { tools: {} } });
	server.server.setRequestHandler(ListToolsRequestSchema, () => ({
		tools: tools.map((tool) => ({
			name: tool.name,
			description: tool.description,
			inputSchema: tool.parameters as McpTool["inputSchema"],
			...(isDeferredTool(tool.name) ? {} : { _meta: { "anthropic/alwaysLoad": true } }),
		})),
	}));
	server.server.setRequestHandler(CallToolRequestSchema, (request) => callTool(request.params.name, request.params.arguments));
	return { [MCP_SERVER_NAME]: { type: "sdk", name: MCP_SERVER_NAME, instance: server } };
}

// --- Usage helpers ---

function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>): void {
	if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
	if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
	if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
	if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
	output.usage.totalTokens = output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
	calculateCost(model, output.usage);
	const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
	const cachePct = promptTokens > 0 ? Math.round(output.usage.cacheRead / promptTokens * 100) : 0;
	debug(`usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens} cachePct=${cachePct}% model=${model.id}`);
}

// --- Effort level mapping ---
// Pi reasoning levels → CC SDK effort levels

const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
};

function normalizeEffortOverrideModelKey(value: string): string {
	const key = value.trim().toLowerCase();
	return key.startsWith(`${PROVIDER_ID}/`) ? key.slice(PROVIDER_ID.length + 1) : key;
}

export function resolveConfiguredEffort(
	modelId: string,
	reasoningEffort: EffortLevel | undefined,
	providerConfig?: Config["provider"],
): EffortLevel | undefined {
	const target = normalizeEffortOverrideModelKey(modelId);
	for (const [key, rawEffort] of Object.entries(providerConfig?.modelEffortOverrides ?? {})) {
		const normalizedKey = normalizeEffortOverrideModelKey(key);
		if (normalizedKey !== "*" && normalizedKey !== target) continue;
		const effort = normalizeEffortLevel(rawEffort) as EffortLevel | undefined;
		if (effort) return effort;
	}
	return (normalizeEffortLevel(providerConfig?.forceEffort) as EffortLevel | undefined) ?? reasoningEffort;
}

// --- Provider helpers: misc ---

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
	switch (reason) {
		case "tool_use": return "toolUse";
		case "max_tokens": return "length";
		case "end_turn": default: return "stop";
	}
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
	if (!input) return fallback;
	try { return JSON.parse(input); } catch { return fallback; }
}


// --- Provider: streaming function ---
//
// Push-based streaming with MCP tool bridge:
// 1. streamSimple starts a query() and kicks off consumeQuery() in background
// 2. consumeQuery() iterates the SDK generator, pushing events to currentPiStream
// 3. On tool_use: ends the current pi stream, nulls it out. The MCP handler
//    blocks the generator naturally — no events arrive until resolved.
// 4. Pi executes the tool, calls streamSimple again. We swap in the new stream,
//    resolve the MCP handler, and the generator unblocks — events flow to new stream.
//
// Note: resetTurnState clears turnSawStreamEvent while the generator may still
// have queued messages from the previous turn. This is safe because step 3 nulls
// currentPiStream, so any leftover messages hit the `!ctx().currentPiStream` guard
// in consumeQuery and are skipped before resetTurnState runs.

function ensureTurnStarted(): void {
	if (!ctx().turnStarted && ctx().currentPiStream && ctx().turnOutput) {
		ctx().currentPiStream!.push({ type: "start", partial: ctx().turnOutput });
		ctx().turnStarted = true;
	}
}

export function flushUnemittedToolCalls(): boolean {
	const c = ctx();
	const calls = c.unemittedToolCalls();
	if (!c.currentPiStream || !c.turnOutput || c.reportedToolResultMismatch || calls.length === 0) return false;

	ensureTurnStarted();
	for (const call of calls) {
		const block = { type: "toolCall" as const, id: call.id, name: call.toolName, arguments: call.arguments };
		c.turnBlocks.push(block);
		const contentIndex = c.turnBlocks.length - 1;
		c.currentPiStream.push({ type: "toolcall_start", contentIndex, partial: c.turnOutput });
		c.currentPiStream.push({ type: "toolcall_end", contentIndex, toolCall: block, partial: c.turnOutput });
		c.markToolCallEmitted(call.id);
	}
	c.turnSawToolCall = true;
	c.turnOutput.stopReason = "toolUse";
	c.currentPiStream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
	c.currentPiStream.end();
	c.currentPiStream = null;
	return true;
}

function finalizeCurrentStream(stopReason?: string): void {
	if (!ctx().currentPiStream || !ctx().turnOutput) return;
	debug(`provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({stopReason: ctx().turnOutput!.stopReason, error: ctx().turnOutput!.errorMessage})}`);
	if (!ctx().turnStarted) ensureTurnStarted();
	const reason = stopReason === "length" ? "length" : "stop";
	ctx().currentPiStream!.push({ type: "done", reason, message: ctx().turnOutput });
	ctx().currentPiStream!.end();
	ctx().currentPiStream = null;
}

function updateTurnOutputModel(modelId: unknown): void {
	const c = ctx();
	if (typeof modelId !== "string" || !modelId || !c.turnOutput) return;
	if (c.turnOutput.model === modelId) return;
	debug(`provider: active Claude model changed ${c.turnOutput.model} -> ${modelId}`);
	c.turnOutput.model = modelId;
}

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
export function processStreamEvent(
	message: SDKMessage,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
): void {
	const c = ctx();
	if (!c.currentPiStream || !c.turnOutput) return;
	const event = (message as SDKMessage & { event: any }).event;
	if (event?.type === "ping") return;
	if (event?.type === "message_stop" && !c.turnSawToolCall) {
		debug("processStreamEvent: ignoring bare message_stop with no streamed content/tool call");
		return;
	}

	if (event?.type === "message_start") {
		if (event.message?.id !== c.assistantMessageId) {
			c.resetToolTracking();
			c.assistantMessageId = event.message?.id ?? null;
		}
		updateTurnOutputModel(event.message?.model);
		if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model);
		return;
	}
	if (c.reportedToolResultMismatch) return;

	if (event?.type === "content_block_start") {
		c.turnSawStreamEvent = true;
		ensureTurnStarted();
		if (event.content_block?.type === "text") {
			c.turnBlocks.push({ type: "text", text: "", index: event.index });
			c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "thinking") {
			c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
			c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else if (event.content_block?.type === "tool_use" && event.content_block.name === CLAUDE_CODE_TOOL_SEARCH) {
			// Claude Code runs its own tool search and continues the turn with the
			// loaded tool; Pi neither sees nor executes it. Its deltas then go unmatched.
			return;
		} else if (event.content_block?.type === "tool_use") {
			c.turnSawToolCall = true;
			const mappedName = mapToolName(event.content_block.name, customToolNameToPi);
			c.recordToolCall(event.content_block.id, mappedName, {});
			c.turnBlocks.push({
				type: "toolCall", id: event.content_block.id,
				name: mappedName,
				arguments: (event.content_block.input as Record<string, unknown>) ?? {},
				partialJson: "", index: event.index,
			});
			c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
		} else {
			debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
		}
		return;
	}

	if (event?.type === "content_block_delta") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) {
			debug("processStreamEvent: ignoring unmatched content_block_delta", event.index);
			return;
		}
		c.turnSawStreamEvent = true;
		if (event.delta?.type === "text_delta" && block.type === "text") {
			block.text += event.delta.text;
			c.currentPiStream!.push({ type: "text_delta", contentIndex: index, delta: event.delta.text, partial: c.turnOutput });
		} else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
			block.thinking += event.delta.thinking;
			c.currentPiStream!.push({ type: "thinking_delta", contentIndex: index, delta: event.delta.thinking, partial: c.turnOutput });
		} else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
			block.partialJson += event.delta.partial_json;
			block.arguments = parsePartialJson(block.partialJson, block.arguments);
			c.currentPiStream!.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta.partial_json, partial: c.turnOutput });
		} else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
			block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
		} else {
			debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
		}
		return;
	}

	if (event?.type === "content_block_stop") {
		const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
		const block = c.turnBlocks[index];
		if (!block) {
			debug("processStreamEvent: ignoring unmatched content_block_stop", event.index);
			return;
		}
		c.turnSawStreamEvent = true;
		delete block.index;
		if (block.type === "text") {
			c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			c.currentPiStream!.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: c.turnOutput });
		} else if (block.type === "toolCall") {
			c.turnSawToolCall = true;
			block.arguments = mapToolArgs(
				block.name, parsePartialJson(block.partialJson, block.arguments),
			);
			c.updateToolCallArgs(block.id, block.arguments);
			delete block.partialJson;
			c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
			c.markToolCallEmitted(block.id);
		}
		return;
	}

	if (event?.type === "message_delta") {
		c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
		if (event.usage) updateUsage(c.turnOutput, event.usage, model);
		return;
	}

	if (event?.type === "message_stop" && c.turnSawToolCall) {
		// Tool call complete — end this pi stream. The SDK will still yield an
		// assistant message for this turn, but currentPiStream=null causes
		// consumeQuery to skip it. The MCP handler blocks the generator until
		// pi delivers the tool result via the next streamSimple call.
		c.turnOutput.stopReason = "toolUse";
		c.currentPiStream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		c.currentPiStream!.end();
		c.currentPiStream = null;

		// Cursor is updated by the next streamSimple call (tool result delivery path)
		// which sets cursor = context.messages.length with the post-tool-result context.
		return;
	}

	if (event?.type !== "message_stop" && event?.type !== "ping") {
		debug("processStreamEvent: unhandled event type", event?.type);
	}
}

// The SDK always yields `assistant` messages (completed content blocks) after streaming.
// When stream_events already delivered the content, this is a no-op. But after
// resetTurnState (e.g. tool result delivery), if the next turn's assistant message
// arrives before any stream_events, this is the primary content path. Must maintain
// the same stream lifecycle as processStreamEvent — including ending the stream on
// tool_use to prevent deadlock with the MCP handler.
function appendMissingToolUsesFromAssistant(
	assistantMsg: { content?: Array<any>; usage?: Record<string, number | undefined> },
	model: Model<any>,
	customToolNameToPi: Map<string, string>,
): boolean {
	const c = ctx();
	if (!assistantMsg?.content) return false;
	let sawToolUse = false;
	for (const block of assistantMsg.content) {
		if (block.type !== "tool_use" || block.name === CLAUDE_CODE_TOOL_SEARCH) continue;
		const existingIdx = c.turnBlocks.findIndex((b: any) => b.type === "toolCall" && b.id === block.id);
		const name = mapToolName(block.name, customToolNameToPi);
		const mappedArgs = mapToolArgs(name, block.input);
		c.recordToolCall(block.id, name, mappedArgs);
		if (c.emittedToolCallIds.has(block.id)) continue;
		sawToolUse = true;
		if (existingIdx >= 0) {
			const existing = c.turnBlocks[existingIdx] as any;
			existing.name = name;
			existing.arguments = mappedArgs;
			c.updateToolCallArgs(block.id, mappedArgs);
			if ("partialJson" in existing) {
				delete existing.partialJson;
				delete existing.index;
				if (c.currentPiStream) {
					c.currentPiStream.push({ type: "toolcall_end", contentIndex: existingIdx, toolCall: existing, partial: c.turnOutput });
					c.markToolCallEmitted(existing.id);
				}
			}
			continue;
		}

		ensureTurnStarted();
		c.turnBlocks.push({
			type: "toolCall", id: block.id,
			name,
			arguments: mappedArgs,
		});
		const idx = c.turnBlocks.length - 1;
		const toolBlock = c.turnBlocks[idx];
		if (c.currentPiStream) {
			c.currentPiStream.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
			c.markToolCallEmitted(block.id);
		}
	}
	if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);
	return sawToolUse;
}

export function processAssistantMessage(message: SDKMessage, model: Model<any>, customToolNameToPi: Map<string, string>): void {
	const c = ctx();
	const assistantMsg = (message as any).message;
	if (!assistantMsg?.content) return;
	updateTurnOutputModel(assistantMsg.model);
	const assistantMessageId = typeof assistantMsg.id === "string" ? assistantMsg.id : null;
	if (c.reportedToolResultMismatch) return;
	if (c.turnSawStreamEvent || (assistantMessageId !== null && assistantMessageId === c.assistantMessageId)) {
		// Claude Agent SDK can yield the completed assistant message before (or
		// instead of) a stream_event message_stop for a tool-use turn. Treat that
		// assistant message as a hard turn boundary so Pi executes the tool calls
		// and the MCP handlers stay blocked until real tool results are delivered.
		// Without this fallback, Claude Code can continue internally with empty MCP
		// results and Pi only sees the real outputs one render cycle later.
		if (appendMissingToolUsesFromAssistant(assistantMsg, model, customToolNameToPi)) {
			c.turnSawToolCall = true;
			if (c.currentPiStream && c.turnOutput) {
				c.turnOutput.stopReason = "toolUse";
				c.currentPiStream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
				c.currentPiStream.end();
				c.currentPiStream = null;
				debug("processAssistantMessage boundary: ended streamed tool_use turn from assistant message");
			}
		}
		return;
	}
	c.resetToolTracking();
	c.assistantMessageId = assistantMessageId;
	debug(`processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`);
	for (const block of assistantMsg.content) {
		if (block.type === "text" && block.text) {
			ensureTurnStarted();
			c.turnBlocks.push({ type: "text", text: block.text });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: block.text, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: block.text, partial: c.turnOutput });
		} else if (block.type === "thinking") {
			ensureTurnStarted();
			c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
			const idx = c.turnBlocks.length - 1;
			c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
			if (block.thinking) c.currentPiStream?.push({ type: "thinking_delta", contentIndex: idx, delta: block.thinking, partial: c.turnOutput });
			c.currentPiStream?.push({ type: "thinking_end", contentIndex: idx, content: block.thinking ?? "", partial: c.turnOutput });
		} else if (block.type === "tool_use" && block.name !== CLAUDE_CODE_TOOL_SEARCH) {
			ensureTurnStarted();
			c.turnSawToolCall = true;
			const mappedName = mapToolName(block.name, customToolNameToPi);
			const mappedArgs = mapToolArgs(mappedName, block.input);
			c.recordToolCall(block.id, mappedName, mappedArgs);
			c.turnBlocks.push({
				type: "toolCall", id: block.id,
				name: mappedName,
				arguments: mappedArgs,
			});
			const idx = c.turnBlocks.length - 1;
			const toolBlock = c.turnBlocks[idx];
			if (c.currentPiStream) {
				c.currentPiStream.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
				c.currentPiStream.push({ type: "toolcall_end", contentIndex: idx, toolCall: toolBlock as any, partial: c.turnOutput });
				c.markToolCallEmitted(block.id);
			}
		} else if (block.type === "fallback") {
			updateTurnOutputModel(block.to?.model);
		} else {
			debug("processAssistantMessage: unhandled block type", block.type);
		}
	}
	if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);

	// End the stream on tool_use, same as processStreamEvent's message_stop handler.
	if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) {
		c.turnOutput.stopReason = "toolUse";
		c.currentPiStream.push({ type: "done", reason: "toolUse", message: c.turnOutput });
		c.currentPiStream.end();
		c.currentPiStream = null;
	}
}

// Claude Code reports account and API failures (usage limits, "Prompt is too
// long", auth) as a synthetic assistant message carrying an `error` code. Hand
// them to Pi as an error so its overflow recovery, retry and limit handling
// apply, instead of streaming the text as if Claude had said it.
function assistantErrorText(message: SDKMessage): string | undefined {
	const code = (message as { error?: unknown }).error;
	if (typeof code !== "string" || !code || code === "max_output_tokens") return undefined;
	return sdkTextFromMessage(message)?.trim() || `Claude Code error: ${code}`;
}

function failTurnWithClaudeError(errorText: string, cwd: string, bridgeConfig: Config, reason: string): void {
	const c = ctx();
	if (!c.turnOutput) return;
	if (!c.currentPiStream) {
		// Pi already holds this turn's message (a tool call it is executing).
		// Leave that message alone: drop the Claude copy and release the query;
		// Pi's tool results then start a fresh query that continues the turn.
		debug(`provider: Claude error while Pi runs tools (${reason}): ${errorText.slice(0, 200)}`);
		if (!c.reportedToolResultMismatch) bridgeRuntime().sharedSession = null;
		c.release?.();
		return;
	}
	let errorMessage = errorText;
	if (isExtraUsageRequiredMessage(errorText)) {
		const openedExtraUsage = launchExtraUsageHelperIfAllowed(cwd, bridgeConfig, reason);
		errorMessage += openedExtraUsage
			? "\n\nOpened Claude Code /extra-usage helper. Complete billing/admin flow in the browser, then retry the prompt."
			: "\n\nRun /claude-bridge:extra, or enable Allow extra usage helper in settings.";
	}
	c.handledTerminalError = true;
	c.turnOutput.stopReason = "error";
	c.turnOutput.errorMessage = errorMessage;
	if (!c.reportedToolResultMismatch) bridgeRuntime().sharedSession = null;
	const piStream = c.currentPiStream;
	c.currentPiStream = null;
	c.release?.();
	piStream?.push({ type: "error", reason: "error", error: c.turnOutput });
	piStream?.end();
}

/** Background consumer: iterates the SDK generator, pushing events to currentPiStream.
 *  Runs until the query ends. Per turn, the SDK yields stream_events (deltas), then
 *  an assistant message (completed blocks). On tool_use, the stream is ended by
 *  whichever path handles it first (processStreamEvent or processAssistantMessage),
 *  and the MCP handler blocks the generator until pi delivers the tool result.
 *  The prompt input is closed once Claude Code reports the turn finished with no
 *  queued user messages left, so the process exits and the loop ends. */
async function consumeQuery(
	sdkQuery: ReturnType<typeof query>,
	input: PromptInput,
	customToolNameToPi: Map<string, string>,
	model: Model<any>,
	cwd: string,
	bridgeConfig: Config,
	isReleased: () => boolean,
): Promise<{ capturedSessionId?: string }> {
	let capturedSessionId: string | undefined;

	for await (const message of sdkQuery) {
		// Once released (Stop, timeout, a terminal error), the shared context may
		// already belong to Pi's next turn; nothing more from this query applies.
		if (isReleased()) break;
		// A steering message that missed the tool round runs as a follow-up turn
		// in this same query; keep the input open until none are queued.
		if (message.type === "result" && !(((message as { queued_turn_count?: number }).queued_turn_count ?? 0) > 0)) input.close();
		const queryCtx = ctx();
		activeStreamIdleWatchdogs.get(queryCtx)?.noteChunk();
		if (!queryCtx.turnOutput) continue;
		if (!queryCtx.currentPiStream && !(message.type === "assistant" && queryCtx.turnSawToolCall)) continue;

		switch (message.type) {
			case "stream_event":
				processStreamEvent(message, customToolNameToPi, model);
				break;
			case "assistant": {
				const errorText = assistantErrorText(message);
				if (errorText !== undefined) failTurnWithClaudeError(errorText, cwd, bridgeConfig, "assistant error");
				else processAssistantMessage(message, model, customToolNameToPi);
				break;
			}
			case "result":
				if (!ctx().turnSawStreamEvent && message.subtype === "success") {
					ensureTurnStarted();
					const text = message.result || "";
					ctx().turnBlocks.push({ type: "text", text });
					const idx = ctx().turnBlocks.length - 1;
					ctx().currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: ctx().turnOutput });
					ctx().currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: ctx().turnOutput });
					ctx().currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: ctx().turnOutput });
				} else if (message.subtype !== "success" && isExtraUsageRequiredMessage(message)) {
					const errorLines = Array.isArray((message as any).errors) ? uniqueNonEmptyLines((message as any).errors) : [];
					const errors = errorLines.length > 0 ? errorLines.join("\n") : String(message.subtype ?? "Claude Code rate limit");
					failTurnWithClaudeError(errors, cwd, bridgeConfig, "result error");
				}
				break;
			case "system":
				if ((message as any).subtype === "init" && (message as any).session_id) {
					capturedSessionId = (message as any).session_id;
					bridgeRuntime().usage.maybeRead(sdkQuery);
				} else if ((message as any).subtype === "model_refusal_fallback") {
					const originalModel = (message as any).original_model;
					const fallbackModel = (message as any).fallback_model;
					updateTurnOutputModel(fallbackModel);
					debug("consumeQuery: model_refusal_fallback", JSON.stringify({ originalModel, fallbackModel }));
					if (originalModel === FABLE_MODEL_ID && fallbackModel === FABLE_FALLBACK_MODEL_ID) {
						safeNotify("Claude bridge switched Fable 5 to Opus 4.8 after Claude Code safety fallback.", "info");
					}
				}
				break;
			case "user":
				break; // SDK echo of user prompt — not needed
			case "rate_limit_event": {
				const info = (message as any).rate_limit_info;
				debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
				if (info?.status === "rejected") {
					const resetsAt = formatResetTimestamp(info.resetsAt);
					const resetAtMs = resetTimestampMs(info.resetsAt);
					const reason = `${info.rateLimitType ?? "unknown"} rate limit`;
					const launchedExtraUsage = isExtraUsageRequiredMessage(info) && launchExtraUsageHelperIfAllowed(cwd, bridgeConfig, reason);
					emitRateLimitEvent({
						model: model.id,
						provider: PROVIDER_ID,
						rateLimitType: info.rateLimitType,
						reason,
						resetAt: info.resetsAt,
						...(resetAtMs !== undefined ? { resetAtMs } : {}),
						source: "claude-bridge",
						status: "rejected",
					});
					bridgeRuntime().piUI?.notify(`${RATE_LIMIT_TOKEN} Claude ${reason} hit — resets ${resetsAt}${launchedExtraUsage ? "; opened /extra-usage helper" : ""}`, "warning");
				} else if (info?.status === "allowed_warning") {
					const warning = formatAllowedRateLimitWarning(info);
					if (warning) bridgeRuntime().piUI?.notify(warning, "warning");
					else debug("consumeQuery: suppressed low/ambiguous allowed_warning rate_limit_event", JSON.stringify(info).slice(0, 300));
				}
				break;
			}
			default:
				debug("consumeQuery: unhandled SDK message type", message.type);
				break;
		}
	}

	debug(`consumeQuery: for-await loop exited, released=${isReleased()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`);

	return { capturedSessionId };
}

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
export function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const runtime = bridgeRuntime();
	const run: RunInBridgeRuntime = callback => runWithBridgeRuntime(runtime, callback);
	const stream = newAssistantMessageEventStream();

	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	const cwd = (options as { cwd?: string } | undefined)?.cwd ?? bridgeRuntime().sessionCwd ?? process.cwd();
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, signalAborted=${options?.signal?.aborted === true}`);

	// --- Abort leftover ---
	// After Stop, Pi still calls the provider once with its already-aborted signal
	// (e.g. to follow the "Operation aborted" results of a stopped tool). Starting
	// Claude here would continue work the user just stopped.
	if (options?.signal?.aborted) {
		// A query can outlive the Pi run that started it (a tool batch that ends
		// the run leaves Claude Code waiting); nothing else would stop it now.
		const stale = ctx().activeQuery as Partial<Pick<ReturnType<typeof query>, "interrupt" | "close">> | null;
		if (stale) {
			if (bridgeRuntime().sharedSession) bridgeRuntime().sharedSession = { ...bridgeRuntime().sharedSession, needsRebuild: true, forceRotate: true };
			ctx().release?.();
			if (typeof stale.interrupt === "function") void stale.interrupt().catch(() => {});
			if (typeof stale.close === "function") try { stale.close(); } catch {}
		}
		const aborted = createTurnOutput(model);
		aborted.stopReason = "aborted";
		aborted.errorMessage = "Operation aborted";
		queueMicrotask(() => {
			stream.push({ type: "error", reason: "aborted", error: aborted });
			stream.end();
		});
		return stream;
	}

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Extract this turn's results
	// (everything after the last assistant message) and match against waiting MCP
	// handlers. Results that arrive before their handler get queued in pendingResults.
	if (ctx().activeQuery) {
		const queryCtx = ctx();
		queryCtx.currentPiStream = stream;
		queryCtx.resetTurnState(model);
		activeStreamIdleWatchdogs.get(queryCtx)?.refresh();

		// Steering and follow-ups: Pi drains its queue after a tool batch and
		// appends the messages after the tool results. Claude Code is blocked on
		// those results, so push the messages into its open input first; it folds
		// them in right after the results, in this same turn. Handlers are released
		// on the next macrotask so the messages reach Claude Code ahead of the
		// results. If one misses the round, Claude Code runs it as a follow-up turn
		// in this query.
		const steering = newUserMessages(context.messages, queryCtx.latestCursor);
		let steeringDelivered = true;
		for (const message of steering) {
			if (!queryCtx.input?.push(message)) steeringDelivered = false;
		}
		if (steering.length > 0) debug(`provider: pushed ${steering.length} steering message(s) into the running Claude turn, delivered=${steeringDelivered}`);
		const releaseHandler = steering.length > 0
			? (resolve: () => void) => { setImmediate(resolve); }
			: (resolve: () => void) => { resolve(); };

		const allResults = extractAllToolResults(context);
		debug(`provider: tool results, ${allResults.length} results, ${queryCtx.pendingToolCalls.size} waiting handlers, ctx.msgs=${context.messages.length}`);
		const unmatchedResultIds: string[] = [];
		for (const result of allResults) {
			const id = result.toolCallId;
			if (id && !queryCtx.hasRecordedToolCall(id)) {
				queryCtx.markToolResultUnmatched(id);
				unmatchedResultIds.push(id);
				debug(`ERROR: tool result [${id}] has no registered tool_call id; refusing to queue or deliver`);
				continue;
			}
			queryCtx.markToolResultDelivered(id);
			if (id && queryCtx.pendingToolCalls.has(id)) {
				const pending = queryCtx.pendingToolCalls.get(id)!;
				queryCtx.pendingToolCalls.delete(id);
				debug(`provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`, JSON.stringify(result.content).slice(0, 200));
				releaseHandler(() => pending.resolve(result));
			} else if (id) {
				queryCtx.pendingResults.set(id, result);
				debug(`provider: queued result [${id}] (${queryCtx.pendingResults.size} pending)`);
			} else {
				debug(`WARNING: tool result without toolCallId, cannot match`);
			}
			if (queryCtx.pendingToolCalls.size > 0 && queryCtx.pendingResults.size > 0) {
				debug(`BUG: both maps non-empty! handlers=${queryCtx.pendingToolCalls.size} results=${queryCtx.pendingResults.size}`);
			}
		}
		if (unmatchedResultIds.length > 0) {
			const errorMessage = `Claude bridge internal error: ${unmatchedResultIds.length} tool result(s) did not match any registered tool_call id. The turn was stopped to avoid delivering tool output to the wrong call. Unmatched ids: ${unmatchedResultIds.slice(0, 8).join(", ")}${unmatchedResultIds.length > 8 ? ", ..." : ""}`;
			const errorResult: McpResult = { content: [{ type: "text", text: errorMessage }], isError: true };
			for (const pending of queryCtx.pendingToolCalls.values()) pending.resolve(errorResult);
			queryCtx.pendingToolCalls.clear();
			reportToolResultMismatch(queryCtx, "unmatched tool result", cwd);
			queryCtx.handledTerminalError = true;
			queryCtx.turnOutput!.stopReason = "error";
			queryCtx.turnOutput!.errorMessage = errorMessage;
			const activeQuery = queryCtx.activeQuery as Partial<Pick<ReturnType<typeof query>, "interrupt" | "close">>;
			queryCtx.currentPiStream = null;
			queryCtx.release?.();
			stream.push({ type: "error", reason: "error", error: queryCtx.turnOutput! });
			stream.end();
			if (typeof activeQuery.interrupt === "function") void activeQuery.interrupt().catch(() => {});
			if (typeof activeQuery.close === "function") try { activeQuery.close(); } catch {}
			return stream;
		}
		const flushedLateToolCalls = flushUnemittedToolCalls();
		if (flushedLateToolCalls) debug(`provider: emitted late tool calls on result-delivery stream`);
		else if (queryCtx.pendingToolCalls.size > 0) {
			debug(`WARNING: ${queryCtx.pendingToolCalls.size} MCP handlers still waiting after delivering ${allResults.length} results`);
		}

		if (bridgeRuntime().sharedSession) {
			// A steering message that could not be pushed is only in Pi's history;
			// rebuild the copy from it before the next turn.
			bridgeRuntime().sharedSession = steeringDelivered
				? { ...bridgeRuntime().sharedSession, cursor: context.messages.length }
				: { ...bridgeRuntime().sharedSession, needsRebuild: true };
		}
		queryCtx.latestCursor = Math.max(queryCtx.latestCursor, context.messages.length);
		return stream;
	}

	// --- Fresh query ---

	// 1. Determine reentrancy and push parent context if needed.
	const isReentrant = ctx().activeQuery !== null;
	if (isReentrant) pushContext();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, stackDepth=${stackDepth()}`);

	// 2. Fresh child context — constructor already gave us clean Maps and empty
	//    arrays. For a reused top-level context, clear explicitly.
	ctx().currentPiStream = stream;
	ctx().pendingToolCalls.clear();
	ctx().pendingResults.clear();
	ctx().resetTurnState(model);
	ctx().resetToolTracking();
	ctx().reportedToolResultMismatch = false;
	ctx().latestCursor = context.messages.length;

	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);

	const mcpServers = buildMcpServers(mcpTools, ctx());
	const bridgeConfig = loadBridgeConfig(cwd);
	const providerSettings = bridgeConfig.provider ?? {};
	const systemPromptMode = providerSettings.systemPromptMode ?? "claude-code";
	const appendSystemPrompt = systemPromptMode === "claude-code" && providerSettings.appendSystemPrompt !== false;
	const agentsAppend = appendSystemPrompt ? extractAgentsAppend() : undefined;
	const skillsAppend = appendSystemPrompt ? extractSkillsBlock(context.systemPrompt) : undefined;
	const promptContextAppend = systemPromptMode === "claude-code"
		? buildPromptContextAppend(context.systemPrompt, cwd, bridgeConfig.promptContext ?? {}, bridgeRuntime().userDir)
		: { text: undefined, labels: [] };
	const appendParts = [agentsAppend, skillsAppend, promptContextAppend.text].filter((part): part is string => Boolean(part));
	const systemPromptAppend = appendParts.length > 0 ? appendParts.join("\n\n") : undefined;

	// MCP auto-loading suppression: with appendSystemPrompt=true (default), the
	// SDK uses isolation mode and avoids filesystem settings. If users turn that
	// off, load user/project settings but pass --strict-mcp-config so Claude Code
	// ignores auto-discovered filesystem MCP servers while Pi owns tool execution.
	const settingSources: SettingSource[] | undefined = systemPromptMode === "pi"
		? []
		: appendSystemPrompt
			? undefined
			: providerSettings.settingSources ?? ["user", "project"];
	const strictMcpConfigEnabled = !appendSystemPrompt && providerSettings.strictMcpConfig !== false;
	const env = claudeEnvironment();
	const claudeExecutable = resolveClaudeCodeExecutable({ configuredPath: providerSettings.pathToClaudeCodeExecutable, env })?.executablePath;
	const claudeExecutablePreflight = claudeExecutable ? preflightClaudeExecutable(claudeExecutable, cwd) : undefined;
	const { sessionId: resumeSessionId, rescue } = syncSharedSession(context.messages, cwd, model, customToolNameToSdk);

	// 3. Prompt. The input stays open for the whole turn so steering can be
	//    pushed into it. In a rescue the copy already ends on the unanswered
	//    message and Claude Code answers it without a prompt from us.
	const input = new PromptInput();
	let promptPreview = "(rescue: answer the unanswered end of the copy)";
	if (!rescue) {
		const lastMsg = context.messages[context.messages.length - 1];
		let content = lastMsg ? userMessageToPromptContent(lastMsg) : "";
		if (content.length === 0) {
			// Guard: the last context message should be a non-empty user message here.
			diagDump("empty_prompt", {
				contextLength: context.messages.length,
				lastMsgRole: lastMsg?.role,
				isReentrant,
				stackDepth: stackDepth(),
				messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
			});
			// Recover: use a continuation prompt so the SDK doesn't send an empty text block
			content = "[continue]";
		}
		promptPreview = typeof content === "string" ? content.slice(0, 60) : "[+images]";
		input.push(sdkUserMessage(content));
	}
	ctx().input = input;

	// Prefer the model's own thinkingLevelMap when present (pi-ai 0.72+ ships
	// per-model overrides — e.g. opus-4-7 wants xhigh→xhigh, not xhigh→max).
	// Fall back to our generic table for older pi-ai or unmapped levels.
	const requestedEffort = options?.reasoning
		? ((model as any).thinkingLevelMap?.[options.reasoning] as EffortLevel | undefined)
			?? REASONING_TO_EFFORT[options.reasoning]
		: undefined;
	const effort = resolveConfiguredEffort(model.id, requestedEffort, providerSettings);

	const extraArgs: Record<string, string | null> = {};
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.
	if (effort) extraArgs["thinking-display"] = "summarized";
	const fallbackModel = fallbackModelForPrimaryModel(model.id);

	// Suppress claude.ai cloud MCP servers (Figma/Canva/etc. auto-discovered via OAuth
	// when the user is logged into Anthropic). These are a separate code path from
	// filesystem MCP and are NOT blocked by --strict-mcp-config or settingSources=undefined.
	// The native CC binary gates them on env var ENABLE_CLAUDEAI_MCP_SERVERS: setting it
	// to "0"/"false"/"no"/"off" makes the loader return early before any cloud fetch.
	// DISABLE_AUTO_COMPACT=1: pi owns context-management and propagates its own
	// /compact via session_compact (see handler in default export). Letting CC
	// also autocompact would double-flush the prompt cache and races pi's
	// threshold with CC's, including CC's anti-thrashing guard (issue #8).
	// Manual /compact in CC still works (we never invoke it).
	const childEnv = {
		...env,
		ENABLE_CLAUDEAI_MCP_SERVERS: "0",
		DISABLE_AUTO_COMPACT: "1",
		...(rescue ? { CLAUDE_CODE_RESUME_INTERRUPTED_TURN: "1" } : {}),
	};
	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		model: model.id,
		env: childEnv,
		...CLAUDE_BRIDGE_TOOL_ISOLATION,
		permissionMode: "bypassPermissions",
		includePartialMessages: true,
		...(fallbackModel ? { fallbackModel } : {}),
		...(providerSettings.fastMode ? { settings: { fastMode: true } } : {}),
		systemPrompt: systemPromptMode === "pi"
			? context.systemPrompt ?? ""
			: {
				type: "preset", preset: "claude_code",
				append: systemPromptAppend ? systemPromptAppend : undefined,
			},
		extraArgs,
		...(effort ? { effort } : {}),
		...(settingSources ? { settingSources } : {}),
		...(mcpServers ? { mcpServers } : {}),
		...(resumeSessionId ? { resume: resumeSessionId } : {}),
		...(claudeExecutable ? { pathToClaudeCodeExecutable: claudeExecutable } : {}),
		spawnClaudeCodeProcess: spawnClaudeCodeWithDiagnostics,
		...makeCliDebugOptions("provider"),
	};

	debug("provider: fresh query",
		`model=${queryOptions.model} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} rescue=${rescue} effort=${effort ?? "default"}`,
		`fallback=${fallbackModel ?? "none"}`,
		`systemPrompt=${systemPromptMode} appendSys=${appendSystemPrompt} promptCtx=${promptContextAppend.labels.join(",") || "none"} strictMcp=${strictMcpConfigEnabled} fastMode=${providerSettings.fastMode === true}`,
		`claudeExec=${claudeExecutablePreflight ? `${claudeExecutablePreflight.fileType}:${claudeExecutablePreflight.path}` : "sdk-default"}`,
		`prompt=${promptPreview}`);

	// 4. Start SDK query and claim it for this context
	let wasAborted = false;
	let streamIdleTimedOut = false;
	let released = false;
	const sdkQuery = query({ prompt: input, options: queryOptions });
	ctx().activeQuery = sdkQuery;

	// 5. Capture context for abort handling (must be AFTER pushContext)
	const abortCtx = ctx();

	const requestAbort = () => {
		// interrupt() asks the CLI to stop gracefully; close() kills it immediately.
		// Both are needed — interrupt alone lets the current API call finish.
		void sdkQuery.interrupt().catch(() => {});
		try { sdkQuery.close(); } catch {}
	};
	const streamIdleTimeoutMs = streamIdleTimeoutMsFromEnv();
	const streamIdleWatchdog = streamIdleTimeoutMs > 0
		? createStreamIdleWatchdog({
			getState: () => ({
				activeQuery: abortCtx.activeQuery,
				currentPiStream: abortCtx.currentPiStream,
				turnOutput: abortCtx.turnOutput,
				turnSawStreamEvent: abortCtx.turnSawStreamEvent,
				turnStarted: abortCtx.turnStarted,
			}),
			onTimeout: ({ idleMs, timeoutMs }) => run(() => {
				if (streamIdleTimedOut || wasAborted || options?.signal?.aborted || abortCtx.activeQuery !== sdkQuery) return;
				streamIdleTimedOut = true;
				abortCtx.handledTerminalError = true;
				if (bridgeRuntime().sharedSession) bridgeRuntime().sharedSession = { ...bridgeRuntime().sharedSession, needsRebuild: true, forceRotate: true };
				const errorMessage = buildStreamIdleTimeoutErrorMessage(timeoutMs);
				debug("provider: stream idle timeout", `model=${model.id}`, `timeout=${timeoutMs}`, `idle=${idleMs}`);
				emitRateLimitEvent({
					idleMs,
					model: model.id,
					provider: PROVIDER_ID,
					rateLimitType: "stream_idle",
					reason: "Claude Code stream idle timeout",
					retryAfterMs: STREAM_IDLE_BACKOFF_HINT_MS,
					source: "claude-bridge",
					status: "rejected",
					timeoutMs,
				});
				if (abortCtx.turnOutput) {
					abortCtx.turnOutput.stopReason = "error";
					abortCtx.turnOutput.errorMessage = errorMessage;
					Object.assign(abortCtx.turnOutput as AssistantMessage & Record<string, unknown>, {
						rateLimitType: "stream_idle",
						retryAfterMs: STREAM_IDLE_BACKOFF_HINT_MS,
						streamIdleTimeoutMs: timeoutMs,
					});
				}
				const piStream = abortCtx.currentPiStream;
				abortCtx.currentPiStream = null;
				releaseQuery();
				piStream?.push({ type: "error", reason: "error", error: abortCtx.turnOutput! });
				piStream?.end();
				requestAbort();
			}),
			timeoutMs: streamIdleTimeoutMs,
		})
		: null;
	if (streamIdleWatchdog) {
		activeStreamIdleWatchdogs.set(abortCtx, streamIdleWatchdog);
		streamIdleWatchdog.refresh();
	}
	const onAbort = () => run(() => {
		if (released) return;
		wasAborted = true;
		reportToolResultMismatch(abortCtx, "abort", cwd, { forceRotate: true });
		// The killed Claude Code process may still write to its session file, so
		// the next turn rebuilds the copy under a new session id.
		if (bridgeRuntime().sharedSession) bridgeRuntime().sharedSession = { ...bridgeRuntime().sharedSession, needsRebuild: true, forceRotate: true };
		for (const pending of abortCtx.pendingToolCalls.values()) { pending.resolve({ content: [{ type: "text", text: "Operation aborted" }] }); }
		abortCtx.pendingToolCalls.clear();
		abortCtx.pendingResults.clear();
		requestAbort();
		// Stop can flush queued messages into a new Pi run before Claude Code
		// exits; end this turn and release the query now, not when it exits.
		const piStream = abortCtx.currentPiStream;
		abortCtx.currentPiStream = null;
		releaseQuery();
		if (piStream && abortCtx.turnOutput) {
			abortCtx.turnOutput.stopReason = "aborted";
			abortCtx.turnOutput.errorMessage = "Operation aborted";
			piStream.push({ type: "error", reason: "aborted", error: abortCtx.turnOutput });
			piStream.end();
		}
	});
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	// Release the query before Pi hears that the turn ended. Pi can call the
	// provider again immediately (a steering message queued during the final
	// reply, messages flushed by Stop, a retry); that call must start a fresh
	// query instead of being routed into this finished one as tool results.
	const releaseQuery = () => {
		if (released) return;
		released = true;
		input.close();
		streamIdleWatchdog?.dispose();
		activeStreamIdleWatchdogs.delete(abortCtx);
		if (options?.signal) options.signal.removeEventListener("abort", onAbort);
		if (abortCtx.activeQuery !== sdkQuery) return;
		reportToolResultMismatch(abortCtx, "query teardown", cwd, { forceRotate: wasAborted || options?.signal?.aborted || streamIdleTimedOut });
		// Drain pending handlers for this query
		for (const pending of abortCtx.pendingToolCalls.values()) { pending.resolve({ content: [{ type: "text", text: "Query ended" }] }); }
		abortCtx.pendingToolCalls.clear();
		abortCtx.pendingResults.clear();
		abortCtx.input = null;
		abortCtx.release = null;
		// A reentrant context is popped in finally, after its stream is finalized.
		if (!isReentrant) abortCtx.activeQuery = null;
	};
	abortCtx.release = releaseQuery;

	// Background consumer — runs until query ends
	consumeQuery(sdkQuery, input, customToolNameToPi, model, cwd, bridgeConfig, () => released)
		.then(({ capturedSessionId }) => {
			debug(`provider: consumeQuery completed, stopReason=${abortCtx.turnOutput?.stopReason}, error=${abortCtx.turnOutput?.errorMessage}, released=${released}`);
			// Stop, a stream timeout or a terminal error already ended the turn.
			if (released) return;

			if (abortCtx.reportedToolResultMismatch) {
				debug(`provider: tool-result mismatch terminated query; preserving rebuild state`);
			}
			assertInitialQuerySucceeded(abortCtx);

			// --- Capture session ID ---
			const previousSession = bridgeRuntime().sharedSession;
			const sessionId = capturedSessionId ?? previousSession?.sessionId;
			if (sessionId) {
				const cursor = Math.max(context.messages.length, abortCtx.latestCursor, previousSession?.cursor ?? 0);
				debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
				// Keep a rebuild marked during the turn (e.g. a steering message that
				// could not be pushed exists only in Pi's history).
				bridgeRuntime().sharedSession = {
					sessionId, cursor, cwd,
					...(previousSession?.needsRebuild ? { needsRebuild: true } : {}),
					...(previousSession?.forceRotate ? { forceRotate: true } : {}),
				};
			}

			releaseQuery();
			finalizeCurrentStream(abortCtx.turnOutput?.stopReason);
		})
		.catch((error) => {
			debug(`provider: query error, model=${model.id}, released=${released}, error=`, error);
			if (released) return;
			const openedExtraUsage = isExtraUsageRequiredMessage(error) && launchExtraUsageHelperIfAllowed(cwd, bridgeConfig, "query error");
			if (!abortCtx.reportedToolResultMismatch) bridgeRuntime().sharedSession = null;
			const piStream = abortCtx.currentPiStream;
			abortCtx.currentPiStream = null;
			releaseQuery();
			if (abortCtx.turnOutput) {
				abortCtx.turnOutput.stopReason = "error";
				abortCtx.turnOutput.errorMessage = `${error instanceof Error ? error.message : String(error)}${openedExtraUsage ? "\n\nOpened Claude Code /extra-usage helper. Complete billing/admin flow in the browser, then retry the prompt." : ""}`;
			}
			piStream?.push({ type: "error", reason: "error", error: abortCtx.turnOutput! });
			piStream?.end();
		})
		.finally(() => {
			releaseQuery();
			if (isReentrant && abortCtx.activeQuery === sdkQuery) popContext();
			sdkQuery.close();
		});

	return stream;
}

function commandCwd(ctx: unknown): string {
	const value = (ctx as { cwd?: unknown })?.cwd;
	return typeof value === "string" && value.length > 0 ? value : process.cwd();
}

async function tryOpenExtensionManagerSettings(ctx: { ui: ExtensionUIContext }): Promise<boolean> {
	const host = globalThis as unknown as Record<PropertyKey, unknown>;
	const openQuickSettings = host[Symbol.for("vstack.pi.extension-manager.open-quick-settings")];
	if (typeof openQuickSettings !== "function") return false;
	try {
		await (openQuickSettings as (ctx: unknown, hint?: string) => Promise<void>)(ctx, "@fractaal/pi-claude-bridge");
		return true;
	} catch {
		return false;
	}
}

function showBridgeStatus(ctx: { ui: ExtensionUIContext; cwd?: string }): void {
	const config = loadBridgeConfig(commandCwd(ctx));
	ctx.ui.notify([
		`Claude bridge: ${config.enabled === false ? "disabled" : "enabled"}`,
		`Extra usage auto-helper: ${extraUsageAllowed(config) ? "on" : "off"} (settings)`,
		`Use /claude-bridge:extra to run Claude Code /extra-usage now.`,
	].join("\n"), "info");
}

type RunInBridgeRuntime = <T>(callback: () => T) => T;

function registerBridgeCommands(pi: ExtensionAPI, run: RunInBridgeRuntime): void {
	const guard = pi as unknown as Record<PropertyKey, unknown>;
	if (guard[COMMANDS_REGISTERED_KEY]) return;
	guard[COMMANDS_REGISTERED_KEY] = true;

	const runExtraUsage = async (ctx: { ui: ExtensionUIContext; cwd?: string }) => {
		const cwd = commandCwd(ctx);
		if (bridgeRuntime().extraUsageHelperInFlight) {
			ctx.ui.notify("Claude extra usage helper already running.", "info");
			await bridgeRuntime().extraUsageHelperInFlight.catch(() => undefined);
			return;
		}
		try {
			ctx.ui.notify("Claude extra usage helper starting…", "info");
			bridgeRuntime().extraUsageHelperInFlight = runExtraUsageHelper(cwd)
				.finally(() => { bridgeRuntime().extraUsageHelperInFlight = null; });
			const message = await bridgeRuntime().extraUsageHelperInFlight;
			ctx.ui.notify(`Claude extra usage helper: ${message}`, "info");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Claude extra usage helper failed: ${message}`, "error");
		}
	};

	pi.registerCommand("claude-bridge", {
		description: "Open Claude bridge settings/status",
		handler: (args: string, ctx) => run(async () => {
			if (args.trim()) ctx.ui.notify("Unknown /claude-bridge argument. Use /claude-bridge:extra to run Claude Code /extra-usage.", "warning");
			if (await tryOpenExtensionManagerSettings(ctx)) return;
			showBridgeStatus(ctx);
		}),
	});
	pi.registerCommand("claude-bridge:extra", {
		description: "Run Claude Code /extra-usage through claude-bridge",
		handler: (_args: string, ctx) => run(() => runExtraUsage(ctx)),
	});
}

// --- Extension registration ---

export interface ClaudeBridgeExtensionOptions {
	userDir?: string;
	/** Claude child/profile environment overrides. Undefined values suppress inherited keys. */
	env?: NodeJS.ProcessEnv;
}

function registerClaudeBridge(pi: ExtensionAPI, options: ClaudeBridgeExtensionOptions) {
	const runtime = createBridgeRuntimeState(options.userDir, options.env);
	const run: RunInBridgeRuntime = callback => runWithBridgeRuntime(runtime, callback);
	const boundStream = ((model: Model<any>, context: Context, options?: SimpleStreamOptions) =>
		run(() => streamClaudeAgentSdk(model, context, options))) as typeof streamClaudeAgentSdk;

	return run(() => {
		bridgeRuntime().extensionApi = pi;
		const config = loadBridgeConfig(process.cwd());
		debug("loadConfig:", JSON.stringify(config));
		registerBridgeCommands(pi, run);
		if (config.enabled === false) {
			debug("provider: disabled by configuration");
			return;
		}

		const clearSession = (event: string) => {
			debug(`${event}: clearing session ${bridgeRuntime().sharedSession?.sessionId?.slice(0, 8) ?? "none"}`);
			bridgeRuntime().sharedSession = null;
			if (!isolatedModule) {
				const g = globalThis as Record<symbol, any>;
				if (g[ACTIVE_STREAM_SIMPLE_KEY] === boundStream) {
					debug(`${event}: clearing ACTIVE_STREAM_SIMPLE_KEY`);
					g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
				}
			}
		};
		pi.on("session_start", (event, ctx) => run(() => {
			recordProjectTrust(ctx);
			bridgeRuntime().piUI = ctx.ui;
			const sessionCwd = typeof (ctx.sessionManager as any)?.getCwd === "function" ? (ctx.sessionManager as any).getCwd() : ctx.cwd;
			if (typeof sessionCwd === "string" && sessionCwd) bridgeRuntime().sessionCwd = sessionCwd;
			if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
				clearSession(`session_start:${event.reason}`);
			}
			// A fork rebuilds from Pi history; it must not resume the parent's Claude JSONL.
			if (event.reason === "startup" || event.reason === "resume") restoreSharedSessionFromPi(ctx);
		}));
		pi.on("session_shutdown", () => run(() => clearSession("session_shutdown")));
		pi.on("message_end", (event, ctx) => run(() => {
			const message = (event as { message?: AssistantMessage }).message;
			if (message?.role === "assistant" && message.provider === PROVIDER_ID) schedulePersistSharedSession(ctx);
		}));

		const markRebuild = (event: string) => {
			if (ctx().activeQuery) {
				reportToolResultMismatch(ctx(), event, bridgeRuntime().sharedSession?.cwd ?? process.cwd());
			}
			if (bridgeRuntime().sharedSession) {
				debug(`${event}: marking needsRebuild on session ${bridgeRuntime().sharedSession.sessionId.slice(0, 8)}`);
				bridgeRuntime().sharedSession = { ...bridgeRuntime().sharedSession, needsRebuild: true };
			}
		};
		pi.on("session_compact", () => run(() => markRebuild("session_compact")));
		pi.on("session_tree", () => run(() => markRebuild("session_tree")));

		const catalog = createClaudeModelCatalog({
			initialModels: MODELS,
			discover: (signal) => run(() => {
				const cwd = bridgeRuntime().sessionCwd ?? process.cwd();
				const configured = loadBridgeConfig(cwd).provider?.pathToClaudeCodeExecutable;
				return discoverClaudeModels({ env: claudeEnvironment(), executablePath: configured, signal });
			}),
			warn: (message) => run(() => {
				pi.events.emit("claude-bridge:model-discovery-warning", { message });
				bridgeRuntime().piUI?.notify(message, "warning");
			}),
		});
		const providerConfig = {
			baseUrl: "claude-bridge",
			apiKey: "not-used",
			api: "claude-bridge" as const,
			models: MODELS,
			refreshModels: catalog.refresh,
			streamSimple: boundStream as any,
		};
		if (isolatedModule) {
			pi.registerProvider(PROVIDER_ID, providerConfig);
			return;
		}

		const g = globalThis as Record<symbol, any>;
		if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
			g[ACTIVE_STREAM_SIMPLE_KEY] = boundStream;
			pi.registerProvider(PROVIDER_ID, providerConfig);
		} else {
			debug(`provider: skipping re-registration, parent instance active (module=${moduleInstanceId})`);
		}
	});
}

export function createClaudeBridgeExtension(options: ClaudeBridgeExtensionOptions = {}) {
	return (pi: ExtensionAPI) => registerClaudeBridge(pi, options);
}

export default createClaudeBridgeExtension();
