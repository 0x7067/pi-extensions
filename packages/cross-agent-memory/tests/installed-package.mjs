import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const packageRoot = resolve(import.meta.dirname, '..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const root = await mkdtemp(join(tmpdir(), 'pi-cross-agent-memory-installed-'));

try {
  // Pack normally: prepack must produce fresh JS/types from the shipped source.
  const [packed] = JSON.parse(execFileSync(npm, ['pack', '--json', '--pack-destination', root], {
    cwd: packageRoot,
    encoding: 'utf8',
  }));
  const files = new Set(packed.files.map((file) => file.path));
  for (const required of ['LICENSE', 'README.md']) {
    assert.ok(files.has(required), `Missing packaged file: ${required}`);
  }
  assert.ok(![...files].some((file) => file.startsWith('tests/') || file.startsWith('node_modules/')));

  const consumer = join(root, 'consumer');
  const home = join(root, 'home');
  const agentDir = join(home, '.pi', 'agent');
  await mkdir(consumer);
  await mkdir(agentDir, { recursive: true });
  await writeFile(join(consumer, 'package.json'), '{"private":true,"type":"module"}\n');
  const env = { ...process.env, HOME: home, USERPROFILE: home, PI_CODING_AGENT_DIR: agentDir };

  // No host peers in the consumer: plain Node must load the type-only factory
  // without a TS loader or a second installed Pi runtime.
  execFileSync(npm, [
    'install', join(root, packed.filename), '--ignore-scripts', '--legacy-peer-deps', '--no-audit', '--no-fund',
  ], { cwd: consumer, env, stdio: 'pipe' });
  const installed = join(consumer, 'node_modules', '@fractaal', 'pi-cross-agent-memory');
  const manifest = JSON.parse(await readFile(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, '@fractaal/pi-cross-agent-memory');
  assert.ok(files.has(manifest.exports['.'].types.replace(/^\.\//, '')), 'Declared types must be packaged');

  const probe = `
    import assert from 'node:assert/strict';
    import { mkdir, writeFile } from 'node:fs/promises';
    import { dirname, join } from 'node:path';
    import memory, * as api from '@fractaal/pi-cross-agent-memory';

    for (const name of [
      'buildCrossAgentMemoryPromptAppend', 'createCrossAgentMemoryExtension',
      'default', 'projectMemorySlug', 'resolveCrossAgentMemoryFiles',
    ]) assert.equal(typeof api[name], 'function');
    assert.equal(typeof memory, 'function');
    const cwd = process.cwd();
    const memoryPath = join(process.env.HOME, '.claude', 'projects', api.projectMemorySlug(cwd), 'memory', 'MEMORY.md');
    await mkdir(dirname(memoryPath), { recursive: true });
    await writeFile(memoryPath, 'ISOLATED_MEMORY_SENTINEL');
    const codexDirectory = join(process.env.HOME, '.codex', 'memories');
    await mkdir(codexDirectory, { recursive: true });
    await writeFile(join(codexDirectory, 'memory_summary.md'), 'CODEX_SUMMARY_SENTINEL');
    await writeFile(join(codexDirectory, 'MEMORY.md'), 'CODEX_HANDBOOK_DETAIL_SENTINEL');
    const promptAppend = await api.buildCrossAgentMemoryPromptAppend({ cwd });
    assert.match(promptAppend, /ISOLATED_MEMORY_SENTINEL/);
    assert.match(promptAppend, /CODEX_SUMMARY_SENTINEL/);
    assert.doesNotMatch(promptAppend, /CODEX_HANDBOOK_DETAIL_SENTINEL/);

    // The host SDK discovers the installed tarball via its Pi package manifest,
    // not via a source path in this worktree. No model/auth/session is started.
    const { DefaultResourceLoader, SettingsManager } = await import(${JSON.stringify(import.meta.resolve('@earendil-works/pi-coding-agent'))});
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: process.env.PI_CODING_AGENT_DIR,
      settingsManager: SettingsManager.inMemory({ packages: [${JSON.stringify(installed)}] }),
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    });
    await loader.reload();
    const { extensions, errors } = loader.getExtensions();
    assert.deepEqual(errors, []);
    const commands = new Set(extensions.flatMap(extension => [...extension.commands.keys()]));
    assert.ok(commands.has('claude-memory'));
    assert.ok(commands.has('cross-agent-memory'));
    const context = { cwd, hasUI: false, sessionManager: { getBranch: () => [] } };
    for (const extension of extensions) {
      for (const handler of extension.handlers.get('session_start') ?? []) await handler({}, context);
    }
    let systemPrompt = 'base prompt';
    for (const extension of extensions) {
      for (const handler of extension.handlers.get('before_agent_start') ?? []) {
        const result = await handler({ systemPrompt }, context);
        systemPrompt = result?.systemPrompt ?? systemPrompt;
      }
    }
    assert.match(systemPrompt, /ISOLATED_MEMORY_SENTINEL/);
    assert.match(systemPrompt, /CODEX_SUMMARY_SENTINEL/);
    assert.ok(systemPrompt.includes(join(codexDirectory, 'MEMORY.md')));
    assert.doesNotMatch(systemPrompt, /CODEX_HANDBOOK_DETAIL_SENTINEL/);
    console.log('PASS: packed Node exports, Pi manifest discovery, command aliases, and summary-only Codex injection');
  `;
  execFileSync(process.execPath, ['--input-type=module', '-e', probe], {
    cwd: consumer,
    env,
    stdio: 'inherit',
  });
} finally {
  await rm(root, { recursive: true, force: true });
}
