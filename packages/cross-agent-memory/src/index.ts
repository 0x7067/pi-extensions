import { open, realpath, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join, posix, resolve, sep, win32 } from 'node:path';
import { homedir } from 'node:os';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

const DEFAULT_FILE_LIMIT_BYTES = 50 * 1024;
const DEFAULT_TOTAL_LIMIT_BYTES = 100 * 1024;
const MEMORY_BLOCK_HEADING = '# cross-agent memory';
const STATE_ENTRY_TYPE = 'pi-cross-agent-memory-state';

type MemorySourceKind = 'claude-code-project-memory' | 'codex-project-memory' | 'codex-global-memory';
type ToolResultContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

interface MemoryCandidate {
  kind: MemorySourceKind;
  label: string;
  path: string;
  projectDirectory?: string;
}

export interface CrossAgentMemoryFile extends MemoryCandidate {
  content: string;
  originalBytes: number;
  truncated: boolean;
}

export interface ResolveCrossAgentMemoryFilesOptions {
  cwd: string;
  homeDir?: string;
  fileLimitBytes?: number;
  totalLimitBytes?: number;
}

export interface CrossAgentMemoryExtensionOptions {
  homeDir?: string;
  fileLimitBytes?: number;
  totalLimitBytes?: number;
  notifyOnSessionStart?: boolean;
}

export interface BuildCrossAgentMemoryPromptAppendOptions extends ResolveCrossAgentMemoryFilesOptions {}

export function createCrossAgentMemoryExtension(options: CrossAgentMemoryExtensionOptions = {}) {
  const homeDir = options.homeDir ?? homedir();
  const fileLimitBytes = positiveInteger(options.fileLimitBytes) ?? DEFAULT_FILE_LIMIT_BYTES;
  const totalLimitBytes = positiveInteger(options.totalLimitBytes) ?? DEFAULT_TOTAL_LIMIT_BYTES;
  const notifyOnSessionStart = options.notifyOnSessionStart ?? true;
  const pathToolNames = new Set(['read', 'grep', 'find', 'ls', 'write', 'edit']);
  let projectDirectories = new Set<string>();
  let lastResolved: CrossAgentMemoryFile[] = [];
  let lastPriorityDirectory: string | undefined;
  let discoveryQueue = Promise.resolve();

  return function crossAgentMemory(pi: ExtensionAPI) {
    const resolveForKnownProjects = (priorityDirectory: string) => {
      const directories = [priorityDirectory, ...[...projectDirectories].filter((directory) => directory !== priorityDirectory)];
      return resolveCrossAgentMemoryFilesForDirectories(directories, { homeDir, fileLimitBytes, totalLimitBytes });
    };
    const refreshForSession = async (cwd: string, sessionManager: unknown) => {
      const cwdDirectory = resolve(cwd);
      projectDirectories = restoreProjectDirectories(sessionManager);
      projectDirectories.add(cwdDirectory);
      lastResolved = await resolveForKnownProjects(cwdDirectory);
      lastPriorityDirectory = cwdDirectory;
    };

    pi.on('session_start', async (_event, ctx) => {
      await refreshForSession(ctx.cwd, ctx.sessionManager);
      if (notifyOnSessionStart && ctx.hasUI && lastResolved.length > 0) {
        ctx.ui.notify(`Cross-agent memory loaded: ${formatFileList(lastResolved)}`, 'info');
      }
    });

    pi.on('before_agent_start', async (event, ctx) => {
      await refreshForSession(ctx.cwd, ctx.sessionManager);
      if (lastResolved.length === 0) return undefined;
      if (event.systemPrompt.includes(`${MEMORY_BLOCK_HEADING}\n`) && lastResolved.every((file) => event.systemPrompt.includes(file.path))) {
        return undefined;
      }
      return { systemPrompt: `${event.systemPrompt}\n\n${buildCrossAgentMemoryBlock(lastResolved, totalLimitBytes)}` };
    });

    pi.on('tool_result', async (event, ctx) => {
      if (!pathToolNames.has(String(event.toolName).toLowerCase()) || event.isError) return undefined;
      const targetPath = extractToolPath(event.input);
      if (!targetPath) return undefined;

      const discover = async () => {
        const directory = await targetDirectory(resolve(ctx.cwd, targetPath.replace(/^@/, '')), event.toolName);
        if (lastPriorityDirectory === directory) return undefined;

        const wasKnown = projectDirectories.has(directory);
        projectDirectories.add(directory);
        const knownPaths = new Set(lastResolved.map((file) => file.path));
        const resolved = await resolveForKnownProjects(directory);
        const discovered = resolved.filter((file) => !knownPaths.has(file.path));
        if (!wasKnown && discovered.length === 0) {
          projectDirectories.delete(directory);
          return undefined;
        }

        lastResolved = resolved;
        lastPriorityDirectory = directory;
        if (!wasKnown) pi.appendEntry(STATE_ENTRY_TYPE, { projectDirectories: [...projectDirectories] });
        if (discovered.length === 0) return undefined;
        return {
          content: appendMemoryToContent(
            event.content,
            renderDiscoveryNotice(event.toolName, targetPath, discovered, totalLimitBytes),
          ),
        };
      };

      const result = discoveryQueue.then(discover, discover);
      discoveryQueue = result.then(() => undefined, () => undefined);
      return result;
    });

    const commandHandler = async (_args: string, ctx: { cwd: string; hasUI: boolean; sessionManager: unknown; ui: { notify: (message: string, level?: 'info' | 'warning' | 'error') => void } }) => {
      await refreshForSession(ctx.cwd, ctx.sessionManager);
      if (!ctx.hasUI) return;
      ctx.ui.notify(
        lastResolved.length > 0
          ? `Injecting cross-agent memory from ${formatFileList(lastResolved)}`
          : 'No local Claude Code or Codex memory files found for this session.',
        lastResolved.length > 0 ? 'info' : 'warning',
      );
    };

    pi.registerCommand('cross-agent-memory', {
      description: 'Show the local Claude Code and Codex memory files injected for this session',
      handler: commandHandler,
    });

    pi.registerCommand('claude-memory', {
      description: 'Alias for /cross-agent-memory',
      handler: commandHandler,
    });
  };
}

