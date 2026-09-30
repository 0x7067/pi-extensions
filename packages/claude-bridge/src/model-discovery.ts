import { query, type ModelInfo, type Options } from '@anthropic-ai/claude-agent-sdk';
import type { Model, RefreshModelsContext } from '@earendil-works/pi-ai';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { PROVIDER_ID } from './convert.js';
import { resolveClaudeCodeExecutable } from './executable-resolution.js';
import { PromptInput } from './prompt-input.js';

const costRatesSchema = z.object({
  input: z.number().nonnegative(), output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(), cacheWrite: z.number().nonnegative(),
});
const metadataSchema = z.object({
  id: z.string().min(1), name: z.string().min(1), reasoning: z.boolean(),
  input: z.array(z.enum(['text', 'image'])).min(1),
  contextWindow: z.number().int().positive(), maxTokens: z.number().int().positive(),
  cost: costRatesSchema.extend({ tiers: z.array(costRatesSchema.extend({ inputTokensAbove: z.number().nonnegative() })).optional() }),
  thinkingLevelMap: z.record(z.string(), z.union([z.string(), z.null()])).optional(),
});
const catalogSchema = z.union([
  z.array(z.unknown()),
  z.object({ models: z.array(z.unknown()) }),
  z.record(z.string(), z.unknown()),
]);
export type BridgeCatalogModel = z.infer<typeof metadataSchema>;

interface DiscoveryQuery { supportedModels(): Promise<ModelInfo[]>; close(): void }
export interface ClaudeModelDiscoveryOptions {
  env?: NodeJS.ProcessEnv;
  executablePath?: string;
  signal?: AbortSignal;
  startQuery?: (input: { prompt: PromptInput; options: Options }) => DiscoveryQuery;
}

