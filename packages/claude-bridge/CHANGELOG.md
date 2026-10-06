# Changelog

## 2.0.0

- Requires Pi 1.x (`@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` 1.0 or newer). Bridge 1.12.x remains the line for Pi 0.85 and older.
- Tool deferral now follows Pi's MCP exposure setting instead of the `mcp__` name prefix. Tools Pi declares always load; registered `deferred` and `codemode` tools wait behind Claude Code's ToolSearch; `hidden` tools and Pi's own `tool_search` and `codemode` tools are not offered.
- A deferred tool Claude loads and calls is activated in Pi, so it is recorded in Pi's transcript and survives model switches. Pi cannot run the first call in the turn it arrives, so Claude is asked to call again and the retry runs.
- Reads the system prompt and tools from the transcript's system messages. Session cursors and fingerprints ignore system messages.
- Model discovery persists through Pi 1.x's `publish`.