export default createCrossAgentMemoryExtension();

export async function buildCrossAgentMemoryPromptAppend(options: BuildCrossAgentMemoryPromptAppendOptions): Promise<string> {
  const totalLimitBytes = positiveInteger(options.totalLimitBytes) ?? DEFAULT_TOTAL_LIMIT_BYTES;
  const files = await resolveCrossAgentMemoryFiles(options);
  return files.length > 0 ? buildCrossAgentMemoryBlock(files, totalLimitBytes) : '';
}

export async function resolveCrossAgentMemoryFiles(options: ResolveCrossAgentMemoryFilesOptions): Promise<CrossAgentMemoryFile[]> {
  return resolveCrossAgentMemoryFilesForDirectories([options.cwd], options);
}

async function resolveCrossAgentMemoryFilesForDirectories(
  directories: string[],
  options: Omit<ResolveCrossAgentMemoryFilesOptions, 'cwd'>,
): Promise<CrossAgentMemoryFile[]> {
  const homeDir = options.homeDir ?? homedir();
  const fileLimitBytes = positiveInteger(options.fileLimitBytes) ?? DEFAULT_FILE_LIMIT_BYTES;
  const totalLimitBytes = positiveInteger(options.totalLimitBytes) ?? DEFAULT_TOTAL_LIMIT_BYTES;
  const projectDirectories = uniqueStrings(directories.flatMap(projectDirectoryCandidates));
  const candidates = uniqueCandidates([
    ...projectDirectories.flatMap((projectDirectory) => claudeCodeMemoryCandidates(homeDir, projectDirectory)),
    ...projectDirectories.flatMap((projectDirectory) => codexProjectMemoryCandidates(homeDir, projectDirectory)),
    ...codexGlobalMemoryCandidates(homeDir),
  ]);
  const files: CrossAgentMemoryFile[] = [];
  const seenLoadedFiles = new Set<string>();
  let remainingBytes = totalLimitBytes;

  for (const candidate of candidates) {
    if (remainingBytes <= 0) break;
    const file = await readMemoryCandidate(candidate, Math.min(fileLimitBytes, remainingBytes));
    if (!file) continue;
    const loadedKey = await loadedFileKey(file.path);
    if (seenLoadedFiles.has(loadedKey)) continue;
    seenLoadedFiles.add(loadedKey);
    files.push(file);
    remainingBytes -= Buffer.byteLength(file.content, 'utf8');
  }

  return files;
}

