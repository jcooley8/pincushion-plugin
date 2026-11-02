#!/usr/bin/env node

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inspectRegistryRelease, inspectReleaseState } from './release-state.mjs';

const MCP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = join(MCP_ROOT, '..');
const EXECUTE = process.argv.includes('--publish');
const MCP_PUBLISHER_RELEASE = 'v1.7.9';
const MCP_PUBLISHER_DIGESTS = Object.freeze({
  'mcp-publisher_darwin_amd64.tar.gz': '8250b61c7530960fbb54f99daa91001004e365c604cb305b13fc072ea3f5cca9',
  'mcp-publisher_darwin_arm64.tar.gz': '5925c8d2c942b2a0330b979530b5d70284c3bdb03850a3cd1032685b80ddc2e3',
  'mcp-publisher_linux_amd64.tar.gz': 'ab128162b0616090b47cf245afe0a23f3ef08936fdce19074f5ba0a4469281ac',
  'mcp-publisher_linux_arm64.tar.gz': '04f5199b3deef8e6fc4d6ed98c56a74f799def53edca3fe6d4862ecd4397c172',
});

function run(command, args, {
  cwd = REPO_ROOT,
  capture = true,
  env = process.env,
  timeout = 300_000,
} = {}) {
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  return { status: result.status ?? 1, stdout: result.stdout || '' };
}

function requireOk(result, message) {
  if (result.status !== 0) throw new Error(message);
  return String(result.stdout || '').trim();
}

function git(...args) {
  return run('git', args, { cwd: REPO_ROOT });
}

export function assertReleaseCheckout({ branch, defaultRef, status, head, remoteHead }) {
  const expectedBranch = String(defaultRef || '').replace(/^origin\//, '');
  if (!branch || branch !== expectedBranch) {
    throw new Error(`release must run from the fetched remote-default branch (${expectedBranch || 'unknown'})`);
  }
  if (status) throw new Error('release checkout is dirty');
  if (!head || head !== remoteHead) throw new Error('release checkout is not the exact fetched remote-default OID');
}

export function parseRemoteHeadReceipt(value) {
  const lines = String(value || '').split(/\r?\n/).filter(Boolean);
  const symref = lines.find((line) => line.startsWith('ref: refs/heads/') && line.endsWith('\tHEAD'));
  const oidLine = lines.find((line) => /^[0-9a-f]{40}\tHEAD$/i.test(line));
  if (!symref || !oidLine) throw new Error('origin did not return an authoritative default-branch receipt');
  const branch = symref.slice('ref: refs/heads/'.length, -'\tHEAD'.length);
  const oid = oidLine.split('\t')[0];
  if (!branch || !oid) throw new Error('origin default-branch receipt is incomplete');
  return { branch, oid };
}

function authenticate(command, checkArgs, loginArgs, label) {
  if (run(command, checkArgs).status === 0) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(`${label} authentication required; rerun this command in an interactive terminal`);
  }
  console.log(`${label} authentication is required. Opening its browser-based sign-in…`);
  requireOk(run(command, loginArgs, { capture: false, timeout: 600_000 }), `${label} sign-in failed`);
  requireOk(run(command, checkArgs), `${label} sign-in did not become active`);
}

export function publisherArtifact(platform = process.platform, architecture = process.arch) {
  const os = platform === 'darwin' ? 'darwin' : platform === 'linux' ? 'linux' : null;
  const arch = architecture === 'arm64' ? 'arm64' : architecture === 'x64' ? 'amd64' : null;
  if (!os || !arch) throw new Error(`unsupported mcp-publisher platform: ${platform}/${architecture}`);
  const name = `mcp-publisher_${os}_${arch}.tar.gz`;
  return { release: MCP_PUBLISHER_RELEASE, name, sha256: MCP_PUBLISHER_DIGESTS[name] };
}

async function registryHasVersion(pkg) {
  return await inspectRegistryRelease({
    serverName: pkg.mcpName,
    packageName: pkg.name,
    version: pkg.version,
  });
}

