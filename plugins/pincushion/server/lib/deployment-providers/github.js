// Injection-only GitHub repository deployment-status webhook adapter.
//
// It deliberately has no registry registration, no default credential lookup,
// and no network client. The caller supplies the official GitHub REST transport
// plus private lifecycle capabilities created by the owner binding factory.

import { redactProviderResult } from './contracts.js';
import { buildManualProviderResult } from './manual.js';

const GITHUB_API_VERSION = '2022-11-28';
const GITHUB_API_ORIGIN = 'https://api.github.com';
const HOOKS_PER_PAGE = 100;
const MAX_HOOK_PAGES = 20;
const MAX_COMPONENT_LENGTH = 100;
const MAX_ENDPOINT_LENGTH = 2_000;
const MAX_SECRET_LENGTH = 512;
const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const ALLOWED_LINK_RELATIONS = new Set(['next', 'prev', 'first', 'last']);

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function string(value, max) {
  if (typeof value !== 'string') return '';
  const result = value.trim();
  return result && result.length <= max ? result : '';
}

function repositoryComponent(value) {
  const result = string(value, MAX_COMPONENT_LENGTH);
  return result && COMPONENT.test(result) ? result : '';
}

function privateHttpsEndpoint(value) {
  const result = string(value, MAX_ENDPOINT_LENGTH);
  if (!result) return '';
  try {
    const parsed = new URL(result);
    return parsed.protocol === 'https:' && !parsed.username && !parsed.password && parsed.hostname && !parsed.hash
      ? parsed.toString()
      : '';
  } catch {
    return '';
  }
}

function validCanonicalOrigins(value) {
  if (!Array.isArray(value) || value.length === 0) return [];
  const origins = [];
  for (const item of value) {
    const result = string(item, MAX_ENDPOINT_LENGTH);
    if (!result) return [];
    try {
      const parsed = new URL(result);
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !parsed.hostname || parsed.origin !== result) return [];
      origins.push(parsed.origin);
    } catch {
      return [];
    }
  }
  return [...new Set(origins)].sort();
}

function validCredential(value) {
  return typeof value === 'string' && value === value.trim() && value.length >= 32 && value.length <= MAX_SECRET_LENGTH &&
    !/[\r\n]/.test(value) ? value : '';
}

function validTransport(value) {
  return isObject(value) && value.kind === 'github-rest' && value.apiVersion === GITHUB_API_VERSION && typeof value.request === 'function';
}

function accepted(value) {
  return isObject(value) && value.ok === true;
}

function manual(requested) {
  return redactProviderResult(buildManualProviderResult({ provider: 'github', requested }));
}

function degraded(reason, writesPerformed) {
  return redactProviderResult({
    requested: true,
    provider: 'github',
    status: 'degraded',
    reason,
    writesPerformed: Boolean(writesPerformed),
  });
}

function conflict() {
  return redactProviderResult({
    requested: true,
    provider: 'github',
    status: 'conflict',
    reason: 'conflicting_existing_webhook',
    writesPerformed: false,
  });
}

function verified(status, writesPerformed) {
  return redactProviderResult({
    requested: true,
    provider: 'github',
    status,
    verification: 'provider_readback',
    firstProductionReceipt: 'pending',
    ingestionMode: 'native_webhook',
    authenticationMethod: 'provider_signature',
    assuranceLevel: 'provider_verified',
    writesPerformed: Boolean(writesPerformed),
  });
}

