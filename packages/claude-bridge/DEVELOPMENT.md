# pi-claude-bridge — development notes

Implementation details for contributors. End-user setup, settings, and troubleshooting live in [`README.md`](./README.md).

## Stream and tool-result handling

- The bridge runs Claude Code through the Claude Agent SDK while Pi remains the owner of the visible TUI and tool execution.
- Claude Code yields each content block of a streamed message as an assistant message when the block ends, before the stream's `message_delta`, which carries the message's real output token count. A streamed tool-use turn therefore ends at its `message_stop`, so the message Pi receives has the final usage and every tool call Claude made in it. Claude Code may already have called the tools' MCP handlers by then; they wait for Pi's results.
- An assistant tool-use message outside the stream in progress (no matching `message_start`, or arriving after its `message_stop`) ends the turn at once. If the SDK reveals another tool call after that boundary, the bridge emits the previously unseen call on the next Pi result-delivery stream instead of leaving its MCP handler waiting forever.
- Tool results whose IDs were never registered in the active assistant tool-use turn are refused instead of being queued against another pending call. Remaining handlers receive an internal-error result so the turn cannot report false success.
- If a query tears down while parallel tool results are still queued or unresolved, the bridge writes diagnostics, marks the Claude session for rebuild, and re-imports delivered results from Pi history on the next turn.
- Each query keeps its prompt input open until Claude Code reports the turn finished. Steering and follow-up messages that Pi appends after a tool batch are pushed into that input before the tool results are released, so Claude Code folds them into the running turn. There is no interrupt-and-resume path: resuming a Claude session that ends on a user-role message makes Claude Code insert a synthetic "No response requested." reply.
- The query is released before Pi is told a turn ended, on every path (completion, Stop, stream-idle timeout, Claude errors). Pi can call again at once (Stop flushes queued messages); that call must start a fresh query.
- A call with an already-aborted signal is Pi following up a stopped turn; the bridge returns `aborted` without starting Claude Code.

## Tools Claude sees

- Pi's tools reach Claude Code through one in-process MCP server whose `tools/list` returns each tool's JSON Schema unchanged. Claude Code sends an MCP tool's input schema to the API as listed, so unions and references survive; the earlier Zod conversion for `createSdkMcpServer` did not.
- The only Claude Code built-in kept is ToolSearch. Claude Code defers every MCP tool not marked `_meta["anthropic/alwaysLoad"]`, and `tools: []` would remove ToolSearch and with it all deferral.
- Which tools go to Claude follows Pi's tool exposure, not tool names. Every tool the transcript declares (`getCurrentTools(context.messages)`) is always-load. Registered tools (`pi.getAllTools()`) with `deferred` or `codemode` exposure that Pi has not declared go without alwaysLoad, so Claude Code defers them and ToolSearch finds them with their full schemas; loading one appends it to the request, so the prompt cache survives. `hidden` tools and Pi's `tool_search` and `codemode` tools are never offered: Claude's ToolSearch is the only search mechanism.
- Pi runs a tool call from the tool set it fixed when the turn began, and the call of a tool Claude just loaded arrives inside that turn. When Claude calls an offered tool Pi has not activated, the bridge calls `pi.setActiveTools` with it added, so Pi declares it in a `toolsAdded` system message before its next request and every later model sees it. Pi still reports that first call as "Tool X not found" (it stays in Pi's transcript); the bridge replaces that result with an instruction for Claude to call again, and the retry runs in the next Pi turn. `tests/unit-pi-session.mjs` shows this with a real Pi session. A tool activated while a Claude session is resumed stays behind ToolSearch for that session (Claude Code keeps the earlier deferral); it loads upfront once the copy is rebuilt.
- The tool list of a running query is fixed when it starts. A tool Pi activates during the query (for example, an extension does) reaches Claude from the next query on; the bridge does not refresh the MCP server's `listChanged`.
- Provider requests carry `TranscriptContext`: the system prompt and tools are system messages inside `context.messages`, read with `getCurrentSystemPrompt` and `getCurrentTools`. Cursors, fingerprints and the Claude copy count conversation messages only (system messages removed), so a mid-transcript system message, or Pi collapsing them for a forced prompt, does not move them. The bridge never calls `onPayload` or `onResponse`: Claude Code sends the HTTP request, so there is no provider payload or response to hand over.
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
