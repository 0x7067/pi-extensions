import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, test } from 'node:test';
import {
  CONTEXT_WINDOW_GLOBAL_DEFAULTS_FILE,
  CONTEXT_WINDOW_STATE_ENTRY,
  CONTEXT_WINDOW_STATE_EVENT,
  effectiveContextWindow,
  parseContextWindowActionInput,
  parseContextWindowDefaults,
  parseContextWindowState,
} from '../../context-window/extensions/context-window-contract.ts';
import contextWindowExtension from '../../context-window/extensions/context-window.ts';
import { fixtureModel, installModelHarness } from './context-window-harness.ts';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('effective context windows are capped by the resolved model maximum', () => {
  assert.equal(effectiveContextWindow(200_000, 128_000, 160_000), 128_000);
  assert.equal(effectiveContextWindow(200_000, null, 160_000), 160_000);
  assert.equal(effectiveContextWindow(200_000, 400_000, null), 200_000);
});

test('namespaced runtime actions validate scope and reset values before ALR applies them', () => {
  assert.deepEqual(parseContextWindowActionInput({ schemaVersion: 1, scope: 'session', value: 128_000, minimum: 16_000, maximum: 200_000 }), {
    schemaVersion: 1,
    scope: 'session',
    value: 128_000,
  });
  assert.deepEqual(parseContextWindowActionInput({ schemaVersion: 1, scope: 'global', value: 'default' }), {
    schemaVersion: 1,
    scope: 'global',
    value: 'default',
  });
  assert.equal(parseContextWindowActionInput({ schemaVersion: 1, scope: 'other', value: 128_000 }), null);
  assert.equal(parseContextWindowActionInput({ schemaVersion: 1, scope: 'session', value: 0 }), null);
});

test('session override persists in Pi JSONL and changes the active model metadata', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portable-context-window-'));
  temporaryDirectories.push(root);
  const { harness, getModel } = installModelHarness(root);
  contextWindowExtension(harness.pi);
  await harness.run('session_start', { reason: 'startup' });

  await harness.commands.get('context-window')!.handler('128k', harness.ctx as never);

  const state = parseContextWindowState(harness.entries.at(-1)?.data);
  assert.equal(state?.sessionOverride, 128_000);
  assert.equal(state?.effectiveWindow, 128_000);
  assert.equal(getModel().contextWindow, 128_000);
  assert.equal(harness.events.emitted.at(-1)?.channel, CONTEXT_WINDOW_STATE_EVENT);
  assert.match(harness.notifications.at(-1)?.message ?? '', /128k effective/);

  await harness.commands.get('context-window')!.handler('400k', harness.ctx as never);
  const clamped = parseContextWindowState(harness.entries.at(-1)?.data);
  assert.equal(clamped?.sessionOverride, 200_000);
  assert.equal(clamped?.effectiveWindow, 200_000);
  assert.equal(getModel().contextWindow, 200_000);

  await harness.commands.get('context-window')!.handler('default', harness.ctx as never);
  const reset = parseContextWindowState(harness.entries.at(-1)?.data);
  assert.equal(reset?.sessionOverride, null);
  assert.equal(reset?.effectiveWindow, 200_000);
  assert.equal(getModel().contextWindow, 200_000);
});

test('global defaults survive a later session and session default inherits them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portable-context-window-global-'));
  temporaryDirectories.push(root);
  const first = installModelHarness(root);
  contextWindowExtension(first.harness.pi);
  await first.harness.run('session_start', { reason: 'startup' });
  await first.harness.commands.get('context-window-default')!.handler('96k', first.harness.ctx as never);

  const defaults = parseContextWindowDefaults(JSON.parse(readFileSync(join(root, CONTEXT_WINDOW_GLOBAL_DEFAULTS_FILE), 'utf8')));
  assert.deepEqual(defaults?.defaults, { 'fixture/fixture-model': 96_000 });
  assert.equal(first.getModel().contextWindow, 96_000);

  const second = installModelHarness(root);
  contextWindowExtension(second.harness.pi);
  await second.harness.run('session_start', { reason: 'startup' });
  const state = parseContextWindowState(second.harness.entries.at(-1)?.data);
  assert.equal(state?.globalDefault, 96_000);
  assert.equal(state?.sessionOverride, null);
  assert.equal(second.getModel().contextWindow, 96_000);

  await second.harness.commands.get('context-window')!.handler('default', second.harness.ctx as never);
  assert.equal(parseContextWindowState(second.harness.entries.at(-1)?.data)?.effectiveWindow, 96_000);
});

