import {
  PROVIDER_IDS,
  selectProviderCandidate,
  redactProviderResult,
  buildManualSetupSummary,
  assertProviderSetupResult,
} from './contracts.js';
import {
  buildManualDeploymentHandoff,
  buildManualProviderResult,
} from './manual.js';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { join, resolve } from 'node:path';

const DETECTION_FILES = Object.freeze([
  ['.vercel/project.json', 'vercel'],
  ['vercel.json', 'vercel'],
  ['netlify.toml', 'netlify'],
  ['.netlify/state.json', 'netlify'],
  ['render.yaml', 'render'],
  ['railway.json', 'railway'],
  ['fly.toml', 'fly'],
  ['Dockerfile', 'docker'],
]);

const SENSITIVE_CONTEXT_KEYS = /(?:token|secret|credential|password|privatekey|private_key|authorization|bearer|cookie|rawpayload|payload|stdout|stderr|error)/i;
const SAFE_ID_PATTERN = /^(?!.*(?:<|>|todo|tbd|unknown|placeholder))(?!.*(?:token|secret|credential|password|bearer|dhk_))[\w:.@/+\-=]{1,512}$/i;

function validCwd(cwd) {
  return typeof cwd === 'string' && cwd.trim() ? cwd : process.cwd();
}

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function safeMetadataValue(value, max = 256) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > max || !SAFE_ID_PATTERN.test(normalized)) return undefined;
  return normalized;
}

function safeGitHubRepository(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  const match = normalized.match(/github\.com[/:]([^/\s:]+)\/([^/#\s]+?)(?:\.git)?$/i);
  if (!match) return undefined;
  const owner = safeMetadataValue(match[1], 100);
  const name = safeMetadataValue(match[2], 200);
  return owner && name ? `${owner}/${name}` : undefined;
}

function addCandidate(map, provider, evidence, metadata = {}) {
  if (!PROVIDER_IDS.includes(provider)) return;
  const existing = map.get(provider);
  if (existing) {
    if (evidence && !existing.evidence.includes(evidence)) existing.evidence.push(evidence);
    for (const [key, value] of Object.entries(metadata)) {
      if (value !== undefined && existing.metadata[key] === undefined) existing.metadata[key] = value;
    }
    return;
  }
  map.set(provider, {
    provider,
    evidence: evidence ? [evidence] : [],
    metadata: Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined)),
  });
}

function remoteValues(value, output = []) {
  if (typeof value === 'string') {
    if (value.trim()) output.push(value.trim());
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) remoteValues(item, output);
    return output;
  }
  if (value && typeof value === 'object') {
    for (const key of ['url', 'remote', 'remoteUrl', 'gitRemote', 'origin']) {
      if (value[key] !== undefined) remoteValues(value[key], output);
    }
  }
  return output;
}

async function injectedGitRemotes(gitRemote, cwd) {
  if (typeof gitRemote === 'function') {
    try {
      return remoteValues(await gitRemote({ cwd }));
    } catch {
      return [];
    }
  }
  return remoteValues(gitRemote);
}

async function localGitRemotes(cwd) {
  const dotGitPath = join(cwd, '.git');
  const configPaths = [];
  try {
    const dotGitStat = await stat(dotGitPath);
    if (dotGitStat.isDirectory()) {
      configPaths.push(join(dotGitPath, 'config'));
    } else if (dotGitStat.isFile()) {
      // Linked worktrees store a pointer in <worktree>/.git. Follow only the
      // local gitdir/commondir metadata; never invoke git or traverse arbitrary
      // repository files while detecting provider evidence.
      const pointer = await readFile(dotGitPath, 'utf8');
      const match = pointer.match(/^gitdir:\s*(.+?)\s*$/im);
      if (match) {
        const gitDir = resolve(cwd, match[1]);
        configPaths.push(join(gitDir, 'config'));
        try {
          const commonDir = (await readFile(join(gitDir, 'commondir'), 'utf8')).trim();
          if (commonDir) configPaths.unshift(join(resolve(gitDir, commonDir), 'config'));
        } catch { /* non-worktree gitdir: its local config remains the fallback */ }
      }
    }
  } catch { /* a non-Git fixture is still valid for file-based detection */ }

  // Preserve the simple directory path as a final fallback for unusual Git
  // layouts where stat/read of the .git pointer was unavailable.
  if (!configPaths.includes(join(dotGitPath, 'config'))) configPaths.push(join(dotGitPath, 'config'));

  const remotes = [];
  for (const gitConfigPath of configPaths) {
    try {
      const source = await readFile(gitConfigPath, 'utf8');
      remotes.push(...[...source.matchAll(/^\s*url\s*=\s*(\S+)\s*$/gim)].map((match) => match[1]).filter(Boolean));
    } catch { /* try the next Git config candidate */ }
  }
  return remotes;
}

