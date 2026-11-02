// setup.mjs — `npx pincushion-mcp setup`, the one-command first-run wizard.
// Express flow: press Enter to start; project defaults can be accepted, but the
// developer explicitly selects an editor and approves the real critique.
// A non-interactive shell stops before sign-in and prints the manual steps,
// including the no-account sample pin, instead of hanging or requiring a critique.
import readline from 'readline';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { randomBytes } from 'crypto';
import { fileURLToPath } from 'url';
import { readFileSync, readdirSync, lstatSync, realpathSync } from 'fs';
import {
  detectProjectDefaults, writeEditorMcpConfig, buildManualSteps,
  buildSignInRequiredExit, getEditorChoice, normalizeEditorChoice,
} from './lib/setup-core.js';
import { captureConnectFailed, captureEvent } from './lib/posthog.js';
import { recordDeveloperSetupIntent } from './login.mjs';
import { installClientCritique, inspectCodexInheritedMcp } from './lib/client-critique-install.js';
import { createSetupCritique, readSetupCritique, findSetupClient, launchSetupClient, readExistingSetupGeneration, finishSetupCritique, waitForSetupGeneration, findIncompleteSetupCritiques, acquireSetupContinuation, setupCritiqueServerEntry, inspectSetupCritique } from './lib/setup-critique.js';
import { prepareSetupRuntime, readSetupRuntimeBinding, setupNodeRuntimeSupported } from './lib/setup-runtime.js';
import { checkNodeRuntime } from './lib/node-runtime.js';
import { rememberInstallRef } from './lib/install-ref.js';

// Mirror server.js: respect the PINCUSHION_SYNC_URL override (and its default)
// and strip the /sync-annotations suffix, so a developer pointing at a local
// emulator/staging doesn't have the wizard silently write to prod.
const DEFAULT_SUPABASE_BASE = (process.env.PINCUSHION_SYNC_URL ||
  'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1/sync-annotations')
  .replace(/\/sync-annotations$/, '');

function resolveKey() {
  if (process.env.PINCUSHION_LICENSE_KEY) return process.env.PINCUSHION_LICENSE_KEY.trim();
  const file = process.env.PINCUSHION_LICENSE_FILE || join(homedir(), '.pincushion', 'license-key');
  try { return readFileSync(file, 'utf8').trim() || null; } catch { return null; }
}

function explicitSetupProjectId(argv = [], optionProjectId) {
  const direct = typeof optionProjectId === 'string' && optionProjectId.trim()
    ? optionProjectId.trim()
    : null;
  if (direct) return direct;
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (arg === '--project-id') {
      const next = String(args[index + 1] || '').trim();
      return next || null;
    }
    if (arg.startsWith('--project-id=')) {
      const value = arg.slice('--project-id='.length).trim();
      return value || null;
    }
  }
  return null;
}

// In-package CTA (growth plan §6.1). The ref tags which surface sent the visit:
// `npm` for anything printed by this package, `readme` for the README hero.
export const NPM_CTA_URL = 'https://www.pincushion.io/mcp?ref=npm';
export const README_CTA_URL = 'https://www.pincushion.io/mcp?ref=readme';

export function buildCollaborationCta(prefix = '') {
  return [
    `${prefix}Connect your agent, then invite your client or designer to pin feedback (nothing for them to install).`,
    `${prefix}Setup guide and docs: ${NPM_CTA_URL}`,
  ].join('\n');
}

// A setup `--ref` is an attribution slug (npm, readme, agency-w1, …), never a
// URL, free text or a credential pasted by mistake. Accept only short
// hyphenated words that start with a letter, with no underscores, at most 21
// characters: shorter than any secret this repo issues (the smallest is 16
// random bytes, 22 base64url characters) and unlike prefixed keys
// (`pc_…`, `dhk_…`, `ghp_…`). Values naming a token or secret are dropped too.
const SETUP_REF = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SECRET_WORD_REF = /token|secret|credential|password|bearer/;
export function normalizeSetupRef(value) {
  const ref = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ref.length <= 21 && SETUP_REF.test(ref) && !SECRET_WORD_REF.test(ref) ? ref : null;
}

// `--ref <slug>` / `--ref=<slug>` attributes the run to the surface that sent
// it (e.g. `setup --ref readme`). Invalid values are dropped.
export function explicitSetupRef(argv = [], optionRef) {
  if (optionRef !== undefined) return normalizeSetupRef(optionRef);
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (arg === '--ref') return normalizeSetupRef(String(args[index + 1] || ''));
    if (arg.startsWith('--ref=')) return normalizeSetupRef(arg.slice('--ref='.length));
  }
  return null;
}

// Minimal coreConfig mirroring server.js:1129-1136 — enough for toolConfigureProject.
// syncServerUrl/syncApiKey are the legacy self-hosted sync path (null here = use the
// Supabase cloud path via supabaseBase + licenseKey).
function buildCoreConfig(cwd, licenseKey = resolveKey(), { supabaseBase = DEFAULT_SUPABASE_BASE, fetchImpl } = {}) {
  const config = {
    feedbackDir: join(cwd, '.feedback'),
    annotationsDir: join(cwd, '.feedback', 'annotations'),
    syncServerUrl: null,
    syncApiKey: null,
    supabaseBase,
    // Snapshot the key that passed the setup sign-in gate. This prevents a
    // credential-file race from silently downgrading a signed-in wizard run
    // into core's intentional no-credential local-only mode.
    licenseKey: typeof licenseKey === 'string' && licenseKey.trim() ? licenseKey.trim() : null,
  };
  if (typeof fetchImpl === 'function') config.fetchImpl = fetchImpl;
  return config;
}

function projectsOnlyUrl(supabaseBase) {
  const endpoint = new URL('sync-annotations', `${String(supabaseBase || DEFAULT_SUPABASE_BASE).replace(/\/+$/, '')}/`);
  endpoint.searchParams.set('projects_only', '1');
  return endpoint.toString();
}

function safeProjectListFailure(status) {
  if (status === 401 || status === 403) {
    return `error ${status} — cloud project identity was not authorized`;
  }
  return `error ${Number.isInteger(status) && status > 0 ? status : 'network'} — cloud project identity could not be verified`;
}

