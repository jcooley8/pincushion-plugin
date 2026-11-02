#!/usr/bin/env node

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

export const MCP_REGISTRY_URL = 'https://registry.modelcontextprotocol.io/v0.1/servers';
export const NPM_REGISTRY_URL = 'https://registry.npmjs.org';
const MCP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

export function parseJsonOutput(value, label) {
  try {
    return JSON.parse(String(value || '').trim());
  } catch {
    throw new Error(`${label} returned unreadable JSON`);
  }
}

function defaultRun(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || MCP_ROOT,
    encoding: 'utf8',
    env: options.env || process.env,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || 120_000,
  });
  return {
    status: result.status ?? 1,
    stdout: result.stdout || '',
    // Intentionally do not expose stderr to callers. Registry and npm errors
    // can contain credentials or token-bearing URLs.
  };
}

export async function inspectNpmRelease({
  packageName,
  version,
  cwd = MCP_ROOT,
  run = defaultRun,
  fetchImpl = globalThis.fetch,
} = {}) {
  const packDir = mkdtempSync(join(tmpdir(), 'pincushion-release-pack-'));
  try {
    const packed = run('npm', ['pack', '--json', '--pack-destination', packDir], { cwd });
    if (packed.status !== 0) throw new Error('npm pack failed while calculating the release digest');
    const packJson = parseJsonOutput(packed.stdout, 'npm pack');
    const localIntegrity = Array.isArray(packJson) ? packJson[0]?.integrity : null;
    if (!localIntegrity) throw new Error('npm pack did not return a package integrity digest');

    let response;
    try {
      const encodedName = packageName.split('/').map(encodeURIComponent).join('%2F');
      response = await fetchImpl(`${NPM_REGISTRY_URL}/${encodedName}/${encodeURIComponent(version)}`, {
        headers: { accept: 'application/json' },
      });
    } catch {
      return { status: 'unavailable', localIntegrity };
    }
    if (response?.status === 404) return { status: 'missing', localIntegrity };
    if (!response?.ok) return { status: 'unavailable', localIntegrity };
    let body;
    try {
      body = await response.json();
    } catch {
      return { status: 'unavailable', localIntegrity };
    }
    const remoteIntegrity = typeof body?.dist?.integrity === 'string' ? body.dist.integrity : '';
    if (!remoteIntegrity) return { status: 'unavailable', localIntegrity };
    return remoteIntegrity === localIntegrity
      ? { status: 'exact', localIntegrity, remoteIntegrity }
      : { status: 'conflict', localIntegrity, remoteIntegrity };
  } finally {
    rmSync(packDir, { recursive: true, force: true });
  }
}

export async function inspectRegistryRelease({
  serverName,
  packageName,
  version,
  fetchImpl = globalThis.fetch,
} = {}) {
  const url = new URL(MCP_REGISTRY_URL);
  url.searchParams.set('search', serverName);
  url.searchParams.set('version', version);
  url.searchParams.set('limit', '100');
  let response;
  try {
    response = await fetchImpl(url, { headers: { accept: 'application/json' } });
  } catch {
    return { status: 'unavailable' };
  }
  if (!response?.ok) return { status: 'unavailable' };
  let body;
  try {
    body = await response.json();
  } catch {
    return { status: 'unavailable' };
  }
  const exact = (body?.servers || []).some(({ server } = {}) =>
    server?.name === serverName &&
    server?.version === version &&
    (server?.packages || []).some((pkg) => pkg.identifier === packageName && pkg.version === version)
  );
  return { status: exact ? 'exact' : 'missing' };
}

export async function inspectReleaseState({ cwd = MCP_ROOT, run = defaultRun, fetchImpl = globalThis.fetch } = {}) {
  const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'));
  const npm = await inspectNpmRelease({ packageName: pkg.name, version: pkg.version, cwd, run, fetchImpl });
  const registry = await inspectRegistryRelease({
    serverName: pkg.mcpName,
    packageName: pkg.name,
    version: pkg.version,
    fetchImpl,
  });
  return { packageName: pkg.name, serverName: pkg.mcpName, version: pkg.version, npm, registry };
}

async function main() {
  const state = await inspectReleaseState();
  process.stdout.write(`${JSON.stringify(state, null, 2)}\n`);
  if (state.npm.status === 'conflict') process.exitCode = 2;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    console.error(`RELEASE_STATE_ERROR: ${error.message}`);
    process.exitCode = 1;
  });
}
