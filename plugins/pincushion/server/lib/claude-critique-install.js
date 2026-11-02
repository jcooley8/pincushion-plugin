import { installedSetupServerEntry } from './setup-core.js';
import { lstatSync, realpathSync, readFileSync, readdirSync, mkdirSync, mkdtempSync, writeFileSync, linkSync, rmSync, openSync, closeSync, fstatSync, readSync, constants } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { homedir } from 'node:os';

const NAME = 'pincushion-critique';
const template = new URL('../agent-assets/claude/pincushion-critique/SKILL.md', import.meta.url);
function exists(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
export function safeDirectories(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (exists(current)) {
      const stat = lstatSync(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    }
    if (dirname(current) === current) return true;
  }
}
export function objectFile(path) {
  if (!exists(path)) return {};
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('unsafe_config');
  const data = JSON.parse(readFileSync(path, 'utf8'));
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('invalid_config');
  return data;
}
function declaredSkillName(path) {
  if (lstatSync(path).size > 64 * 1024) throw new Error('unsupported_skill_name_precedence');
  const text = readFileSync(path, 'utf8');
  if (text.startsWith('\uFEFF') || (!text.startsWith('---') && /^\s*---/.test(text))) {
    throw new Error('unsupported_skill_name_precedence');
  }
  if (!text.startsWith('---')) return null; // No frontmatter: directory name is the command identity.
  const block = text.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?$/m);
  if (!block) throw new Error('unsupported_skill_name_precedence');
  const names = [];
  for (const line of block[1].split(/\r?\n/)) {
    if (!line.trim() || /^[ \t]*#/.test(line)) continue;
    const entry = line.match(/^(?:([A-Za-z0-9_-]+)|"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)')[ \t]*:[ \t]*(.*)$/);
    if (!entry) throw new Error('unsupported_skill_name_precedence');
    const key = entry[1] || entry[2] || entry[3];
    const value = entry[4].trim();
    if (/^[&*!>|\[{]/.test(value)) throw new Error('unsupported_skill_name_precedence');
    if (key.toLowerCase() === 'name') names.push(value);
  }
  if (!names.length) return null;
  if (names.length !== 1) throw new Error('unsupported_skill_name_precedence');
  const value = names[0];
  // Ordinary scalar names with optional inline comments are enough here.
  // Folded values, aliases/tags, escapes and duplicate/indented keys need an
  // editor-side precedence check rather than a speculative YAML interpretation.
  const match = value.match(/^(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))(?:[ \t]+#.*)?$/);
  if (!match) throw new Error('unsupported_skill_name_precedence');
  return match[1] || match[2] || match[3];
}
function inheritedSkillName(path) {
  const actual=realpathSync(path);
  if(basename(actual)!=='SKILL.md') throw new Error('skill_scope_unavailable');
  const fd=openSync(actual,constants.O_RDONLY|constants.O_NOFOLLOW);
  let text;
  try {
    const stat=fstatSync(fd);if(!stat.isFile()||stat.size>65536)throw new Error('skill_scope_unavailable');
    const bytes=Buffer.alloc(65537);const count=readSync(fd,bytes,0,bytes.length,0);if(count>65536)throw new Error('skill_scope_unavailable');text=bytes.subarray(0,count).toString('utf8');
  } finally {closeSync(fd);}
  if(text.startsWith('\uFEFF') || (!text.startsWith('---') && /^\s*---/.test(text)))throw new Error('unsupported_skill_name_precedence');
  if(!text.startsWith('---'))return null;
  const block=text.match(/^---[ \t]*\r?\n([\s\S]*?)^---[ \t]*\r?$/m);if(!block)throw new Error('unsupported_skill_name_precedence');
  const names=[];
  for(const line of block[1].split(/\r?\n/)) {
    if(!line.trim()||/^[ \t]/.test(line)||line.startsWith('#'))continue;
    const entry=line.match(/^(?:([A-Za-z0-9_-]+)|"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)')[ \t]*:[ \t]*(.*)$/);
    if(!entry)throw new Error('unsupported_skill_name_precedence');
    if((entry[1]||entry[2]||entry[3]).toLowerCase()==='name')names.push(entry[4].trim());
  }
  if(names.length!==1)throw new Error('unsupported_skill_name_precedence');
  const name=names[0].match(/^(?:"([A-Za-z0-9_-]+)"|'([A-Za-z0-9_-]+)'|([A-Za-z0-9_-]+))(?:[ \t]+#.*)?$/);
  if(!name)throw new Error('unsupported_skill_name_precedence');return name[1]||name[2]||name[3];
}
// Read only inherited identity metadata. Codex supports directory aliases;
// a manifest defines a skill boundary, whose assets are not extra skills.
export function inheritedSkillCollision(base) {
  if(exists(join(base,'commands',`${NAME}.md`)))return true;
  const root=join(base,'skills');if(!exists(root))return false;
  const pending=[[root,[]]];const seen=new Set();let count=0;
  while(pending.length) {
    const [logical,parents]=pending.pop();if(++count>512||parents.length>8)throw new Error('skill_scope_unavailable');
    const directory=realpathSync(logical);
    if(!lstatSync(directory).isDirectory()||parents.includes(directory))throw new Error('skill_scope_unavailable');
    if(basename(logical).toLowerCase()===NAME||basename(directory).toLowerCase()===NAME)return true;
    if(seen.has(directory))continue;seen.add(directory);
    const manifest=join(directory,'SKILL.md');
    if(exists(manifest)) {
      if(basename(dirname(realpathSync(manifest))).toLowerCase()===NAME||inheritedSkillName(manifest)?.toLowerCase()===NAME)return true;
      continue;
    }
    const entries=readdirSync(directory,{withFileTypes:true});if(entries.length>512)throw new Error('skill_scope_unavailable');
    for(const entry of entries) {
      const path=join(directory,entry.name);
      if(entry.isDirectory())pending.push([path,[...parents,directory]]);
      else if(entry.isSymbolicLink()) {const resolved=realpathSync(path);if(lstatSync(resolved).isDirectory())pending.push([path,[...parents,directory]]);else throw new Error('skill_scope_unavailable');}
    }
  }
  return false;
}
export function skillCollision(base, except) {
  if (exists(join(base, 'commands', `${NAME}.md`))) return true;
  const root = join(base, 'skills');
  if (!exists(root)) return false;
  const pending = [[root, 0]];
  let count = 0;
  while (pending.length) {
    const [directory, depth] = pending.pop();
    if (++count > 512 || depth > 8 || !safeDirectories(directory)) throw new Error('skill_scope_unavailable');
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (path === except) continue;
      if (entry.isSymbolicLink()) throw new Error('skill_scope_unavailable');
      if (entry.isDirectory()) {
        if (entry.name.toLowerCase() === NAME) return true;
        pending.push([path, depth + 1]);
      } else if (entry.name === 'SKILL.md') {
        if (declaredSkillName(path)?.toLowerCase() === NAME) return true;
      }
    }
  }
  return false;
}

// Read local precedence without printing config or credential contents.
export function installClaudeCritique({ cwd, projectId, urls, editor, consent, installedRuntime = false, runtimeBinding } = {}) {
  if (editor !== 'claude' || consent !== true || !/^[A-Za-z0-9_-]{1,128}$/.test(projectId || '') ||
      !Array.isArray(urls) || !urls.length) return { action: 'skipped', reason: 'explicit_project_editor_consent_required' };
  let staging;
  try {
    if (lstatSync(resolve(cwd)).isSymbolicLink()) return { action: 'blocked', reason: 'unsafe_directory' };
    const root = realpathSync(resolve(cwd));
    const skills = join(root, '.claude', 'skills');
    if (!safeDirectories(skills)) return { action: 'blocked', reason: 'unsafe_directory' };
    const home = homedir();
    const global = objectFile(join(home, '.claude.json'));
    const project = objectFile(join(root, '.mcp.json'));
    const local = global.projects?.[resolve(cwd)] || global.projects?.[root];
    if (local?.mcpServers?.pincushion || global.mcpServers?.pincushion) {
      return { action: 'blocked', reason: 'inherited_mcp_entry_requires_editor_verification' };
    }
    const server = project.mcpServers?.pincushion;
    const expected = ['-y', 'pincushion-mcp', '--project-dir', '.', '--project-id', projectId];
    if (JSON.stringify(server) !== JSON.stringify(installedSetupServerEntry(projectId,root,runtimeBinding)) && (installedRuntime || server?.command !== 'npx' || JSON.stringify(server.args) !== JSON.stringify(expected) ||
        Object.keys(server).some((key) => !['command', 'args'].includes(key)))) {
      return { action: 'blocked', reason: 'acknowledged_project_mcp_required' };
    }
    const managed = process.platform === 'darwin' ? '/Library/Application Support/ClaudeCode'
      : process.platform === 'win32' ? 'C:\\Program Files\\ClaudeCode' : '/etc/claude-code';
    for (const base of [join(home, '.claude'), join(managed, '.claude')]) {
      if (skillCollision(base)) {
        return { action: 'blocked', reason: 'inherited_skill_collision' };
      }
    }
    // Parent project skills may win or qualify this name. Preserve them.
    for (let parent = dirname(root); dirname(parent) !== parent; parent = dirname(parent)) {
      if (skillCollision(join(parent, '.claude'))) {
        return { action: 'blocked', reason: 'ancestor_skill_collision' };
      }
    }
    for (const settingsPath of [join(managed, 'managed-mcp.json'), join(managed, 'managed-settings.json'),
      join(home, '.claude', 'settings.json'), join(root, '.claude', 'settings.json'), join(root, '.claude', 'settings.local.json')]) {
      const settings = objectFile(settingsPath);
      if (settings.mcpServers?.pincushion || settings.managedMcpServers?.pincushion ||
          settings.strictPluginOnlyCustomization || settings.disableAllSkills || settings.allowManagedMcpServersOnly) {
        return { action: 'blocked', reason: 'editor_policy_requires_verification' };
      }
    }
    const targetDir = join(skills, NAME);
    const path = join(targetDir, 'SKILL.md');
    const content = readFileSync(template);
    if (skillCollision(join(root, '.claude'), targetDir)) return { action: 'blocked', reason: 'project_skill_collision' };
    if (!safeDirectories(targetDir)) return { action: 'blocked', reason: 'unsafe_directory' };
    if (exists(path)) {
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink() || !readFileSync(path).equals(content)) {
        return { action: 'blocked', reason: 'asset_collision' };
      }
      return { action: 'already', path };
    }
    if (exists(targetDir) && readdirSync(targetDir).length) return { action: 'blocked', reason: 'asset_collision' };
    mkdirSync(targetDir, { recursive: true });
    if (!safeDirectories(targetDir)) return { action: 'blocked', reason: 'unsafe_directory' };
    staging = mkdtempSync(join(skills, '.pincushion-install-'));
    const staged = join(staging, 'SKILL.md');
    writeFileSync(staged, content, { flag: 'wx', mode: 0o600 });
    linkSync(staged, path); // Atomic exclusive creation; never overwrite a raced asset.
    return { action: 'created', path };
  } catch (error) {
    if (error.message === 'unsupported_skill_name_precedence') {
      return { action: 'blocked', reason: 'unsupported_skill_name_precedence_requires_editor_verification' };
    }
    return { action: 'blocked', reason: 'configuration_or_asset_unavailable' };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
  }
}
