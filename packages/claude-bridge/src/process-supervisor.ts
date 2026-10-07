const SUPERVISOR_ERROR_PREFIX = "__CLAUDE_BRIDGE_CHILD_ERROR__";
export const SUPERVISOR_PID_PREFIX = "__CLAUDE_BRIDGE_CHILD_PID__";

/**
 * Small Node supervisor used because child_process.spawn has no pre-exec hook for
 * setting PR_SET_PDEATHSIG. It keeps the Claude Code child in a separate process
 * group, forwards stdin/stdout/stderr, and notices when its bridge parent has
 * disappeared. The source is embedded in the bridge bundle, so the published
 * package does not need a platform-specific helper executable.
 */
export const SUPERVISOR_SCRIPT = String.raw`
const { spawn } = require("node:child_process");

const ERROR_PREFIX = ${JSON.stringify(SUPERVISOR_ERROR_PREFIX)};
const PID_PREFIX = ${JSON.stringify(SUPERVISOR_PID_PREFIX)};
const parentPid = Number(process.env.CLAUDE_BRIDGE_PARENT_PID);
const command = process.env.CLAUDE_BRIDGE_CHILD_COMMAND;
const args = JSON.parse(process.env.CLAUDE_BRIDGE_CHILD_ARGS_JSON || "[]");
const childEnv = JSON.parse(process.env.CLAUDE_BRIDGE_CHILD_ENV_JSON || "{}");
const childCwd = process.env.CLAUDE_BRIDGE_CHILD_CWD || process.cwd();

let child;
let stopping = false;
let finished = false;
let forceTimer;
let parentTimer;

function serializableError(error) {
  return {
    message: error instanceof Error ? error.message : String(error),
    code: error && typeof error === "object" && typeof error.code === "string" ? error.code : undefined,
    errno: error && typeof error === "object" && typeof error.errno === "number" ? error.errno : undefined,
    syscall: error && typeof error === "object" && typeof error.syscall === "string" ? error.syscall : undefined,
    path: error && typeof error === "object" && typeof error.path === "string" ? error.path : undefined,
  };
}

function reportError(error) {
  try { process.stderr.write(ERROR_PREFIX + JSON.stringify(serializableError(error)) + "\n"); } catch {}
}

function stopChild(signal) {
  if (!child || child.exitCode !== null || child.killed) return;
  stopping = true;
  try { child.kill(signal); } catch {}
  if (!forceTimer && signal !== "SIGKILL") {
    forceTimer = setTimeout(() => {
      try { if (child.exitCode === null) child.kill("SIGKILL"); } catch {}
    }, 2000);
    forceTimer.unref?.();
  }
}

function finish(code, signal) {
  if (finished) return;
  finished = true;
  if (forceTimer) clearTimeout(forceTimer);
  if (parentTimer) clearInterval(parentTimer);
  if (signal && process.platform !== "win32") {
    // The supervisor is the process the SDK observes. Returning the conventional
    // signal exit code avoids re-entering our signal handler while preserving the
    // fact that the Claude child stopped because of a signal.
    process.exitCode = 128 + (typeof signal === "string" ? ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15, SIGKILL: 9 }[signal] || 1) : 1);
  } else {
    process.exitCode = typeof code === "number" ? code : 1;
  }
  setImmediate(() => process.exit(process.exitCode || 0));
}

try {
  child = spawn(command, args, {
    cwd: childCwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  process.stderr.write(PID_PREFIX + String(child.pid || "") + "\n");
} catch (error) {
  reportError(error);
  finish(1);
}

if (child) {
  process.stdin.on("error", () => {});
  child.stdin.on("error", () => {});
  process.stdin.pipe(child.stdin);
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  child.once("error", (error) => reportError(error));
  child.once("exit", (code, signal) => finish(code, signal));
}

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => stopChild(signal));
}

parentTimer = setInterval(() => {
  if (!Number.isInteger(parentPid) || parentPid <= 0 || process.ppid !== parentPid) {
    stopChild("SIGTERM");
  }
}, 50);
parentTimer.unref?.();
`;

export function supervisorEnvironment(
	command: string,
	args: readonly string[],
	env: NodeJS.ProcessEnv,
	cwd: string | undefined,
): NodeJS.ProcessEnv {
	return {
		...env,
		CLAUDE_BRIDGE_PARENT_PID: String(process.pid),
		CLAUDE_BRIDGE_CHILD_COMMAND: command,
		CLAUDE_BRIDGE_CHILD_ARGS_JSON: JSON.stringify(args),
		CLAUDE_BRIDGE_CHILD_ENV_JSON: JSON.stringify(env),
		...(cwd ? { CLAUDE_BRIDGE_CHILD_CWD: cwd } : {}),
	};
}

export function parseSupervisorError(line: string): { message: string; code?: string; errno?: number; syscall?: string; path?: string } | undefined {
	if (!line.startsWith(SUPERVISOR_ERROR_PREFIX)) return undefined;
	try {
		const parsed = JSON.parse(line.slice(SUPERVISOR_ERROR_PREFIX.length)) as Record<string, unknown>;
		return {
			message: typeof parsed.message === "string" ? parsed.message : "Claude Code child process failed to start",
			...(typeof parsed.code === "string" ? { code: parsed.code } : {}),
			...(typeof parsed.errno === "number" ? { errno: parsed.errno } : {}),
			...(typeof parsed.syscall === "string" ? { syscall: parsed.syscall } : {}),
			...(typeof parsed.path === "string" ? { path: parsed.path } : {}),
		};
	} catch {
		return { message: line.slice(SUPERVISOR_ERROR_PREFIX.length) || "Claude Code child process failed to start" };
	}
}