function projectIdentityFailure({ name, urls, cloudSync, status = 'identity_unavailable', identityStatus = 'unavailable', candidates = [] }) {
  return {
    success: false,
    projectId: null,
    projectName: name,
    urls: Array.isArray(urls) ? urls : [],
    status,
    cloudSync,
    identity: {
      source: 'cloud_projects_only',
      status: identityStatus,
      candidates: [...new Set((Array.isArray(candidates) ? candidates : [])
        .map((candidate) => String(candidate || '').trim())
        .filter(Boolean))].sort(),
    },
  };
}

function cloudIdentityProjects(registryProjects, remoteProjects) {
  const remoteIds = new Set((Array.isArray(remoteProjects) ? remoteProjects : [])
    .map((project) => String(project?.projectId || project?.id || '').trim())
    .filter(Boolean));
  return Object.fromEntries(Object.entries(registryProjects || {}).filter(([key, project]) => {
    const projectId = String(project?.projectId || key || '').trim();
    return remoteIds.has(projectId);
  }));
}

function cachedProjectId(value) {
  const id = String(value || '').trim();
  return id || null;
}

function cachedRegistryProjectIds(projects) {
  const ids = new Set();
  for (const [key, project] of Object.entries(projects || {})) {
    const id = cachedProjectId(project?.projectId || key);
    if (id) ids.add(id);
  }
  return ids;
}

// Match the server startup evidence scan. These IDs are recovery-only: they
// must appear in the authenticated cloud snapshot before setup can reuse or
// mutate any project, and are never treated as a local authorization grant.
function cachedAnnotationProjectIds(cwd) {
  const ids = new Set();
  const add = (value) => {
    const id = cachedProjectId(value);
    if (id) ids.add(id);
  };
  const feedbackDir = join(cwd, '.feedback');
  try {
    const pins = JSON.parse(readFileSync(join(feedbackDir, 'pins.json'), 'utf8'));
    for (const pin of [...(Array.isArray(pins?.open) ? pins.open : []), ...(Array.isArray(pins?.resolved) ? pins.resolved : [])]) {
      add(pin?.projectId || pin?.project_id);
    }
  } catch { /* missing or malformed cached pins remain non-authoritative */ }
  try {
    for (const file of readdirSync(join(feedbackDir, 'annotations'))) {
      if (!file.endsWith('.json')) continue;
      const page = JSON.parse(readFileSync(join(feedbackDir, 'annotations', file), 'utf8'));
      for (const annotation of Array.isArray(page?.annotations) ? page.annotations : []) {
        add(annotation?.projectId || annotation?.project_id);
      }
    }
  } catch { /* missing or malformed cached annotations remain non-authoritative */ }
  return ids;
}

function setupRecoveryProjectIds({ cwd, projects, projectId } = {}) {
  const ids = cachedRegistryProjectIds(projects);
  for (const id of cachedAnnotationProjectIds(cwd)) ids.add(id);
  const explicitId = cachedProjectId(projectId);
  if (explicitId) ids.add(explicitId);
  return ids;
}

function remoteProjectIds(remoteProjects) {
  return new Set((Array.isArray(remoteProjects) ? remoteProjects : [])
    .map((project) => cachedProjectId(project?.projectId || project?.id))
    .filter(Boolean));
}

/**
 * Reconcile a standalone setup run with the authenticated cloud project list
 * before it can create or re-register an identity. MCP-server startup performs
 * the same projects_only hydration, but `npx pincushion-mcp setup` exits before
 * that long-lived server process is ever started.
 */
export async function hydrateSignedInSetupProjectIdentity({
  cwd,
  licenseKey = resolveKey(),
  supabaseBase = DEFAULT_SUPABASE_BASE,
  fetchImpl = fetch,
  coreModule,
  projectId,
} = {}) {
  const activeLicenseKey = typeof licenseKey === 'string' && licenseKey.trim()
    ? licenseKey.trim()
    : null;
  if (!activeLicenseKey) {
    return projectIdentityFailure({
      cloudSync: 'skipped — not signed in',
      status: 'identity_unavailable',
      identityStatus: 'unavailable',
    });
  }

  const core = coreModule || await import('./lib/core.js');
  const config = buildCoreConfig(cwd, activeLicenseKey, { supabaseBase, fetchImpl });
  let response;
  try {
    response = await fetchImpl(projectsOnlyUrl(supabaseBase), {
      method: 'GET',
      headers: { 'x-license-key': activeLicenseKey },
    });
  } catch {
    return projectIdentityFailure({ cloudSync: safeProjectListFailure(0) });
  }
  if (!response?.ok) {
    return projectIdentityFailure({ cloudSync: safeProjectListFailure(response?.status) });
  }

  const data = await response.json().catch(() => null);
  const licenseId = typeof data?.licenseId === 'string' && data.licenseId.trim()
    ? data.licenseId.trim()
    : null;
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.projects) || !licenseId) {
    return projectIdentityFailure({ cloudSync: 'error: cloud project identity response was malformed' });
  }

  // Snapshot recovery evidence before hydration can merge authenticated rows
  // into the cache. It is deliberately weaker than authorization: a matching
  // ID only permits us to continue with the fresh cloud response; a missing
  // ID or immutable account mismatch stops setup before it can create a
  // replacement project.
  const cachedRegistry = await core.readProjectRegistry(config);
  if (cachedRegistry.malformed) {
    return projectIdentityFailure({ cloudSync: 'error: cloud project identity cache could not be hydrated' });
  }
  const recoveryProjectIds = setupRecoveryProjectIds({
    cwd,
    projects: cachedRegistry.projects,
    projectId,
  });
  if (core.detectProjectAccountMismatch({
    projects: cachedRegistry.projects,
    remoteProjects: data.projects,
    activeLicenseId: licenseId,
  })) {
    return projectIdentityFailure({
      cloudSync: 'synced',
      status: 'account_mismatch',
      identityStatus: 'account_mismatch',
      candidates: [...recoveryProjectIds],
    });
  }

  let hydration;
  try {
    hydration = await core.hydrateProjectRegistry(config, data.projects, { viewerLicenseId: licenseId });
  } catch {
    return projectIdentityFailure({ cloudSync: 'error: cloud project identity cache could not be hydrated' });
  }
  if (!['merged', 'no_remote_projects'].includes(hydration?.reason)) {
    return projectIdentityFailure({ cloudSync: 'error: cloud project identity cache could not be hydrated' });
  }

  const authenticatedProjectIds = remoteProjectIds(data.projects);
  const unavailableEvidenceIds = [...recoveryProjectIds]
    .filter((projectId) => !authenticatedProjectIds.has(projectId))
    .sort();
  if (unavailableEvidenceIds.length) {
    return projectIdentityFailure({
      cloudSync: 'synced',
      status: 'cloud_absent',
      identityStatus: 'cloud_absent',
      candidates: unavailableEvidenceIds,
    });
  }

  const registry = await core.readProjectRegistry(config);
  if (registry.malformed) {
    return projectIdentityFailure({ cloudSync: 'error: local project identity cache is malformed' });
  }
  return {
    success: true,
    cloudSync: 'synced',
    config,
    projects: cloudIdentityProjects(registry.projects, data.projects),
    remoteProjects: data.projects,
    licenseId,
  };
}

