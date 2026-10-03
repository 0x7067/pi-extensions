import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { buildCrossAgentMemoryPromptAppend, createCrossAgentMemoryExtension, projectMemorySlug, resolveCrossAgentMemoryFiles } from '../src/index.js';

const tempRoots: string[] = [];

async function tempRoot() {
  const root = await mkdtemp(join(tmpdir(), 'pi-cross-agent-memory-'));
  tempRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function isAlreadyExistsError(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST';
}

function fakePi() {
  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<unknown> | unknown>>();
  const commands = new Map<string, (args: string, ctx: any) => Promise<unknown> | unknown>();
  const entries: any[] = [];
  const pi = {
    on: vi.fn((name: string, handler: (event: any, ctx: any) => Promise<unknown> | unknown) => {
      const existing = handlers.get(name) ?? [];
      existing.push(handler);
      handlers.set(name, existing);
    }),
    registerCommand: vi.fn((name: string, definition: { handler: (args: string, ctx: any) => Promise<unknown> | unknown }) => {
      commands.set(name, definition.handler);
    }),
    appendEntry: vi.fn((customType: string, data: unknown) => {
      entries.push({ type: 'custom', customType, data });
    }),
  };
  return { pi, handlers, commands, entries };
}

async function writeMemory(path: string, content: string) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

describe('project memory slug', () => {
  it('matches Claude/Codex project directory slugs for POSIX and Windows paths', () => {
    expect(projectMemorySlug('/home/benjude/Symph/aria-chat', '/')).toBe('-home-benjude-Symph-aria-chat');
    expect(projectMemorySlug('/workspace/project', '/')).toBe('-workspace-project');
    expect(projectMemorySlug('C:\\Users\\Ben\\Projects\\demo', '\\')).toBe('-C-Users-Ben-Projects-demo');
  });
});

describe('resolveCrossAgentMemoryFiles', () => {
  it.each(['.codex', '.Codex'])('loads Claude project memory and the %s global summary, not its handbook', async (codexDirectory) => {
    const home = await tempRoot();
    const cwd = join(home, 'Projects', 'demo');
    await mkdir(cwd, { recursive: true });
    const claudeMemory = join(home, '.claude', 'projects', projectMemorySlug(cwd), 'memory', 'MEMORY.md');
    const codexSummary = join(home, codexDirectory, 'memories', 'memory_summary.md');
    await writeMemory(claudeMemory, 'Claude project memory.\n');
    await writeMemory(codexSummary, 'Codex summary.\n');
    await writeMemory(join(home, codexDirectory, 'memories', 'MEMORY.md'), 'Detailed Codex handbook.\n');

    const files = await resolveCrossAgentMemoryFiles({ cwd, homeDir: home });

    expect(files.map((file) => file.path)).toEqual([claudeMemory, codexSummary]);
    expect(files.map((file) => file.content)).toEqual(['Claude project memory.\n', 'Codex summary.\n']);
  });

  it.each([undefined, ''])('does not inject the handbook when the summary is %s', async (summary) => {
    const home = await tempRoot();
    const cwd = join(home, 'Projects', 'demo');
    await mkdir(cwd, { recursive: true });
    await writeMemory(join(home, '.codex', 'memories', 'MEMORY.md'), 'Detailed Codex handbook.\n');
    if (summary !== undefined) await writeMemory(join(home, '.codex', 'memories', 'memory_summary.md'), summary);

    expect(await buildCrossAgentMemoryPromptAppend({ cwd, homeDir: home })).toBe('');
  });

  it('includes a Codex summary once when alternate paths alias the same file', async () => {
    const home = await tempRoot();
    const cwd = join(home, 'Projects', 'demo');
    await mkdir(cwd, { recursive: true });
    const codexLower = join(home, '.codex', 'memories', 'memory_summary.md');
    const codexUpper = join(home, '.Codex', 'memories', 'memory_summary.md');
    await writeMemory(codexLower, 'Codex summary.\n');
    try {
      await mkdir(dirname(codexUpper), { recursive: true });
      await symlink(codexLower, codexUpper);
    } catch (error) {
      if (!isAlreadyExistsError(error)) throw error;
    }

    const files = await resolveCrossAgentMemoryFiles({ cwd, homeDir: home });

    expect(files.map((file) => file.path)).toEqual([codexLower]);
  });

  it('builds a prompt append block for hosts that cannot rely on before_agent_start', async () => {
    const home = await tempRoot();
    const cwd = join(home, 'Projects', 'demo');
    await mkdir(cwd, { recursive: true });
    const claudeMemory = join(home, '.claude', 'projects', projectMemorySlug(cwd), 'memory', 'MEMORY.md');
    const codexSummary = join(home, '.codex', 'memories', 'memory_summary.md');
    const codexHandbook = join(home, '.codex', 'memories', 'MEMORY.md');
    await writeMemory(claudeMemory, 'Claude host prompt memory.\n');
    await writeMemory(codexSummary, 'Codex summary for prompt hosts.\n');
    await writeMemory(codexHandbook, 'Detailed Codex handbook.\n');

    const promptAppend = await buildCrossAgentMemoryPromptAppend({ cwd, homeDir: home });

    expect(promptAppend).toContain('# cross-agent memory');
    expect(promptAppend).toContain('Claude host prompt memory.');
    expect(promptAppend).toContain(claudeMemory);
    expect(promptAppend).toContain('Codex summary for prompt hosts.');
    expect(promptAppend).toContain(codexSummary);
    expect(promptAppend).toContain(codexHandbook);
    expect(promptAppend).not.toContain('Detailed Codex handbook.');
  });

  it('skips directory matches and respects file and total byte budgets', async () => {
    const home = await tempRoot();
    const cwd = join(home, 'Projects', 'demo');
    await mkdir(cwd, { recursive: true });
    const slug = projectMemorySlug(cwd);
    const claudeMemory = join(home, '.claude', 'projects', slug, 'memory', 'MEMORY.md');
    const codexProjectDirectoryAtMemoryPath = join(home, '.codex', 'projects', slug, 'memory', 'MEMORY.md');
    const codexGlobalMemory = join(home, '.codex', 'memories', 'memory_summary.md');
    await writeMemory(claudeMemory, 'A'.repeat(20));
    await mkdir(codexProjectDirectoryAtMemoryPath, { recursive: true });
    await writeMemory(codexGlobalMemory, 'B'.repeat(20));

    const files = await resolveCrossAgentMemoryFiles({ cwd, homeDir: home, fileLimitBytes: 12, totalLimitBytes: 18 });

    expect(files).toHaveLength(2);
    expect(files[0]).toMatchObject({ path: claudeMemory, content: 'A'.repeat(12), truncated: true, originalBytes: 20 });
    expect(files[1]).toMatchObject({ path: codexGlobalMemory, content: 'B'.repeat(6), truncated: true, originalBytes: 20 });
  });
});

describe('Pi extension', () => {
  it('registers commands and injects a bounded cross-agent memory block', async () => {
    const home = await tempRoot();
    const cwd = join(home, 'Projects', 'demo');
    await mkdir(cwd, { recursive: true });
    const claudeMemory = join(home, '.claude', 'projects', projectMemorySlug(cwd), 'memory', 'MEMORY.md');
    await writeMemory(claudeMemory, 'Claude memory.\n');
    const runtime = fakePi();

    createCrossAgentMemoryExtension({ homeDir: home, notifyOnSessionStart: false })(runtime.pi as never);

    expect(runtime.commands.has('cross-agent-memory')).toBe(true);
    expect(runtime.commands.has('claude-memory')).toBe(true);
    const beforeAgent = runtime.handlers.get('before_agent_start')?.[0];
    const result = await beforeAgent?.({ systemPrompt: 'base prompt' }, { cwd, hasUI: true, ui: { notify: vi.fn() } });
    const systemPrompt = (result as { systemPrompt: string }).systemPrompt;
    expect(systemPrompt).toContain('# cross-agent memory');
    expect(systemPrompt).toContain('Claude memory.');
    expect(systemPrompt).toContain(claudeMemory);
  });

  it('discovers memory for projects touched by read and write tools and restores it with the session', async () => {
    const home = await tempRoot();
    const startCwd = join(home, 'Projects', 'start');
    const readProject = join(home, 'Projects', 'read-project');
    const writeProject = join(home, 'Projects', 'write-project');
    await Promise.all([startCwd, readProject, writeProject].map((directory) => mkdir(directory, { recursive: true })));

    for (const [directory, content] of [
      [startCwd, 'Starting project memory.\n'],
      [readProject, 'Read project memory.\n'],
      [writeProject, 'Write project memory.\n'],
    ]) {
      await writeMemory(join(home, '.claude', 'projects', projectMemorySlug(directory), 'memory', 'MEMORY.md'), content);
    }
    await writeMemory(join(readProject, 'read.ts'), 'export {};\n');

    const runtime = fakePi();
    createCrossAgentMemoryExtension({ homeDir: home, notifyOnSessionStart: false })(runtime.pi as never);
    const ctx = {
      cwd: startCwd,
      hasUI: true,
      ui: { notify: vi.fn() },
      sessionManager: { getBranch: () => runtime.entries },
    };
    await runtime.handlers.get('session_start')?.[0]?.({}, ctx);

    const toolResult = runtime.handlers.get('tool_result')?.[0];
    expect(toolResult).toBeDefined();
    for (const [toolName, path, expectedMemory] of [
      ['read', join(readProject, 'read.ts'), 'Read project memory.'],
      ['write', join(writeProject, 'NOTICE'), 'Write project memory.'],
    ]) {
      const result = await toolResult?.({
        toolName,
        input: { path },
        content: [{ type: 'text', text: 'tool output' }],
        isError: false,
      }, ctx) as { content: Array<{ type: string; text: string }> };
      expect(result.content.at(-1)?.text).toContain(expectedMemory);
    }

    const beforeAgent = runtime.handlers.get('before_agent_start')?.[0];
    const continued = await beforeAgent?.({ systemPrompt: 'base prompt' }, ctx) as { systemPrompt: string };
    expect(continued.systemPrompt).toContain('Starting project memory.');
    expect(continued.systemPrompt).toContain('Read project memory.');
    expect(continued.systemPrompt).toContain('Write project memory.');

    const persistedEntries = [...runtime.entries];
    const resumedRuntime = fakePi();
    createCrossAgentMemoryExtension({ homeDir: home, notifyOnSessionStart: false })(resumedRuntime.pi as never);
    const resumedCtx = {
      ...ctx,
      sessionManager: { getBranch: () => persistedEntries },
    };
    await resumedRuntime.handlers.get('session_start')?.[0]?.({}, resumedCtx);
    const resumed = await resumedRuntime.handlers.get('before_agent_start')?.[0]?.({ systemPrompt: 'base prompt' }, resumedCtx) as { systemPrompt: string };
    expect(resumed.systemPrompt).toContain('Read project memory.');
    expect(resumed.systemPrompt).toContain('Write project memory.');

    runtime.entries.splice(0);
    const branched = await beforeAgent?.({ systemPrompt: 'base prompt' }, ctx) as { systemPrompt: string };
    expect(branched.systemPrompt).toContain('Starting project memory.');
    expect(branched.systemPrompt).not.toContain('Read project memory.');
    expect(branched.systemPrompt).not.toContain('Write project memory.');
  });

  it('prioritizes newly encountered project memory within the total context budget', async () => {
    const home = await tempRoot();
    const startCwd = join(home, 'Projects', 'start');
    const otherProject = join(home, 'Projects', 'other');
    await Promise.all([startCwd, otherProject].map((directory) => mkdir(directory, { recursive: true })));
    await writeMemory(join(home, '.claude', 'projects', projectMemorySlug(startCwd), 'memory', 'MEMORY.md'), 'START-FULL');
    await writeMemory(join(home, '.claude', 'projects', projectMemorySlug(otherProject), 'memory', 'MEMORY.md'), 'OTHER');
    await writeMemory(join(otherProject, 'read.ts'), 'export {};\n');

    const runtime = fakePi();
    createCrossAgentMemoryExtension({ homeDir: home, fileLimitBytes: 10, totalLimitBytes: 10, notifyOnSessionStart: false })(runtime.pi as never);
    const ctx = {
      cwd: startCwd,
      hasUI: false,
      ui: { notify: vi.fn() },
      sessionManager: { getBranch: () => runtime.entries },
    };
    await runtime.handlers.get('session_start')?.[0]?.({}, ctx);
    const result = await runtime.handlers.get('tool_result')?.[0]?.({
      toolName: 'read',
      input: { path: join(otherProject, 'read.ts') },
      content: [{ type: 'text', text: 'tool output' }],
      isError: false,
    }, ctx) as { content: Array<{ type: string; text: string }> };

    expect(result.content.at(-1)?.text).toContain('OTHER');
    const continued = await runtime.handlers.get('before_agent_start')?.[0]?.({ systemPrompt: 'base prompt' }, ctx) as { systemPrompt: string };
    expect(continued.systemPrompt).toContain('START-FULL');
    expect(continued.systemPrompt).not.toContain('OTHER');
  });

});
