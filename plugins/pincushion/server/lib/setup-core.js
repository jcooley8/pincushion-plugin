// setup-core.js — pure helpers for the `pincushion-mcp setup` wizard.
// No interactivity here: detection, config-file writing, and string builders only,
// so the wizard's readline shell stays thin and these stay unit-testable.
// 2026-10-26: buildManualSteps leads with the no-account sample pin, then the
// interactive setup command, so a non-TTY README run is not told to start a critique.
import { existsSync, realpathSync, readFileSync, writeFileSync, mkdirSync, renameSync, unlinkSync, lstatSync, openSync, fstatSync, closeSync, linkSync, constants } from 'fs';
import { join, resolve, dirname, basename } from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { parse as parseToml } from 'smol-toml';
import { readSetupRuntimeBinding } from './setup-runtime.js';

const FRAMEWORK_PORTS = [
  { re: /next(\s+dev|\b)/, port: 3000 },
  { re: /vite\b/, port: 5173 },
  { re: /react-scripts\s+start/, port: 3000 },
  { re: /astro(\s+dev|\b)/, port: 4321 },
  { re: /nuxt\b/, port: 3000 },
  { re: /sveltekit|svelte-kit/, port: 5173 },
  { re: /remix\b/, port: 3000 },
  { re: /ng\s+serve|@angular/, port: 4200 },
];

