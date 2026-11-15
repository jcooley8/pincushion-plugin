// One plugin folder installs in Claude Code, Codex and Cursor. Checks that the
// three marketplaces point at it, its manifests agree on name and version with
// the vendored server, the Cursor manifests follow Cursor's plugin schema
// fields, and the setup and doctor skills only name tools the server exposes.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, root), 'utf8');
const json = (path) => JSON.parse(read(path));
const plugin = 'plugins/pincushion/';
const version = json(`${plugin}server/package.json`).version;

test('all three marketplaces install plugins/pincushion', () => {
  const claude = json('.claude-plugin/marketplace.json');
  const codex = json('.agents/plugins/marketplace.json');
  const cursor = json('.cursor-plugin/marketplace.json');
  assert.equal(claude.plugins[0].source, './plugins/pincushion');
  assert.equal(codex.plugins[0].source.path, './plugins/pincushion');
  assert.equal(cursor.plugins[0].source, 'plugins/pincushion');
  for (const m of [claude, codex, cursor]) assert.equal(m.plugins[0].name, 'pincushion');
});

test('plugin manifests share the name and the vendored server version', () => {
  for (const host of ['.claude-plugin', '.codex-plugin', '.cursor-plugin']) {
    const m = json(`${plugin}${host}/plugin.json`);
    assert.equal(m.name, 'pincushion', host);
    assert.equal(m.version, version, host);
  }
  assert.equal(json(`${plugin}package.json`).version, version);
  assert.equal(json('server.json').version, version);
  assert.ok(read(`${plugin}.codex.mcp.json`).includes(`pincushion-mcp@${version}`));
  assert.ok(read(`${plugin}.cursor.mcp.json`).includes(`pincushion-mcp@${version}`));
});

test('Cursor manifests use only schema fields and relative paths that exist', () => {
  const allowed = new Set(['name', 'displayName', 'description', 'version', 'minClientVersions', 'author',
    'publisher', 'homepage', 'repository', 'license', 'logo', 'keywords', 'category', 'tags', 'commands',
    'agents', 'skills', 'rules', 'hooks', 'variables', 'mcpServers']);
  const m = json(`${plugin}.cursor-plugin/plugin.json`);
  for (const key of Object.keys(m)) assert.ok(allowed.has(key), `unexpected Cursor plugin field ${key}`);
  assert.deepEqual(Object.keys(m.author), ['name']);
  for (const key of ['skills', 'rules', 'mcpServers', 'logo']) {
    assert.equal(m[key].includes('..'), false);
    assert.ok(existsSync(new URL(`${plugin}${m[key]}`, root)), `${key} path missing`);
  }
  const market = json('.cursor-plugin/marketplace.json');
  for (const key of Object.keys(market)) assert.ok(['name', 'owner', 'metadata', 'plugins'].includes(key));
  for (const entry of market.plugins) {
    for (const key of Object.keys(entry)) assert.ok(['name', 'source', 'description', 'minClientVersions'].includes(key));
  }
});

test('every skill has frontmatter whose name matches its folder', () => {
  for (const dir of readdirSync(new URL(`${plugin}skills/`, root))) {
    const skill = read(`${plugin}skills/${dir}/SKILL.md`);
    assert.match(skill, new RegExp(`^---\\nname: ${dir}\\ndescription: .+\\n`), dir);
  }
});

test('setup and doctor only name tools the vendored server exposes', () => {
  const tools = new Set(json(`${plugin}server/catalog.snapshot.json`).tools.map((t) => t.name));
  const named = {
    setup: ['get_project_identity_diagnostic', 'sign_in', 'propose_project_setup', 'confirm_project_setup',
      'get_project_context', 'list_setup_pins', 'start_first_crit', 'get_first_crit_status', 'approve_pin'],
    doctor: ['get_project_identity_diagnostic', 'get_project_context', 'list_setup_pins'],
  };
  for (const [skill, names] of Object.entries(named)) {
    const text = read(`${plugin}skills/${skill}/SKILL.md`);
    for (const name of names) {
      assert.ok(tools.has(name), `${name} is not a server tool`);
      assert.ok(text.includes(`\`${name}\``), `${skill} should name ${name}`);
    }
    const mentioned = [...text.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((m) => m[1]);
    // Result statuses the server returns, not tools.
    const statuses = new Set(['signed_in', 'sign_in_required', 'registration_not_acknowledged']);
    for (const name of mentioned) assert.ok(tools.has(name) || statuses.has(name), `${skill} names unknown tool ${name}`);
  }
  const doctor = read(`${plugin}skills/doctor/SKILL.md`);
  for (const mutating of ['sign_in', 'confirm_project_setup', 'start_first_crit', 'approve_pin', 'claim_pin']) {
    assert.equal(doctor.includes(`\`${mutating}\``), false, `doctor must stay read-only: ${mutating}`);
  }
});
