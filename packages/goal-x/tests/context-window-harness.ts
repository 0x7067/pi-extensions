import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import { createHarness } from './harness.ts';

export type FixtureModel = Model<Api>;

export function fixtureModel(provider = 'fixture', id = 'fixture-model', contextWindow = 200_000): FixtureModel {
  return {
    provider,
    id,
    name: `${provider}/${id}`,
    api: 'fixture-api',
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 8_192,
  } as FixtureModel;
}

export function installModelHarness(
  root: string,
  models: FixtureModel[] = [fixtureModel()],
  initialEntries: Array<Record<string, unknown>> = [],
) {
  const harness = createHarness(initialEntries, root);
  let current = models[0]!;
  const catalogs = new Map<string, FixtureModel[]>();
  const providers = new Map<string, Provider>();
  const discovered = new Map<string, FixtureModel[]>();
  for (const model of models) {
    catalogs.set(model.provider, [...(catalogs.get(model.provider) ?? []), model]);
  }
  for (const id of catalogs.keys()) {
    providers.set(id, {
      id,
      name: id,
      auth: { apiKey: { name: 'Fixture', resolve: async () => ({ auth: {} }) } },
      getModels: () => catalogs.get(id) ?? [],
      refreshModels: async () => {
        const next = discovered.get(id);
        if (next) catalogs.set(id, next);
      },
      stream: () => { throw new Error('fixture streaming available'); },
      streamSimple: () => { throw new Error('fixture streaming available'); },
    });
  }
  Object.assign(harness.ctx, {
    model: current,
    sessionManager: {
      ...harness.ctx.sessionManager,
      getSessionFile: () => join(root, 'sessions', 'fixture.jsonl'),
    },
    modelRegistry: {
      getProvider: (provider: string) => providers.get(provider),
      find: (provider: string, modelId: string) => providers.get(provider)?.getModels().find((model) => model.id === modelId),
      getAvailable: () => [...providers.values()].flatMap((provider) => provider.getModels()),
    },
  });
  Object.assign(harness.pi, {
    // Like Pi, replacing a provider changes the registry, not the active model.
    registerProvider: (provider: Provider) => { providers.set(provider.id, provider); },
    setModel: async (next: FixtureModel) => {
      current = next;
      Object.assign(harness.ctx, { model: next });
      return true;
    },
  });
  mkdirSync(join(root, 'sessions'), { recursive: true });
  if (!existsSync(join(root, 'models.json'))) writeFileSync(join(root, 'models.json'), '{}\n');
  return {
    harness,
    getModel: () => current,
    discoverModels: (provider: string, next: FixtureModel[]) => { discovered.set(provider, next); },
    selectModel(provider: string, modelId: string): FixtureModel {
      const selected = providers.get(provider)?.getModels().find((model) => model.id === modelId);
      if (!selected) throw new Error(`Unknown fixture model ${provider}/${modelId}`);
      current = selected;
      Object.assign(harness.ctx, { model: selected });
      return selected;
    },
  };
}