test('model selection reapplies the selected model default or true maximum', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portable-context-window-model-select-'));
  temporaryDirectories.push(root);
  writeFileSync(join(root, CONTEXT_WINDOW_GLOBAL_DEFAULTS_FILE), `${JSON.stringify({
    schemaVersion: 1,
    defaults: {
      'alpha/standard': 120_000,
      'beta/small': 96_000,
    },
  }, null, 2)}\n`);
  const { harness, getModel, selectModel } = installModelHarness(root, [
    fixtureModel('alpha', 'standard', 200_000),
    fixtureModel('beta', 'small', 80_000),
    fixtureModel('gamma', 'large', 400_000),
  ]);
  contextWindowExtension(harness.pi);
  await harness.run('session_start', { reason: 'startup' });
  assert.equal(getModel().contextWindow, 120_000);

  const small = selectModel('beta', 'small');
  await harness.run('model_select', { type: 'model_select', model: small, previousModel: undefined, source: 'set' });
  let selected = parseContextWindowState(harness.entries.at(-1)?.data);
  assert.deepEqual(selected?.model, { provider: 'beta', modelId: 'small' });
  assert.equal(selected?.globalDefault, 96_000);
  assert.equal(selected?.maxWindow, 80_000);
  assert.equal(getModel().contextWindow, 80_000);

  const large = selectModel('gamma', 'large');
  await harness.run('model_select', { type: 'model_select', model: large, previousModel: small, source: 'set' });
  selected = parseContextWindowState(harness.entries.at(-1)?.data);
  assert.deepEqual(selected?.model, { provider: 'gamma', modelId: 'large' });
  assert.equal(selected?.globalDefault, null);
  assert.equal(selected?.effectiveWindow, 400_000);
  assert.equal(getModel().contextWindow, 400_000);
});

test('clearing a global default removes only the selected model key and restores its maximum', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portable-context-window-global-clear-'));
  temporaryDirectories.push(root);
  writeFileSync(join(root, CONTEXT_WINDOW_GLOBAL_DEFAULTS_FILE), `${JSON.stringify({
    schemaVersion: 1,
    defaults: { 'fixture/fixture-model': 96_000, 'other/model': 64_000 },
  }, null, 2)}\n`);
  const { harness, getModel } = installModelHarness(root);
  contextWindowExtension(harness.pi);
  await harness.run('session_start', { reason: 'startup' });
  assert.equal(getModel().contextWindow, 96_000);

  await harness.commands.get('context-window-default')!.handler('default', harness.ctx as never);

  const defaults = parseContextWindowDefaults(JSON.parse(readFileSync(join(root, CONTEXT_WINDOW_GLOBAL_DEFAULTS_FILE), 'utf8')));
  assert.deepEqual(defaults?.defaults, { 'other/model': 64_000 });
  const state = parseContextWindowState(harness.entries.at(-1)?.data);
  assert.equal(state?.globalDefault, null);
  assert.equal(state?.effectiveWindow, 200_000);
  assert.equal(getModel().contextWindow, 200_000);
});

