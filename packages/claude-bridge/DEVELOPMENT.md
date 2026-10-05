# pi-claude-bridge — development notes

Implementation details for contributors. End-user setup, settings, and troubleshooting live in [`README.md`](./README.md).

## Stream and tool-result handling

- The bridge runs Claude Code through the Claude Agent SDK while Pi remains the owner of the visible TUI and tool execution.
- If the SDK stream yields a completed assistant tool-use message before `message_stop`, the bridge treats that assistant message as the tool-turn boundary. Pi executes the tool calls immediately, and the matching tool results are delivered back before the turn continues.
- If the SDK reveals another tool call after that boundary, the bridge emits the previously unseen call on the next Pi result-delivery stream instead of leaving its MCP handler waiting forever.
- Tool results whose IDs were never registered in the active assistant tool-use turn are refused instead of being queued against another pending call. Remaining handlers receive an internal-error result so the turn cannot report false success.
- If a query tears down while parallel tool results are still queued or unresolved, the bridge writes diagnostics, marks the Claude session for rebuild, and re-imports delivered results from Pi history on the next turn.
- Each query keeps its prompt input open until Claude Code reports the turn finished. Steering and follow-up messages that Pi appends after a tool batch are pushed into that input before the tool results are released, so Claude Code folds them into the running turn. There is no interrupt-and-resume path: resuming a Claude session that ends on a user-role message makes Claude Code insert a synthetic "No response requested." reply.
- The query is released before Pi is told a turn ended, on every path (completion, Stop, stream-idle timeout, Claude errors). Pi can call again at once (Stop flushes queued messages); that call must start a fresh query.
- A call with an already-aborted signal is Pi following up a stopped turn; the bridge returns `aborted` without starting Claude Code.

## Tools Claude sees

- Pi's tools reach Claude Code through one in-process MCP server whose `tools/list` returns each tool's JSON Schema unchanged. Claude Code sends an MCP tool's input schema to the API as listed, so unions and references survive; the earlier Zod conversion for `createSdkMcpServer` did not.
- The only Claude Code built-in kept is ToolSearch. Claude Code defers every MCP tool not marked `_meta["anthropic/alwaysLoad"]`, and `tools: []` would remove ToolSearch and with it all deferral.
- Pi's own tools are marked always-load. Tools Pi bridges from other MCP servers (`mcp__<server>__<tool>`) are deferred until Claude has called them in the session: Claude Code rebuilds its loaded set only from its own `tool_reference` results, which a copy rebuilt from Pi history does not contain.
- Claude Code runs ToolSearch itself. The bridge does not emit it to Pi, so Pi's turn continues into Claude's next request.

## Claude session copy

- Claude Code runs in the Pi session's working directory, recorded at `session_start`. Pi passes no cwd to providers, and the host process's cwd (for Symphony Desktop, its launch directory) would otherwise become Claude Code's working directory and git context.

- Pi history is canonical. The Claude session file is a copy: resumed while Pi history matches the bridge's cursor, otherwise rebuilt from Pi history.
- Rebuilds normalize history with Pi's `transformMessages` (from `@earendil-works/pi-ai/api/transform-messages`), the same rules every Pi provider uses: aborted and errored assistant turns are dropped and unanswered tool calls get an error result.
- When the normalized history does not end in "Claude's last reply, then the new prompt" (an unanswered prompt after Stop or an error, or tool results Pi continues from after compaction), the whole history is written to the copy and Claude Code answers its unanswered end via `CLAUDE_CODE_RESUME_INTERRUPTED_TURN`.
- A reply with no text and no tool call (Claude ended the turn after thinking only) does not count as Claude's last reply. Claude Code drops such messages when it loads a session, so resuming on one would leave the copy ending on a user-role message. The copy is rebuilt without it, and the prompt it did not answer is answered with the new one.

## Context window and errors

- Claude Code enforces its own context window before calling the API, from the account's entitlement and its model registry (200k for models it does not know as 1M). The bridge does not override it: forcing `<id>[1m]` can claim a window the account is not entitled to, which fails past 200k as an extra-usage error instead of a recoverable overflow.
- Claude Code reports account and API failures as a synthetic assistant message with an `error` code. The bridge returns these to Pi as errors, so "Prompt is too long" triggers Pi's overflow compaction and retry, and usage limits are not shown as assistant text. If such an error arrives while Pi is executing the turn's tool calls, the message Pi holds is left intact; the query is released and Pi's tool results continue the turn in a fresh query.
- `tests/unit-claude-code-contract.mjs` runs the real bundled Claude Code binary against a scripted fake Anthropic API (`tests/lib/fake-anthropic.mjs`) and checks what Pi and the API receive.

## Executable resolution

- `src/executable-resolution.ts` is the sole resolver for bridge execution and programmatic hosts. Import it through `@fractaal/pi-claude-bridge/executable-resolution` instead of copying PATH logic.
- On Windows, Agent SDK execution resolves native `.exe` or `.com` binaries. Status and login callers may opt into `.cmd` and `.bat` shell shims.
- Auto-discovered executable paths stay process-local. Only an explicit user-configured path belongs in persisted bridge settings.

## Diagnostics

- Rate-limit errors are deduplicated before user notification. The bridge emits `vstack:rate-limit` so `pi-qol` can opt into reset-time auto-resume.
- Stream-idle stalls close the stalled Claude Code subprocess and return a retryable assistant error. `CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT` accepts bare seconds or `ms`, `s`, and `m` suffixes.
- Integrity diagnostics are written to `~/.pi/agent/claude-bridge-diag.log` with counts, affected tool names, and sampled tool-call IDs.
- Startup preflight failures preserve the underlying `code`, `errno`, `syscall`, `path`, `cwd`, and detected executable file type before handing the error back to the SDK.