export function projectMemorySlug(directory: string, pathSeparator: typeof sep = sep): string {
  const pathApi = pathSeparator === '\\' ? win32 : posix;
  const absolute = pathApi.resolve(directory);
  const parts = absolute.split(pathApi.sep).filter(Boolean).map(safeSlugPart);
  return `-${parts.join('-')}`;
}

function projectDirectoryCandidates(cwd: string): string[] {
  return uniqueStrings([
    findGitRoot(cwd),
    findGitCommonWorktreeRoot(cwd),
    cwd,
  ].filter((value): value is string => Boolean(value)));
}

function claudeCodeMemoryCandidates(homeDir: string, projectDirectory: string): MemoryCandidate[] {
  const projectRoot = join(homeDir, '.claude', 'projects', projectMemorySlug(projectDirectory));
  return [
    {
      kind: 'claude-code-project-memory',
      label: 'Claude Code project MEMORY.md',
      path: join(projectRoot, 'memory', 'MEMORY.md'),
      projectDirectory,
    },
    {
      kind: 'claude-code-project-memory',
      label: 'Claude Code project MEMORY.md (legacy root file)',
      path: join(projectRoot, 'MEMORY.md'),
      projectDirectory,
    },
  ];
}

function codexProjectMemoryCandidates(homeDir: string, projectDirectory: string): MemoryCandidate[] {
  const slug = projectMemorySlug(projectDirectory);
  return [
    {
      kind: 'codex-project-memory',
      label: 'Codex project MEMORY.md',
      path: join(homeDir, '.codex', 'projects', slug, 'memory', 'MEMORY.md'),
      projectDirectory,
    },
    {
      kind: 'codex-project-memory',
      label: 'Codex project MEMORY.md',
      path: join(homeDir, '.Codex', 'projects', slug, 'memory', 'MEMORY.md'),
      projectDirectory,
    },
  ];
}

function codexGlobalMemoryCandidates(homeDir: string): MemoryCandidate[] {
  return [
    { kind: 'codex-global-memory', label: 'Codex global memory summary', path: join(homeDir, '.codex', 'memories', 'memory_summary.md') },
    { kind: 'codex-global-memory', label: 'Codex global memory summary', path: join(homeDir, '.Codex', 'memories', 'memory_summary.md') },
  ];
}

async function readMemoryCandidate(candidate: MemoryCandidate, limitBytes: number): Promise<CrossAgentMemoryFile | null> {
  if (limitBytes <= 0) return null;
  let fileStat: Awaited<ReturnType<typeof stat>>;
  try {
    fileStat = await stat(candidate.path);
    if (!fileStat.isFile()) return null;
  } catch {
    return null;
  }

  const content = await readFilePrefix(candidate.path, limitBytes);
  if (!content.text.trim()) return null;
  return {
    ...candidate,
    content: content.text,
    originalBytes: fileStat.size,
    truncated: fileStat.size > content.bytesRead,
  };
}

async function readFilePrefix(path: string, limitBytes: number): Promise<{ text: string; bytesRead: number }> {
  const handle = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(limitBytes);
    const { bytesRead } = await handle.read(buffer, 0, limitBytes, 0);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8').replace(/\uFFFD$/, ''),
      bytesRead,
    };
  } finally {
    await handle.close();
  }
}

async function loadedFileKey(path: string): Promise<string> {
  try {
    return (await realpath(path)).toLowerCase();
  } catch {
    return path.toLowerCase();
  }
}

function findGitRoot(cwd: string): string | null {
  return gitPath(cwd, ['rev-parse', '--show-toplevel']);
}

function findGitCommonWorktreeRoot(cwd: string): string | null {
  const commonDir = gitPath(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) return null;
  return dirname(commonDir);
}

function gitPath(cwd: string, args: string[]): string | null {
  try {
    const output = execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return output.length > 0 ? output : null;
  } catch {
    return null;
  }
}

