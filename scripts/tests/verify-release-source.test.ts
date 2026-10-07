import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseReleaseTag } from '../verify-release-source.mjs';

const script = resolve(import.meta.dirname, '..', 'verify-release-source.mjs');
const temporaryDirectories: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

async function createReleaseRepository(version = '0.1.1', workspace = 'directive-roots') {
  const root = await mkdtemp(join(tmpdir(), 'pi-extensions-release-'));
  temporaryDirectories.push(root);
  const remote = join(root, 'origin.git');
  const checkout = join(root, 'checkout');

  await mkdir(checkout);
  git(root, 'init', '--bare', remote);
  git(checkout, 'init', '-b', 'main');
  git(checkout, 'config', 'user.name', 'Release Test');
  git(checkout, 'config', 'user.email', 'release@example.com');
  await mkdir(join(checkout, 'packages', workspace), { recursive: true });
  await writeFile(join(checkout, 'packages', workspace, 'package.json'), JSON.stringify({
    name: `@fractaal/pi-${workspace}`,
    version,
  }));
  git(checkout, 'add', '.');
  git(checkout, 'commit', '-m', 'release fixture');
  git(checkout, 'remote', 'add', 'origin', remote);
  git(checkout, 'push', '-u', 'origin', 'main');
  return { root, checkout, remote };
}

function verify(cwd: string, tag: string, githubOutput?: string): string {
  return execFileSync('node', [script, tag], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...(githubOutput ? { GITHUB_OUTPUT: githubOutput } : {}) },
  }).trim();
}

async function expectVerificationFailure(cwd: string, tag: string, message: string) {
  let stderr = '';
  try {
    verify(cwd, tag);
  } catch (error) {
    stderr = String((error as { stderr?: string }).stderr ?? error);
  }
  expect(stderr).toContain(message);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('release source verification', () => {
  it('parses an independent package release tag', () => {
    expect(parseReleaseTag('directive-roots-v0.1.1')).toEqual({ workspace: 'directive-roots', version: '0.1.1' });
  });

  it('parses a republish tag as the same package version', () => {
    expect(parseReleaseTag('directive-roots-v0.1.1-republish2')).toEqual({ workspace: 'directive-roots', version: '0.1.1' });
  });

  it('rejects malformed and path-like release tags', () => {
    expect(() => parseReleaseTag('../directive-roots-v0.1.1')).toThrow('Release tag must be');
    expect(() => parseReleaseTag('directive-roots-0.1.1')).toThrow('Release tag must be');
  });

  it('accepts a matching package version at a tag on main', async () => {
    const { checkout } = await createReleaseRepository();
    const outputPath = join(checkout, 'github-output');
    git(checkout, 'tag', 'directive-roots-v0.1.1');
    git(checkout, 'push', 'origin', 'refs/tags/directive-roots-v0.1.1');

    const result = JSON.parse(verify(checkout, 'directive-roots-v0.1.1', outputPath));
    expect(result).toMatchObject({
      package: '@fractaal/pi-directive-roots',
      workspace: 'directive-roots',
      version: '0.1.1',
    });
    expect(await readFile(outputPath, 'utf8')).toContain('package=@fractaal/pi-directive-roots\n');
  });

  it.each([
    ['cross-agent-memory', '0.3.1'],
    ['goal-x', '0.28.9'],
    ['todo', '0.1.3'],
    ['context-window', '0.1.1'],
  ])('accepts a migrated %s package through the same release verifier', async (workspace, version) => {
    const { checkout } = await createReleaseRepository(version, workspace);
    const tag = `${workspace}-v${version}`;
    git(checkout, 'tag', tag);
    git(checkout, 'push', 'origin', `refs/tags/${tag}`);
    expect(JSON.parse(verify(checkout, tag))).toMatchObject({
      package: `@fractaal/pi-${workspace}`, workspace, version,
    });
  });

  it('rejects a tag whose version differs from the package', async () => {
    const { checkout } = await createReleaseRepository('0.1.0');
    git(checkout, 'tag', 'directive-roots-v0.1.1');

    await expectVerificationFailure(checkout, 'directive-roots-v0.1.1', 'is version 0.1.0');
  });

  it('rejects a release tag that is not accepted on main', async () => {
    const { checkout } = await createReleaseRepository();
    git(checkout, 'switch', '-c', 'unmerged-release');
    await writeFile(join(checkout, 'unmerged.txt'), 'not on main\n');
    git(checkout, 'add', '.');
    git(checkout, 'commit', '-m', 'unmerged release');
    git(checkout, 'tag', 'directive-roots-v0.1.1');
    git(checkout, 'push', 'origin', 'refs/tags/directive-roots-v0.1.1');

    await expectVerificationFailure(checkout, 'directive-roots-v0.1.1', 'does not target a commit accepted on the current origin/main');
  });

  it('rejects a release when the remote tag moves after checkout', async () => {
    const { root, checkout, remote } = await createReleaseRepository();
    const tag = 'directive-roots-v0.1.1';
    git(checkout, 'tag', tag);
    git(checkout, 'push', 'origin', `refs/tags/${tag}`);

    const releaseCheckout = join(root, 'release-checkout');
    git(root, 'clone', remote, releaseCheckout);
    git(releaseCheckout, 'checkout', tag);
    expect(() => verify(releaseCheckout, tag)).not.toThrow();

    await writeFile(join(checkout, 'later-main-change.txt'), 'later main commit\n');
    git(checkout, 'add', '.');
    git(checkout, 'commit', '-m', 'later main commit');
    git(checkout, 'tag', '--force', tag);
    git(checkout, 'push', 'origin', 'main', `+refs/tags/${tag}:refs/tags/${tag}`);

    await expectVerificationFailure(releaseCheckout, tag, 'now targets');
  });
});
