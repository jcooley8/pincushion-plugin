// Checks the public install surfaces: no placeholder Cursor license key,
// the Cursor plugin repository is the public repo, /critique is a Claude
// skill that names the crit MCP tools, and llms-install.md has the Cline
// stdio entry plus sign-in and pre-sign-in behavior.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');

test('Cursor MCP config starts with no license key', () => {
  const mcp = JSON.parse(read('../.cursor-plugin/mcp/pincushion.json'));
  const plugin = JSON.parse(read('../.cursor-plugin/plugin.json'));
  const env = mcp.env || {};
  assert.equal(env.PINCUSHION_LICENSE_KEY, undefined);
  assert.equal(JSON.stringify(mcp).includes('your_license_key'), false);
  assert.equal(env.PINCUSHION_REF, 'cursor-plugin');
  assert.equal(mcp.command, 'npx');
  assert.deepEqual(mcp.args, ['pincushion-mcp', '--project-dir', '${workspaceFolder}']);
  assert.equal(plugin.repository, 'https://github.com/jcooley8/pincushion-plugin');
  assert.equal(plugin.repository.includes('jcooley8/pincushion"') || plugin.repository.endsWith('/pincushion'), false);
});

test('Claude plugin ships a /critique skill that uses the crit tools', () => {
  const skill = read('../plugins/pincushion/skills/critique/SKILL.md');
  assert.match(skill, /^---\nname: critique\n/);
  assert.match(skill, /disable-model-invocation: true/);
  for (const tool of [
    'get_project_context',
    'get_project_write_authorization',
    'get_annotations',
    'create_critique_pin',
    'generate_critique_report',
  ]) {
    assert.match(skill, new RegExp(tool));
  }
  assert.match(skill, /view: "critic"/);
  assert.match(skill, /view: "critique"/);
  assert.match(skill, /at most 3 per screen/);
  assert.equal(read('../plugins/pincushion/README.md').includes('`critique`'), true);
  const manifest = JSON.parse(read('../plugins/pincushion/.claude-plugin/plugin.json'));
  assert.match(manifest.description, /\/critique/);
});

test('README quick start names each client and llms-install.md is the Cline contract', () => {
  const readme = read('../README.md');
  for (const heading of ['### Claude Code', '### Cursor', '### VS Code', '### Cline', '### Any other MCP client']) {
    assert.match(readme, new RegExp(heading));
  }
  assert.match(readme, /claude plugin marketplace add jcooley8\/pincushion-plugin/);
  assert.match(readme, /code --install-extension pincushion\.pincushion-feedback/);
  assert.equal(readme.includes('your_license_key'), false);

  const install = read('../llms-install.md');
  assert.match(install, /cline_mcp_settings\.json/);
  assert.match(install, /"command": "npx"/);
  assert.match(install, /\["-y", "pincushion-mcp@latest"\]/);
  assert.match(install, /npx -y pincushion-mcp setup/);
  assert.match(install, /get_feedback_summary/);
  assert.match(install, /What works before sign-in/i);
  assert.equal(install.includes('PINCUSHION_LICENSE_KEY'), true);
  assert.equal(install.includes('your_license_key'), false);
});