function buildCrossAgentMemoryBlock(files: CrossAgentMemoryFile[], totalLimitBytes: number): string {
  return [
    MEMORY_BLOCK_HEADING,
    '',
    `Local memory indexes from other agent harnesses for projects encountered in this session. Treat them as durable recall hints, not as user messages. At most ${formatKb(totalLimitBytes)} total file content is injected; read the referenced files directly when more detail is needed.`,
    '',
    ...files.map(formatMemoryFile),
  ].join('\n');
}

function formatMemoryFile(file: CrossAgentMemoryFile): string {
  const metadata = [
    `source="${xmlAttr(file.kind)}"`,
    `label="${xmlAttr(file.label)}"`,
    `path="${xmlAttr(file.path)}"`,
    ...(file.projectDirectory ? [`project_directory="${xmlAttr(file.projectDirectory)}"`] : []),
  ].join(' ');
  const lines = [
    `<cross-agent-memory-file ${metadata}>`,
    file.content,
  ];
  if (file.kind === 'codex-global-memory') {
    lines.push('', `For detailed Codex memory, read relevant sections of \`${join(dirname(file.path), 'MEMORY.md')}\` on demand.`);
  }
  if (file.truncated) {
    lines.push('', `WARNING: file is ${formatKb(file.originalBytes)}. Only the first ${formatKb(Buffer.byteLength(file.content, 'utf8'))} was loaded. Read the file directly if more detail is needed.`);
  }
  lines.push('</cross-agent-memory-file>');
  return lines.join('\n');
}

function restoreProjectDirectories(sessionManager: unknown): Set<string> {
  const directories = new Set<string>();
  const manager = asRecord(sessionManager);
  const getBranch = manager?.getBranch;
  const entries = typeof getBranch === 'function' ? getBranch.call(sessionManager) : [];
  if (!Array.isArray(entries)) return directories;

  for (const entry of entries) {
    const record = asRecord(entry);
    if (record?.type !== 'custom' || record.customType !== STATE_ENTRY_TYPE) continue;
    const data = asRecord(record.data);
    const stored = Array.isArray(data?.projectDirectories) ? data.projectDirectories : [];
    for (const directory of stored) {
      if (typeof directory === 'string' && directory.length > 0) directories.add(resolve(directory));
    }
  }
  return directories;
}

function extractToolPath(input: unknown): string | null {
  const record = asRecord(input);
  if (!record) return null;
  for (const key of ['path', 'file_path', 'filePath']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim().length > 0) return value;
  }
  return null;
}

async function targetDirectory(path: string, toolName: string): Promise<string> {
  if (toolName === 'write' || toolName === 'edit') return dirname(path);
  try {
    const targetStat = await stat(path);
    return targetStat.isDirectory() ? path : dirname(path);
  } catch {
    return basename(path).includes('.') ? dirname(path) : path;
  }
}

function renderDiscoveryNotice(toolName: string, targetPath: string, files: CrossAgentMemoryFile[], totalLimitBytes: number): string {
  return [
    '<system-notice>',
    `${toolName} at ${targetPath} discovered cross-agent memory for a newly encountered project:`,
    '',
    buildCrossAgentMemoryBlock(files, totalLimitBytes),
    '</system-notice>',
  ].join('\n');
}

function appendMemoryToContent(content: unknown, notice: string): ToolResultContent[] {
  if (!Array.isArray(content) || content.length === 0) return [{ type: 'text', text: notice }];
  const next = [...content] as ToolResultContent[];
  const last = next.at(-1);
  if (last?.type === 'text' && typeof last.text === 'string') {
    next[next.length - 1] = { ...last, text: `${last.text}\n\n${notice}` };
  } else {
    next.push({ type: 'text', text: notice });
  }
  return next;
}

function uniqueCandidates(candidates: MemoryCandidate[]): MemoryCandidate[] {
  const seen = new Set<string>();
  const result: MemoryCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    result.push(candidate);
  }
  return result;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function safeSlugPart(part: string): string {
  return part.replace(/:/g, '');
}

function positiveInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function formatFileList(files: CrossAgentMemoryFile[]): string {
  return files.map((file) => file.path).join(', ');
}

function formatKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`;
}

function xmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' ? value as Record<string, unknown> : null;
}