async function main() {
  requireOk(git('fetch', 'origin', '--prune'), 'git fetch failed');
  const branch = requireOk(git('symbolic-ref', '--quiet', '--short', 'HEAD'), 'release requires an attached branch');
  const remoteReceipt = parseRemoteHeadReceipt(requireOk(
    git('ls-remote', '--symref', 'origin', 'HEAD'),
    'origin default branch is unknown',
  ));
  const defaultRef = `origin/${remoteReceipt.branch}`;
  const status = requireOk(git('status', '--porcelain'), 'git status failed');
  const head = requireOk(git('rev-parse', 'HEAD'), 'cannot resolve HEAD');
  const fetchedRemoteHead = requireOk(git('rev-parse', defaultRef), 'cannot resolve fetched remote default');
  if (fetchedRemoteHead !== remoteReceipt.oid) throw new Error('fetched remote-default ref does not match the remote HEAD receipt');
  const remoteHead = remoteReceipt.oid;
  assertReleaseCheckout({ branch, defaultRef, status, head, remoteHead });

  const pkg = JSON.parse(readFileSync(join(MCP_ROOT, 'package.json'), 'utf8'));
  const tag = `mcp-v${pkg.version}`;
  let state = await inspectReleaseState({ cwd: MCP_ROOT });
  if (state.npm.status === 'conflict') {
    throw new Error(`npm ${pkg.name}@${pkg.version} exists with a different package digest`);
  }
  if (state.npm.status === 'unavailable') {
    throw new Error('npm registry read-back is unavailable; refusing to infer that the version is missing');
  }
  if (state.registry.status === 'unavailable') {
    throw new Error('MCP Registry read-back is unavailable; refusing to publish without a known starting state');
  }

  console.log(`Release candidate ${pkg.name}@${pkg.version} at ${head}`);
  console.log(`npm=${state.npm.status}; registry=${state.registry.status}; tag=${tag}`);
  if (!EXECUTE) {
    console.log('CHECK_ONLY: rerun `npm run release:fallback -- --publish` to execute missing stages.');
    return;
  }

  if (state.npm.status === 'missing') {
    authenticate(
      'npm',
      ['whoami', '--registry=https://registry.npmjs.org/'],
      ['login', '--auth-type=web', '--registry=https://registry.npmjs.org/'],
      'npm',
    );
    requireOk(run('node', ['scripts/preflight.mjs'], {
      cwd: MCP_ROOT,
      capture: false,
      env: { ...process.env, npm_config_registry: 'https://registry.npmjs.org/' },
    }), 'MCP release preflight failed');
    requireOk(run('npm', ['publish', '--access', 'public', '--registry=https://registry.npmjs.org/'], { cwd: MCP_ROOT, capture: false, timeout: 600_000 }), 'npm publish failed');
    state = await inspectReleaseState({ cwd: MCP_ROOT });
    if (state.npm.status !== 'exact') throw new Error('npm publish did not read back with the exact local package digest');
  } else {
    requireOk(run('node', ['scripts/preflight.mjs'], {
      cwd: MCP_ROOT,
      capture: false,
      env: {
        ...process.env,
        PREFLIGHT_SKIP_VERSION: '1',
        npm_config_registry: 'https://registry.npmjs.org/',
      },
    }), 'MCP resume preflight failed');
  }

  authenticate('gh', ['auth', 'status'], ['auth', 'login', '--web'], 'GitHub');

  const registryBeforePublish = await registryHasVersion(pkg);
  if (registryBeforePublish.status === 'unavailable') {
    throw new Error('MCP Registry read-back became unavailable; refusing to infer that the version is missing');
  }
  if (registryBeforePublish.status !== 'exact') {
    const downloadDir = mkdtempSync(join(tmpdir(), 'pincushion-mcp-publisher-'));
    try {
      const artifact = publisherArtifact();
      requireOk(run('gh', ['release', 'download', artifact.release, '--repo', 'modelcontextprotocol/registry', '--pattern', artifact.name, '--dir', downloadDir]), 'mcp-publisher download failed');
      const archive = join(downloadDir, artifact.name);
      const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
      if (digest !== artifact.sha256) throw new Error('mcp-publisher release asset failed its pinned SHA-256 check');
      requireOk(run('tar', ['-xzf', archive, '-C', downloadDir]), 'mcp-publisher extraction failed');
      const publisher = join(downloadDir, 'mcp-publisher');
      if (!existsSync(publisher)) throw new Error('mcp-publisher binary was not present in the verified release asset');
      requireOk(run(publisher, ['login', 'github'], { cwd: MCP_ROOT, capture: false, timeout: 600_000 }), 'MCP Registry GitHub sign-in failed');
      requireOk(run(publisher, ['publish'], { cwd: MCP_ROOT, capture: false }), 'MCP Registry publish failed');
      const registryReadback = await registryHasVersion(pkg);
      if (registryReadback.status === 'unavailable') {
        throw new Error('registry_pending: MCP Registry publish completed but exact read-back is unavailable');
      }
      if (registryReadback.status !== 'exact') throw new Error('registry_pending: MCP Registry publish did not read back at the exact version');
    } finally {
      rmSync(downloadDir, { recursive: true, force: true });
    }
  }

  requireOk(run('npm', ['run', 'build:mcpb'], { cwd: MCP_ROOT, capture: false }), 'MCPB build failed');
  const assetPath = join(MCP_ROOT, 'pincushion.mcpb');
  if (!existsSync(assetPath)) throw new Error('MCPB build did not create pincushion.mcpb');

  const remoteTag = git('ls-remote', '--exit-code', '--tags', 'origin', `refs/tags/${tag}^{}`);
  if (remoteTag.status === 0) {
    const taggedOid = String(remoteTag.stdout).trim().split(/\s+/)[0];
    if (taggedOid !== head) throw new Error(`${tag} already points to a different OID`);
  } else {
    const localTag = git('rev-parse', '-q', '--verify', `refs/tags/${tag}^{}`);
    if (localTag.status === 0 && String(localTag.stdout).trim() !== head) {
      throw new Error(`local ${tag} points to a different OID`);
    }
    if (localTag.status !== 0) requireOk(git('tag', '-a', tag, '-m', `Release ${tag}`), `failed to create ${tag}`);
    requireOk(git('push', 'origin', `refs/tags/${tag}`), `failed to push ${tag}`);
  }

  const releaseExists = run('gh', ['release', 'view', tag], { cwd: REPO_ROOT }).status === 0;
  if (releaseExists) {
    requireOk(run('gh', ['release', 'upload', tag, assetPath, '--clobber'], { cwd: REPO_ROOT }), 'GitHub release asset upload failed');
  } else {
    requireOk(run('gh', ['release', 'create', tag, assetPath, '--verify-tag', '--title', tag, '--generate-notes'], { cwd: REPO_ROOT }), 'GitHub release creation failed');
  }

  console.log(`RELEASE_COMPLETE: ${pkg.name}@${pkg.version} / ${tag} / ${basename(assetPath)} / ${head}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    // Child stderr is never surfaced here. This keeps registry credentials,
    // npm tokens, and token-bearing URLs out of durable logs.
    console.error(`RELEASE_BLOCKED: ${error.message}`);
    process.exitCode = 1;
  });
}
