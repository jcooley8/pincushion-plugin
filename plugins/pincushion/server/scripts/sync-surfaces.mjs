#!/usr/bin/env node
// sync-surfaces.mjs — keep every plugin surface in lockstep with the MCP catalog,
// and make any change to the catalog a visible, reviewed event.
//
//   node sync-surfaces.mjs            # FIX mode: regenerate managed files + snapshot
//   node sync-surfaces.mjs --check    # CHECK mode (CI): verify only, fail on drift
//
// Guards:
//   A  internal parity   — tools↔dispatch table, prompts↔GetPrompt, Pro-sets are real
//   B  surface refs      — no IDE/skill/vscode surface names a tool not in the catalog
//   C  doc tables        — CLAUDE.md table + README index regenerated from the catalog
//   D  golden snapshot   — catalog diffed vs catalog.snapshot.json (reviewed change)
//   E  new-surface guard — no orphan files in a managed dir; no unregistered IDE dir
//
// (preflight.mjs covers the functional net: boot + deps + version. Contract tests
//  cover the MCP↔Supabase wire shape. Both run separately in `validate`.)

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { extractCatalog, MCP_ROOT } from './extract-catalog.mjs';

const REPO_ROOT = join(MCP_ROOT, '..');
const CHECK = process.argv.includes('--check');

const errors = [];
const writes = [];
const fail = (m) => errors.push(m);
const note = (m) => console.log(m);

// ── helpers ──────────────────────────────────────────────────────────────────
function sliceBetween(src, startNeedle, endNeedle) {
  const s = src.indexOf(startNeedle);
  if (s === -1) throw new Error(`could not find "${startNeedle}" in server.js`);
  const e = src.indexOf(endNeedle, s + startNeedle.length);
  if (e === -1) throw new Error(`could not find "${endNeedle}" after "${startNeedle}"`);
  return src.slice(s, e);
}
const casesIn = (slice) => new Set([...slice.matchAll(/case\s+['"]([^'"]+)['"]\s*:/g)].map((m) => m[1]));

function dispatchEntriesIn(serverSrc) {
  const entries = casesIn(
    sliceBetween(serverSrc, 'async function dispatchTool(', 'server.setRequestHandler(CallToolRequestSchema'),
  );
  // The registry is deliberately parsed from its bounded object body rather
  // than importing server.js, which would start the MCP process during a sync
  // check. Keep switch parsing as a compatibility path for older branches.
  const registryStart = serverSrc.indexOf('const TOOL_HANDLERS = createToolRegistry({');
  if (registryStart >= 0) {
    const registryEnd = serverSrc.indexOf('});\n\nasync function dispatchTool', registryStart);
    if (registryEnd >= 0) {
      const body = serverSrc.slice(registryStart, registryEnd);
      for (const match of body.matchAll(/^\s{2}([a-z][a-z0-9_]*):\s/gm)) entries.add(match[1]);
    }
  }
  return entries;
}

// Emit `content` to `relPath`: write it in fix mode, byte-compare it in check mode.
function emit(relPath, content) {
  const abs = join(REPO_ROOT, relPath);
  const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  if (existing === content) return;
  if (CHECK) {
    fail(`${relPath} is out of date — run \`npm run sync\` to regenerate it`);
  } else {
    writeFileSync(abs, content);
    writes.push(relPath);
    note(`  ✎ wrote ${relPath}`);
  }
}

// ── Guard A: internal parity ──────────────────────────────────────────────────
const DISPATCH_ONLY = new Set(['apply_preview']); // intentional unadvertised v1 stub