async function workflowEvidence(cwd) {
  const workflowRoot = join(cwd, '.github', 'workflows');
  try {
    const entries = await readdir(workflowRoot, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && /\.(?:ya?ml)$/i.test(entry.name))
      .map((entry) => `.github/workflows/${entry.name}`)
      .sort();
  } catch {
    return [];
  }
}

function attachDetectionMetadata(candidates) {
  const providers = candidates.map((candidate) => candidate.provider);
  const status = providers.length > 1
    ? 'ambiguous_provider'
    : providers.length === 0
      ? 'unsupported_provider_api'
      : undefined;
  const selection = selectProviderCandidate(candidates, undefined);
  // The function returns an array for callers that only need a candidate list,
  // while non-enumerable aliases retain a report-shaped interface for callers
  // that need status/selection without changing array equality or JSON output.
  Object.defineProperties(candidates, {
    candidates: { value: candidates, enumerable: false },
    providers: { value: providers, enumerable: false },
    candidateIds: { value: providers, enumerable: false },
    status: { value: status, enumerable: false },
    selection: { value: selection, enumerable: false },
  });
  return candidates;
}

/**
 * Detect local deployment evidence. Detection is read-only and deliberately
 * returns every candidate; it never selects or contacts a provider.
 *
 * @param {{cwd?: string, gitRemote?: unknown}} options
 * @returns {Promise<Array<{provider: string, evidence: string[], metadata: Record<string, string>}>>}
 */
export async function detectDeploymentProviders({ cwd: rawCwd, gitRemote } = {}) {
  const cwd = validCwd(rawCwd);
  const detected = new Map();

  for (const [relativePath, provider] of DETECTION_FILES) {
    const path = join(cwd, relativePath);
    if (!await exists(path)) continue;
    const metadata = {};
    if (relativePath === '.vercel/project.json') {
      const project = await readJson(path);
      metadata.projectId = safeMetadataValue(project.projectId ?? project.project_id);
      metadata.orgId = safeMetadataValue(project.orgId ?? project.org_id ?? project.teamId ?? project.team_id);
    }
    if (relativePath === '.netlify/state.json') {
      const state = await readJson(path);
      metadata.siteId = safeMetadataValue(state.siteId ?? state.site_id);
    }
    addCandidate(detected, provider, relativePath, metadata);
  }

  const workflows = await workflowEvidence(cwd);
  for (const evidence of workflows) addCandidate(detected, 'github-actions', evidence);

  const remotes = [
    ...(await injectedGitRemotes(gitRemote, cwd)),
    ...(!gitRemote ? await localGitRemotes(cwd) : []),
  ];
  for (const remote of remotes) {
    const repository = safeGitHubRepository(remote);
    if (!repository) continue;
    addCandidate(detected, 'github', 'git:github_remote', { repository });
    // A workflow is a separate CI route from a repository webhook. Keep both
    // candidates when both signals exist so ensure cannot guess a route.
    if (workflows.length) addCandidate(detected, 'github-actions', 'git:github_remote', { repository });
  }

  return attachDetectionMetadata([...detected.values()]);
}

function candidateListFromContext(context = {}, detection) {
  if (Array.isArray(context.candidates)) return context.candidates;
  if (Array.isArray(context.detectedCandidates)) return context.detectedCandidates;
  if (Array.isArray(context.detection)) return context.detection;
  if (typeof context.candidate === 'string' || (context.candidate && typeof context.candidate === 'object')) return [context.candidate];
  return detection;
}

function candidateIds(candidates) {
  return [...new Set((Array.isArray(candidates) ? candidates : [])
    .map((candidate) => typeof candidate === 'string' ? candidate : candidate?.provider ?? candidate?.id)
    .filter((provider) => PROVIDER_IDS.includes(provider)))];
}

async function resolveSelection(context = {}) {
  const detected = await detectDeploymentProviders({ cwd: context.cwd, gitRemote: context.gitRemote });
  const candidates = candidateListFromContext(context, detected);
  const explicitProvider = context.deploymentProvider ?? context.provider;
  const selection = selectProviderCandidate(candidates, explicitProvider);
  return { detected, candidates, selection };
}

