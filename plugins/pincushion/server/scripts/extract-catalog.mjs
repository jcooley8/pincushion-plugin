#!/usr/bin/env node
// extract-catalog.mjs — the single source of truth, made machine-readable.
//
// Spawns the MCP server hermetically and reads its ADVERTISED catalog over the
// protocol (the same surface every IDE/agent actually sees). Introspection — not
// source parsing — sidesteps every brittle-regex trap: multi-line tool literals,
// nested prompt `arguments[].name` keys, and the intentional `apply_preview`
// dispatch-only stub. The one thing the protocol doesn't expose is Pro-gating,
// so we read the two flat `new Set([...])` literals straight from source.
//
// Hermetic boot: use an owned empty project and force any inherited signed-in
// profile to a loopback-only endpoint. Catalog generation must never poll a
// developer's configured cloud project.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MCP_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Pro-gating Sets are NOT advertised over the protocol — read them from source.
// Both are flat string-literal arrays, so a narrow regex is safe (this is the
// same pattern preflight.mjs uses for version fields).
export function readProSets() {
  const src = readFileSync(join(MCP_ROOT, 'server.js'), 'utf8');
  const grab = (name) => {
    const m = src.match(new RegExp(`const ${name} = new Set\\(\\[([\\s\\S]*?)\\]\\)`));
    return m ? [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]) : [];
  };
  return { proTools: grab('PRO_TOOLS'), softTools: grab('PRO_SOFT_TOOLS') };
}

const byName = (a, b) => a.name.localeCompare(b.name);

// Returns a stable-sorted catalog: { version, tools[], prompts[], resources[],
// proTools[], softTools[] }. Stable ordering makes the golden snapshot diff clean.
export async function extractCatalog() {
  const catalogProjectDir = mkdtempSync(join(tmpdir(), 'pincushion-mcp-catalog-'));
  const transport = new StdioClientTransport({
    command: 'node',
    args: ['server.js', '--bridge-port', '0', '--project-dir', catalogProjectDir],
    cwd: MCP_ROOT,
    env: {
      ...process.env,
      PINCUSHION_LICENSE_KEY: '',
      PINCUSHION_SYNC_URL: 'http://127.0.0.1:9/functions/v1/sync-annotations',
      PINCUSHION_NO_TELEMETRY: '1',
      PINCUSHION_NO_ONBOARDING: '1',
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'pincushion-catalog', version: '1.0.0' }, { capabilities: {} });
  try {
    await client.connect(transport);
    const [toolsRes, promptsRes, resourcesRes] = await Promise.all([
      client.listTools(),
      client.listPrompts(),
      client.listResources(),
    ]);

    const { proTools, softTools } = readProSets();
    const proSet = new Set(proTools);
    const softSet = new Set(softTools);

    const tools = toolsRes.tools
      .map((t) => ({ name: t.name, description: t.description || '', pro: proSet.has(t.name), soft: softSet.has(t.name) }))
      .sort(byName);
    const prompts = promptsRes.prompts
      .map((p) => ({ name: p.name, description: p.description || '', args: (p.arguments || []).map((a) => a.name) }))
      .sort(byName);
    const resources = (resourcesRes.resources || [])
      .map((r) => ({ uri: r.uri, name: r.name || '', description: r.description || '' }))
      .sort((a, b) => a.uri.localeCompare(b.uri));

    const version = JSON.parse(readFileSync(join(MCP_ROOT, 'package.json'), 'utf8')).version;
    return { version, tools, prompts, resources, proTools: [...proTools].sort(), softTools: [...softTools].sort() };
  } finally {
    try {
      await transport.close();
    } finally {
      rmSync(catalogProjectDir, { recursive: true, force: true });
    }
  }
}

// CLI: human summary → stderr, full JSON → stdout (so it can be piped/saved).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  extractCatalog()
    .then((cat) => {
      console.error(
        `tools=${cat.tools.length} prompts=${cat.prompts.length} resources=${cat.resources.length} ` +
        `pro=${cat.proTools.length} soft=${cat.softTools.length} version=${cat.version}`
      );
      process.stdout.write(JSON.stringify(cat, null, 2) + '\n');
    })
    .catch((e) => {
      console.error('[extract-catalog] failed:', e?.stack || e?.message || String(e));
      process.exit(1);
    });
}
