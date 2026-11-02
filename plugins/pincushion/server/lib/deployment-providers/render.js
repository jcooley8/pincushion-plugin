// Render Standard Webhooks deployment adapter.
//
// This module deliberately has no ambient credentials, fetch implementation, or
// registry registration. A trusted host must explicitly inject both the current
// official Render API seam and the owner lifecycle callbacks. That keeps an
// unsupported/partially configured Render project on the manual path instead of
// accidentally creating a workspace-wide destination.

import { redactProviderResult } from './contracts.js';
import { buildManualProviderResult } from './manual.js';

const MAX_IDENTIFIER_LENGTH = 512;
const MAX_ENDPOINT_LENGTH = 2_000;
const RENDER_WEBHOOK_ID = /^whk-[0-9a-z]{20}$/;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@/+=-]{0,511}$/;
const RENDER_EVENT = 'deploy_ended';
const PRODUCTION_ENVIRONMENT = 'production';
const PINCUSHION_RENDER_WEBHOOK_NAME = 'Pincushion production deployment receiver';
// Render's list endpoints return one cursor per item rather than a separate
// page envelope. Keep the page size explicit so a full page always proves that
// another request is required, and bound traversal before any write can occur.
const RENDER_WEBHOOK_PAGE_LIMIT = 100;
const MAX_RENDER_WEBHOOK_PAGES = 32;
const MAX_RENDER_WEBHOOK_ITEMS = 512;

function text(value, max = 300) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function safeIdentifier(value, max = MAX_IDENTIFIER_LENGTH) {
  const candidate = text(value, max);
  return candidate && SAFE_IDENTIFIER.test(candidate) ? candidate : '';
}

function safeWebhookId(value) {
  const candidate = text(value, 64);
  return RENDER_WEBHOOK_ID.test(candidate) ? candidate : '';
}

function validEndpoint(value) {
  const endpoint = text(value, MAX_ENDPOINT_LENGTH);
  if (!endpoint) return '';
  try {
    const parsed = new URL(endpoint);
    return parsed.protocol === 'https:' && parsed.hostname && !parsed.username && !parsed.password
      ? endpoint
      : '';
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

function validAttemptId(value) {
  return Boolean(safeIdentifier(value));
}

function validBase64(value) {
  if (typeof value !== 'string' || !value || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const padding = value.match(/=+$/)?.[0] || '';
  const unpadded = value.slice(0, value.length - padding.length);
  if (!unpadded || unpadded.length % 4 === 1) return false;
  const requiredPadding = (4 - (unpadded.length % 4)) % 4;
  if (padding && padding.length !== requiredPadding) return false;
  try {
    // Keep this in lockstep with the native receiver's base64Bytes parser:
    // Render Standard Webhooks use the decoded bytes after `whsec_` as the
    // HMAC key, so a syntactically plausible string is not enough.
    atob(unpadded + '='.repeat(requiredPadding));
    return true;
  } catch {
    return false;
  }
}

function validSecret(value) {
  return typeof value === 'string' && value.length > 'whsec_'.length && value.length <= 8_192 &&
    value.startsWith('whsec_') && validBase64(value.slice('whsec_'.length));
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
    ok: status >= 200 && status < 300,
    status,
    body: value.body,
    ambiguous: false,
  };
}

function exactRenderWebhook(webhook, endpointUrl, webhookName) {
  return Boolean(webhook) && typeof webhook === 'object' &&
    Boolean(safeWebhookId(webhook.id)) &&
    text(webhook.name, 200) === webhookName &&
    text(webhook.url, MAX_ENDPOINT_LENGTH) === endpointUrl &&
    webhook.enabled === true &&
    Array.isArray(webhook.eventFilter) && webhook.eventFilter.length === 1 && webhook.eventFilter[0] === RENDER_EVENT;
}

function parseWebhookPage(body) {
  // Render's current official list schema is an array of required
  // `{ webhook, cursor }` wrappers. Do not accept the older/raw webhook array
  // or a similarly shaped arbitrary object: missing inventory is unsafe when
  // the workspace can support only one destination.
  if (!Array.isArray(body) || body.length > RENDER_WEBHOOK_PAGE_LIMIT) return null;
  const webhooks = [];
  const cursors = [];
  for (const entry of body) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) ||
      !Object.prototype.hasOwnProperty.call(entry, 'webhook') ||
      !Object.prototype.hasOwnProperty.call(entry, 'cursor') ||
      !entry.webhook || typeof entry.webhook !== 'object' || Array.isArray(entry.webhook) ||
      typeof entry.cursor !== 'string' || entry.cursor.length === 0 ||
      entry.cursor.length > MAX_IDENTIFIER_LENGTH || entry.cursor.trim().length === 0) {
      return null;
    }
    webhooks.push(entry.webhook);
    // Cursors are opaque provider values. Preserve them byte-for-byte for the
    // next query, while still rejecting repeated/non-progressing values.
    cursors.push(entry.cursor);
  }
  return { webhooks, cursors };
}