/** One metadata-only initialization. Never attach to or reinitialize an inference query. */
export async function discoverClaudeModels(options: ClaudeModelDiscoveryOptions = {}): Promise<ModelInfo[]> {
  const env = { ...process.env, ...options.env };
  const executablePath = options.executablePath ?? resolveClaudeCodeExecutable({ env })?.executablePath;
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]);
  signal.throwIfAborted();
  const cwd = await mkdtemp(join(tmpdir(), 'pi-claude-models-'));
  const abortController = new AbortController();
  const input = new PromptInput(); // Never supplied a prompt: no inference or tool execution.
  let session: DiscoveryQuery | undefined;
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    session = (options.startQuery ?? query)({
      prompt: input,
      options: {
        cwd, ...(executablePath ? { pathToClaudeCodeExecutable: executablePath } : {}), abortController,
        tools: [], mcpServers: {}, settingSources: [], persistSession: false,
        settings: { disableAllHooks: true }, extraArgs: { 'strict-mcp-config': null },
        env: { ...env, ENABLE_CLAUDEAI_MCP_SERVERS: '0' },
      },
    });
    return await Promise.race([
      session.supportedModels(),
      new Promise<never>((_resolve, reject) => {
        onAbort = () => { abortController.abort(); reject(new Error('Claude model discovery was cancelled or timed out.')); };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) onAbort();
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
    input.close();
    try { session?.close(); } finally { await rm(cwd, { recursive: true, force: true }); }
  }
}

/** Only capability/pricing fields cross this boundary; never catalog headers or request destinations. */
export function parseClaudeModelMetadata(value: unknown): BridgeCatalogModel[] {
  const catalog = catalogSchema.parse(value);
  const rows = Array.isArray(catalog) ? catalog : Array.isArray(catalog.models) ? catalog.models : Object.values(catalog);
  return rows.flatMap(row => {
    const parsed = metadataSchema.safeParse(row);
    return parsed.success ? [parsed.data] : [];
  });
}

export function mergeClaudeModelDiscovery(
  existing: readonly BridgeCatalogModel[],
  discovered: readonly ModelInfo[],
  metadata: readonly BridgeCatalogModel[],
): { models: BridgeCatalogModel[]; missingMetadata: string[] } {
  const models = new Map(existing.map(model => [model.id, model]));
  const details = new Map([...existing, ...metadata].map(model => [model.id, model]));
  const missingMetadata: string[] = [];
  for (const info of discovered) {
    const id = info.resolvedModel ?? info.value;
    // Aliases without a resolved wire ID aren't stable persisted selections.
    if (!id.startsWith('claude-')) continue;
    // Claude Code can resolve an alias to a wire selector such as opus[1m].
    // Keep that selector for execution, but look up its underlying model's data.
    const metadataId = id.endsWith('[1m]') ? id.slice(0, -4) : id;
    const known = details.get(id) ?? details.get(metadataId);
    if (!known) { missingMetadata.push(id); continue; }
    let thinkingLevelMap = known.thinkingLevelMap;
    if (info.supportedEffortLevels?.length) {
      const efforts = new Set<string>(info.supportedEffortLevels);
      thinkingLevelMap = Object.fromEntries(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map(level => {
        const wireLevel = level === 'off' ? 'none' : level === 'minimal' ? 'low' : level;
        return [level, efforts.has(wireLevel) ? wireLevel : null];
      }));
    }
    models.set(id, {
      ...known, id, name: id === metadataId ? known.name : `${known.name} (1M)`, thinkingLevelMap,
      reasoning: info.supportsEffort ?? info.supportsAdaptiveThinking ?? known.reasoning,
    });
  }
  return { models: [...models.values()], missingMetadata: [...new Set(missingMetadata)] };
}

export function createClaudeModelCatalog(options: {
  initialModels: BridgeCatalogModel[];
  discover(signal?: AbortSignal): Promise<ModelInfo[]>;
  fetchMetadata?: (signal?: AbortSignal) => Promise<unknown>;
  warn?: (message: string) => void;
}) {
  let models = options.initialModels;
  let pending: Promise<BridgeCatalogModel[]> | undefined;
  const fetchMetadata = options.fetchMetadata ?? (async (signal?: AbortSignal) => {
    const response = await fetch('https://pi.dev/api/models/providers/anthropic', { signal, headers: { accept: 'application/json' } });
    if (!response.ok) throw new Error(`Claude model metadata request failed (${response.status}).`);
    return response.json();
  });
  return {
    refresh(context: RefreshModelsContext): Promise<BridgeCatalogModel[]> {
      pending ??= (async () => {
        try {
          const stored = await context.store.read();
          const cached = parseClaudeModelMetadata(stored?.models ?? []);
          models = [...new Map([...options.initialModels, ...cached].map(model => [model.id, model])).values()];
          if (!context.allowNetwork || context.signal?.aborted) return models;
          if (!context.force && stored?.checkedAt && Date.now() - stored.checkedAt < 4 * 60 * 60_000) return models;
          const signal = AbortSignal.any([AbortSignal.timeout(20_000), ...(context.signal ? [context.signal] : [])]);
          const [discovered, metadataResult] = await Promise.all([
            options.discover(signal),
            fetchMetadata(signal).then(parseClaudeModelMetadata).catch((error: unknown) => {
              options.warn?.(error instanceof Error ? error.message : 'Claude model metadata is unavailable.');
              return [];
            }),
          ]);
          signal.throwIfAborted();
          const merged = mergeClaudeModelDiscovery(models, discovered, metadataResult);
          if (merged.missingMetadata.length) {
            options.warn?.(`Claude models await context/output metadata: ${merged.missingMetadata.join(', ')}.`);
          }
          const entry = {
            models: merged.models.map(model => ({ ...model, provider: PROVIDER_ID, api: PROVIDER_ID, baseUrl: PROVIDER_ID })) as Model<typeof PROVIDER_ID>[],
            checkedAt: Date.now(),
          };
          await context.store.write(entry);
          models = merged.models;
          return models;
        } finally { pending = undefined; }
      })();
      return pending;
    },
  };
}
