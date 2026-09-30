import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, parse as parsePath } from 'node:path';
import type { Api, Model, Provider } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from '@earendil-works/pi-coding-agent';
import lockfile from 'proper-lockfile';
import {
  CONTEXT_WINDOW_GLOBAL_DEFAULTS_FILE,
  CONTEXT_WINDOW_ACTION_ID,
  CONTEXT_WINDOW_DEFAULT_ACTION_ID,
  CONTEXT_WINDOW_SCHEMA_VERSION,
  CONTEXT_WINDOW_STATE_ENTRY,
  CONTEXT_WINDOW_STATE_EVENT,
  CONTEXT_WINDOW_STATE_REQUEST_EVENT,
  effectiveContextWindow,
  parseContextWindowActionInput,
  parseContextWindowDefaults,
  parseContextWindowState,
  modelKey,
  type ContextWindowDefaults,
  type ContextWindowModel,
  type ContextWindowState,
} from './context-window-contract.ts';

const GLOBAL_DEFAULTS_FILE_VERSION = CONTEXT_WINDOW_SCHEMA_VERSION;

type ModelRegistryLike = ExtensionContext['modelRegistry'];

type ContextWindowCommandContext = ExtensionCommandContext & {
  model?: Model<Api>;
};

function modelRef(model: Model<Api> | undefined): ContextWindowModel | null {
  if (!model || typeof model.provider !== 'string' || !model.provider.trim() || typeof model.id !== 'string' || !model.id.trim()) return null;
  return { provider: model.provider, modelId: model.id };
}

function modelMax(model: Model<Api>): number {
  if (!Number.isSafeInteger(model.contextWindow) || model.contextWindow <= 0) {
    throw new Error(`Model ${model.provider}/${model.id} does not expose a valid context window.`);
  }
  return model.contextWindow;
}

function parseTokenCount(raw: string, maxWindow: number): number {
  const normalized = raw.trim().toLowerCase().replaceAll(',', '');
  if (normalized === 'max') return maxWindow;
  const match = /^(\d+(?:\.\d+)?)([kmgt])?$/.exec(normalized);
  if (!match) throw new Error('Context window must be a positive token count, compact k/m syntax, max, or default.');
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === 'k' ? 1_000 : unit === 'm' ? 1_000_000 : unit === 'g' ? 1_000_000_000 : unit === 't' ? 1_000_000_000_000 : 1;
  const value = amount * multiplier;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('Context window must be a positive safe integer.');
  return Math.min(maxWindow, value);
}

function statusText(state: ContextWindowState): string {
  const scope = state.sessionOverride === null
    ? state.globalDefault === null ? 'model maximum' : `global default ${formatTokens(state.globalDefault)}`
    : `session override ${formatTokens(state.sessionOverride)}`;
  return `${state.model.provider}/${state.model.modelId}: ${formatTokens(state.effectiveWindow)} effective, ${formatTokens(state.maxWindow)} maximum (${scope}).`;
}