function verified(status, writesPerformed) {
  return redactProviderResult({
    requested: true,
    provider: 'render',
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
    provider: 'render',
    status: 'degraded',
    reason,
    writesPerformed,
  });
}

function conflict(requested) {
  return redactProviderResult({
    requested,
    provider: 'render',
    status: 'conflict',
    reason: 'conflicting_existing_webhook',
    writesPerformed: false,
  });
}

function manual(requested) {
  return redactProviderResult(buildManualProviderResult({ provider: 'render', requested }));
}

function callbackSucceeded(value) {
  return value === true || (value && typeof value === 'object' && value.ok === true);
}

function finalizationOutcome(value) {
  if (callbackSucceeded(value)) return 'committed';
  if (value === false || (value && typeof value === 'object' && value.ok === false)) return 'rejected';
  return 'ambiguous';
}

async function callCallback(callback, payload) {
  if (typeof callback !== 'function') return { ok: false, value: undefined };
  try {
    const value = await callback(payload);
    return { ok: callbackSucceeded(value), value };
  } catch {
    return { ok: false, value: undefined };
  }
}

/**
 * Create an explicit Render adapter. The caller owns transport authentication
 * and must only supply an `officialRenderApi` transport which implements the
 * documented Render REST operations used below. This factory does not perform
 * any I/O by itself.
 */