function withPrivateRecoveryState(result, state) {
  // Registry/public result projection copies enumerable fields only. This small
  // non-enumerable marker lets the private orchestration boundary notice that
  // core minted a fresh callback capability without exposing IDs, a secret, or
  // the callback object to JSON/MCP callers.
  Object.defineProperty(result, 'recoveryState', {
    value: state,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}

function automationAuthorized(context) {
  return isObject(context) && context.deploymentAutomation === 'auto' && context.ownerConsent === true &&
    context.ownerAuthorized === true && context.writesAllowed === true;
}

function hookId(value) {
  return Number.isSafeInteger(value) && value > 0 ? String(value) : '';
}

function validEvents(value) {
  return Array.isArray(value) && value.length > 0 && value.length <= 100 &&
    value.every((event) => typeof event === 'string' && event.length > 0 && event.length <= 128) && new Set(value).size === value.length;
}

function validHook(value) {
  return isObject(value) && value.type === 'Repository' && hookId(value.id) && typeof value.name === 'string' && value.name.length > 0 &&
    typeof value.active === 'boolean' && validEvents(value.events) && isObject(value.config) && typeof value.config.url === 'string' &&
    value.config.url.length > 0 && value.config.url.length <= MAX_ENDPOINT_LENGTH && typeof value.config.content_type === 'string' &&
    ['0', '1', 0, 1].includes(value.config.insecure_ssl);
}

function exactHook(hook, endpoint) {
  return validHook(hook) && hook.name === 'web' && hook.active === true && hook.events.length === 1 &&
    hook.events[0] === 'deployment_status' && hook.config.url === endpoint && hook.config.content_type === 'json' &&
    (hook.config.insecure_ssl === '0' || hook.config.insecure_ssl === 0);
}

function sameReceiver(hook, endpoint) {
  return validHook(hook) && hook.config.url === endpoint;
}

function listHeader(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  if (!isObject(headers)) return '';
  const expected = name.toLowerCase();
  return Object.entries(headers).find(([key]) => key.toLowerCase() === expected)?.[1] || '';
}

function linkEntries(value) {
  const entries = [];
  let start = 0;
  let inAngle = false;
  let inQuotes = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (inQuotes) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inQuotes = false;
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      continue;
    }
    if (character === '<') {
      if (inAngle) return null;
      inAngle = true;
      continue;
    }
    if (character === '>') {
      if (!inAngle) return null;
      inAngle = false;
      continue;
    }
    if (character === ',' && !inAngle) {
      const entry = value.slice(start, index).trim();
      if (!entry) return null;
      entries.push(entry);
      start = index + 1;
    }
  }
  if (inAngle || inQuotes || escaped) return null;
  const finalEntry = value.slice(start).trim();
  if (!finalEntry) return null;
  entries.push(finalEntry);
  return entries;
}

