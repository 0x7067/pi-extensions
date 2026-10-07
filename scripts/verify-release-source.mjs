#!/usr/bin/env node

import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const RELEASE_TAG = /^([a-z0-9]+(?:-[a-z0-9]+)*)-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/;

export function parseReleaseTag(tag) {
  // A failed publish can leave an immutable, unpublished tag. A suffix gives the
  // OIDC workflow a new protected tag to retry the same package version without
  // moving the original release tag.
  const releaseTag = tag.replace(/-republish\d*$/, '');
  const match = RELEASE_TAG.exec(releaseTag);
  if (!match) {
    throw new Error(`Release tag must be <package-directory>-v<semver>; received ${JSON.stringify(tag)}.`);
  }
  return { workspace: match[1], version: match[2] };
}

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function remoteTagCommit(tag, cwd) {
  const output = git([
    'ls-remote',
    '--tags',
    'origin',
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ], cwd);
  const refs = new Map(output.split('\n').filter(Boolean).map((line) => line.split(/\s+/, 2).reverse()));
  return refs.get(`refs/tags/${tag}^{}`) ?? refs.get(`refs/tags/${tag}`) ?? null;
}

export function verifyReleaseSource(tag, cwd = process.cwd()) {
  const { workspace, version } = parseReleaseTag(tag);
  const manifestPath = resolve(cwd, 'packages', workspace, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const expectedPackageName = `@fractaal/pi-${workspace}`;

  if (manifest.name !== expectedPackageName) {
    throw new Error(`${manifestPath} must name ${expectedPackageName}; found ${JSON.stringify(manifest.name)}.`);
  }
  if (manifest.private === true) {
    throw new Error(`${manifest.name} is private and cannot be published.`);
  }
  if (manifest.version !== version) {
    throw new Error(`${manifest.name} is version ${manifest.version}, but ${tag} requests ${version}.`);
  }

  const head = git(['rev-parse', 'HEAD'], cwd);
  const tagCommit = git(['rev-list', '-n', '1', `refs/tags/${tag}`], cwd);
  if (tagCommit !== head) {
    throw new Error(`${tag} targets ${tagCommit}, but the checked-out release commit is ${head}.`);
  }

  git(['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'], cwd);
  const liveTagCommit = remoteTagCommit(tag, cwd);
  if (liveTagCommit !== head) {
    throw new Error(`${tag} now targets ${liveTagCommit ?? 'nothing'} on origin, not the checked-out release commit ${head}.`);
  }

  try {
    execFileSync('git', ['merge-base', '--is-ancestor', head, 'refs/remotes/origin/main'], {
      cwd,
      stdio: 'ignore',
    });
  } catch {
    throw new Error(`${tag} does not target a commit accepted on the current origin/main.`);
  }

  return {
    package: manifest.name,
    workspace,
    version,
    commit: head,
  };
}

function writeGitHubOutputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''),
  );
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const values = verifyReleaseSource(process.argv[2]);
    writeGitHubOutputs(values);
    console.log(JSON.stringify(values));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
