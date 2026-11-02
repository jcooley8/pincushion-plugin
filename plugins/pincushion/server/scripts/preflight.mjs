#!/usr/bin/env node
// preflight.mjs — release drift guard for pincushion-mcp.
//
// Run before publishing (and in PR CI). Catches the exact failure classes that
// have shipped "Could not attach to MCP server pincushion" to users:
//
//   1. VERSION DRIFT   — package.json version must be strictly greater than the
//      version already on npm, and server.json must match package.json. (npm
//      publish uses package.json, not the git tag, so an un-bumped version
//      silently republishes / no-ops.)
//   2. MISSING DEP     — every non-builtin import in server.js + lib/*.js must be
//      a declared dependency. A bare `import 'x'` with `x` absent from
//      package.json throws ERR_MODULE_NOT_FOUND at startup → broken handshake.
//   3. BOOT FAILURE    — the server must complete the MCP initialize handshake on
//      a clean install AND exit when stdin closes (the orphan-process guard).
//
// Exit non-zero on any failure so CI blocks the release.

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execSync } from 'node:child_process';
import { builtinModules } from 'node:module';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const fail = [];
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.log(`  ✗ ${m}`); fail.push(m); };

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

// ── 1. Version drift ─────────────────────────────────────────────────────────
// PREFLIGHT_SKIP_VERSION=1 skips the "ahead of npm" check (use on PR CI, where
// not every PR bumps the version). The publish workflow runs WITHOUT it so a
// release can never ship an un-bumped version.
console.log('1. Version drift');
function cmpSemver(a, b) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0); }
  return 0;
}
if (process.env.PREFLIGHT_SKIP_VERSION === '1') {
  ok(`version-ahead check skipped (PREFLIGHT_SKIP_VERSION=1); package.json ${pkg.version}`);
} else {
  let npmLatest = null;
  try {
    npmLatest = execSync(`npm view ${pkg.name} version`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { /* package not yet published, or offline */ }
  if (npmLatest) {
    if (cmpSemver(pkg.version, npmLatest) > 0) ok(`package.json ${pkg.version} > npm latest ${npmLatest}`);
    else bad(`package.json ${pkg.version} is NOT ahead of npm latest ${npmLatest} — bump it (npm publish would republish/no-op)`);
  } else {
    ok(`no npm version to compare (first publish or offline): package.json ${pkg.version}`);
  }
}
try {
  const sj = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));
  const sjVers = [sj.version, ...(sj.packages || []).map((p) => p.version)];
  if (sjVers.every((v) => v === pkg.version)) ok(`server.json versions all match ${pkg.version}`);
  else bad(`server.json version(s) ${JSON.stringify(sjVers)} != package.json ${pkg.version}`);
} catch (e) { bad(`server.json unreadable: ${e.message}`); }
// The registry entry is public: repository.url must be the public plugin repo,
// not the private monorepo (404s publicly, so directories mark the server dead).
try {
  const sj = JSON.parse(readFileSync(join(ROOT, 'server.json'), 'utf8'));
  if (sj.repository?.url === 'https://github.com/jcooley8/pincushion-plugin') ok('server.json repository.url is the public plugin repo');
  else bad(`server.json repository.url ${JSON.stringify(sj.repository?.url)} must be https://github.com/jcooley8/pincushion-plugin (public)`);
} catch (e) { bad(`server.json unreadable: ${e.message}`); }
// MCPB manifest version must equal package.json — the .mcpb bundle (Desktop
// Extension / Anthropic directory) can never ship a stale version.
try {
  const mf = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  if (mf.version === pkg.version) ok(`manifest.json version matches ${pkg.version}`);
  else bad(`manifest.json version ${mf.version} != package.json ${pkg.version}`);
} catch (e) { bad(`manifest.json unreadable: ${e.message}`); }

// ── 2. Undeclared dependencies ───────────────────────────────────────────────
console.log('2. Imports are declared dependencies');
const declared = new Set([
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
  ...Object.keys(pkg.peerDependencies || {}),
]);
const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
function pkgNameOf(spec) {
  if (spec.startsWith('@')) return spec.split('/').slice(0, 2).join('/');
  return spec.split('/')[0];
}
function scanFile(rel) {
  const src = readFileSync(join(ROOT, rel), 'utf8');
  const specs = new Set();
  const re = /(?:import\s[^'"]*from\s*|import\s*|import\(\s*|require\(\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) specs.add(m[1]);
  for (const spec of specs) {
    if (spec.startsWith('.') || spec.startsWith('/')) continue;        // relative
    if (builtins.has(spec) || builtins.has(`node:${spec}`)) continue;   // builtin
    const name = pkgNameOf(spec);
    if (!declared.has(name)) bad(`${rel} imports '${spec}' but '${name}' is not in package.json dependencies`);
  }
}
const filesToScan = ['server.js', ...readdirSync(join(ROOT, 'lib')).filter((f) => f.endsWith('.js')).map((f) => `lib/${f}`)];
for (const f of filesToScan) scanFile(f);
if (!fail.length || fail.every((f) => !f.includes('imports'))) ok(`scanned ${filesToScan.length} files — all imports declared`);

// ── 3. Boot smoke test (handshake + self-exit on stdin EOF) ──────────────────
console.log('3. Boot smoke test (handshake + exits on transport close)');
const result = await new Promise((resolve) => {
  const child = spawn('node', [join(ROOT, 'server.js'), '--project-dir', ROOT], {
    env: { ...process.env, PINCUSHION_NO_TELEMETRY: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let handshaked = false;
  child.stdout.on('data', (d) => {
    out += d;
    if (!handshaked && out.includes('"protocolVersion"') && out.includes('"id":1')) {
      handshaked = true;
      child.stdin.end(); // close transport → server must exit
    }
  });
  child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"preflight","version":"1"}}}\n');
  const hsTimer = setTimeout(() => { if (!handshaked) { try { child.kill('SIGKILL'); } catch {} resolve({ handshaked: false, exited: false }); } }, 15000);
  const exitTimer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} resolve({ handshaked, exited: false }); }, 20000);
  child.on('exit', () => { clearTimeout(hsTimer); clearTimeout(exitTimer); resolve({ handshaked, exited: true }); });
});
if (result.handshaked) ok('completed MCP initialize handshake'); else bad('did NOT complete handshake within 15s');
if (result.exited) ok('exited within ~5s of stdin close (no orphan)'); else bad('did NOT exit on stdin close — would orphan');

// ── Verdict ──────────────────────────────────────────────────────────────────
console.log('');
if (fail.length) { console.error(`PREFLIGHT FAILED (${fail.length} issue(s)). Release blocked.`); process.exit(1); }
console.log('PREFLIGHT PASSED ✓'); process.exit(0);