const ask = (rl, q) => new Promise((res) => rl.question(q, (a) => res((a || '').trim())));

// The interactive wizard calls core directly, so it bypasses the MCP tool's
// existing `project configured` event. Record only a bounded registration
// outcome here: no project name, URL, server response, or error text is ever
// sent to analytics.
export function setupProjectRegistrationTelemetry(result, urlCount) {
  const cloudSync = typeof result?.cloudSync === 'string' ? result.cloudSync : '';
  const httpFailure = /^error\s+([1-5]\d{2})\b/i.exec(cloudSync);
  let outcome = 'cloud_unknown';
  if (cloudSync === 'synced') outcome = 'cloud_synced';
  else if (httpFailure) outcome = `cloud_http_${httpFailure[1]}`;
  else if (/^error:/i.test(cloudSync)) outcome = 'cloud_transport_error';
  else if (/not signed in/i.test(cloudSync)) outcome = 'cloud_not_signed_in';

  // Before a cloud acknowledgement, core's generated ID/status is only an
  // in-memory candidate. Do not let analytics claim a registered project.
  const projectStatus = cloudSync === 'synced' && ['created', 'existing', 'updated'].includes(result?.status)
    ? result.status
    : 'unknown';
  const numericUrlCount = Number(urlCount);
  return {
    outcome,
    project_status: projectStatus,
    url_count: Number.isFinite(numericUrlCount) && numericUrlCount >= 0
      ? Math.floor(numericUrlCount)
      : 0,
  };
}

/**
 * The setup wizard calls core directly, rather than through server.js's
 * authenticated MCP wrapper. Keep that cloud-registration boundary explicit:
 * a signed-in setup must wait for the project PUT acknowledgement before a
 * generated ID becomes durable. This helper is also intentionally injectable
 * for the outage regression without contacting a provider.
 */
// Read-only list of the projects this account can connect code to (owner,
// editor or developer), so a project created in the Pincushion app can be
// picked by name instead of being re-registered from guessed URLs. Any
// failure returns an empty list and setup falls back to creating a project.
export async function listSignedInSetupProjects({
  licenseKey = resolveKey(),
  supabaseBase = DEFAULT_SUPABASE_BASE,
  fetchImpl = fetch,
} = {}) {
  const key = typeof licenseKey === 'string' ? licenseKey.trim() : '';
  if (!key) return [];
  try {
    const response = await fetchImpl(projectsOnlyUrl(supabaseBase), {
      method: 'GET',
      headers: { 'x-license-key': key },
      signal: AbortSignal.timeout(8000),
    });
    if (!response?.ok) return [];
    const data = await response.json().catch(() => null);
    if (!Array.isArray(data?.projects)) return [];
    return data.projects
      .map((project) => ({
        projectId: String(project?.projectId || project?.id || '').trim(),
        name: String(project?.name || '').replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 80),
        urls: Array.isArray(project?.urls) ? project.urls.filter((url) => typeof url === 'string').slice(0, 8) : [],
        role: String(project?.role || '').trim(),
      }))
      .filter((project) => project.projectId && ['owner', 'editor', 'developer'].includes(project.role));
  } catch {
    return [];
  }
}

export async function configureSignedInSetupProject({
  cwd,
  licenseKey = resolveKey(),
  name,
  urls,
  projectId,
  configureProject,
  fetchImpl = fetch,
  supabaseBase = DEFAULT_SUPABASE_BASE,
  selectProject,
} = {}) {
  const activeLicenseKey = typeof licenseKey === 'string' && licenseKey.trim()
    ? licenseKey.trim()
    : null;
  if (!activeLicenseKey) {
    throw new Error('Pincushion sign-in is no longer available; no project was registered. Run `npx pincushion-mcp login` and retry setup.');
  }
  const identity = await hydrateSignedInSetupProjectIdentity({
    cwd,
    licenseKey: activeLicenseKey,
    supabaseBase,
    fetchImpl,
    projectId,
  });
  if (!identity.success) return { ...identity, projectName: name, urls: Array.isArray(urls) ? urls : [] };

  const core = await import('./lib/core.js');
  const resolved = core.resolveProjectIdentity({
    projects: identity.projects,
    projectId,
    urls,
  });
  const hasExplicitProjectId = String(projectId ?? '').trim().length > 0;
  if (resolved.status === 'ambiguous' && typeof selectProject === 'function') {
    const candidates = resolved.candidates.map(id => ({
      projectId: id,
      name: String(identity.projects[id]?.name || '').replace(/[\x00-\x1f\x7f]/g, '').slice(0, 80),
      urls: core.normalizeProjectUrls(identity.projects[id]?.urls || []).slice(0, 8),
    }));
    const selected = await selectProject(candidates);
    if (candidates.some(candidate => candidate.projectId === selected)) {
      // A selection is not authorization: re-read authenticated identity and
      // exact project admission before the normal configuration write.
      return configureSignedInSetupProject({ cwd, licenseKey: activeLicenseKey, name, urls,
        projectId: selected, configureProject, fetchImpl, supabaseBase });
    }
  }

  if (resolved.status === 'ambiguous' || (hasExplicitProjectId && resolved.status === 'unresolved')) {
    // Multiple canonical URL candidates (or an explicitly requested ID absent
    // from the authoritative account) are not permission to manufacture a
    // replacement ID. Leave the hydrated cache intact and require an explicit
    // project choice on a later setup run.
    return {
      success: false,
      projectId: null,
      projectName: name,
      urls: Array.isArray(urls) ? urls : [],
      status: resolved.status === 'ambiguous' ? 'identity_ambiguous' : 'identity_unresolved',
      cloudSync: 'synced',
      identity: { source: 'cloud_projects_only', ...resolved },
    };
  }
  const configure = typeof configureProject === 'function'
    ? configureProject
    : core.toolConfigureProject;
  const result = await configure(identity.config, {
    name,
    urls,
    deferLocalWriteUntilCloudAck: true,
    ...(resolved.projectId && { projectId: resolved.projectId }),
  });
  return {
    ...result,
    identity: { source: 'cloud_projects_only', ...resolved },
  };
}

