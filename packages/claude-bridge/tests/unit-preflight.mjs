/**
 * Tests for Claude executable preflight diagnostics.
 * The checks do not require Claude Code to be installed; they use temp files
 * and the current Node executable as a known platform binary.
 */
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { preflightClaudeExecutable, spawnClaudeCodeWithDiagnostics } from "../src/index.ts";

function withTempDir(fn) {
	const dir = mkdtempSync(join(tmpdir(), "claude-bridge-preflight-"));
	let cleanupNow = true;
	const cleanup = () => rmSync(dir, { recursive: true, force: true });
	try {
		const result = fn(dir);
		if (result && typeof result.then === "function") {
			cleanupNow = false;
			return result.finally(cleanup);
		}
		return result;
	} finally {
		if (cleanupNow) cleanup();
	}
}

describe("preflightClaudeExecutable", () => {
	it("accepts an existing executable shebang script", () => withTempDir((dir) => {
		const script = join(dir, "claude-wrapper");
		writeFileSync(script, "#!/bin/sh\nexit 0\n");
		chmodSync(script, 0o755);

		const result = preflightClaudeExecutable(script, dir);
		assert.equal(result.path, script);
		assert.equal(result.cwd, dir);
		assert.equal(result.fileType, "shebang-script");
	}));

	it("accepts the current Node executable as an existing platform binary", () => withTempDir((dir) => {
		const result = preflightClaudeExecutable(process.execPath, dir);
		assert.equal(result.path, process.execPath);
		assert.match(result.fileType, /^(elf|mach-o|pe)$/);
	}));

	it("reports errno details for a non-existent executable path", () => withTempDir((dir) => {
		const missing = join(dir, "missing-claude");
		assert.throws(
			() => preflightClaudeExecutable(missing, dir),
			(error) => {
				assert.equal(error.name, "ClaudeExecutablePreflightError");
				assert.equal(error.code, "ENOENT");
				assert.equal(error.path, missing);
				assert.equal(error.cwd, dir);
				assert.equal(error.syscall, "stat");
				assert.match(error.message, /code=ENOENT/);
				assert.match(error.message, /errno=-?\d+/);
				assert.match(error.message, /syscall=stat/);
				assert.doesNotMatch(error.message, /native binary not found/);
				return true;
			},
		);
	}));

	it("reports errno details for a deleted cwd before checking the executable", () => withTempDir((dir) => {
		rmSync(dir, { recursive: true, force: true });
		assert.throws(
			() => preflightClaudeExecutable(process.execPath, dir),
			(error) => {
				assert.equal(error.name, "ClaudeExecutablePreflightError");
				assert.equal(error.code, "ENOENT");
				assert.equal(error.path, dir);
				assert.equal(error.cwd, dir);
				assert.equal(error.syscall, "stat");
				assert.match(error.message, /cwd is not reachable/);
				assert.ok(error.message.includes(`cwd=${dir}`));
				assert.doesNotMatch(error.message, /native binary not found/);
				return true;
			},
		);
	}));

	it("reports structured details when cwd is a file", () => withTempDir((dir) => {
		const fileCwd = join(dir, "not-a-directory");
		writeFileSync(fileCwd, "not a directory\n");
		assert.throws(
			() => preflightClaudeExecutable(process.execPath, fileCwd),
			(error) => {
				assert.equal(error.name, "ClaudeExecutablePreflightError");
				assert.equal(error.code, "ENOTDIR");
				assert.equal(error.path, fileCwd);
				assert.equal(error.cwd, fileCwd);
				assert.equal(error.syscall, "chdir");
				assert.match(error.message, /cwd is not a directory/);
				assert.ok(error.message.includes(`cwd=${fileCwd}`));
				return true;
			},
		);
	}));

	it("rewrites spawn ENOENT so SDK surfaces diagnostic context", async () => withTempDir(async (dir) => {
		const missing = join(dir, "missing-claude");
		const proc = spawnClaudeCodeWithDiagnostics({
			command: missing,
			args: [],
			cwd: dir,
			env: {},
			signal: new AbortController().signal,
		});
		const error = await new Promise((resolve) => proc.once("error", resolve));
		assert.equal(error.name, "ClaudeSpawnDiagnosticError");
		assert.equal(error.code, "CLAUDE_BRIDGE_SPAWN_FAILED");
		assert.equal(error.originalCode, "ENOENT");
		assert.match(error.originalMessage, /ENOENT/);
		assert.equal(error.path, missing);
		assert.equal(error.cwd, dir);
		assert.match(error.message, /code=ENOENT/);
		assert.match(error.message, /syscall=spawn/);
		assert.doesNotMatch(error.message, /native binary not found/);
		assert.notEqual(error.cause, error);
		assert.doesNotThrow(() => JSON.stringify(error));
		assert.doesNotMatch(error.stack ?? "", /wrapClaudeSpawnErrorForSdk/);
	}));

	it("stops Claude Code when the bridge host disappears", async () => withTempDir(async (dir) => {
		const pidFile = join(dir, "child.pid");
		const bundle = join(new URL("..", import.meta.url).pathname, "bundle", "index.js");
		const host = spawn(process.execPath, [
			"--input-type=module",
			"-e",
			`const { spawnClaudeCodeWithDiagnostics } = await import(${JSON.stringify(bundle)});\n` +
				`const { writeFileSync } = await import("node:fs");\n` +
				`const child = spawnClaudeCodeWithDiagnostics({ command: process.execPath, args: ["-e", ${JSON.stringify(`const { writeFileSync } = require("node:fs"); writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`)}], cwd: ${JSON.stringify(dir)}, env: process.env, signal: new AbortController().signal });\n` +
				`child.once("error", (error) => { writeFileSync(${JSON.stringify(join(dir, "host-error.txt"))}, String(error)); process.exit(1); });\n` +
				`console.log("ready");\nsetTimeout(() => process.exit(0), 150);`,
		], { cwd: dir, stdio: ["ignore", "pipe", "pipe"] });
		let output = "";
		host.stdout.on("data", (chunk) => { output += chunk.toString(); });
		const closed = new Promise((resolve) => host.once("close", resolve));
		for (let attempt = 0; attempt < 50 && !existsSync(pidFile); attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(output.trim(), "ready");
		assert.ok(existsSync(pidFile), "the supervised Claude child started");
		await closed;
		const childPid = Number(readFileSync(pidFile, "utf8"));
		let alive = true;
		for (let attempt = 0; attempt < 60 && alive; attempt++) {
			try { process.kill(childPid, 0); } catch { alive = false; }
			if (alive) await new Promise((resolve) => setTimeout(resolve, 50));
		}
		if (alive) {
			try { process.kill(childPid, "SIGKILL"); } catch {}
		}
		assert.equal(alive, false, "the Claude child must not survive its bridge host");
	}));
});