function guardParity(catalog, serverSrc) {
  const toolNames = new Set(catalog.tools.map((t) => t.name));
  const promptNames = new Set(catalog.prompts.map((p) => p.name));

  const dispatchEntries = dispatchEntriesIn(serverSrc);
  for (const t of toolNames) {
    if (!dispatchEntries.has(t)) fail(`parity: tool "${t}" is advertised but has no dispatch-table entry — calls would fail`);
  }
  for (const entry of dispatchEntries) {
    if (!toolNames.has(entry) && !DISPATCH_ONLY.has(entry)) fail(`parity: dispatch-table entry "${entry}" is not an advertised tool (stale or unlisted)`);
  }

  const promptCases = casesIn(
    sliceBetween(serverSrc, 'server.setRequestHandler(GetPromptRequestSchema', 'async function dispatchTool('),
  );
  for (const p of promptNames) {
    if (!promptCases.has(p)) fail(`parity: prompt "${p}" is advertised but has no GetPrompt case`);
  }
  for (const c of promptCases) {
    if (!promptNames.has(c)) fail(`parity: GetPrompt case "${c}" is not an advertised prompt`);
  }

  for (const t of catalog.proTools) if (!toolNames.has(t)) fail(`parity: PRO_TOOLS member "${t}" is not a real tool`);
  for (const t of catalog.softTools) if (!toolNames.has(t)) fail(`parity: PRO_SOFT_TOOLS member "${t}" is not a real tool`);
}

// ── Guard B: surface references ────────────────────────────────────────────────
// Every IDE command, skill, and the VS Code extension names MCP tools in prose.
// If a surface references a tool the server no longer advertises, an end user who
// runs that command gets a dead tool call. We extract tool references and assert
// each ∈ catalog. Signals (deterministic, verified ~0 false positives over 56
// files): `mcp__pincushion__<name>` tokens, and backticked `<name>` / \`<name>\`
// matching the Pincushion verb_noun naming convention. Escape hatch for a legit
// non-Pincushion token: a line containing `pincushion-sync:ignore <name>`
// (works as an HTML comment in .md or a // comment in .ts).
const VERB_PREFIX = /^(get|add|create|claim|approve|resolve|fix|assign|implement|configure|update|record|register|link|list|remove|upload|search|set|complete|preview)_[a-z0-9_]+$/;
const BACKTICK_TOKEN = /\\?`([a-z][a-z0-9_]*)\\?`/g;
const MCP_TOKEN = /mcp__pincushion__([a-z0-9_]+)/g;
const IGNORE_DIRECTIVE = /pincushion-sync:ignore\s+([a-z0-9_]+)/g;

// The registry of every surface the sync scanner covers. Guard B scans these for
// tool references; Guard E uses the roots to detect a new IDE surface that was
// added without coverage. Keep this the single list of "what we guard".
const list = (rel) => (existsSync(join(REPO_ROOT, rel)) ? readdirSync(join(REPO_ROOT, rel)) : []);
const SURFACES = [
  { root: '.claude/commands', collect: (r) => list(r).filter((f) => f.endsWith('.md')).map((f) => `${r}/${f}`) },
  { root: '.cursor/rules', collect: (r) => list(r).map((d) => `${r}/${d}/RULE.md`) },
  { root: '.cursor-plugin/rules', collect: (r) => list(r).filter((f) => f.endsWith('.mdc')).map((f) => `${r}/${f}`) },
  { root: '.windsurf/workflows', collect: (r) => list(r).filter((f) => f.endsWith('.md')).map((f) => `${r}/${f}`) },
  { root: '.agent/workflows', collect: (r) => list(r).filter((f) => f.endsWith('.md')).map((f) => `${r}/${f}`) },
  { root: '.github/prompts', collect: (r) => list(r).filter((f) => f.endsWith('.md')).map((f) => `${r}/${f}`) },
  { root: '.codex/commands', collect: (r) => list(r).filter((f) => f.endsWith('.md')).map((f) => `${r}/${f}`) },
  { root: '.claude/skills', collect: (r) => list(r).filter((d) => d !== 'integration-javascript_node').map((d) => `${r}/${d}/SKILL.md`) },
  { root: 'pincushion-grok/skills', collect: (r) => list(r).map((d) => `${r}/${d}/SKILL.md`) },
  { root: 'pincushion-agent-plugin/skills', collect: (r) => list(r).map((d) => `${r}/${d}/SKILL.md`) },
  { root: 'pincushion-grok/agents', collect: (r) => list(r).filter((f) => f.endsWith('.md')).map((f) => `${r}/${f}`) },
];
// Surfaces outside a scanned root (the marketplace extension).
const EXTRA_SURFACE_FILES = ['pincushion-vscode/src/extension.ts'];

