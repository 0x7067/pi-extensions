# @fractaal/pi-claude-bridge

Run Claude Code as a Pi provider using your Claude subscription. Adds `claude-bridge/*` models to `/model` while keeping Pi's tools and TUI.

![Claude bridge demo response](https://raw.githubusercontent.com/fractaal/pi-extensions/main/packages/claude-bridge/assets/bridge-demo.png)
![Claude Bridge settings panel](https://raw.githubusercontent.com/fractaal/pi-extensions/main/packages/claude-bridge/assets/settings-panel.png)

Maintained from [`@vanillagreen/pi-claude-bridge`](https://github.com/vanillagreencom/vstack/tree/main/pi-extensions/pi-claude-bridge), itself forked from [`elidickinson/pi-claude-bridge`](https://github.com/elidickinson/pi-claude-bridge). The fractaal fork tracks current Pi APIs and can use Pi's complete system prompt without embedding host-specific policy.

## Highlights

- `claude-bridge/claude-fable-5`, Opus 5, Sonnet 5, Opus 4.8, Opus 4.7, Sonnet 4.6, and Haiku in `/model`.
- Pi tool calls run on Pi; Claude Code handles reasoning.
- Tool-use turns block until Pi-delivered tool results reach Claude Code, including persistent subagent panes.
- Session continuity across normal turns, `/compact`, tree navigation, and abort recovery.
- Steering: a message sent while a tool runs reaches Claude in the same turn, right after the tool result.
- When a session outgrows the context window Claude Code allows for your account, Pi compacts and continues the turn automatically.
- Thinking-level forwarding with summarized Opus thinking display.
- Optional Claude effort overrides (`xhigh` → `max` for Opus 4.8).
- MCP isolation and Claude cloud-MCP suppression to keep tokens lean.
- Opt-in forwarding of `APPEND_SYSTEM.md` and recognized Pi prompt hooks.

## Install

Via [npm](https://www.npmjs.com/package/@fractaal/pi-claude-bridge):

```bash
pi install npm:@fractaal/pi-claude-bridge
```

Restart Pi after installation.

## Model discovery

On Pi model-catalog refresh, the bridge asks its selected Claude Code executable (including the SDK-bundled CLI on managed hosts) for its supported models through a short-lived initialization: no prompt, tools, MCP servers, hooks, or persisted conversation. It resolves aliases to canonical IDs and uses `pi.dev`'s Anthropic catalog for context/output limits and pricing. Prices are list-price estimates, not a statement of subscription charges. Neither credentials nor provider request headers are sent to `pi.dev`.

Discovered models are additive and stored in Pi's existing `ModelsStore`; the bundled list is an offline baseline, not an inclusion limit. Cache-only startup performs no discovery, ordinary refreshes reuse a four-hour cache, and Pi's forced refresh bypasses that interval. Failed discovery keeps the last-known catalog. If a newly advertised model has no usable limit metadata yet, the bridge reports it through the UI and `claude-bridge:model-discovery-warning` rather than inventing capabilities; later refreshes can add it once metadata is available.

Embedding hosts use Pi's refresh lifecycle and publish the resulting registry changes. Discovery uses the same executable and per-runtime environment as inference, without reinitializing an active inference Query. A new model requiring a newer Claude Code protocol can still require updating Claude Code.

## Prompt context

`systemPromptMode` has two modes:

- `claude-code` (default): use Claude Code's preset prompt and optionally append selected Pi context.
- `pi`: pass Pi's complete system prompt through unchanged and disable Claude filesystem setting sources, avoiding duplicate instructions and MCP discovery.

The bridge only provides this mechanism. Pi installations and embedding hosts choose the mode through normal package settings.

Embedding hosts that run multiple sibling Pi runtimes in one process should use `@fractaal/pi-claude-bridge/isolated`. Every factory invocation owns independent session, tool, UI, and query state. The default package entry preserves personal Pi's nested-agent behavior, where reloaded extension instances share one model registry.

The factory also accepts `env`, an optional map of Claude child-process environment overrides. Hosts can supply a runtime-specific gateway endpoint, credential or `CLAUDE_CONFIG_DIR` without changing `process.env` or another runtime. Setting an entry to `undefined` suppresses its inherited value. Overrides are copied when the extension is registered; executable discovery, native session-copy paths and Claude subprocesses use the same effective environment. Normal Pi configuration and the bridge's tool/MCP isolation remain unchanged. Keep credentials in the host's runtime configuration, not persisted bridge settings or source.

## Settings

Open `/extensions:settings`; settings appear under the **Claude Bridge** tab.

Project settings in `.pi/settings.json` apply only after Pi marks the workspace trusted; before trust, vstack Pi extensions read user/global settings only.

### General

| Setting | What it does |
| --- | --- |
| Enable Claude bridge provider | Register `claude-bridge/*` models. Reload required. |

### Base prompt

| Setting | What it does |
| --- | --- |
| System prompt | Choose Claude Code's preset prompt or Pi's complete system prompt. |
| Forward AGENTS.md + skills | In Claude Code mode, append AGENTS.md and Pi's skills block. |

### Pi prompt context

| Setting | What it does |
| --- | --- |
| Forward APPEND_SYSTEM.md | Forward project/global `APPEND_SYSTEM.md` content. |

### Pi prompt hooks

| Setting | What it does |
| --- | --- |
| Forward project agents hook | Forward `pi-agents-tmux` Project Agents/Subagents list. |
| Forward task panel hook | Forward `pi-task-panel` workflow reminders. |
| Forward caveman hook | Forward `pi-caveman` response-style directives. |

### Claude Code

| Setting | What it does |
| --- | --- |
| Strict MCP config | Block filesystem MCP auto-loads; Pi owns tools. |
| Allow extra usage helper | Let the bridge launch Claude Code's `/extra-usage` flow when extra usage is required. Billing/admin approval still happens in Claude's browser page. |
| Fast mode | Enable Claude Code fast mode for bridge requests when the selected model supports it. |
| Force Claude effort | Override Pi's thinking-level mapping for every claude-bridge request. `none` keeps Pi's selected level; `max` sends Claude Code `--effort max`. |
| Model effort overrides | JSON object mapping model IDs to Claude Code efforts, e.g. `{"claude-opus-4-8":"max"}`. Per-model entries beat the global force setting. |
| Claude executable path | Explicit `claude` binary path; empty auto-detects. |

Pi 0.80.6 and newer expose native `max` thinking. Fable 5 bridge metadata forwards both `xhigh` and `max`; **Force Claude effort** and **Model effort overrides** remain available when one bridge model needs a different fixed effort. For example, to force only Opus 4.8 to `max`:

```json
{"claude-opus-4-8":"max"}
```

Keys may be bare model IDs (`claude-opus-4-8`), `claude-bridge/<id>`, or `*` for all bridge models. Values are `low`, `medium`, `high`, `xhigh`, or `max`.

### Fable 5 caveat

The bridge registers `claude-bridge/claude-fable-5`, `claude-bridge/claude-opus-5-5`, `claude-bridge/claude-opus-5`, `claude-bridge/claude-sonnet-5`, and `claude-bridge/claude-opus-4-8` even when Pi's Anthropic model registry has not shipped those entries yet. For Fable 5, the bridge asks Claude Code to use Opus 4.8 as the availability fallback and preserves Claude Code's content-safety fallback events so Pi labels rerouted turns as Opus 4.8. Content-safety fallback still depends on Claude Code's own Fable 5 support; use Claude Code 2.1.170 or newer, and set `ANTHROPIC_DEFAULT_FABLE_MODEL` / `ANTHROPIC_DEFAULT_OPUS_MODEL` yourself when routing provider-specific model IDs through Bedrock, Vertex, or Foundry.

## Extra usage and rate limits

Claude Code's `/extra-usage` local command works through the Claude Agent SDK. In Pi, use `/claude-bridge:extra` to run that flow from claude-bridge. Persist automatic launch on extra-usage errors with **Allow extra usage helper** in `/extensions:settings`.

When Claude Code reports a rate-limit reset time, the bridge shows one clear `[rate-limit]` warning with timezone context and avoids repeating the same error line. If `pi-qol` is installed, it can use the reset time to resume later.

Allowed-warning rate-limit events are filtered before user notification. The bridge normalizes unambiguous numeric utilization (`0 < value < 1` as fractional, `1 < value <= 100` as percent), suppresses low or unit-ambiguous values such as exact `1`, and only shows a neutral warning at 80%+ instead of claiming an unverified `% used` value. Check Claude Code `/usage` for exact allowed-warning utilization.

If Claude Code accepts a turn but produces no visible output, the bridge returns a retryable assistant error with a backoff hint instead of leaving Pi stuck waiting. Tune the first-output timeout with `CLAUDE_BRIDGE_STREAM_IDLE_TIMEOUT` (bare numbers are seconds; suffixes `ms`, `s`, and `m` are accepted). Default: `90s`; set `0` to disable.

## Plan usage for hosts

On a Claude subscription, the bridge reads Claude Code's plan usage during turns (at most once a minute) and emits `claude-bridge:usage` on Pi's extension event bus: `{ provider: "anthropic-claude-code", observedAt, planType, windows: [{ id: "five_hour" | "weekly", label, windowSeconds, usedPercent, resetAt }] }`. Hosts such as Aria Local Runtime can show it as quota. For steady pacing, hosts can instead poll `createClaudeUsageProbe()` from `@fractaal/pi-claude-bridge/usage-probe` about once a minute: it keeps one idle Claude Code process (no prompt, tools, MCP servers, or user settings, so no model calls) while reads continue and closes it about two minutes after they stop. Claude Code marks the underlying API experimental, so the bridge stops reading for the rest of the process if the call disappears, keeps failing, or returns an unexpected shape. API-key, Bedrock, and Vertex sessions emit nothing.

## Debugging

Set `CLAUDE_BRIDGE_DEBUG=1` to write bridge logs to `~/.pi/agent/claude-bridge.log` and per-query Claude Code CLI logs under `~/.pi/agent/cc-cli-logs/`.

Tool-result integrity problems are recorded even when debug logging is off, in the private diagnostic file `~/.pi/agent/claude-bridge-diag.log`. They are not shown in the conversation: the bridge rebuilds Claude's session from Pi history before the next turn.

Startup failures include the resolved Claude executable and working directory, which makes missing binaries and wrong launch directories easier to fix.

Contributor-facing stream, tool-result, and startup diagnostics are documented in [`DEVELOPMENT.md`](./DEVELOPMENT.md).
