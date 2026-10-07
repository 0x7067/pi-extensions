import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  createClaudeModelCatalog, discoverClaudeModels, mergeClaudeModelDiscovery, parseClaudeModelMetadata,
} from '../src/model-discovery.ts';

const metadata = (id = 'claude-new-model') => ({
  id, name: id, reasoning: true, input: ['text', 'image'], contextWindow: 1_000_000, maxTokens: 128_000,
  cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
});
const discovery = [{ value: 'sonnet', resolvedModel: 'claude-new-model', displayName: 'New model', description: '', supportsEffort: true, supportedEffortLevels: ['low', 'high', 'max'] }];
function memoryStore() {
  let value;
  return {
    read: async () => structuredClone(value),
    write: async (entry) => { value = structuredClone(entry); },
    // Pi's refresh context: an immutable snapshot of the stored catalog, and publish() to persist.
    context: (options = {}) => ({
      signal: new AbortController().signal,
      ...options,
      stored: structuredClone(value),
      publish: async ({ persist, update }) => { if (persist !== undefined) value = persist === null ? undefined : structuredClone(persist); update?.(); return true; },
    }),
  };
}

describe('Claude model discovery', () => {
  it('initializes without a prompt, tools, MCP, hooks or a persisted session, then closes', async () => {
    let started;
    let closed = false;
    const result = await discoverClaudeModels({
      executablePath: '/fixture/claude',
      startQuery: (input) => {
        started = input;
        return { supportedModels: async () => discovery, close: () => { closed = true; } };
      },
    });
    assert.equal(result, discovery);
    assert.deepEqual(started.options.tools, []);
    assert.deepEqual(started.options.mcpServers, {});
    assert.deepEqual(started.options.settingSources, []);
    assert.deepEqual(started.options.settings, { disableAllHooks: true });
    assert.equal(started.options.persistSession, false);
    assert.equal(started.options.env.ENABLE_CLAUDEAI_MCP_SERVERS, '0');
    assert.equal(started.prompt.isClosed, true);
    assert.deepEqual(await started.prompt[Symbol.asyncIterator]().next(), { value: undefined, done: true });
    assert.equal(closed, true);
    assert.equal(existsSync(started.options.cwd), false);
  });

  it('allows the SDK-bundled Claude executable when no separate CLI is installed, as on Neo', async () => {
    let started;
    const result = await discoverClaudeModels({
      env: { PATH: '' },
      startQuery: (input) => { started = input; return { supportedModels: async () => discovery, close() {} }; },
    });
    assert.equal(result, discovery);
    assert.equal(started.options.pathToClaudeCodeExecutable, undefined);
    assert.equal(started.options.env.PATH, '');
  });

  it('cancels a stalled initialization and closes its subprocess instead of blocking the host', async () => {
    const controller = new AbortController();
    let started;
    let closed = false;
    const promise = discoverClaudeModels({
      executablePath: '/fixture/claude', signal: controller.signal,
      startQuery: (input) => {
        started = input;
        queueMicrotask(() => controller.abort());
        return { supportedModels: () => new Promise(() => {}), close: () => { closed = true; } };
      },
    });
    await assert.rejects(promise, /cancelled or timed out/);
    assert.equal(closed, true);
    assert.equal(started.prompt.isClosed, true);
    assert.equal(existsSync(started.options.cwd), false);
  });

  it('enriches an unknown canonical ID and maps only supported Pi efforts without accepting transport fields', () => {
    const details = parseClaudeModelMetadata({ future: {
      ...metadata(), api: 'malicious-api', provider: 'other', baseUrl: 'https://not-the-provider.test', headers: { Authorization: 'must-not-propagate' },
    } });
    const { models, missingMetadata } = mergeClaudeModelDiscovery([metadata('claude-existing')], discovery, details);
    assert.deepEqual(models.map(model => model.id), ['claude-existing', 'claude-new-model']);
    const added = models[1];
    assert.equal(added.contextWindow, 1_000_000);
    assert.equal(added.maxTokens, 128_000);
    assert.deepEqual(added.cost, metadata().cost);
    assert.deepEqual(added.thinkingLevelMap, { off: null, minimal: 'low', low: 'low', medium: null, high: 'high', xhigh: null, max: 'max' });
    for (const key of ['api', 'provider', 'baseUrl', 'headers']) assert.equal(added[key], undefined);
    assert.deepEqual(missingMetadata, []);
  });

  it('retains a native long-context selector while using the underlying model metadata', () => {
    const result = mergeClaudeModelDiscovery([], [{ ...discovery[0], resolvedModel: 'claude-new-model[1m]' }], [metadata()]);
    assert.deepEqual(result.missingMetadata, []);
    assert.equal(result.models[0].id, 'claude-new-model[1m]');
    assert.equal(result.models[0].contextWindow, 1_000_000);
    assert.match(result.models[0].name, /\(1M\)$/);
  });

  it('persists new models through Pi model storage and can restore them offline in a new runtime', async () => {
    const store = memoryStore();
    const catalog = createClaudeModelCatalog({ initialModels: [metadata('claude-existing')], discover: async () => discovery, fetchMetadata: async () => [metadata()] });
    const result = await catalog.refresh(store.context({ allowNetwork: true }));
    assert.ok(result.some(model => model.id === 'claude-new-model'));
    const restarted = createClaudeModelCatalog({
      initialModels: [metadata('claude-existing')],
      discover: async () => { throw new Error('offline discovery must not run'); },
      fetchMetadata: async () => { throw new Error('offline metadata must not run'); },
    });
    assert.deepEqual(await restarted.refresh(store.context({ allowNetwork: false })), result);
    assert.equal((await store.read()).models.find(model => model.id === 'claude-new-model').provider, 'claude-bridge');
  });

  it('does not replace last-known models on an upstream failure', async () => {
    const store = memoryStore();
    await store.write({ models: [{ ...metadata(), provider: 'claude-bridge', api: 'claude-bridge', baseUrl: 'claude-bridge' }] });
    const catalog = createClaudeModelCatalog({ initialModels: [], discover: async () => { throw new Error('discovery offline'); }, fetchMetadata: async () => [] });
    await assert.rejects(catalog.refresh(store.context({ allowNetwork: true, force: true })), /discovery offline/);
    assert.deepEqual((await catalog.refresh(store.context({ allowNetwork: false }))).map(model => model.id), ['claude-new-model']);
  });

  it('reports absent limits rather than inventing capabilities or prices for a new model', async () => {
    const warnings = [];
    const catalog = createClaudeModelCatalog({
      initialModels: [metadata('claude-existing')], discover: async () => discovery,
      fetchMetadata: async () => [{ ...metadata(), contextWindow: -1 }], warn: message => warnings.push(message),
    });
    assert.deepEqual((await catalog.refresh(memoryStore().context({ allowNetwork: true }))).map(model => model.id), ['claude-existing']);
    assert.ok(warnings.some(message => message.includes('claude-new-model')));
  });

  it('can explicitly refresh a cached catalog without requiring a new process or package', async () => {
    const store = memoryStore();
    let latest = discovery;
    const catalog = createClaudeModelCatalog({
      initialModels: [], discover: async () => latest,
      fetchMetadata: async () => [metadata(), metadata('claude-another-model')],
    });
    await catalog.refresh(store.context({ allowNetwork: true }));
    latest = [...latest, { value: 'claude-another-model', displayName: 'Another model', description: '' }];
    assert.equal((await catalog.refresh(store.context({ allowNetwork: true }))).length, 1);
    const result = await catalog.refresh(store.context({ allowNetwork: true, force: true }));
    assert.deepEqual(result.map(model => model.id), ['claude-new-model', 'claude-another-model']);
  });
});