function parseLinkEntry(entry) {
  const parts = [];
  let start = 0;
  let inAngle = false;
  let inQuotes = false;
  let escaped = false;
  for (let index = 0; index < entry.length; index += 1) {
    const character = entry[index];
    if (inQuotes) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inQuotes = false;
      continue;
    }
    if (character === '"') {
      inQuotes = true;
      continue;
    }
    if (character === '<') {
      if (inAngle) return null;
      inAngle = true;
      continue;
    }
    if (character === '>') {
      if (!inAngle) return null;
      inAngle = false;
      continue;
    }
    if (character === ';' && !inAngle) {
      const part = entry.slice(start, index).trim();
      if (!part) return null;
      parts.push(part);
      start = index + 1;
    }
  }
  if (inAngle || inQuotes || escaped) return null;
  const finalPart = entry.slice(start).trim();
  if (!finalPart) return null;
  parts.push(finalPart);
  const target = parts.shift()?.match(/^<([^<>]+)>$/);
  if (!target || parts.length === 0) return null;
  let relation = '';
  for (const parameter of parts) {
    const match = parameter.match(/^([A-Za-z][A-Za-z0-9!#$&+.^_`|~-]*)\s*=\s*(?:"([^"]*)"|([^\s]+))$/);
    if (!match || match[1].toLowerCase() !== 'rel' || relation) return null;
    relation = (match[2] ?? match[3]).toLowerCase();
  }
  return ALLOWED_LINK_RELATIONS.has(relation) ? { relation, url: target[1] } : null;
}

function validateLinkTarget(value, currentPage, hooksPath, relation) {
  try {
    const target = new URL(value);
    const pageValue = target.searchParams.get('page');
    const page = Number(pageValue);
    const queryKeys = [...target.searchParams.keys()];
    const canonicalHooksPath = /^\/repositories\/[1-9][0-9]*\/hooks$/.test(target.pathname);
    if (target.origin !== GITHUB_API_ORIGIN || target.username || target.password || target.hash ||
      !(target.pathname === hooksPath || canonicalHooksPath) || queryKeys.length !== 2 ||
      queryKeys.filter((key) => key === 'per_page').length !== 1 || queryKeys.filter((key) => key === 'page').length !== 1 ||
      target.searchParams.get('per_page') !== String(HOOKS_PER_PAGE) || !/^[1-9][0-9]*$/.test(pageValue) ||
      !Number.isSafeInteger(page)) return null;
    if (relation === 'next' && page !== currentPage + 1) return null;
    if (relation === 'prev' && (currentPage === 1 || page !== currentPage - 1)) return null;
    if (relation === 'first' && page !== 1) return null;
    if (relation === 'last' && page < currentPage) return null;
    return page;
  } catch {
    return null;
  }
}

function nextPage(headers, currentPage, hooksPath) {
  const link = listHeader(headers, 'link');
  if (typeof link !== 'string' || !link) return { ok: true, page: null, linkPresent: false };
  const entries = linkEntries(link);
  if (!entries) return { ok: false };
  const relations = new Set();
  let next = null;
  let last = null;
  for (const entry of entries) {
    const parsed = parseLinkEntry(entry);
    if (!parsed || relations.has(parsed.relation)) return { ok: false };
    const page = validateLinkTarget(parsed.url, currentPage, hooksPath, parsed.relation);
    if (page === null) return { ok: false };
    relations.add(parsed.relation);
    if (parsed.relation === 'next') next = page;
    if (parsed.relation === 'last') last = page;
  }
  if (next === null && last !== null && last > currentPage) return { ok: false };
  if (next !== null && last !== null && last < next) return { ok: false };
  return { ok: true, page: next, linkPresent: true };
}

function observedAt() {
  return new Date().toISOString();
}

/**
 * Private caller-secret lifecycle capabilities are closure-bound to exactly one
 * owner project/binding/attempt. The adapter passes no owner IDs to them:
 *
 * - reserveCallerGeneratedCredential({ credential })
 * - markCallerGeneratedCredentialWriteStarted()
 * - mintCallerSecretProviderReadback({ outcome, providerWebhookId?, observedAt })
 * - recoverCallerGeneratedCredential({ providerReadback })
 * - bindReservedCredential({ providerWebhookId })
 * - finalizeProvisioning(provider facts)
 *
 * `mint…` is the authority for opaque provider-readback proofs. The adapter
 * never creates a local proof or accepts a caller-supplied proof.
 */
export function createGitHubRepositoryWebhookAdapter({
  owner,
  repo,
  endpointUrl,
  attemptPrivateReceiverIdentity,
  credential,
  canonicalOrigins,
  productionEnvironment,
  transport,
  authCapability,
  mintCallerSecretProviderReadback,
  reserveCallerGeneratedCredential,
  markCallerGeneratedCredentialWriteStarted,
  recoverCallerGeneratedCredential,
  bindReservedCredential,
  finalizeProvisioning,
} = {}) {
  const repositoryOwner = repositoryComponent(owner);
  const repositoryName = repositoryComponent(repo);
  const receiverEndpoint = privateHttpsEndpoint(endpointUrl);
  const receiverIdentity = privateHttpsEndpoint(attemptPrivateReceiverIdentity);
  const signingCredential = validCredential(credential);
  const origins = validCanonicalOrigins(canonicalOrigins);
  const repository = repositoryOwner && repositoryName ? `${repositoryOwner}/${repositoryName}` : '';
  const hooksPath = repository ? `/repos/${repository}/hooks` : '';
  const lifecycle = {
    mintCallerSecretProviderReadback,
    reserveCallerGeneratedCredential,
    markCallerGeneratedCredentialWriteStarted,
    recoverCallerGeneratedCredential,
    bindReservedCredential,
    finalizeProvisioning,
  };
  const configured = Boolean(repository && receiverEndpoint && receiverIdentity === receiverEndpoint && signingCredential && origins.length &&
    productionEnvironment === 'production' && validTransport(transport) && typeof authCapability === 'function');

  function validLifecycle() {
    return Object.values(lifecycle).every((callback) => typeof callback === 'function');
  }

  async function hasRepositoryAdminPermission() {
    if (!configured) return false;
    try {
      const capability = await authCapability({
        owner: repositoryOwner,
        repo: repositoryName,
        repositoryPermission: 'admin',
        webhookPermission: 'write',
      });
      return isObject(capability) && capability.provider === 'github' && capability.owner === repositoryOwner &&
        capability.repo === repositoryName && capability.repositoryAdmin === true && capability.webhookPermission === 'write';
    } catch {
      return false;
    }
  }

  async function request(method, path, body) {
    try {
      const response = await transport.request({
        method,
        path,
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': GITHUB_API_VERSION },
        ...(body === undefined ? {} : { body }),
      });
      return isObject(response) && Number.isInteger(response.status) ? { ok: true, response } : { ok: false };
    } catch {
      return { ok: false };
    }
  }

  async function listHooks() {
    const hooks = [];
    let page = 1;
    for (let count = 0; count < MAX_HOOK_PAGES; count += 1) {
      const current = page;
      const received = await request('GET', `${hooksPath}?per_page=${HOOKS_PER_PAGE}&page=${current}`);
      if (!received.ok || received.response.status !== 200 || !Array.isArray(received.response.body) ||
        received.response.body.length > HOOKS_PER_PAGE || !received.response.body.every(validHook)) return { ok: false };
      hooks.push(...received.response.body);
      const following = nextPage(received.response.headers, current, hooksPath);
      if (!following.ok) return { ok: false };
      if (following.page !== null) {
        page = following.page;
      } else if (!following.linkPresent && received.response.body.length === HOOKS_PER_PAGE) {
        page = current + 1;
      } else {
        return { ok: true, hooks };
      }
    }
    return { ok: false };
  }

  async function getExactHook(providerWebhookId) {
    if (!/^\d+$/.test(providerWebhookId)) return { ok: false };
    const received = await request('GET', `${hooksPath}/${providerWebhookId}`);
    if (!received.ok || received.response.status !== 200 || !exactHook(received.response.body, receiverIdentity) ||
      hookId(received.response.body.id) !== providerWebhookId) return { ok: false };
    return { ok: true, hook: received.response.body };
  }

  function receiverInventoryState(hooks) {
    const matches = hooks.filter((hook) => sameReceiver(hook, receiverIdentity));
    if (matches.length === 0) return { state: 'absent' };
    if (matches.length === 1 && exactHook(matches[0], receiverIdentity)) return { state: 'exact', hook: matches[0] };
    return { state: 'conflict' };
  }

  async function completeExactReadback(expectedWebhookId = '') {
    let direct = null;
    // A successful POST can supply an ID, but its response is not proof. Read
    // that exact resource first, then complete the bounded inventory proof.
    if (expectedWebhookId) {
      direct = await getExactHook(expectedWebhookId);
      if (!direct.ok) return { state: 'unverified' };
    }
    const inventory = await listHooks();
    if (!inventory.ok) return { state: 'unverified' };
    const state = receiverInventoryState(inventory.hooks);
    if (state.state !== 'exact') return state;
    const providerWebhookId = hookId(state.hook.id);
    if (!providerWebhookId || (expectedWebhookId && providerWebhookId !== expectedWebhookId)) return { state: 'conflict' };
    if (!direct) direct = await getExactHook(providerWebhookId);
    if (!direct.ok) return { state: 'unverified' };
    return { state: 'exact', providerWebhookId, providerReadBackAt: observedAt() };
  }

  async function settleAbsence({ writesPerformed, allowNewAttempt, failureReason }) {
    const proof = lifecycle.mintCallerSecretProviderReadback({ outcome: 'absent', observedAt: observedAt() });
    if (!proof || typeof proof !== 'object') return degraded(failureReason, writesPerformed);
    let recovery;
    try {
      recovery = await lifecycle.recoverCallerGeneratedCredential({ providerReadback: proof });
    } catch {
      return degraded(failureReason, writesPerformed);
    }
    // The new callback set contains no plaintext old credential. This adapter
    // intentionally does not begin another provider write in the same call;
    // orchestration must start it with a newly generated secret/attempt.
    if (accepted(recovery) && recovery.state === 'new_attempt_ready' && allowNewAttempt) {
      return withPrivateRecoveryState(manual(true), 'new_attempt_required');
    }
    // A write-start marker can outlive a locally observed absence: GitHub may
    // still commit a delayed POST. A repair-required response is deliberately
    // not collapsed into an old-secret retry or a successful manual result.
    return degraded(failureReason, writesPerformed);
  }

  async function settleConfirmedAbsence({ writesPerformed, allowNewAttempt, failureReason }) {
    // A reservation can only be closed from a complete, immediately observed
    // inventory proof. The initial preflight established attribution; this
    // separate readback establishes the terminal absence state.
    const freshInventory = await listHooks();
    if (!freshInventory.ok || receiverInventoryState(freshInventory.hooks).state !== 'absent') {
      return degraded(failureReason, writesPerformed);
    }
    return settleAbsence({ writesPerformed, allowNewAttempt, failureReason });
  }

  async function bindExisting(providerWebhookId, providerReadBackAt, recovered = false) {
    if (recovered) {
      const proof = lifecycle.mintCallerSecretProviderReadback({
        outcome: 'exact_existing',
        providerWebhookId,
        observedAt: providerReadBackAt,
      });
      if (!proof || typeof proof !== 'object') return degraded('verification_failed', true);
      let recovery;
      try {
        recovery = await lifecycle.recoverCallerGeneratedCredential({ providerReadback: proof });
      } catch {
        return degraded('verification_failed', true);
      }
      if (!accepted(recovery) || recovery.state !== 'credential_stored') return degraded('verification_failed', true);
    }
    let bound;
    try {
      bound = await lifecycle.bindReservedCredential({ providerWebhookId });
    } catch {
      return degraded('verification_failed', true);
    }
    if (!accepted(bound) || (bound.state && bound.state !== 'credential_stored')) {
      return compensateAfterRejectedBind(providerWebhookId);
    }
    let finalization;
    try {
      finalization = await lifecycle.finalizeProvisioning({
        providerWebhookId,
        providerRepository: repository,
        productionEnvironment: 'production',
        eventType: 'deployment_status',
        eventScope: 'project',
        canonicalOrigins: origins,
        providerReadBackAt,
      });
    } catch {
      return degraded('verification_failed', true);
    }
    // The lifecycle has historically returned `{ ok: true }` on successful
    // finalization. A state, if supplied, must be a known successful state;
    // absence is compatible with that established private callback contract.
    return accepted(finalization) && (!finalization.state || ['configured', 'active', 'finalized'].includes(finalization.state))
      ? verified('configured', true)
      : degraded('verification_failed', true);
  }

  async function compensateAfterRejectedBind(providerWebhookId) {
    // Compensation is only adjacent to a known rejected bind. A fresh complete
    // pre-delete list must prove exactly one receiver hook with this identity.
    const before = await listHooks();
    const state = before.ok ? receiverInventoryState(before.hooks) : { state: 'unverified' };
    if (state.state !== 'exact' || hookId(state.hook.id) !== providerWebhookId) return degraded('verification_failed', true);
    // A DELETE request is an external mutation attempt regardless of its
    // status/transport outcome. The following complete readback is the only
    // cleanup proof; a 204 alone never certifies deletion.
    await request('DELETE', `${hooksPath}/${providerWebhookId}`);
    const after = await listHooks();
    const afterState = after.ok ? receiverInventoryState(after.hooks) : { state: 'unverified' };
    if (afterState.state !== 'absent') return degraded('verification_failed', true);
    // Generic custody repair currently cannot prove that an acknowledged
    // write-start can be cleared by a provider-specific delete. Still invoke
    // opaque absence recovery so its durable state remains authoritative; no
    // retry or success claim follows it.
    return settleAbsence({ writesPerformed: true, allowNewAttempt: false, failureReason: 'verification_failed' });
  }

  async function createWebhook() {
    const received = await request('POST', hooksPath, {
      name: 'web',
      active: true,
      events: ['deployment_status'],
      config: {
        url: receiverEndpoint,
        content_type: 'json',
        secret: signingCredential,
        insecure_ssl: '0',
      },
    });
    if (!received.ok) return { state: 'ambiguous' };
    if (received.response.status >= 400 && received.response.status < 500) return { state: 'rejected' };
    if (received.response.status !== 201) return { state: 'ambiguous' };
    return { state: 'created', providerWebhookId: hookId(received.response.body?.id) };
  }

  async function inspect() {
    if (!configured || !await hasRepositoryAdminPermission()) return manual(false);
    const listed = await listHooks();
    // GitHub redacts configured webhook secrets on readback. A pre-existing
    // target cannot be certified as credential-bound by this adapter alone.
    return !listed.ok ? manual(false) : manual(false);
  }

  async function ensure(context = {}) {
    const requested = isObject(context) && context.deploymentAutomation === 'auto';
    if (!requested || !automationAuthorized(context) || !configured || !validLifecycle()) return manual(requested);
    if (!await hasRepositoryAdminPermission()) return manual(true);

    const preRead = await listHooks();
    if (!preRead.ok) return degraded('verification_failed', false);
    if (receiverInventoryState(preRead.hooks).state !== 'absent') return conflict();

    let reserved;
    try {
      reserved = await lifecycle.reserveCallerGeneratedCredential({ credential: signingCredential });
    } catch {
      return manual(true);
    }
    if (!accepted(reserved)) return manual(true);

    let writeStarted;
    try {
      writeStarted = await lifecycle.markCallerGeneratedCredentialWriteStarted();
    } catch {
      // No provider request began. Settle the reservation only through a fresh
      // trusted absence proof; never reuse this closure-held credential.
      return settleConfirmedAbsence({ writesPerformed: false, allowNewAttempt: true, failureReason: 'verification_failed' });
    }
    if (!accepted(writeStarted) || writeStarted.state !== 'external_write_started') {
      return settleConfirmedAbsence({ writesPerformed: false, allowNewAttempt: true, failureReason: 'verification_failed' });
    }

    const created = await createWebhook();
    if (created.state === 'rejected') {
      // A generic write-start marker deliberately remains conservative even
      // after a GitHub 4xx. Settle it only after a fresh complete absence
      // readback; no retry or old-secret reuse follows this terminal path.
      const afterRejection = await listHooks();
      if (!afterRejection.ok || receiverInventoryState(afterRejection.hooks).state !== 'absent') {
        // A POST was already dispatched. Its final provider state is unknown
        // when this confirming readback cannot be completed, so never report
        // this as a no-write path.
        return degraded('create_failed', true);
      }
      return settleAbsence({ writesPerformed: true, allowNewAttempt: false, failureReason: 'create_failed' });
    }

    const readback = await completeExactReadback(created.providerWebhookId);
    if (created.state === 'created' && created.providerWebhookId && readback.state === 'exact') {
      return bindExisting(readback.providerWebhookId, readback.providerReadBackAt, false);
    }
    if (readback.state === 'exact') {
      return bindExisting(readback.providerWebhookId, readback.providerReadBackAt, true);
    }
    if (readback.state === 'absent') {
      // The marker says GitHub may still commit late. This recovery is merely
      // durable repair evidence; a new attempt/secret is not auto-created.
      return settleAbsence({ writesPerformed: true, allowNewAttempt: false, failureReason: 'verification_failed' });
    }
    return degraded('verification_failed', true);
  }

  return Object.freeze({
    id: 'github',
    inspect,
    ensure,
    // Process-loss and rotation/revoke remain manual: no attempt-owned proof
    // survives this closure and GitHub does not read webhook secrets back.
    compensateAttempt: async (context = {}) => manual(context?.deploymentAutomation === 'auto'),
    rotate: async (context = {}) => manual(context?.deploymentAutomation === 'auto'),
    revoke: async (context = {}) => manual(context?.deploymentAutomation === 'auto'),
  });
}