function readJsonSafe(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function gitRemoteName(cwd) {
  let cfg = '';
  try { cfg = readFileSync(join(cwd, '.git', 'config'), 'utf8'); } catch { return null; }
  const m = cfg.match(/url\s*=\s*.*[/:]([^/\s]+?)(?:\.git)?\s*$/m);
  return m ? m[1] : null;
}

function detectName(cwd) {
  const pkg = readJsonSafe(join(cwd, 'package.json'));
  if (pkg && typeof pkg.name === 'string' && pkg.name.trim()) {
    return pkg.name.replace(/^@[^/]+\//, '').trim(); // strip npm scope
  }
  return gitRemoteName(cwd) || basename(cwd) || 'my-app';
}

function boundedDefaultFile(cwd, name) {
  let fd;
  try {
    if (lstatSync(cwd).isSymbolicLink()) return '';
    fd = openSync(join(cwd, name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    return stat.isFile() && stat.size <= 65536 ? readFileSync(fd, 'utf8') : '';
  } catch { return ''; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function literalPort(value) {
  if (!/^\d{1,5}$/.test(value || '')) return null;
  const port = Number(value); return port >= 1 && port <= 65535 ? port : null;
}
function scriptPort(script) {
  // Suggest only literal ports from a single familiar server command. Never
  // evaluate scripts, shell expansion, delegated commands or quoted prose.
  if (typeof script !== 'string' || script.length > 4096 || /[;&|<>`$\\\r\n]/.test(script)) return null;
  const tokens = []; let token = '', quote = null;
  for (const c of script) {
    if (quote) { if (c === quote) quote = null; else token += c; }
    else if (c === '"' || c === "'") quote = c;
    else if (/\s/.test(c)) { if (token) { tokens.push(token); token = ''; } }
    else token += c;
  }
  if (quote) return null;
  if (token) tokens.push(token);
  let index = tokens[0] === 'cross-env' ? 1 : 0;
  const inline = [];
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index] || '')) {
    if (tokens[index].startsWith('PORT=')) inline.push(tokens[index].slice(5));
    index++;
  }
  const command = tokens.slice(index).join(' ');
  const executable = basename(tokens[index] || '');
  if (!['next','vite','react-scripts','astro','nuxt','sveltekit','svelte-kit','remix','ng'].includes(executable)) return null;
  const framework = FRAMEWORK_PORTS.find(f => f.re.test(command));
  if (!framework || ['build','test'].includes(tokens[index + 1])) return null;
  const suggestion = { port:null, frameworkPort:framework.port };
  const flags = [];
  for (let i = index + 1; i < tokens.length; i++) {
    if (tokens[i] === '--port' || tokens[i] === '-p') flags.push(tokens[++i]);
    else if (tokens[i].startsWith('--port=')) flags.push(tokens[i].slice(7));
    else if (/^(?:--port|-p)/.test(tokens[i])) return suggestion;
  }
  const values = flags.length ? flags : inline;
  if (!values.length || values.some(value => literalPort(value) === null) || new Set(values.map(literalPort)).size !== 1) return suggestion;
  return { ...suggestion, port:literalPort(values[0]) };
}
function detectDevUrl(cwd) {
  let pkg;
  try { pkg = JSON.parse(boundedDefaultFile(cwd, 'package.json')); } catch { pkg = null; }
  const scripts = [pkg?.scripts?.dev, pkg?.scripts?.start].filter(value => typeof value === 'string');
  const suggestions = scripts.map(scriptPort).filter(Boolean);
  for (const suggestion of suggestions) if (suggestion.port !== null) return `localhost:${suggestion.port}`;
  for (const envFile of ['.env.local', '.env']) {
    const matches = [...boundedDefaultFile(cwd, envFile).matchAll(/^\s*(?:export\s+)?PORT\s*=\s*(?:"(\d+)"|'(\d+)'|(\d+))\s*(?:#.*)?$/gm)];
    const values = matches.map(m => literalPort(m[1] || m[2] || m[3]));
    if (values.length && values.every(value => value !== null) && new Set(values).size === 1) return `localhost:${values[0]}`;
  }
  if (suggestions.length) return `localhost:${suggestions[0].frameworkPort}`;
  return 'localhost:3000';
}


function detectEditor(cwd) {
  if (existsSync(join(cwd, '.codex', 'config.toml'))) return 'codex';
  if (existsSync(join(cwd, '.cursor'))) return 'cursor';
  if (existsSync(join(cwd, '.vscode'))) return 'vscode';
  if (existsSync(join(cwd, '.mcp.json'))) return 'claude';
  return null;
}

export function detectProjectDefaults(cwd) {
  const name = detectName(cwd);
  // No live URL is guessed. `<package-name>.vercel.app` (or .netlify.app) is a
  // global namespace, so the guess frequently named someone else's deployment.
  return { name, devUrl: detectDevUrl(cwd), stagingUrl: '', editor: detectEditor(cwd) };
}

// editor -> { file segments relative to cwd, top-level server map key }.
// VS Code uses "servers"; Cursor and Claude-Code project config use "mcpServers".
// JSON-based clients share one writer. Codex has a project-local TOML writer
// below; neither writer touches a user's global MCP configuration.
const EDITOR_CONFIG = {
  cursor: { file: ['.cursor', 'mcp.json'], key: 'mcpServers' },
  vscode: { file: ['.vscode', 'mcp.json'], key: 'servers' },
  claude: { file: ['.mcp.json'], key: 'mcpServers' },
};

export const EDITOR_CHOICES = Object.freeze([
  { id: 'cursor', label: 'Cursor', configuration: 'project_file' },
  { id: 'vscode', label: 'VS Code', configuration: 'project_file' },
  { id: 'claude', label: 'Claude Code', configuration: 'project_file' },
  { id: 'codex', label: 'Codex', configuration: 'project_file' },
  { id: 'manual', label: 'Another MCP client', configuration: 'manual' },
]);

const EDITOR_ALIASES = {
  'claude-code': 'claude',
  'vs-code': 'vscode',
  other: 'manual',
  unsupported: 'manual',
};

export function normalizeEditorChoice(value) {
  const raw = String(value || '').trim().toLowerCase();
  const id = EDITOR_ALIASES[raw] || raw;
  return EDITOR_CHOICES.some((choice) => choice.id === id) ? id : null;
}

export function getEditorChoice(value) {
  const id = normalizeEditorChoice(value);
  return EDITOR_CHOICES.find((choice) => choice.id === id) || null;
}

export function editorManualCommand(editor) {
  return normalizeEditorChoice(editor) === 'codex'
    ? 'codex mcp add pincushion -- npx -y pincushion-mcp --project-dir .'
    : 'npx -y pincushion-mcp --project-dir .';
}

export function isAutoConfigurableEditor(editor) {
  const choice = normalizeEditorChoice(editor);
  return choice === 'codex' || Boolean(EDITOR_CONFIG[choice]);
}

// Portable invocation — never a worktree-specific path (configs that pin a
// worktree path break when the worktree is removed).
const SERVER_ENTRY = { command: 'npx', args: ['-y', 'pincushion-mcp', '--project-dir', '.'] };

export function installedSetupServerEntry(projectId, cwd = process.cwd(), runtimeBinding) {
  let command = process.execPath, serverPath = fileURLToPath(new URL('../server.js', import.meta.url));
  if (runtimeBinding !== undefined) {
    const verified = readSetupRuntimeBinding({ cwd, artifactId: runtimeBinding?.artifactId });
    if (!verified.ready) throw new Error('runtime_missing_or_unverified');
    command = verified.command; serverPath = verified.serverPath;
  }
  return { command, args: [serverPath, '--project-dir', realpathSync(resolve(cwd)), '--project-id', projectId, '--cloud-sync', '--no-auto-register-project'] };
}

function scopedServerEntry(projectId, installedRuntime = false, cwd, runtimeBinding) {
  if (installedRuntime && projectId) return installedSetupServerEntry(projectId, cwd, runtimeBinding);
  return projectId
    ? { ...SERVER_ENTRY, args: [...SERVER_ENTRY.args, '--project-id', projectId] }
    : { ...SERVER_ENTRY };
}

function isGeneratedPincushionEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !Array.isArray(entry.args) ||
      Object.keys(entry).some((key) => !['command', 'args'].includes(key))) return false;
  const args = entry.args;
  if (entry.command === process.execPath && args[0] === fileURLToPath(new URL('../server.js', import.meta.url))) {
    try { return /^[A-Za-z0-9_-]{1,128}$/.test(args[4] || '') && JSON.stringify(entry) === JSON.stringify(installedSetupServerEntry(args[4], args[2])); } catch { return false; }
  }
  if (entry.command === process.execPath && typeof args[0] === 'string') {
    try {
      const artifactId = basename(dirname(args[0]));
      const runtime = readSetupRuntimeBinding({ cwd: args[2], artifactId });
      if (runtime.ready && /^[A-Za-z0-9_-]{1,128}$/.test(args[4] || '') && JSON.stringify(entry) === JSON.stringify(installedSetupServerEntry(args[4], args[2], runtime))) return true;
    } catch { /* Unverified runtime entries are preserved, never overwritten. */ }
  }
  if (entry.command !== SERVER_ENTRY.command) return false;
  const base = args[0] === '-y' ? SERVER_ENTRY.args : SERVER_ENTRY.args.slice(1);
  if (args.length !== base.length && args.length !== base.length + 2) return false;
  if (!base.every((arg, index) => args[index] === arg)) return false;
  return args.length === base.length ||
    (args[base.length] === '--project-id' && /^[A-Za-z0-9_-]{1,128}$/.test(args[base.length + 1]));
}

function isPinnedToProject(entry, projectId) {
  if (!isGeneratedPincushionEntry(entry)) return false;
  const projectIds = entry.args.flatMap((arg, index) => arg === '--project-id' ? [entry.args[index + 1]] : []);
  return projectIds.length === 1 && projectIds[0] === projectId;
}

function codexServerBlock(projectId, installedRuntime, cwd, runtimeBinding) {
  const entry = scopedServerEntry(projectId, installedRuntime, cwd, runtimeBinding);
  return `[mcp_servers.pincushion]\ncommand = ${JSON.stringify(entry.command)}\nargs = ${JSON.stringify(entry.args)}\n`;
}

// Reject unsafe config paths before reading, then publish from an exclusive
// random temporary inode. Never touch predictable pre-existing temp files.
function configOriginal(path) {
  for (let parent = dirname(resolve(path)); ; parent = dirname(parent)) {
    try { const stat = lstatSync(parent); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe_config_path'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(parent) === parent) break;
  }
  let fd;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('unsafe_config_file');
    return { content: readFileSync(fd, 'utf8'), dev: stat.dev, ino: stat.ino };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  finally { if (fd !== undefined) closeSync(fd); }
}
function writeConfigAtomically(path, next, before) {
  const unchanged = () => {
    const current = configOriginal(path);
    return before === null ? current === null : current !== null && current.dev === before.dev && current.ino === before.ino && current.content === before.content;
  };
  let fd, owned;
  const temp = `${path}.${randomBytes(16).toString('hex')}.pincushion-tmp`;
  try {
    if (!unchanged()) throw new Error('config_changed');
    mkdirSync(dirname(path), { recursive: true });
    fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    owned = fstatSync(fd);
    writeFileSync(fd, next); closeSync(fd); fd = undefined;
    if (!unchanged()) throw new Error('config_changed');
    if (before === null) linkSync(temp, path); // Absence remains atomic at publication.
    else renameSync(temp, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (owned) {
      try { const current = lstatSync(temp); if (current.isFile() && current.dev === owned.dev && current.ino === owned.ino) unlinkSync(temp); }
      catch { /* No unowned file is removed on failure. */ }
    }
  }
}

function writeCodexMcpConfig({ cwd, projectId, installedRuntime, runtimeBinding }) {
  const path = join(cwd, '.codex', 'config.toml');
  if (projectId && !/^[A-Za-z0-9_-]{1,128}$/.test(projectId)) {
    return { path, action: 'skipped', editor: 'codex' };
  }
  let before;
  try { before = configOriginal(path); }
  catch { return { path, action: 'skipped', editor: 'codex' }; }
  const existed = before !== null, original = before?.content || '';
  let parsed;
  try { parsed = parseToml(original); }
  catch { return { path, action: 'skipped', editor: 'codex' }; }
  // Only replace a section we generated. Preserve every other Codex setting
  // verbatim, and never overwrite a hand-authored Pincushion server.
  const generated = /^\[mcp_servers\.pincushion\]\r?\ncommand = ("[^\r\n]*")\r?\nargs = (\[[^\r\n]*\])\r?\n?/m;
  const match = original.match(generated);
  let next;
  const existingEntry = parsed?.mcp_servers?.pincushion;
  if (existingEntry !== undefined) {
    if (!match || !isGeneratedPincushionEntry(existingEntry)) {
      return { path, action: 'skipped', editor: 'codex' };
    }
    let args;
    try { args = JSON.parse(match[2]); } catch { args = null; }
    if (!isGeneratedPincushionEntry({ command: existingEntry.command, args }) ||
        JSON.stringify(args) !== JSON.stringify(existingEntry.args)) {
      return { path, action: 'skipped', editor: 'codex' };
    }
    if ((!projectId || isPinnedToProject(existingEntry, projectId)) && (!installedRuntime || JSON.stringify(existingEntry) === JSON.stringify(scopedServerEntry(projectId, true, cwd, runtimeBinding)))) {
      return { path, action: 'already', editor: 'codex' };
    }
    next = original.replace(match[0], codexServerBlock(projectId, installedRuntime, cwd, runtimeBinding));
  } else {
    next = `${original}${original && !original.endsWith('\n') ? '\n' : ''}${original ? '\n' : ''}${codexServerBlock(projectId, installedRuntime, cwd, runtimeBinding)}`;
  }
  // Parsing both versions protects inline tables and quoted/multiline strings:
  // a regex match in user prose must never count as an MCP server.
  try {
    const expected = scopedServerEntry(projectId, installedRuntime, cwd, runtimeBinding);
    const actual = parseToml(next)?.mcp_servers?.pincushion;
    if (!actual || actual.command !== expected.command ||
        JSON.stringify(actual.args) !== JSON.stringify(expected.args)) {
      return { path, action: 'skipped', editor: 'codex' };
    }
  } catch { return { path, action: 'skipped', editor: 'codex' }; }
  try { writeConfigAtomically(path, next, before); }
  catch { return { path, action: 'skipped', editor: 'codex' }; }
  return { path, action: existed ? 'updated' : 'created', editor: 'codex' };
}

// Write the pincushion MCP entry into an explicitly selected editor's
// PROJECT-LOCAL config.
// Supplying projectId is reserved for a completed report claim: it updates only
// Pincushion's own entry so subsequent agent sessions target that exact project.
// Returns { path, action: 'created'|'updated'|'already'|'skipped'|'manual' }. Never throws,
// never touches global ~/.claude.json (clobbered while the app runs), never
// clobbers an unparseable file, and writes atomically (temp + rename).
export function writeEditorMcpConfig({ editor, cwd, projectId: rawProjectId, installedRuntime = false, runtimeBinding }) {
  if (runtimeBinding !== undefined && !readSetupRuntimeBinding({ cwd, artifactId: runtimeBinding?.artifactId }).ready) return { path: '', action: 'skipped', reason: 'runtime_missing_or_unverified', editor };
  const selectedEditor = normalizeEditorChoice(editor);
  const projectId = typeof rawProjectId === 'string' && rawProjectId.trim() ? rawProjectId.trim() : null;
  if (selectedEditor === 'codex') return writeCodexMcpConfig({ cwd, projectId, installedRuntime, runtimeBinding });
  const conf = EDITOR_CONFIG[selectedEditor];
  if (!conf) return { path: '', action: 'manual', editor: selectedEditor };
  const path = join(cwd, ...conf.file);

  // Defense-in-depth: never write the global ~/.claude.json (it gets clobbered
  // while the app runs — a real past incident). Not reachable by today's
  // EDITOR_CONFIG entries (all project-local); this guards a FUTURE entry that
  // mistakenly points at the global config.
  if (path === join(homedir(), '.claude.json')) return { path, action: 'skipped', editor: selectedEditor };

  let before;
  try { before = configOriginal(path); }
  catch { return { path, action: 'skipped', editor: selectedEditor }; }
  const existed = before !== null;
  let data = {};
  if (existed) {
    try { data = JSON.parse(before.content); }
    catch { return { path, action: 'skipped', editor: selectedEditor }; } // don't clobber hand-edited config
  }
  // Preserve every existing field. A malformed root or server map is not an
  // invitation to replace it with an empty object: leave it for the developer
  // and give the caller a manual fallback instead.
  if (!data || typeof data !== 'object' || Array.isArray(data)) return { path, action: 'skipped', editor: selectedEditor };
  if (Object.hasOwn(data, conf.key) && (!data[conf.key] || typeof data[conf.key] !== 'object' || Array.isArray(data[conf.key]))) {
    return { path, action: 'skipped', editor: selectedEditor };
  }
  if (!Object.hasOwn(data, conf.key)) data[conf.key] = {};
  const existingPincushion = data[conf.key].pincushion;
  if (Object.hasOwn(data[conf.key], 'pincushion')) {
    if (!isGeneratedPincushionEntry(existingPincushion)) return { path, action: 'skipped', editor: selectedEditor };
    if ((!projectId || isPinnedToProject(existingPincushion, projectId)) && (!installedRuntime || JSON.stringify(existingPincushion) === JSON.stringify(scopedServerEntry(projectId, true, cwd, runtimeBinding)))) return { path, action: 'already', editor: selectedEditor };
  }

  data[conf.key].pincushion = scopedServerEntry(projectId, installedRuntime, cwd, runtimeBinding);
  try { writeConfigAtomically(path, `${JSON.stringify(data, null, 2)}\n`, before); }
  catch { return { path, action: 'skipped', editor: selectedEditor }; }
  return { path, action: existed ? 'updated' : 'created', editor: selectedEditor };
}

// Reached only past the sign-in gate, so the run is always signed in here.
export function buildWizardSummary({ project, editorResult, extensionStatus = 'not_opened' } = {}) {
  const lines = ['✓ Signed in'];
  lines.push(project && project.name
    ? `✓ Project "${project.name}" registered${project.urls && project.urls.length ? ` (${project.urls.join(', ')})` : ''}`
    : '• Project not registered — run configure_project');
  if (editorResult) {
    const editor = getEditorChoice(editorResult.editor);
    const label = editor?.label || 'editor';
    const m = {
      created: `✓ Config written: ${editorResult.path}`,
      updated: `✓ Config written: ${editorResult.path}`,
      already: `• Config already present: ${editorResult.path}`,
      skipped: `• Config written: no. ${label} was left unchanged.`,
      manual: `• Config written: no. Run \`${editorManualCommand(editorResult.editor)}\` from your project directory.`,
    };
    lines.push(m[editorResult.action] || '• Editor config skipped');
    if (editorResult.action === 'created' || editorResult.action === 'updated') {
      lines.push(`• Restart needed: restart ${label} before it can load the new MCP config.`);
    } else if (editorResult.action === 'already') {
      lines.push(`• Restart needed: restart ${label} if it has not loaded this MCP config yet.`);
    }
  }
  lines.push(extensionStatus === 'opened'
    ? '• Optional extension: its install/connect page was opened; completion is not verified.'
    : '• Optional extension: not opened. It is only needed to place new browser pins.');
  lines.push('• Agent connection: not yet verified.');
  lines.push('• Exact real pin read: pending. After restart, ask your agent to call get_actionable_pins.');
  lines.push('• Review an existing AI or human finding, approve that exact pin, then ask the agent to implement it.');
  return lines.join('\n');
}

// Honest early-exit when the user declines the required sign-in gate. Does NOT
// pretend setup happened; routes them to resume + the account-free demo.
export function buildSignInRequiredExit() {
  return [
    'Setup needs a Pincushion account: your agent reads pins from your projects,',
    'so there is nothing to connect until you sign in.',
    '',
    'When you are ready, resume with:  npx pincushion-mcp setup   (or  npx pincushion-mcp login)',
    'Want to see it work first? Ask your agent to "run the Pincushion quickstart" —',
    'a ~60-second demo that needs no account.',
  ].join('\n');
}

export function buildManualSteps() {
  return [
    'Pincushion setup needs an interactive terminal. To see a pin with no account, add `npx -y pincushion-mcp` to your agent and ask "Show my Pincushion pins", or call start_quickstart_demo.',
    'To connect this code:',
    '  1. In a terminal, run: npx -y pincushion-mcp setup --ref readme',
    '     # sign in, pick a project, and choose Claude Code, Cursor, VS Code, or Codex',
    '     or create a project in the Pincushion app (https://www.pincushion.io/app) and copy its setup command.',
    '     No terminal here? Sign in once with: npx -y pincushion-mcp login',
    '  2. Add the server to your client, from your project directory:',
    '       Claude Code:  claude mcp add --scope project pincushion -- npx -y pincushion-mcp --project-dir .',
    '       Cursor:       add the server to .cursor/mcp.json: {"mcpServers":{"pincushion":{"command":"npx","args":["-y","pincushion-mcp","--project-dir","."]}}}',
    '       Codex:        codex mcp add pincushion -- npx -y pincushion-mcp --project-dir .',
    `       Any other MCP client: ${editorManualCommand('manual')}`,
    '  3. Restart your editor, then ask the agent to call get_actionable_pins.',
  ].join('\n');
}