// Mint a single-use extension-handoff token so the extension adopts THIS
// wizard's sign-in instead of asking the user to sign in a second time (the
// split-auth-store activation gap, b12). Returns the pincushion.io/handoff
// URL to open, or null (caller falls back to the plain install page — the
// wizard must never fail because the handoff endpoint is unreachable).
export async function mintHandoffUrl({ supabaseBase = DEFAULT_SUPABASE_BASE, licenseKey = resolveKey(), fetchImpl = fetch } = {}) {
  if (!licenseKey) return null;
  try {
    const res = await fetchImpl(`${supabaseBase}/extension-handoff?action=create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-license-key': licenseKey },
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    return (data && data.ok && typeof data.url === 'string' && data.url.startsWith('https://')) ? data.url : null;
  } catch {
    return null;
  }
}

function safeHandoffUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('https://')) return null;
  try {
    const url = new URL(value);
    if (!['pincushion.io', 'www.pincushion.io'].includes(url.hostname)) return null;
    if (url.pathname !== '/handoff' || url.username || url.password || url.search) return null;
    const hash = new URLSearchParams(url.hash.replace(/^#/, ''));
    if (hash.get('v') !== '2' || !/^pc_h2_[A-Za-z0-9_-]{43}$/.test(hash.get('t') || '')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function activationSessionId() {
  return randomBytes(32).toString('base64url');
}

// V2 is attempted only when the cloud registration returned an authoritative
// project ID. Older extension builds remain supported by the legacy helper if
// the v2 endpoint is unavailable during the mixed-version rollout.
export async function mintV2HandoffUrl({
  supabaseBase = DEFAULT_SUPABASE_BASE,
  licenseKey = resolveKey(),
  projectId,
  fetchImpl = fetch,
  activationSession = activationSessionId(),
} = {}) {
  if (!licenseKey || typeof projectId !== 'string' || !projectId.trim()) return null;
  if (typeof activationSession !== 'string' || !/^[A-Za-z0-9_-]{16,128}$/.test(activationSession)) return null;
  try {
    const res = await fetchImpl(`${supabaseBase}/extension-handoff?action=create_v2`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-license-key': licenseKey },
      body: JSON.stringify({
        projectId: projectId.trim(),
        activationSessionId: activationSession,
        purpose: 'extension-connect-v2',
      }),
    });
    if (!res.ok) return null;
    const data = await res.json().catch(() => ({}));
    if (!data || data.ok !== true || data.version !== 2) return null;
    return safeHandoffUrl(data.url);
  } catch {
    return null;
  }
}

export async function mintPreferredHandoffUrl({
  supabaseBase = DEFAULT_SUPABASE_BASE,
  licenseKey = resolveKey(),
  projectId,
  fetchImpl = fetch,
} = {}) {
  const v2 = await mintV2HandoffUrl({ supabaseBase, licenseKey, projectId, fetchImpl });
  return v2 || mintHandoffUrl({ supabaseBase, licenseKey, fetchImpl });
}


function safeSetupEditorConfig(cwd, editor) {
  const locations = {claude:['.mcp.json'],codex:['.codex','config.toml'],cursor:['.cursor','mcp.json'],vscode:['.vscode','mcp.json']};
  const parts = locations[editor]; if(!parts)return true;
  try {
    if(lstatSync(resolve(cwd)).isSymbolicLink())return false;
    let current=realpathSync(resolve(cwd));
    for(let i=0;i<parts.length;i++){
      current=join(current,parts[i]);let stat;
      try{stat=lstatSync(current);}catch(error){if(error.code==='ENOENT')continue;throw error;}
      if(stat.isSymbolicLink() || (i<parts.length-1?!stat.isDirectory():!stat.isFile()||stat.size>1024*1024))return false;
    }
    return true;
  }catch{return false;}
}

async function continueSetupCritique({ cwd, runId, output, licenseKey, client, opts }) {
  const { request } = readSetupCritique(cwd, runId);
  const stateOptions = { request, functionsBase: DEFAULT_SUPABASE_BASE, licenseKey,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) };
  const existing = await readExistingSetupGeneration(stateOptions);
  if (existing.blocked) {
    output.write(`Critique held: ${existing.reason}. No regeneration or reupload. Run ${runId} is preserved.\n`); return 1;
  }
  let ownership; let retainOwnership = false; let guiController; let interrupt; let agentExit;
  try {
    if (!existing.receipt) {
      if (!request.runtimeArtifactId || !readSetupRuntimeBinding({ cwd, artifactId: request.runtimeArtifactId }).ready) {
        output.write(`Incomplete: runtime_missing_or_unverified. Run ${runId} is preserved. Review the original Node/runtime or rerun setup; no client, replacement pins or report generation started.\n`); return 1;
      }
      ownership = acquireSetupContinuation(cwd, runId);
      if (!ownership.acquired) { output.write(`Incomplete: ${ownership.reason}. No concurrent agent started.\n`); return 1; }
      const latest = await readExistingSetupGeneration(stateOptions);
      if (latest.blocked) { output.write(`Critique held: ${latest.reason}. No regeneration.\n`); return 1; }
      if (!latest.receipt) {
        client ||= findSetupClient(request.editor, { cwd });
        if (!client.available) { output.write(`Incomplete: ${client.reason}. No client substitution.\n`); return 1; }
        output.write(`Starting ${request.editor} with normal permissions. Review trust/MCP identity before captures or writes.\n`);
        const launch = await launchSetupClient({ editor: request.editor, executable: client.executable, cwd, request });
        if (!launch.started) { output.write(`Incomplete: ${launch.reason}. Run ${runId} is preserved.\n`); return 1; }
        agentExit = launch;
        if (request.editor === 'vscode') {
          retainOwnership = true;
          if (launch.code !== 0) { output.write('VS Code chat launch failed; no critique completion claimed.\n'); return 1; }
          output.write('VS Code chat opened. Review workspace/MCP trust and Manual permissions. Waiting up to ten minutes for this exact report; launch is not completion.\n');
          guiController = new AbortController(); interrupt = () => guiController.abort();
          process.on('SIGINT', interrupt); process.on('SIGTERM', interrupt);
          const pending = await waitForSetupGeneration(stateOptions, { signal: guiController.signal });
          if (!pending.receipt || guiController.signal.aborted) { output.write(`Incomplete: ${guiController.signal.aborted ? 'agent_wait_interrupted' : pending.reason}. Run preserved; no regeneration.\n`); return 1; }
        }
      }
    }
    if (guiController?.signal.aborted) { output.write('Interrupted. No browser completion claimed.\n'); return 1; }
    const result = await finishSetupCritique({ cwd, runId, functionsBase: DEFAULT_SUPABASE_BASE, licenseKey,
      signal: guiController?.signal, ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    output.write(JSON.stringify(result) + '\n');
    if (!result.verified || !result.browser?.opened) {
      if (result.reason === 'generation_absent' && agentExit && (agentExit.code !== 0 || agentExit.signal)) {
        const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
        const runtime = setupCritiqueServerEntry(request);
        const resume = `${quote(runtime.command)} ${quote(runtime.args[0])} setup --resume-crit ${quote(runId)}`;
        output.write(`Agent exited ${agentExit.signal ? `with signal ${agentExit.signal}` : `with code ${agentExit.code}`}; no saved critique was found. Check the selected agent's model/access settings. Run ${runId} is preserved. From this same workspace, resume with: ${resume}\n`);
      } else output.write(`Incomplete. Run ${runId} is preserved; repeat setup to reconcile it.\n`);
      return 1;
    }
    output.write(`${result.outcome}; browser launch accepted. ${result.coverageComplete ? '' : 'Coverage is incomplete. '}No fixed number of findings is promised.\n`);
    retainOwnership = false; return 0;
  } finally {
    if (interrupt) { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
    ownership?.release?.({ retain: retainOwnership });
  }
}