function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${trimNumber(value / 1_000)}k`;
  if (value < 1_000_000_000) return `${trimNumber(value / 1_000_000)}m`;
  return `${trimNumber(value / 1_000_000_000)}b`;
}

function trimNumber(value: number): string {
  return value >= 100 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}

function stateFor(
  model: Model<Api>,
  revision: number,
  sessionOverride: number | null,
  globalDefault: number | null,
): ContextWindowState {
  const maxWindow = modelMax(model);
  const effectiveWindow = effectiveContextWindow(maxWindow, sessionOverride, globalDefault);
  return {
    schemaVersion: CONTEXT_WINDOW_SCHEMA_VERSION,
    revision,
    model: { provider: model.provider, modelId: model.id },
    maxWindow,
    sessionOverride,
    globalDefault,
    effectiveWindow,
  };
}

function loadState(ctx: ExtensionContext): ContextWindowState | null {
  const branch = ctx.sessionManager.getBranch();
  for (let index = branch.length - 1; index >= 0; index -= 1) {
    const entry = branch[index] as { type?: string; customType?: string; data?: unknown };
    if (entry.type !== 'custom' || entry.customType !== CONTEXT_WINDOW_STATE_ENTRY) continue;
    const parsed = parseContextWindowState(entry.data);
    if (!parsed) throw new Error(`Invalid ${CONTEXT_WINDOW_STATE_ENTRY} at the active branch leaf; refusing to fall back to older context-window state.`);
    return parsed;
  }
  return null;
}

function profileRoot(ctx: ExtensionContext): string {
  const sessionFile = ctx.sessionManager.getSessionFile();
  if (sessionFile) {
    let current = dirname(sessionFile);
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(join(current, 'models.json'))) return current;
      const parent = parsePath(current).dir;
      if (parent === current) break;
      current = parent;
    }
  }
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  return configured || join(homedir(), '.pi', 'agent');
}

function defaultsPath(ctx: ExtensionContext): string {
  return join(profileRoot(ctx), CONTEXT_WINDOW_GLOBAL_DEFAULTS_FILE);
}

async function readDefaults(ctx: ExtensionContext): Promise<ContextWindowDefaults> {
  const path = defaultsPath(ctx);
  try {
    const parsed = parseContextWindowDefaults(await readFile(path, 'utf8').then(JSON.parse));
    if (!parsed) throw new Error(`Invalid ${CONTEXT_WINDOW_GLOBAL_DEFAULTS_FILE}.`);
    return parsed;
  } catch (error) {
    if (isNotFound(error)) return { schemaVersion: GLOBAL_DEFAULTS_FILE_VERSION, defaults: {} };
    throw error;
  }
}

async function writeDefaults(ctx: ExtensionContext, mutate: (current: ContextWindowDefaults) => ContextWindowDefaults): Promise<ContextWindowDefaults> {
  const path = defaultsPath(ctx);
  await mkdir(dirname(path), { recursive: true });
  let lockCompromised: Error | null = null;
  const release = await lockfile.lock(path, {
    realpath: false,
    retries: { retries: 10, factor: 2, minTimeout: 100, maxTimeout: 10_000, randomize: true },
    stale: 30_000,
    onCompromised: (error) => { lockCompromised = error; },
  });
  try {
    if (lockCompromised) throw lockCompromised;
    const result = mutate(await readDefaults(ctx));
    const temporary = `${path}.${process.pid}.${Date.now().toString(36)}.tmp`;
    await writeFile(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    if (lockCompromised) throw lockCompromised;
    await rename(temporary, path);
    if (lockCompromised) throw lockCompromised;
    return result;
  } finally {
    if (lockCompromised) await release().catch(() => undefined);
    else await release();
  }
}

function isNotFound(error: unknown): boolean {
  return error !== null && typeof error === 'object' && 'code' in error && (error as { code?: unknown }).code === 'ENOENT';
}

export default function contextWindowExtension(pi: ExtensionAPI): void {
  let state: ContextWindowState | null = null;
  let defaults: ContextWindowDefaults = { schemaVersion: GLOBAL_DEFAULTS_FILE_VERSION, defaults: {} };
  let runtimeContext: ExtensionContext | null = null;
  const originalProviders = new Map<string, Provider>();
  let applying = false;

  function emitState(): void {
    if (state) pi.events.emit(CONTEXT_WINDOW_STATE_EVENT, structuredClone(state));
  }

  function persist(next: ContextWindowState, ctx: ExtensionContext): void {
    state = structuredClone(next);
    pi.appendEntry(CONTEXT_WINDOW_STATE_ENTRY, state);
    emitState();
  }

  function captureProvider(providerId: string, registry: ModelRegistryLike): Provider {
    const existing = originalProviders.get(providerId);
    if (existing) return existing;
    const provider = registry.getProvider(providerId);
    if (!provider) throw new Error(`Provider ${providerId} is unavailable.`);
    originalProviders.set(providerId, provider);
    return provider;
  }

  async function applyModel(model: Model<Api>, ctx: ExtensionContext, shouldPersist: boolean): Promise<void> {
    const ref = modelRef(model);
    if (!ref) return;
    const provider = captureProvider(ref.provider, ctx.modelRegistry);
    const sessionOverride = state?.sessionOverride ?? null;
    // Decorate the live catalog, not a captured model array. Native refresh,
    // authentication, streaming and additional capabilities remain provider-owned.
    pi.registerProvider({
      ...provider,
      getModels: () => provider.getModels().map((candidate) => {
        const globalDefault = defaults.defaults[modelKey({ provider: candidate.provider, modelId: candidate.id })] ?? null;
        const cap = candidate.id === model.id && sessionOverride !== null ? sessionOverride : globalDefault;
        return { ...candidate, contextWindow: effectiveContextWindow(modelMax(candidate), cap, null) };
      }),
    });
    const replacement = ctx.modelRegistry.find(ref.provider, ref.modelId);
    const maxWindow = modelMax(provider.getModels().find((candidate) => candidate.id === ref.modelId) ?? model);
    const globalDefault = defaults.defaults[modelKey(ref)] ?? null;
    const next = stateFor(
      { ...model, contextWindow: maxWindow } as Model<Api>,
      state?.revision ?? 0,
      sessionOverride,
      globalDefault,
    );
    if (replacement && ctx.model?.contextWindow !== next.effectiveWindow && !applying) {
      applying = true;
      try {
        // models.json remains the configured ceiling in the registry. Apply the
        // selected budget to the active model as well, not the uncapped entry.
        await pi.setModel({ ...replacement, contextWindow: next.effectiveWindow });
      } finally {
        applying = false;
      }
    }
    if (shouldPersist && (!state || state.model.provider !== next.model.provider || state.model.modelId !== next.model.modelId || state.maxWindow !== next.maxWindow || state.sessionOverride !== next.sessionOverride || state.globalDefault !== next.globalDefault || state.effectiveWindow !== next.effectiveWindow)) {
      persist({ ...next, revision: (state?.revision ?? 0) + 1 }, ctx);
    } else {
      state = { ...next, revision: state?.revision ?? next.revision };
      emitState();
    }
  }

  async function refresh(ctx: ExtensionContext, model = ctx.model): Promise<void> {
    if (!model) return;
    defaults = await readDefaults(ctx);
    await applyModel(model, ctx, true);
  }

  async function setSessionOverride(raw: string, ctx: ContextWindowCommandContext): Promise<void> {
    const model = ctx.model;
    if (!model) throw new Error('No model is active.');
    const current = state ?? stateFor(model, 0, null, defaults.defaults[modelKey(modelRef(model)!) ] ?? null);
    const nextOverride = raw.trim().toLowerCase() === 'default' ? null : parseTokenCount(raw, current.maxWindow);
    state = { ...current, sessionOverride: nextOverride };
    await applyModel({ ...model, contextWindow: current.maxWindow } as Model<Api>, ctx, false);
    persist({ ...state!, revision: current.revision + 1 }, ctx);
    ctx.ui.notify(statusText(state!), 'info');
  }

  async function setGlobalDefault(raw: string, ctx: ContextWindowCommandContext): Promise<void> {
    const model = ctx.model;
    if (!model) throw new Error('No model is active.');
    const ref = modelRef(model);
    if (!ref) throw new Error('The active model is unavailable.');
    const current = state ?? stateFor(model, 0, null, null);
    const nextValue = raw.trim().toLowerCase() === 'default' ? null : parseTokenCount(raw, current.maxWindow);
    defaults = await writeDefaults(ctx, (existing) => {
      const next = { ...existing.defaults };
      if (nextValue === null) delete next[modelKey(ref)];
      else next[modelKey(ref)] = nextValue;
      return { schemaVersion: GLOBAL_DEFAULTS_FILE_VERSION, defaults: next };
    });
    await applyModel({ ...model, contextWindow: current.maxWindow } as Model<Api>, ctx, false);
    persist({ ...state!, revision: current.revision + 1 }, ctx);
    ctx.ui.notify(statusText(state!), 'info');
  }

  pi.events.on(CONTEXT_WINDOW_STATE_REQUEST_EVENT, () => emitState());
  pi.events.on('aria-local:runtime-action', (raw) => {
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
    if ((record?.actionId !== CONTEXT_WINDOW_ACTION_ID && record?.actionId !== CONTEXT_WINDOW_DEFAULT_ACTION_ID) || !runtimeContext) return;
    const input = parseContextWindowActionInput(record.input);
    if (!input) return;
    const operation = input.scope === 'global' || record.actionId === CONTEXT_WINDOW_DEFAULT_ACTION_ID
      ? setGlobalDefault
      : setSessionOverride;
    void operation(String(input.value), runtimeContext as ContextWindowCommandContext).catch((error) => {
      runtimeContext?.ui.notify(error instanceof Error ? error.message : 'The context-window action failed.', 'error');
    });
  });

  pi.registerCommand('context-window', {
    description: 'Show or set the current session context-window override.',
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as ContextWindowCommandContext;
      if (!args.trim()) {
        if (state) ctx.ui.notify(statusText(state), 'info');
        else await refresh(ctx);
        return;
      }
      await setSessionOverride(args, ctx);
    },
  });

  pi.registerCommand('context-window-default', {
    description: 'Show or set the current model global context-window default.',
    handler: async (args, rawCtx) => {
      const ctx = rawCtx as ContextWindowCommandContext;
      if (!args.trim()) {
        if (state) ctx.ui.notify(statusText(state), 'info');
        else await refresh(ctx);
        return;
      }
      await setGlobalDefault(args, ctx);
    },
  });

  pi.on('session_start', async (_event, ctx) => {
    runtimeContext = ctx;
    const loaded = loadState(ctx);
    state = loaded;
    defaults = await readDefaults(ctx);
    await refresh(ctx);
  });

  pi.on('session_tree', async (_event, ctx) => {
    runtimeContext = ctx;
    state = loadState(ctx);
    await refresh(ctx);
  });

  pi.on('model_select', async (event, ctx) => {
    if (applying) return;
    await refresh(ctx, event.model);
  });

  pi.on('session_shutdown', () => { runtimeContext = null; });
}

export * from './context-window-contract.ts';
