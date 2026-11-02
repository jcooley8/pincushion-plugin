#!/usr/bin/env node
// build-mcpb.mjs — package the Pincushion MCP server as a Desktop Extension (.mcpb).
//
// Produces a SELF-CONTAINED bundle (the server + its production dependencies +
// icon + manifest) that installs in Claude Desktop in one click — no Node toolchain
// or npm on the user's machine. We vendor prod node_modules rather than esbuild
// because @sentry/node, posthog-node and @supabase/supabase-js use dynamic
// require/conditional exports that resist single-file bundling (the build-mcpb skill
// explicitly endorses copying node_modules when deps resist bundling).
//
// Layout produced under build/mcpb/ (gitignored):
//   manifest.json, icon.png, server/{server.js,package.json,LICENSE.md,lib/,docs/,node_modules/}

import { execSync } from 'node:child_process';
import { cpSync, rmSync, mkdirSync, copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packMcpb, validateMcpbManifest } from '../../scripts/mcpb-format.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..'); // pincushion-mcp/
const REPO = join(ROOT, '..');                                    // repo root
const BUILD = join(ROOT, 'build', 'mcpb');
const SERVER = join(BUILD, 'server');
const OUT = join(ROOT, 'pincushion.mcpb');
const log = (m) => console.log(`[build:mcpb] ${m}`);
const run = (cmd, cwd) => execSync(cmd, { cwd: cwd || ROOT, stdio: 'inherit' });

// Version sanity — manifest.json must match package.json (preflight also enforces this).
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const mf = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
if (pkg.version !== mf.version) {
  console.error(`[build:mcpb] version mismatch: package.json ${pkg.version} != manifest.json ${mf.version}`);
  process.exit(1);
}

log(`clean ${BUILD}`);
rmSync(BUILD, { recursive: true, force: true });
mkdirSync(SERVER, { recursive: true });

log('stage manifest + icon');
copyFileSync(join(ROOT, 'manifest.json'), join(BUILD, 'manifest.json'));
const icon = join(REPO, 'store-assets', 'icon128.png');
if (!existsSync(icon)) { console.error(`[build:mcpb] icon not found: ${icon}`); process.exit(1); }
copyFileSync(icon, join(BUILD, 'icon.png'));

log('stage server code');
for (const f of ['server.js', 'claim.mjs', 'login.mjs', 'package.json', 'package-lock.json', 'LICENSE.md']) copyFileSync(join(ROOT, f), join(SERVER, f));
for (const d of ['lib', 'docs', 'demo']) {
  if (existsSync(join(ROOT, d))) cpSync(join(ROOT, d), join(SERVER, d), { recursive: true,
    filter: (path) => path !== join(ROOT, 'lib', 'safe-error.contract.mjs') });
}
// Ship the /snapshot-latest-deploy capture helper (just the one script — not the
// build tooling that also lives in scripts/).
if (existsSync(join(ROOT, 'scripts', 'capture-snapshot.mjs'))) {
  mkdirSync(join(SERVER, 'scripts'), { recursive: true });
  copyFileSync(join(ROOT, 'scripts', 'capture-snapshot.mjs'), join(SERVER, 'scripts', 'capture-snapshot.mjs'));
}

log('vendor locked production dependencies (npm ci --omit=dev --ignore-scripts)');
run('npm ci --omit=dev --ignore-scripts --no-audit --no-fund', SERVER);

log('validate manifest');
validateMcpbManifest(join(BUILD, 'manifest.json'));

log('pack');
rmSync(OUT, { force: true });
packMcpb(BUILD, OUT);

const mb = (statSync(OUT).size / 1024 / 1024).toFixed(1);
log(`done → ${OUT} (${mb} MB)`);