function noSelectionResult({ requested, selection, candidates }) {
  const ids = candidateIds(candidates);
  if (selection.status === 'ambiguous_provider') {
    return {
      requested: requested === true,
      status: 'ambiguous_provider',
      verification: 'candidate_detection',
      writesPerformed: false,
      ownerAuthorizationRequired: true,
      candidates: ids,
    };
  }
  const result = {
    ...buildManualProviderResult({
      provider: 'unknown',
      requested: requested === true,
      status: 'unsupported_provider_api',
      verification: 'candidate_detection',
      reason: 'explicit_provider_not_detected',
    }),
    candidates: ids,
  };
  // An explicit provider that is not in a non-empty detected list must not be
  // relabeled as `unknown`; that would hide the selection mismatch.
  if (ids.length > 0) delete result.provider;
  return result;
}

function adapterFor(context, provider) {
  const adapters = context?.adapters;
  if (adapters && typeof adapters === 'object' && !Array.isArray(adapters)) {
    const adapter = adapters[provider];
    if (adapter) return adapter;
  }
  if (context?.adapter && typeof context.adapter === 'object') return context.adapter;
  return undefined;
}

function safeAdapterContext(context, provider, candidates, mode, extra = {}) {
  const SAFE_CONTEXT_KEYS = new Set([
    'cwd', 'projectRoot', 'gitRemote', 'deploymentAutomation',
    'deploymentProvider', 'provider', 'candidates', 'candidate',
    'projectId', 'project_id', 'orgId', 'org_id', 'teamId', 'team_id',
    'siteId', 'site_id', 'serviceId', 'service_id', 'environment',
    'repository', 'repo', 'attemptId', 'scope', 'requestedScope',
  ]);
  const output = {};
  for (const [key, value] of Object.entries(context || {})) {
    if (!SAFE_CONTEXT_KEYS.has(key) || SENSITIVE_CONTEXT_KEYS.test(key)) continue;
    output[key] = value;
  }
  return {
    ...output,
    provider,
    deploymentProvider: provider,
    candidates,
    mode,
    writesAllowed: mode !== 'inspect',
    ...extra,
  };
}

function normalizeAdapterResult(value, { provider, requested, mode, context }) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return buildManualProviderResult({ provider, requested, ...context });
  }
  const redacted = redactProviderResult({ ...value, requested: requested === true });
  const allowedStatuses = new Set([
    'configured', 'already_configured', 'manual_setup_required',
    'unsupported_provider_api', 'ambiguous_provider', 'conflict', 'degraded',
  ]);
  if (!allowedStatuses.has(redacted.status)) {
    return buildManualProviderResult({ provider, requested, ...context });
  }
  const output = {
    ...redacted,
    requested: requested === true,
    provider,
    writesPerformed: mode === 'inspect' ? false : (redacted.writesPerformed ?? false),
  };
  if (output.status === 'configured' || output.status === 'already_configured') {
    // A registry result may claim managed setup only when the injected adapter
    // supplied the complete provider-readback contract. This keeps a partial
    // or test-double result from being surfaced as configured.
    try {
      assertProviderSetupResult({
        ...output,
        requested: true,
      });
    } catch {
      return buildManualProviderResult({ provider, requested, ...context });
    }
  }
  if (['manual_setup_required', 'unsupported_provider_api'].includes(output.status)) {
    output.writesPerformed = false;
    output.ownerAuthorizationRequired = true;
    output.ingestionMode = 'authenticated_normalized_submission';
    output.authenticationMethod = 'receiver_bearer';
    output.assuranceLevel = 'authenticated_submitter';
    output.manualSetupSummary = buildManualSetupSummary(provider);
  }
  return output;
}

async function ownerConsentGranted(context = {}) {
  const callbacks = [context.ownerConsent, context.ownerAuthorizationCallback, context.authorizeOwner];
  const callback = callbacks.find((value) => typeof value === 'function');
  if (callback) {
    try {
      const result = await callback({
        provider: context.deploymentProvider ?? context.provider,
        deploymentAutomation: 'auto',
      });
      if (result === true) return true;
      if (result && typeof result === 'object') {
        return result.authorized === true || result.consent === true || result.ownerAuthorized === true;
      }
      return false;
    } catch {
      return false;
    }
  }
  if (context.ownerConsent === true || context.ownerAuthorized === true || context.ownerAuthorization === true) return true;
  const ownerContextIsAuthorized = (value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const ownerIdentity = value.authorized === true || value.ownerAuthorized === true || value.role === 'owner';
    const explicitConsent = value.consent === true || value.deploymentAutomation === 'auto' || value.consent === 'auto';
    return ownerIdentity && explicitConsent;
  };
  if (context.ownerConsent && typeof context.ownerConsent === 'object') {
    return ownerContextIsAuthorized(context.ownerConsent);
  }
  if (context.owner && typeof context.owner === 'object') {
    return ownerContextIsAuthorized(context.owner);
  }
  if (context.ownerContext && typeof context.ownerContext === 'object') {
    return ownerContextIsAuthorized(context.ownerContext);
  }
  return false;
}

