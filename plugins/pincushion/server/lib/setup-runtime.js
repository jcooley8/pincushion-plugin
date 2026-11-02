import { createHash, randomBytes } from 'node:crypto';
import { constants, lstatSync, realpathSync, readdirSync, readFileSync, writeFileSync, mkdirSync, openSync, closeSync, fstatSync, readSync, linkSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { checkNodeRuntime } from './node-runtime.js';

// This is a runtime allowlist, not a recursive copy of a user's checkout.
export const SETUP_RUNTIME_ROOTS = Object.freeze(['cli.js', 'server.js', 'setup.mjs', 'claim.mjs', 'login.mjs', 'snapshot.mjs', 'capture.mjs', 'mobile-wall.mjs', 'lib', 'scripts/capture-snapshot.mjs', 'agent-assets', 'package.json', 'LICENSE.md', 'runtime/package-lock.snapshot.json']);
const HASH = /^[a-f0-9]{64}$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const LIMIT = 128 * 1024 * 1024;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function setupNodeRuntimeSupported() {
  return checkNodeRuntime().supported;
}
function present(path) { try { return lstatSync(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
function directories(path) {
  for (let p = resolve(path); ; p = dirname(p)) {
    const stat = present(p);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) throw new Error('unsafe_runtime_directory');
    if (dirname(p) === p) return;
  }
}
function bytes(path, maximum = 8 * 1024 * 1024) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maximum) throw new Error('unsafe_runtime_file');
    const data = Buffer.alloc(stat.size + 1); let length = 0;
    while (length < data.length) { const count = readSync(fd, data, length, data.length - length, null); if (!count) break; length += count; }
    if (length !== stat.size) throw new Error('runtime_file_changed');
    return data.subarray(0, length);
  } finally { closeSync(fd); }
}
function inventory(root, roots, excludeContracts = false) {
  const files = {}; let total = 0, count = 0;
  function visit(name, depth = 0) {
    if (depth > 16 || ++count > 20000) throw new Error('runtime_inventory_limit');
    if (excludeContracts && /(?:^|\/)(?:fixtures|tests)(?:\/|$)|\.(?:test|contract)\.[^.]+$/.test(name)) return;
    const path = join(root, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error('runtime_symlink');
    if (excludeContracts && /(?:^|\/)(?:\.[^/]+|node_modules|build|credentials|secrets)(?:\/|$)/i.test(name)) throw new Error('unsupported_runtime_asset');
    if (stat.isDirectory()) { for (const child of readdirSync(path).sort()) visit(`${name}/${child}`, depth + 1); return; }
    if (!stat.isFile()) throw new Error('unsafe_runtime_file');
    if (excludeContracts && name.startsWith('lib/') && !/\.(?:js|mjs|json)$/.test(name)) throw new Error('unsupported_runtime_asset');
    if (excludeContracts && name.startsWith('agent-assets/') && !/\.(?:md|yaml|yml|json|js|mjs)$/.test(name)) throw new Error('unsupported_runtime_asset');
    const data = bytes(path); total += data.length;
    if (total > LIMIT) throw new Error('runtime_inventory_limit');
    files[name] = { sha256: digest(data), size: data.length };
  }
  for (const name of roots) visit(name);
  return files;
}
function stable(value) { return JSON.stringify(Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))); }
function runtimeIdentity(files, nodeExecutable = process.execPath, nodeVersion = process.version) {
  return digest(stable({ files, nodeExecutable, nodeVersion }));
}
function sourceSnapshot(sourceRoot) {
  directories(sourceRoot); const source = realpathSync(sourceRoot);
  const files = inventory(source, SETUP_RUNTIME_ROOTS, true);
  const pkg = JSON.parse(bytes(join(source, 'package.json')));
  const lock = JSON.parse(bytes(join(source, 'runtime/package-lock.snapshot.json')));
  if (pkg.name !== 'pincushion-mcp' || lock.lockfileVersion !== 3 || lock.name !== pkg.name || lock.version !== pkg.version || stable(lock.packages?.['']?.dependencies || {}) !== stable(pkg.dependencies || {}) || stable(lock.packages?.['']?.optionalDependencies || {}) !== stable(pkg.optionalDependencies || {})) throw new Error('runtime_lock_mismatch');
  if (pkg.workspaces || pkg.bundleDependencies || pkg.bundledDependencies) throw new Error('unsupported_runtime_dependencies');
  if ([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})].some(name => !PACKAGE_NAME.test(name))) throw new Error('unsupported_runtime_dependencies');
  for (const [name, entry] of Object.entries(lock.packages || {})) {
    if (!name) continue;
    // npm preserves this exact placeholder for an unavailable *direct optional*
    // package. It has no downloadable code. Keep optional absence semantics;
    // never admit a missing integrity/resolution for a required dependency.
    const optionalAbsent = Object.hasOwn(pkg.optionalDependencies || {}, name.slice('node_modules/'.length)) && name.startsWith('node_modules/') && entry.optional === true && Object.keys(entry).length === 1;
    if (optionalAbsent) continue;
    if (!name.startsWith('node_modules/') || name.split('/').includes('..') || entry.link || !entry.integrity || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity)) throw new Error('unsupported_runtime_dependencies');
    const url = new URL(entry.resolved);
    if (url.protocol !== 'https:' || url.hostname !== 'registry.npmjs.org' || url.port || url.username || url.password || url.search || url.hash) throw new Error('unsupported_runtime_dependencies');
  }
  return { source, files, artifactId: runtimeIdentity(files), version: pkg.version };
}
function location(cwd, artifactId) {
  if (!HASH.test(artifactId || '')) throw new Error('invalid_runtime_artifact');
  directories(cwd); const root = realpathSync(resolve(cwd));
  const target = join(root, '.pincushion', 'runtime', artifactId); directories(target);
  return { root, target };
}
function exclusive(path, data) {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  writeFileSync(temp, data, { flag: 'wx', mode: 0o600 });
  try { linkSync(temp, path); } finally { unlinkSync(temp); }
}
export function readSetupRuntimeBinding({ cwd, artifactId } = {}) {
  try {
    const { root, target } = location(cwd, artifactId);
    const receipt = JSON.parse(bytes(join(target, 'ready.json')));
    if (receipt.version !== 1 || receipt.artifactId !== artifactId || receipt.workspace !== root || !receipt.files || !receipt.dependencies || receipt.nodeExecutable !== process.execPath || receipt.nodeVersion !== process.version) throw new Error('runtime_receipt_mismatch');
    if (runtimeIdentity(receipt.files, receipt.nodeExecutable, receipt.nodeVersion) !== artifactId) throw new Error('runtime_receipt_mismatch');
    const expected = Object.keys(receipt.files);
    if (expected.some(name => isAbsolute(name) || name.split('/').some(part => !part || part === '..' || part === '.'))) throw new Error('runtime_receipt_mismatch');
    if (stable(inventory(target, SETUP_RUNTIME_ROOTS, true)) !== stable(receipt.files) || digest(bytes(join(target, 'package-lock.json'))) !== receipt.files['runtime/package-lock.snapshot.json']?.sha256 || stable(inventory(target, ['node_modules'])) !== stable(receipt.dependencies)) throw new Error('runtime_content_mismatch');
    const permitted = new Set([...SETUP_RUNTIME_ROOTS.map(name => name.split('/')[0]), 'node_modules', 'package-lock.json', 'ready.json']);
    if (readdirSync(target).some(name => !permitted.has(name))) throw new Error('runtime_content_mismatch');
    return { ready: true, artifactId, directory: target, command: receipt.nodeExecutable, serverPath: join(target, 'server.js') };
  } catch { return { ready: false, reason: 'runtime_missing_or_unverified' }; }
}
function npmExecutable(cwd) {
  for (const directory of (process.env.PATH || '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = join(directory, 'npm');
    try {
      const actual = realpathSync(candidate), rel = relative(cwd, actual);
      if (lstatSync(actual).isFile() && rel && (rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel))) return candidate;
    } catch {}
  }
  throw new Error('npm_missing_or_unverified');
}
function boundedChild(command, args, { cwd, env, timeoutMs, failure, timeout = failure, interrupted = failure }) {
  return new Promise((resolveResult, reject) => {
    let child, timer, settled = false;
    const stop = () => { if (!child?.pid) return; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } };
    const onInterrupt = () => { stop(); done(new Error(interrupted)); };
    const done = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      process.removeListener('SIGINT', onInterrupt); process.removeListener('SIGTERM', onInterrupt);
      error ? reject(error) : resolveResult();
    };
    try { child = spawn(command, args, { cwd, env, shell: false, detached: process.platform !== 'win32', stdio: 'ignore' }); }
    catch { done(new Error(failure)); return; }
    process.once('SIGINT', onInterrupt); process.once('SIGTERM', onInterrupt);
    timer = setTimeout(() => { stop(); done(new Error(timeout)); }, timeoutMs);
    child.once('error', () => { stop(); done(new Error(failure)); });
    child.once('exit', code => { stop(); done(code === 0 ? null : new Error(failure)); });
  });
}
async function installDependencies(target, executable, timeoutMs) {
  const cache = join(target, '.install-cache'), userConfig = join(target, '.empty-user-npmrc'), globalConfig = join(target, '.empty-global-npmrc');
  mkdirSync(cache, { mode: 0o700 });
  for (const path of [userConfig, globalConfig]) writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_/i.test(key) && !/^(NODE_OPTIONS|NODE_PATH|NPM_TOKEN|NODE_AUTH_TOKEN)$/i.test(key)));
  const args = ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--bin-links=false', '--workspaces=false', '--registry=https://registry.npmjs.org', `--cache=${cache}`, `--userconfig=${userConfig}`, `--globalconfig=${globalConfig}`];
  // Logs are deliberately not exposed: npm output may contain ambient details.
  await boundedChild(executable, args, { cwd: target, env, timeoutMs, failure: 'runtime_dependencies_failed', timeout: 'runtime_dependencies_timeout', interrupted: 'runtime_dependencies_interrupted' });
  // Only the owned install artifacts are removed, never an existing runtime.
  const { rmSync } = await import('node:fs');
  rmSync(cache, { recursive: true }); unlinkSync(userConfig); unlinkSync(globalConfig);
}
async function importSmoke(target) {
  const pkg = JSON.parse(bytes(join(target, 'package.json')));
  const modules = [...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {}).filter(name => present(join(target, 'node_modules', name, 'package.json')))];
  if (modules.some(name => !PACKAGE_NAME.test(name))) throw new Error('unsupported_runtime_dependencies');
  // The SDK exposes server subpaths; its package-root module is not shipped.
  // Use the same entry points server.js imports, without starting MCP/auth.
  const imports = modules.flatMap(name => name === '@modelcontextprotocol/sdk'
    ? [`${name}/server/index.js`, `${name}/server/stdio.js`, `${name}/types.js`] : [name]);
  const program = `await Promise.all(${JSON.stringify(imports)}.map(name => import(name)));`;
  const env = { ...process.env }; delete env.NODE_OPTIONS; delete env.NODE_PATH;
  await boundedChild(process.execPath, ['--input-type=module', '-e', program], { cwd: target, env, timeoutMs: 5000, failure: 'runtime_import_failed', interrupted: 'runtime_dependencies_interrupted' });
  // Parse the copied executable without starting account, MCP or browser work.
  await boundedChild(process.execPath, ['--check', join(target, 'server.js')], { cwd: target, env, timeoutMs: 5000, failure: 'runtime_import_failed', interrupted: 'runtime_dependencies_interrupted' });
}
export async function prepareSetupRuntime({ cwd, consent, sourceRoot = fileURLToPath(new URL('../', import.meta.url)), timeoutMs = 180000 } = {}) {
  if (consent !== true) return { ready: false, reason: 'explicit_runtime_consent_required' };
  if (!setupNodeRuntimeSupported()) return { ready: false, reason: 'runtime_node_unsupported' };
  if (process.platform === 'win32') return { ready: false, reason: 'runtime_install_platform_unsupported' };
  let target;
  try {
    const snapshot = sourceSnapshot(sourceRoot), place = location(cwd, snapshot.artifactId); target = place.target;
    if (present(target)) return readSetupRuntimeBinding({ cwd, artifactId: snapshot.artifactId });
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 }); directories(dirname(target));
    // Exclusive reservation. Incomplete reservations are never silently repaired.
    mkdirSync(target, { mode: 0o700 }); directories(target);
    for (const name of Object.keys(snapshot.files)) {
      directories(dirname(join(target, name))); mkdirSync(dirname(join(target, name)), { recursive: true, mode: 0o700 });
      const data = bytes(join(snapshot.source, name));
      if (digest(data) !== snapshot.files[name].sha256) throw new Error('runtime_source_changed');
      exclusive(join(target, name), data);
    }
    exclusive(join(target, 'package-lock.json'), bytes(join(target, 'runtime/package-lock.snapshot.json')));
    const executable = npmExecutable(place.root);
    await installDependencies(target, executable, Math.min(180000, Math.max(1000, timeoutMs)));
    await importSmoke(target);
    directories(target);
    const dependencies = inventory(target, ['node_modules']);
    if (stable(inventory(target, SETUP_RUNTIME_ROOTS, true)) !== stable(snapshot.files)) throw new Error('runtime_source_changed');
    const receipt = { version: 1, artifactId: snapshot.artifactId, workspace: place.root, packageVersion: snapshot.version, nodeExecutable: process.execPath, nodeVersion: process.version, files: snapshot.files, dependencies };
    exclusive(join(target, 'ready.json'), `${JSON.stringify(receipt)}\n`);
    return readSetupRuntimeBinding({ cwd, artifactId: snapshot.artifactId });
  } catch (error) { return { ready: false, reason: ['runtime_dependencies_failed', 'runtime_dependencies_timeout', 'runtime_dependencies_interrupted', 'npm_missing_or_unverified'].includes(error.message) ? error.message : 'runtime_install_blocked', ...(target ? { directory: target } : {}) }; }
}
