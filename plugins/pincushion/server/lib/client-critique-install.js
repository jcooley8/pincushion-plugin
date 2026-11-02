import { installedSetupServerEntry } from './setup-core.js';
import { lstatSync, realpathSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync, linkSync, rmSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseToml } from 'smol-toml';
import { parse as parseJsonc } from 'jsonc-parser';
import { installClaudeCritique, safeDirectories, skillCollision, inheritedSkillCollision, objectFile } from './claude-critique-install.js';

const NAME = 'pincushion-critique';
const template = new URL('../agent-assets/claude/pincushion-critique/SKILL.md', import.meta.url);
const policy = 'policy:\n  allow_implicit_invocation: false\n';
function exists(path) { try { lstatSync(path); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
function config(path) {
  if (!exists(path)) return {};
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || lstatSync(path).size > 1024 * 1024) throw new Error('unsafe_config');
  return parseToml(readFileSync(path, 'utf8'));
}
function vscodeSettings(path) {
  if (!exists(path)) return {};
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('unsafe_config');
  // VS Code settings allow comments and trailing commas; malformed input must
  // still fail closed because the JSONC parser can return a partial object.
  const errors = [];
  const data = parseJsonc(readFileSync(path, 'utf8'), errors, { allowTrailingComma: true });
  if (errors.length || !data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_config');
  return data;
}
function identicalFile(path, body) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const expected = Buffer.from(body); const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== expected.length) return false;
    const bytes = Buffer.alloc(expected.length + 1); let length = 0;
    while (length < bytes.length) { const count = readSync(fd, bytes, length, bytes.length - length, null); if (!count) break; length += count; }
    return length === expected.length && bytes.subarray(0, length).equals(expected);
  } finally { closeSync(fd); }
}
function sameServer(server, projectId, cwd, required, runtimeBinding) {
  if (JSON.stringify(server) === JSON.stringify(installedSetupServerEntry(projectId,cwd,runtimeBinding))) return true;
  if (required) return false;
  return server?.command === 'npx' && JSON.stringify(server.args) === JSON.stringify(['-y', 'pincushion-mcp', '--project-dir', '.', '--project-id', projectId]) && Object.keys(server).every(key => ['command', 'args'].includes(key));
}
function supportedDisabledSkills(skills, target) {
  if (!skills) return true;
  if (typeof skills !== 'object' || Object.keys(skills).some(key => key !== 'config') || !Array.isArray(skills.config) || skills.config.length > 128) return false;
  return skills.config.every(row => row && Object.keys(row).every(key => ['path','enabled'].includes(key)) && row.enabled === false && typeof row.path === 'string' && isAbsolute(row.path) && !/pincushion-critique/i.test(row.path) && resolve(row.path) !== target && resolve(row.path) !== join(target,'SKILL.md') && (!exists(row.path) || (!/pincushion-critique/i.test(realpathSync(row.path)) && realpathSync(row.path) !== target && realpathSync(row.path) !== join(target,'SKILL.md'))));
}
export function inspectCodexInheritedMcp() {
  try {
    const home=homedir(); const user=config(join(process.env.CODEX_HOME || join(home,'.codex'),'config.toml'));
    const managed=config('/etc/codex/config.toml');
    if (managed.mcp_servers?.pincushion) return {blocked:true,reason:'managed_mcp_requires_verification'};
    const entry=user.mcp_servers?.pincushion;
    if (!entry) return {present:false};
    if (typeof entry !== 'object' || Object.keys(entry).some(key=>!['command','args'].includes(key)) || typeof entry.command !== 'string' || !Array.isArray(entry.args) || entry.args.some(value=>typeof value!=='string')) return {blocked:true,reason:'inherited_mcp_policy_requires_verification'};
    return {present:true};
  } catch { return {blocked:true,reason:'editor_policy_requires_verification'}; }
}
export function installClientCritique(options = {}) {
  if (options.editor === 'claude') return installClaudeCritique(options);
  const { cwd, projectId, urls, editor, consent } = options;
  if (!['codex', 'cursor', 'vscode'].includes(editor) || consent !== true || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId || '') || !Array.isArray(urls) || !urls.length) return { action: 'skipped', reason: 'explicit_project_editor_consent_required' };
  let staging;
  try {
    if (lstatSync(resolve(cwd)).isSymbolicLink()) return { action: 'blocked', reason: 'unsafe_directory' };
    const root = realpathSync(resolve(cwd)); const home = homedir();
    const base = join(root, editor === 'codex' ? '.agents' : editor === 'vscode' ? '.github' : '.cursor');
    const target = join(base, 'skills', NAME);
    if (!safeDirectories(target)) return { action: 'blocked', reason: 'unsafe_directory' };
    if (editor === 'codex') {
      const local = config(join(root, '.codex', 'config.toml'));
      if (local.profile || !supportedDisabledSkills(local.skills,target) || local.skillOverrides) return { action: 'blocked', reason: 'editor_policy_requires_verification' };
      if (!sameServer(local.mcp_servers?.pincushion, projectId, root, options.installedRuntime === true, options.runtimeBinding)) return { action: 'blocked', reason: 'acknowledged_project_mcp_required' };
      for (const directory of [process.env.CODEX_HOME || join(home, '.codex'), '/etc/codex']) {
        const inherited = config(join(directory, 'config.toml'));
        if ((inherited.mcp_servers?.pincushion && !(options.inheritedMcpConsent === true && directory !== '/etc/codex' && inspectCodexInheritedMcp().present === true)) || inherited.profile || inherited.skillOverrides || !supportedDisabledSkills(inherited.skills,target)) return { action: 'blocked', reason: 'editor_policy_requires_verification' };
      }
    } else if (editor === 'cursor') {
      if (!sameServer(objectFile(join(root, '.cursor', 'mcp.json')).mcpServers?.pincushion, projectId, root, options.installedRuntime === true, options.runtimeBinding)) return { action: 'blocked', reason: 'acknowledged_project_mcp_required' };
      if (objectFile(join(home, '.cursor', 'mcp.json')).mcpServers?.pincushion) return { action: 'blocked', reason: 'inherited_mcp_entry_requires_editor_verification' };
      // Unknown CLI overrides or skill policies need active-editor verification.
      const settings = objectFile(join(home, '.cursor', 'cli-config.json'));
      if (settings.mcpServers || settings.skillOverrides || settings.disableAllSkills || settings.force || settings.approveMcps) return { action: 'blocked', reason: 'editor_policy_requires_verification' };
    }
    if (editor === 'vscode') {
      if (!sameServer(objectFile(join(root, '.vscode', 'mcp.json')).servers?.pincushion, projectId, root, options.installedRuntime === true, options.runtimeBinding)) return { action:'blocked',reason:'acknowledged_project_mcp_required' };
      const user = process.platform === 'darwin' ? join(home, 'Library', 'Application Support', 'Code', 'User') : join(home, '.config', 'Code', 'User');
      if (process.env.VSCODE_PORTABLE || process.env.XDG_CONFIG_HOME || !safeDirectories(user) || (exists(join(user, 'profiles')) && (!safeDirectories(join(user,'profiles')) || readdirSync(join(user, 'profiles')).length)) || process.env.VSCODE_IPC_HOOK_CLI || process.env.VSCODE_AGENT_FOLDER || process.env.VSCODE_REMOTE_NAME) return {action:'blocked',reason:'editor_context_requires_verification'};
      for (const path of [join(user,'settings.json'),join(root,'.vscode','settings.json')]) {
        const settings = vscodeSettings(path);
        if (settings['chat.agent.enabled'] === false || settings['chat.useAgentSkills'] === false || settings['chat.mcp.access'] === false || settings['chat.agentSkillsLocations'] || settings['chat.tools.global.autoApprove'] === true || ['autoApprove','autopilot'].includes(settings['chat.permissions.default']) || settings['chat.mcp.discovery.enabled'] === true || settings.mcp) return {action:'blocked',reason:'editor_policy_requires_verification'};
      }
      for (const path of [join(user,'mcp.json'),join(home,'.copilot','mcp-config.json'),join(root,'.mcp.json')]) {
        const inherited = objectFile(path);
        if (inherited.servers?.pincushion || inherited.mcpServers?.pincushion) return {action:'blocked',reason:'inherited_mcp_entry_requires_editor_verification'};
      }
      if (readdirSync(root).some(name => name.endsWith('.code-workspace'))) return {action:'blocked',reason:'editor_context_requires_verification'};
    }
    const scopes = editor === 'codex' ? ['.agents'] : editor === 'vscode' ? ['.github','.agents','.claude'] : ['.cursor', '.agents'];
    const globals = editor === 'codex' ? [join(home, '.agents'), process.env.CODEX_HOME || join(home, '.codex'), '/etc/codex'] : editor === 'vscode' ? [join(home,'.copilot'),join(home,'.agents'),join(home,'.claude')] : [join(home, '.cursor'), join(home, '.agents')];
    for (const directory of globals) if (editor === 'codex' ? inheritedSkillCollision(directory) : skillCollision(directory)) return { action: 'blocked', reason: 'inherited_skill_collision' };
    for (let ancestor = dirname(root); dirname(ancestor) !== ancestor; ancestor = dirname(ancestor)) {
      for (const scope of scopes) if (editor === 'codex' ? inheritedSkillCollision(join(ancestor, scope)) : skillCollision(join(ancestor, scope))) return { action: 'blocked', reason: 'ancestor_skill_collision' };
      const inherited = editor === 'codex' ? config(join(ancestor, '.codex', 'config.toml')).mcp_servers?.pincushion : editor === 'vscode' ? objectFile(join(ancestor,'.vscode','mcp.json')).servers?.pincushion || objectFile(join(ancestor,'.mcp.json')).mcpServers?.pincushion : objectFile(join(ancestor, '.cursor', 'mcp.json')).mcpServers?.pincushion;
      if (inherited) {
        let consentedUserEntry = false;
        if (editor === 'codex' && options.inheritedMcpConsent === true && inspectCodexInheritedMcp().present === true) {
          try { consentedUserEntry = realpathSync(join(ancestor,'.codex','config.toml')) === realpathSync(join(process.env.CODEX_HOME || join(home,'.codex'),'config.toml')); } catch { /* unresolved aliases remain blocked */ }
        }
        if (!consentedUserEntry) return { action: 'blocked', reason: 'inherited_mcp_entry_requires_editor_verification' };
      }
    }
    for (const scope of scopes) if (skillCollision(join(root, scope), target)) return { action: 'blocked', reason: 'project_skill_collision' };
    const content = readFileSync(template, 'utf8');
    const files = editor === 'codex' ? { 'SKILL.md': content.replace('disable-model-invocation: true\n', ''), 'agents/openai.yaml': policy } : { 'SKILL.md': content };
    if (exists(target)) {
      for (const entry of readdirSync(target)) if (!['SKILL.md', ...(editor === 'codex' ? ['agents'] : [])].includes(entry)) return { action: 'blocked', reason: 'asset_collision' };
      if (editor === 'codex' && !safeDirectories(join(target, 'agents'))) return { action: 'blocked', reason: 'unsafe_directory' };
      if (editor === 'codex' && exists(join(target, 'agents')) && readdirSync(join(target, 'agents')).some(name => name !== 'openai.yaml')) return { action: 'blocked', reason: 'asset_collision' };
    }
    let identical = true;
    for (const [name, body] of Object.entries(files)) {
      const path = join(target, name);
      if (!safeDirectories(dirname(path))) return { action: 'blocked', reason: 'unsafe_directory' };
      if (exists(path)) {
        if (!identicalFile(path, body)) return { action: 'blocked', reason: 'asset_collision' };
      } else identical = false;
    }
    if (identical) return { action: 'already', path: join(target, 'SKILL.md') };
    mkdirSync(target, { recursive: true });
    staging = mkdtempSync(join(base, 'skills', '.pincushion-install-'));
    // Codex's explicit-only policy exists before its newly visible SKILL.md.
    for (const name of Object.keys(files).sort((a, b) => a === 'SKILL.md' ? 1 : b === 'SKILL.md' ? -1 : 0)) {
      const destination = join(target, name);
      if (exists(destination)) {
        if (!safeDirectories(dirname(destination)) || !identicalFile(destination, files[name])) return { action: 'blocked', reason: 'asset_collision' };
        continue;
      }
      mkdirSync(dirname(destination), { recursive: true });
      if (!safeDirectories(dirname(destination))) return { action: 'blocked', reason: 'unsafe_directory' };
      const staged = join(staging, name.replaceAll('/', '_'));
      writeFileSync(staged, files[name], { flag: 'wx', mode: 0o600 }); linkSync(staged, destination);
    }
    return { action: 'created', path: join(target, 'SKILL.md') };
  } catch (error) {
    return { action: 'blocked', reason: error.message === 'unsupported_skill_name_precedence' ? 'unsupported_skill_name_precedence_requires_editor_verification' : 'configuration_or_asset_unavailable' };
  } finally { if (staging) rmSync(staging, { recursive: true, force: true }); }
}
