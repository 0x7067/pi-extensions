# @fractaal/pi-cross-agent-memory

Portable Pi extension that injects local Claude Code and Codex memory indexes for projects encountered during a Pi session.

Maintained in [`fractaal/pi-extensions`](https://github.com/fractaal/pi-extensions/tree/main/packages/cross-agent-memory). The npm package name, exports, command aliases, and session state are unchanged by the move from the standalone repository.

## What it loads

- Claude Code project memory:
  - `~/.claude/projects/<project-slug>/memory/MEMORY.md`
  - legacy `~/.claude/projects/<project-slug>/MEMORY.md`
- Codex project memory, if present:
  - `~/.codex/projects/<project-slug>/memory/MEMORY.md`
  - `~/.Codex/projects/<project-slug>/memory/MEMORY.md`
- Codex global summary, if present:
  - `~/.codex/memories/memory_summary.md`
  - `~/.Codex/memories/memory_summary.md`

Codex's `memory_summary.md` is its compact, prompt-loaded index. Its global `MEMORY.md` is the detailed handbook, not a startup index. The extension injects the summary and a pointer to the handbook for on-demand reads. If the summary is missing or empty, it does not fall back to injecting the handbook. Neither Codex file nor its automatic memory generation is modified.

It also considers the git common worktree root, so a task worktree can still pick up memory saved against the main checkout root.

At session start, memory is resolved from the active cwd. Successful path-aware `read`, `grep`, `find`, `ls`, `write`, and `edit` results also discover memory for newly encountered projects. Newly discovered memory is surfaced in that tool result for the next model turn, retained for later prompts, and restored when the session reloads or resumes. The active cwd remains first within the total context budget on later prompts. Memory is advisory recall, so writes are never blocked while it loads.

## Pi usage

From npm:

```bash
pi install npm:@fractaal/pi-cross-agent-memory
```

Existing Git pins to the [standalone repository](https://github.com/fractaal/pi-cross-agent-memory) still identify their original source, but new releases come from this monorepo. Replace the old installed source with the npm package rather than loading both.

Local dogfood while developing:

```bash
pi install /path/to/pi-extensions/packages/cross-agent-memory
```

Pi loads the extension through the `pi.extensions` manifest entry, which points at `./src/index.ts` — Pi's loader compiles TypeScript itself, so no build output is involved on this path.

## Commands

- `/cross-agent-memory` shows which memory files are currently injected for the session.
- `/claude-memory` is kept as a compatibility alias for Ben's old personal extension command.

## Embedding

ALR or another host can import the factory directly:

```ts
import { createCrossAgentMemoryExtension } from '@fractaal/pi-cross-agent-memory';

const extensionFactory = createCrossAgentMemoryExtension({ notifyOnSessionStart: false });
```

This import resolves to compiled JS in `dist/` via the package `exports` map — plain Node can load it, no TypeScript loader required. The default export is a ready-to-load Pi extension for ordinary Pi package use.

## Packaging

This package preserves two entry paths from one implementation:

1. **Two entry doors, one implementation.**
   - `pi.extensions` in `package.json` points at the TypeScript source (`./src/index.ts`). Pi's own loader consumes this — it compiles TS itself. This is the standard Pi-ecosystem door.
   - `exports` / `main` / `types` point at compiled JS in `dist/`. Ordinary Node consumers (ALR embedding Pi as a library, tests, scripts) import through this door. Node deliberately refuses to type-strip `.ts` files inside `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so this door **must** be compiled JS.
2. **`dist/` is never committed.** It is gitignored. The build runs automatically at publish time via `prepack`, so the npm tarball always contains fresh compiled output matching the source it ships with.
3. **`files` ships both doors**: `dist` (compiled JS + types) and `src` (the `.ts` the Pi loader reads).
4. **Published to npm under `@fractaal`**, `publishConfig.access: public`. Consumers pin ordinary semver versions. No git-SHA tarball URLs, no vendored build artifacts, no path-resolving `.ts` files out of `node_modules` at runtime.
5. **Runtime imports stay lean.** The Pi API is imported type-only (`import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'`), so the compiled output has no hard runtime dependency on the harness — it is declared as a peer.

## Development and releases

Run from the monorepo root:

```bash
npm ci
npm run typecheck
npm test
npm run test:installed --workspace @fractaal/pi-cross-agent-memory
```

Installed-package acceptance packs with `prepack`, installs into a temporary consumer without host peers, and verifies ordinary Node exports plus Pi manifest discovery and memory injection. It uses an isolated home/profile, makes no model calls, and removes its temporary files.

Releases use GitHub Actions OIDC, not local `npm publish`. See the [monorepo release guide](https://github.com/fractaal/pi-extensions/blob/main/docs/releasing.md). The release tag is `cross-agent-memory-v<version>`; npm must authorize owner `fractaal`, repository `pi-extensions`, workflow filename `publish-npm.yml`, and environment `npm-publish` for this existing package.

## Source attribution

Imported without runtime or existing test changes from [`fractaal/pi-cross-agent-memory@0abc6686552fd1474454d6071e23eb9081ac7eca`](https://github.com/fractaal/pi-cross-agent-memory/tree/0abc6686552fd1474454d6071e23eb9081ac7eca), the source of npm version 0.3.0. Version 0.3.1 changes repository ownership paths and release integration, not memory behavior. The original MIT license is retained.