function surfaceFiles() {
  const out = [];
  for (const s of SURFACES) for (const p of s.collect(s.root)) if (existsSync(join(REPO_ROOT, p))) out.push(p);
  for (const p of EXTRA_SURFACE_FILES) if (existsSync(join(REPO_ROOT, p))) out.push(p);
  return out;
}

function guardSurfaceRefs(catalog) {
  const toolNames = new Set(catalog.tools.map((t) => t.name));
  let scanned = 0;
  for (const rel of surfaceFiles()) {
    const src = readFileSync(join(REPO_ROOT, rel), 'utf8');
    scanned++;
    const ignore = new Set([...src.matchAll(IGNORE_DIRECTIVE)].map((m) => m[1]));
    const refs = new Set();
    for (const m of src.matchAll(BACKTICK_TOKEN)) if (VERB_PREFIX.test(m[1])) refs.add(m[1]);
    for (const m of src.matchAll(MCP_TOKEN)) refs.add(m[1]);
    for (const r of refs) {
      if (ignore.has(r) || toolNames.has(r)) continue;
      fail(`surface ref: ${rel} references tool "${r}" not in the MCP catalog (renamed/removed?). If intentional/non-Pincushion, add a \`pincushion-sync:ignore ${r}\` comment.`);
    }
  }
  note(`  (scanned ${scanned} surface files)`);
}

// Deployment reconciliation is safety-critical orchestration, not just a
// tool-name reference. Every supported IDE command must carry the same compact
// contract marker and mention the receipt checkpoints that prevent snapshot and
// Crit flows from racing each other. This deliberately checks semantics at a
// bounded token level rather than attempting brittle natural-language equality.
const DEPLOYMENT_MARKER = 'pincushion-deployment-reconciliation:v2';
const DEPLOYMENT_COMMAND_SURFACES = [
  '.claude/commands/critique-latest-deploy.md',
  '.claude/commands/snapshot-latest-deploy.md',
  '.cursor/rules/critique-latest-deploy/RULE.md',
  '.cursor-plugin/rules/critique-latest-deploy.mdc',
  '.windsurf/workflows/critique-latest-deploy.md',
  '.agent/workflows/critique-latest-deploy.md',
  '.github/prompts/critique-latest-deploy.prompt.md',
  '.codex/commands/critique-latest-deploy.md',
  '.codex/commands/snapshot-latest-deploy.md',
];
const DEPLOYMENT_REQUIRED_TOKENS = [
  'get_pending_critiques',
  'get_pending_deployment_frame_refreshes',
  'start_deployment_capture_run',
  'complete_deployment_capture_run',
  'register_deployment_discovered_pages',
  'upload_page_snapshot',
  'record_deployment_page_result',
  'complete_critique_request',
  'capture-snapshot.mjs --reconcile',
  '--capture-run-id',
  'captureRunId',
  'captureProof',
  'never in shell argv',
  'historical pre-frame',
  'newly staged desktop/mobile',
  'frame_refresh_state',
  'acceptedPendingPages',
  'bootstrap_required',
  'idempotent: true',
  '--require-auth',
  '--proof-selector',
  'private/reserved',
  'auth.mode',
];

function guardDeploymentCommandParity() {
  for (const rel of DEPLOYMENT_COMMAND_SURFACES) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) {
      fail(`deployment command: ${rel} is missing — every supported surface needs the reconciliation checkpoint`);
      continue;
    }
    const src = readFileSync(abs, 'utf8');
    if (!src.includes(DEPLOYMENT_MARKER)) fail(`deployment command: ${rel} is missing ${DEPLOYMENT_MARKER}`);
    for (const token of DEPLOYMENT_REQUIRED_TOKENS) {
      if (!src.includes(token)) fail(`deployment command: ${rel} is missing required reconciliation token "${token}"`);
    }
    if (/freshRenderReceipts|renderReceipts|render_receipts/.test(src)) {
      fail(`deployment command: ${rel} still describes removed metadata-only unchanged receipts`);
    }
    const registrationIndex = src.indexOf('register_deployment_discovered_pages');
    const uploadIndex = src.indexOf('upload_page_snapshot');
    const resultIndex = src.indexOf('record_deployment_page_result');
    if (registrationIndex < 0 || registrationIndex > uploadIndex || registrationIndex > resultIndex) {
      fail(`deployment command: ${rel} must register discovered URLs before any snapshot upload or terminal page result`);
    }
    if (!/do not\s+(?:call\s+|invoke\s+)?`?complete_critique_request`?.{0,180}(?:before|until)/is.test(src)) {
      fail(`deployment command: ${rel} must explicitly prevent critique completion before reconciliation/crit receipts`);
    }
  }
}

