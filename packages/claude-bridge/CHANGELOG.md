# Changelog

## 2.0.0

- Requires the Pi 1.x provider API as shipped by the fractaal fork 0.86 or newer (peer range `>=0.86.0`). Bridge 1.12.x remains the line for Pi 0.85 and older.
- Tool deferral now follows Pi's MCP exposure setting instead of the `mcp__` name prefix. Tools Pi declares always load; registered `deferred` and `codemode` tools wait behind Claude Code's ToolSearch; `hidden` tools and Pi's own `tool_search` and `codemode` tools are not offered.
- A deferred tool Claude loads and calls is activated in Pi, so it is recorded in Pi's transcript and survives model switches. The fork's Pi 0.86 runs that call in the same turn; upstream Pi 1.0.4 reports a tool activated mid-turn as not found.
- Reads the system prompt and tools from the transcript's system messages. Session cursors and fingerprints ignore system messages.
- Model discovery persists through Pi 1.x's `publish`.
