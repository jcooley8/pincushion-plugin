// Vercel managed deployment-webhook adapter.
//
// This adapter deliberately owns no registry registration. A caller creates it
// with its endpoint, binding lifecycle callbacks, and an injected transport,
// then supplies that instance to the provider-neutral registry. That keeps the
// Vercel-specific credential and webhook semantics out of other providers.

import { execFile } from 'node:child_process';

import { redactProviderResult } from './contracts.js';
import { buildManualProviderResult } from './manual.js';

const CLI_TIMEOUT_MS = 10_000;
const CLI_MAX_BUFFER = 1024 * 1024;
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_ENDPOINT_LENGTH = 2_000;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]{0,511}$/;

function boundedCliTimeout(value) {
  return Number.isFinite(value) && value > 0
    ? Math.min(Math.floor(value), 15_000)
    : CLI_TIMEOUT_MS;
}

function text(value, max = 300) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeIdentifier(value, max = MAX_IDENTIFIER_LENGTH) {
  const candidate = text(value, max);
  return candidate && SAFE_IDENTIFIER.test(candidate) ? candidate : '';
}

function scopeArgs(orgId) {
  const scope = safeIdentifier(orgId, 200);
  return scope ? ['--scope', scope] : [];
}

function validEndpoint(value) {
  const endpoint = text(value, MAX_ENDPOINT_LENGTH);
  if (!endpoint) return '';
  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === 'https:' && parsed.hostname ? endpoint : '';
  } catch {
    return '';
  }
}

function canonicalHttpsOrigins(value) {
  if (!Array.isArray(value)) return [];
  const origins = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !entry.trim()) return [];
    try {
      const parsed = new URL(entry.trim());
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname) return [];
      origins.push(parsed.origin);
    } catch {
      return [];
    }
  }
  return [...new Set(origins)].sort();
}