export async function runSetup(argv = [], opts = {}) {
  if (!setupNodeRuntimeSupported()) { (opts.output || process.stdout).write(`Incomplete: runtime_node_unsupported. No sign-in, project/configuration or critique started.\n\n${checkNodeRuntime({ command: 'setup' }).message}`); return 1; }
  const cwd = opts.cwd || process.cwd();
  const input = opts.input || process.stdin;
  const output = opts.output || process.stdout;
  const requestedProjectId = explicitSetupProjectId(argv, opts.projectId);
  const setupRef = explicitSetupRef(argv, opts.ref);
  // The first ref this machine saw is reported on the account by the MCP server
  // on its next connect (lib/install-ref.js). Best effort, never overwrites.
  if (setupRef) (opts.rememberInstallRef || rememberInstallRef)(setupRef);
  const inspectIndex = argv.indexOf('--inspect-crit');
  if (inspectIndex >= 0) {
    const result = await inspectSetupCritique({ cwd, runId: argv[inspectIndex + 1], functionsBase: DEFAULT_SUPABASE_BASE, licenseKey: (opts.resolveKey || resolveKey)() });
    output.write(JSON.stringify(result) + '\n');
    return result.ready ? 0 : 1;
  }
  const finishIndex = argv.indexOf('--finish-crit');
  if (finishIndex >= 0) {
    const result = await finishSetupCritique({ cwd, runId: argv[finishIndex + 1], functionsBase: DEFAULT_SUPABASE_BASE,
      licenseKey: (opts.resolveKey || resolveKey)(), ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}) });
    output.write(JSON.stringify(result) + '\n');
    return result.verified && result.browser?.opened ? 0 : 1;
  }
  const resumeIndex = argv.indexOf('--resume-crit');
  if (resumeIndex >= 0) {
    if (!input.isTTY) { output.write('Interactive resume required; no agent or report generation started.\n'); return 1; }
    let state;
    try { state = readSetupCritique(cwd, argv[resumeIndex + 1]); }
    catch { output.write('Resume request is unavailable; no agent started.\n'); return 1; }
    const resumeRl = typeof opts.ask === 'function' ? null : readline.createInterface({ input, output });
    const answer = typeof opts.ask === 'function' ? await opts.ask(`Resume ${state.request.editor} for the same project, URL, cost and access choices? [y/N] `)
      : await ask(resumeRl, `Resume ${state.request.editor} for the same project, URL, cost and access choices? [y/N] `);
    resumeRl?.close();
    if (!/^(y|yes)$/i.test(answer || '')) { output.write('Resume declined; no report completion claimed.\n'); return 1; }
    const existing = await readExistingSetupGeneration({ request: state.request, functionsBase: DEFAULT_SUPABASE_BASE, licenseKey: (opts.resolveKey || resolveKey)(), ...(opts.fetchImpl ? {fetchImpl:opts.fetchImpl} : {}) });
    if (existing.blocked) { output.write(`Resume held: ${existing.reason}. No regeneration or reupload.\n`); return 1; }
    if (existing.receipt) return continueSetupCritique({ cwd, runId: state.request.runId, output, licenseKey: (opts.resolveKey || resolveKey)(), opts });
    const runtimeBinding = readSetupRuntimeBinding({ cwd, artifactId: state.request.runtimeArtifactId });
    if (!runtimeBinding.ready) { output.write('Resume blocked: runtime_missing_or_unverified. Original run preserved; review Node/runtime or rerun setup. No automatic config rewrite or new critique.\n'); return 1; }
    const installed = installClientCritique({ cwd, projectId: state.request.projectId, urls: [state.request.url], editor: state.request.editor, consent: true, installedRuntime: true, runtimeBinding, inheritedMcpConsent: state.request.inheritedMcpConsent === true });
    if (!['created', 'already'].includes(installed.action)) { output.write(`Resume blocked: ${installed.reason}.\n`); return 1; }
    return continueSetupCritique({ cwd, runId: state.request.runId, output, licenseKey: (opts.resolveKey || resolveKey)(), opts });
  }

  const resolveLicenseKey = opts.resolveKey || resolveKey;
  const writeConfig = opts.writeEditorMcpConfig || writeEditorMcpConfig;
  const configureProject = opts.configureSignedInSetupProject || configureSignedInSetupProject;
  const recordIntent = opts.recordDeveloperSetupIntent || recordDeveloperSetupIntent;
  let project = null;
  const capture = opts.captureEvent || captureEvent;
  // Each place the wizard stops short of a connected agent says why
  // (closed-enum reason; see CONNECT_FAILED_REASONS in lib/posthog.js).
  const connectFailed = (reason, detail) => {
    try { (opts.captureConnectFailed || captureConnectFailed)({ reason, stage: 'setup', detail, licenseKey: resolveLicenseKey() || null }); }
    catch { /* telemetry never changes setup's outcome */ }
  };
  const askOverride = typeof opts.ask === 'function' ? opts.ask : null;

  if (!input.isTTY) { output.write('This shell is not interactive, so setup stopped before sign-in. Nothing was changed and no critique was started.\n' + buildManualSteps() + '\n\n' + buildCollaborationCta() + '\n'); return 1; }

  const rl = askOverride ? null : readline.createInterface({ input, output });
  const w = (s) => output.write(s);
  const askQuestion = (question) => askOverride ? Promise.resolve(askOverride(question)) : ask(rl, question);
  try {
    w('\n  Pincushion setup: connect this code to a Pincushion project and your coding agent.\n');
    w(`  Working directory: ${resolve(cwd)}\n`);
    await askQuestion('  Press Enter to start. ');

    // 1. Sign in — REQUIRED GATE. Everything after this needs a cloud account, so
    // a declined sign-in exits early with an honest message (never fakes setup).
    let signedIn = !!resolveLicenseKey();
    if (signedIn) {
      w('\n  1. Already signed in ✓\n');
    } else {
      w('\n  1. Sign in — opening your browser...\n');
      const runLogin = opts.runLogin || (await import('./login.mjs')).runLogin;
      // resolveKey() below is the source of truth for success; runLogin's exit code
      // isn't needed — cancel and failure both correctly fall to the sign-in-required exit.
      await runLogin({ developerSetupIntent: true, developerSetupSource: 'setup' });
      signedIn = !!resolveLicenseKey();
      if (!signedIn) {
        const retry = await askQuestion('  Sign-in didn\'t complete. Retry? [Y/n] ');
        if (!/^n/i.test(retry)) {
          await runLogin({ developerSetupIntent: true, developerSetupSource: 'setup' });
          signedIn = !!resolveLicenseKey();
        }
      }
      if (!signedIn) {
        connectFailed('signin_incomplete');
        w('\n' + buildSignInRequiredExit() + '\n\n' + buildCollaborationCta() + '\n\n');
        return 1; // No completed setup or report when sign-in is unavailable.
      }
      w('     ✓ signed in\n');
    }

    // This explicit setup run is the only reason to record developer setup
    // intent. It is an acknowledgement-only event: failing to record it never
    // turns a partial run into an error or a successful setup into a claim.
    const activeLicenseKey = resolveLicenseKey();
    try {
      const intentOptions = {
        licenseKey: activeLicenseKey,
        developerSetupIntent: true,
        developerSetupSource: 'setup',
        functionsBase: DEFAULT_SUPABASE_BASE,
      };
      if (typeof opts.fetchImpl === 'function') intentOptions.fetchImpl = opts.fetchImpl;
      await recordIntent(intentOptions);
    } catch { /* setup status remains truthful without this optional acknowledgement */ }

    // 2. Choose the project. Projects are created in the Pincushion app, so
    // offer the account's projects first; only a brand-new project needs a
    // name and site URL. An explicit --project-id binds exactly that project
    // and never rewrites its name or URLs.
    const detected = detectProjectDefaults(cwd);
    const listProjects = opts.listSetupProjects || (() => listSignedInSetupProjects({
      licenseKey: resolveLicenseKey(),
      ...(typeof opts.fetchImpl === 'function' ? { fetchImpl: opts.fetchImpl } : {}),
    }));
    const accountProjects = await listProjects().catch(() => []);
    let name = detected.name;
    let urls = [detected.devUrl].filter(Boolean);
    let chosenProjectId = requestedProjectId;
    // Only owners and editors can share invite links (People tab). The role is
    // known for a listed project and for one this run created; otherwise null.
    // Developer-seat members are stored as editors; a legacy `developer` value
    // (pre-20260506 rows) is not an inviter in the app either.
    let projectRole = null;
    const requested = requestedProjectId
      ? accountProjects.find((candidate) => candidate.projectId === requestedProjectId)
      : null;
    if (requested) {
      w(`\n  2. Project: ${requested.name || requested.projectId}\n`);
      projectRole = requested.role;
      name = requested.name || name;
      urls = requested.urls.length ? requested.urls : urls;
    } else if (requestedProjectId) {
      // Not confirmed by the listing (offline or not yet visible): bind by ID
      // and add no locally detected URLs to someone's existing project.
      w(`\n  2. Project: ${requestedProjectId}\n`);
      urls = [];
    } else if (accountProjects.length) {
      w('\n  2. Which project is this code for?\n');
      const shown = accountProjects.slice(0, 20);
      shown.forEach((candidate, index) => w(`     ${index + 1}. ${candidate.name || 'Unnamed project'}${candidate.urls[0] ? ` (${candidate.urls[0]})` : ''}\n`));
      w('     n. Create a new project\n');
      const fallback = shown.length === 1 ? '1' : '';
      let picked = null;
      for (let attempt = 0; attempt < 2 && picked === null; attempt += 1) {
        const answer = ((await askQuestion(`  Project${fallback ? ` [${fallback}]` : ''}: `)) || fallback).trim().toLowerCase();
        if (answer === 'n') picked = 'new';
        else if (/^[1-9]\d*$/.test(answer) && shown[Number(answer) - 1]) picked = shown[Number(answer) - 1];
        else w('     Enter a number from the list, or n for a new project.\n');
      }
      if (picked === null) { w('  Incomplete: no project chosen. Nothing was changed.\n'); return 1; }
      if (picked !== 'new') {
        chosenProjectId = picked.projectId;
        projectRole = picked.role;
        name = picked.name || name;
        urls = picked.urls.length ? picked.urls : urls;
      }
    }
    if (!chosenProjectId) {
      if (!accountProjects.length) w('\n  2. New project\n');
      name = (await askQuestion(`     Name [${name}]: `)) || name;
      const siteUrl = (await askQuestion(`     Site URL [${urls[0] || ''}]: `)) || urls[0] || '';
      urls = [siteUrl].filter(Boolean);
    }
    {
      // This wizard deliberately stops before any provider lifecycle. A real
      // agent connection and a real pin read come first; an owner can review
      // deployment automation separately afterwards.
      w('     Deployment automation stays off during initial connection. No provider will be contacted.\n');
      const telemetryKey = resolveLicenseKey();
      try {
        const configurationOptions = {
          cwd,
          licenseKey: telemetryKey,
          name,
          urls,
          selectProject: async candidates => {
            w('     Several authenticated projects match these URLs. Select the intended project; none is selected automatically.\n');
            candidates.forEach((candidate, index) => w(`     ${index + 1}. ${candidate.name || 'Unnamed project'} (${candidate.projectId}) — ${candidate.urls.join(', ')}\n`));
            const selection = await askQuestion('  Project number (blank cancels): ');
            if (!/^[1-9]\d*$/.test(selection || '')) return null;
            const candidate = candidates[Number(selection) - 1];
            if (!candidate) return null;
            const confirmed = await askQuestion(`  Use ${candidate.projectId} for this project and critique? [y/N] `);
            return /^(y|yes)$/i.test(confirmed || '') ? candidate.projectId : null;
          },
          ...(chosenProjectId && { projectId: chosenProjectId }),
        };
        if (typeof opts.fetchImpl === 'function') configurationOptions.fetchImpl = opts.fetchImpl;
        const res = await configureProject(configurationOptions);
        if (telemetryKey) {
          capture(telemetryKey, 'setup_project_registration', {
            ...setupProjectRegistrationTelemetry(res, urls.length),
            ...(setupRef && { ref: setupRef }),
          });
        }
        const registrationAcknowledged = res?.cloudSync === 'synced' &&
          ['created', 'existing', 'updated'].includes(res?.status);
        if (res?.identity?.status === 'ambiguous') {
          w('     • project selection was cancelled or unresolved; no duplicate project, editor connection or critique was created.\n');
        } else if (res?.identity?.status === 'unresolved') {
          connectFailed('project_identity_unresolved');
          w('     • the requested project ID is not available to this signed-in account; no replacement project was registered.\n');
        } else if (!registrationAcknowledged) {
          // `projectId` in an unacknowledged core response is only an
          // in-memory candidate. Do not display or retain it as a registered
          // project: the acknowledgement-first helper guarantees it was not
          // persisted locally.
          connectFailed('project_registration_failed', typeof res?.status === 'string' ? res.status : null);
          w('     • cloud registration was not acknowledged; no project identity was saved locally. Check your connection/sign-in and retry setup.\n');
        } else {
          project = {
            name,
            urls: (await import('./lib/core.js')).normalizeProjectUrls(urls),
            ...(typeof res.projectId === 'string' && res.projectId.trim()
              ? { projectId: res.projectId.trim() }
              : {}),
          };
          // Registration may resolve a "new" project to one the account already
          // has (same URL); take that project's listed role.
          projectRole = res.status === 'created' ? 'owner'
            : (accountProjects.find((candidate) => candidate.projectId === res.projectId)?.role || projectRole);
          w(`     ✓ ${res.status === 'created' ? 'created' : 'using'} ${name}${res.projectId ? ` (${res.projectId})` : ''}\n`);
        }
      } catch (e) {
        if (telemetryKey) {
          capture(telemetryKey, 'setup_project_registration', {
            outcome: 'configuration_exception',
            project_status: 'unknown',
            url_count: urls.length,
            ...(setupRef && { ref: setupRef }),
          });
        }
        connectFailed('project_registration_failed', 'configuration_exception');
        w(`     • could not register: ${e.message}\n`);
      }
    }

    if (!project?.projectId) { w('  Incomplete: no authenticated project binding. Setup stopped before editor connection or critique.\n'); return 1; }

    // 3. Editor config — detection can suggest, but never selects or silently
    // falls back to another editor. Codex uses project-local config.toml.
    const detectedEditor = getEditorChoice(detected.editor);
    w(`\n  3. Which coding agent should read this project's pins?\n`);
    if (detectedEditor) w(`     Detected: ${detectedEditor.label}.\n`);
    w('     Type claude, cursor, vscode or codex (s to skip).\n');
    const selectedEditor = normalizeEditorChoice(await askQuestion('  Editor: '));
    let inheritedMcpConsent = false;
    let runtimeBinding;
    let editorResult = { action: 'skipped', path: '', editor: null };
    if (!selectedEditor) {
      w(`     Skipped. Connect an agent later with: npx -y pincushion-mcp setup --project-id ${project.projectId}\n`);
      return 0;
    } else {
      if(selectedEditor === 'codex') {
        const inherited=inspectCodexInheritedMcp();
        if(inherited.blocked){w(`  Incomplete: ${inherited.reason}. Existing settings preserved.\n`);return 1;}
        if(inherited.present){inheritedMcpConsent=/^(y|yes)$/i.test(await askQuestion('  Existing global Pincushion connection. Use this exact project/package for this session only, preserving global settings and permissions? [y/N] '));if(!inheritedMcpConsent){w('  Incomplete: inherited connection override declined.\n');return 1;}}
      }
      if(!safeSetupEditorConfig(cwd,selectedEditor)){w('  Incomplete: editor config path is unsafe or unavailable; existing files preserved.\n');return 1;}
      if (selectedEditor !== 'manual') {
        const approved = await askQuestion('  Install the locked Pincushion runtime and npm dependencies in this project and connect this selected editor? No global config, credentials or install scripts. [y/N] ');
        if (!/^(y|yes)$/i.test(approved || '')) { w('  Incomplete: project runtime installation declined. No editor connection or critique started.\n'); return 1; }
        runtimeBinding = await (opts.prepareSetupRuntime || prepareSetupRuntime)({ cwd, consent: true });
        if (!runtimeBinding.ready) { connectFailed('runtime_install_failed', runtimeBinding.reason); w(`  Incomplete: ${runtimeBinding.reason}. Existing and incomplete runtime files are preserved; no client or critique started.\n`); return 1; }
      }
      editorResult = writeConfig({ editor: selectedEditor, cwd, projectId: project?.projectId, installedRuntime: true, runtimeBinding });
      const choice = getEditorChoice(selectedEditor);
      if (editorResult.action === 'created' || editorResult.action === 'updated') {
        w(`     ✓ Config written: ${editorResult.path}\n`);
        w(`     The first time ${choice.label} starts the Pincushion server, approve it when asked.\n`);
      } else if (editorResult.action === 'already') {
        w(`     ✓ Config already in place: ${editorResult.path}\n`);
      } else if (editorResult.action === 'manual') {
        w(selectedEditor === 'manual' ? '     Manual mode has no identified agent runtime. Project registration alone cannot run a critique; no report completed.\n' : `     • ${choice?.label || 'This editor'} cannot be configured safely in this flow. No connection or critique completed.\n`);
      } else {
        w(`     • ${choice?.label || 'Editor'} config was left unchanged. Use its manual MCP instructions.\n`);
      }
    }

    // Connected: the selected agent can now read this project's pins. A first
    // AI critique is optional and runs only through the explicitly selected
    // supported client.
    const connected = ['created', 'updated', 'already'].includes(editorResult.action);
    if (!connected) {
      connectFailed('editor_config_failed', editorResult.reason || editorResult.action);
      w('  Incomplete: no coding agent was connected. Existing configuration is preserved.\n');
      return 1;
    }
    const choiceLabel = getEditorChoice(selectedEditor)?.label || 'your editor';
    w(`\n  ✓ ${project.name} is connected to ${choiceLabel}.\n`);
    w(`  Open ${choiceLabel} in this folder (restart it if it is already open) and ask: "Show my Pincushion pins".\n`);
    w(`  Reviewers leave pins from the Pincushion app: https://www.pincushion.io/app/project/${encodeURIComponent(project.projectId)}\n`);
    w(['owner', 'editor'].includes(projectRole)
      ? '  Invite your client or designer: open that project, go to People, and share an invite link.\n'
      : projectRole
        ? '  To bring in your client or designer, ask a project owner or editor to share an invite link from People.\n'
        : '  To invite your client or designer, an owner or editor shares an invite link from that project\'s People tab.\n');
    if (['claude', 'codex', 'cursor', 'vscode'].includes(selectedEditor) && process.platform !== 'win32') {
      const client = findSetupClient(selectedEditor, { cwd });
      if (client.available) {
        const wantsCritique = await askQuestion('\n  Optional: Continue now with a first AI critique of your site? [y/N] ');
        if (/^(y|yes)$/i.test(wantsCritique || '')) {
          w('\n  4. First AI critique of your site.\n');
          w('  Uses your existing agent tokens and Pincushion limits. Normal trust and tool approvals remain visible.\n');
          w('  Images and pin records leave this machine. No paid hosted fallback is used.\n');
          {
            project.urls.forEach((url, index) => w(`  ${index + 1}. ${url}\n`));
            const choice = await askQuestion('  Registered URL number [1]: ');
            const url = project.urls[Number(choice || '1') - 1];
            if (!url) { w('  Invalid registered URL choice; no critique started.\n'); return 1; }
            const owned = await askQuestion(`  Is ${url} your site and ${project.projectId} the intended project? [y/N] `);
            if (!/^(y|yes)$/i.test(owned || '')) { w('  No critique started. Your agent is still connected.\n'); return 0; }
            let prior;
            try { prior = findIncompleteSetupCritiques({cwd,projectId:project.projectId,url,editor:selectedEditor}); }
            catch { w('  Incomplete run state needs review; no new critique or duplicate writes started.\n'); return 1; }
            if (prior.length) {
              prior.forEach((state,index) => w(`  ${index + 1}. Existing incomplete run ${state.request.runId} (${state.request.accessMode})\n`));
              const choice = prior.length === 1 ? '1' : await askQuestion('  Incomplete run number (blank cancels): ');
              const state = /^[1-9]\d*$/.test(choice || '') ? prior[Number(choice)-1] : null;
              if (!state) { w('  No run selected. No replacement critique started.\n'); return 1; }
              const approved = await askQuestion('  Resume this same run, goal, upload and access choices under normal permissions? [y/N] ');
              if (!/^(y|yes)$/i.test(approved || '')) { w('  Resume declined. No replacement critique started.\n'); return 1; }
              const priorRuntime = readSetupRuntimeBinding({ cwd, artifactId: state.request.runtimeArtifactId });
              if (!priorRuntime.ready || priorRuntime.artifactId !== runtimeBinding.artifactId) { w('  Resume blocked: original runtime requires review. Existing run/configuration preserved; no replacement critique started.\n'); return 1; }
              const installed = installClientCritique({cwd,projectId:project.projectId,urls:project.urls,editor:selectedEditor,consent:true,installedRuntime:true,runtimeBinding:priorRuntime,inheritedMcpConsent:state.request.inheritedMcpConsent === true});
              if (!['created','already'].includes(installed.action)) {w(`  Resume blocked: ${installed.reason}.\n`);return 1;}
              rl?.close(); return await continueSetupCritique({cwd,runId:state.request.runId,output,licenseKey:resolveLicenseKey(),client,opts});
            }
            const goal = await askQuestion('  Audience and goal (one sentence): ');
            const protectedPage = /^(y|yes)$/i.test(await askQuestion('  Does this page require an existing authorized app sign-in? [y/N] '));
            if (protectedPage) w('  Capture must use already authorized local state; it will stop if unavailable. No login cookies are uploaded.\n');
            const access = await askQuestion('  Report access: project_members or public [project_members]: ');
            const accessMode = (access || 'project_members').trim();
            if (!['public', 'project_members'].includes(accessMode) || (protectedPage && accessMode !== 'project_members')) {
              w('  Invalid access choice; signed-in evidence must be project_members. No critique started.\n'); return 1;
            }
            const consent = await askQuestion(`  Approve saving findings, cloud image uploads and ${accessMode} report access? [y/N] `);
            if (!/^(y|yes)$/i.test(consent || '')) { w('  No critique started. Your agent is still connected.\n'); return 0; }
            const installed = installClientCritique({ cwd, editor: selectedEditor, projectId: project.projectId, urls: project.urls, consent: true, installedRuntime: true, runtimeBinding, inheritedMcpConsent });
            if (!['created', 'already'].includes(installed.action)) { w(`  Critique not started: ${installed.reason}. Existing assets preserved.\n`); return 1; }
            const state = createSetupCritique({ cwd, editor: selectedEditor, projectId: project.projectId, url, goal, accessMode, requireAuth: protectedPage, consent: true, runtimeBinding, inheritedMcpConsent, ownershipAcknowledged: true, licenseKey: resolveLicenseKey(), functionsBase: DEFAULT_SUPABASE_BASE });
            rl?.close();
            return await continueSetupCritique({ cwd, runId: state.request.runId, output, licenseKey: resolveLicenseKey(), client, opts });
          }
        }
      }
    }
    return 0;
  } finally {
    rl?.close();
  }
}