async function inspectWithSelection(context, selectionData) {
  const { candidates, selection } = selectionData;
  if (!selection?.provider) return noSelectionResult({ requested: false, selection, candidates });
  const provider = selection.provider;
  const adapter = adapterFor(context, provider);
  if (adapter && typeof adapter.inspect === 'function') {
    try {
      const value = await adapter.inspect(safeAdapterContext(context, provider, candidates, 'inspect'));
      return normalizeAdapterResult(value, { provider, requested: false, mode: 'inspect', context });
    } catch {
      return buildManualProviderResult({ provider, requested: false, status: 'degraded', ...context });
    }
  }
  return buildManualProviderResult({ provider, requested: false, ...context });
}

/**
 * Inspect a selected provider without credentials or provider writes.
 */
export async function inspectDeploymentProvider(context = {}) {
  return inspectWithSelection(context, await resolveSelection(context));
}

/**
 * Ensure a provider binding only after explicit `deploymentAutomation: 'auto'`
 * and owner consent. No built-in adapter is registered in this task; callers
 * may inject an admitted adapter for tests/future provider implementations.
 */
export async function ensureDeploymentProvider(context = {}) {
  const selectionData = await resolveSelection(context);
  const requested = context.deploymentAutomation === 'auto';
  if (!requested) {
    const result = selectionData.selection?.provider
      ? buildManualProviderResult({ provider: selectionData.selection.provider, requested: false, ...context })
      : noSelectionResult({ requested: false, ...selectionData });
    return result;
  }
  if (!selectionData.selection?.provider) {
    return noSelectionResult({ requested: true, ...selectionData });
  }
  const provider = selectionData.selection.provider;
  if (!await ownerConsentGranted(context)) {
    return buildManualProviderResult({ provider, requested: true, ...context });
  }

  const adapter = adapterFor(context, provider);
  if (!adapter || typeof adapter.ensure !== 'function') {
    // Task 4 has no admitted provider writer. A future adapter is injected at
    // this boundary only after it can prove credentials, writes, and read-back.
    return buildManualProviderResult({ provider, requested: true, ...context });
  }
  try {
    const value = await adapter.ensure(safeAdapterContext(context, provider, selectionData.candidates, 'ensure'));
    return normalizeAdapterResult(value, { provider, requested: true, mode: 'ensure', context });
  } catch {
    return buildManualProviderResult({ provider, requested: true, status: 'degraded', ...context });
  }
}

/**
 * Compensate only an exact setup attempt through an injected adapter. Missing
 * attempt identity, consent, or adapter capability is fail-closed and leaves
 * the provider in a manual state; no broad provider cleanup is attempted.
 */
export async function compensateDeploymentProviderAttempt(context = {}) {
  const selectionData = await resolveSelection(context);
  const requested = context.deploymentAutomation === 'auto';
  if (!requested || !selectionData.selection?.provider) {
    return selectionData.selection?.provider
      ? buildManualProviderResult({ provider: selectionData.selection.provider, requested, ...context })
      : noSelectionResult({ requested, ...selectionData });
  }
  const provider = selectionData.selection.provider;
  const attemptId = typeof context.attemptId === 'string' ? context.attemptId.trim() : '';
  if (!attemptId || !SAFE_ID_PATTERN.test(attemptId) || !await ownerConsentGranted(context)) {
    return buildManualProviderResult({ provider, requested: true, ...context });
  }
  const adapter = adapterFor(context, provider);
  const compensate = adapter && (adapter.compensateAttempt || adapter.compensate);
  if (typeof compensate !== 'function') {
    return buildManualProviderResult({ provider, requested: true, ...context });
  }
  try {
    const value = await compensate.call(adapter, safeAdapterContext(
      context,
      provider,
      selectionData.candidates,
      'compensate',
      { attemptId },
    ));
    return normalizeAdapterResult(value, { provider, requested: true, mode: 'compensate', context });
  } catch {
    return buildManualProviderResult({ provider, requested: true, status: 'degraded', ...context });
  }
}

export { buildManualDeploymentHandoff };