function sameStringList(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function values(value) {
  const rows = Array.isArray(value) ? value : [value];
  const output = [];
  for (const row of rows) {
    if (typeof row === 'string') {
      const candidate = text(row);
      if (candidate) output.push(candidate);
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const candidate = text(row.id || row.projectId || row.project_id);
    if (candidate) output.push(candidate);
  }
  return output;
}

function webhookEvents(webhook) {
  return new Set(values(webhook?.events ?? webhook?.event));
}

function webhookProjects(webhook) {
  return new Set(values(
    webhook?.projectIds ?? webhook?.project_ids ?? webhook?.projects ?? webhook?.project ?? webhook?.projectId ?? webhook?.project_id,
  ));
}

function webhookUrl(webhook) {
  return text(webhook?.url ?? webhook?.targetUrl ?? webhook?.target_url ?? webhook?.endpoint, MAX_ENDPOINT_LENGTH);
}

function webhookId(webhook) {
  return safeIdentifier(webhook?.id ?? webhook?.webhookId ?? webhook?.webhook_id);
}

function exactManagedWebhook(webhook, endpointUrl, projectId) {
  const events = webhookEvents(webhook);
  const projects = webhookProjects(webhook);
  return webhookUrl(webhook) === endpointUrl &&
    events.size === 1 && events.has('deployment.promoted') &&
    projects.size === 1 && projects.has(projectId);
}

function targetMatchState(webhooks, endpointUrl, projectId) {
  const targets = webhooks.filter((webhook) => webhookUrl(webhook) === endpointUrl);
  const exact = targets.filter((webhook) => exactManagedWebhook(webhook, endpointUrl, projectId));
  if (targets.length === 1 && exact.length === 1) return { state: 'exact', webhook: exact[0] };
  if (targets.length > 0) return { state: 'conflict', webhook: null };
  return { state: 'missing', webhook: null };
}

function parseWebhookList(body) {
  if (Array.isArray(body)) return body;
  if (body && typeof body === 'object') {
    if (Array.isArray(body.webhooks)) return body.webhooks;
    if (Array.isArray(body.data)) return body.data;
  }
  return null;
}

function parseJson(textValue) {
  try {
    return JSON.parse(String(textValue || ''));
  } catch {
    return undefined;
  }
}

function statusOk(status) {
  return Number.isInteger(status) && status >= 200 && status < 300;
}

function responseShape(value) {
  if (!value || typeof value !== 'object') {
    return { ok: false, status: undefined, body: undefined, ambiguous: true };
  }
  const status = Number(value.status);
  if (!Number.isInteger(status)) {
    return { ok: false, status: undefined, body: undefined, ambiguous: true };
  }
  return {
    ok: statusOk(status),
    status,
    body: value.body,
    ambiguous: false,
  };
}

function verified(status, writesPerformed) {
  return redactProviderResult({
    requested: true,
    provider: 'vercel',
    status,
    verification: 'provider_readback',
    firstProductionReceipt: 'pending',
    ingestionMode: 'native_webhook',
    authenticationMethod: 'provider_signature',
    assuranceLevel: 'provider_verified',
    writesPerformed,
  });
}

function degraded(reason, { requested = true, writesPerformed = false } = {}) {
  return redactProviderResult({
    requested,
    provider: 'vercel',
    status: 'degraded',
    reason,
    writesPerformed,
  });
}

function manual(requested) {
  return redactProviderResult(buildManualProviderResult({
    provider: 'vercel',
    requested,
  }));
}

function callbackSucceeded(value) {
  return value === true || (value && typeof value === 'object' && value.ok === true);
}

function finalizationOutcome(value) {
  if (callbackSucceeded(value)) return 'committed';
  // Only an explicit negative acknowledgement proves the lifecycle rejected
  // the replacement. Missing or malformed callback results can also be a lost
  // response, so treat them as ambiguous and force active-binding readback.
  if (value === false || (value && typeof value === 'object' && value.ok === false)) return 'rejected';
  return 'ambiguous';
}

async function callCallback(callback, payload) {
  if (typeof callback !== 'function') return false;
  try {
    return callbackSucceeded(await callback(payload));
  } catch {
    return false;
  }
}

function resolvedProjectId(configuredProjectId, context) {
  const fromContext = safeIdentifier(
    context?.providerProjectId ?? context?.provider_project_id ?? context?.projectId ?? context?.project_id,
  );
  if (configuredProjectId && fromContext && configuredProjectId !== fromContext) return '';
  return configuredProjectId || fromContext;
}

function validAttemptId(value) {
  return Boolean(safeIdentifier(value));
}

function credentialFromCreate(body) {
  // The official POST /v1/webhooks response carries this one-time value as
  // `secret`. It is deliberately consumed by exactly one callback below and is
  // never copied into a result, error, log, or lifecycle-finalization payload.
  return typeof body?.secret === 'string' && body.secret.length > 0
    ? body.secret
    : '';
}

async function runs(run, args, options) {
  try {
    await run(args, options);
    return true;
  } catch {
    return false;
  }
}

/**
 * Make an argv-only Vercel CLI runner. It is export-compatible with the
 * pre-adapter facade and has no shell interpolation path.
 */
export function createVercelCliRunner(execFileImpl = execFile) {
  return async function runVercelCli(args, { cwd, timeoutMs } = {}) {
    const argv = Array.isArray(args) ? args.map((arg) => String(arg)) : [];
    return await new Promise((resolve, reject) => {
      try {
        execFileImpl('vercel', argv, {
          cwd,
          timeout: boundedCliTimeout(timeoutMs),
          maxBuffer: CLI_MAX_BUFFER,
          windowsHide: true,
          shell: false,
        }, (error, stdout = '', stderr = '') => {
          if (error) {
            reject(error);
            return;
          }
          resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
        });
      } catch (error) {
        reject(error);
      }
    });
  };
}

export const runVercelCli = createVercelCliRunner();

/**
 * Official Vercel CLI API transport. `vercel api` uses the authenticated CLI
 * session to invoke Vercel's documented REST endpoint. Unlike `webhooks
 * create`, POST /v1/webhooks supplies a structured response containing the
 * one-time signing secret, so this transport never needs to parse CLI prose.
 */
function createVercelCliApiTransport({
  run = runVercelCli,
  cwd,
  orgId,
  timeoutMs,
} = {}) {
  const options = { cwd, timeoutMs };
  const scope = scopeArgs(orgId);
  const transport = async ({ method, path, body } = {}) => {
    const normalizedMethod = typeof method === 'string' ? method.toUpperCase() : '';
    if (!['GET', 'POST', 'DELETE'].includes(normalizedMethod) || typeof path !== 'string' || !path.startsWith('/v1/webhooks')) {
      return { status: 400, body: null };
    }

    const args = ['api', path, '-X', normalizedMethod, '--raw'];
    if (normalizedMethod === 'POST') {
      const url = validEndpoint(body?.url);
      const projectId = safeIdentifier(Array.isArray(body?.projectIds) ? body.projectIds[0] : '');
      if (!url || !projectId || !Array.isArray(body?.events) || body.events.length !== 1 || body.events[0] !== 'deployment.promoted') {
        return { status: 400, body: null };
      }
      args.push(
        '-F', `url=${url}`,
        '-F', `events=${JSON.stringify(['deployment.promoted'])}`,
        '-F', `projectIds=${JSON.stringify([projectId])}`,
      );
    }
    if (normalizedMethod === 'DELETE') args.push('--dangerously-skip-permissions');
    args.push(...scope);

    const result = await run(args, options);
    if (normalizedMethod === 'DELETE') return { status: 204, body: null };
    const bodyValue = parseJson(result?.stdout);
    return bodyValue === undefined
      ? { status: 502, body: null }
      : { status: 200, body: bodyValue };
  };
  Object.defineProperties(transport, {
    structuredSecretResponse: { value: true },
    usesVercelCli: { value: true },
    run: { value: run },
    options: { value: options },
    scope: { value: scope },
  });
  return transport;
}

/**
 * Create an injectable, provider-neutral registry adapter for one Vercel
 * project/receiver. Lifecycle callbacks are intentionally captured in this
 * closure: registry's safe context never carries an endpoint, credential, raw
 * transport output, or callable that could widen another provider's surface.
 */
export function createVercelDeploymentAdapter({
  endpointUrl: rawEndpointUrl,
  projectId: rawProjectId,
  pincushionProjectId: rawPincushionProjectId,
  orgId,
  bindingId: rawBindingId,
  canonicalOrigins: rawCanonicalOrigins,
  cwd,
  timeoutMs,
  run,
  transport: injectedTransport,
  captureProviderGeneratedCredential,
  finalizeProvisioning,
  markAttemptDegraded,
  completeExternalCleanup,
  hasUsableCredential,
  getAttemptOwnedWebhook,
  getActiveBinding,
  getCleanupDebt,
} = {}) {
  const endpointUrl = validEndpoint(rawEndpointUrl);
  const configuredProjectId = safeIdentifier(rawProjectId);
  const pincushionProjectId = safeIdentifier(rawPincushionProjectId);
  const bindingId = safeIdentifier(rawBindingId);
  const configuredCanonicalOrigins = canonicalHttpsOrigins(rawCanonicalOrigins);
  const transport = typeof injectedTransport === 'function'
    ? injectedTransport
    : createVercelCliApiTransport({ run, cwd, orgId, timeoutMs });
  const transportUsesCli = transport?.usesVercelCli === true;
  const transportHasStructuredSecret = transport?.structuredSecretResponse === true;
  const cliOptions = transportUsesCli
    ? (transport.options || { cwd, timeoutMs })
    : { cwd, timeoutMs };
  const cliScope = transportUsesCli ? (transport.scope || scopeArgs(orgId)) : scopeArgs(orgId);
  const cliRun = transportUsesCli && typeof transport.run === 'function' ? transport.run : null;

  async function cliReady() {
    if (!transportUsesCli) return { ok: true };
    if (!await runs(cliRun, ['--version'], cliOptions)) return { ok: false, reason: 'cli_unavailable' };
    if (!await runs(cliRun, ['whoami', ...cliScope], cliOptions)) return { ok: false, reason: 'cli_auth_unavailable' };
    return { ok: true };
  }

  async function request(requestOptions) {
    try {
      return responseShape(await transport(requestOptions));
    } catch {
      // A transport exception says nothing reliable about whether Vercel
      // accepted a mutation, so callers must read back before retrying.
      return { ok: false, status: undefined, body: undefined, ambiguous: true };
    }
  }

  async function list(projectId) {
    const response = await request({
      method: 'GET',
      path: `/v1/webhooks?projectId=${encodeURIComponent(projectId)}`,
    });
    const webhooks = response.ok ? parseWebhookList(response.body) : null;
    return webhooks
      ? { ok: true, webhooks, providerReadBackAt: new Date().toISOString() }
      : { ok: false, webhooks: [], providerReadBackAt: '' };
  }

  async function deleteWebhook(providerWebhookId) {
    const response = await request({
      method: 'DELETE',
      path: `/v1/webhooks/${encodeURIComponent(providerWebhookId)}`,
    });
    return response.ok;
  }

  async function readTarget(context) {
    const projectId = resolvedProjectId(configuredProjectId, context);
    if (!endpointUrl || !projectId) return { ok: false, reason: 'missing_project_metadata', projectId: '' };
    const ready = await cliReady();
    if (!ready.ok) return { ok: false, reason: ready.reason, projectId };
    const listed = await list(projectId);
    if (!listed.ok) return { ok: false, reason: 'webhook_list_unavailable', projectId };
    return {
      ok: true,
      projectId,
      webhooks: listed.webhooks,
      match: targetMatchState(listed.webhooks, endpointUrl, projectId),
    };
  }

  function writeCapabilities(context) {
    return context?.deploymentAutomation === 'auto' &&
      context?.writesAllowed === true &&
      validAttemptId(context?.attemptId) &&
      Boolean(bindingId) &&
      Boolean(pincushionProjectId) &&
      resolvedCanonicalOrigins(context).length > 0 &&
      transportHasStructuredSecret &&
      typeof captureProviderGeneratedCredential === 'function' &&
      typeof finalizeProvisioning === 'function' &&
      typeof markAttemptDegraded === 'function';
  }

  function resolvedCanonicalOrigins(context = {}) {
    const hasContextualOrigins = Object.prototype.hasOwnProperty.call(context, 'canonicalOrigins') ||
      Object.prototype.hasOwnProperty.call(context, 'canonical_origins');
    const contextual = canonicalHttpsOrigins(context?.canonicalOrigins ?? context?.canonical_origins);
    if (hasContextualOrigins && contextual.length === 0) return [];
    if (configuredCanonicalOrigins.length && contextual.length &&
      !sameStringList(configuredCanonicalOrigins, contextual)) return [];
    return configuredCanonicalOrigins.length ? configuredCanonicalOrigins : contextual;
  }

  function rotateCapabilities(context) {
    // Rotation finalization must atomically create write-ahead cleanup debt,
    // and the adapter must be able to complete that exact debt after fresh
    // provider absence readback. Never create a replacement without both
    // lifecycle boundaries.
    return writeCapabilities(context) && typeof completeExternalCleanup === 'function';
  }

  function safeLifecyclePayload({ attemptId, projectId, providerWebhookId, replacesProviderWebhookId, errorCode } = {}) {
    return {
      provider: 'vercel',
      ...(bindingId && { bindingId }),
      ...(validAttemptId(attemptId) && { attemptId: safeIdentifier(attemptId) }),
      ...(pincushionProjectId && { projectId: pincushionProjectId }),
      ...(projectId && { providerProjectId: projectId }),
      // Lifecycle persistence is keyed by this canonical field. Do not send
      // compatibility aliases into the lifecycle callback contract.
      ...(providerWebhookId && { providerWebhookId }),
      ...(replacesProviderWebhookId && { replacesProviderWebhookId }),
      ...(errorCode && { errorCode }),
    };
  }

  async function markDegraded(payload) {
    return await callCallback(markAttemptDegraded, payload);
  }

  async function usableCredential({ projectId, providerWebhookId }) {
    return await callCallback(hasUsableCredential, safeLifecyclePayload({ projectId, providerWebhookId }));
  }

  async function readUsableActiveBinding(projectId) {
    if (typeof getActiveBinding !== 'function') return { ok: false, providerWebhookId: '' };
    let active;
    try {
      active = await getActiveBinding(safeLifecyclePayload({ projectId }));
    } catch {
      return { ok: false, providerWebhookId: '' };
    }
    const providerWebhookId = safeIdentifier(active?.providerWebhookId ?? active?.webhookId ?? active?.providerResourceId);
    const cleanupDebtId = safeIdentifier(active?.cleanupDebtId ?? active?.cleanup_debt_id);
    const cleanupTargetProviderWebhookId = safeIdentifier(
      active?.cleanupTargetProviderWebhookId ?? active?.cleanup_target_provider_webhook_id,
    );
    return {
      ok: Boolean(providerWebhookId) && active?.credentialUsable === true,
      providerWebhookId,
      cleanupDebtId,
      cleanupTargetProviderWebhookId,
    };
  }

  async function createWebhook(projectId) {
    const response = await request({
      method: 'POST',
      path: '/v1/webhooks',
      body: {
        url: endpointUrl,
        events: ['deployment.promoted'],
        projectIds: [projectId],
      },
    });
    // A definite client rejection is the one create outcome that proves this
    // request made no provider write. Network failures, 5xx responses, and a
    // malformed success body are all ambiguous and require provider readback.
    if (!response.ok) {
      if (Number.isInteger(response.status) && response.status >= 400 && response.status < 500) {
        return { outcome: 'rejected', status: response.status };
      }
      return { outcome: 'ambiguous', status: response.status };
    }
    const providerWebhookId = webhookId(response.body);
    if (!providerWebhookId || !exactManagedWebhook(response.body, endpointUrl, projectId)) {
      return { outcome: 'ambiguous', status: response.status };
    }
    return {
      outcome: 'created',
      providerWebhookId,
      credential: credentialFromCreate(response.body),
    };
  }

  async function freshExactResource(projectId, providerWebhookId) {
    const listed = await list(projectId);
    if (!listed.ok) return { ok: false, readbackOk: false, webhooks: [], providerReadBackAt: '' };
    const webhook = listed.webhooks.find((candidate) =>
      webhookId(candidate) === providerWebhookId && exactManagedWebhook(candidate, endpointUrl, projectId),
    );
    return {
      ok: Boolean(webhook),
      readbackOk: true,
      webhook,
      webhooks: listed.webhooks,
      providerReadBackAt: listed.providerReadBackAt,
    };
  }

  function exactAbsentCompensationScope(webhooks, projectId, providerWebhookId, expectedRemainingProviderWebhookId) {
    const targetPresent = webhooks.some((candidate) => webhookId(candidate) === providerWebhookId);
    if (targetPresent) return { ok: false };
    // An initial attempt is safe to certify absent only if no same-target
    // webhook creates ambiguity in this exact provider-project scope. During a
    // replacement, the one retained old hook must itself be the unique exact
    // target; any extra or drifted target remains unsafe to repair.
    const absentProof = expectedRemainingProviderWebhookId
      ? exactReplacementOnly(webhooks, projectId, expectedRemainingProviderWebhookId, providerWebhookId)
      : targetMatchState(webhooks, endpointUrl, projectId).state === 'missing';
    return { ok: absentProof };
  }

  function exactRotationPair(webhooks, projectId, oldProviderWebhookId, newProviderWebhookId) {
    const targets = webhooks.filter((webhook) => webhookUrl(webhook) === endpointUrl);
    const exactIds = new Set(targets
      .filter((webhook) => exactManagedWebhook(webhook, endpointUrl, projectId))
      .map(webhookId));
    return targets.length === 2 &&
      exactIds.size === 2 &&
      exactIds.has(oldProviderWebhookId) &&
      exactIds.has(newProviderWebhookId);
  }

  function exactReplacementOnly(webhooks, projectId, providerWebhookId, retiredProviderWebhookId = '') {
    const match = targetMatchState(webhooks, endpointUrl, projectId);
    const retiredAbsent = !retiredProviderWebhookId ||
      !webhooks.some((webhook) => webhookId(webhook) === retiredProviderWebhookId);
    return match.state === 'exact' &&
      webhookId(match.webhook) === providerWebhookId &&
      retiredAbsent;
  }

  async function compensateKnownResource({
    attemptId,
    projectId,
    providerWebhookId,
    expectedRemainingProviderWebhookId,
  }) {
    // Fresh readback is non-negotiable: a provider ID alone is never enough to
    // delete a resource. Verify it is still this adapter's exact target first.
    const current = await freshExactResource(projectId, providerWebhookId);
    if (!current.ok) {
      const absent = current.readbackOk
        ? exactAbsentCompensationScope(
          current.webhooks,
          projectId,
          providerWebhookId,
          expectedRemainingProviderWebhookId,
        )
        : { ok: false };
      return absent.ok
        ? {
          ok: true,
          writesPerformed: false,
          providerReadBackAt: current.providerReadBackAt,
          repairOutcome: 'provider_resource_absent',
        }
        : { ok: false, writesPerformed: false, providerReadBackAt: '', repairOutcome: '' };
    }
    if (expectedRemainingProviderWebhookId && !exactRotationPair(
      current.webhooks,
      projectId,
      expectedRemainingProviderWebhookId,
      providerWebhookId,
    )) return { ok: false, writesPerformed: false, providerReadBackAt: '', repairOutcome: '' };
    // A DELETE acknowledgement is not absence proof. Even a rejected or lost
    // response can race a concurrent removal, so always use a fresh provider
    // list to decide whether this exact attempt-owned target is now absent.
    const deleteAttempted = true;
    const deleteAcknowledged = await deleteWebhook(providerWebhookId);
    const after = await list(projectId);
    if (!after.ok) return { ok: false, writesPerformed: deleteAttempted, providerReadBackAt: '', repairOutcome: '' };
    let absent = false;
    if (expectedRemainingProviderWebhookId) {
      absent = exactReplacementOnly(
        after.webhooks,
        projectId,
        expectedRemainingProviderWebhookId,
        providerWebhookId,
      );
    } else {
      absent = !after.webhooks.some((webhook) => webhookId(webhook) === providerWebhookId);
    }
    return {
      ok: absent,
      writesPerformed: deleteAttempted,
      providerReadBackAt: absent ? after.providerReadBackAt : '',
      // A post-delete absence remains useful proof even if the delete response
      // was ambiguous. Do not overclaim which actor removed it in that case.
      repairOutcome: absent
        ? (deleteAcknowledged ? 'provider_resource_deleted' : 'provider_resource_absent')
        : '',
    };
  }

  async function compensateAfterFailure({
    attemptId,
    projectId,
    providerWebhookId,
    replacesProviderWebhookId,
    errorCode,
    publicReason = 'create_failed',
    expectedRemainingProviderWebhookId,
  }) {
    // The lifecycle callback revokes only the attempt's replacement credential.
    // It must acknowledge first; without that durable state we cannot safely
    // delete a cloud hook and leave credential ownership ambiguous.
    const acknowledged = await markDegraded(safeLifecyclePayload({
      attemptId,
      projectId,
      providerWebhookId,
      replacesProviderWebhookId,
      errorCode,
    }));
    if (!acknowledged) {
      return degraded('verification_failed', { requested: true, writesPerformed: true });
    }
    const compensated = await compensateKnownResource({
      attemptId,
      projectId,
      providerWebhookId,
      expectedRemainingProviderWebhookId,
    });
    if (!compensated.ok) {
      await markDegraded(safeLifecyclePayload({
        attemptId,
        projectId,
        providerWebhookId,
        replacesProviderWebhookId,
        errorCode: 'orphaned_external',
      }));
    }
    return degraded(publicReason, { requested: true, writesPerformed: true });
  }

  async function captureReplacementCredential({ attemptId, projectId, providerWebhookId, credential, replacesProviderWebhookId }) {
    // Provider readback happens before credential custody. A create response is
    // not enough proof that Vercel installed the exact project/event target.
    const fresh = await freshExactResource(projectId, providerWebhookId);
    if (!fresh.ok) return { ok: false, errorCode: 'provider_readback_failed', publicReason: 'verification_failed' };

    // This callback is the one and only credential handoff. The credential is
    // never passed to finalization, degradation, compensation, or a return.
    const captured = await callCallback(captureProviderGeneratedCredential, {
      ...safeLifecyclePayload({ attemptId, projectId, providerWebhookId, replacesProviderWebhookId }),
      credential,
    });
    if (!captured) {
      return { ok: false, errorCode: 'credential_upload_failed' };
    }

    return { ok: true, webhooks: fresh.webhooks, providerReadBackAt: fresh.providerReadBackAt };
  }

  async function finalizeReplacement({
    attemptId,
    projectId,
    providerWebhookId,
    replacesProviderWebhookId,
    providerReadBackAt,
    canonicalOrigins,
  }) {
    const exactOrigins = canonicalHttpsOrigins(canonicalOrigins);
    if (!providerReadBackAt || Number.isNaN(Date.parse(providerReadBackAt)) || exactOrigins.length === 0) {
      return { outcome: 'rejected', cleanupRequired: false, cleanupDebtId: '' };
    }
    const payload = safeLifecyclePayload({
      attemptId,
      projectId,
      providerWebhookId,
      replacesProviderWebhookId,
    });
    Object.assign(payload, {
      providerReadBackAt,
      providerProjectId: projectId,
      productionEnvironment: 'production',
      canonicalOrigins: exactOrigins,
      eventType: 'deployment.promoted',
      eventScope: 'project',
    });
    // A false/negative acknowledgement proves finalization was rejected. A
    // throw or lost callback response is different: it may have committed, so
    // callers must read the active binding before touching either cloud hook.
    try {
      const finalized = await finalizeProvisioning(payload);
      return {
        outcome: finalizationOutcome(finalized),
        cleanupRequired: finalized?.cleanupRequired === true || finalized?.cleanup_required === true,
        cleanupDebtId: safeIdentifier(finalized?.cleanupDebtId ?? finalized?.cleanup_debt_id),
      };
    } catch {
      return { outcome: 'ambiguous', cleanupRequired: false, cleanupDebtId: '' };
    }
  }

  async function completeCleanupDebt({
    cleanupDebtId,
    projectId,
    activeProviderWebhookId,
    cleanupTargetProviderWebhookId,
    providerReadBackAt,
  }) {
    if (!cleanupDebtId || !providerReadBackAt || Number.isNaN(Date.parse(providerReadBackAt)) ||
      typeof completeExternalCleanup !== 'function') return false;
    const retainedProviderWebhookId = safeIdentifier(activeProviderWebhookId);
    return await callCallback(completeExternalCleanup, {
      provider: 'vercel',
      ...(bindingId && { bindingId }),
      ...(pincushionProjectId && { projectId: pincushionProjectId }),
      providerProjectId: projectId,
      cleanupDebtId,
      ...(retainedProviderWebhookId && { activeProviderWebhookId: retainedProviderWebhookId }),
      cleanupTargetProviderWebhookId,
      providerReadBackAt,
      providerReadBackOutcome: retainedProviderWebhookId
        ? 'target_absent_retained_present'
        : 'target_absent',
    });
  }

  async function resolveAmbiguousCreate({ attemptId, projectId, existingProviderWebhookId }) {
    // Never issue a second create after an uncertain outcome. Fresh provider
    // readback decides whether the target is now an unmanaged/orphaned exact
    // hook, a conflicting target, or simply not observable yet.
    const after = await list(projectId);
    if (!after.ok) {
      await markDegraded(safeLifecyclePayload({
        attemptId,
        projectId,
        errorCode: 'provider_readback_failed',
      }));
      return degraded('verification_failed', { requested: true, writesPerformed: true });
    }
    // Rotation begins with a known active old hook. Seeing only that same hook
    // after an ambiguous replacement create means no replacement is observable;
    // it must not be mislabeled (or repaired) as an orphan from this attempt.
    if (existingProviderWebhookId && exactReplacementOnly(
      after.webhooks,
      projectId,
      existingProviderWebhookId,
    )) {
      await markDegraded(safeLifecyclePayload({
        attemptId,
        projectId,
        errorCode: 'provider_readback_failed',
      }));
      return degraded('verification_failed', { requested: true, writesPerformed: true });
    }
    if (existingProviderWebhookId) {
      const exactReplacement = after.webhooks.find((webhook) =>
        webhookId(webhook) !== existingProviderWebhookId && exactManagedWebhook(webhook, endpointUrl, projectId),
      );
      if (exactReplacement && exactRotationPair(
        after.webhooks,
        projectId,
        existingProviderWebhookId,
        webhookId(exactReplacement),
      )) {
        await markDegraded(safeLifecyclePayload({
          attemptId,
          projectId,
          providerWebhookId: webhookId(exactReplacement),
          replacesProviderWebhookId: existingProviderWebhookId,
          errorCode: 'orphaned_external',
        }));
        return degraded('verification_failed', { requested: true, writesPerformed: true });
      }
    }
    const match = targetMatchState(after.webhooks, endpointUrl, projectId);
    if (match.state === 'exact') {
      await markDegraded(safeLifecyclePayload({
        attemptId,
        projectId,
        providerWebhookId: webhookId(match.webhook),
        errorCode: 'orphaned_external',
      }));
      return degraded('verification_failed', { requested: true, writesPerformed: true });
    }
    if (match.state === 'conflict') {
      await markDegraded(safeLifecyclePayload({
        attemptId,
        projectId,
        errorCode: 'orphaned_external',
      }));
      return degraded('conflicting_existing_webhook', { requested: true, writesPerformed: true });
    }
    await markDegraded(safeLifecyclePayload({
      attemptId,
      projectId,
      errorCode: 'provider_readback_failed',
    }));
    return degraded('verification_failed', { requested: true, writesPerformed: true });
  }

  async function compensateReplacementBeforeOldRetirement({
    attemptId,
    projectId,
    oldProviderWebhookId,
    newProviderWebhookId,
    errorCode,
    publicReason = 'create_failed',
  }) {
    // Only retire the replacement when a fresh readback proves the old exact
    // hook remains active. If either target is uncertain, leave both external
    // resources unchanged rather than recording post-finalization cleanup debt
    // for an attempt that has not safely crossed finalization.
    const pair = await list(projectId);
    if (!pair.ok || !exactRotationPair(pair.webhooks, projectId, oldProviderWebhookId, newProviderWebhookId)) {
      return degraded('verification_failed', { requested: true, writesPerformed: true });
    }
    return await compensateAfterFailure({
      attemptId,
      projectId,
      providerWebhookId: newProviderWebhookId,
      replacesProviderWebhookId: oldProviderWebhookId,
      expectedRemainingProviderWebhookId: oldProviderWebhookId,
      errorCode,
      publicReason,
    });
  }

  async function inspect(context = {}) {
    const read = await readTarget(context);
    if (!read.ok) return degraded(read.reason, { requested: false, writesPerformed: false });
    if (read.match.state === 'conflict') {
      return degraded('conflicting_existing_webhook', { requested: false, writesPerformed: false });
    }
    if (read.match.state !== 'exact') return manual(false);
    const providerWebhookId = webhookId(read.match.webhook);
    if (!providerWebhookId || !await usableCredential({ projectId: read.projectId, providerWebhookId })) return manual(false);
    return redactProviderResult({ ...verified('already_configured', false), requested: false });
  }

  async function ensure(context = {}) {
    const requested = context?.deploymentAutomation === 'auto';
    if (!requested) return manual(false);
    const read = await readTarget(context);
    if (!read.ok) return degraded(read.reason, { requested: true, writesPerformed: false });
    if (read.match.state === 'conflict') return degraded('conflicting_existing_webhook', { requested: true, writesPerformed: false });
    if (read.match.state === 'exact') {
      const providerWebhookId = webhookId(read.match.webhook);
      if (providerWebhookId && await usableCredential({ projectId: read.projectId, providerWebhookId })) {
        return verified('already_configured', false);
      }
      // An active external target without a provable encrypted credential must
      // not be treated as managed, replaced, or duplicated.
      return manual(true);
    }
    if (!writeCapabilities(context)) return manual(true);

    const created = await createWebhook(read.projectId);
    if (created.outcome === 'rejected') {
      await markDegraded(safeLifecyclePayload({
        attemptId: context.attemptId,
        projectId: read.projectId,
        errorCode: 'provider_create_failed',
      }));
      return degraded('create_failed', { requested: true, writesPerformed: false });
    }
    if (created.outcome === 'ambiguous') {
      return await resolveAmbiguousCreate({
        attemptId: context.attemptId,
        projectId: read.projectId,
      });
    }
    if (!created.credential) {
      return await compensateAfterFailure({
        attemptId: context.attemptId,
        projectId: read.projectId,
        providerWebhookId: created.providerWebhookId,
        errorCode: 'credential_upload_failed',
        publicReason: 'create_failed',
      });
    }
    const captured = await captureReplacementCredential({
      attemptId: context.attemptId,
      projectId: read.projectId,
      providerWebhookId: created.providerWebhookId,
      credential: created.credential,
    });
    if (!captured.ok) {
      return await compensateAfterFailure({
        attemptId: context.attemptId,
        projectId: read.projectId,
        providerWebhookId: created.providerWebhookId,
        errorCode: captured.errorCode,
        publicReason: captured.publicReason || 'create_failed',
      });
    }
    const finalized = await finalizeReplacement({
      attemptId: context.attemptId,
      projectId: read.projectId,
      providerWebhookId: created.providerWebhookId,
      providerReadBackAt: captured.providerReadBackAt,
      canonicalOrigins: resolvedCanonicalOrigins(context),
    });
    if (finalized.outcome === 'rejected') {
      return await compensateAfterFailure({
        attemptId: context.attemptId,
        projectId: read.projectId,
        providerWebhookId: created.providerWebhookId,
        errorCode: 'finalize_failed',
      });
    }
    if (finalized.outcome === 'ambiguous') {
      // A lost finalizer response may already have persisted the new binding.
      // Only a matching usable binding plus fresh provider readback can settle
      // that uncertainty; otherwise leave the attempt-owned cloud hook intact.
      const active = await readUsableActiveBinding(read.projectId);
      const fresh = active.ok && active.providerWebhookId === created.providerWebhookId
        ? await freshExactResource(read.projectId, created.providerWebhookId)
        : { ok: false };
      if (!fresh.ok) return degraded('verification_failed', { requested: true, writesPerformed: true });
    }
    return verified('configured', true);
  }

  async function compensateAttempt(context = {}) {
    const requested = context?.deploymentAutomation === 'auto';
    const projectId = resolvedProjectId(configuredProjectId, context);
    // Compensation is an attempt-scoped lifecycle repair. Without the exact
    // Pincushion project and binding identities, even a read-only provider
    // lookup could target the wrong ownership scope, so do not contact Vercel.
    if (!requested || context?.writesAllowed !== true || !validAttemptId(context?.attemptId) ||
      !projectId || !endpointUrl || !pincushionProjectId || !bindingId ||
      typeof getAttemptOwnedWebhook !== 'function') {
      return manual(requested);
    }
    const ready = await cliReady();
    if (!ready.ok) return degraded(ready.reason, { requested: true, writesPerformed: false });
    let owned;
    try {
      owned = await getAttemptOwnedWebhook(safeLifecyclePayload({
        attemptId: context.attemptId,
        projectId,
      }));
    } catch {
      owned = null;
    }
    const providerWebhookId = safeIdentifier(owned?.providerWebhookId ?? owned?.webhookId ?? owned?.providerResourceId);
    const replacesProviderWebhookId = safeIdentifier(
      owned?.replacesProviderWebhookId ?? owned?.replaces_webhook_id ?? owned?.replacesProviderResourceId,
    );
    if (!providerWebhookId) return manual(true);

    const compensated = await compensateKnownResource({
      attemptId: context.attemptId,
      projectId,
      providerWebhookId,
      expectedRemainingProviderWebhookId: replacesProviderWebhookId || undefined,
    });
    if (!compensated.ok) {
      await markDegraded(safeLifecyclePayload({
        attemptId: context.attemptId,
        projectId,
        providerWebhookId,
        replacesProviderWebhookId,
        errorCode: 'orphaned_external',
      }));
      return degraded('verification_failed', { requested: true, writesPerformed: compensated.writesPerformed });
    }
    // This return travels only through the adapter's direct, internal repair
    // seam. The provider-neutral registry projects it through
    // `redactProviderResult`, which intentionally removes every identity and
    // readback field before it can reach a public response.
    return {
      ...degraded('safe_status_code', { requested: true, writesPerformed: compensated.writesPerformed }),
      projectId: pincushionProjectId,
      providerProjectId: projectId,
      bindingId,
      attemptId: safeIdentifier(context.attemptId),
      providerWebhookId,
      ...(replacesProviderWebhookId && { replacesProviderWebhookId }),
      providerReadBackAt: compensated.providerReadBackAt,
      repairOutcome: compensated.repairOutcome,
    };
  }

  async function recoverCleanup(context = {}) {
    const requested = context?.deploymentAutomation === 'auto';
    const projectId = resolvedProjectId(configuredProjectId, context);
    const requestedBindingId = safeIdentifier(context?.bindingId ?? context?.binding_id);
    const cleanupDebtId = safeIdentifier(context?.cleanupDebtId ?? context?.cleanup_debt_id);
    const activeProviderWebhookId = safeIdentifier(
      context?.activeProviderWebhookId ?? context?.active_provider_webhook_id,
    );
    const cleanupTargetProviderWebhookId = safeIdentifier(
      context?.cleanupTargetProviderWebhookId ?? context?.cleanup_target_provider_webhook_id,
    );
    const authorized = requested &&
      context?.provider === 'vercel' &&
      context?.ownerConsent === true &&
      context?.ownerAuthorized === true &&
      context?.writesAllowed === true &&
      context?.confirmed === true &&
      context?.cleanupOnly === true;
    if (!authorized || !projectId || !pincushionProjectId || !endpointUrl || !bindingId || requestedBindingId !== bindingId ||
      !cleanupDebtId || !cleanupTargetProviderWebhookId ||
      (activeProviderWebhookId && activeProviderWebhookId === cleanupTargetProviderWebhookId) ||
      typeof completeExternalCleanup !== 'function' || typeof getCleanupDebt !== 'function') {
      return manual(requested);
    }

    let debt;
    try {
      debt = await getCleanupDebt({
        projectId: pincushionProjectId,
        providerProjectId: projectId,
        provider: 'vercel',
        bindingId,
        cleanupDebtId,
        ...(activeProviderWebhookId && { activeProviderWebhookId }),
        cleanupTargetProviderWebhookId,
        deploymentAutomation: 'auto',
        ownerConsent: true,
        ownerAuthorized: true,
        writesAllowed: true,
        confirmed: true,
        cleanupOnly: true,
      });
    } catch {
      debt = null;
    }
    const debtBindingId = safeIdentifier(debt?.bindingId ?? debt?.binding_id);
    const debtProjectId = safeIdentifier(debt?.projectId ?? debt?.project_id);
    const debtCleanupId = safeIdentifier(debt?.cleanupDebtId ?? debt?.cleanup_debt_id);
    const debtActiveId = safeIdentifier(debt?.activeProviderWebhookId ?? debt?.active_provider_webhook_id);
    const debtTargetId = safeIdentifier(
      debt?.cleanupTargetProviderWebhookId ?? debt?.cleanup_target_provider_webhook_id,
    );
    const cleanupKind = debt?.cleanupKind ?? debt?.cleanup_kind;
    const exactDebt = debt?.ok === true && debt?.cleanupRequired === true &&
      (cleanupKind === 'rotation' || cleanupKind === 'revocation') && debt?.provider === 'vercel' &&
      debtBindingId === bindingId && debtProjectId === pincushionProjectId && debtCleanupId === cleanupDebtId &&
      debtTargetId === cleanupTargetProviderWebhookId;
    const exactRotationDebt = cleanupKind === 'rotation' && Boolean(activeProviderWebhookId) &&
      debtActiveId === activeProviderWebhookId && debtActiveId !== debtTargetId;
    const exactRevocationDebt = cleanupKind === 'revocation' && !activeProviderWebhookId && !debtActiveId;
    if (!exactDebt || (!exactRotationDebt && !exactRevocationDebt)) {
      return degraded('verification_failed', { requested: true, writesPerformed: false });
    }

    const ready = await cliReady();
    if (!ready.ok) return degraded(ready.reason, { requested: true, writesPerformed: false });

    // Recovery begins from the durable lifecycle debt and exact owner scope.
    // Rotation requires an exact old/new pair (or old absent/new retained).
    // Revocation has no retained identity: it may delete only its exact target
    // after a fresh target readback, then must prove that target absent.
    const before = await list(projectId);
    if (!before.ok) return degraded('verification_failed', { requested: true, writesPerformed: false });
    let completionReadBackAt = before.providerReadBackAt;
    if (exactRotationDebt) {
      if (!exactReplacementOnly(
        before.webhooks,
        projectId,
        activeProviderWebhookId,
        cleanupTargetProviderWebhookId,
      )) {
        if (!exactRotationPair(
          before.webhooks,
          projectId,
          cleanupTargetProviderWebhookId,
          activeProviderWebhookId,
        )) {
          return degraded('verification_failed', { requested: true, writesPerformed: false });
        }
        // A DELETE response is not proof. Always perform a second exact
        // readback and leave the durable debt pending on any ambiguity.
        await deleteWebhook(cleanupTargetProviderWebhookId);
        const after = await list(projectId);
        if (!after.ok || !exactReplacementOnly(
          after.webhooks,
          projectId,
          activeProviderWebhookId,
          cleanupTargetProviderWebhookId,
        )) {
          return degraded('verification_failed', { requested: true, writesPerformed: true });
        }
        completionReadBackAt = after.providerReadBackAt;
      }
    } else {
      const targetBeforeDelete = before.webhooks.find((webhook) =>
        webhookId(webhook) === cleanupTargetProviderWebhookId &&
        exactManagedWebhook(webhook, endpointUrl, projectId),
      );
      const targetAlreadyAbsent = !before.webhooks.some((webhook) =>
        webhookId(webhook) === cleanupTargetProviderWebhookId,
      );
      if (!targetAlreadyAbsent) {
        if (!targetBeforeDelete) {
          return degraded('verification_failed', { requested: true, writesPerformed: false });
        }
        await deleteWebhook(cleanupTargetProviderWebhookId);
        const after = await list(projectId);
        if (!after.ok || after.webhooks.some((webhook) => webhookId(webhook) === cleanupTargetProviderWebhookId)) {
          return degraded('verification_failed', { requested: true, writesPerformed: true });
        }
        completionReadBackAt = after.providerReadBackAt;
      }
    }

    const completed = await completeCleanupDebt({
      cleanupDebtId,
      projectId,
      ...(activeProviderWebhookId && { activeProviderWebhookId }),
      cleanupTargetProviderWebhookId,
      providerReadBackAt: completionReadBackAt,
    });
    if (!completed) return degraded('verification_failed', { requested: true, writesPerformed: true });
    return exactRotationDebt
      ? verified('configured', true)
      : degraded('safe_status_code', { requested: true, writesPerformed: true });
  }

  async function rotate(context = {}) {
    const requested = context?.deploymentAutomation === 'auto';
    // This adapter-local recovery method is not a public registry entrypoint.
    // A future owner-consented orchestration path must supply the existing
    // write/confirmation gates plus the idempotent cleanup-record capability.
    if (!requested || context?.confirmed !== true || !rotateCapabilities(context) || typeof getActiveBinding !== 'function') {
      return manual(requested);
    }
    const read = await readTarget(context);
    if (!read.ok) return degraded(read.reason, { requested: true, writesPerformed: false });
    if (read.match.state === 'conflict' || read.match.state === 'missing') {
      return read.match.state === 'conflict'
        ? degraded('conflicting_existing_webhook', { requested: true, writesPerformed: false })
        : manual(true);
    }

    const active = await readUsableActiveBinding(read.projectId);
    const oldProviderWebhookId = active.providerWebhookId;
    if (!active.ok || webhookId(read.match.webhook) !== oldProviderWebhookId) {
      return manual(true);
    }

    const created = await createWebhook(read.projectId);
    if (created.outcome === 'rejected') {
      await markDegraded(safeLifecyclePayload({
        attemptId: context.attemptId,
        projectId: read.projectId,
        errorCode: 'provider_create_failed',
      }));
      return degraded('create_failed', { requested: true, writesPerformed: false });
    }
    if (created.outcome === 'ambiguous') {
      return await resolveAmbiguousCreate({
        attemptId: context.attemptId,
        projectId: read.projectId,
        existingProviderWebhookId: oldProviderWebhookId,
      });
    }
    if (created.providerWebhookId === oldProviderWebhookId) {
      return degraded('create_failed', { requested: true, writesPerformed: true });
    }
    if (!created.credential) {
      return await compensateReplacementBeforeOldRetirement({
        attemptId: context.attemptId,
        projectId: read.projectId,
        oldProviderWebhookId,
        newProviderWebhookId: created.providerWebhookId,
        errorCode: 'credential_upload_failed',
      });
    }
    const captured = await captureReplacementCredential({
      attemptId: context.attemptId,
      projectId: read.projectId,
      providerWebhookId: created.providerWebhookId,
      credential: created.credential,
      replacesProviderWebhookId: oldProviderWebhookId,
    });
    if (!captured.ok) {
      // The old credential remains usable until provider readback proves it
      // retired; at this phase only the replacement may be compensated.
      return await compensateReplacementBeforeOldRetirement({
        attemptId: context.attemptId,
        projectId: read.projectId,
        oldProviderWebhookId,
        newProviderWebhookId: created.providerWebhookId,
        errorCode: captured.errorCode,
        publicReason: captured.publicReason || 'create_failed',
      });
    }

    // The replacement credential is captured, but the cloud binding remains
    // unfinalized. Verify both exact hooks before finalizing the new binding,
    // so a pre-finalization failure can revoke only the replacement and leave
    // the old delivery path active.
    const beforeOldDelete = await list(read.projectId);
    if (!beforeOldDelete.ok || !exactRotationPair(
      beforeOldDelete.webhooks,
      read.projectId,
      oldProviderWebhookId,
      created.providerWebhookId,
    )) {
      // The replacement is credential-stored but not finalized. Do not turn a
      // missing pair proof into post-finalization cleanup debt; preserve both
      // cloud resources for owner repair instead.
      return degraded('verification_failed', { requested: true, writesPerformed: true });
    }

    // Finalization atomically promotes the newly captured credential/binding
    // while the old cloud webhook is still present. It receives the exact old
    // resource identity so lifecycle storage can persist the replacement edge.
    // A failure here remains safely compensable because the old path is intact.
    const finalized = await finalizeReplacement({
      attemptId: context.attemptId,
      projectId: read.projectId,
      providerWebhookId: created.providerWebhookId,
      replacesProviderWebhookId: oldProviderWebhookId,
      providerReadBackAt: beforeOldDelete.providerReadBackAt,
      canonicalOrigins: resolvedCanonicalOrigins(context),
    });
    if (finalized.outcome === 'rejected') {
      return await compensateReplacementBeforeOldRetirement({
        attemptId: context.attemptId,
        projectId: read.projectId,
        oldProviderWebhookId,
        newProviderWebhookId: created.providerWebhookId,
        errorCode: 'finalize_failed',
      });
    }
    let rotationCleanupDebtId = finalized.cleanupRequired ? finalized.cleanupDebtId : '';
    if (finalized.outcome === 'ambiguous') {
      const readback = await readUsableActiveBinding(read.projectId);
      if (readback.ok && readback.providerWebhookId === oldProviderWebhookId) {
        return await compensateReplacementBeforeOldRetirement({
          attemptId: context.attemptId,
          projectId: read.projectId,
          oldProviderWebhookId,
          newProviderWebhookId: created.providerWebhookId,
          errorCode: 'finalize_failed',
        });
      }
      if (!readback.ok || readback.providerWebhookId !== created.providerWebhookId) {
        // A lost finalizer response whose active binding cannot be classified
        // is neither a confirmed old-active replacement nor a confirmed new
        // binding. Delete neither and never create cleanup debt for it.
        return degraded('verification_failed', { requested: true, writesPerformed: true });
      }
      if (readback.cleanupTargetProviderWebhookId !== oldProviderWebhookId) {
        return degraded('verification_failed', { requested: true, writesPerformed: true });
      }
      rotationCleanupDebtId = readback.cleanupDebtId;
    }
    // The old external hook may be deleted only after the same transaction
    // that promoted the replacement durably recorded its exact cleanup debt.
    if (!rotationCleanupDebtId) {
      return degraded('verification_failed', { requested: true, writesPerformed: true });
    }

    // Finalization is committed (or active-binding readback proved it did).
    // Refresh the exact pair before old cleanup, because finalization may have
    // taken time and no delete is safe against stale cloud state. If Vercel
    // already retired old, the exact new-only readback completes successfully.
    const beforeOldCleanup = await list(read.projectId);
    if (!beforeOldCleanup.ok) {
      return degraded('verification_failed', { requested: true, writesPerformed: true });
    }
    if (exactReplacementOnly(
      beforeOldCleanup.webhooks,
      read.projectId,
      created.providerWebhookId,
      oldProviderWebhookId,
    )) {
      const completed = await completeCleanupDebt({
        cleanupDebtId: rotationCleanupDebtId,
        projectId: read.projectId,
        activeProviderWebhookId: created.providerWebhookId,
        cleanupTargetProviderWebhookId: oldProviderWebhookId,
        providerReadBackAt: beforeOldCleanup.providerReadBackAt,
      });
      return completed
        ? verified('configured', true)
        : degraded('verification_failed', { requested: true, writesPerformed: true });
    }
    if (!exactRotationPair(
      beforeOldCleanup.webhooks,
      read.projectId,
      oldProviderWebhookId,
      created.providerWebhookId,
    )) {
      return degraded('verification_failed', { requested: true, writesPerformed: true });
    }

    // Read back even if DELETE itself rejects/times out: the response alone
    // cannot establish old cleanup. From here onward, never degrade/compensate
    // the new binding.
    await deleteWebhook(oldProviderWebhookId);
    const afterOldDelete = await list(read.projectId);
    if (!afterOldDelete.ok) {
      return degraded('verification_failed', { requested: true, writesPerformed: true });
    }
    if (!exactReplacementOnly(
      afterOldDelete.webhooks,
      read.projectId,
      created.providerWebhookId,
      oldProviderWebhookId,
    )) {
      return degraded('verification_failed', { requested: true, writesPerformed: true });
    }
    const completed = await completeCleanupDebt({
      cleanupDebtId: rotationCleanupDebtId,
      projectId: read.projectId,
      activeProviderWebhookId: created.providerWebhookId,
      cleanupTargetProviderWebhookId: oldProviderWebhookId,
      providerReadBackAt: afterOldDelete.providerReadBackAt,
    });
    return completed
      ? verified('configured', true)
      : degraded('verification_failed', { requested: true, writesPerformed: true });
  }

  return Object.freeze({
    id: 'vercel',
    inspect,
    ensure,
    compensateAttempt,
    recoverCleanup,
    rotate,
  });
}

/**
 * Compatibility facade for existing callers. It remains deliberately
 * read-oriented: legacy call sites do not have the attempt-scoped lifecycle
 * callbacks required to custody a one-time secret safely, so they can inspect
 * and return a manual handoff but cannot create or replace a Vercel webhook.
 */
export async function ensureVercelDeploymentWebhook({
  cwd,
  projectId,
  pincushionProjectId,
  endpointUrl,
  canonicalOrigins,
  orgId,
  run = runVercelCli,
  timeoutMs,
  bindingId,
  attemptId,
  deploymentAutomation,
  ownerConsent,
  captureProviderGeneratedCredential,
  finalizeProvisioning,
  markAttemptDegraded,
  completeExternalCleanup,
  hasUsableCredential,
  transport,
} = {}) {
  const managedLegacyConsent = deploymentAutomation === 'auto' && ownerConsent === true;
  const adapter = createVercelDeploymentAdapter({
    cwd,
    projectId,
    pincushionProjectId: managedLegacyConsent ? pincushionProjectId : undefined,
    endpointUrl,
    orgId,
    timeoutMs,
    run,
    bindingId: managedLegacyConsent ? bindingId : undefined,
    canonicalOrigins: managedLegacyConsent ? canonicalOrigins : undefined,
    transport,
    captureProviderGeneratedCredential: managedLegacyConsent ? captureProviderGeneratedCredential : undefined,
    finalizeProvisioning: managedLegacyConsent ? finalizeProvisioning : undefined,
    markAttemptDegraded: managedLegacyConsent ? markAttemptDegraded : undefined,
    completeExternalCleanup: managedLegacyConsent ? completeExternalCleanup : undefined,
    hasUsableCredential: managedLegacyConsent ? hasUsableCredential : undefined,
  });
  return await adapter.ensure({
    projectId,
    // Core's historical facade invokes this only after its own explicit
    // `deploymentAutomation: "auto"` choice. Retain that response shape while
    // stripping every write capability unless this caller also supplied an
    // explicit owner-consented managed lifecycle.
    deploymentAutomation: 'auto',
    // With no binding/callbacks this does not grant any write capability; the
    // factory gate above returns manual after readback. Explicit future callers
    // still need every managed lifecycle capability to pass that gate.
    writesAllowed: true,
    attemptId,
    canonicalOrigins,
  });
}