// One-off Crit commands and critic agents must share one headless-first,
// complete-review contract. Keep this as a static guard so a newly edited IDE
// surface cannot quietly fall back to the old single-page/browser-only flow.
const CRITIQUE_SURFACE_FILES = [
  '.codex/commands/critique.md',
  '.codex/agents/pincushion-critic.toml',
  '.claude/commands/critique.md',
  '.claude/agents/pincushion-critic.md',
  '.cursor/rules/critique/RULE.md',
  '.cursor-plugin/rules/critique.mdc',
  '.windsurf/workflows/critique.md',
  '.agent/workflows/critique.md',
  '.github/prompts/critique.prompt.md',
];

const CRITIQUE_REQUIRED_PATTERNS = [
  ['bounded critique capture command', /capture-snapshot\.mjs\s+--critique/],
  ['registered route inventory', /--inventory=/],
  ['project context before capture', /Before capture, read `get_project_context/],
  ['critique capture mode', /critique-v1/],
  ['bounded discovery default', /default discovery (?:(?:is\s+)?max\s+64|max\s+is\s+64)/i],
  ['explicit page-only gate', /--page-only[\s\S]{0,140}explicit|explicit[\s\S]{0,140}--page-only/i],
  ['auth capture option', /--require-auth/],
  ['pin enrichment option', /--pins=/],
  ['critic project context', /get_project_context[\s\S]{0,160}view:\s*["']critic["']/],
  ['critic annotation read', /get_annotations[\s\S]{0,220}view:\s*["']critique["']/],
  ['complete discovered surface', /every discovered (?:page|screen)|review every discovered screen|every page/i],
  ['cross-run finding rank', /top\s+8/i],
  ['per-screen finding cap', /(?:max|at most)\s+3 per screen/i],
  ['shared critique run ID', /critiqueRunId/],
  ['visibility mode', /visibility/],
  ['private member visibility', /project_members/],
  ['run read-back', /re-read[\s\S]{0,120}(?:run ID|run id|exact)/i],
  ['post-pin capture', /(?:after|final)[\s\S]{0,160}--pins=|--pins=[\s\S]{0,160}(?:after|final)/i],
  ['default critique report', /by\s+default[\s\S]{0,180}generate_critique_report/i],
  ['critique report purpose', /purpose:\s*["']critique["']/],
  ['report access mode', /accessMode/],
  ['report coverage', /coverage/],
  ['exact critique pin IDs', /critiquePinIds/],
  ['report screens', /screens/],
  ['capture-only report purpose', /purpose:\s*["']capture["']/],
  ['zero-finding label', /no AI[\s\S]{0,20}findings/i],
  ['headless-first boundary', /headless/i],
  ['headed auth boundary', /snapshot\s+--login/],
  ['incomplete coverage boundary', /incomplete(?: route)? coverage/i],
  ['private-pixel boundary', /private pixels/i],
  ['native report boundary', /native\s+report/i],
  ['published image privacy', /shared images/i],
  ['published pin privacy', /pin records/i],
  ['auth-state privacy', /auth\s+state\s+does\s+not/i],
];

function guardCritiqueSurfaceParity() {
  for (const rel of CRITIQUE_SURFACE_FILES) {
    const abs = join(REPO_ROOT, rel);
    if (!existsSync(abs)) {
      fail(`one-off critique: ${rel} is missing — every shipped surface needs the headless review contract`);
      continue;
    }
    const src = readFileSync(abs, 'utf8');
    for (const [label, pattern] of CRITIQUE_REQUIRED_PATTERNS) {
      if (!pattern.test(src)) fail(`one-off critique: ${rel} is missing ${label}`);
    }
  }
}

// ── Guard C: doc tables (managed blocks) ───────────────────────────────────────
// CLAUDE.md and README list tools in markdown. These drift by hand (CLAUDE.md was
// missing 12 real tools). We regenerate ONLY the fenced region from the catalog,
// using each tool's own `description` as the source of truth — so a description
// improved in server.js flows to every doc. Hand-written prose around the fence is
// untouched. README keeps its curated `### ` deep-dives; we add a complete index
// on top and assert no `### ` documents a tool that no longer exists.
const cell = (s) => String(s).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
const gatePrefix = (t) => (t.pro ? '**Pro.** ' : t.soft ? '**Pro (Free returns a partial result).** ' : '');

function generateToolTable(catalog) {
  return [
    '<!-- Generated from the MCP server\'s advertised tools — edit descriptions in pincushion-mcp/server.js, then run `npm run sync`. -->',
    '| Tool | What it does |',
    '|---|---|',
    ...catalog.tools.map((t) => `| \`${t.name}\` | ${gatePrefix(t)}${cell(t.description)} |`),
  ].join('\n');
}

function generateToolIndex(catalog) {
  const summary = (d) => { const s = cell(d); return s.length <= 100 ? s : s.slice(0, 97).replace(/\s+\S*$/, '') + '…'; };
  const plan = (t) => (t.pro ? 'Pro' : t.soft ? 'Pro\\*' : '');
  return [
    '<!-- Generated index of every MCP tool — edit descriptions in pincushion-mcp/server.js, then run `npm run sync`. Pro\\* = degrades to a partial result on Free. -->',
    '| Tool | Plan | Summary |',
    '|---|---|---|',
    ...catalog.tools.map((t) => `| \`${t.name}\` | ${plan(t)} | ${summary(t.description)} |`),
  ].join('\n');
}

// Replace the content between `<!-- BEGIN GENERATED:<id> -->` and the matching
// END marker. The markers must already exist (added once, by hand).
function regenerateFence(relPath, fenceId, inner) {
  const abs = join(REPO_ROOT, relPath);
  const src = readFileSync(abs, 'utf8');
  const begin = `<!-- BEGIN GENERATED:${fenceId} -->`;
  const end = `<!-- END GENERATED:${fenceId} -->`;
  const bi = src.indexOf(begin);
  const ei = src.indexOf(end);
  if (bi === -1 || ei === -1 || ei < bi) {
    fail(`${relPath}: missing managed-block fence "${fenceId}" (${begin} … ${end})`);
    return;
  }
  const next = src.slice(0, bi + begin.length) + '\n' + inner + '\n' + src.slice(ei);
  if (next === src) return;
  if (CHECK) {
    fail(`${relPath}: managed block "${fenceId}" is out of date — run \`npm run sync\``);
  } else {
    writeFileSync(abs, next);
    writes.push(relPath);
    note(`  ✎ regenerated ${relPath} [${fenceId}]`);
  }
}

function guardDocTables(catalog) {
  regenerateFence('CLAUDE.md', 'tool-table', generateToolTable(catalog));
  regenerateFence('pincushion-mcp/README.md', 'tool-index', generateToolIndex(catalog));
  // Stale-section guard: a `### `name`` deep-dive for a tool that's gone.
  const toolNames = new Set(catalog.tools.map((t) => t.name));
  const readme = readFileSync(join(MCP_ROOT, 'README.md'), 'utf8');
  for (const m of readme.matchAll(/^###\s+`([a-z][a-z0-9_]*)`/gm)) {
    if (VERB_PREFIX.test(m[1]) && !toolNames.has(m[1])) {
      fail(`pincushion-mcp/README.md: \`### ${m[1]}\` documents a tool not in the catalog (stale section — remove or rename)`);
    }
  }
}

// ── Guard D: golden snapshot ──────────────────────────────────────────────────
const SNAPSHOT_REL = 'pincushion-mcp/catalog.snapshot.json';

function guardSnapshot(catalog) {
  const serialized = JSON.stringify(catalog, null, 2) + '\n';
  const abs = join(REPO_ROOT, SNAPSHOT_REL);
  const existing = existsSync(abs) ? readFileSync(abs, 'utf8') : null;
  if (existing === serialized) return;

  if (CHECK) {
    fail(`snapshot: ${SNAPSHOT_REL} is out of date — the catalog changed`);
    if (existing) {
      try {
        const prev = JSON.parse(existing);
        const names = (arr, k = 'name') => new Set(arr.map((x) => x[k]));
        const diff = (label, was, now, k) => {
          const a = names(was, k); const b = names(now, k);
          const added = [...b].filter((x) => !a.has(x));
          const removed = [...a].filter((x) => !b.has(x));
          if (added.length) fail(`  + ${label} added: ${added.join(', ')}`);
          if (removed.length) fail(`  - ${label} removed: ${removed.join(', ')}`);
        };
        diff('tools', prev.tools, catalog.tools);
        diff('prompts', prev.prompts, catalog.prompts);
        diff('resources', prev.resources, catalog.resources, 'uri');
      } catch { /* unparseable previous snapshot — the byte mismatch above is enough */ }
    }
    fail('  → review the change, then run `npm run sync` to accept it (this is how an intentional tool add/rename/remove gets recorded)');
  } else {
    writeFileSync(abs, serialized);
    writes.push(SNAPSHOT_REL);
    note(`  ✎ wrote ${SNAPSHOT_REL}`);
  }
}

// ── Guard E: new-surface guard ─────────────────────────────────────────────────
// Adding Pincushion commands for a brand-new IDE creates a new root the scanner
// doesn't know about — silent drift. We watch the common AI-IDE command/rule
// conventions and fail if one appears on disk but isn't a covered surface, so the
// author has to register it. (New files inside an already-covered root are picked
// up automatically by SURFACES.) Extend WATCH_CANDIDATES as new IDEs emerge.
const WATCH_CANDIDATES = [
  '.zed/commands', '.continue/prompts', '.continue/commands', '.roo/rules',
  '.clinerules', '.gemini/commands', '.opencode/command', '.kilocode/rules',
  '.amazonq/prompts', '.junie/commands', '.codex/prompts', '.aider/commands',
];

function guardNewSurface() {
  const covered = new Set(SURFACES.map((s) => s.root));
  for (const root of covered) {
    if (!existsSync(join(REPO_ROOT, root))) note(`  (note: covered surface "${root}" not found — deleted, or did the IDE rename its convention?)`);
  }
  for (const cand of WATCH_CANDIDATES) {
    if (covered.has(cand)) continue;
    if (existsSync(join(REPO_ROOT, cand))) {
      fail(`new surface: "${cand}" exists but isn't covered by the sync scanner. Register it in SURFACES (pincushion-mcp/scripts/sync-surfaces.mjs) so its tool references are guarded.`);
    }
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
async function main() {
  const catalog = await extractCatalog();
  const serverSrc = readFileSync(join(MCP_ROOT, 'server.js'), 'utf8');
  note(`Catalog: ${catalog.tools.length} tools, ${catalog.prompts.length} prompts, ${catalog.resources.length} resources (v${catalog.version}) — mode: ${CHECK ? 'check' : 'fix'}`);

  note('A. Internal parity');
  guardParity(catalog, serverSrc);
  note('B. Surface references');
  guardSurfaceRefs(catalog);
  note('B2. Deployment command semantics');
  guardDeploymentCommandParity();
  note('B3. One-off critique surface semantics');
  guardCritiqueSurfaceParity();
  note('C. Doc tables');
  guardDocTables(catalog);
  note('D. Golden snapshot');
  guardSnapshot(catalog);
  note('E. New-surface guard');
  guardNewSurface();

  if (errors.length) {
    console.error(`\nSYNC ${CHECK ? 'CHECK FAILED' : 'FAILED'} — ${errors.length} issue(s):`);
    for (const e of errors) console.error(`  ✗ ${e}`);
    if (CHECK) console.error('\nRun `npm run sync` to regenerate managed files, then commit, or fix the surfaces above.');
    process.exit(1);
  }
  note(CHECK ? '\nSYNC CHECK PASSED ✓' : `\nSYNC OK ✓${writes.length ? ` — wrote ${writes.length}: ${writes.join(', ')}` : ' — nothing to change'}`);
}

main().catch((e) => { console.error('[sync] crashed:', e?.stack || e?.message || String(e)); process.exit(1); });