test('session tree navigation restores the complete context-window snapshot on each active branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portable-context-window-tree-'));
  temporaryDirectories.push(root);
  const { harness, getModel } = installModelHarness(root);
  contextWindowExtension(harness.pi);
  await harness.run('session_start', { reason: 'startup' });
  await harness.commands.get('context-window')!.handler('128k', harness.ctx as never);
  const branch128 = structuredClone(harness.entries);
  await harness.commands.get('context-window')!.handler('64k', harness.ctx as never);
  const branch64 = structuredClone(harness.entries);
  assert.equal(getModel().contextWindow, 64_000);

  harness.entries.splice(0, harness.entries.length, ...branch128);
  await harness.run('session_tree', { type: 'session_tree', oldLeafId: null, newLeafId: null });
  assert.equal(parseContextWindowState(harness.entries.at(-1)?.data)?.sessionOverride, 128_000);
  assert.equal(getModel().contextWindow, 128_000);

  harness.entries.splice(0, harness.entries.length, ...branch64);
  await harness.run('session_tree', { type: 'session_tree', oldLeafId: null, newLeafId: null });
  assert.equal(parseContextWindowState(harness.entries.at(-1)?.data)?.sessionOverride, 64_000);
  assert.equal(getModel().contextWindow, 64_000);
});

test('independent Pi processes preserve concurrent per-model global-default updates', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portable-context-window-processes-'));
  temporaryDirectories.push(root);
  writeFileSync(join(root, 'models.json'), '{}\n');
  const worker = fileURLToPath(new URL('./context-window-default-worker.ts', import.meta.url));
  const modelIds = Array.from({ length: 12 }, (_, index) => `model-${index}`);

  await Promise.all(modelIds.map((modelId, index) => execFileAsync(process.execPath, [
    '--experimental-strip-types',
    worker,
    root,
    'fixture',
    modelId,
    String(64_000 + index * 1_000),
  ])));

  const defaults = parseContextWindowDefaults(JSON.parse(readFileSync(join(root, CONTEXT_WINDOW_GLOBAL_DEFAULTS_FILE), 'utf8')));
  assert.equal(Object.keys(defaults?.defaults ?? {}).length, modelIds.length);
  for (const [index, modelId] of modelIds.entries()) {
    assert.equal(defaults?.defaults[`fixture/${modelId}`], 64_000 + index * 1_000);
  }
});

test('a context budget preserves discovery and native provider behavior without switching the active model', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portable-context-window-discovery-'));
  temporaryDirectories.push(root);
  const { harness, getModel, discoverModels, selectModel } = installModelHarness(root);
  contextWindowExtension(harness.pi);
  await harness.run('session_start', { reason: 'startup' });
  await harness.commands.get('context-window')!.handler('96k', harness.ctx as never);
  const selected = getModel();
  const provider = harness.ctx.modelRegistry.getProvider('fixture')!;
  discoverModels('fixture', [fixtureModel(), fixtureModel('fixture', 'newly-discovered', 400_000)]);

  await provider.refreshModels?.({
    allowNetwork: true,
    store: { read: async () => undefined, write: async () => {}, delete: async () => {} },
  });

  assert.equal(getModel(), selected, 'discovery does not change the active session model');
  assert.equal(getModel().contextWindow, 96_000);
  assert.equal(provider.getModels().find((model) => model.id === 'newly-discovered')?.contextWindow, 400_000);
  assert.ok(await provider.auth.apiKey?.resolve({ ctx: { env: async () => undefined } } as never));
  assert.throws(() => provider.streamSimple(selected, { messages: [] }), /fixture streaming available/);
  const next = selectModel('fixture', 'newly-discovered');
  await harness.run('model_select', { type: 'model_select', model: next, source: 'set' });
  assert.equal(getModel().id, 'newly-discovered');
  assert.equal(getModel().contextWindow, 96_000, 'the session cap also applies after selecting a discovered model');
  assert.equal(parseContextWindowState(harness.entries.at(-1)?.data)?.maxWindow, 400_000);
});

test('malformed persisted state fails closed instead of falling back to an older state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'portable-context-window-invalid-'));
  temporaryDirectories.push(root);
  const { harness } = installModelHarness(root);
  harness.entries.push({ type: 'custom', customType: CONTEXT_WINDOW_STATE_ENTRY, data: { schemaVersion: 1, revision: 4 } });
  contextWindowExtension(harness.pi);
  await assert.rejects(() => harness.run('session_start', { reason: 'startup' }), /Invalid pi-context-window-state-v1/);
});