export function createRenderDeploymentAdapter({
  endpointUrl: rawEndpointUrl,
  ownerId: rawOwnerId,
  projectId: rawProjectId,
  serviceId: rawServiceId,
  environmentId: rawEnvironmentId,
  pincushionProjectId: rawPincushionProjectId,
  bindingId: rawBindingId,
  canonicalOrigins: rawCanonicalOrigins,
  webhookName: rawWebhookName,
  transport,
  readCapability,
  captureProviderGeneratedCredential,
  finalizeProvisioning,
  markAttemptDegraded,
  hasUsableCredential,
  getAttemptOwnedWebhook,
  getActiveBinding,
} = {}) {
  const endpointUrl = validEndpoint(rawEndpointUrl);
  const ownerId = safeIdentifier(rawOwnerId);
  const configuredProjectId = safeIdentifier(rawProjectId);
  const serviceId = safeIdentifier(rawServiceId);
  const environmentId = safeIdentifier(rawEnvironmentId);
  const pincushionProjectId = safeIdentifier(rawPincushionProjectId);
  const bindingId = safeIdentifier(rawBindingId);
  const configuredCanonicalOrigins = canonicalHttpsOrigins(rawCanonicalOrigins);
  // A predictable fixed name is part of the exact destination identity. Do
  // not let a caller insert arbitrary setup text into a provider resource.
  const webhookName = rawWebhookName === undefined
    ? PINCUSHION_RENDER_WEBHOOK_NAME
    : (text(rawWebhookName, 200) === PINCUSHION_RENDER_WEBHOOK_NAME ? PINCUSHION_RENDER_WEBHOOK_NAME : '');
  const officialTransport = typeof transport === 'function' &&
    transport.officialRenderApi === true && transport.structuredSecretResponse === true;

  function resolvedProjectId(context = {}) {
    const contextual = safeIdentifier(
      context.providerProjectId ?? context.provider_project_id ?? context.projectId ?? context.project_id,
    );
    if (configuredProjectId && contextual && configuredProjectId !== contextual) return '';
    return configuredProjectId || contextual;
  }

  function resolvedCanonicalOrigins(context = {}) {
    const hasContextualOrigins = Object.prototype.hasOwnProperty.call(context, 'canonicalOrigins') ||
      Object.prototype.hasOwnProperty.call(context, 'canonical_origins');
    const contextual = canonicalHttpsOrigins(context.canonicalOrigins ?? context.canonical_origins);
    if (hasContextualOrigins && contextual.length === 0) return [];
    if (configuredCanonicalOrigins.length && contextual.length &&
      !sameStringList(configuredCanonicalOrigins, contextual)) return [];
    return configuredCanonicalOrigins.length ? configuredCanonicalOrigins : contextual;
  }

  function configuredScope(context = {}) {
    const projectId = resolvedProjectId(context);
    return endpointUrl && ownerId && projectId && serviceId && environmentId && webhookName &&
      pincushionProjectId && bindingId && resolvedCanonicalOrigins(context).length > 0
      ? { projectId }
      : null;
  }

  function provisioningCapabilities(context = {}) {
    return context.deploymentAutomation === 'auto' &&
      context.writesAllowed === true &&
      validAttemptId(context.attemptId) &&
      Boolean(configuredScope(context)) &&
      officialTransport &&
      typeof readCapability === 'function' &&
      typeof captureProviderGeneratedCredential === 'function' &&
      typeof finalizeProvisioning === 'function' &&
      typeof markAttemptDegraded === 'function' &&
      // A lost finalization response cannot be safely compensated unless the
      // owner lifecycle can tell whether this exact new binding became active.
      typeof getActiveBinding === 'function';
  }

  function compensationCapabilities(context = {}) {
    return context.deploymentAutomation === 'auto' &&
      context.writesAllowed === true &&
      validAttemptId(context.attemptId) &&
      Boolean(configuredScope(context)) &&
      officialTransport &&
      typeof readCapability === 'function' &&
      typeof markAttemptDegraded === 'function' &&
      typeof getAttemptOwnedWebhook === 'function';
  }

  async function request(requestOptions) {
    try {
      return responseShape(await transport(requestOptions));
    } catch {
      // A timeout or thrown transport error never proves whether a provider
      // mutation happened. Callers either read back the exact known ID or stop
      // in degraded/manual state without retrying a write.
      return { ok: false, status: undefined, body: undefined, ambiguous: true };
    }
  }

  async function readWorkspaceCapability(projectId) {
    if (typeof readCapability !== 'function') return { ok: false };
    let capability;
    try {
      capability = await readCapability({
        provider: 'render',
        ownerId,
        projectId,
        serviceId,
        environmentId,
        productionEnvironment: PRODUCTION_ENVIRONMENT,
        eventType: RENDER_EVENT,
        requiredDestinationLimit: 1,
      });
    } catch {
      return { ok: false };
    }
    const exact = capability && typeof capability === 'object' &&
      capability.ok === true &&
      safeIdentifier(capability.ownerId) === ownerId &&
      capability.callerRole === 'ADMIN' &&
      safeIdentifier(capability.projectId) === projectId &&
      safeIdentifier(capability.serviceId) === serviceId &&
      safeIdentifier(capability.environmentId) === environmentId &&
      capability.productionEnvironment === PRODUCTION_ENVIRONMENT &&
      capability.destinationInventoryComplete === true &&
      capability.destinationLimit === 1 &&
      Number.isSafeInteger(capability.destinationCount) &&
      capability.destinationCount >= 0 && capability.destinationCount <= 1;
    return exact ? { ok: true, destinationCount: capability.destinationCount } : { ok: false };
  }

  async function listWebhooks() {
    const webhooks = [];
    const seenCursors = new Set();
    let cursor = '';
    let pagesRead = 0;
    while (pagesRead < MAX_RENDER_WEBHOOK_PAGES) {
      if (webhooks.length >= MAX_RENDER_WEBHOOK_ITEMS) {
        return { ok: false, webhooks: [], providerReadBackAt: '', reason: 'webhook_inventory_incomplete' };
      }
      const params = new URLSearchParams({
        ownerId,
        limit: String(RENDER_WEBHOOK_PAGE_LIMIT),
      });
      if (cursor) params.set('cursor', cursor);
      const response = await request({
        method: 'GET',
        path: `/webhooks?${params.toString()}`,
      });
      if (!response.ok) {
        return { ok: false, webhooks: [], providerReadBackAt: '', reason: 'webhook_list_unavailable' };
      }
      const page = parseWebhookPage(response.body);
      if (!page) {
        return { ok: false, webhooks: [], providerReadBackAt: '', reason: 'webhook_list_malformed' };
      }
      if (webhooks.length + page.webhooks.length > MAX_RENDER_WEBHOOK_ITEMS) {
        return { ok: false, webhooks: [], providerReadBackAt: '', reason: 'webhook_inventory_incomplete' };
      }
      for (const pageCursor of page.cursors) {
        if (seenCursors.has(pageCursor) || pageCursor === cursor) {
          return { ok: false, webhooks: [], providerReadBackAt: '', reason: 'webhook_list_malformed' };
        }
        seenCursors.add(pageCursor);
      }
      webhooks.push(...page.webhooks);
      pagesRead += 1;

      // A short/empty page is terminal. A full page must provide a fresh
      // cursor; otherwise the inventory is ambiguous and no provider write is
      // allowed. The cursor on the final wrapper is the continuation token.
      if (page.webhooks.length < RENDER_WEBHOOK_PAGE_LIMIT) {
        return { ok: true, webhooks, providerReadBackAt: new Date().toISOString() };
      }
      const nextCursor = page.cursors[page.cursors.length - 1];
      if (!nextCursor || nextCursor === cursor) {
        return { ok: false, webhooks: [], providerReadBackAt: '', reason: 'webhook_list_malformed' };
      }
      cursor = nextCursor;
    }
    return { ok: false, webhooks: [], providerReadBackAt: '', reason: 'webhook_inventory_incomplete' };
  }

  async function readWebhook(providerWebhookId) {
    const response = await request({
      method: 'GET',
      path: `/webhooks/${encodeURIComponent(providerWebhookId)}`,
    });
    if (response.status === 404) return { ok: true, absent: true, providerReadBackAt: new Date().toISOString() };
    if (!response.ok || !exactRenderWebhook(response.body, endpointUrl, webhookName) ||
      safeWebhookId(response.body.id) !== providerWebhookId) {
      return { ok: false, absent: false, providerReadBackAt: '' };
    }
    return { ok: true, absent: false, providerReadBackAt: new Date().toISOString() };
  }

  async function deleteWebhook(providerWebhookId) {
    const response = await request({
      method: 'DELETE',
      path: `/webhooks/${encodeURIComponent(providerWebhookId)}`,
    });
    // The documented endpoint uses 204. A response alone never proves cleanup;
    // the caller always follows it with an exact GET absence readback.
    // `request` catches transport failures, but the DELETE was still attempted;
    // preserve that external-write fact for the public compensation result.
    return { ok: response.status === 204, writesPerformed: true };
  }

  function inventoryState(webhooks) {
    if (webhooks.length !== 0 && webhooks.length !== 1) return { state: 'conflict' };
    if (webhooks.length === 0) return { state: 'missing' };
    const webhook = webhooks[0];
    return exactRenderWebhook(webhook, endpointUrl, webhookName)
      ? { state: 'exact', providerWebhookId: safeWebhookId(webhook.id) }
      : { state: 'conflict' };
  }

  async function readState(context = {}) {
    const scope = configuredScope(context);
    if (!scope) return { ok: false, kind: 'manual' };
    const capability = await readWorkspaceCapability(scope.projectId);
    if (!capability.ok) return { ok: false, kind: 'manual' };
    const listed = await listWebhooks();
    if (!listed.ok) {
      // Keep provider-specific parser details private; only the contract's
      // stable machine codes cross the adapter boundary.
      const reason = listed.reason === 'webhook_list_unavailable'
        ? 'webhook_list_unavailable'
        : 'verification_failed';
      return { ok: false, kind: 'degraded', reason };
    }
    // The injected official capability must prove a complete inventory and the
    // live list must agree before a one-destination workspace is touched.
    if (listed.webhooks.length !== capability.destinationCount) {
      return { ok: false, kind: 'degraded', reason: 'verification_failed' };
    }
    return { ok: true, projectId: scope.projectId, ...inventoryState(listed.webhooks) };
  }

  function safeLifecyclePayload({ attemptId, projectId, providerWebhookId, errorCode } = {}) {
    return {
      provider: 'render',
      ...(bindingId ? { bindingId } : {}),
      ...(pincushionProjectId ? { projectId: pincushionProjectId } : {}),
      ...(validAttemptId(attemptId) ? { attemptId: safeIdentifier(attemptId) } : {}),
      ...(projectId ? { providerProjectId: projectId } : {}),
      ...(serviceId ? { providerResourceId: serviceId } : {}),
      ...(ownerId ? { providerAccountId: ownerId } : {}),
      ...(providerWebhookId ? { providerWebhookId } : {}),
      ...(errorCode ? { errorCode } : {}),
    };
  }

  async function markDegraded(payload) {
    return (await callCallback(markAttemptDegraded, payload)).ok;
  }

  async function usableCredential({ projectId, providerWebhookId }) {
    return (await callCallback(hasUsableCredential, safeLifecyclePayload({ projectId, providerWebhookId }))).ok;
  }

  async function activeBinding(projectId) {
    try {
      const value = await getActiveBinding(safeLifecyclePayload({ projectId }));
      const exactLifecycleBinding = value && typeof value === 'object' &&
        value.ok === true && value.provider === 'render' && value.state === 'active' &&
        safeIdentifier(value.bindingId ?? value.binding_id) === bindingId;
      return {
        ok: exactLifecycleBinding && value.credentialUsable === true,
        providerWebhookId: exactLifecycleBinding
          ? safeWebhookId(value.providerWebhookId ?? value.webhookId ?? value.providerResourceId)
          : '',
      };
    } catch {
      return { ok: false, providerWebhookId: '' };
    }
  }

  function attemptOwnedWebhook(value, attemptId) {
    // A repair callback must echo the exact lifecycle record it read. A bare
    // webhook ID is not enough authority to delete: it could describe an
    // already-finalized binding or a record from another attempt.
    if (!value || typeof value !== 'object' || value.ok !== true ||
      // The owner-sealed sync-annotations projection intentionally omits the
      // provider because this adapter is already bound to Render. If a
      // provider field is supplied by a test/transport, it must still agree.
      (value.provider !== undefined && value.provider !== 'render') ||
      safeIdentifier(value.bindingId ?? value.binding_id) !== bindingId ||
      safeIdentifier(value.attemptId ?? value.attempt_id) !== safeIdentifier(attemptId) ||
      value.state !== 'degraded') return '';
    return safeWebhookId(value.providerWebhookId ?? value.webhookId ?? value.providerResourceId);
  }

  async function createWebhook() {
    const response = await request({
      method: 'POST',
      path: '/webhooks',
      body: {
        ownerId,
        name: webhookName,
        url: endpointUrl,
        enabled: true,
        eventFilter: [RENDER_EVENT],
      },
    });
    if (response.status !== 201) {
      if (Number.isInteger(response.status) && response.status >= 400 && response.status < 500) {
        return { outcome: 'rejected' };
      }
      return { outcome: 'ambiguous' };
    }
    const providerWebhookId = safeWebhookId(response.body?.id);
    if (!providerWebhookId || !exactRenderWebhook(response.body, endpointUrl, webhookName)) {
      return { outcome: 'ambiguous' };
    }
    return {
      outcome: 'created',
      providerWebhookId,
      credential: validSecret(response.body?.secret) ? response.body.secret : '',
    };
  }

  async function freshSingleTarget(providerWebhookId) {
    const individual = await readWebhook(providerWebhookId);
    if (!individual.ok || individual.absent) return { ok: false, providerReadBackAt: '' };
    const listed = await listWebhooks();
    if (!listed.ok || listed.webhooks.length !== 1 || !exactRenderWebhook(listed.webhooks[0], endpointUrl, webhookName) ||
      safeWebhookId(listed.webhooks[0].id) !== providerWebhookId) {
      return { ok: false, providerReadBackAt: '' };
    }
    return { ok: true, providerReadBackAt: listed.providerReadBackAt };
  }

  async function compensateKnownWebhook({ attemptId, projectId, providerWebhookId, errorCode }) {
    // Persist fail-closed attempt state before deletion. If lifecycle state is
    // unavailable, keep the exact cloud destination intact for owner repair.
    if (!await markDegraded(safeLifecyclePayload({ attemptId, projectId, providerWebhookId, errorCode }))) {
      return { ok: false, writesPerformed: false };
    }
    const before = await readWebhook(providerWebhookId);
    if (!before.ok || before.absent) return { ok: false, writesPerformed: false };
    const deletion = await deleteWebhook(providerWebhookId);
    const after = await readWebhook(providerWebhookId);
    return {
      ok: deletion.ok && after.ok && after.absent,
      writesPerformed: deletion.writesPerformed,
    };
  }

  async function compensateAfterFailure({ attemptId, projectId, providerWebhookId, errorCode }) {
    const compensated = await compensateKnownWebhook({ attemptId, projectId, providerWebhookId, errorCode });
    // This path is entered only after a confirmed 201 create response. The
    // provider write is therefore true even when lifecycle marking or the
    // pre-delete readback blocks a compensating DELETE.
    if (!compensated.ok) {
      await markDegraded(safeLifecyclePayload({
        attemptId,
        projectId,
        providerWebhookId,
        errorCode: 'orphaned_external',
      }));
      return degraded('verification_failed', { requested: true, writesPerformed: true });
    }
    return degraded('create_failed', { requested: true, writesPerformed: true });
  }

  async function captureCredential({ attemptId, projectId, providerWebhookId, credential, providerReadBackAt }) {
    // The provider response secret is used exactly once here. It is excluded
    // from every other callback and every adapter result.
    return (await callCallback(captureProviderGeneratedCredential, {
      ...safeLifecyclePayload({ attemptId, projectId, providerWebhookId }),
      credential,
      providerReadBackAt,
    })).ok;
  }

  async function finalize({ attemptId, projectId, providerWebhookId, providerReadBackAt, canonicalOrigins }) {
    const exactOrigins = canonicalHttpsOrigins(canonicalOrigins);
    if (!providerReadBackAt || Number.isNaN(Date.parse(providerReadBackAt)) || exactOrigins.length === 0) {
      return 'rejected';
    }
    try {
      const value = await finalizeProvisioning({
        ...safeLifecyclePayload({ attemptId, projectId, providerWebhookId }),
        providerReadBackAt,
        productionEnvironment: PRODUCTION_ENVIRONMENT,
        canonicalOrigins: exactOrigins,
        eventType: RENDER_EVENT,
        eventScope: 'project',
      });
      return finalizationOutcome(value);
    } catch {
      return 'ambiguous';
    }
  }

  async function inspect(context = {}) {
    const state = await readState(context);
    if (!state.ok) {
      return state.kind === 'degraded'
        ? degraded(state.reason, { requested: false, writesPerformed: false })
        : manual(false);
    }
    if (state.state === 'conflict') return conflict(false);
    if (state.state !== 'exact' || !state.providerWebhookId) return manual(false);
    return await usableCredential({ projectId: state.projectId, providerWebhookId: state.providerWebhookId })
      ? redactProviderResult({ ...verified('already_configured', false), requested: false })
      : manual(false);
  }

  async function ensure(context = {}) {
    const requested = context.deploymentAutomation === 'auto';
    if (!requested) return manual(false);
    // Do not even read/create a provider destination if this adapter cannot
    // survive credential/finalization ambiguity with exact owner lifecycle
    // callbacks. This is the pre-write fail-closed boundary.
    if (!provisioningCapabilities(context)) return manual(true);
    const state = await readState(context);
    if (!state.ok) {
      return state.kind === 'degraded'
        ? degraded(state.reason, { requested: true, writesPerformed: false })
        : manual(true);
    }
    if (state.state === 'conflict') return conflict(true);
    if (state.state === 'exact') {
      return state.providerWebhookId && await usableCredential({ projectId: state.projectId, providerWebhookId: state.providerWebhookId })
        ? verified('already_configured', false)
        : manual(true);
    }

    const created = await createWebhook();
    if (created.outcome === 'rejected') {
      await markDegraded(safeLifecyclePayload({
        attemptId: context.attemptId,
        projectId: state.projectId,
        errorCode: 'provider_create_failed',
      }));
      return degraded('create_failed', { requested: true, writesPerformed: false });
    }
    if (created.outcome === 'ambiguous') {
      // No retry and no delete: without an exact response ID, a subsequently
      // observed destination cannot be proved to belong to this attempt.
      await markDegraded(safeLifecyclePayload({
        attemptId: context.attemptId,
        projectId: state.projectId,
        errorCode: 'provider_readback_failed',
      }));
      return degraded('verification_failed', { requested: true, writesPerformed: true });
    }

    const fresh = await freshSingleTarget(created.providerWebhookId);
    if (!fresh.ok || !created.credential) {
      return await compensateAfterFailure({
        attemptId: context.attemptId,
        projectId: state.projectId,
        providerWebhookId: created.providerWebhookId,
        errorCode: fresh.ok ? 'credential_upload_failed' : 'provider_readback_failed',
      });
    }
    if (!await captureCredential({
      attemptId: context.attemptId,
      projectId: state.projectId,
      providerWebhookId: created.providerWebhookId,
      credential: created.credential,
      providerReadBackAt: fresh.providerReadBackAt,
    })) {
      return await compensateAfterFailure({
        attemptId: context.attemptId,
        projectId: state.projectId,
        providerWebhookId: created.providerWebhookId,
        errorCode: 'credential_upload_failed',
      });
    }

    const finalized = await finalize({
      attemptId: context.attemptId,
      projectId: state.projectId,
      providerWebhookId: created.providerWebhookId,
      providerReadBackAt: fresh.providerReadBackAt,
      canonicalOrigins: resolvedCanonicalOrigins(context),
    });
    if (finalized === 'rejected') {
      return await compensateAfterFailure({
        attemptId: context.attemptId,
        projectId: state.projectId,
        providerWebhookId: created.providerWebhookId,
        errorCode: 'finalize_failed',
      });
    }
    if (finalized === 'ambiguous') {
      const active = await activeBinding(state.projectId);
      const confirmed = active.ok && active.providerWebhookId === created.providerWebhookId
        ? await freshSingleTarget(created.providerWebhookId)
        : { ok: false };
      // The owner lifecycle may already have committed the new credential. Do
      // not compensate/delete it unless an exact old-active state proves that.
      if (!confirmed.ok) return degraded('verification_failed', { requested: true, writesPerformed: true });
    }
    return verified('configured', true);
  }

  async function compensateAttempt(context = {}) {
    const requested = context.deploymentAutomation === 'auto';
    if (!requested || !compensationCapabilities(context)) return manual(requested);
    const scope = configuredScope(context);
    const capability = await readWorkspaceCapability(scope.projectId);
    if (!capability.ok) return manual(true);
    let owned;
    try {
      owned = await getAttemptOwnedWebhook(safeLifecyclePayload({ attemptId: context.attemptId, projectId: scope.projectId }));
    } catch {
      owned = null;
    }
    const providerWebhookId = attemptOwnedWebhook(owned, context.attemptId);
    if (!providerWebhookId) return manual(true);
    const compensated = await compensateKnownWebhook({
      attemptId: context.attemptId,
      projectId: scope.projectId,
      providerWebhookId,
      errorCode: 'attempt_compensation',
    });
    if (!compensated.ok) {
      await markDegraded(safeLifecyclePayload({
        attemptId: context.attemptId,
        projectId: scope.projectId,
        providerWebhookId,
        errorCode: 'orphaned_external',
      }));
      return degraded('verification_failed', { requested: true, writesPerformed: compensated.writesPerformed });
    }
    return degraded('safe_status_code', { requested: true, writesPerformed: compensated.writesPerformed });
  }

  // Render's current Standard Webhooks API does not provide an atomic
  // replacement + durable external-cleanup-debt protocol. Keep both actions
  // manual until an admitted lifecycle contract can prove that exact sequence.
  async function rotate(context = {}) {
    return manual(context.deploymentAutomation === 'auto');
  }

  async function recoverCleanup(context = {}) {
    return manual(context.deploymentAutomation === 'auto');
  }

  return Object.freeze({
    id: 'render',
    inspect,
    ensure,
    compensateAttempt,
    rotate,
    recoverCleanup,
  });
}
