// lib/core.js — Core business logic for Pincushion
// Pure functions for annotation management, testable and config-driven

import { chmod, readFile, writeFile, readdir, rename, unlink } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { randomBytes } from 'crypto';
import {
  branchName as gitBranchName,
  filterLikelyFilePaths,
  inferLikelyFileSuggestions,
  revalidateTrackedSourceText,
} from './git.js';
import {
  enrichThreadMessage,
  parseRichComment,
  renderRichCommentHtml,
  summarizeRichComment,
} from './rich-text.js';
import {
  DEPLOYMENT_OUTCOME_STATUS_MAP,
  DEPLOYMENT_RECONCILIATION_CONTRACT,
  DEPLOYMENT_TERMINAL_STATUSES,
  MAX_DISCOVERED_DEPLOYMENT_PAGES,
  normalizeCaptureFingerprint,
  normalizeDiscoveredPageUrls,
  normalizeInventoryUrl,
} from './deployment-reconciliation.js';
import {
  detectDeploymentProviders as detectDeploymentProvidersFromRegistry,
  inspectDeploymentProvider as inspectDeploymentProviderFromRegistry,
  ensureDeploymentProvider as ensureDeploymentProviderFromRegistry,
} from './deployment-provider.js';
import {
  PROVIDER_IDS,
  buildManualSetupSummary,
  redactProviderResult,
  selectProviderCandidate,
} from './deployment-providers/contracts.js';
import {
  SUBMISSION_DELIVERY_STATUSES,
  createSubmissionOperationId,
  submitJournaledAnnotation,
} from './submission-journal.js';
import { safeErrorResponse, safeProviderError } from './safe-error.js';
import {
  annotationCachePath,
  pageUrlFromAnnotationEntry,
  readVersionedAnnotationPages,
  updateScopedAnnotationPage,
  writeScopedAnnotationPage,
} from './annotation-cache.js';
import { QA_IMPORT_LIMITS, deterministicQaPinId, normalizeQaImport, qaImportPreview } from './qa-ingestion.js';

// ─── Project Filter Helper ───────────────────────────────────────────────────
// projectId can be: null (no filter), a string (single ID), or a Set (multiple IDs).
// Returns true if the annotation matches the filter.
function matchesProject(annProjectId, filter) {
  if (!filter) return true;                          // no filter — everything passes
  if (filter instanceof Set) return filter.has(annProjectId);
  return annProjectId === filter;                    // simple string match
}

function serializeThreadMessage(message = {}) {
  return enrichThreadMessage({
    author: message.author || 'Unknown',
    timestamp: message.timestamp,
    body: message.body || '',
    type: message.type || 'comment',
  });
}

// Human-readable device context from a pin's stored viewport
// ({width, height, dpr?, orientation?, device?, coarsePointer?}). Old pins
// carry only {width,height} (or nothing) — fall back to a width heuristic
// with a trailing "?" since a narrow window isn't proof of a phone.
// Returns { device, label, breakpoint } or null.
export function describeViewport(viewport) {
  if (!viewport || typeof viewport.width !== 'number') return null;
  const w = viewport.width, h = viewport.height;
  let device = viewport.device;
  if (!device) device = w < 768 ? 'mobile?' : w < 1200 ? 'tablet?' : 'desktop';
  const parts = [`${w}×${h}`];
  if (viewport.orientation) parts.push(viewport.orientation);
  if (viewport.dpr) parts.push(`@${viewport.dpr}x`);
  return {
    device,
    label: `${device} (${parts.join(', ')})`,
    breakpoint: `${device.replace('?', '')} (~${w}px)`,
  };
}

function firstUserThreadMessage(thread = []) {
  return (thread || []).find(
    (message) => message.type !== 'code-note' && message.type !== 'decline' && message.author !== 'AI Agent'
  ) || null;
}

// `ready` is the modern status name post-`rename_approved_to_ready_status`
// migration; `approved` is the legacy alias still found in older local
// files. Treat both as the same implementation-ready state. Without this,
// every pin coming back from cloud sync (which normalizes to `ready`)
// falls through the implementation queue — including AI critic pins.
export function isReadyStatus(status) {
  return status === 'ready' || status === 'approved';
}

// Terminal annotations are retained as history, but must never re-enter an
// implementation path. Keep this predicate as the sole lifecycle definition so
// every caller treats a board-owner dismissal exactly like the other immutable
// end states.
const TERMINAL_STATUSES = new Set(['resolved', 'archived', 'dismissed']);

export function isTerminalStatus(status) {
  return TERMINAL_STATUSES.has(String(status || '').trim());
}

// Pin IDs arrive from the cloud and are authored by any project member,
// including link-invited commenters. They name agent-queue trigger files, so
// an ID such as "../../package" must never resolve outside the queue
// directory. Real clients mint `ann_<base36|uuid>`; anything with a path
// separator, a leading dot, or a control character gets no file path.
const SAFE_QUEUE_FILE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/;

export function agentQueueFilePath(queueDir, annotationId) {
  const id = typeof annotationId === 'string' ? annotationId : '';
  if (!queueDir || !SAFE_QUEUE_FILE_ID.test(id)) return null;
  return join(queueDir, `${id}.json`);
}

function rejectedTerminalMutation(annotationId, status) {
  const label = String(status || 'terminal');
  return {
    success: false,
    annotationId,
    error: `Pin "${annotationId}" has terminal status "${label}" and cannot be changed through an implementation lifecycle tool.`,
  };
}

// ─── Supabase Status Push ─────────────────────────────────────────────────────
// Push a single annotation's status back to Supabase so the deploy hook
// (and the extension's next poll) sees the up-to-date state.
// Never throws; this is retained for local-only and new-pin compatibility.
// Existing lifecycle writes use the remote-first receipt path below. Most
// legacy callers fire-and-forget, but the return value carries the outcome so METERED tools
// (assign_pin_to_agent, add_bot_reply, create_critique_pin,
// record_pin_verification) can await it and surface a 402 quota_exceeded
// (free AI-action pool exhausted) instead of silently not syncing:
//   { ok: true } | { ok: false, status, body } — body is the parsed JSON
//   error (e.g. { error: 'quota_exceeded', used, cap, resets_at, upgrade_url })
//   when the server sent one, else null.
async function responseBody(res) {
  if (typeof res?.text === 'function') {
    const text = await res.text().catch(() => '');
    if (!text) return null;
    try { return JSON.parse(text); } catch { return null; }
  }
  if (typeof res?.json === 'function') return res.json().catch(() => null);
  return null;
}

async function postAnnotationToSync(url, config, ann, pageUrl, pageTitle) {
  const licenseKey = config.licenseKey || config.syncApiKey || null;
  if (!licenseKey) return { ok: false, status: 0, body: null };
  try {
    const fetchImpl = config.fetchImpl || fetch;
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-license-key': licenseKey,
        'x-pincushion-client': `mcp/${config.pkgVersion || '0'}`,
      },
      body: JSON.stringify([{
        id: ann.id,
        pageUrl: pageUrl || ann.pageUrl || '',
        pageTitle: pageTitle || ann.pageTitle || '',
        element: ann.element || null,
        pin: ann.pin || null,
        thread: ann.thread || [],
        status: ann.status || 'open',
        action: ann.action || null,
        tags: ann.tags || [],
        createdAt: ann.createdAt || new Date().toISOString(),
        updatedAt: ann.updatedAt || new Date().toISOString(),
        resolvedAt: ann.resolvedAt || null,
        approvedAt: ann.approvedAt || null,
        approvedBy: ann.approvedBy || null,
        implementedAt: ann.implementedAt || null,
        implementer: ann.implementer || null,
        projectId: ann.projectId || config.projectId || null,
        author: ann.author || null,
        authorEmail: ann.authorEmail || null,
        // is_bot is server-side gated to author_email === 'pincushion-bot@pincushion.io';
        // forwarding the local flag here just lets a legitimate bot pin round-trip
        // without losing its badge.
        isBot: ann.isBot === true,
        // Third-party agent authorship (create_agent_pin). Server re-derives
        // author_class and forces the "<agentName> (agent)" display — these
        // are inputs, not trusted state.
        authorClass: ann.authorClass || null,
        agentName: ann.agentName || null,
        priority: ann.priority || null,
        visibility: ann.visibility || 'public',
        commitSha: ann.commitSha || null,
        branchName: ann.branchName || null,
        prUrl: ann.prUrl || null,
        deployUrl: ann.deployUrl || null,
        deployedAt: ann.deployedAt || null,
        verificationStatus: ann.verificationStatus || null,
        verificationNotes: ann.verificationNotes || null,
        verifiedAt: ann.verifiedAt || null,
        viewport: ann.viewport || null,
        domSnippet: ann.domSnippet || null,
        likelyFiles: Array.isArray(ann.likelyFiles) ? ann.likelyFiles : null,
        acceptanceCriteria: ann.acceptanceCriteria || null,
      }]),
    });
    const body = await responseBody(res);
    if (!res.ok) {
      console.error(`[Pincushion] Cloud sync failed for ${ann.id}: ${res.status} ${body?.error || body?.message || ''}`);
      return { ok: false, status: res.status, body };
    }
    return { ok: true, status: res.status, body };
  } catch (err) {
    console.error(`[Pincushion] Cloud sync error for ${ann.id}:`, err.message || err);
    return { ok: false, status: 0, body: null };
  }
}

async function pushAnnotationToSupabase(config, ann, pageUrl, pageTitle) {
  const supabaseBase = config.supabaseBase || 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1';
  return postAnnotationToSync(`${supabaseBase}/sync-annotations`, config, ann, pageUrl, pageTitle);
}

export function resolveLifecycleAuthority(config = {}) {
  const syncServerUrl = typeof config.syncServerUrl === 'string' ? config.syncServerUrl.trim() : '';
  const licenseKey = typeof config.licenseKey === 'string' ? config.licenseKey.trim() : (config.syncApiKey || '').trim();
  if (!syncServerUrl || !licenseKey) {
    return {
      ok: false,
      error: 'authoritative_sync_required',
      reason: 'missing_credentials',
      message: 'An authoritative sync URL and license are required before changing an existing pin. Local files were left unchanged. Sign in once with `npx -y pincushion-mcp login` (or `npx -y pincushion-mcp setup`), restart your editor, then retry.',
    };
  }
  try {
    const parsed = new URL(syncServerUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('unsupported protocol');
  } catch {
    return {
      ok: false,
      error: 'authoritative_sync_required',
      reason: 'invalid_sync_url',
      message: 'A valid authoritative http(s) sync URL is required before changing an existing pin. Local files were left unchanged.',
    };
  }
  return { ok: true, syncServerUrl, licenseKey };
}

function matchingCanonicalRow(body, annotationId) {
  const rows = Array.isArray(body)
    ? body
    : Array.isArray(body?.annotations)
      ? body.annotations
      : body?.annotation && typeof body.annotation === 'object'
        ? [body.annotation]
        : body?.data && typeof body.data === 'object'
          ? [body.data]
          : [];
  const matches = rows.filter((row) => row && String(row.id || '') === annotationId && typeof row.status === 'string');
  return matches.length === 1 ? matches[0] : null;
}

function canonicalExactScope(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const hasPageUrl = Object.prototype.hasOwnProperty.call(row, 'pageUrl');
  const hasSnakePageUrl = Object.prototype.hasOwnProperty.call(row, 'page_url');
  const hasProjectId = Object.prototype.hasOwnProperty.call(row, 'projectId');
  const hasSnakeProjectId = Object.prototype.hasOwnProperty.call(row, 'project_id');
  // A response carrying both compatibility aliases must agree exactly. A
  // caller cannot choose which scope reaches persistence by ordering fields.
  if ((hasPageUrl && hasSnakePageUrl && row.pageUrl !== row.page_url) ||
      (hasProjectId && hasSnakeProjectId && row.projectId !== row.project_id)) {
    return null;
  }
  const pageUrl = hasPageUrl ? row.pageUrl : row.page_url;
  const projectId = hasProjectId ? row.projectId : row.project_id;
  if (typeof pageUrl !== 'string' || !pageUrl || pageUrl.trim() !== pageUrl ||
      typeof projectId !== 'string' || !projectId || projectId.trim() !== projectId) {
    return null;
  }
  try {
    const parsed = new URL(pageUrl);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return null;
  } catch {
    return null;
  }
  return { pageUrl, projectId };
}

function canonicalAnnotation(candidate, row) {
  // The response is authoritative, but preserve candidate fields that an older
  // rolling deployment has not started echoing yet. A response without an id or
  // status is rejected before this point, so it can never be mistaken for a
  // lifecycle receipt.
  const value = { ...candidate };
  const aliases = [
    ['id', 'id'], ['pageUrl', 'page_url'], ['pageTitle', 'page_title'],
    ['element', 'element'], ['pin', 'pin'], ['thread', 'thread'], ['status', 'status'],
    ['action', 'action'], ['tags', 'tags'], ['visibility', 'visibility'], ['createdAt', 'created_at'],
    ['updatedAt', 'updated_at'], ['resolvedAt', 'resolved_at'], ['approvedAt', 'approved_at'],
    ['approvedBy', 'approved_by'], ['implementedAt', 'implemented_at'],
    ['implementer', 'implementer'], ['projectId', 'project_id'], ['author', 'author'],
    ['authorEmail', 'author_email'], ['isBot', 'is_bot'], ['authorClass', 'author_class'],
    ['agentName', 'agent_name'], ['commitSha', 'commit_sha'], ['branchName', 'branch_name'],
    ['prUrl', 'pr_url'], ['deployUrl', 'deploy_url'], ['deployedAt', 'deployed_at'],
    ['verificationStatus', 'verification_status'], ['verificationNotes', 'verification_notes'],
    ['verifiedAt', 'verified_at'], ['dismissedAt', 'dismissed_at'], ['dismissedBy', 'dismissed_by'],
    ['viewport', 'viewport'], ['domSnippet', 'dom_snippet'], ['likelyFiles', 'likely_files'],
    ['acceptanceCriteria', 'acceptance_criteria'],
    // Narrow server-managed revision, used only to compare a resolved local
    // pin against frozen client-review evidence. It is never caller authority.
    ['clientReviewSourceRevision', 'client_review_source_revision'],
  ];
  for (const [localKey, remoteKey] of aliases) {
    if (Object.prototype.hasOwnProperty.call(row, localKey)) value[localKey] = row[localKey];
    else if (Object.prototype.hasOwnProperty.call(row, remoteKey)) value[localKey] = row[remoteKey];
  }
  return value;
}

async function acceptLifecycleMutation(config, candidate, pageUrl, pageTitle) {
  const remote = resolveLifecycleAuthority(config);
  if (!remote.ok) return { ok: false, status: 0, ...remote };
  const result = await postAnnotationToSync(remote.syncServerUrl, { ...config, licenseKey: remote.licenseKey }, candidate, pageUrl, pageTitle);
  if (!result.ok) {
    const failure = safeProviderError(result.body, result.status, { fallback: 'provider_request_failed' });
    return {
      ok: false,
      status: result.status,
      error: failure.error,
      message: failure.message || `Cloud lifecycle update for pin "${candidate.id}" was not accepted. Local files were left unchanged.`,
    };
  }
  const row = matchingCanonicalRow(result.body, candidate.id);
  if (!row) {
    return {
      ok: false,
      status: result.status,
      error: 'remote_canonical_row_missing',
      message: `Cloud accepted the request for pin "${candidate.id}" without a matching canonical annotation row. Local files were left unchanged.`,
    };
  }
  const canonicalScope = canonicalExactScope(row);
  if (!canonicalScope || canonicalScope.pageUrl !== pageUrl ||
      (candidate.projectId && canonicalScope.projectId !== candidate.projectId) ||
      (config.projectId && canonicalScope.projectId !== config.projectId)) {
    return {
      ok: false,
      status: result.status,
      error: 'remote_canonical_scope_mismatch',
      message: `Cloud returned an incomplete or mismatched project/page scope for pin "${candidate.id}". Local files were left unchanged.`,
    };
  }
  const annotation = canonicalAnnotation(candidate, row);
  // Scope is an authorization boundary. Never inherit it from the local
  // candidate after the POST; carry only the exact canonical values returned
  // by the authoritative service into persistence.
  annotation.pageUrl = canonicalScope.pageUrl;
  annotation.projectId = canonicalScope.projectId;
  if (annotation.status === 'dismissed') {
    return {
      ok: false,
      status: result.status,
      error: 'annotation_dismissed',
      message: `Pin "${candidate.id}" was dismissed by its board owner. Local files were left unchanged.`,
    };
  }
  if (annotation.status !== candidate.status) {
    return {
      ok: false,
      status: result.status,
      error: 'remote_canonical_state_mismatch',
      message: `Cloud returned status "${annotation.status}" instead of the requested "${candidate.status}" for pin "${candidate.id}". Local files were left unchanged.`,
    };
  }
  return { ok: true, annotation, remote: true };
}

// Shared decoration for metered tools: await the cloud push and, when the
// server rejected it with 402 quota_exceeded, splice the upgrade payload into
// the tool result so the agent (and the human reading the transcript) sees
// WHY the action didn't sync — the local change still applied.
async function pushMeteredAndDecorate(config, ann, pageUrl, pageTitle, result) {
  const push = await pushAnnotationToSupabase(config, ann, pageUrl, pageTitle);
  if (!push.ok && push.status === 402 && push.body?.error === 'quota_exceeded') {
    result.success = false;
    result.error = 'quota_exceeded';
    const used = Number.isInteger(push.body.used) && push.body.used >= 0 && push.body.used <= 1_000_000
      ? push.body.used : undefined;
    const cap = Number.isInteger(push.body.cap) && push.body.cap >= 0 && push.body.cap <= 1_000_000
      ? push.body.cap : undefined;
    result.quota = {
      ...(used === undefined ? {} : { used }),
      ...(cap === undefined ? {} : { cap }),
    };
    result.upgrade_url = 'https://www.pincushion.io/pricing?ref=mcp-plan-limit';
    result.message = safeProviderError(push.body, push.status, { fallback: 'quota_exceeded' }).error === 'quota_exceeded'
      ? 'The AI-action quota is exhausted. The local change applied, but it was not synced to the cloud.'
      : result.message;
    result.warning = 'This AI action was NOT synced to the cloud — the free monthly AI-action pool is exhausted. The local change applied, but stakeholders/integrations will not see it.';
  }
  return result;
}

// ─── New Pin Submission Receipts ────────────────────────────────────────────
// New pins differ from older local-first writers: cloud acceptance is the
// source of truth. The durable journal retains only the public annotation
// candidate and its caller-provided operation id; credentials remain in this
// process and are supplied directly to fetch.
const CREATION_OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;
const CREATION_DELIVERY_STATUSES = Object.freeze({
  duplicate: 'rejected_duplicate',
  scopeRequired: 'project_scope_required',
  scopeUnavailable: 'project_scope_unavailable',
  scopeAmbiguous: 'project_scope_ambiguous',
  scopeUnregistered: 'project_scope_unregistered',
  scopeMismatch: 'project_scope_mismatch',
  scopeForbidden: 'project_scope_forbidden',
  cacheUnavailable: 'accepted_cache_unavailable',
});
// The cloud may advance a newly created pin while a client is recovering a
// lost response. A matching immutable ID, exact page/project scope, and a
// current server lifecycle value prove acceptance; requiring the original
// `open` value here would discard that legitimate authoritative transition.
const CANONICAL_CREATION_STATUSES = new Set([
  'open',
  'ready',
  'in-progress',
  'implemented',
  'resolved',
  'archived',
  'dismissed',
]);

function creationFailure({
  annotationId = null,
  operationId = null,
  deliveryStatus = SUBMISSION_DELIVERY_STATUSES.rejectedValidation,
  retryable = false,
  error = 'submission_rejected',
  message = error,
  extra = {},
} = {}) {
  return {
    success: false,
    annotationId,
    operationId,
    deliveryStatus,
    retryable,
    error,
    message,
    ...extra,
  };
}

function requestedCreationOperationId(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, explicit: false, operationId: createSubmissionOperationId() };
  }
  if (typeof value !== 'string' || !CREATION_OPERATION_ID.test(value.trim())) {
    return {
      ok: false,
      result: creationFailure({
        deliveryStatus: SUBMISSION_DELIVERY_STATUSES.rejectedValidation,
        error: 'operationId_invalid',
        message: 'operationId must be an opaque 8-128 character stable identifier. Reuse it only when recovering that same submission.',
      }),
    };
  }
  return { ok: true, explicit: true, operationId: value.trim() };
}

function canonicalRowsForCreation(body) {
  if (Array.isArray(body)) return { valid: true, rows: body };
  if (!body || typeof body !== 'object') return { valid: false, rows: [] };
  if (Array.isArray(body.annotations)) return { valid: true, rows: body.annotations };
  if (body.annotation && typeof body.annotation === 'object' && !Array.isArray(body.annotation)) {
    return { valid: true, rows: [body.annotation] };
  }
  if (body.data && typeof body.data === 'object' && !Array.isArray(body.data)) {
    return { valid: true, rows: [body.data] };
  }
  return { valid: false, rows: [] };
}

function canonicalField(row, camelCase, snakeCase) {
  if (Object.prototype.hasOwnProperty.call(row, camelCase)) return row[camelCase];
  if (Object.prototype.hasOwnProperty.call(row, snakeCase)) return row[snakeCase];
  return undefined;
}

function canonicalCreationIdentity(row, candidate) {
  // A server response that echoes only ID/page/status is not enough for an
  // automated pin. It could be a commenter-downgraded human annotation with
  // the same transport receipt. Validate raw remote fields before
  // canonicalAnnotation can fill legacy omissions from the local candidate.
  if (candidate.isBot === true) {
    const isBot = canonicalField(row, 'isBot', 'is_bot');
    const author = canonicalField(row, 'author', 'author');
    const authorEmail = canonicalField(row, 'authorEmail', 'author_email');
    if (typeof isBot !== 'boolean' || typeof author !== 'string' || typeof authorEmail !== 'string') {
      return { ok: false, complete: false };
    }
    return { ok: isBot === true && author === BOT_AUTHOR && authorEmail === BOT_EMAIL, complete: true };
  }
  if (candidate.authorClass === 'agent') {
    const authorClass = canonicalField(row, 'authorClass', 'author_class');
    const agentName = canonicalField(row, 'agentName', 'agent_name');
    const author = canonicalField(row, 'author', 'author');
    if (typeof authorClass !== 'string' || typeof author !== 'string' ||
        (agentName !== undefined && typeof agentName !== 'string')) {
      return { ok: false, complete: false };
    }
    // annotations has no agent_name column, so sync-annotations echoes only
    // author_class and the server-forced "<agentName> (agent)" author. That
    // author already binds the agent name; an echoed agentName must still match.
    return {
      ok: authorClass === 'agent' && author === candidate.author &&
        (agentName === undefined || agentName === candidate.agentName),
      complete: true,
    };
  }
  return { ok: false, complete: false };
}

function pendingCreationOutcome(error = 'remote_unavailable') {
  return {
    kind: 'pending',
    deliveryStatus: SUBMISSION_DELIVERY_STATUSES.pending,
    retryable: true,
    error,
  };
}

function rejectedCreationOutcome(deliveryStatus, error) {
  return { kind: 'rejected', deliveryStatus, retryable: false, error };
}

function validatedCreationOutcome(body, candidate, { allowAbsent = false } = {}) {
  const envelope = canonicalRowsForCreation(body);
  if (!envelope.valid) return pendingCreationOutcome('malformed_canonical_response');
  const matches = envelope.rows.filter((row) => row && typeof row === 'object' && String(row.id || '') === candidate.id);
  if (matches.length === 0) return allowAbsent ? { kind: 'absent' } : pendingCreationOutcome('canonical_annotation_missing');
  if (matches.length !== 1) return pendingCreationOutcome('canonical_annotation_ambiguous');

  const row = matches[0];
  const status = canonicalField(row, 'status', 'status');
  const pageUrl = canonicalField(row, 'pageUrl', 'page_url');
  const projectId = canonicalField(row, 'projectId', 'project_id');
  if (typeof status !== 'string' || !CANONICAL_CREATION_STATUSES.has(status) ||
      typeof pageUrl !== 'string' || typeof projectId !== 'string') {
    return pendingCreationOutcome('canonical_annotation_incomplete');
  }
  if (pageUrl !== candidate.pageUrl || projectId !== candidate.projectId) {
    return rejectedCreationOutcome(
      SUBMISSION_DELIVERY_STATUSES.rejectedCanonical,
      'remote_canonical_mismatch',
    );
  }
  const identity = canonicalCreationIdentity(row, candidate);
  if (!identity.complete) return pendingCreationOutcome('canonical_annotation_identity_incomplete');
  if (!identity.ok) {
    return rejectedCreationOutcome(
      SUBMISSION_DELIVERY_STATUSES.rejectedCanonical,
      'remote_canonical_identity_mismatch',
    );
  }
  const annotation = canonicalAnnotation(candidate, row);
  // Never manufacture private acceptance from the submitted candidate when
  // the authoritative row omits visibility. Keep acceptance identity, but let
  // the critique result hold downstream uploads/report generation.
  if (candidate.isBot === true && candidate.visibility === 'project_members' &&
      !Object.prototype.hasOwnProperty.call(row, 'visibility')) delete annotation.visibility;
  return { kind: 'accepted', annotation };
}

function remoteCreationOutcome(result, candidate, { allowAbsent = false } = {}) {
  if (!result?.ok) {
    const status = Number(result?.status || 0);
    const rawCode = typeof result?.body?.error === 'string' ? result.body.error.trim() : '';
    const code = rawCode
      ? safeProviderError(result?.body, result?.status, { fallback: 'provider_request_failed' }).error
      : '';
    if (status === 0 || status === 408 || status >= 500) {
      return pendingCreationOutcome(status === 0 ? 'network_error' : 'remote_unavailable');
    }
    if (status === 402 || status === 429 || code === 'quota_exceeded') {
      return rejectedCreationOutcome(SUBMISSION_DELIVERY_STATUSES.rejectedQuota, code || 'quota_exceeded');
    }
    if (status === 401 || (status === 403 && /(?:license|auth|credential|forbidden)/i.test(code))) {
      return rejectedCreationOutcome(SUBMISSION_DELIVERY_STATUSES.rejectedAuthentication, code || 'remote_authentication_rejected');
    }
    if (status === 409) {
      if (code === 'duplicate_variant') {
        return rejectedCreationOutcome(SUBMISSION_DELIVERY_STATUSES.rejectedValidation, code);
      }
      if (code) return rejectedCreationOutcome(SUBMISSION_DELIVERY_STATUSES.rejectedRemote, code);
      return pendingCreationOutcome('remote_conflict');
    }
    if (status === 400 || status === 422) {
      return rejectedCreationOutcome(SUBMISSION_DELIVERY_STATUSES.rejectedValidation, code || 'remote_validation_rejected');
    }
    return rejectedCreationOutcome(SUBMISSION_DELIVERY_STATUSES.rejectedRemote, code || `remote_rejected_${status || 'unknown'}`);
  }
  return validatedCreationOutcome(result.body, candidate, { allowAbsent });
}

async function sendCreationToCloud(config, candidate, pageUrl, pageTitle) {
  const remote = resolveLifecycleAuthority(config);
  if (!remote.ok) {
    return rejectedCreationOutcome(SUBMISSION_DELIVERY_STATUSES.rejectedAuthentication, remote.error || 'authoritative_sync_required');
  }
  const result = await postAnnotationToSync(
    remote.syncServerUrl,
    { ...config, licenseKey: remote.licenseKey },
    candidate,
    pageUrl,
    pageTitle,
  );
  return remoteCreationOutcome(result, candidate);
}

async function reconcileCreationById(config, candidate) {
  const remote = resolveLifecycleAuthority(config);
  if (!remote.ok) {
    return rejectedCreationOutcome(SUBMISSION_DELIVERY_STATUSES.rejectedAuthentication, remote.error || 'authoritative_sync_required');
  }
  try {
    const endpoint = new URL(remote.syncServerUrl);
    endpoint.searchParams.set('annotation_id', candidate.id);
    endpoint.searchParams.set('pageUrl', candidate.pageUrl);
    endpoint.searchParams.set('project_id', candidate.projectId);
    const fetchImpl = config.fetchImpl || fetch;
    const response = await fetchImpl(endpoint.toString(), {
      method: 'GET',
      headers: {
        'x-license-key': remote.licenseKey,
        'x-pincushion-client': `mcp/${config.pkgVersion || '0'}`,
      },
    });
    return remoteCreationOutcome({
      ok: response?.ok === true,
      status: response?.status || 0,
      body: await responseBody(response),
    }, candidate, { allowAbsent: true });
  } catch {
    return pendingCreationOutcome('network_error');
  }
}

async function resolveCreationProjectScope(config, { pageUrl, projectId } = {}) {
  const requestedProjectId = typeof projectId === 'string' ? projectId.trim() : '';
  if (typeof config.resolveSubmissionProjectScope === 'function') {
    try {
      const resolved = await config.resolveSubmissionProjectScope({ pageUrl, requestedProjectId });
      if (resolved?.ok && typeof resolved.projectId === 'string' && resolved.projectId.trim()) {
        return { ok: true, projectId: resolved.projectId.trim() };
      }
      const scopeReason = typeof resolved?.deliveryStatus === 'string'
        ? resolved.deliveryStatus
        : typeof resolved?.reason === 'string'
          ? resolved.reason
          : CREATION_DELIVERY_STATUSES.scopeUnavailable;
      return {
        ok: false,
        result: creationFailure({
          deliveryStatus: scopeReason,
          retryable: resolved?.retryable === true,
          error: typeof resolved?.error === 'string' ? resolved.error : scopeReason,
          message: typeof resolved?.message === 'string'
            ? resolved.message
            : 'The authenticated project registry is unavailable, so this submission was not sent.',
        }),
      };
    } catch {
      return {
        ok: false,
        result: creationFailure({
          deliveryStatus: CREATION_DELIVERY_STATUSES.scopeUnavailable,
          retryable: true,
          error: 'project_scope_unavailable',
          message: 'The authenticated project registry could not resolve this page. The submission was not sent.',
        }),
      };
    }
  }
  const configuredProjectId = requestedProjectId || (typeof config.projectId === 'string' ? config.projectId.trim() : '');
  if (configuredProjectId) return { ok: true, projectId: configuredProjectId };
  return {
    ok: false,
    result: creationFailure({
      deliveryStatus: CREATION_DELIVERY_STATUSES.scopeRequired,
      error: 'project_scope_required',
      message: 'A trusted projectId or authenticated exact-page project registration is required before this submission can be sent.',
    }),
  };
}

async function persistAcceptedCreation(config, allData, pageUrl, pageTitle, annotation) {
  if (config?.annotationCacheVersion === 2 && typeof annotation?.projectId === 'string' && annotation.projectId) {
    // The journal gives this function only a canonical cloud receipt. Fold
    // that receipt into the current exact scope while holding the v2 update
    // lease, so a concurrent bridge pull or lifecycle repair cannot be
    // replaced by the stale local snapshot captured before submission.
    const persisted = await updateScopedAnnotationPage({
      annotationsDir: config.annotationsDir,
      projectId: annotation.projectId,
      pageUrl,
      update: (current) => {
        const source = current
          ? clonePageData(current)
          : {
              projectId: annotation.projectId,
              pageUrl,
              pageTitle: pageTitle || pageUrl,
              annotations: [],
            };
        source.projectId = annotation.projectId;
        source.pageUrl = pageUrl;
        source.pageTitle = pageTitle || source.pageTitle || pageUrl;
        source.annotations = [...(source.annotations || [])];
        const index = source.annotations.findIndex((item) => item?.id === annotation.id);
        if (index === -1) source.annotations.push(annotation);
        else source.annotations[index] = annotation;
        source.exportedAt = new Date().toISOString();
        return source;
      },
    });
    await rebuildIndex(config);
    return persisted.pageData;
  }
  const source = allData[pageUrl] || { pageUrl, pageTitle: pageTitle || pageUrl, annotations: [] };
  const page = {
    ...source,
    pageUrl,
    pageTitle: pageTitle || source.pageTitle || pageUrl,
    annotations: [...(source.annotations || [])],
    exportedAt: new Date().toISOString(),
  };
  const existingIndex = page.annotations.findIndex((item) => item?.id === annotation.id);
  if (existingIndex === -1) page.annotations.push(annotation);
  else page.annotations[existingIndex] = annotation;
  await writeAnnotationFile(config.annotationsDir, page);
  await rebuildIndex(config);
  return page;
}

async function submitNewAnnotation(config, {
  operation,
  operationId,
  annotation,
  pageTitle,
  allData,
}) {
  const authority = resolveLifecycleAuthority(config);
  if (!authority.ok) {
    return creationFailure({
      annotationId: annotation.id,
      operationId,
      deliveryStatus: SUBMISSION_DELIVERY_STATUSES.rejectedAuthentication,
      error: authority.error || 'authoritative_sync_required',
      message: 'An authoritative cloud sync URL and accepted license are required before creating a pin. No local actionable pin was written.',
    });
  }
  const receipt = await submitJournaledAnnotation({
    privateConfigDir: config.privateConfigDir,
    projectId: annotation.projectId,
    pageUrl: annotation.pageUrl,
    syncServerUrl: config.syncServerUrl,
    operation,
    operationId,
    annotation,
    send: (candidate) => sendCreationToCloud(config, candidate, annotation.pageUrl, pageTitle),
    reconcile: (candidate) => reconcileCreationById(config, candidate),
  });
  if (receipt.outcome !== 'accepted') {
    return creationFailure({
      annotationId: receipt.annotationId,
      operationId: receipt.operationId,
      deliveryStatus: receipt.deliveryStatus,
      retryable: receipt.retryable,
      error: receipt.error || 'submission_pending',
      message: receipt.outcome === 'rejected'
        ? 'The cloud rejected this pin submission. No local actionable pin was written.'
        : 'The cloud has not confirmed this pin submission. It is retained for reconciliation and no local actionable pin was written.',
    });
  }
  try {
    const page = await persistAcceptedCreation(config, allData, annotation.pageUrl, pageTitle, receipt.annotation);
    return { ok: true, annotation: receipt.annotation, page, operationId: receipt.operationId };
  } catch {
    return creationFailure({
      annotationId: receipt.annotationId,
      operationId: receipt.operationId,
      deliveryStatus: CREATION_DELIVERY_STATUSES.cacheUnavailable,
      retryable: true,
      error: 'local_cache_write_failed',
      message: 'The cloud accepted this pin, but the local actionable cache could not be updated. Retry with the same operationId to repair the cache.',
    });
  }
}

// ─── Project Config ───────────────────────────────────────────────────────────
// Project-level settings live in `.feedback/projects.json` keyed by projectId.
// Settings include URL registrations (legacy) plus traceability knobs added
// later: `commitTrailers`, `attributionComments`, `recordCommitSha`.
//
// Returns null when the file or projectId can't be resolved — callers should
// treat that as "use defaults" rather than an error, since the file may not
// exist yet on a fresh install.

const TRAILER_PRESET_VALUES = new Set(['minimal', 'standard', 'full']);
const ATTRIBUTION_COMMENT_VALUES = new Set(['off', 'context-warrants', 'always']);

// Critique context lifetimes. The compile is cheap (the dev agent does it once
// at /setup), but the underlying inputs drift: marketing copy changes, the
// product evolves, pin history accumulates. We surface a coarse staleness
// signal so /critique callers can decide whether to suggest a /refresh-brand.
//
// 30 / 60 days are intentionally generous — recompiling too aggressively
// burns the dev's tokens for marginal gain. Pin-count-based busting is the
// stronger signal (handled at fix_and_resolve time, not here).
const CRITIQUE_FRESH_DAYS = 30;
const CRITIQUE_STALE_DAYS = 60;

// Project identity is deliberately keyed by the immutable cloud project ID.
// URL matching is only a startup convenience for a workspace that has not yet
// cached an ID; display names are never an ownership signal.
const PROJECT_CLOUD_FIELDS = Object.freeze([
  'name',
  'urls',
  'role',
  'ownerLicenseId',
  'autoReadyInvited',
  'commentAccess',
  'allowedDomains',
  'brandContext',
  'autoCritique',
  'critiqueSignals',
  'critiquePolicy',
  'critiqueContext',
  'critiqueContextCompiledAt',
  'critiqueContextPinsAtCompile',
  'domain',
]);

function safeProjectId(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

/**
 * Normalize a project URL for identity matching.
 *
 * This intentionally mirrors the URL registration behavior used by
 * configure_project: local development hosts default to http, other hosts to
 * https, query/hash values are not identity, and a meaningful path is kept so
 * two apps hosted on different path prefixes do not collapse into one project.
 */
export function normalizeProjectUrl(value) {
  let input = String(value ?? '').trim().replace(/\/+$/, '');
  if (!input) return null;
  const localHost = /^(localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?|::1(?::\d+)?|[^\s/]+\.local(?::\d+)?)(\/|$)/i;
  if (!/^https?:\/\//i.test(input)) {
    input = `${localHost.test(input) ? 'http' : 'https'}://${input}`;
  }
  try {
    const parsed = new URL(input);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname.replace(/\/+$/, '') : '';
    return `${parsed.origin}${path}`;
  } catch {
    // Keep the historical permissive behavior for an unusual but non-empty
    // registration value. It remains a deterministic exact-match candidate,
    // never a display-name or ownership match.
    return input;
  }
}

export function normalizeProjectUrls(urls) {
  if (!Array.isArray(urls)) return [];
  return [...new Set(urls.map(normalizeProjectUrl).filter(Boolean))];
}

function projectEntries(projects) {
  if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return [];
  return Object.entries(projects)
    .map(([key, value]) => {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
      const projectId = safeProjectId(value.projectId) || safeProjectId(key);
      return projectId ? { key, projectId, project: value } : null;
    })
    .filter(Boolean);
}

/**
 * Read the local project registry while distinguishing missing and malformed
 * files. Callers that need to preserve an existing cache can then fail closed
 * instead of replacing it with an empty object.
 */
export async function readProjectRegistry(config = {}) {
  const projectsFile = join(config.feedbackDir, 'projects.json');
  try {
    const raw = await readFile(projectsFile, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { exists: true, malformed: true, projects: {}, projectsFile };
    }
    return { exists: true, malformed: false, projects: parsed, projectsFile };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { exists: false, malformed: false, projects: {}, projectsFile };
    }
    return { exists: true, malformed: true, projects: {}, projectsFile };
  }
}

async function writeProjectRegistryAtomic(config, projects, projectsFile = join(config.feedbackDir, 'projects.json')) {
  if (!existsSync(config.feedbackDir)) mkdirSync(config.feedbackDir, { recursive: true });
  const tempFile = `${projectsFile}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    await writeFile(tempFile, JSON.stringify(projects, null, 2));
    await rename(tempFile, projectsFile);
  } catch (error) {
    try { await unlink(tempFile); } catch { /* best effort */ }
    throw error;
  }
}

function projectFieldValue(field, value) {
  if (field === 'urls') return Array.isArray(value) ? normalizeProjectUrls(value) : undefined;
  if (field === 'allowedDomains') return Array.isArray(value)
    ? [...new Set(value.map((domain) => String(domain || '').toLowerCase().trim()).filter(Boolean))]
    : undefined;
  if (field === 'name' || field === 'domain' || field === 'role' || field === 'ownerLicenseId' ||
      field === 'commentAccess' || field === 'critiquePolicy' || field === 'critiqueContext' ||
      field === 'critiqueContextCompiledAt') {
    return value === null ? null : (typeof value === 'string' ? value : undefined);
  }
  if (field === 'autoReadyInvited' || field === 'autoCritique') {
    return typeof value === 'boolean' ? value : undefined;
  }
  if (field === 'critiqueSignals') {
    return value === null || (value && typeof value === 'object' && !Array.isArray(value)) ? value : undefined;
  }
  if (field === 'critiqueContextPinsAtCompile') {
    return Number.isFinite(Number(value)) ? Number(value) : undefined;
  }
  return undefined;
}

/**
 * Merge a successful cloud `data.projects` response into the local registry.
 * The write is a same-directory temp-file rename, so a process crash cannot
 * leave a partially written projects.json. Remote rows are keyed only by their
 * immutable projectId; all unrelated/local-only fields survive unchanged.
 */
export async function mergeProjectRegistry(config, remoteProjects, { viewerLicenseId } = {}) {
  if (!Array.isArray(remoteProjects)) {
    return { written: false, reason: 'malformed_projects', projectIds: [] };
  }
  const local = await readProjectRegistry(config);
  if (local.malformed) {
    return { written: false, reason: 'local_registry_malformed', projectIds: [] };
  }

  const remoteRows = remoteProjects
    .filter((row) => row && typeof row === 'object' && !Array.isArray(row))
    .map((row) => ({ row, projectId: safeProjectId(row.projectId) || safeProjectId(row.id) }))
    .filter(({ projectId }) => projectId);
  if (!remoteRows.length) {
    return { written: false, reason: remoteProjects.length ? 'malformed_projects' : 'no_remote_projects', projectIds: [] };
  }

  // This is the immutable identity of the authenticated viewer, not the
  // project's owner. It is retained only as account-mismatch recovery
  // evidence for every returned role; authorization always comes from the
  // fresh cloud response and is never inferred from this cache field.
  const safeViewerLicenseId = safeProjectId(viewerLicenseId);
  const projects = { ...local.projects };
  for (const { row, projectId } of remoteRows) {
    const current = projects[projectId] && typeof projects[projectId] === 'object' && !Array.isArray(projects[projectId])
      ? projects[projectId]
      : {};
    const next = { ...current, projectId };
    for (const field of PROJECT_CLOUD_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(row, field)) continue;
      const value = projectFieldValue(field, row[field]);
      if (value !== undefined) next[field] = value;
    }
    if (safeViewerLicenseId) next.viewerLicenseId = safeViewerLicenseId;
    projects[projectId] = next;
  }

  const before = JSON.stringify(local.projects, null, 2);
  const after = JSON.stringify(projects, null, 2);
  const written = before !== after;
  if (written) await writeProjectRegistryAtomic(config, projects, local.projectsFile);
  return {
    written,
    reason: 'merged',
    projectIds: remoteRows.map(({ projectId }) => projectId),
    projectCount: Object.keys(projects).length,
  };
}

// Named alias for callers that describe the successful zero-annotation sync as
// hydration. Keeping both names makes the intent explicit without duplicating
// the atomic merge implementation.
export const hydrateProjectRegistry = mergeProjectRegistry;

function normalizedUrlMatches(registeredUrl, discoveredUrl) {
  if (!registeredUrl || !discoveredUrl) return false;
  if (registeredUrl === discoveredUrl) return true;
  try {
    const registered = new URL(registeredUrl);
    const discovered = new URL(discoveredUrl);
    if (registered.origin !== discovered.origin) return false;
    const registeredPath = registered.pathname.replace(/\/+$/, '') || '/';
    const discoveredPath = discovered.pathname.replace(/\/+$/, '') || '/';
    // A host-only registration owns the host; a path registration owns only
    // that path prefix. The boundary check prevents `/app` matching `/apple`.
    return registeredPath === '/' ||
      discoveredPath === registeredPath ||
      discoveredPath.startsWith(`${registeredPath}/`);
  } catch {
    return false;
  }
}

/**
 * Resolve a workspace to a cached project without using display names. An
 * explicit known ID wins; otherwise one and only one normalized URL candidate
 * is accepted. Ambiguous and unknown results are intentionally non-actionable.
 */
export function resolveProjectIdentity({ projects = {}, projectId, urls = [] } = {}) {
  const entries = projectEntries(projects);
  const explicitId = safeProjectId(projectId);
  const exact = explicitId && entries.find(({ projectId: id }) => id === explicitId);
  if (explicitId) {
    return exact
      ? { status: 'exact_id', projectId: explicitId, candidates: [explicitId] }
      : { status: 'unresolved', projectId: null, candidates: [] };
  }

  const incomingUrls = normalizeProjectUrls(urls);
  if (!incomingUrls.length) return { status: 'none', projectId: null, candidates: [] };
  const candidates = entries.filter(({ project }) => {
    const registeredUrls = normalizeProjectUrls(project.urls || []);
    return incomingUrls.some((incoming) => registeredUrls.some((registered) => normalizedUrlMatches(registered, incoming)));
  }).map(({ projectId: id }) => id);
  const uniqueCandidates = [...new Set(candidates)].sort();
  if (uniqueCandidates.length === 1) {
    return { status: 'matched', projectId: uniqueCandidates[0], candidates: uniqueCandidates };
  }
  if (uniqueCandidates.length > 1) {
    return { status: 'ambiguous', projectId: null, candidates: uniqueCandidates };
  }
  return { status: 'none', projectId: null, candidates: [] };
}

// AI critique and third-party-agent pin creation changes the project board on
// behalf of an automated actor. A commenter may read and comment on a project,
// but cannot select it as the authority for one of those writes. Keep the URL
// matching rule shared with the rest of the registry path: host registrations
// may match a child path, and path registrations match only that path prefix.
export function resolvePrivilegedSubmissionProjectScope({ projects = {}, pageUrl, requestedProjectId } = {}) {
  const requested = typeof requestedProjectId === 'string' ? requestedProjectId.trim() : '';
  const identity = resolveProjectIdentity({ projects, urls: [pageUrl] });
  let projectId = null;
  if (requested) {
    if (!Object.prototype.hasOwnProperty.call(projects, requested)) {
      return { ok: false, reason: 'project_scope_mismatch', candidates: [] };
    }
    if (identity.status === 'matched' && identity.projectId === requested) projectId = requested;
    else if (identity.status === 'ambiguous' && identity.candidates.includes(requested)) projectId = requested;
    else {
      return {
        ok: false,
        reason: identity.status === 'none' ? 'project_scope_unregistered' : 'project_scope_mismatch',
        candidates: identity.candidates,
      };
    }
  } else if (identity.status === 'matched') {
    projectId = identity.projectId;
  } else {
    return {
      ok: false,
      reason: identity.status === 'ambiguous' ? 'project_scope_ambiguous' : 'project_scope_unregistered',
      candidates: identity.candidates,
    };
  }
  const role = typeof projects[projectId]?.role === 'string' ? projects[projectId].role.trim() : '';
  if (role !== 'owner' && role !== 'editor') {
    return { ok: false, reason: 'project_scope_forbidden', candidates: [projectId] };
  }
  return { ok: true, projectId, candidates: [projectId] };
}

// A successful credential can still belong to a different account. Classify
// that only from immutable evidence: a cached viewer UUID (for any role), a
// legacy owner UUID fallback, a server-supplied active license UUID, and no
// shared project ID. This is recovery classification only; cached evidence
// never grants access or authorizes a project mutation. Missing legacy UUIDs
// remain unknown rather than being guessed from email or display names.
export function detectProjectAccountMismatch({ projects = {}, remoteProjects = [], activeLicenseId } = {}) {
  const activeId = safeProjectId(activeLicenseId);
  if (!activeId || !Array.isArray(remoteProjects)) return false;
  const cachedEntries = projectEntries(projects);
  const remoteIds = new Set(remoteProjects
    .map((project) => safeProjectId(project?.projectId) || safeProjectId(project?.id))
    .filter(Boolean));
  if (cachedEntries.some(({ projectId }) => remoteIds.has(projectId))) return false;
  const cachedViewerIds = new Set(cachedEntries
    .map(({ project }) => safeProjectId(project.viewerLicenseId))
    .filter(Boolean));
  const cachedOwnerIds = new Set(cachedEntries
    .filter(({ project }) => project.role === 'owner' && safeProjectId(project.ownerLicenseId))
    .map(({ project }) => safeProjectId(project.ownerLicenseId)));
  const cachedIdentityIds = new Set([...cachedViewerIds, ...cachedOwnerIds]);
  return cachedIdentityIds.size > 0 && !cachedIdentityIds.has(activeId);
}

function diagnosticState(value, allowed, fallback) {
  return allowed.has(value) ? value : fallback;
}

function diagnosticSource(value) {
  const source = String(value || '').trim();
  return new Set(['env', 'cli-arg', 'rotated', 'project-file', 'home-file', 'none']).has(source)
    ? source
    : 'unknown';
}

function diagnosticLast4(key) {
  const value = typeof key === 'string' ? key.trim() : '';
  return value.length >= 4 ? value.slice(-4) : '????';
}

function safeLast4(value, fallbackKey = null) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return candidate.length === 4 ? candidate : diagnosticLast4(fallbackKey);
}

/**
 * Build the identity diagnostic's deliberately narrow, credential-safe shape.
 * The function accepts raw candidate keys only so the server can derive the
 * last four characters; no raw key is ever returned.
 */
export function buildProjectIdentityDiagnostic({
  authState = 'unknown',
  activeSource = 'none',
  activeKey = null,
  cache = {},
  candidates = [],
  ambiguity = {},
} = {}) {
  const auth = {
    state: diagnosticState(authState, new Set(['unknown', 'authenticated', 'rejected', 'unavailable']), 'unknown'),
    source: diagnosticSource(activeSource),
    last4: diagnosticLast4(activeKey),
  };
  const cacheState = diagnosticState(cache.state, new Set(['unknown', 'present', 'missing', 'malformed']), 'unknown');
  const safeCache = { state: cacheState };
  if (Number.isFinite(Number(cache.projectCount))) safeCache.projectCount = Number(cache.projectCount);
  const safeCandidates = Array.isArray(candidates) ? candidates.map((candidate) => ({
    source: diagnosticSource(candidate?.source),
    status: diagnosticState(candidate?.status, new Set(['untried', 'active', 'rejected', 'unavailable']), 'untried'),
    last4: safeLast4(candidate?.last4, candidate?.key),
  })) : [];
  const ambiguityState = diagnosticState(ambiguity.state, new Set(['unknown', 'unambiguous', 'ambiguous', 'none']), 'unknown');
  const safeAmbiguity = {
    state: ambiguityState,
    candidates: Array.isArray(ambiguity.candidates)
      ? ambiguity.candidates.map(safeProjectId).filter(Boolean).slice(0, 20)
      : [],
  };
  return { auth, cache: safeCache, candidates: safeCandidates, ambiguity: safeAmbiguity };
}

function stalenessLabel(compiledContext, compiledAt) {
  if (!compiledContext) return 'missing';
  if (!compiledAt) return 'fresh'; // legacy rows that pre-date the column
  const ageMs = Date.now() - new Date(compiledAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > CRITIQUE_STALE_DAYS) return 'stale';
  if (ageDays > CRITIQUE_FRESH_DAYS) return 'aging';
  return 'fresh';
}

export async function readProjectConfig(config, projectId) {
  if (!projectId) return null;
  try {
    const projectsFile = join(config.feedbackDir, 'projects.json');
    const projects = JSON.parse(await readFile(projectsFile, 'utf8'));
    return projects[projectId] || null;
  } catch {
    return null;
  }
}

// ─── Read-only project context (for critic subagent) ─────────────────────────
// The Pincushion AI critic needs `brandContext` before it generates any pin —
// without it, the critic produces generic UX-blog noise. The original prompt
// told the critic to call `configure_project` to fetch brandContext, but
// configure_project mutates: it upserts the project row, creates a deploy
// hook, idempotently inserts the bot member, and pushes to cloud. A typo'd
// project name in a read step turned into an unintended write.
//
// This tool is the read-only path: never mutates, never touches the network.

export async function toolGetProjectContext(config, { projectId, name, url, view } = {}) {
  const registry = await readProjectRegistry(config);
  const rawConnection = typeof config.projectIdentityProvenance === 'function'
    ? await Promise.resolve().then(() => config.projectIdentityProvenance()).catch(() => null)
    : config.projectIdentityProvenance;
  const connectionState = diagnosticState(rawConnection?.connection?.state,
    new Set(['unknown', 'authenticated', 'rejected', 'unavailable']), 'unknown');
  const connection = {
    state: connectionState,
    source: diagnosticSource(rawConnection?.connection?.source),
    last4: safeLast4(rawConnection?.connection?.last4),
    reason: diagnosticState(rawConnection?.connection?.reason,
      new Set(['unknown', 'connected', 'license_rejected', 'account_mismatch', 'cloud_inaccessible']), 'unknown'),
    projectRegistryAuthoritative: rawConnection?.connection?.projectRegistryAuthoritative === true,
    projectsVerifiedAt: typeof rawConnection?.connection?.projectsVerifiedAt === 'string'
      ? rawConnection.connection.projectsVerifiedAt
      : null,
  };
  const cloudProjectIds = new Set(Array.isArray(rawConnection?.connection?.cloudProjectIds)
    ? rawConnection.connection.cloudProjectIds.map(safeProjectId).filter(Boolean)
    : []);
  const cache = {
    state: registry.malformed ? 'malformed' : registry.exists ? 'present' : 'missing',
    source: 'projects.json',
    projectCount: Object.keys(registry.projects).length,
  };
  const provenance = { connection, cache };
  const connectionClassification = (resolvedProjectId = null) => {
    if (!registry.exists) return 'local_registry_missing';
    if (connection.reason === 'account_mismatch') return 'account_mismatch';
    if (connection.state === 'rejected') return 'license_rejected';
    if (connection.state === 'unavailable') return 'cloud_inaccessible';
    if (connection.state === 'authenticated' && connection.projectRegistryAuthoritative &&
        resolvedProjectId && !cloudProjectIds.has(resolvedProjectId)) return 'cloud_absent';
    if (connection.state === 'authenticated' && connection.projectRegistryAuthoritative) return 'connected';
    return 'cache_only';
  };
  const withProvenance = (result, resolvedProjectId = null) => ({
    ...result,
    local_registry_missing: !registry.exists,
    projectConnectionState: connectionClassification(resolvedProjectId),
    provenance,
    // These top-level aliases are additive convenience fields for clients
    // that do not want to unpack provenance. Existing context fields remain
    // unchanged below.
    connection,
    cache,
  });

  if (!registry.exists) {
    return withProvenance({
      success: false,
      error: 'no_projects_file',
      message: 'No projects.json found in this workspace. Run configure_project once to register the project before calling /critique.',
    });
  }
  if (registry.malformed) {
    return withProvenance({
      success: false,
      error: 'malformed_projects_file',
      message: 'The local projects.json file is malformed. It was left unchanged; repair or restore it before calling /critique.',
    });
  }
  const projects = registry.projects;
  if (view && view !== 'critic') return withProvenance({ success: false, error: 'invalid_view' });
  if (url && !projectId && !name) {
    const identity = resolveProjectIdentity({ projects, urls: [url] });
    if (!identity.projectId) return withProvenance({ success: false, error: identity.status === 'ambiguous' ? 'ambiguous_project' : 'project_not_found', candidates: identity.candidates });
    projectId = identity.projectId;
  }

  // Map a project record to the public-facing read-only shape. Mirrors the
  // `ai:` block returned by configure_project so the critic sees the same
  // schema either way.
  const toContext = (id, p) => {
    // Layered critique system: the compiled `critique_context` is what the AI
    // critic should read at pin time. Fall back to the legacy `brand_context`
    // (single short blob) when no compiled context exists yet, so older
    // projects keep working until they run /refresh-brand.
    const compiledAt = p.critiqueContextCompiledAt || null;
    const pinsAtCompile = Number(p.critiqueContextPinsAtCompile || 0);
    const compiledContext = p.critiqueContext || null;
    const effectiveContext = compiledContext || p.brandContext || null;

    if (view === 'critic') return {
      projectId: id,
      name: p.name,
      urls: (p.urls || []).slice(0, 64),
      commentAccess: p.commentAccess || 'open',
      ai: { critique: {
        effectiveContext: typeof effectiveContext === 'string' ? effectiveContext.slice(0, 4000) : effectiveContext,
        policy: typeof p.critiquePolicy === 'string' ? p.critiquePolicy.slice(0, 1200) : p.critiquePolicy || null,
        staleness: stalenessLabel(compiledContext, compiledAt),
        contextTruncated: typeof effectiveContext === 'string' && effectiveContext.length > 4000,
      } },
    };
    return {
      projectId: id,
      name: p.name,
      urls: p.urls || [],
      domain: p.domain || null,
      commentAccess: p.commentAccess || 'open',
      allowedDomains: p.allowedDomains || [],
      ai: {
        // brandContext: legacy single-blob field. Kept so older /critique
        // prompts that read it directly still work. New callers should use
        // ai.critique.effectiveContext instead.
        brandContext: p.brandContext || null,
        autoCritique: p.autoCritique !== false,
        critique: {
          // What the bot should actually load into its prompt at pin time.
          // Falls back to brandContext when no compiled context exists yet.
          effectiveContext,
          // Raw compiled output of the most recent /setup or /refresh-brand
          // run. Null when the project hasn't run the compile flow.
          compiledContext,
          // User-editable critique policy override (survives recompiles).
          policy: p.critiquePolicy || null,
          // Raw signals the agent gathered (readme, theme tokens, sample copy,
          // competitors, mission, etc). JSONB — shape decided by the agent.
          signals: p.critiqueSignals || null,
          compiledAt,
          pinsAtCompile,
          // Staleness signal for /critique callers. "missing" means there is
          // no compiled context at all — the agent should run /refresh-brand
          // (or treat brandContext as a thin fallback). "fresh" / "aging" /
          // "stale" are best-effort time-based heuristics; the caller decides
          // whether to recompile. Pin-based busting happens in toolFixAndResolve.
          staleness: stalenessLabel(compiledContext, compiledAt),
        },
      },
      traceability: {
        commitTrailers: p.commitTrailers || 'minimal',
        attributionComments: p.attributionComments || 'off',
        recordCommitSha: p.recordCommitSha !== false,
      },
    };
  };

  if (projectId) {
    const p = projects[projectId];
    if (!p) {
      // Even when hydration intentionally did not retain a stale local row,
      // an authenticated authoritative cloud list can still prove that this
      // requested immutable ID is absent. Preserve that distinction for
      // support/recovery rather than collapsing it into a generic local miss.
      return withProvenance({ success: false, error: 'project_not_found', message: `No project with id "${projectId}" in this workspace.` }, projectId);
    }
    return withProvenance({ success: true, project: toContext(projectId, p) }, projectId);
  }

  if (name) {
    const entry = Object.entries(projects).find(([, p]) => p.name === name);
    if (!entry) {
      return withProvenance({
        success: false,
        error: 'project_not_found',
        message: `No project named "${name}" in this workspace.`,
        availableProjects: Object.entries(projects).map(([id, p]) => ({ projectId: id, name: p.name })),
      });
    }
    return withProvenance({ success: true, project: toContext(entry[0], entry[1]) }, entry[0]);
  }

  // No filter — return all projects' contexts so the caller can pick.
  const all = Object.entries(projects).map(([id, p]) => toContext(id, p));
  return withProvenance({ success: true, count: all.length, projects: all });
}

// ─── URL Utilities ────────────────────────────────────────────────────────────

export function urlToSlug(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname)
      .replace(/[^a-zA-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'page';
  } catch {
    return 'page';
  }
}

// ─── File Reading ─────────────────────────────────────────────────────────────

export async function readAnnotationFiles(annotationsDir, { versioned = false } = {}) {
  if (versioned) {
    return readVersionedAnnotationPages({ annotationsDir, ensureMigrated: true });
  }
  if (!existsSync(annotationsDir)) return {};

  const files = await readdir(annotationsDir).catch(() => []);
  const result = {};

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = await readFile(join(annotationsDir, file), 'utf-8');
      const data = JSON.parse(content);
      result[data.pageUrl || file] = data;
    } catch {
      // Skip malformed files silently
    }
  }

  return result;
}

function malformedAuthoritativeSnapshot() {
  const error = new Error('Authoritative Pincushion sync returned a malformed annotation snapshot; cached pins are intentionally withheld.');
  error.code = 'authoritative_sync_unavailable';
  error.reason = 'malformed_response';
  error.status = 0;
  return error;
}

function isAuthoritativeAnnotationSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  return Object.values(snapshot).every((page) => (
    page &&
    typeof page === 'object' &&
    !Array.isArray(page) &&
    typeof page.pageUrl === 'string' &&
    Array.isArray(page.annotations)
  ));
}

export async function readAllAnnotations(config, fetchRemote = null) {
  // The explicit no-sync/local-only path retains the project-local annotation
  // files as its source of truth. Once a caller supplies a configured cloud
  // authority, that snapshot is the entire source of truth: merging in local
  // rows would let a remotely dismissed pin re-enter an implementation queue.
  if (!fetchRemote) {
    return readAnnotationFiles(config.annotationsDir, {
      versioned: config?.annotationCacheVersion === 2,
    });
  }

  const remote = await fetchRemote();
  if (!isAuthoritativeAnnotationSnapshot(remote)) throw malformedAuthoritativeSnapshot();
  return remote;
}

export async function writeAnnotationFile(annotationsDir, pageData, {
  versioned = false,
  projectId = null,
} = {}) {
  // Local-only and legacy callers can keep their unscoped compatibility file.
  // Authoritative callers supply the immutable project scope and are routed to
  // v2, whose hash key includes that scope plus the exact page URL.
  if (versioned && typeof projectId === 'string' && projectId) {
    return writeScopedAnnotationPage({
      annotationsDir,
      projectId,
      pageUrl: pageData?.pageUrl,
      pageData,
    });
  }
  if (!existsSync(annotationsDir)) {
    mkdirSync(annotationsDir, { recursive: true });
  }

  const slug = urlToSlug(pageData.pageUrl);
  const filePath = join(annotationsDir, `${slug}.json`);
  await writeFile(filePath, JSON.stringify(pageData, null, 2), 'utf-8');
  return filePath;
}

function annotationPageUrl(entryKey, pageData) {
  return pageUrlFromAnnotationEntry(entryKey, pageData);
}

async function writeCachedAnnotationPage(config, pageData, projectId) {
  return writeAnnotationFile(config.annotationsDir, pageData, {
    versioned: config?.annotationCacheVersion === 2,
    projectId,
  });
}

function clonePageData(data) {
  return JSON.parse(JSON.stringify(data));
}

function lifecycleFailure(annotationId, accepted) {
  return {
    success: false,
    annotationId,
    error: accepted.error || 'remote_lifecycle_rejected',
    status: accepted.status || 0,
    message: accepted.message || `Cloud lifecycle update for pin "${annotationId}" was not accepted. Local files were left unchanged.`,
  };
}

// Existing annotation lifecycle writes require an accepted remote canonical
// receipt. Build on a detached page clone, wait for the exact canonical row,
// and only then write the annotation file/index. This is intentionally separate
// from new-pin creation, whose local-first behavior is still the documented
// offline fallback.
async function persistLifecycleCandidate(config, sourcePage, candidatePage, candidateAnn, pageUrl) {
  const accepted = await acceptLifecycleMutation(config, candidateAnn, pageUrl, candidatePage.pageTitle || sourcePage.pageTitle);
  if (!accepted.ok) return { ok: false, result: lifecycleFailure(candidateAnn.id, accepted) };

  const index = candidatePage.annotations.findIndex((item) => item.id === candidateAnn.id);
  if (index === -1) {
    return {
      ok: false,
      result: {
        success: false,
        annotationId: candidateAnn.id,
        error: 'local_candidate_missing',
        message: `Local candidate for pin "${candidateAnn.id}" disappeared before it could be committed.`,
      },
    };
  }
  candidatePage.annotations[index] = accepted.annotation;
  candidatePage.exportedAt = new Date().toISOString();
  let persistedPage = candidatePage;
  const canonicalProjectId = accepted.annotation.projectId;
  if (config?.annotationCacheVersion === 2 && typeof canonicalProjectId === 'string' && canonicalProjectId) {
    // A remote lifecycle acknowledgement can race a bridge or cloud pull for
    // the same exact page. Re-read and merge only this canonical row while
    // holding the scope lease so an unrelated accepted row is retained.
    const persisted = await updateScopedAnnotationPage({
      annotationsDir: config.annotationsDir,
      projectId: canonicalProjectId,
      pageUrl,
      update: (current) => {
        const next = current ? clonePageData(current) : clonePageData(candidatePage);
        const currentIndex = next.annotations.findIndex((item) => item?.id === candidateAnn.id);
        if (currentIndex >= 0) next.annotations[currentIndex] = accepted.annotation;
        else next.annotations.push(accepted.annotation);
        next.projectId = canonicalProjectId;
        next.pageUrl = pageUrl;
        next.pageTitle = candidatePage.pageTitle || next.pageTitle || sourcePage.pageTitle || pageUrl;
        next.exportedAt = candidatePage.exportedAt;
        return next;
      },
    });
    persistedPage = persisted.pageData;
  } else {
    await writeCachedAnnotationPage(config, candidatePage, canonicalProjectId);
  }
  await rebuildIndex(config);
  return { ok: true, annotation: accepted.annotation, page: persistedPage, remote: accepted.remote };
}

async function removeAgentQueueEntry(config, annotationId) {
  if (!config.agentQueueDir) return;
  try {
    const { unlink } = await import('fs/promises');
    const queueFile = agentQueueFilePath(config.agentQueueDir, annotationId);
    if (queueFile && existsSync(queueFile)) await unlink(queueFile);
  } catch (err) {
    console.error(`[pincushion] Failed to remove agent queue file for ${annotationId} (non-fatal):`, err?.message || err);
  }
}

// Count resolved pins for a project — used to baseline `critique_context_pins_at_compile`
// at compile time, so a later /critique can detect that N more pins have
// been resolved since the brief was built (a strong "recompile" signal).
//
// Falls back to 0 when annotations aren't readable yet (fresh project, no
// .feedback/annotations/ dir). projectId may be undefined for projects that
// pre-date projectId tagging — caller treats 0 as "we don't know."
export async function countResolvedPinsForProject(config, projectId) {
  if (!projectId) return 0;
  const allData = await readAnnotationFiles(config.annotationsDir, {
    versioned: config?.annotationCacheVersion === 2,
  });
  let count = 0;
  for (const data of Object.values(allData)) {
    for (const ann of (data.annotations || [])) {
      if (ann.status === 'resolved' && (ann.projectId === projectId || !ann.projectId)) {
        count++;
      }
    }
  }
  return count;
}

// Find a single annotation by ID across all pages (for cloud sync push-back)
export async function findAnnotationById(config, annotationId) {
  const allData = await readAllAnnotations(config);
  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (ann) return { ...ann, pageUrl, pageTitle: data.pageTitle };
  }
  return null;
}

export async function rebuildIndex(config) {
  const allData = await readAllAnnotations(config);
  const pages = [];
  let totalOpen = 0;
  let totalResolved = 0;

  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    const anns = data.annotations || [];
    const open = anns.filter(a => !isTerminalStatus(a.status)).length;
    const resolved = anns.filter(a => a.status === 'resolved').length;
    totalOpen += open;
    totalResolved += resolved;
    const cacheFile = data.cacheVersion === 2 && typeof data.projectId === 'string' && data.projectId && data.scope?.scopeHash
      ? (() => {
        const scope = annotationCachePath(config.annotationsDir, { projectId: data.projectId, pageUrl });
        return `annotations/v2/${scope.projectHash}/${scope.scopeHash}.json`;
      })()
      : `annotations/${urlToSlug(pageUrl)}.json`;
    pages.push({
      url: pageUrl,
      slug: urlToSlug(pageUrl),
      title: data.pageTitle || pageUrl,
      totalPins: anns.length,
      open,
      resolved,
      file: cacheFile,
    });
  }

  const index = {
    generatedAt: new Date().toISOString(),
    summary: { totalPages: pages.length, totalOpen, totalResolved },
    pages
  };

  const feedbackDir = config.feedbackDir;
  if (!existsSync(feedbackDir)) mkdirSync(feedbackDir, { recursive: true });
  await writeFile(join(feedbackDir, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');
  return index;
}

// ─── Format Helpers ───────────────────────────────────────────────────────────

export function formatAnnotationForAgent(ann, number) {
  return {
    id: ann.id,
    number,
    status: ann.status,
    tags: ann.tags,
    createdAt: ann.createdAt,
    resolvedAt: ann.resolvedAt,
    element: {
      lwcComponent: ann.element?.lwcComponent,
      selector: ann.element?.selector,
      tagName: ann.element?.tagName,
      textContent: ann.element?.textContent?.slice(0, 150),
      attributes: ann.element?.attributes
    },
    thread: ann.thread?.map(serializeThreadMessage)
  };
}

// ─── Tool Implementations ─────────────────────────────────────────────────────

export async function toolGetAnnotations(config, { pageUrl, pageUrls, componentName, status, projectId, view, critiqueRunId } = {}, fetchRemote = null) {
  if (view && view !== 'critique') return { error: 'invalid_view' };
  if (componentName !== undefined && componentName !== null && typeof componentName !== 'string') {
    return { error: 'componentName must be a string' };
  }
  if (pageUrls !== undefined && (!Array.isArray(pageUrls) || pageUrls.length > 64 || pageUrls.some(url => typeof url !== 'string'))) {
    return { error: 'pageUrls must contain at most 64 URL strings' };
  }
  if (view === 'critique' && !projectId) return { error: 'projectId is required for critique view' };
  const allData = await readAllAnnotations(config, fetchRemote);
  const results = [];
  const exactUrls = pageUrls ? new Set(pageUrls) : null;
  let totalMatched = 0;

  for (const [entryKey, data] of Object.entries(allData)) {
    const actualPageUrl = annotationPageUrl(entryKey, data);
    let anns = data.annotations || [];

    // Filter to current project (supports string ID or Set of IDs)
    if (projectId) anns = anns.filter(a => matchesProject(a.projectId, projectId));

    // Filter by page URL
    if (exactUrls && !exactUrls.has(actualPageUrl)) continue;
    if (!exactUrls && pageUrl && !actualPageUrl.includes(pageUrl) && !pageUrl.includes(actualPageUrl)) continue;
    if (critiqueRunId) anns = anns.filter(a => (a.tags || []).includes(`critique-run:${critiqueRunId}`));

    // Filter by component name
    if (componentName) {
      const comp = componentName.toLowerCase().replace(/^c-/, '');
      anns = anns.filter(a => {
        const lwc = (a.element?.lwcComponent || '').toLowerCase().replace(/^c-/, '');
        const selector = (a.element?.selector || '').toLowerCase();
        return lwc.includes(comp) || selector.includes(comp);
      });
    }

    // Filter by status
    if (status) {
      anns = anns.filter(a => a.status === status);
    }

    if (anns.length === 0) continue;

    totalMatched += anns.length;
    results.push({
      pageUrl: actualPageUrl,
      pageTitle: data.pageTitle || actualPageUrl,
      annotations: view === 'critique'
        ? anns.slice(0, 20).map(a => ({
          id: a.id,
          status: a.status,
          selector: a.element?.selector || null,
          body: String(a.thread?.[0]?.body || '').slice(0, 180),
          priority: a.priority || null,
          visibility: a.visibility || 'public',
          isBot: a.isBot === true,
          tags: (a.tags || []).filter(tag => tag === 'pincushion-ai' || tag.startsWith('critique-run:')).slice(0, 2),
        }))
        : anns.map((a, idx) => formatAnnotationForAgent(a, idx + 1))
    });
    if (view === 'critique' && results.length >= 64) break;
  }

  if (results.length === 0) {
    return { message: 'No annotations found matching the given filters.', feedbackDir: config.feedbackDir };
  }

  return { totalPages: results.length, ...(view === 'critique' ? { totalMatched, truncated: totalMatched > results.reduce((sum, page) => sum + page.annotations.length, 0) } : {}), pages: results };
}

export async function toolSearchAnnotations(config, { query }, fetchRemote = null) {
  if (!query) return { error: 'query parameter is required' };
  if (typeof query !== 'string') return { error: 'query must be a string' };

  const allData = await readAllAnnotations(config, fetchRemote);
  const matches = [];
  const q = query.toLowerCase();

  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    for (const ann of (data.annotations || [])) {
      const searchText = [
        ann.element?.selector,
        ann.element?.lwcComponent,
        ann.element?.textContent,
        ...(ann.thread || []).map(m => m.body),
        ...(ann.tags || [])
      ].join(' ').toLowerCase();

      if (searchText.includes(q)) {
        matches.push({
          pageUrl,
          pageTitle: data.pageTitle || pageUrl,
          annotation: formatAnnotationForAgent(ann, null)
        });
      }
    }
  }

  return {
    query,
    totalMatches: matches.length,
    results: matches
  };
}

export async function toolGetFeedbackSummary(config, fetchRemote = null, { projectId } = {}) {
  const allData = await readAllAnnotations(config, fetchRemote);

  let totalOpen = 0;
  let totalApproved = 0;
  let totalInProgress = 0;
  let totalResolved = 0;
  let totalArchived = 0;
  let totalDismissed = 0;
  const byPage = [];
  const byComponent = {};
  const openItems = [];

  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    // Filter annotations to current project (supports string ID or Set of IDs)
    const anns = (data.annotations || []).filter(a =>
      matchesProject(a.projectId, projectId)
    );
    const open = anns.filter(a => a.status === 'open').length;
    const approved = anns.filter(a => isReadyStatus(a.status)).length;
    const inProgress = anns.filter(a => a.status === 'in-progress').length;
    const resolved = anns.filter(a => a.status === 'resolved').length;
    const archived = anns.filter(a => a.status === 'archived').length;
    const dismissed = anns.filter(a => a.status === 'dismissed').length;

    totalOpen += open;
    totalApproved += approved;
    totalInProgress += inProgress;
    totalResolved += resolved;
    totalArchived += archived;
    totalDismissed += dismissed;

    if (anns.length > 0) {
      byPage.push({
        pageUrl,
        pageTitle: data.pageTitle || pageUrl,
        total: anns.length,
        open,
        approved,
        inProgress,
        resolved,
        archived,
        dismissed,
      });
    }

    // Group by LWC component
    for (const ann of anns) {
      const comp = ann.element?.lwcComponent;
      if (comp) {
        if (!byComponent[comp]) byComponent[comp] = { open: 0, resolved: 0, total: 0 };
        byComponent[comp].total++;
        if (ann.status === 'resolved') byComponent[comp].resolved++;
        else if (!isTerminalStatus(ann.status)) byComponent[comp].open++;
      }
    }

    // Collect open items with context
    for (const ann of anns.filter(a => !isTerminalStatus(a.status))) {
      openItems.push({
        id: ann.id,
        pageTitle: data.pageTitle || pageUrl,
        pageUrl,
        component: ann.element?.lwcComponent || ann.element?.tagName,
        firstComment: ann.thread[0]?.body || '(no comment)',
        author: ann.thread[0]?.author,
        createdAt: ann.createdAt,
        replyCount: ann.thread.length
      });
    }
  }

  // Sort open items by age (oldest first). Priority-based sort was removed
  // when the priority column became dormant — every pin is 'medium' in
  // practice, so the secondary sort key collapsed to a no-op.
  openItems.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return {
    summary: {
      totalOpen,
      totalApproved,
      totalInProgress,
      totalResolved,
      totalArchived,
      totalDismissed,
      totalAnnotations: totalOpen + totalApproved + totalInProgress + totalResolved + totalArchived + totalDismissed
    },
    openItems: openItems.slice(0, 50),
    byPage,
    byComponent,
    feedbackDir: config.feedbackDir
  };
}

export async function toolGetComponentFeedback(config, { componentName }, fetchRemote = null) {
  if (!componentName) return { error: 'componentName parameter is required' };
  if (typeof componentName !== 'string') return { error: 'componentName must be a string' };

  const comp = componentName.toLowerCase().replace(/^c-/, '').replace(/-/g, '');
  const allData = await readAllAnnotations(config, fetchRemote);
  const results = [];

  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    const matching = (data.annotations || []).filter(ann => {
      const lwc = (ann.element?.lwcComponent || '').toLowerCase().replace(/^c-/, '').replace(/-/g, '');
      const selector = (ann.element?.selector || '').toLowerCase().replace(/-/g, '');
      const tags = (ann.tags || []).join(' ').toLowerCase().replace(/-/g, '');
      return lwc.includes(comp) || selector.includes(comp) || tags.includes(comp);
    });

    if (matching.length > 0) {
      results.push({
        pageUrl,
        pageTitle: data.pageTitle || pageUrl,
        annotations: matching.map((a, idx) => formatAnnotationForAgent(a, idx + 1))
      });
    }
  }

  // Generate a summary for the agent
  const allAnns = results.flatMap(r => r.annotations);
  const open = allAnns.filter(a => !isTerminalStatus(a.status));
  const resolved = allAnns.filter(a => a.status === 'resolved');

  const summary = open.length === 0
    ? `No open feedback for component "${componentName}".`
    : `${open.length} open item(s) for "${componentName}": ${open.map(a =>
        `"${a.thread[0]?.body?.slice(0, 80) || 'no comment'}" (element: ${a.element.selector})`
      ).join('; ')}`;

  return {
    componentName,
    summary,
    totalOpen: open.length,
    totalResolved: resolved.length,
    pages: results
  };
}

export async function toolResolveAnnotation(config, { annotationId, comment, resolvedBy }, fetchRemote = null) {
  const allData = await readAllAnnotations(config, fetchRemote);

  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;

    if (ann.status === 'resolved') {
      return { success: true, annotationId, alreadyResolved: true, message: `Pin "${annotationId}" was already resolved` };
    }
    if (isTerminalStatus(ann.status)) return rejectedTerminalMutation(annotationId, ann.status);

    const candidatePage = clonePageData(data);
    const candidate = candidatePage.annotations.find(a => a.id === annotationId);
    const now = new Date().toISOString();

    candidate.status = 'resolved';
    candidate.resolvedAt = now;
    candidate.updatedAt = now;

    if (comment) {
      candidate.thread = candidate.thread || [];
      candidate.thread.push({
        id: `msg_${Date.now().toString(36)}`,
        author: resolvedBy || 'AI Agent',
        authorEmail: '',
        timestamp: now,
        body: comment,
        type: 'resolution'
      });
    }

    const persisted = await persistLifecycleCandidate(config, data, candidatePage, candidate, pageUrl);
    if (!persisted.ok) return persisted.result;
    await removeAgentQueueEntry(config, annotationId);

    return {
      success: true,
      annotationId,
      message: `Resolved annotation "${annotationId}" on page "${persisted.page.pageTitle || pageUrl}"`
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

export async function toolApprovePin(config, { annotationId, approvedBy }, fetchRemote = null) {
  if (!annotationId) return { error: 'annotationId is required' };

  const allData = await readAllAnnotations(config, fetchRemote);

  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;

    if (isTerminalStatus(ann.status)) return rejectedTerminalMutation(annotationId, ann.status);
    if (isReadyStatus(ann.status)) {
      return { success: true, annotationId, message: `Pin "${annotationId}" was already approved`, alreadyApproved: true };
    }

    const candidatePage = clonePageData(data);
    const candidate = candidatePage.annotations.find(a => a.id === annotationId);
    const now = new Date().toISOString();

    // Write the modern status name. Old `approved`/`approvedAt`/`approvedBy`
    // fields stay for backwards compat with consumers that haven't migrated,
    // but `status: 'ready'` is canonical post-rename-migration.
    candidate.status = 'ready';
    candidate.approvedAt = now;
    candidate.approvedBy = approvedBy || 'Unknown';
    candidate.updatedAt = now;

    // Add approval event to thread
    candidate.thread = candidate.thread || [];
    candidate.thread.push({
      id: `msg_${Date.now().toString(36)}`,
      author: approvedBy || 'Unknown',
      authorEmail: '',
      timestamp: now,
      body: `Approved for implementation`,
      type: 'approval'
    });

    const persisted = await persistLifecycleCandidate(config, data, candidatePage, candidate, pageUrl);
    if (!persisted.ok) return persisted.result;

    return {
      success: true,
      annotationId,
      approvedAt: persisted.annotation.approvedAt,
      approvedBy: persisted.annotation.approvedBy,
      pageTitle: persisted.page.pageTitle || pageUrl,
      message: `Pin "${annotationId}" approved for implementation on "${persisted.page.pageTitle || pageUrl}"`
    };
  }

  return { success: false, error: `Pin "${annotationId}" not found` };
}

const CLIENT_REVIEW_GUIDANCE_MAX_BYTES = 512 * 1024;
const CLIENT_REVIEW_GUIDANCE_TIMEOUT_MS = 15_000;
const CLIENT_REVIEW_PROJECT = /^pc_proj_[a-z0-9][a-z0-9_-]{0,127}$/;
const CLIENT_REVIEW_ANNOTATION = /^ann_[a-z0-9][a-z0-9_-]{0,127}$/;
const CLIENT_REVIEW_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_REVIEW_DIGEST = /^[a-f0-9]{64}$/i;
const CLIENT_REVIEW_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const CLIENT_REVIEW_PACKAGE_ALGORITHM = 'application_canonical_json_v1_sha256_utf8';

function isClientReviewRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clientReviewExactKeys(value, keys) {
  return isClientReviewRecord(value)
    && Object.getOwnPropertySymbols(value).length === 0
    && Object.keys(value).length === keys.length
    && keys.every(key => Object.prototype.hasOwnProperty.call(value, key));
}

function clientReviewTimestamp(value, { nullable = false } = {}) {
  return nullable && value === null
    ? true
    : typeof value === 'string' && CLIENT_REVIEW_TIMESTAMP.test(value);
}

function clientReviewPageUrl(value) {
  return typeof value === 'string' && value === value.trim() && value.length >= 1 && value.length <= 2000;
}

function clientReviewStringArray(value, limit, predicate) {
  if (!Array.isArray(value) || value.length > limit) return null;
  const output = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || !predicate(item) || seen.has(item)) return null;
    seen.add(item);
    output.push(item);
  }
  return output;
}

// This boundary mirrors the Edge adapter's allowlist.  A service-side schema
// extension cannot accidentally flow through the local MCP packet, especially
// not a reviewer address, guest credential, token, actor proof, or raw SQL
// field.  The returned object remains small enough for a review packet.
function normalizeClientReviewGuidance(value, expectedProjectId) {
  if (!clientReviewExactKeys(value, ['projectId', 'guidance']) || value.projectId !== expectedProjectId) return null;
  const guidance = value.guidance;
  if (!clientReviewExactKeys(guidance, [
    'state', 'lifecycle', 'decisionState', 'lifecycleState', 'artifactAvailability',
    'review', 'annotationIds', 'annotationRevisions', 'pageUrls', 'instructions',
    'notes', 'copyProposals', 'copyProposalsTruncated',
  ])) return null;
  const validStates = new Set(['not_requested', 'awaiting_review', 'changes_requested', 'accepted']);
  const validLifecycles = new Set(['none', 'active', 'superseded', 'closed']);
  const validArtifactAvailability = new Set(['not_requested', 'available', 'expired']);
  if (!validStates.has(guidance.state) || !validLifecycles.has(guidance.lifecycle) ||
    !validStates.has(guidance.decisionState) || !validLifecycles.has(guidance.lifecycleState) ||
    !validArtifactAvailability.has(guidance.artifactAvailability) ||
    guidance.state !== guidance.decisionState || guidance.lifecycle !== guidance.lifecycleState ||
    typeof guidance.instructions !== 'string' || guidance.instructions.length > 16384 ||
    typeof guidance.copyProposalsTruncated !== 'boolean') return null;
  const annotationIds = clientReviewStringArray(guidance.annotationIds, 100, item => CLIENT_REVIEW_ANNOTATION.test(item));
  const pageUrls = clientReviewStringArray(guidance.pageUrls, 20, clientReviewPageUrl);
  if (!annotationIds || !pageUrls) return null;
  let review = null;
  if (guidance.review !== null) {
    const candidate = guidance.review;
    if (!clientReviewExactKeys(candidate, [
      'id', 'issuedAt', 'packageDigest', 'packageAlgorithm', 'evidenceExpiresAt', 'supersededByReviewId',
    ]) || typeof candidate.id !== 'string' || !CLIENT_REVIEW_UUID.test(candidate.id) ||
      !clientReviewTimestamp(candidate.issuedAt) || typeof candidate.packageDigest !== 'string' ||
      !CLIENT_REVIEW_DIGEST.test(candidate.packageDigest) || candidate.packageAlgorithm !== CLIENT_REVIEW_PACKAGE_ALGORITHM ||
      !clientReviewTimestamp(candidate.evidenceExpiresAt, { nullable: true }) ||
      !(candidate.supersededByReviewId === null || (typeof candidate.supersededByReviewId === 'string' && CLIENT_REVIEW_UUID.test(candidate.supersededByReviewId)))) return null;
    review = {
      id: candidate.id,
      issuedAt: candidate.issuedAt,
      packageDigest: candidate.packageDigest.toLowerCase(),
      packageAlgorithm: candidate.packageAlgorithm,
      evidenceExpiresAt: candidate.evidenceExpiresAt,
      supersededByReviewId: candidate.supersededByReviewId,
    };
  }
  if ((guidance.decisionState === 'not_requested') !== (review === null) ||
    (guidance.decisionState === 'not_requested' &&
      (guidance.lifecycleState !== 'none' || guidance.artifactAvailability !== 'not_requested')) ||
    (guidance.decisionState !== 'not_requested' &&
      (guidance.lifecycleState === 'none' || guidance.artifactAvailability === 'not_requested'))) return null;
  if (!Array.isArray(guidance.annotationRevisions) || guidance.annotationRevisions.length > 100) return null;
  const annotationRevisions = [];
  const revisionAnnotationIds = new Set();
  for (const revision of guidance.annotationRevisions) {
    if (!clientReviewExactKeys(revision, [
      'annotationId', 'captureId', 'pageUrl', 'selector', 'sourceRevision', 'sourceRevisionDigest',
      'reviewId', 'packageDigest', 'packageAlgorithm',
    ]) || typeof revision.annotationId !== 'string' || !CLIENT_REVIEW_ANNOTATION.test(revision.annotationId) ||
      typeof revision.captureId !== 'string' || !CLIENT_REVIEW_UUID.test(revision.captureId) ||
      !clientReviewPageUrl(revision.pageUrl) || typeof revision.selector !== 'string' ||
      revision.selector.length < 1 || revision.selector.length > 2048 ||
      typeof revision.sourceRevision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(revision.sourceRevision) ||
      typeof revision.sourceRevisionDigest !== 'string' || !CLIENT_REVIEW_DIGEST.test(revision.sourceRevisionDigest) ||
      typeof revision.reviewId !== 'string' || !CLIENT_REVIEW_UUID.test(revision.reviewId) ||
      typeof revision.packageDigest !== 'string' || !CLIENT_REVIEW_DIGEST.test(revision.packageDigest) ||
      revision.packageAlgorithm !== CLIENT_REVIEW_PACKAGE_ALGORITHM || !review ||
      revision.reviewId !== review.id || revision.packageDigest.toLowerCase() !== review.packageDigest ||
      !annotationIds.includes(revision.annotationId) || !pageUrls.includes(revision.pageUrl) ||
      revisionAnnotationIds.has(revision.annotationId)) return null;
    revisionAnnotationIds.add(revision.annotationId);
    annotationRevisions.push({
      annotationId: revision.annotationId, captureId: revision.captureId, pageUrl: revision.pageUrl,
      selector: revision.selector, sourceRevision: revision.sourceRevision,
      sourceRevisionDigest: revision.sourceRevisionDigest.toLowerCase(), reviewId: revision.reviewId,
      packageDigest: revision.packageDigest.toLowerCase(), packageAlgorithm: revision.packageAlgorithm,
    });
  }
  if (!Array.isArray(guidance.notes) || guidance.notes.length > 20) return null;
  const notes = [];
  for (const note of guidance.notes) {
    if (!clientReviewExactKeys(note, ['note', 'recordedAt']) || typeof note.note !== 'string' ||
      note.note.length > 4096 || !clientReviewTimestamp(note.recordedAt)) return null;
    notes.push({ note: note.note, recordedAt: note.recordedAt });
  }
  if (!Array.isArray(guidance.copyProposals) || guidance.copyProposals.length > 8) return null;
  const copyProposals = [];
  const fingerprints = new Set();
  for (const proposal of guidance.copyProposals) {
    if (!clientReviewExactKeys(proposal, [
      'pageUrl', 'captureId', 'annotationId', 'selector', 'originalText', 'replacementText',
      'decisionRecordedAt', 'reviewId', 'packageDigest', 'packageAlgorithm',
    ]) || !clientReviewPageUrl(proposal.pageUrl) || typeof proposal.captureId !== 'string' ||
      !CLIENT_REVIEW_UUID.test(proposal.captureId) ||
      !(proposal.annotationId === null || (typeof proposal.annotationId === 'string' && CLIENT_REVIEW_ANNOTATION.test(proposal.annotationId))) ||
      typeof proposal.selector !== 'string' || proposal.selector.length < 1 || proposal.selector.length > 2048 ||
      typeof proposal.originalText !== 'string' || proposal.originalText.length < 1 || proposal.originalText.length > 16384 ||
      typeof proposal.replacementText !== 'string' || proposal.replacementText.length > 16384 ||
      !clientReviewTimestamp(proposal.decisionRecordedAt) || typeof proposal.reviewId !== 'string' ||
      !CLIENT_REVIEW_UUID.test(proposal.reviewId) || typeof proposal.packageDigest !== 'string' ||
      !CLIENT_REVIEW_DIGEST.test(proposal.packageDigest) || proposal.packageAlgorithm !== CLIENT_REVIEW_PACKAGE_ALGORITHM ||
      !review || proposal.reviewId !== review.id || proposal.packageDigest.toLowerCase() !== review.packageDigest ||
      !pageUrls.includes(proposal.pageUrl) ||
      (typeof proposal.annotationId === 'string' && !annotationIds.includes(proposal.annotationId))) return null;
    const fingerprint = `${proposal.captureId}\0${proposal.annotationId || ''}\0${proposal.selector}\0${proposal.originalText}\0${proposal.replacementText}`;
    if (fingerprints.has(fingerprint)) return null;
    fingerprints.add(fingerprint);
    copyProposals.push({
      pageUrl: proposal.pageUrl, captureId: proposal.captureId, annotationId: proposal.annotationId,
      selector: proposal.selector, originalText: proposal.originalText,
      replacementText: proposal.replacementText, decisionRecordedAt: proposal.decisionRecordedAt,
      reviewId: proposal.reviewId, packageDigest: proposal.packageDigest.toLowerCase(),
      packageAlgorithm: proposal.packageAlgorithm,
    });
  }
  return {
    state: guidance.state,
    lifecycle: guidance.lifecycle,
    decisionState: guidance.decisionState,
    lifecycleState: guidance.lifecycleState,
    artifactAvailability: guidance.artifactAvailability,
    review,
    annotationIds,
    annotationRevisions,
    pageUrls,
    instructions: guidance.instructions,
    notes,
    copyProposals,
    copyProposalsTruncated: guidance.copyProposalsTruncated,
  };
}

function clientReviewEndpoint(config = {}) {
  const configuredBase = typeof config.supabaseBase === 'string' ? config.supabaseBase : '';
  const configuredSync = typeof config.syncServerUrl === 'string' ? config.syncServerUrl : '';
  const raw = configuredBase || configuredSync;
  if (!raw || raw !== raw.trim() || /[\u0000-\u001f\u007f]/.test(raw)) return null;
  try {
    const endpoint = new URL(raw);
    if ((endpoint.protocol !== 'https:' && endpoint.protocol !== 'http:') || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return null;
    const segments = endpoint.pathname.split('/').filter(Boolean);
    if (configuredBase) {
      if (segments.length < 2 || segments.at(-2) !== 'functions' || segments.at(-1) !== 'v1') return null;
      segments.push('client-review');
    } else {
      if (segments.at(-1) !== 'sync-annotations') return null;
      segments[segments.length - 1] = 'client-review';
    }
    endpoint.pathname = `/${segments.join('/')}`;
    return endpoint.toString();
  } catch {
    return null;
  }
}

function exactClientReviewLicense(config = {}) {
  const candidate = typeof config.licenseKey === 'string'
    ? config.licenseKey
    : typeof config.syncApiKey === 'string' ? config.syncApiKey : null;
  // Preserve the credential byte-for-byte.  Whitespace/control is not a
  // normalization opportunity at an authority boundary.
  return candidate && candidate === candidate.trim() && !/[\u0000-\u001f\u007f]/.test(candidate) ? candidate : null;
}

async function boundedClientReviewJson(response) {
  try {
    if (typeof response?.arrayBuffer === 'function') {
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > CLIENT_REVIEW_GUIDANCE_MAX_BYTES) return null;
      return JSON.parse(new TextDecoder().decode(bytes));
    }
    if (typeof response?.text === 'function') {
      const body = await response.text();
      if (typeof body !== 'string' || Buffer.byteLength(body, 'utf8') > CLIENT_REVIEW_GUIDANCE_MAX_BYTES) return null;
      return JSON.parse(body);
    }
  } catch {
    // An invalid/oversized response is unavailable, not an empty review.
  }
  return null;
}

function unavailableClientReviewGuidance(reason) {
  return {
    availability: { state: 'unavailable', reason },
    state: 'unavailable', lifecycle: 'unavailable', decisionState: 'unavailable',
    lifecycleState: 'unavailable', artifactAvailability: 'unavailable', review: null,
    annotationIds: [], annotationRevisions: [], pageUrls: [], instructions: '', notes: [], copyProposals: [],
    copyProposalsTruncated: false,
    sourceRevalidation: {
      availability: { state: 'unavailable', reason: 'source_revalidation_not_run' },
      checks: [],
      note: 'No client-review guidance was available, so no local source text was checked.',
    },
  };
}

async function loadClientReviewGuidance(config, projectId) {
  if (!CLIENT_REVIEW_PROJECT.test(projectId)) return unavailableClientReviewGuidance('client_review_project_invalid');
  const endpoint = clientReviewEndpoint(config);
  const licenseKey = exactClientReviewLicense(config);
  const fetchImpl = config.fetchImpl || globalThis.fetch;
  if (!endpoint || !licenseKey || typeof fetchImpl !== 'function') return unavailableClientReviewGuidance('client_review_guidance_unavailable');
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), CLIENT_REVIEW_GUIDANCE_TIMEOUT_MS) : null;
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST', redirect: 'error', cache: 'no-store', credentials: 'omit',
      ...(controller ? { signal: controller.signal } : {}),
      headers: {
        accept: 'application/json', 'content-type': 'application/json',
        'x-license-key': licenseKey,
        'x-pincushion-client': `mcp/${config.pkgVersion || '0'}`,
      },
      body: JSON.stringify({ action: 'owner_guidance', projectId }),
    });
    const body = await boundedClientReviewJson(response);
    if (!response?.ok) {
      const code = isClientReviewRecord(body) && typeof (body.error || body.code) === 'string'
        ? (body.error || body.code) : '';
      return unavailableClientReviewGuidance(code === 'client_review_pilot_disabled'
        ? 'client_review_pilot_inactive' : 'client_review_guidance_unavailable');
    }
    const guidance = normalizeClientReviewGuidance(body, projectId);
    if (!guidance) return unavailableClientReviewGuidance('client_review_guidance_unavailable');
    return {
      availability: { state: 'available' },
      ...guidance,
      sourceRevalidation: null,
    };
  } catch {
    return unavailableClientReviewGuidance('client_review_guidance_unavailable');
  } finally {
    if (timer) clearTimeout(timer);
  }
}

const CLIENT_REVIEW_GUIDANCE_PROJECT_LIMIT = 16;
const CLIENT_REVIEW_CHANGE_PACKET_LIMIT = 20;
const CLIENT_REVIEW_CHANGE_PIN_LIMIT = 100;
const CLIENT_REVIEW_CHANGE_PINS_PER_PACKET = 20;
const CLIENT_REVIEW_CHANGE_CANDIDATE_LIMIT = 400;

function noApplicableClientReviewGuidance(loaded) {
  return {
    ...loaded,
    state: 'not_requested', lifecycle: 'none', decisionState: 'not_requested',
    lifecycleState: 'none', artifactAvailability: 'not_requested', review: null,
    annotationIds: [], annotationRevisions: [], pageUrls: [], instructions: '', notes: [],
    copyProposals: [], copyProposalsTruncated: false,
    sourceRevalidation: {
      availability: { state: 'available' }, checks: [],
      note: 'The active client-review record does not include a pin in this implementation packet.',
    },
  };
}

async function scopedClientReviewGuidance(config, loaded, packet) {
  const packetPinIds = new Set((packet.pins || []).map(pin => pin.id));
  const applies = loaded.annotationIds.some(annotationId => packetPinIds.has(annotationId));
  if (!applies) return noApplicableClientReviewGuidance(loaded);
  const proposals = loaded.copyProposals.filter(proposal =>
    proposal.pageUrl === packet.pageUrl &&
    (proposal.annotationId === null || packetPinIds.has(proposal.annotationId))
  );
  const sourceRevalidation = config.projectDir && proposals.length > 0
    ? await revalidateTrackedSourceText(config.projectDir, proposals.map(proposal => proposal.originalText))
    : {
      availability: { state: 'unavailable', reason: config.projectDir ? 'source_revalidation_not_needed' : 'source_revalidation_project_unavailable' },
      checks: [],
      note: 'Copy proposals are bounded review observations, not a global replacement instruction or proof that a screenshot is editable.',
    };
  const originals = [...new Set(proposals.map(proposal => proposal.originalText))].slice(0, 8);
  const revalidationByOriginal = new Map(originals.map((originalText, index) => [
    originalText, sourceRevalidation.checks?.[index] || null,
  ]));
  return {
    ...loaded,
    annotationRevisions: loaded.annotationRevisions.filter(revision =>
      revision.pageUrl === packet.pageUrl && packetPinIds.has(revision.annotationId)
    ),
    copyProposals: proposals.map(proposal => ({
      ...proposal,
      originalTextRevalidation: revalidationByOriginal.get(proposal.originalText) || null,
    })),
    sourceRevalidation,
    note: 'Review copy proposals describe an observed original/replacement pair. Select and verify a target file; never perform a global replacement or infer that the screenshot itself is editable.',
  };
}

function currentClientReviewRevision(annotation) {
  const value = annotation?.clientReviewSourceRevision ?? annotation?.client_review_source_revision;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) return String(value);
  return typeof value === 'string' && /^[1-9][0-9]{0,18}$/.test(value) ? value : null;
}

function reviewChangePin(candidate, frozen) {
  const annotation = candidate.annotation;
  const currentRevision = currentClientReviewRevision(annotation);
  const localSelector = annotation?.element?.selector;
  if (typeof localSelector === 'string' && localSelector && localSelector !== frozen.selector) {
    return { pin: null, omission: 'selector_mismatch' };
  }
  if (!currentRevision) return { pin: null, omission: 'source_revision_unavailable' };
  if (currentRevision !== frozen.sourceRevision) {
    return { pin: null, omission: 'source_revision_mismatch' };
  }
  return { pin: {
    id: annotation.id,
    projectId: candidate.projectId,
    status: annotation.status,
    pincushionPinUrl: buildDeepLink(candidate.pageUrl, annotation.id),
    element: annotation.element ? {
      selector: annotation.element.selector || null,
      xpath: annotation.element.xpath || null,
      tagName: annotation.element.tagName || null,
      textContent: (annotation.element.textContent || annotation.element.text || '').slice(0, 200),
      lwcComponent: annotation.element.lwcComponent || null,
    } : { selector: frozen.selector },
    viewport: annotation.viewport || null,
    thread: (annotation.thread || []).map(serializeThreadMessage),
    comment: summarizeRichComment(annotation.thread?.[0]?.body || '', 200),
    tags: annotation.tags || [],
    frozenReviewRevision: frozen,
    currentReviewRevision: { state: 'matched', sourceRevision: currentRevision },
  }, omission: null };
}

function reviewChangeMeta({ unavailableProjectIds, omitted }) {
  return {
    availability: unavailableProjectIds.length > 0
      ? { state: 'degraded', reason: 'client_review_guidance_unavailable' }
      : { state: 'available' },
    limits: {
      maxProjects: CLIENT_REVIEW_GUIDANCE_PROJECT_LIMIT,
      maxPackets: CLIENT_REVIEW_CHANGE_PACKET_LIMIT,
      maxPins: CLIENT_REVIEW_CHANGE_PIN_LIMIT,
      maxPinsPerPacket: CLIENT_REVIEW_CHANGE_PINS_PER_PACKET,
    },
    unavailableProjectIds,
    omitted,
  };
}

async function attachClientReviewGuidance(config, packets, reviewChangeCandidates = [], reviewChangeCandidatesTruncated = false) {
  const allProjectIds = [
    ...packets.flatMap(packet => (packet.pins || []).map(pin => pin.projectId)),
    ...reviewChangeCandidates.map(candidate => candidate.projectId),
  ].filter(projectId => CLIENT_REVIEW_PROJECT.test(projectId));
  const projectIds = [...new Set(allProjectIds)].slice(0, CLIENT_REVIEW_GUIDANCE_PROJECT_LIMIT);
  const selectedProjectIds = new Set(projectIds);
  const byProject = new Map(await Promise.all(projectIds.map(async projectId => [
    projectId, await loadClientReviewGuidance(config, projectId),
  ])));
  for (const packet of packets) {
    const projectId = (packet.pins || []).map(pin => pin.projectId)
      .find(candidate => selectedProjectIds.has(candidate));
    const loaded = projectId ? byProject.get(projectId) : null;
    if (!loaded) {
      packet.clientReviewGuidance = unavailableClientReviewGuidance('client_review_guidance_unavailable');
      continue;
    }
    if (loaded.availability.state !== 'available') {
      packet.clientReviewGuidance = loaded;
      continue;
    }
    const packetGuidance = await scopedClientReviewGuidance(config, loaded, packet);
    packet.clientReviewGuidance = packetGuidance;
    for (const pin of packet.pins || []) {
      pin.clientReviewGuidance = {
        availability: packetGuidance.availability,
        state: packetGuidance.state,
        lifecycle: packetGuidance.lifecycle,
        decisionState: packetGuidance.decisionState,
        lifecycleState: packetGuidance.lifecycleState,
        artifactAvailability: packetGuidance.artifactAvailability,
        review: packetGuidance.review,
        copyProposals: packetGuidance.copyProposals.filter(proposal => proposal.annotationId === pin.id),
      };
    }
  }

  const grouped = new Map();
  const unavailableProjectIds = [];
  const omitted = {
    candidateLimit: reviewChangeCandidatesTruncated ? 1 : 0,
    projectBudget: 0, unavailable: 0, notCurrentChangeRequest: 0,
    sourceMismatch: 0, sourceRevisionMismatch: 0, sourceRevisionUnavailable: 0,
    packetLimit: 0, pinLimit: 0,
  };
  for (const candidate of reviewChangeCandidates) {
    if (!selectedProjectIds.has(candidate.projectId)) {
      omitted.projectBudget++;
      continue;
    }
    const loaded = byProject.get(candidate.projectId);
    if (!loaded || loaded.availability.state !== 'available') {
      omitted.unavailable++;
      if (CLIENT_REVIEW_PROJECT.test(candidate.projectId) && !unavailableProjectIds.includes(candidate.projectId)) {
        unavailableProjectIds.push(candidate.projectId);
      }
      continue;
    }
    // Only a current, still-artifact-available changes request can reopen
    // delivered work. Superseded, closed, expired-artifact, and accepted
    // records remain historical evidence but do not silently reactivate pins.
    if (loaded.decisionState !== 'changes_requested' || loaded.lifecycleState !== 'active' ||
      loaded.artifactAvailability !== 'available' || !loaded.review) {
      omitted.notCurrentChangeRequest++;
      continue;
    }
    const frozen = loaded.annotationRevisions.find(revision =>
      revision.annotationId === candidate.annotation.id && revision.pageUrl === candidate.pageUrl
    );
    if (!frozen) {
      omitted.sourceMismatch++;
      continue;
    }
    const pinResult = reviewChangePin(candidate, frozen);
    if (!pinResult.pin) {
      omitted.sourceMismatch++;
      if (pinResult.omission === 'source_revision_mismatch') omitted.sourceRevisionMismatch++;
      if (pinResult.omission === 'source_revision_unavailable') omitted.sourceRevisionUnavailable++;
      continue;
    }
    const pin = pinResult.pin;
    const key = `${candidate.projectId}\u0000${candidate.pageUrl}`;
    if (!grouped.has(key)) grouped.set(key, {
      kind: 'client_review_changes', projectId: candidate.projectId, pageUrl: candidate.pageUrl,
      pageTitle: candidate.pageTitle, suggestedBranch: gitBranchName(candidate.pageTitle, candidate.pageUrl),
      review: loaded.review, decisionState: loaded.decisionState, lifecycleState: loaded.lifecycleState,
      artifactAvailability: loaded.artifactAvailability, pins: [], _guidance: loaded,
    });
    const group = grouped.get(key);
    if (group.pins.length >= CLIENT_REVIEW_CHANGE_PINS_PER_PACKET) {
      omitted.pinLimit++;
      continue;
    }
    group.pins.push(pin);
  }
  const reviewChanges = [];
  let emittedPins = 0;
  for (const group of [...grouped.values()].sort((left, right) =>
    left.projectId.localeCompare(right.projectId) || left.pageUrl.localeCompare(right.pageUrl)
  )) {
    if (reviewChanges.length >= CLIENT_REVIEW_CHANGE_PACKET_LIMIT) {
      omitted.packetLimit += group.pins.length;
      continue;
    }
    const remaining = CLIENT_REVIEW_CHANGE_PIN_LIMIT - emittedPins;
    if (remaining <= 0) {
      omitted.pinLimit += group.pins.length;
      continue;
    }
    if (group.pins.length > remaining) {
      omitted.pinLimit += group.pins.length - remaining;
      group.pins = group.pins.slice(0, remaining);
    }
    const clientReviewGuidance = await scopedClientReviewGuidance(config, group._guidance, group);
    delete group._guidance;
    group.pinCount = group.pins.length;
    group.selectors = [...new Set(group.pins.map(pin => pin.element?.selector).filter(Boolean))];
    group.clientReviewGuidance = clientReviewGuidance;
    group.workflow = [
      'This is a client-review change request against an already resolved pin. Re-read the current pin, implement the requested revision, and obtain a new delivery/review decision; do not overwrite the historical accepted decision.',
      'The frozenReviewRevision is the exact version included in the review. A missing local revision is explicitly not a verified match, and a mismatched local revision is omitted fail-closed.',
    ];
    reviewChanges.push(group);
    emittedPins += group.pins.length;
  }
  return { reviewChanges, reviewChangesMeta: reviewChangeMeta({ unavailableProjectIds, omitted }) };
}

/**
 * Get all approved pins grouped by page, with suggested branch names.
 * This is the primary tool for agents starting an implementation session.
 * Returns pins in the "approved" status that haven't been claimed yet.
 *
 * @param {object} config
 * @param {object} options - { projectId }
 * @param {function|null} fetchRemote
 * @returns {object} Grouped approved pins with branch suggestions
 */
export async function toolGetApprovedPins(config, { projectId } = {}, fetchRemote = null) {
  const allData = await readAllAnnotations(config, fetchRemote);

  // Collect approved AND in-progress pins (in-progress = previously claimed but
  // agent crashed/disconnected before resolving — these still need implementation).
  const byPage = {};
  let totalApproved = 0;
  let totalInProgress = 0;
  const reviewChangeCandidates = [];
  let reviewChangeCandidatesTruncated = false;
  // Bound aggregate filesystem work as well as individual scans. Equal DOM
  // snippets share one result; excess distinct snippets stay explicitly unknown.
  const sourceSuggestionSearches = new Map();
  const maxSourceSearchesPerPacket = 8;

  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    // Resolved pins normally stay out of implementation packets. A current
    // version-bound `changes_requested` decision is the narrow exception: it
    // belongs in the separate reviewChanges stream below, never back in the
    // ready/in-progress queue. Require an explicit exact project ID here; a
    // local fallback/config project must not cross a review authority fence.
    for (const annotation of data.annotations || []) {
      if (annotation?.status !== 'resolved' || !CLIENT_REVIEW_ANNOTATION.test(annotation?.id || '') ||
        typeof annotation.projectId !== 'string' || !CLIENT_REVIEW_PROJECT.test(annotation.projectId) ||
        !matchesProject(annotation.projectId, projectId)) continue;
      if (reviewChangeCandidates.length >= CLIENT_REVIEW_CHANGE_CANDIDATE_LIMIT) {
        reviewChangeCandidatesTruncated = true;
        continue;
      }
      reviewChangeCandidates.push({
        projectId: annotation.projectId,
        pageUrl,
        pageTitle: data.pageTitle || pageUrl,
        annotation,
      });
    }
    const anns = (data.annotations || []).filter(a => {
      // Both 'ready' (modern) and 'approved' (legacy) qualify, plus
      // in-progress (previously claimed but not yet resolved).
      if (isTerminalStatus(a.status)) return false;
      if (!isReadyStatus(a.status) && a.status !== 'in-progress') return false;
      if (!matchesProject(a.projectId, projectId)) return false;
      return true;
    });

    if (anns.length === 0) continue;

    const pageTitle = data.pageTitle || pageUrl;
    const branch = gitBranchName(pageTitle, pageUrl);

    // Per-pin work-packet enrichment: surface viewport/DOM/likely-files/
    // acceptance criteria when the pin carries them, so agents pick up
    // implementation context automatically without a second tool call.
    const enrichedPins = [];
    for (const ann of anns) {
      // Keep the historical string[] field compatible with both local
      // `likelyFiles` and cloud/database `likely_files`. Stored values are
      // unverified fallback only: a completed local source search always wins,
      // even if an untrusted caller claims the same Git revision.
      const domSnippet = ann.domSnippet || ann.dom_snippet || null;
      const hasStoredLikelyFiles = Array.isArray(ann.likelyFiles) || Array.isArray(ann.likely_files);
      const rawStoredLikelyFiles = Array.isArray(ann.likelyFiles) && ann.likelyFiles.length > 0
        ? ann.likelyFiles
        : Array.isArray(ann.likely_files)
          ? ann.likely_files
          : Array.isArray(ann.likelyFiles)
            ? ann.likelyFiles
            : [];
      const storedLikelyFiles = filterLikelyFilePaths(rawStoredLikelyFiles);
      const storedProvenance = ann.likelyFilesProvenance || ann.likely_files_provenance || null;
      const storedRevision = storedProvenance?.repository?.revision
        || storedProvenance?.repoRevision
        || storedProvenance?.revision
        || null;

      let likelyFiles = storedLikelyFiles;
      let likelyFileSuggestions = storedLikelyFiles.map(path => ({
        path,
        confidence: 'low',
        confidenceScope: 'legacy_stored_path',
        matchedBy: ['stored'],
        hints: [],
        contentFingerprint: null,
      }));
      let likelyFilesProvenance = {
        schemaVersion: 1,
        repository: {
          state: config.projectDir ? 'not_checked' : 'unavailable',
          revision: null,
          headRevision: null,
          contentSource: 'not_checked',
          workingTree: null,
        },
        search: { mode: 'not_run', status: domSnippet ? 'unavailable' : 'not_run' },
        implementation: {
          verified: false,
          reason: 'Stored paths are compatibility fallback only, not implementation evidence.',
        },
        cache: { state: hasStoredLikelyFiles ? 'unverified' : 'absent', stale: hasStoredLikelyFiles },
        uncertainty: {
          level: 'high',
          reasons: [config.projectDir
            ? 'No DOM snippet was available for a verified local source search.'
            : 'No local project directory was configured, so source suggestions were not verified.'],
        },
      };

      const sourceBudgetExhausted = sourceSuggestionSearches.size >= maxSourceSearchesPerPacket
        && !sourceSuggestionSearches.has(domSnippet);
      if (config.projectDir && domSnippet && sourceBudgetExhausted) {
        likelyFilesProvenance.search = { mode: 'not_run', status: 'request_budget_exhausted' };
        likelyFilesProvenance.uncertainty = {
          level: 'high',
          reasons: ['The packet source-search budget was exhausted; stored paths remain unverified. Inspect this pin locally before implementation.'],
        };
      } else if (config.projectDir && domSnippet) {
        const searchKey = domSnippet;
        let sourceSearch = sourceSuggestionSearches.get(searchKey);
        if (!sourceSearch) {
          sourceSearch = inferLikelyFileSuggestions(config.projectDir, domSnippet);
          sourceSuggestionSearches.set(searchKey, sourceSearch);
        }
        try {
          const inferred = await sourceSearch;
          const searchCompleted = inferred.provenance?.search?.status === 'completed';
          const baseUncertainty = inferred.provenance?.uncertainty || { level: 'high', reasons: [] };

          if (searchCompleted) {
            // This includes a legacy [] and a same-OID forged value: source
            // bytes read in this request are the only current suggestion set.
            likelyFiles = inferred.likelyFiles;
            likelyFileSuggestions = inferred.suggestions;
            likelyFilesProvenance = {
              ...inferred.provenance,
              cache: {
                state: hasStoredLikelyFiles ? 'refreshed' : 'computed',
                stale: false,
                replacedStored: hasStoredLikelyFiles,
                previousRevision: storedRevision,
              },
            };
          } else {
            likelyFilesProvenance = {
              ...inferred.provenance,
              cache: {
                state: hasStoredLikelyFiles ? 'unverified_fallback' : 'unavailable',
                stale: hasStoredLikelyFiles,
                previousRevision: storedRevision,
              },
              uncertainty: {
                ...baseUncertainty,
                reasons: [...new Set([
                  ...(baseUncertainty.reasons || []),
                  'No completed local source search was available; legacy paths remain unverified fallback only.',
                ])],
              },
            };
          }
        } catch {
          likelyFilesProvenance = {
            ...likelyFilesProvenance,
            cache: { state: hasStoredLikelyFiles ? 'unverified_fallback' : 'unavailable', stale: hasStoredLikelyFiles },
            uncertainty: {
              level: 'high',
              reasons: ['The bounded local source search was unavailable; stored suggestions were not verified.'],
            },
          };
        }
      }

      enrichedPins.push({
        id: ann.id,
        projectId: ann.projectId || config.projectId || null,
        status: ann.status,
        approvedAt: ann.approvedAt,
        approvedBy: ann.approvedBy,
        author: ann.author || ann.createdBy || 'Unknown',
        // Deep link back to the page with the pin auto-focused — used for the
        // optional `Pincushion-Pin-Url:` trailer when `commitTrailers='full'`.
        // Cheap to include unconditionally; agent decides whether to use it.
        pincushionPinUrl: buildDeepLink(pageUrl, ann.id),
        element: ann.element ? {
          selector: ann.element.selector || null,
          xpath: ann.element.xpath || null,
          tagName: ann.element.tagName || null,
          textContent: (ann.element.textContent || ann.element.text || '').slice(0, 200),
          lwcComponent: ann.element.lwcComponent || null,
        } : null,
        // A3: agent work-packet fields. Null/empty values dropped at the
        // serializer layer by callers that want a tight payload.
        viewport: ann.viewport || null,
        // Derived breakpoint hint (e.g. "mobile (~375px)") + a verification
        // nudge so the implementing agent checks the fix at the width the
        // stakeholder actually reported it at. Only added when the pin
        // carries a viewport and the stakeholder didn't author their own
        // acceptance criteria.
        breakpoint: describeViewport(ann.viewport)?.breakpoint || null,
        domSnippet,
        // `likelyFiles` remains the legacy string[] contract (including for
        // `likely_files` cloud records); the structured fields make freshness
        // and uncertainty visible without breaking existing agent clients.
        likelyFiles: likelyFiles || [],
        likelyFileSuggestions,
        likelyFilesProvenance,
        acceptanceCriteria: ann.acceptanceCriteria
          || (describeViewport(ann.viewport)
            ? `Verify the fix at ${describeViewport(ann.viewport).breakpoint} — this pin was captured at that screen size.`
            : null),
        thread: (ann.thread || []).map(serializeThreadMessage),
        comment: summarizeRichComment(ann.thread?.[0]?.body || '', 200),
        tags: ann.tags || [],
      });
    }

    byPage[entryKey] = {
      pageUrl,
      pageTitle,
      suggestedBranch: branch,
      pins: enrichedPins,
    };

    for (const ann of anns) {
      if (isReadyStatus(ann.status)) totalApproved++;
      else if (ann.status === 'in-progress') totalInProgress++;
    }
  }

  const totalActionable = totalApproved + totalInProgress;
  const pageCount = Object.keys(byPage).length;

  const parts = [];
  if (totalApproved > 0) parts.push(`${totalApproved} approved`);
  if (totalInProgress > 0) parts.push(`${totalInProgress} in-progress (previously claimed, not yet resolved)`);

  // Collect per-project traceability config so the agent can read the
  // commit-trailer preset, attribution-comment policy, and SHA-recording flag
  // without a second round-trip. Keyed by projectId; pins without a projectId
  // fall through to the hardcoded defaults at usage time.
  const projectIds = new Set();
  for (const data of Object.values(allData)) {
    for (const ann of data.annotations || []) {
      if (!isTerminalStatus(ann.status) && (isReadyStatus(ann.status) || ann.status === 'in-progress') && ann.projectId) {
        projectIds.add(ann.projectId);
      }
    }
  }
  const traceability = {};
  for (const pid of projectIds) {
    const proj = await readProjectConfig(config, pid);
    traceability[pid] = {
      commitTrailers: proj?.commitTrailers || 'minimal',
      attributionComments: proj?.attributionComments || 'off',
      recordCommitSha: proj?.recordCommitSha !== false,
    };
  }

  // Implementation packets: each page-level group is one work item the agent
  // should fix in a single branch/PR. `packets` is the canonical name —
  // `pages` is kept as an alias for backward compatibility with older agent
  // prompts that read result.pages directly.
  const packets = Object.values(byPage).map(page => ({
    ...page,
    // Aggregate selectors across all pins on this page so the agent can grep
    // the source tree once per packet rather than per pin.
    selectors: Array.from(new Set(
      (page.pins || [])
        .map(p => p.element?.selector)
        .filter(Boolean)
    )),
    pinCount: (page.pins || []).length,
  }));

  // This is an additive packet enrichment. A missing pilot, remote review
  // adapter, credential, or malformed response is explicit on each packet and
  // never prevents legacy approved-pin work from being returned. Resolved
  // post-delivery change requests are emitted separately and cannot silently
  // re-enter the ordinary ready/in-progress flow.
  const { reviewChanges, reviewChangesMeta } = await attachClientReviewGuidance(
    config, packets, reviewChangeCandidates, reviewChangeCandidatesTruncated,
  );

  const message = totalActionable > 0
    ? `${totalActionable} pin(s) across ${pageCount} page(s) ready for implementation: ${parts.join(', ')}.`
    : reviewChanges.length > 0
      ? `${reviewChanges.reduce((count, packet) => count + packet.pinCount, 0)} resolved pin(s) have current client-review change requests in reviewChanges.`
      : 'No approved pins waiting for implementation. Pins must be approved before they can be implemented.';

  return {
    totalApproved,
    totalInProgress,
    totalActionable,
    pageCount,
    packetCount: packets.length,
    packets,
    pages: packets, // backward-compat alias
    reviewChanges,
    reviewChangesMeta,
    traceability,
    workflow: [
      '1. Use the element.selector and element.xpath to find the component in source code (grep for the selector, tag name, or text content)',
      '2. Read the full thread to understand the stakeholder request, then implement the change',
      '3. Call claim_pin(annotationId) to mark it in-progress before starting (skip if already in-progress)',
      '4. After implementing, call fix_and_resolve(annotationId, fixDescription, commitSha?) to close the pin (pass commitSha after committing for the dashboard backlink)',
      '5. Commit body must include Pin-ID: <id>. If traceability[pin.projectId].commitTrailers is "standard", also add Reviewed-By: <pin.approvedBy> on a new line — but ONLY if approvedBy differs from the git committer email (skip self-approval). If "full", also add Pincushion-Pin-Url: <pin.pincushionPinUrl>. If "minimal" (default), Pin-ID alone.',
      '6. Inline comments: only when traceability[pin.projectId].attributionComments is "context-warrants" AND the pin captures a non-obvious WHY (a constraint, intent, or rationale not self-evident from the diff). Format: // Pincushion <pinId>: <one-line WHY>. Skip for cosmetic fixes (typos, color tweaks, copy edits).',
      'NOTE: Implement on the current branch. Do NOT create branches unless the dev asks. If a git command fails with "Unable to create ... .lock", another git process is in flight — wait, retry, or surface the conflict to the user. Do NOT delete files under .git/.',
    ],
    message,
  };
}

// Return a single implementation packet for one page. Useful when an agent
// wants to batch-fix one page at a time rather than fetching everything.
// Matches pageUrl by exact value or partial substring (case-insensitive).
export async function toolGetImplementationPacket(config, { pageUrl, projectId } = {}, fetchRemote = null) {
  if (!pageUrl) return { error: 'pageUrl is required' };

  const all = await toolGetApprovedPins(config, { projectId }, fetchRemote);
  const implementationPackets = Array.isArray(all.packets) ? all.packets : [];
  const reviewChangePackets = Array.isArray(all.reviewChanges) ? all.reviewChanges : [];
  const availablePackets = [...implementationPackets, ...reviewChangePackets];
  if (availablePackets.length === 0) {
    return {
      pageUrl,
      pinCount: 0,
      pins: [],
      reviewChangesMeta: all.reviewChangesMeta,
      message: 'No approved pins or current client-review change requests on any page yet.',
    };
  }

  const needle = pageUrl.toLowerCase();
  const match = availablePackets.find(p =>
    (p.pageUrl || '').toLowerCase() === needle ||
    (p.pageUrl || '').toLowerCase().includes(needle)
  );

  if (!match) {
    return {
      pageUrl,
      pinCount: 0,
      pins: [],
      availablePages: availablePackets.map(p => p.pageUrl),
      reviewChangesMeta: all.reviewChangesMeta,
      message: `No approved pins or current client-review change requests found for page matching "${pageUrl}". Available pages: ${availablePackets.map(p => p.pageUrl).join(', ')}.`,
    };
  }

  return {
    ...match,
    traceability: all.traceability,
    reviewChangesMeta: all.reviewChangesMeta,
    message: match.kind === 'client_review_changes'
      ? `${match.pinCount} resolved pin(s) have a current client-review change request on "${match.pageTitle || match.pageUrl}". Re-implement and obtain a new review decision.`
      : `${match.pinCount} pin(s) ready on "${match.pageTitle || match.pageUrl}". Implement them in one branch.`,
  };
}

// Assign a pin directly to the local coding agent. Sets pin to ready and
// drops a trigger file in .feedback/.agent-queue/ that agent-loop.mjs picks
// up and dispatches to Cursor/Claude Code/Codex. This is the first-class
// "assign to agent" action — turns a pin into agent work in one call.
export async function toolAssignPinToAgent(config, { annotationId, assignedBy } = {}, fetchRemote = null) {
  if (!annotationId) return { error: 'annotationId is required' };

  const allData = await readAllAnnotations(config, fetchRemote);

  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;

    if (isTerminalStatus(ann.status)) return rejectedTerminalMutation(annotationId, ann.status);

    const candidatePage = clonePageData(data);
    const candidate = candidatePage.annotations.find(a => a.id === annotationId);

    const now = new Date().toISOString();

    // Promote to ready if not already approved
    if (!isReadyStatus(candidate.status) && candidate.status !== 'in-progress') {
      candidate.status = 'ready';
      candidate.approvedAt = candidate.approvedAt || now;
      candidate.approvedBy = candidate.approvedBy || assignedBy || 'Agent assignment';
    }

    // Mark as queued for the agent. agent-loop will set action='implementing'
    // when it actually claims the pin via claim_pin.
    candidate.action = 'pending_implementation';
    candidate.assignedAt = now;
    candidate.assignedBy = assignedBy || 'Unknown';
    candidate.updatedAt = now;

    candidate.thread = candidate.thread || [];
    candidate.thread.push({
      id: `msg_${Date.now().toString(36)}`,
      author: assignedBy || 'Pincushion',
      authorEmail: '',
      timestamp: now,
      body: `Assigned to coding agent`,
      type: 'assignment'
    });

    const persisted = await persistLifecycleCandidate(config, data, candidatePage, candidate, pageUrl);
    if (!persisted.ok) return persisted.result;
    const accepted = persisted.annotation;

    // Write the queue trigger file for agent-loop.mjs to pick up.
    // Format matches what agent-loop's buildPrompt expects: id, pageUrl,
    // element, thread, and any work-packet fields the pin carries.
    if (config.agentQueueDir) {
      try {
        if (!existsSync(config.agentQueueDir)) {
          mkdirSync(config.agentQueueDir, { recursive: true });
        }
        const queuePath = agentQueueFilePath(config.agentQueueDir, annotationId);
        if (!queuePath) throw new Error('unsafe_agent_queue_id');
        const queuePayload = {
          id: accepted.id,
          pageUrl,
          pageTitle: persisted.page.pageTitle || pageUrl,
          element: accepted.element || null,
          thread: accepted.thread || [],
          projectId: accepted.projectId || null,
          assignedAt: now,
          assignedBy: accepted.assignedBy,
          // Work-packet fields (A3) — agents that understand them get richer
          // context; older agents ignore them.
          viewport: accepted.viewport || null,
          domSnippet: accepted.domSnippet || null,
          likelyFiles: accepted.likelyFiles || null,
          acceptanceCriteria: accepted.acceptanceCriteria || null,
        };
        await writeFile(queuePath, JSON.stringify(queuePayload, null, 2), 'utf-8');
      } catch (err) {
        // Queue write is best-effort — pin is still assigned even if the
        // file write fails (e.g. permissions issue on a shared mount).
        return {
          success: true,
          annotationId,
          assignedAt: now,
          warning: 'Pin assigned but the local agent queue could not be written; agent-loop may not pick it up automatically.',
          warningCode: 'agent_queue_write_failed',
          message: `Pin "${annotationId}" assigned to agent (queue file write failed).`
        };
      }
    }

    const result = {
      success: true,
      annotationId,
      assignedAt: now,
      assignedBy: accepted.assignedBy,
      pageUrl,
      pageTitle: persisted.page.pageTitle || pageUrl,
      message: `Pin "${annotationId}" assigned to coding agent on "${persisted.page.pageTitle || pageUrl}". agent-loop will dispatch it within a few seconds.`,
    };
    return result;
  }

  return { success: false, error: `Pin "${annotationId}" not found` };
}

export async function toolAddAgentReply(config, { annotationId, body, author }, fetchRemote = null) {
  if (!annotationId || !body) return { error: 'annotationId and body are required' };

  const allData = await readAllAnnotations(config, fetchRemote);

  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    const sourceAnn = (data.annotations || []).find(a => a.id === annotationId);
    if (!sourceAnn) continue;

    if (isTerminalStatus(sourceAnn.status)) return rejectedTerminalMutation(annotationId, sourceAnn.status);

    // Existing-pin writes are remote-first: prepare a detached candidate and
    // do not touch the local cache until sync-annotations returns the exact
    // canonical row. This closes the owner-dismissal race for thread replies.
    const candidatePage = clonePageData(data);
    const candidate = (candidatePage.annotations || []).find(a => a.id === annotationId);
    if (!candidate) continue;
    candidate.thread = Array.isArray(candidate.thread) ? candidate.thread : [];
    candidate.thread.push({
      id: `msg_${Date.now().toString(36)}`,
      author: author || 'AI Agent',
      authorEmail: '',
      timestamp: new Date().toISOString(),
      body
    });
    candidate.updatedAt = new Date().toISOString();

    const persisted = await persistLifecycleCandidate(config, data, candidatePage, candidate, pageUrl);
    if (!persisted.ok) return persisted.result;

    return {
      success: true,
      annotationId,
      message: `Added reply to annotation "${annotationId}"`
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

// ─── Pincushion AI: pending-work summary ────────────────────────────────────
// Single source of truth for "what bot work is owed?". Surfaced in three
// places (every sync response, /pins output, first-tool-of-session banner)
// so the queue-and-poll model never feels like a fax machine — pending bot
// items become impossible to miss without spamming.
//
// Both flows are queue-and-poll (LLM never runs server-side), so this
// helper just counts the candidates.

export async function getPendingWorkSummary(config, fetchRemote = null) {
  let pendingCritiques = 0;
  let pendingReplies = 0;
  // Network call — silently degrade on error so a queue outage doesn't
  // break unrelated MCP tools.
  try {
    const r = await toolGetPendingCritiques(config, {});
    if (r && r.success) pendingCritiques = r.count || 0;
  } catch { /* ignore */ }
  // Local read — pulls from .feedback files. Cheap.
  try {
    const r = await toolGetReplyCandidates(config, {}, fetchRemote);
    pendingReplies = (r && r.count) || 0;
  } catch { /* ignore */ }
  return {
    pendingCritiques,
    pendingReplies,
    hasWork: pendingCritiques > 0 || pendingReplies > 0,
  };
}

// ─── Pincushion AI: critique queue (deploy-hook integration) ───────────────
// The critique_queue table is written by the deploy-hook edge function on
// every Pro/Team deploy and consumed here by the dev's IDE. These wrappers
// call the dedicated `critique-queue` edge function — license-scoped, no
// LLM compute on Pincushion's side.

async function _critiqueQueueFetch(config, pathSuffix, init = {}) {
  const supabaseBase = config.supabaseBase || 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1';
  const licenseKey = config.licenseKey;
  if (!licenseKey) {
    return { ok: false, status: 401, body: { error: 'license_required', message: 'Set licenseKey in config to use the critique queue.' } };
  }
  try {
    const res = await fetch(`${supabaseBase}/critique-queue${pathSuffix}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        'Content-Type': 'application/json',
        'x-license-key': licenseKey,
      },
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      body: safeErrorResponse(err, {
        code: 'network_error',
        message: 'The critique queue could not be reached.',
        // GETs can be retried safely. POST completion requests must be
        // reconciled by request id because the provider may have committed
        // before the transport failed.
        retryable: String(init.method || 'GET').toUpperCase() === 'GET',
      }),
    };
  }
}

function normalizeCaptureReceipt(receipt = {}) {
  if (!receipt || typeof receipt !== 'object') return null;
  const versionId = receipt.version_id || receipt.versionId || null;
  const capturedAt = receipt.captured_at || receipt.capturedAt || null;
  const contentHash = receipt.content_hash || receipt.contentHash || null;
  const captureFingerprint = normalizeCaptureFingerprint(receipt);
  if (!versionId && !capturedAt && !contentHash && !captureFingerprint) return null;
  return { versionId, capturedAt, contentHash, captureFingerprint };
}

function normalizeLatestCaptureReceipts(receipts = {}) {
  if (!receipts || typeof receipts !== 'object' || Array.isArray(receipts)) return {};
  const normalized = {};
  for (const [pageUrl, deviceReceipts] of Object.entries(receipts)) {
    const canonicalUrl = normalizeInventoryUrl(pageUrl) || pageUrl;
    if (!deviceReceipts || typeof deviceReceipts !== 'object' || Array.isArray(deviceReceipts)) continue;
    const devices = {};
    for (const [deviceClass, receipt] of Object.entries(deviceReceipts)) {
      const normalizedReceipt = normalizeCaptureReceipt(receipt);
      if (normalizedReceipt) devices[deviceClass] = normalizedReceipt;
    }
    if (Object.keys(devices).length) normalized[canonicalUrl] = devices;
  }
  return normalized;
}

const PREVIOUS_CAPTURE_RECEIPT_HASH = /^[0-9a-f]{64}$/;
const PREVIOUS_CAPTURE_RECEIPT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})$/;
const MAX_PRIVATE_PREVIOUS_CAPTURE_PAGES = MAX_DISCOVERED_DEPLOYMENT_PAGES;

function exactCaptureRunPageScope(value) {
  if (!Array.isArray(value) || value.length > MAX_PRIVATE_PREVIOUS_CAPTURE_PAGES) return null;
  const scope = [];
  const seen = new Set();
  for (const pageUrl of value) {
    if (typeof pageUrl !== 'string' || pageUrl.length > 2000 || pageUrl !== pageUrl.trim()) return null;
    // Do not canonicalize this key: the frozen server scope is the authority.
    // Validation merely rejects malformed aliases so a baseline cannot migrate
    // to a different page URL while crossing the private MCP boundary.
    if (normalizeInventoryUrl(pageUrl) !== pageUrl || seen.has(pageUrl)) return null;
    seen.add(pageUrl);
    scope.push(pageUrl);
  }
  return scope;
}

function normalizePreviousCaptureReceipt(receipt) {
  if (!isPlainObject(receipt)) return null;
  const versionId = receipt.versionId;
  const rawContentHash = receipt.contentHash;
  const rawCapturedAt = receipt.capturedAt;
  if (typeof versionId !== 'string' || !UUID_V4ISH.test(versionId)
    || typeof rawContentHash !== 'string' || !PREVIOUS_CAPTURE_RECEIPT_HASH.test(rawContentHash.toLowerCase())
    || typeof rawCapturedAt !== 'string' || !PREVIOUS_CAPTURE_RECEIPT_TIMESTAMP.test(rawCapturedAt)) {
    return null;
  }
  const capturedAtMs = Date.parse(rawCapturedAt);
  if (Number.isNaN(capturedAtMs)) return null;
  const captureFingerprint = normalizeCaptureFingerprint({ captureFingerprint: receipt.captureFingerprint });
  if (!captureFingerprint) return null;
  return {
    versionId,
    contentHash: rawContentHash.toLowerCase(),
    captureFingerprint,
    capturedAt: new Date(capturedAtMs).toISOString(),
  };
}

// A run baseline is intentionally a private, frozen, exact-key projection.
// It is not a general receipt parser: missing, extra, partial, or malformed
// data fails closed per accepted page rather than being repaired or inferred.
function normalizePreviousCaptureReceipts(receipts, acceptedPageUrls) {
  const scope = exactCaptureRunPageScope(acceptedPageUrls);
  if (!scope) return {};
  const source = isPlainObject(receipts) ? receipts : {};
  return Object.fromEntries(scope.map((pageUrl) => {
    const pair = isPlainObject(source[pageUrl]) ? source[pageUrl] : null;
    const desktop = normalizePreviousCaptureReceipt(pair?.desktop);
    const mobile = normalizePreviousCaptureReceipt(pair?.mobile);
    return [pageUrl, desktop && mobile ? { desktop, mobile } : {}];
  }));
}

function normalizeDeploymentMetadata(deployment = null) {
  if (!deployment || typeof deployment !== 'object') return null;
  const id = deployment.id || deployment.deployment_id || deployment.deploymentId || null;
  if (!id) return null;
  return {
    id,
    provider: deployment.provider || null,
    environment: deployment.environment || null,
    deployUrl: deployment.deploy_url || deployment.deployUrl || null,
    deployHash: deployment.deploy_hash || deployment.deployHash || null,
    deployedAt: deployment.deployed_at || deployment.deployedAt || null,
    status: deployment.status || null,
    frameRefreshState: deployment.frame_refresh_state || deployment.frameRefreshState || null,
    cleanupState: deployment.cleanup_state || deployment.cleanupState || null,
  };
}

function normalizeReceiptArray(value, singularValue = null) {
  const raw = Array.isArray(value)
    ? value
    : value !== undefined && value !== null
    ? [value]
    : singularValue !== undefined && singularValue !== null
    ? [singularValue]
    : [];
  // These arrays are ordered desktop/mobile pairs. Do not independently
  // deduplicate, sort, lower-case, or truncate them: that would break the
  // immutable version-to-hash correspondence returned by the edge receipt.
  return raw.map((item) => typeof item === 'string' ? item.trim() : '').filter(Boolean);
}

function normalizeCleanupReceipt(receipt = null) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) return null;
  const state = receipt.state || receipt.cleanup_state || receipt.cleanupState || null;
  const result = { state };
  for (const key of ['completed', 'failed', 'claimed', 'retryable']) {
    if (Object.prototype.hasOwnProperty.call(receipt, key)) result[key] = receipt[key];
  }
  return result;
}

function normalizePageResult(result = {}) {
  if (!result || typeof result !== 'object') return null;
  const pageUrl = result.page_url || result.pageUrl || null;
  if (!pageUrl) return null;
  const rawReceipts = result.capture_receipts || result.captureReceipts || {};
  const captureReceipts = Array.isArray(rawReceipts)
    ? rawReceipts.map(normalizeCaptureReceipt).filter(Boolean)
    : normalizeLatestCaptureReceipts({ [pageUrl]: rawReceipts })[normalizeInventoryUrl(pageUrl) || pageUrl] || {};
  return {
    pageUrl,
    status: result.status || null,
    changeKind: result.change_kind || result.changeKind || null,
    beforeVersionId: result.before_version_id || result.beforeVersionId || null,
    beforeContentHash: result.before_content_hash || result.beforeContentHash || null,
    afterVersionId: result.after_version_id || result.afterVersionId || null,
    afterContentHash: result.after_content_hash || result.afterContentHash || null,
    afterVersionIds: normalizeReceiptArray(
      result.after_version_ids ?? result.afterVersionIds,
      result.after_version_id || result.afterVersionId || null,
    ),
    afterContentHashes: normalizeReceiptArray(
      result.after_content_hashes ?? result.afterContentHashes,
      result.after_content_hash || result.afterContentHash || null,
    ),
    captureReceipts,
  };
}

function reconciliationQueuePath(config, action) {
  const override = config?.deploymentReconciliationPaths?.[action];
  if (typeof override === 'string' && override.startsWith('/')) return override;
  return DEPLOYMENT_RECONCILIATION_CONTRACT.queuePaths[action];
}

function normalizeAcceptedDiscoveryRows(body = {}) {
  // `page_results` is the canonical edge-function response field. Keep the
  // early aliases so a client can interoperate during a rolling deployment,
  // but never infer accepted rows from the original local URL list.
  const rawRows = body?.accepted || body?.accepted_pages || body?.acceptedPages || body?.page_results || body?.pageResults || body?.pages || [];
  const rows = Array.isArray(rawRows) ? rawRows : [];
  return rows.map((row) => {
    const raw = typeof row === 'string' ? { page_url: row } : row;
    const pageUrl = normalizeInventoryUrl(raw?.page_url || raw?.pageUrl || raw?.url);
    if (!pageUrl) return null;
    return {
      pageUrl,
      // The edge function returns accepted pending rows. Treat an omitted
      // state as pending for backwards-compatible early deployments, but do
      // not transform an explicit non-pending state into work to stage.
      status: raw?.status || 'pending',
      changeKind: raw?.change_kind || raw?.changeKind || null,
    };
  }).filter(Boolean);
}

export async function toolGetPendingCritiques(config, { projectId } = {}) {
  const qs = projectId
    ? `?status=pending&project_id=${encodeURIComponent(projectId)}`
    : '?status=pending';
  const r = await _critiqueQueueFetch(config, qs, { method: 'GET' });
  if (!r.ok) {
    return { success: false, ...safeProviderError(r.body, r.status, { fallback: 'queue_fetch_failed', retryable: true }) };
  }
  const requests = (r.body?.requests || []).map(req => {
    const deployment = normalizeDeploymentMetadata(req.deployment || {
      id: req.deployment_id || req.deploymentId,
      provider: req.deployment_provider,
      environment: req.deployment_environment,
      deploy_url: req.deploy_url,
      deploy_hash: req.deploy_hash,
      deployed_at: req.deployed_at,
      status: req.deployment_status,
      cleanup_state: req.cleanup_state || req.cleanupState,
    });
    return {
      id: req.id,
      projectId: req.project_id,
      pageUrls: req.page_urls || [],
      deployHash: req.deploy_hash || deployment?.deployHash || null,
      deploymentId: deployment?.id || null,
      deployment,
      resolvedPinIds: req.resolved_pin_ids || [],
      requestedAt: req.requested_at,
      pinCount: req.pin_count,
      pageResults: (req.page_results || req.pageResults || []).map(normalizePageResult).filter(Boolean),
      projectPageInventory: req.project_pages || req.projectPageInventory || [],
      latestCaptureReceipts: normalizeLatestCaptureReceipts(req.latest_capture_receipts || req.latestCaptureReceipts || {}),
      // { pageUrl: ISO|null } latest full-page snapshot per page — legacy
      // snapshot-latest-deploy callers retain their idempotency behavior when
      // talking to an older edge deployment.
      latestSnapshotAt: req.latest_snapshot_at || {},
    };
  });
  return { success: true, count: requests.length, pending: requests };
}

// Frame refresh work is intentionally discoverable independently of the
// legacy Critique queue. The redacted endpoint returns only deployment ID,
// page scope, and state; it never returns a proof or deployment storage data.
export async function toolGetPendingDeploymentFrameRefreshes(config, { projectId } = {}) {
  const qs = projectId
    ? `?status=pending&project_id=${encodeURIComponent(projectId)}`
    : '?status=pending';
  const r = await _critiqueQueueFetch(config, reconciliationQueuePath(config, 'listFrameRefreshes') + qs, { method: 'GET' });
  if (!r.ok) {
    return { success: false, ...safeProviderError(r.body, r.status, { fallback: 'frame_refresh_fetch_failed', retryable: true }) };
  }
  const pending = (Array.isArray(r.body?.frame_refreshes) ? r.body.frame_refreshes : []).map((row) => {
    const deployment = normalizeDeploymentMetadata(row?.deployment || { id: row?.deployment_id || row?.deploymentId });
    return {
      deploymentId: deployment?.id || null,
      deployment,
      projectId: row?.project_id || row?.projectId || null,
      pageUrls: Array.isArray(row?.page_urls || row?.pageUrls) ? (row.page_urls || row.pageUrls) : [],
      executorMode: row?.executor_mode || row?.executorMode || null,
      frameRefresh: {
        state: row?.frame_refresh?.state || row?.frameRefresh?.state || deployment?.frameRefreshState || null,
      },
    };
  }).filter((row) => row.deploymentId);
  return { success: true, count: pending.length, pending };
}

// The proof returned here is intentionally short-lived and opaque. Callers
// must keep it in process/memory and pass it only to upload/page-result calls.
export async function toolStartDeploymentCaptureRun(config, { deploymentId, includePreviousCaptureReceipts } = {}) {
  const normalizedDeploymentId = String(deploymentId || '').trim();
  if (!normalizedDeploymentId) return { success: false, error: 'deploymentId is required' };
  const includePrevious = includePreviousCaptureReceipts === true;
  const r = await _critiqueQueueFetch(config, reconciliationQueuePath(config, 'startCaptureRun'), {
    method: 'POST',
    body: JSON.stringify({
      deployment_id: normalizedDeploymentId,
      ...(includePrevious ? { include_previous_capture_receipts: true } : {}),
    }),
  });
  if (!r.ok) {
    return { success: false, ...safeProviderError(r.body, r.status, { fallback: 'capture_run_start_failed' }) };
  }
  const captureRun = r.body?.capture_run && typeof r.body.capture_run === 'object'
    ? {
      id: r.body.capture_run.id || null,
      deploymentId: r.body.capture_run.deployment_id || r.body.capture_run.deploymentId || normalizedDeploymentId,
      state: r.body.capture_run.state || null,
      expiresAt: r.body.capture_run.expires_at || r.body.capture_run.expiresAt || null,
      executorMode: r.body.capture_run.executor_mode || r.body.capture_run.executorMode || null,
      pageUrls: Array.isArray(r.body.capture_run.page_urls || r.body.capture_run.pageUrls)
        ? (r.body.capture_run.page_urls || r.body.capture_run.pageUrls) : [],
    }
    : null;
  const captureProof = typeof r.body?.capture_proof === 'string' ? r.body.capture_proof : null;
  if (!captureRun?.id || !captureProof) return { success: false, error: 'capture_run_start_invalid_response' };
  return {
    success: true,
    captureRun,
    captureProof,
    ...(includePrevious ? {
      previousCaptureReceipts: normalizePreviousCaptureReceipts(
        r.body?.previous_capture_receipts,
        captureRun.pageUrls,
      ),
    } : {}),
  };
}

export async function toolCompleteDeploymentCaptureRun(config, { deploymentId, captureRunId, captureProof } = {}) {
  const normalizedDeploymentId = String(deploymentId || '').trim();
  const normalizedRunId = String(captureRunId || '').trim();
  const normalizedProof = String(captureProof || '').trim();
  if (!normalizedDeploymentId || !normalizedRunId || normalizedProof.length < 32) {
    return { success: false, error: 'deploymentId, captureRunId, and captureProof are required' };
  }
  const r = await _critiqueQueueFetch(config, reconciliationQueuePath(config, 'completeCaptureRun'), {
    method: 'POST',
    body: JSON.stringify({ deployment_id: normalizedDeploymentId, capture_run_id: normalizedRunId, capture_proof: normalizedProof }),
  });
  if (!r.ok) return { success: false, ...safeProviderError(r.body, r.status, { fallback: 'capture_run_complete_failed' }) };
  return { success: true, deployment: normalizeDeploymentMetadata(r.body?.deployment) };
}

// Register exactly the bounded URL inventory discovered in the current browser
// context before any capture is staged. The backend owns duplicate/race policy
// and returns the accepted pending rows; callers must use that returned subset
// rather than assuming every local discovery is eligible.
export async function toolRegisterDeploymentDiscoveredPages(config, {
  deploymentId,
  pageUrls,
} = {}) {
  const normalizedDeploymentId = String(deploymentId || '').trim();
  if (!normalizedDeploymentId) return { success: false, error: 'deploymentId is required' };
  if (!Array.isArray(pageUrls) || !pageUrls.length) return { success: false, error: 'pageUrls must contain at least one discovered http(s) URL' };
  if (pageUrls.length > MAX_DISCOVERED_DEPLOYMENT_PAGES) {
    return { success: false, error: `pageUrls is bounded to ${MAX_DISCOVERED_DEPLOYMENT_PAGES} entries per reconciliation` };
  }
  const normalizedPageUrls = normalizeDiscoveredPageUrls(pageUrls);
  if (!normalizedPageUrls.length) return { success: false, error: 'pageUrls must contain at least one valid discovered http(s) URL' };
  const r = await _critiqueQueueFetch(config, reconciliationQueuePath(config, 'discoverPages'), {
    method: 'POST',
    body: JSON.stringify({ deployment_id: normalizedDeploymentId, page_urls: normalizedPageUrls }),
  });
  if (!r.ok) {
    return { success: false, ...safeProviderError(r.body, r.status, { fallback: 'deployment_discovery_registration_failed' }) };
  }
  const acceptedPages = normalizeAcceptedDiscoveryRows(r.body);
  const acceptedPendingPages = acceptedPages.filter((page) => page.status === 'pending');
  return {
    success: true,
    deployment: normalizeDeploymentMetadata(r.body?.deployment),
    acceptedPages,
    acceptedPendingPages,
    acceptedPageUrls: acceptedPendingPages.map((page) => page.pageUrl),
  };
}

export async function toolCompleteCritiqueRequest(config, { id, pinCount } = {}) {
  if (!id) return { success: false, error: 'id is required' };
  const r = await _critiqueQueueFetch(config, '/complete', {
    method: 'POST',
    body: JSON.stringify({ id, pin_count: pinCount }),
  });
  if (!r.ok) {
    return { success: false, ...safeProviderError(r.body, r.status, { fallback: 'complete_failed' }) };
  }
  return {
    success: true,
    id: r.body?.request?.id,
    completedAt: r.body?.request?.completed_at,
    pinCount: r.body?.request?.pin_count,
  };
}

// Record one terminal deployment-page outcome. The backend auto-finalizes the
// deployment atomically only once every page has a terminal result; do not add
// a client-side "finalize" call, because it would race the backend receipt.
export async function toolRecordDeploymentPageResult(config, {
  deploymentId,
  pageUrl,
  status,
  outcome,
  versionIds,
  contentHashes,
  error,
  captureRunId,
  captureProof,
} = {}) {
  const normalizedDeploymentId = String(deploymentId || '').trim();
  const normalizedPageUrl = normalizeInventoryUrl(pageUrl);
  const normalizedOutcome = String(outcome || '').trim();
  const normalizedStatus = String(status || DEPLOYMENT_OUTCOME_STATUS_MAP[normalizedOutcome] || '').trim();
  if (!normalizedDeploymentId) return { success: false, error: 'deploymentId is required' };
  if (!normalizedPageUrl) return { success: false, error: 'pageUrl must be a valid http(s) URL' };
  if (!DEPLOYMENT_TERMINAL_STATUSES.includes(normalizedStatus)) {
    return { success: false, error: `status must be one of: ${DEPLOYMENT_TERMINAL_STATUSES.join(', ')}` };
  }
  // Keep version IDs and byte hashes in order as paired immutable receipts.
  // Deduplicating either list independently would silently scramble those
  // pairs. Reconciliation is deliberately desktop+mobile only, so staging
  // cannot proceed with a partial responsive evidence set.
  const cleanIds = (Array.isArray(versionIds) ? versionIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean)
    .slice(0, 2);
  const cleanHashes = (Array.isArray(contentHashes) ? contentHashes : [])
    .map((hash) => String(hash || '').trim().toLowerCase())
    .filter((hash) => /^[0-9a-f]{64}$/.test(hash))
    .slice(0, 2);
  const normalizedCaptureRunId = String(captureRunId || '').trim();
  const normalizedCaptureProof = String(captureProof || '').trim();
  const hasCaptureRun = normalizedCaptureRunId.length > 0 || normalizedCaptureProof.length > 0;
  if (hasCaptureRun && (!normalizedCaptureRunId || normalizedCaptureProof.length < 32)) {
    return { success: false, error: 'captureRunId and opaque captureProof must be supplied together' };
  }
  const requiresStagedVersions = normalizedStatus === 'updated'
    || normalizedStatus === 'added'
    || (normalizedStatus === 'unchanged' && hasCaptureRun);
  if (requiresStagedVersions && (cleanIds.length !== 2 || cleanHashes.length !== 2 || cleanIds.length !== cleanHashes.length)) {
    return { success: false, error: `${normalizedStatus} requires paired immutable desktop and mobile versionIds and SHA-256 contentHashes from current-run staged uploads` };
  }
  if (!requiresStagedVersions && (cleanIds.length || cleanHashes.length)) {
    return { success: false, error: `${normalizedStatus} must not attach staged capture receipts` };
  }
  const cleanError = typeof error === 'string' ? error.trim().slice(0, 1000) : '';
  if (['failed', 'inaccessible', 'skipped'].includes(normalizedStatus) && !cleanError) {
    return { success: false, error: `${normalizedStatus} requires a bounded truthful error/reason` };
  }
  const r = await _critiqueQueueFetch(config, reconciliationQueuePath(config, 'recordPageResult'), {
    method: 'POST',
    body: JSON.stringify({
      deployment_id: normalizedDeploymentId,
      page_url: normalizedPageUrl,
      status: normalizedStatus,
      ...(normalizedCaptureRunId ? { capture_run_id: normalizedCaptureRunId } : {}),
      ...(normalizedCaptureProof ? { capture_proof: normalizedCaptureProof } : {}),
      ...(cleanIds.length ? { version_ids: cleanIds } : {}),
      ...(cleanHashes.length ? { content_hashes: cleanHashes } : {}),
      ...(cleanError ? { error: cleanError } : {}),
    }),
  });
  const idempotent = Boolean(r.body?.idempotent || r.body?.replayed || r.body?.already_recorded || r.body?.alreadyRecorded);
  // Some deployments return an explicit idempotent replay as 200 while others
  // retain a conflict status. The backend is authoritative about exact-body
  // equality; when it says the receipt is idempotent, expose it as success and
  // never encourage the caller to make a replacement upload.
  const legacyRunRequired = !hasCaptureRun && r.body?.error === 'capture_run_id_and_proof_required';
  if (!r.ok && !idempotent) {
    if (legacyRunRequired) {
      return {
        success: false,
        error: 'deployment_frame_refresh_run_required',
        message: 'This deployment has an initialized frame-refresh obligation; start a capture run and provide its proof. Historical not_requested receipts retain the legacy no-run route.',
        status: r.status,
      };
    }
    return { success: false, ...safeProviderError(r.body, r.status, { fallback: 'deployment_page_result_failed' }) };
  }
  const deployment = normalizeDeploymentMetadata(r.body?.deployment);
  const cleanup = normalizeCleanupReceipt(r.body?.cleanup || r.body?.cleanup_receipt || r.body?.cleanupReceipt);
  return {
    success: true,
    deployment,
    pageResult: normalizePageResult(r.body?.page_result || r.body?.pageResult),
    cleanup,
    cleanupState: cleanup?.state || deployment?.cleanupState || null,
    autoFinalized: Boolean(r.body?.auto_finalized || r.body?.autoFinalized
      || (deployment?.status === 'completed' && deployment?.frameRefreshState === 'completed')),
    // A retry with the exact same terminal receipt is a success. Surface that
    // fact so an orchestration command can stop retrying without mistaking it
    // for a second capture/report promotion.
    idempotent,
  };
}

// ─── Pincushion AI: shared bot identity ─────────────────────────────────────
// Single source of truth for the bot's identity. The Chrome extension's
// `isBotPin` and the edge function's spoof-rejection logic both key on the
// email — never on the display name — so this is the trust anchor.
const BOT_EMAIL = 'pincushion-bot@pincushion.io';
const BOT_AUTHOR = 'Pincushion AI';
const CRITIQUE_SEVERITIES = new Set(['high', 'medium']);

// ─── Pincushion AI: Reply Candidates + Bot Reply ────────────────────────────
// Used by the /pincushion-replies slash command. Returns the set of pins where
// the bot should respond, with the trigger reason attached so the slash
// command can craft an appropriate reply. Two trigger categories:
//
//   A. "mention"     — any pin where the latest thread message contains
//                      `@pincushion` AND was authored by a human.
//   B. "reply-on-bot-pin" — pin authored by the bot (first thread message
//                      from Pincushion AI) where the latest message is from
//                      a human.
//
// Idempotency rule (applied to both): if the LATEST thread message is
// bot-authored, skip the pin. The bot never replies twice in a row.

const MENTION_REGEX = /@pincushion\b/i;

function _isBotThreadMessage(msg) {
  if (!msg) return false;
  return msg.authorEmail === BOT_EMAIL || msg.author === BOT_AUTHOR;
}

export async function toolGetReplyCandidates(config, { projectId } = {}, fetchRemote = null) {
  const allData = await readAllAnnotations(config, fetchRemote);
  const candidates = [];

  for (const [entryKey, pageData] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, pageData);
    for (const ann of (pageData.annotations || [])) {
      if (projectId && ann.projectId !== projectId) continue;
      // Closed threads, including board-owner dismissal, never re-enter an
      // agent-facing reply/implementation workflow.
      if (isTerminalStatus(ann.status)) continue;
      const thread = ann.thread || [];
      if (!thread.length) continue;

      const lastMsg = thread[thread.length - 1];
      // Idempotency: if latest message is bot-authored, no reply needed.
      if (_isBotThreadMessage(lastMsg)) continue;

      // Trigger A — @pincushion mention in the latest message.
      const mentionedInLast = lastMsg.body && MENTION_REGEX.test(lastMsg.body);

      // Trigger B — pin originally authored by the bot, latest message is human.
      const firstMsg = thread[0];
      const pinIsBotAuthored = ann.isBot === true || _isBotThreadMessage(firstMsg);
      const repliedOnBotPin = pinIsBotAuthored && !_isBotThreadMessage(lastMsg);

      if (!mentionedInLast && !repliedOnBotPin) continue;

      // Build a minimal candidate record for the slash command. Include
      // enough context to draft a reply: the pin's selector, the latest
      // human message, and the trigger reason.
      candidates.push({
        annotationId: ann.id,
        pageUrl,
        pageTitle: pageData.pageTitle || pageUrl,
        projectId: ann.projectId || null,
        selector: ann.element?.selector || null,
        componentName: ann.element?.lwcComponent || null,
        triggers: [
          ...(mentionedInLast ? ['mention'] : []),
          ...(repliedOnBotPin ? ['reply-on-bot-pin'] : []),
        ],
        latestMessage: {
          author: lastMsg.author,
          body: lastMsg.body,
          timestamp: lastMsg.timestamp,
        },
        // Send the recent thread so the bot can keep tone consistent.
        recentThread: thread.slice(-6).map(m => ({
          author: m.author,
          isBot: _isBotThreadMessage(m),
          body: m.body,
          timestamp: m.timestamp,
        })),
        pinIsBotAuthored,
      });
    }
  }

  // Newest first so the slash command can pace replies if there's a backlog.
  candidates.sort((a, b) =>
    new Date(b.latestMessage.timestamp || 0) - new Date(a.latestMessage.timestamp || 0)
  );
  return { candidates, count: candidates.length };
}

export async function toolAddBotReply(config, { annotationId, body } = {}, fetchRemote = null) {
  if (!annotationId) return { success: false, error: 'annotationId is required' };
  if (!body || typeof body !== 'string' || !body.trim()) {
    return { success: false, error: 'body is required (the bot reply text)' };
  }
  // Same length cap as create_critique_pin so the bot stays on-brand.
  const trimmedBody = body.trim().slice(0, 800);

  const allData = await readAllAnnotations(config, fetchRemote);
  // The entry key is opaque for v2 records, so derive the exact URL from the
  // validated page record before calling the authoritative lifecycle path.
  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    const sourceAnn = (data.annotations || []).find(a => a.id === annotationId);
    if (!sourceAnn) continue;

    if (isTerminalStatus(sourceAnn.status)) return rejectedTerminalMutation(annotationId, sourceAnn.status);

    // Defensive idempotency check: if the last thread message is already
    // bot-authored, refuse — prevents a buggy slash command run from
    // doubling up replies if it's invoked twice.
    const lastMsg = (sourceAnn.thread || [])[sourceAnn.thread.length - 1];
    if (_isBotThreadMessage(lastMsg)) {
      return {
        success: false,
        error: 'idempotency_skip',
        message: `Pin "${annotationId}" already has a Pincushion AI reply as the most recent message — no reply posted.`,
      };
    }

    // Prepare a detached candidate, then persist only after the authoritative
    // service accepts the write and supplies its canonical annotation row.
    const candidatePage = clonePageData(data);
    const candidate = (candidatePage.annotations || []).find(a => a.id === annotationId);
    if (!candidate) continue;
    candidate.thread = Array.isArray(candidate.thread) ? candidate.thread : [];
    candidate.thread.push({
      id: `msg_${Date.now().toString(36)}`,
      author: BOT_AUTHOR,
      authorEmail: BOT_EMAIL, // critical — the Chrome extension keys bot styling on this exact email
      timestamp: new Date().toISOString(),
      body: trimmedBody,
    });
    candidate.updatedAt = new Date().toISOString();

    const persisted = await persistLifecycleCandidate(config, data, candidatePage, candidate, pageUrl);
    if (!persisted.ok) return persisted.result;

    // sync-annotations meters this authoritatively before the local commit.
    return {
      success: true,
      annotationId,
      message: `Pincushion AI replied on pin "${annotationId}".`,
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

// ─── Pincushion AI: Bot Critique Pin ─────────────────────────────────────────
// Used by the /critique slash command and /critique-latest-deploy. Writes a
// pin authored by Pincushion AI to .feedback/<page-slug>.json and pushes to
// Supabase. The Chrome extension resolves screen position from element.selector
// since the bot has no live page coords.
//
// Strict invariants:
// - author === 'Pincushion AI', authorEmail === 'pincushion-bot@pincushion.io'.
// - isBot === true. The edge function only honors this when author_email
//   matches the canonical bot, so a spoofed payload from elsewhere is rejected.
// - severity ∈ {'high','medium'} maps to priority. 'low' is intentionally
//   excluded — the bot's job is to flag issues worth acting on, not noise.
//
// Bot identity constants (BOT_EMAIL, BOT_AUTHOR, CRITIQUE_SEVERITIES) are
// declared at the top of the Pincushion AI block above so reply helpers
// share the same trust anchor.

function normalizeVariantRoute(pageUrl) {
  try {
    const url = new URL(pageUrl);
    const pathname = url.pathname.replace(/\/+$/, '') || '/';
    return `${url.origin.toLowerCase()}${pathname.toLowerCase()}`;
  } catch {
    return String(pageUrl || '').split(/[?#]/, 1)[0].replace(/\/+$/, '').toLowerCase();
  }
}

function normalizeVariantFinding(body, pageUrl) {
  let normalized = String(body || '').toLowerCase();
  try {
    const url = new URL(pageUrl);
    const values = [...url.searchParams.values()]
      .map(value => value.trim().toLowerCase())
      .filter(value => value.length >= 3)
      .sort((a, b) => b.length - a.length);
    for (const value of values) normalized = normalized.split(value).join('{variant}');
  } catch {
    // Invalid URLs are rejected elsewhere; retain the body-only fingerprint.
  }
  return normalized.replace(/[^a-z0-9{}]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function findQueryVariantDuplicate(allData, { pageUrl, selector, body, projectId = null, authorClass, agentName, isBot }) {
  let candidate;
  try {
    candidate = new URL(pageUrl);
  } catch {
    return null;
  }
  if (!candidate.search) return null;

  const route = normalizeVariantRoute(pageUrl);
  const finding = normalizeVariantFinding(body, pageUrl);
  const normalizedSelector = String(selector || '').trim();

  for (const page of Object.values(allData || {})) {
    for (const annotation of page.annotations || []) {
      const existingUrl = annotation.pageUrl || page.pageUrl;
      if (!existingUrl || existingUrl === pageUrl || normalizeVariantRoute(existingUrl) !== route) continue;
      if (projectId && annotation.projectId !== projectId) continue;
      if (String(annotation.element?.selector || '').trim() !== normalizedSelector) continue;
      if (authorClass && (annotation.authorClass !== authorClass || annotation.agentName !== agentName)) continue;
      if (isBot && !annotation.isBot) continue;
      const existingBody = annotation.thread?.[0]?.body || '';
      if (normalizeVariantFinding(existingBody, existingUrl) === finding) return annotation;
    }
  }
  return null;
}

function duplicateVariantResult(duplicate, pageUrl) {
  return {
    success: false,
    deliveryStatus: CREATION_DELIVERY_STATUSES.duplicate,
    retryable: false,
    error: 'duplicate_variant',
    duplicateOf: duplicate.id,
    normalizedRoute: normalizeVariantRoute(pageUrl),
    message: 'This finding already exists on another query variant of the same route and selector.',
    nextAction: 'Inspect a distinct state, scenario, or element before filing another pin.',
  };
}

export async function toolCreateCritiquePin(config, {
  pageUrl,
  pageTitle,
  componentName,
  selector,
  body,
  severity = 'medium',
  visibility = 'public',
  tags = [],
  critiqueRunId,
  projectId,
  operationId: suppliedOperationId,
} = {}, fetchRemote = null) {
  // Validate up-front so the critic subagent gets a clear error instead of a
  // half-written pin file.
  if (!pageUrl) return creationFailure({ error: 'pageUrl is required' });
  if (!body || typeof body !== 'string' || !body.trim()) {
    return creationFailure({ error: 'body is required (the critique text shown to the user)' });
  }
  if (!CRITIQUE_SEVERITIES.has(severity)) {
    return creationFailure({ error: `severity must be one of: ${[...CRITIQUE_SEVERITIES].join(', ')}` });
  }
  if (!['public', 'project_members'].includes(visibility)) return creationFailure({ error: 'visibility must be public or project_members' });
  if (selector !== undefined && typeof selector !== 'string') {
    return creationFailure({ error: 'selector must be a string CSS selector' });
  }
  if (!Array.isArray(tags)) {
    return creationFailure({ error: 'tags must be an array of strings' });
  }
  // Reserve room for the `critique-` generation-key prefix while keeping the
  // tag and report receipt byte-for-byte identical.
  const normalizedRunId = String(critiqueRunId || '').trim().slice(0, 100);
  if (!normalizedRunId) {
    return creationFailure({ error: 'critiqueRunId is required' });
  }
  // Hard cap on body length: prevents an LLM from dumping a 5000-word essay
  // into a thread message. UX is concrete pins, not blog posts.
  const trimmedBody = body.trim().slice(0, 800);

  const requestedOperation = requestedCreationOperationId(suppliedOperationId);
  if (!requestedOperation.ok) return requestedOperation.result;
  const scope = await resolveCreationProjectScope(config, { pageUrl, projectId });
  if (!scope.ok) return { ...scope.result, operationId: requestedOperation.operationId };

  const now = new Date().toISOString();
  const annotationId = `ann_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  // Every bot pin belongs to one explicit Crit receipt. This makes it
  // impossible for a later report to claim unrelated AI pins merely because
  // they happen to be on the same project.
  const finalTags = [...new Set(['pincushion-ai', `critique-run:${normalizedRunId}`, ...tags.map(String)])];

  const newAnn = {
    id: annotationId,
    pageUrl,
    // Bot pins start 'open' like any human pin — the team triages them into
    // 'ready'. (They used to skip straight to 'ready', which read as
    // pre-approved work nobody had reviewed.)
    status: 'open',
    priority: severity,
    visibility,
    tags: finalTags,
    element: {
      selector: selector || null,
      lwcComponent: componentName || null,
    },
    pin: null, // no live page coords; Chrome extension resolves via selector.
    thread: [{
      id: `msg_${Date.now().toString(36)}`,
      author: BOT_AUTHOR,
      authorEmail: BOT_EMAIL,
      timestamp: now,
      body: trimmedBody,
    }],
    createdAt: now,
    updatedAt: now,
    author: BOT_AUTHOR,
    authorEmail: BOT_EMAIL,
    isBot: true,
    projectId: scope.projectId,
  };

  // Duplicate detection is only a local quality hint. Do not put an
  // authoritative snapshot fetch ahead of the journal: an unavailable cloud
  // must become a retained pending submission rather than an unrecorded tool
  // failure. The canonical POST/GET receipt below remains the write authority.
  const allData = await readAllAnnotations(config);
  // A supplied operation id is an explicit idempotency boundary. It lets a
  // caller recover an accepted/pending submission even after a local cache
  // restart, and permits a deliberately separate otherwise-identical finding.
  // Normal new calls retain the existing query-variant signal deduplication.
  if (!requestedOperation.explicit) {
    const duplicate = findQueryVariantDuplicate(allData, {
      pageUrl,
      selector,
      body: trimmedBody,
      projectId: scope.projectId,
      isBot: true,
    });
    if (duplicate) return { ...duplicateVariantResult(duplicate, pageUrl), operationId: requestedOperation.operationId };
  }
  const submitted = await submitNewAnnotation(config, {
    operation: 'create_critique_pin',
    operationId: requestedOperation.operationId,
    annotation: newAnn,
    pageTitle: pageTitle || pageUrl,
    allData,
  });
  if (!submitted.ok) return submitted;
  const accepted = submitted.annotation;
  // Canonical acceptance is a completed write, even when its privacy is wrong.
  // Preserve the journal/identity and hold further work; a new operation would
  // duplicate a pin and cannot repair its immutable visibility.
  if (accepted.visibility !== visibility) {
    return {
      success: false,
      error: 'accepted_visibility_mismatch',
      accepted: true,
      annotationId: accepted.id,
      operationId: submitted.operationId,
      deliveryStatus: SUBMISSION_DELIVERY_STATUSES.accepted,
      retryable: false,
      requiresReconciliation: true,
      requestedVisibility: visibility,
      acceptedVisibility: accepted.visibility ?? null,
      message: 'The pin was accepted but its visibility was not verified. Hold uploads and report generation; reconcile this same annotation and operation without creating another pin.',
    };
  }
  return {
    success: true,
    annotationId: accepted.id,
    operationId: submitted.operationId,
    deliveryStatus: SUBMISSION_DELIVERY_STATUSES.accepted,
    retryable: false,
    pin: {
      id: accepted.id,
      pageUrl: accepted.pageUrl,
      selector: selector || null,
      severity,
      tags: finalTags,
      author: BOT_AUTHOR,
      isBot: true,
    },
    message: `Created Pincushion AI pin "${accepted.id}" on ${pageUrl}.`,
  };
}

// ─── Agent Pin Writer ────────────────────────────────────────────────────────
// First-class pins from THIRD-PARTY agents — browser QA agents (Claude in
// Chrome, computer-use), Playwright checkers, CI visual diffs, or another IDE
// agent. Distinct from create_critique_pin: this is NOT the Pincushion AI
// voice (no bot styling, never is_bot) — the author renders as
// "<agentName> (agent)" with an agent chip, enforced server-side. Metered as
// an AI action (agent_pin). This is the write half of the agent→agent
// handoff: a browser agent files the work packet, the coding agent implements
// it via implement_approved_pins / assign_pin_to_agent.
function qaImportEndpoint(config = {}, authority = null) {
  // Keep the credential-bearing request on the already validated sync
  // authority. A caller-supplied arbitrary endpoint (including a mismatched
  // supabaseBase/qaImportEndpoint field) would turn this tool into a
  // license-key forwarding primitive, so it is intentionally unsupported.
  const configured = typeof authority?.syncServerUrl === 'string' && authority.syncServerUrl.trim()
    ? authority.syncServerUrl.trim()
    : typeof config.syncServerUrl === 'string' && config.syncServerUrl.trim()
      ? config.syncServerUrl.trim()
      : '';
  if (!configured) return null;
  try {
    const parsed = new URL(configured);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const originalPath = parsed.pathname;
    parsed.pathname = originalPath.replace(/\/sync-annotations\/?$/, '/qa-ingestion');
    if (parsed.pathname === originalPath) return null;
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return null;
  }
}

function qaImportResponseBody(body, expectedFindings = null) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const projectId = typeof body.project_id === 'string' ? body.project_id : body.projectId;
  const runId = typeof body.run_id === 'string' ? body.run_id : body.runId;
  const findings = Array.isArray(body.findings) ? body.findings : null;
  if (body.success !== true || projectId === undefined || runId === undefined || !findings) return null;
  if (typeof projectId !== 'string' || typeof runId !== 'string') return null;
  if (findings.length > QA_IMPORT_LIMITS.maxFindings || findings.some((finding) => !finding || typeof finding !== 'object' || Array.isArray(finding) ||
    typeof finding.finding_key !== 'string' || !/^qa_[a-f0-9]{64}$/i.test(finding.finding_key) ||
    !['failed', 'passed', 'inconclusive', 'skipped'].includes(finding.outcome) ||
    typeof finding.rule !== 'string' || !finding.rule.trim() || finding.rule.length > QA_IMPORT_LIMITS.maxRuleChars ||
    typeof finding.target !== 'string' || !finding.target.trim() || finding.target.length > QA_IMPORT_LIMITS.maxTargetChars ||
    typeof finding.action !== 'string' || !finding.action.trim() || finding.action.length > 128 ||
    (finding.annotation_id !== null && finding.annotation_id !== undefined && typeof finding.annotation_id !== 'string') ||
    (typeof finding.annotation_id === 'string' && finding.annotation_id.length > 200))) return null;
  if (Array.isArray(expectedFindings)) {
    const expectedByKey = new Map(expectedFindings.map((finding) => [finding.findingKey, finding]));
    const returnedKeys = new Set(findings.map((finding) => finding.finding_key));
    if (returnedKeys.size !== findings.length || returnedKeys.size !== expectedByKey.size) return null;
    for (const finding of findings) {
      const expected = expectedByKey.get(finding.finding_key);
      if (!expected || finding.rule !== expected.rule || finding.target !== expected.target || finding.outcome !== expected.outcome) return null;
      // An observational pass can never smuggle a pin identity back through a
      // malformed/future response. Failed records may legitimately have no
      // annotation when a deterministic identity conflict was preserved.
      if (expected.outcome !== 'failed' && finding.annotation_id !== null && finding.annotation_id !== undefined) return null;
      if (finding.annotation_id !== null && finding.annotation_id !== undefined && finding.annotation_id !== deterministicQaPinId(expected)) return null;
    }
  }
  return {
    success: true,
    projectId,
    runId,
    replayed: body.replayed === true,
    summary: body.summary && typeof body.summary === 'object' && !Array.isArray(body.summary) ? body.summary : {},
    findings,
    // This tool is observation-only even if a future server accidentally
    // includes a stronger-looking field in its response. Deployment/check
    // evidence has separate authoritative tools and cannot be upgraded here.
    evidence: { trusted: false, verification: 'not_established' },
    message: typeof body.message === 'string' ? body.message.slice(0, 512) : 'QA results imported.',
  };
}

/**
 * Import already-parsed axe or Playwright JSON. Normalization is deliberately
 * local and side-effect free; only the non-dry-run path calls the dedicated
 * server-side importer. The importer never reads a file, fetches a page, calls
 * a provider, resolves an annotation, or writes verification evidence.
 */
export async function toolImportQaResults(config, input = {}, _fetchRemote = null) {
  const parsed = normalizeQaImport(input);
  if (!parsed.ok) {
    return {
      success: false,
      error: 'invalid_qa_results',
      reason: parsed.error,
      ...(parsed.max !== undefined ? { max: parsed.max } : {}),
    };
  }
  const normalized = parsed.value;
  const preview = qaImportPreview(normalized);
  if (normalized.dryRun) {
    return {
      success: true,
      dryRun: true,
      preview,
      evidence: { trusted: false, verification: 'not_established' },
      message: 'Preview only. No findings, pins, statuses, or verification records were changed.',
    };
  }

  const authority = resolveLifecycleAuthority(config);
  if (!authority.ok) {
    return {
      success: false,
      error: 'authoritative_sync_required',
      message: 'An authenticated authoritative sync URL and license are required before importing QA results. Nothing was written.',
    };
  }
  const endpoint = qaImportEndpoint(config, authority);
  const fetchImpl = _fetchRemote || config?.fetchImpl || globalThis.fetch;
  if (!endpoint || typeof fetchImpl !== 'function') {
    return {
      success: false,
      error: 'qa_import_unavailable',
      message: 'The authoritative QA importer is unavailable. Nothing was written.',
    };
  }

  const requestBody = {
    action: 'import_qa_results',
    project_id: normalized.projectId,
    page_url: normalized.pageUrl,
    device: normalized.device,
    format: normalized.format,
    format_version: normalized.formatVersion,
    run_id: normalized.runId,
    source: normalized.source,
    source_metadata: normalized.sourceMetadata,
    commit_sha: normalized.commitSha,
    branch: normalized.branch,
    environment: normalized.environment,
    payload_digest: normalized.payloadDigest,
    findings: normalized.findings.map((finding) => ({
      rule: finding.rule,
      target: finding.target,
      outcome: finding.outcome,
      severity: finding.severity,
      message: finding.message,
      source_index: finding.sourceIndex,
      identity: finding.identity,
      finding_key: finding.findingKey,
    })),
  };
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'Content-Type': 'application/json',
        'x-license-key': authority.licenseKey,
        'x-pincushion-client': `mcp/${config.pkgVersion || '0'}`,
      },
      body: JSON.stringify(requestBody),
    });
    const body = await responseBody(response);
    if (!response?.ok) {
      return {
        success: false,
        ...safeProviderError(body, Number(response?.status || 0), { fallback: 'qa_import_rejected' }),
      };
    }
    const canonical = qaImportResponseBody(body, normalized.findings);
    if (!canonical || canonical.projectId !== normalized.projectId || canonical.runId !== normalized.runId) {
      return {
        success: false,
        error: 'qa_import_malformed_response',
        message: 'The authoritative QA importer returned an incomplete or mismatched receipt. Treat the import outcome as unknown and retry with the same run ID.',
      };
    }
    return { ...canonical, dryRun: false, preview };
  } catch {
    return {
      success: false,
      error: 'qa_import_network_error',
      retryable: true,
      message: 'The authoritative QA importer could not be reached. Nothing was assumed to have been written; retry with the same run ID.',
    };
  }
}

export async function toolCreateAgentPin(config, {
  pageUrl,
  pageTitle,
  selector,
  body,
  agentName,
  severity = 'medium',
  acceptanceCriteria,
  tags = [],
  projectId,
  operationId: suppliedOperationId,
} = {}, fetchRemote = null) {
  if (!pageUrl) return creationFailure({ error: 'pageUrl is required' });
  if (!body || typeof body !== 'string' || !body.trim()) {
    return creationFailure({ error: 'body is required (what the agent found + the suggested fix)' });
  }
  if (!agentName || typeof agentName !== 'string' || !agentName.trim()) {
    return creationFailure({ error: 'agentName is required (e.g. "Playwright a11y check", "Claude in Chrome") — it renders as the pin author' });
  }
  if (!CRITIQUE_SEVERITIES.has(severity)) {
    return creationFailure({ error: `severity must be one of: ${[...CRITIQUE_SEVERITIES].join(', ')}` });
  }
  if (selector !== undefined && typeof selector !== 'string') {
    return creationFailure({ error: 'selector must be a string CSS selector' });
  }
  if (!Array.isArray(tags)) return creationFailure({ error: 'tags must be an array of strings' });

  const requestedOperation = requestedCreationOperationId(suppliedOperationId);
  if (!requestedOperation.ok) return requestedOperation.result;
  const scope = await resolveCreationProjectScope(config, { pageUrl, projectId });
  if (!scope.ok) return { ...scope.result, operationId: requestedOperation.operationId };

  const cleanAgentName = agentName.trim().slice(0, 80);
  const trimmedBody = body.trim().slice(0, 1200);
  const now = new Date().toISOString();
  const annotationId = `ann_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const finalTags = [...new Set(['agent-pin', ...tags.map(String)])];
  const authorDisplay = `${cleanAgentName} (agent)`;

  const newAnn = {
    id: annotationId,
    pageUrl,
    status: 'open', // agent findings get triaged like any pin — never pre-approved
    tags: finalTags,
    element: { selector: selector || null, lwcComponent: null },
    pin: null,
    thread: [{
      id: `msg_${Date.now().toString(36)}`,
      author: authorDisplay,
      authorEmail: '',
      timestamp: now,
      body: trimmedBody,
    }],
    createdAt: now,
    updatedAt: now,
    author: authorDisplay,
    authorEmail: '',
    authorClass: 'agent',
    agentName: cleanAgentName,
    acceptanceCriteria: typeof acceptanceCriteria === 'string' ? acceptanceCriteria.slice(0, 2000) : null,
    projectId: scope.projectId,
  };

  // See create_critique_pin: local duplicate hints must not prevent a durable
  // journal entry when the authoritative service is temporarily unavailable.
  const allData = await readAllAnnotations(config);
  if (!requestedOperation.explicit) {
    const duplicate = findQueryVariantDuplicate(allData, {
      pageUrl,
      selector,
      body: trimmedBody,
      projectId: scope.projectId,
      authorClass: 'agent',
      agentName: cleanAgentName,
    });
    if (duplicate) return { ...duplicateVariantResult(duplicate, pageUrl), operationId: requestedOperation.operationId };
  }
  const submitted = await submitNewAnnotation(config, {
    operation: 'create_agent_pin',
    operationId: requestedOperation.operationId,
    annotation: newAnn,
    pageTitle: pageTitle || pageUrl,
    allData,
  });
  if (!submitted.ok) return submitted;
  const accepted = submitted.annotation;
  return {
    success: true,
    annotationId: accepted.id,
    operationId: submitted.operationId,
    deliveryStatus: SUBMISSION_DELIVERY_STATUSES.accepted,
    retryable: false,
    pin: { id: accepted.id, pageUrl: accepted.pageUrl, selector: selector || null, severity, tags: finalTags, author: authorDisplay, authorClass: 'agent' },
    message: `Created agent pin "${accepted.id}" by ${authorDisplay} on ${pageUrl}.`,
  };
}

export async function toolFixAndResolve(config, { annotationId, fixDescription, filePath, lineNumber, commitSha, branchName, prUrl }, fetchRemote = null) {
  if (!annotationId || !fixDescription) {
    return { error: 'annotationId and fixDescription are required' };
  }

  const allData = await readAllAnnotations(config, fetchRemote);

  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;
    if (isTerminalStatus(ann.status)) return rejectedTerminalMutation(annotationId, ann.status);

    const candidatePage = clonePageData(data);
    const candidate = candidatePage.annotations.find(a => a.id === annotationId);

    const implementedAt = new Date().toISOString();
    const locationSuffix = filePath
      ? ` (${filePath}${lineNumber ? `:${lineNumber}` : ''})`
      : '';

    // fix_and_resolve is the terminal transition in the Open → Ready → Resolved
    // lifecycle. The pin should disappear from the stakeholder's Ready tab the
    // moment the agent finishes. Previously this set only `action='implemented'`
    // and the pin stayed visible until someone manually called resolve_annotation
    // — the tool name promised resolution but didn't deliver it.
    candidate.status = 'resolved';
    candidate.resolvedAt = implementedAt;
    candidate.action = 'implemented';
    candidate.implementedAt = implementedAt;
    candidate.updatedAt = implementedAt; // must bump so cloud sync pull doesn't overwrite

    // Bidirectional pin↔commit link. Only persisted when the project's
    // recordCommitSha setting is on (default: true). The check is
    // best-effort — if config can't be loaded, we keep today's behavior
    // by writing the SHA, since it's invisible plumbing with no source-
    // code or commit-log cost.
    if (commitSha) {
      const projectConfig = await readProjectConfig(config, candidate.projectId).catch(() => null);
      const recordSha = projectConfig?.recordCommitSha !== false;
      if (recordSha) candidate.commitSha = commitSha;
    }

    // A4: Branch / PR linkage. These let the stakeholder see "Resolved in
    // PR #142" without an extra round-trip, and they're how time-to-fix is
    // computed (commit timestamp - pin createdAt). Validation is light —
    // we'd rather store a slightly malformed URL than block the resolve.
    if (typeof branchName === 'string' && branchName.trim()) {
      candidate.branchName = branchName.trim().slice(0, 200);
    }
    if (typeof prUrl === 'string' && prUrl.trim()) {
      const trimmed = prUrl.trim().slice(0, 500);
      // Only store URLs that look like a GitHub/GitLab/Bitbucket PR — prevents
      // accidental injection of arbitrary text into the dashboard link.
      if (/^https?:\/\/[a-z0-9.-]+\/.+\/(pull|merge_requests?|pull-requests)\/[0-9a-z-]+/i.test(trimmed)) {
        candidate.prUrl = trimmed;
      }
    }

    candidate.thread = candidate.thread || [];
    candidate.thread.push({
      id: `msg_${Date.now().toString(36)}`,
      author: 'AI Agent',
      authorEmail: '',
      timestamp: implementedAt,
      body: `Implemented: ${fixDescription}${locationSuffix}`,
      type: 'code-note'
    });

    const persisted = await persistLifecycleCandidate(config, data, candidatePage, candidate, pageUrl);
    if (!persisted.ok) return persisted.result;
    await removeAgentQueueEntry(config, annotationId);

    return {
      success: true,
      annotationId,
      message: `Resolved "${annotationId}" on page "${persisted.page.pageTitle || pageUrl}".`,
      status: 'resolved',
      fixDescription,
      filePath,
      lineNumber,
      commitSha: persisted.annotation.commitSha || null,
      branchName: persisted.annotation.branchName || null,
      prUrl: persisted.annotation.prUrl || null,
      resolvedAt: persisted.annotation.resolvedAt || null,
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

// A6: time-to-fix metrics. Computes median + p25/p75 over the duration
// between pin creation and resolution. Returns null when the sample is too
// small to be statistically meaningful (< 5 resolved pins) so the landing
// page doesn't lie about velocity.
//
// Pro/Team gate is enforced at the server.js wrapper layer (it owns license
// state). This pure builder returns the Free-tier degraded payload so it
// stays unit-testable.
export function buildFreeTierMetricsResponse(sampleSize, scope, projectId, currentPlan = 'free') {
  return {
    sampleSize: sampleSize ?? 0,
    thresholdMet: false,
    median: null,
    p25: null,
    p75: null,
    scope,
    projectId: scope === 'project' ? (projectId || null) : null,
    planRequired: 'pro',
    currentPlan,
    upgradeUrl: 'https://www.pincushion.io/pricing?ref=mcp-plan-limit',
    message: `Time-to-fix metrics require Pro or Team. Sample size visible (${sampleSize ?? 0} resolved pin(s)); upgrade to see median, p25, and p75.`,
  };
}
//
// Stat note: percentile uses linear interpolation (R default). Sample size
// is exposed so callers can decide whether to display the number publicly.
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export async function toolGetTimeToFixMetrics(config, { projectId, scope = 'project' } = {}, fetchRemote = null) {
  if (scope !== 'project' && scope !== 'global') {
    return { error: 'scope must be "project" or "global"' };
  }

  const allData = await readAllAnnotations(config, fetchRemote);
  const durations = []; // in seconds

  for (const data of Object.values(allData)) {
    for (const ann of (data.annotations || [])) {
      if (scope === 'project' && !matchesProject(ann.projectId, projectId)) continue;
      if (ann.status !== 'resolved') continue;
      if (!ann.createdAt || !ann.resolvedAt) continue;
      const start = new Date(ann.createdAt).getTime();
      const end = new Date(ann.resolvedAt).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      durations.push(Math.round((end - start) / 1000));
    }
  }

  const sampleSize = durations.length;
  // Honest threshold: under 5 resolved pins, medians are noise. Return the
  // count but no metric so the caller can hide the widget.
  if (sampleSize < 5) {
    return {
      sampleSize,
      median: null,
      p25: null,
      p75: null,
      scope,
      projectId: scope === 'project' ? (projectId || null) : null,
      message: `Only ${sampleSize} resolved pin(s) — need at least 5 to compute a meaningful median.`,
      thresholdMet: false,
    };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const p25 = percentile(sorted, 0.25);
  const p75 = percentile(sorted, 0.75);

  return {
    sampleSize,
    median,
    p25,
    p75,
    medianHuman: humanizeSeconds(median),
    p25Human: humanizeSeconds(p25),
    p75Human: humanizeSeconds(p75),
    scope,
    projectId: scope === 'project' ? (projectId || null) : null,
    thresholdMet: true,
    message: `Median time-to-fix: ${humanizeSeconds(median)} across ${sampleSize} resolved pin(s).`,
  };
}

function humanizeSeconds(s) {
  if (!Number.isFinite(s) || s < 0) return 'n/a';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

// A5: record the outcome of Pincushion AI's post-deploy verification on a
// resolved pin. Called by the critic subagent after running the auto-critique
// for a fresh deploy. Status one of:
//   'verified'      — the fix is in place and no regressions detected
//   'regressed'     — the fix appears to have introduced a new issue
//   'inconclusive'  — the critic couldn't determine outcome (e.g. element gone)
//   'pending'       — explicit reset to pending (rare; used when re-running)
const VERIFICATION_STATUSES = new Set(['verified', 'regressed', 'inconclusive', 'pending']);

export async function toolRecordPinVerification(config, { annotationId, status, notes, verifiedAt } = {}, fetchRemote = null) {
  if (!annotationId) return { error: 'annotationId is required' };
  if (!status || !VERIFICATION_STATUSES.has(status)) {
    return { error: `status must be one of: ${[...VERIFICATION_STATUSES].join(', ')}` };
  }

  const cleanNotes = typeof notes === 'string' ? notes.slice(0, 2000) : null;
  const cleanVerifiedAt = (typeof verifiedAt === 'string' && verifiedAt) ? verifiedAt : new Date().toISOString();

  const allData = await readAllAnnotations(config, fetchRemote);
  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;
    if (isTerminalStatus(ann.status) && ann.status !== 'resolved') return rejectedTerminalMutation(annotationId, ann.status);

    if (typeof config.submitReportedVerification === 'function') {
      // Preserve the legacy tool's default observation time. A null time made
      // verified -> regressed -> verified reuse the first report forever when
      // the implementation/notes were unchanged. An explicit time still lets
      // a caller retry the same logical observation idempotently.
      const reported = await config.submitReportedVerification({ annotation: ann, annotationId, status, notes: cleanNotes, verifiedAt: cleanVerifiedAt });
      if (!reported?.legacyFallback) {
        if (!reported?.success) return reported || { success: false, error: 'verification_evidence_unavailable' };
        return {
          success: true, annotationId, verificationStatus: status, verificationNotes: cleanNotes,
          verifiedAt: reported.verification?.reported?.reported_at || null,
          verificationProvenance: 'reported', reportId: reported.report_id,
          verification: reported.verification,
          message: `Recorded caller-reported verification "${status}" on pin "${annotationId}". This report does not establish independent check execution or client acceptance.`,
        };
      }
    }

    const candidatePage = clonePageData(data);
    const candidate = candidatePage.annotations.find(a => a.id === annotationId);

    candidate.verificationStatus = status;
    candidate.verificationNotes = cleanNotes;
    candidate.verifiedAt = cleanVerifiedAt;
    candidate.updatedAt = new Date().toISOString();

    const persisted = await persistLifecycleCandidate(config, data, candidatePage, candidate, pageUrl);
    if (!persisted.ok) return persisted.result;

    return {
      success: true,
      annotationId,
      verificationStatus: status,
      verificationNotes: cleanNotes,
      verifiedAt: cleanVerifiedAt,
      verificationProvenance: 'legacy_reported',
      message: `Recorded caller-reported verification "${status}" on pin "${annotationId}". Independent check execution and client acceptance are not established by this report.`,
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

// A4: link a deploy URL to a resolved pin. Called by deploy-hook when the
// resolved-pins set is auto-finalized on deploy. Idempotent — re-running on
// the same pin overwrites the previous deploy_url with the latest value
// (newer deploy supersedes the older one).
export async function toolLinkPinDeploy(config, { annotationId, deployUrl, deployedAt } = {}, fetchRemote = null) {
  if (!annotationId) return { error: 'annotationId is required' };
  if (!deployUrl || typeof deployUrl !== 'string') return { error: 'deployUrl is required' };

  // Light URL validation. We do NOT restrict to specific hosts — deploys
  // happen on Vercel, Netlify, AWS, Render, custom CDNs. Just ensure it's
  // an http(s) URL of reasonable length.
  let parsed;
  try {
    parsed = new URL(deployUrl);
  } catch {
    return { error: 'deployUrl must be a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'deployUrl must use http or https' };
  }
  const cleanDeployUrl = parsed.toString().slice(0, 500);
  const cleanDeployedAt = (typeof deployedAt === 'string' && deployedAt) ? deployedAt : new Date().toISOString();

  const allData = await readAllAnnotations(config, fetchRemote);
  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;
    if (isTerminalStatus(ann.status) && ann.status !== 'resolved') return rejectedTerminalMutation(annotationId, ann.status);

    const candidatePage = clonePageData(data);
    const candidate = candidatePage.annotations.find(a => a.id === annotationId);

    candidate.deployUrl = cleanDeployUrl;
    candidate.deployedAt = cleanDeployedAt;
    candidate.updatedAt = new Date().toISOString();

    const persisted = await persistLifecycleCandidate(config, data, candidatePage, candidate, pageUrl);
    if (!persisted.ok) return persisted.result;
    return {
      success: true,
      annotationId,
      deployUrl: cleanDeployUrl,
      deployedAt: cleanDeployedAt,
      message: `Linked deploy "${cleanDeployUrl}" to pin "${annotationId}".`,
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

export async function toolGetActionablePins(config, { projectId, mode, mentionedUser } = {}, fetchRemote = null) {
  const allData = await readAllAnnotations(config, fetchRemote);
  const actionable = [];
  // Normalise mentionedUser: strip leading @ so "@josh" and "josh" both work
  const mentionFilter = mentionedUser ? mentionedUser.replace(/^@/, '').toLowerCase() : null;

  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    for (const ann of (data.annotations || [])) {
      // Skip already-resolved pins
      if (isTerminalStatus(ann.status)) continue;

      // Classify this pin into modes:
      //
      //   'auto-agent'      — user clicked "Send to Agent"; action = pending_implementation
      //   'preview-ready'   — agent generated a preview; commenter can review/approve
      //   'preview-approved'— commenter approved; dev can apply
      //   'preview-revised' — commenter revised after seeing preview; agent should re-generate
      //   'follow-up'       — previously implemented pin with a new user comment
      //   'review'          — open pin with no action set; standard review queue
      //
      // All modes show up for developers. Preview modes also surface for commenters.

      let pinMode = null;

      // v2 status-driven: ready pins (formerly 'approved') are highest priority
      // — implement immediately. Honor both names so legacy local files still work.
      if (isReadyStatus(ann.status)) {
        pinMode = 'approved';
      } else if (ann.action === 'implemented') {
        // Implemented + awaiting human resolve. Only re-surface as a follow-up
        // if the user has replied AFTER the agent's last code-note. Checked
        // before `status === 'in-progress'` so follow-up replies on legacy
        // implemented-but-unresolved pins still re-enter the queue.
        const thread = ann.thread || [];
        const lastCodeNote = [...thread].reverse().find(m => m.type === 'code-note');
        if (lastCodeNote) {
          const lastUserMsg = [...thread].reverse().find(
            m => m.type !== 'code-note' && m.type !== 'decline' && m.author !== 'AI Agent'
          );
          if (lastUserMsg && new Date(lastUserMsg.timestamp) > new Date(lastCodeNote.timestamp)) {
            pinMode = 'follow-up';
          }
        }
      } else if (ann.status === 'in-progress') {
        pinMode = 'in-progress';
      } else if (ann.action === 'pending_implementation') {
        pinMode = 'auto-agent';
      } else if (ann.action === 'preview_ready') {
        pinMode = 'preview-ready';
      } else if (ann.action === 'preview_approved') {
        pinMode = 'preview-approved';
      } else if (ann.action === 'preview_revised') {
        pinMode = 'preview-revised';
      } else if (ann.action === 'preview_generating') {
        pinMode = 'auto-agent'; // Still processing — group with auto-agent
      } else if (!ann.action || ann.action === null || ann.action === 'none') {
        // Review Mode pin: reviewer left a comment, hasn't explicitly sent to agent
        // Only surface if there's at least one user comment in the thread
        const hasComment = (ann.thread || []).some(
          m => m.type !== 'code-note' && m.type !== 'decline' && m.author !== 'AI Agent'
        );
        if (hasComment) {
          pinMode = 'review';
        }
      }

      if (!pinMode) continue;

      // Optional filters (supports string ID or Set of IDs)
      if (!matchesProject(ann.projectId, projectId)) continue;
      if (mode && pinMode !== mode) continue;
      // mentionedUser: only include if @username appears in any thread message body
      if (mentionFilter) {
        const mentioned = (ann.thread || []).some(m =>
          m.body && m.body.toLowerCase().includes(`@${mentionFilter}`)
        );
        if (!mentioned) continue;
      }

      actionable.push({
        id: ann.id,
        pageUrl,
        pageTitle: data.pageTitle || pageUrl,
        projectId: ann.projectId || null,
        status: ann.status,
        action: ann.action,
        mode: pinMode,           // 'auto-agent' | 'follow-up' | 'review'
        element: {
          lwcComponent: ann.element?.lwcComponent,
          selector: ann.element?.selector,
          tagName: ann.element?.tagName,
          textContent: ann.element?.textContent?.slice(0, 150),
          attributes: ann.element?.attributes
        },
        // Device context so an agent triaging pins can tell a mobile-only
        // issue from a desktop one before pulling the full work packet.
        viewport: ann.viewport || null,
        device: describeViewport(ann.viewport)?.label || null,
        thread: ann.thread?.map(serializeThreadMessage),
        preview: ann.preview ? {
          status: ann.preview.status,
          diff: ann.preview.diff,
          cssOverride: ann.preview.cssOverride,
          complexity: ann.preview.complexity,
          model: ann.preview.model,
          generatedAt: ann.preview.generatedAt,
          filePath: ann.preview.filePath,
        } : null,
        createdAt: ann.createdAt
      });
    }
  }

  // Sort: approved pins first (stakeholder-approved, implement now), then in-progress, etc.
  const modeOrder = {
    'approved': 0,          // Stakeholder approved — implement immediately
    'in-progress': 1,       // Already claimed, finish implementation
    'preview-approved': 2,  // Commenter approved — dev should apply
    'auto-agent': 3,        // Queued for processing
    'preview-revised': 4,   // Needs re-generation
    'preview-ready': 5,     // Awaiting commenter review
    'follow-up': 6,
    'review': 7,
  };
  // Sort by mode (approved first, etc.) then by age (oldest first within mode).
  // Priority secondary-sort was removed when the priority column went dormant.
  actionable.sort((a, b) => {
    const md = (modeOrder[a.mode] ?? 5) - (modeOrder[b.mode] ?? 5);
    if (md !== 0) return md;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });

  const approvedCount        = actionable.filter(p => p.mode === 'approved').length;
  const inProgressCount      = actionable.filter(p => p.mode === 'in-progress').length;
  const previewApprovedCount = actionable.filter(p => p.mode === 'preview-approved').length;
  const previewReadyCount    = actionable.filter(p => p.mode === 'preview-ready').length;
  const previewRevisedCount  = actionable.filter(p => p.mode === 'preview-revised').length;
  const autoAgentCount       = actionable.filter(p => p.mode === 'auto-agent').length;
  const followUpCount        = actionable.filter(p => p.mode === 'follow-up').length;
  const reviewCount          = actionable.filter(p => p.mode === 'review').length;

  const parts = [];
  if (approvedCount)        parts.push(`${approvedCount} APPROVED — implement now`);
  if (inProgressCount)      parts.push(`${inProgressCount} in-progress — finish implementation`);
  if (previewApprovedCount) parts.push(`${previewApprovedCount} preview approved (ready to apply)`);
  if (autoAgentCount)       parts.push(`${autoAgentCount} auto-agent`);
  if (previewRevisedCount)  parts.push(`${previewRevisedCount} revised (needs re-gen)`);
  if (previewReadyCount)    parts.push(`${previewReadyCount} preview ready`);
  if (followUpCount)        parts.push(`${followUpCount} follow-up`);
  if (reviewCount)          parts.push(`${reviewCount} review`);
  const summary = parts.join(', ');

  // Build priority-ordered instructions
  let instructions;
  if (approvedCount > 0) {
    instructions = `⚡ ${approvedCount} APPROVED PIN(S) — IMPLEMENT NOW.\n` +
      'These pins have been approved by stakeholders and are waiting for you to implement.\n' +
      'Workflow:\n' +
      '  1. Call implement_approved_pins to get full context (element selectors, thread, branch names)\n' +
      '  2. For each pin: claim_pin → find the code using the element selector → make the change → fix_and_resolve\n' +
      '  3. Commit and push the branch\n' +
      (inProgressCount > 0 ? `\nAlso: ${inProgressCount} pin(s) already claimed but not yet resolved — finish those too.\n` : '') +
      (actionable.length > approvedCount + inProgressCount ? `\n${actionable.length - approvedCount - inProgressCount} other pin(s) also need attention.` : '');
  } else if (inProgressCount > 0) {
    instructions = `${inProgressCount} pin(s) are claimed/in-progress but not yet resolved. Finish implementation and call fix_and_resolve for each.`;
  } else if (actionable.length > 0) {
    instructions = `${actionable.length} pins awaiting attention (${summary}). ` +
      'For all pins: read the thread, implement the change, then call fix_and_resolve({ annotationId, fixDescription }).';
  } else {
    instructions = 'No pins are currently awaiting attention.';
  }

  return {
    totalActionable: actionable.length,
    breakdown: {
      approved: approvedCount,
      inProgress: inProgressCount,
      previewApproved: previewApprovedCount,
      previewReady: previewReadyCount,
      previewRevised: previewRevisedCount,
      autoAgent: autoAgentCount,
      followUp: followUpCount,
      review: reviewCount,
    },
    pins: actionable,
    instructions,
  };
}

export async function toolClaimPin(config, { annotationId, implementer } = {}, fetchRemote = null) {
  if (!annotationId) return { error: 'annotationId is required' };

  const allData = await readAllAnnotations(config, fetchRemote);

  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;
    if (isTerminalStatus(ann.status)) return rejectedTerminalMutation(annotationId, ann.status);

    // Claimable states:
    //   ready/approved        — went through approve_pin flow OR was auto-published
    //                           by Pincushion AI (bot pins ship as 'ready'; human
    //                           approval flow now writes 'ready' too post-rename
    //                           migration). Both names are honored.
    //   pending_implementation — user clicked "Send to Agent"
    //   open (review mode)    — reviewer left a comment; dev picks it up directly
    const isReviewPin = (ann.status === 'open' || ann.status === 'in-progress') &&
      (!ann.action || ann.action === null || ann.action === 'none') &&
      (ann.thread || []).some(m => m.type !== 'code-note' && m.type !== 'decline' && m.author !== 'AI Agent');
    const isClaimable = isReadyStatus(ann.status) || ann.action === 'pending_implementation' || isReviewPin;
    if (!isClaimable) {
      const hint = ann.status === 'resolved'
        ? 'Pin is already resolved.'
        : ann.action === 'implemented'
          ? 'Pin is already implemented and not pending implementation — add a follow-up comment to re-queue it.'
          : ann.action === 'implementing'
            ? `Pin is already being implemented by ${ann.implementer || 'someone'}.`
            : 'Pin is not pending implementation, has no reviewable comments yet, and has not been approved or queued.';
      return { error: `Pin "${annotationId}" cannot be claimed. ${hint}` };
    }

    const candidatePage = clonePageData(data);
    const candidate = candidatePage.annotations.find(a => a.id === annotationId);
    candidate.status = 'in-progress';
    candidate.action = 'implementing';
    candidate.implementer = implementer || 'AI Agent';
    candidate.updatedAt = new Date().toISOString();

    const persisted = await persistLifecycleCandidate(config, data, candidatePage, candidate, pageUrl);
    if (!persisted.ok) return persisted.result;
    return {
      success: true,
      annotationId,
      message: `Claimed pin "${annotationId}" — now marked as implementing by ${persisted.annotation.implementer}`
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

const COMMENT_ACCESS_VALUES = new Set(['open', 'domain', 'invited']);

// ─── Provider-neutral deployment orchestration ─────────────────────────────
//
// The MCP boundary is deliberately smaller than the provider/lifecycle
// boundary. Provider adapters may need ephemeral setup values while working,
// but this module never returns those values (or a provider webhook ID) to an
// agent. Only the registry's redacted result contract crosses this boundary.
const DEPLOYMENT_PROVIDER_SET = new Set(PROVIDER_IDS);
const LIFECYCLE_METHODS = Object.freeze({
  begin: ['begin', 'beginProvisioning'],
  getBinding: ['getBinding', 'get_binding', 'getBindingForProject'],
  inspect: ['inspect', 'getActive', 'get_active'],
  getCleanup: ['getCleanup', 'get_cleanup', 'getPendingCleanup'],
  getActive: ['getActive', 'get_active'],
  getRepair: ['getRepair', 'get_repair', 'getRepairStatus'],
  uploadCredential: ['uploadCredential', 'upload_credential', 'captureProviderGeneratedCredential'],
  reserveCredential: ['reserveCredential', 'reserve_credential', 'reserveCallerGeneratedCredential'],
  bindReservedCredential: ['bindReservedCredential', 'bind_reserved_credential', 'bindCallerGeneratedCredential'],
  recoverReservedCredential: ['recoverReservedCredential', 'recover_reserved_credential'],
  markReservedCredentialWriteStarted: ['markReservedCredentialWriteStarted', 'mark_reserved_credential_write_started', 'markCallerGeneratedCredentialWriteStarted'],
  markDegraded: ['markDegraded', 'markAttemptDegraded', 'mark_degraded'],
  markCleanupRequired: ['markCleanupRequired', 'markExternalCleanupRequired', 'mark_cleanup_required'],
  repair: ['repair', 'repairProvisioning'],
  rotate: ['rotate', 'rotateProvisioning'],
  revoke: ['revoke', 'revokeProvisioning'],
  finalizeProvisioning: ['finalizeProvisioning', 'finalize', 'finalize_provisioning'],
  completeExternalCleanup: ['completeExternalCleanup', 'complete_external_cleanup'],
});
const PUBLIC_BINDING_STATES = new Set([
  'active', 'missing', 'pending', 'provisioning', 'replacement_pending',
  'revoked', 'failed', 'unknown', 'manual_setup_required', 'degraded',
]);
const PUBLIC_RECEIPT_STATES = new Set(['pending', 'accepted', 'missing', 'unknown']);
const PUBLIC_RECONCILIATION_STATES = new Set(['pending', 'reconciled', 'current', 'failed', 'unknown']);
const PUBLIC_FRAME_STATES = new Set(['pending', 'queued', 'running', 'current', 'failed', 'unknown']);
const PUBLIC_QUEUE_STATES = new Set(['pending', 'queued', 'empty', 'current', 'failed', 'unknown']);
const PUBLIC_CRIT_STATES = new Set(['not_requested', 'pending', 'queued', 'running', 'completed', 'failed', 'unknown']);
const PUBLIC_LIFECYCLE_STATES = new Set([
  'active', 'missing', 'provisioning', 'replacement_pending', 'revoked',
  'configured', 'already_configured',
  'repairing', 'repair_not_available', 'manual_setup_required',
  'confirmation_required', 'cleanup_required', 'cleanup_status_unavailable',
  'degraded', 'failed', 'unknown',
]);
const UUID_V4ISH = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function publicProvider(value) {
  return typeof value === 'string' && DEPLOYMENT_PROVIDER_SET.has(value) ? value : undefined;
}

function projectRootForDeployment(config = {}) {
  if (typeof config.projectRoot === 'string' && config.projectRoot.trim()) return config.projectRoot;
  const feedbackDir = typeof config.feedbackDir === 'string' ? config.feedbackDir : '';
  return feedbackDir.endsWith('/.feedback') ? feedbackDir.slice(0, -'.feedback'.length) : process.cwd();
}

function candidateProviderIds(candidates) {
  if (!Array.isArray(candidates)) return [];
  return [...new Set(candidates
    .map((candidate) => typeof candidate === 'string' ? candidate : candidate?.provider ?? candidate?.id)
    .filter((provider) => publicProvider(provider)))];
}

function publicCandidateList(candidates) {
  return candidateProviderIds(candidates).map((provider) => ({ provider }));
}

function selectedProviderCandidate(candidates, provider) {
  if (!Array.isArray(candidates) || !provider) return null;
  return candidates.find((candidate) => (
    (typeof candidate === 'string' ? candidate : candidate?.provider ?? candidate?.id) === provider
  )) || null;
}

function privateProviderMetadata(candidate) {
  const metadata = isPlainObject(candidate?.metadata) ? candidate.metadata : {};
  const output = {};
  for (const [target, keys] of Object.entries({
    projectId: ['projectId', 'project_id', 'siteId', 'site_id'],
    orgId: ['orgId', 'org_id', 'teamId', 'team_id'],
    resourceId: ['resourceId', 'resource_id', 'serviceId', 'service_id'],
    repository: ['repository', 'repo'],
  })) {
    const value = keys.map((key) => internalProviderIdentifier(metadata[key])).find(Boolean);
    if (value) output[target] = value;
  }
  return output;
}

function isLocalOrPrivateOriginHost(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  // IPv6 prefix checks apply only to IPv6 literals. Without the colon gate,
  // ordinary public DNS names such as fda.gov were silently discarded.
  if (host === '::1' || (host.includes(':') && (
    host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe8')
  ))) return true;
  const octets = host.split('.').map((part) => Number(part));
  if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return octets[0] === 0 || octets[0] === 10 || octets[0] === 127 ||
    (octets[0] === 169 && octets[1] === 254) ||
    (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
    (octets[0] === 192 && octets[1] === 168);
}

// A configured URL is not automatically production evidence. The lifecycle
// accepts only normalized public HTTPS origins, derived from the owner's own
// project registration; adapters may not replace or infer this identity.
function canonicalProductionOrigins(urls) {
  const origins = new Set();
  for (const value of Array.isArray(urls) ? urls : []) {
    try {
      const parsed = new URL(String(value));
      if (parsed.protocol !== 'https:' || isLocalOrPrivateOriginHost(parsed.hostname)) continue;
      origins.add(parsed.origin.toLowerCase());
    } catch { /* configured URL normalization already handles user feedback */ }
  }
  return [...origins].sort();
}

async function configuredCanonicalProductionOrigins(config, projectId) {
  const feedbackDir = typeof config.feedbackDir === 'string' ? config.feedbackDir : '';
  const ownerProjectId = internalProviderIdentifier(projectId);
  if (!feedbackDir || !ownerProjectId) return [];
  try {
    const projects = JSON.parse(await readFile(join(feedbackDir, 'projects.json'), 'utf8'));
    const urls = isPlainObject(projects?.[ownerProjectId]) ? projects[ownerProjectId].urls : [];
    return canonicalProductionOrigins(urls);
  } catch {
    return [];
  }
}

function privateReceiverHandoff(value, projectId) {
  if (!isPlainObject(value)) return null;
  const deployHookId = internalProviderIdentifier(value.deployHookId ?? value.deploy_hook_id) || `dhk_${projectId}`;
  const receiverEndpoint = typeof (value.receiverEndpoint ?? value.endpointUrl ?? value.endpoint_url) === 'string'
    ? (value.receiverEndpoint ?? value.endpointUrl ?? value.endpoint_url).trim()
    : '';
  if (!receiverEndpoint) return { deployHookId };
  try {
    const parsed = new URL(receiverEndpoint);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.pathname.includes('/deploy-hook/')) return null;
    return { deployHookId, receiverEndpoint: parsed.toString() };
  } catch {
    return null;
  }
}

/**
 * Create or retrieve the legacy receiver only inside an owner-consented auto
 * setup. The token is intentionally consumed in this function and never added
 * to an MCP result or adapter ensure context. A host must explicitly inject
 * the private handoff factory; core never fetches or reconstructs bearer
 * receiver material on its own.
 */
async function prepareOwnerDeploymentReceiver(config, { projectId, provider }) {
  const factory = config.createDeploymentReceiverHandoff || config.createOwnerDeploymentReceiverHandoff;
  if (typeof factory === 'function') {
    try {
      const value = await factory({
        projectId,
        provider,
        deploymentAutomation: 'auto',
        ownerConsent: true,
        ownerAuthorized: true,
        writesAllowed: true,
      });
      return privateReceiverHandoff(value, projectId);
    } catch {
      return null;
    }
  }

  return null;
}

async function detectDeploymentCandidates(config, projectRoot) {
  const detect = config.detectDeploymentProviders || detectDeploymentProvidersFromRegistry;
  try {
    const candidates = await detect({ cwd: projectRoot, gitRemote: config.gitRemote });
    return Array.isArray(candidates) ? candidates : [];
  } catch {
    return [];
  }
}

function manualDeploymentResult({ requested, provider, selection, candidates }) {
  const ids = candidateProviderIds(candidates);
  if (selection?.status === 'ambiguous_provider') {
    return {
      requested: requested === true,
      status: 'ambiguous_provider',
      verification: 'candidate_detection',
      writesPerformed: false,
      ownerAuthorizationRequired: true,
      candidates: ids,
    };
  }
  if (!provider) {
    const summary = buildManualSetupSummary('unknown');
    return {
      ...redactProviderResult({
        requested: requested === true,
        provider: 'unknown',
        status: 'unsupported_provider_api',
        verification: 'candidate_detection',
        writesPerformed: false,
        ownerAuthorizationRequired: true,
        manualSetupSummary: summary,
      }),
      candidates: ids,
    };
  }
  const summary = buildManualSetupSummary(provider);
  return redactProviderResult({
    requested: requested === true,
    provider,
    ...summary,
    manualSetupSummary: summary,
  });
}

function redactedOwnerSetupReference({ provider, canonicalOrigins }) {
  if (!provider) return undefined;
  return {
    provider,
    productionEnvironment: 'production',
    canonicalOrigins: Array.isArray(canonicalOrigins) ? canonicalOrigins : [],
    recipe: {
      eventScope: 'project',
      delivery: 'An owner must use the private setup channel to obtain receiver material before configuring this provider.',
      approvalBoundary: 'This reference does not authorize source or CI changes; obtain separate owner approval before making those changes.',
    },
  };
}

function withRedactedOwnerSetupReference(result, reference) {
  return reference ? { ...result, setupHandoff: reference } : result;
}

function withManualOwnerSetupReference(result, { provider, canonicalOrigins }) {
  if (!isPlainObject(result) || !['manual_setup_required', 'unsupported_provider_api'].includes(result.status)) {
    return result;
  }
  return withRedactedOwnerSetupReference(result, redactedOwnerSetupReference({ provider, canonicalOrigins }));
}

function publicDeploymentResult(result, fallback) {
  const redacted = redactProviderResult(result);
  return Object.keys(redacted).length ? redacted : fallback;
}

const PRIVATE_PROVIDER_FACT_RE = /^[A-Za-z0-9][A-Za-z0-9._:@/+\-=]{0,511}$/;
const PRIVATE_PROVIDER_WEBHOOK_RE = /^[A-Za-z0-9][A-Za-z0-9._:@+\-=]{0,511}$/;
const PRIVATE_PROVIDER_FACT_SENSITIVE_RE = /(?:token|secret|credential|password|bearer|dhk_)/i;
const PRIVATE_EVENT_TYPE_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PRIVATE_REPAIR_OUTCOMES = new Set([
  'provider_resource_absent',
  'provider_resource_deleted',
  'provider_scope_absent',
]);
const CALLER_SECRET_PROVIDER_READBACK_MAX_AGE_MS = 5 * 60 * 1000;
const PRIVATE_CALLER_SECRET_PROVIDER_READBACKS = new WeakMap();

function privateProviderFact(value, { webhook = false } = {}) {
  const normalized = internalProviderIdentifier(value);
  const expression = webhook ? PRIVATE_PROVIDER_WEBHOOK_RE : PRIVATE_PROVIDER_FACT_RE;
  if (!normalized || !expression.test(normalized) || normalized.includes('://') || PRIVATE_PROVIDER_FACT_SENSITIVE_RE.test(normalized)) {
    return undefined;
  }
  return normalized;
}

function callerSecretReadbackContext(context = {}) {
  const projectId = internalProviderIdentifier(context.projectId);
  const bindingId = internalProviderIdentifier(context.bindingId);
  const attemptId = internalProviderIdentifier(context.attemptId);
  const provider = publicProvider(context.provider);
  return projectId && bindingId && attemptId && provider
    ? { projectId, bindingId, attemptId, provider }
    : null;
}

function callerSecretProviderReadbackFacts(value, { now = Date.now() } = {}) {
  if (!isPlainObject(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
  const keys = Object.keys(value).sort();
  const outcome = value.outcome;
  const observedAt = value.observedAt;
  if (typeof observedAt !== 'string' || observedAt !== observedAt.trim() || !observedAt) return null;
  const observedAtMs = Date.parse(observedAt);
  if (Number.isNaN(observedAtMs) || Math.abs(now - observedAtMs) > CALLER_SECRET_PROVIDER_READBACK_MAX_AGE_MS) return null;
  const providerWebhookId = privateProviderFact(value.providerWebhookId, { webhook: true });
  if (outcome === 'exact_existing') {
    if (keys.length !== 3 || keys.join(',') !== 'observedAt,outcome,providerWebhookId' || !providerWebhookId) return null;
    return { outcome, providerWebhookId, observedAt };
  }
  if (outcome === 'absent') {
    if (keys.length !== 2 || keys.join(',') !== 'observedAt,outcome' || providerWebhookId !== undefined) return null;
    return { outcome, observedAt };
  }
  return null;
}

// Provider readback is a trusted adapter attestation, not a provider-signed
// object. Its opaque WeakMap backing keeps it out of MCP-shaped JSON and binds
// it to the factory's fixed owner lifecycle identity. A JSON clone, a proof
// minted for another attempt, or a raw object passed by an MCP caller fails
// before any owner lifecycle request is issued.
function mintCallerSecretProviderReadback(value, context) {
  const identity = callerSecretReadbackContext(context);
  const facts = callerSecretProviderReadbackFacts(value);
  if (!identity || !facts) return null;
  const proof = Object.freeze(Object.create(null));
  PRIVATE_CALLER_SECRET_PROVIDER_READBACKS.set(proof, { identity, facts });
  return proof;
}

function sealedCallerSecretProviderReadback(proof, context) {
  const sealed = proof && typeof proof === 'object'
    ? PRIVATE_CALLER_SECRET_PROVIDER_READBACKS.get(proof)
    : null;
  const identity = callerSecretReadbackContext(context);
  if (!sealed || !identity ||
    sealed.identity.projectId !== identity.projectId ||
    sealed.identity.bindingId !== identity.bindingId ||
    sealed.identity.attemptId !== identity.attemptId ||
    sealed.identity.provider !== identity.provider) return null;
  // Freshness is checked again at use time, not just when the adapter minted
  // the in-memory proof, so a delayed callback cannot replay stale absence.
  return callerSecretProviderReadbackFacts(sealed.facts);
}

function exactProviderFinalization(payload, context) {
  if (!isPlainObject(payload)) return null;
  const projectId = internalProviderIdentifier(context.projectId);
  const bindingId = internalProviderIdentifier(context.bindingId);
  const attemptId = internalProviderIdentifier(context.attemptId);
  const provider = publicProvider(context.provider);
  const providerReadBackAt = typeof (payload.providerReadBackAt ?? payload.provider_read_back_at) === 'string'
    ? (payload.providerReadBackAt ?? payload.provider_read_back_at)
    : '';
  const providerWebhookId = privateProviderFact(payload.providerWebhookId ?? payload.provider_webhook_id, { webhook: true });
  const replacesProviderWebhookId = privateProviderFact(
    payload.replacesProviderWebhookId ?? payload.replaces_provider_webhook_id,
    { webhook: true },
  );
  const providerAccountId = privateProviderFact(payload.providerAccountId ?? payload.provider_account_id);
  const providerProjectId = privateProviderFact(payload.providerProjectId ?? payload.provider_project_id);
  const providerResourceId = privateProviderFact(payload.providerResourceId ?? payload.provider_resource_id);
  const providerRepository = privateProviderFact(payload.providerRepository ?? payload.provider_repository);
  const productionEnvironment = payload.productionEnvironment ?? payload.production_environment;
  const eventType = payload.eventType ?? payload.event_type;
  const eventScope = payload.eventScope ?? payload.event_scope;
  const canonicalOrigins = Array.isArray(context.canonicalOrigins) ? context.canonicalOrigins : [];

  // The adapter must supply fresh provider facts. Core contributes only the
  // owner-configured canonical origins and immutable owner lifecycle IDs.
  if (!projectId || !bindingId || !attemptId || !provider ||
    !providerReadBackAt || providerReadBackAt !== providerReadBackAt.trim() || Number.isNaN(Date.parse(providerReadBackAt)) ||
    !providerWebhookId || providerWebhookId === replacesProviderWebhookId ||
    (!providerProjectId && !providerResourceId && !providerRepository) ||
    productionEnvironment !== 'production' || eventScope !== 'project' ||
    typeof eventType !== 'string' || !PRIVATE_EVENT_TYPE_RE.test(eventType) ||
    canonicalOrigins.length === 0) return null;

  return {
    projectId,
    bindingId,
    attemptId,
    provider,
    providerReadBackAt,
    providerWebhookId,
    ...(replacesProviderWebhookId ? { replacesProviderWebhookId } : {}),
    ...(providerAccountId ? { providerAccountId } : {}),
    ...(providerProjectId ? { providerProjectId } : {}),
    ...(providerResourceId ? { providerResourceId } : {}),
    ...(providerRepository ? { providerRepository } : {}),
    productionEnvironment,
    canonicalOrigins,
    eventType,
    eventScope,
  };
}

function ownerLifecycleResult(response) {
  if (!response?.ok) return { ok: false, state: 'degraded' };
  return response.json()
    .then((body) => isPlainObject(body) ? body : { ok: false, state: 'degraded' })
    .catch(() => ({ ok: false, state: 'degraded' }));
}

// This is the concrete runtime client for the owner-keyed sync-annotations
// lifecycle. It is intentionally opt-in at the embedding boundary: tests and
// offline callers retain the injectable seam, while server.js explicitly
// enables it. No provider API is called by this client.
function createOwnerDeploymentLifecycle(config) {
  if (config.enableDeploymentLifecycle !== true) return null;
  const licenseKey = typeof config.licenseKey === 'string' ? config.licenseKey.trim() : '';
  const supabaseBase = typeof config.supabaseBase === 'string' && config.supabaseBase.trim()
    ? config.supabaseBase.replace(/\/$/, '')
    : '';
  const fetchImpl = config.fetchImpl || globalThis.fetch;
  if (!licenseKey || !supabaseBase || typeof fetchImpl !== 'function') return null;

  const request = async (body) => {
    try {
      const response = await fetchImpl(`${supabaseBase}/sync-annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-license-key': licenseKey },
        body: JSON.stringify(body),
      });
      return await ownerLifecycleResult(response);
    } catch {
      return { ok: false, state: 'degraded' };
    }
  };
  const bindingInput = (payload = {}, { withAttempt = false } = {}) => {
    const projectId = internalProviderIdentifier(payload.projectId ?? payload.project_id);
    const bindingId = internalProviderIdentifier(payload.bindingId ?? payload.binding_id);
    const provider = publicProvider(payload.provider ?? payload.deploymentProvider);
    const attemptId = internalProviderIdentifier(payload.attemptId ?? payload.attempt_id);
    if (!projectId || !bindingId || !provider || (withAttempt && !attemptId)) return null;
    return { projectId, bindingId, provider, ...(withAttempt ? { attemptId } : {}) };
  };
  const idempotencyKey = (value) => {
    const key = typeof value === 'string' ? value : '';
    return key.length >= 8 && key.length <= 200 && !/[\u0000-\u001f\u007f]/.test(key) ? key : undefined;
  };

  return {
    // toolConfigureProject uses this marker to bootstrap the receiver before
    // begin. A successful begin is the owner-only admission proof for the one
    // immediate setup handoff; later tools never receive that material.
    requiresReceiverBootstrap: true,
    begin: async (payload = {}) => {
      const projectId = internalProviderIdentifier(payload.projectId ?? payload.project_id);
      const provider = publicProvider(payload.provider ?? payload.deploymentProvider);
      const deployHookId = internalProviderIdentifier(payload.deployHookId ?? payload.deploy_hook_id);
      const key = idempotencyKey(payload.idempotencyKey ?? payload.idempotency_key);
      if (!projectId || !provider || !deployHookId || !key) return { ok: false, state: 'degraded' };
      return request({ action: 'deployment_provider_begin', projectId, provider, deployHookId, idempotencyKey: key });
    },
    getBinding: async (payload = {}) => {
      const projectId = internalProviderIdentifier(payload.projectId ?? payload.project_id);
      const provider = publicProvider(payload.provider ?? payload.deploymentProvider);
      if (!projectId || !provider) return { ok: false, state: 'degraded' };
      return request({ action: 'deployment_provider_get_binding', projectId, provider });
    },
    uploadCredential: async (payload = {}) => {
      const binding = bindingInput(payload, { withAttempt: true });
      const providerWebhookId = privateProviderFact(payload.providerWebhookId ?? payload.provider_webhook_id, { webhook: true });
      const replacesProviderWebhookId = privateProviderFact(
        payload.replacesProviderWebhookId ?? payload.replaces_provider_webhook_id,
        { webhook: true },
      );
      const credential = typeof payload.credential === 'string' ? payload.credential : '';
      if (!binding || !providerWebhookId || !credential || providerWebhookId === replacesProviderWebhookId) {
        return { ok: false, state: 'degraded' };
      }
      return request({
        action: 'deployment_provider_upload_credential',
        ...binding,
        providerWebhookId,
        ...(replacesProviderWebhookId ? { replacesProviderWebhookId } : {}),
        credential,
      });
    },
    // Caller-generated webhook secrets need a durable encrypted reservation
    // before an adapter POSTs to a provider. This method is reachable only
    // through the injected provider-adapter callbacks below; no MCP tool
    // exposes the caller secret, reservation identity, or provider resource.
    reserveCredential: async (payload = {}) => {
      const binding = bindingInput(payload, { withAttempt: true });
      const credential = typeof payload.credential === 'string'
        ? payload.credential
        : typeof payload.callerGeneratedCredential === 'string'
        ? payload.callerGeneratedCredential
        : '';
      if (!binding || !credential) return { ok: false, state: 'degraded' };
      return request({
        action: 'deployment_provider_reserve_credential',
        ...binding,
        credential,
      });
    },
    bindReservedCredential: async (payload = {}) => {
      const binding = bindingInput(payload, { withAttempt: true });
      const providerWebhookId = privateProviderFact(payload.providerWebhookId ?? payload.provider_webhook_id, { webhook: true });
      const replacesProviderWebhookId = privateProviderFact(
        payload.replacesProviderWebhookId ?? payload.replaces_provider_webhook_id,
        { webhook: true },
      );
      if (!binding || !providerWebhookId || providerWebhookId === replacesProviderWebhookId) {
        return { ok: false, state: 'degraded' };
      }
      return request({
        action: 'deployment_provider_bind_reserved_credential',
        ...binding,
        providerWebhookId,
        ...(replacesProviderWebhookId ? { replacesProviderWebhookId } : {}),
      });
    },
    recoverReservedCredential: async (payload = {}) => {
      const binding = bindingInput(payload, { withAttempt: true });
      const providerReadback = callerSecretProviderReadbackFacts(payload.providerReadback);
      if (!binding || !providerReadback) return { ok: false, state: 'degraded' };
      return request({
        action: 'deployment_provider_recover_reserved_credential',
        ...binding,
        providerReadback,
      });
    },
    markReservedCredentialWriteStarted: async (payload = {}) => {
      const binding = bindingInput(payload, { withAttempt: true });
      if (!binding) return { ok: false, state: 'degraded' };
      return request({
        action: 'deployment_provider_mark_reserved_credential_write_started',
        ...binding,
      });
    },
    finalizeProvisioning: async (payload = {}) => {
      const finalization = exactProviderFinalization(payload, payload);
      if (!finalization) return { ok: false, state: 'degraded' };
      return request({ action: 'deployment_provider_finalize', ...finalization });
    },
    markDegraded: async (payload = {}) => {
      const binding = bindingInput(payload, { withAttempt: true });
      const providerWebhookId = privateProviderFact(payload.providerWebhookId ?? payload.provider_webhook_id, { webhook: true });
      const replacesProviderWebhookId = privateProviderFact(
        payload.replacesProviderWebhookId ?? payload.replaces_provider_webhook_id,
        { webhook: true },
      );
      const errorCode = typeof (payload.errorCode ?? payload.error_code) === 'string'
        ? (payload.errorCode ?? payload.error_code).trim()
        : '';
      if (!binding || !errorCode || providerWebhookId === replacesProviderWebhookId) return { ok: false, state: 'degraded' };
      return request({
        action: 'deployment_provider_mark_degraded',
        ...binding,
        ...(providerWebhookId ? { providerWebhookId } : {}),
        ...(replacesProviderWebhookId ? { replacesProviderWebhookId } : {}),
        errorCode,
      });
    },
    markCleanupRequired: async (payload = {}) => {
      const binding = bindingInput(payload, { withAttempt: true });
      const providerWebhookId = privateProviderFact(payload.providerWebhookId ?? payload.provider_webhook_id, { webhook: true });
      const replacesProviderWebhookId = privateProviderFact(
        payload.replacesProviderWebhookId ?? payload.replaces_provider_webhook_id,
        { webhook: true },
      );
      if (!binding || !providerWebhookId || !replacesProviderWebhookId || providerWebhookId === replacesProviderWebhookId) {
        return { ok: false, state: 'degraded' };
      }
      return request({
        action: 'deployment_provider_cleanup_required',
        ...binding,
        providerWebhookId,
        replacesProviderWebhookId,
        errorCode: 'old_provider_webhook_cleanup_required',
      });
    },
    completeExternalCleanup: async (payload = {}) => {
      const binding = bindingInput(payload);
      const cleanupDebtId = durableCleanupDebt(payload);
      const providerReadBackAt = typeof (payload.providerReadBackAt ?? payload.provider_read_back_at) === 'string'
        ? (payload.providerReadBackAt ?? payload.provider_read_back_at)
        : '';
      const cleanupTargetProviderWebhookId = privateProviderFact(
        payload.cleanupTargetProviderWebhookId ?? payload.cleanup_target_provider_webhook_id,
        { webhook: true },
      );
      const activeProviderWebhookId = privateProviderFact(
        payload.activeProviderWebhookId ?? payload.active_provider_webhook_id,
        { webhook: true },
      );
      const providerReadBackOutcome = payload.providerReadBackOutcome ?? payload.provider_read_back_outcome;
      if (!binding || !cleanupDebtId || !providerReadBackAt || providerReadBackAt !== providerReadBackAt.trim() ||
        Number.isNaN(Date.parse(providerReadBackAt)) || !cleanupTargetProviderWebhookId ||
        !['target_absent', 'target_absent_retained_present'].includes(providerReadBackOutcome) ||
        cleanupTargetProviderWebhookId === activeProviderWebhookId) return { ok: false, state: 'degraded' };
      return request({
        action: 'deployment_provider_cleanup_completed',
        ...binding,
        cleanupDebtId,
        providerReadBackAt,
        cleanupTargetProviderWebhookId,
        ...(activeProviderWebhookId ? { activeProviderWebhookId } : {}),
        providerReadBackOutcome,
      });
    },
    getCleanup: async (payload = {}) => {
      const binding = bindingInput(payload);
      return binding ? request({ action: 'deployment_provider_get_cleanup', ...binding }) : { ok: false, state: 'degraded' };
    },
    getActive: async (payload = {}) => {
      const binding = bindingInput(payload);
      return binding ? request({ action: 'deployment_provider_get_active', ...binding }) : { ok: false, state: 'degraded' };
    },
    getRepair: async (payload = {}) => {
      const binding = bindingInput(payload);
      return binding ? request({ action: 'deployment_provider_get_repair', ...binding }) : { ok: false, state: 'degraded' };
    },
    inspect: async (payload = {}) => {
      const direct = bindingInput(payload);
      if (direct) return request({ action: 'deployment_provider_get_active', ...direct });
      const projectId = internalProviderIdentifier(payload.projectId ?? payload.project_id);
      const provider = publicProvider(payload.provider ?? payload.deploymentProvider);
      if (!projectId || !provider) return { ok: false, state: 'manual_setup_required' };
      const binding = await request({ action: 'deployment_provider_get_binding', projectId, provider });
      const bindingId = internalProviderIdentifier(binding.bindingId ?? binding.binding_id);
      if (binding.ok !== true || binding.found !== true || !bindingId) return { ok: false, state: 'manual_setup_required' };
      return request({ action: 'deployment_provider_get_active', projectId, provider, bindingId });
    },
    repair: async (payload = {}) => {
      // The adapter supplies the provider's exact absence/deletion readback;
      // this client only forwards a fully validated private completion record.
      // A bare owner request must never retire an orphaned attempt on its own.
      const completion = exactRepairCompletion(payload, payload);
      if (payload.confirmed !== true || !completion) return { ok: false, state: 'repair_not_available' };
      return request({ action: 'deployment_provider_repair', ...completion, confirmed: true });
    },
    rotate: async (payload = {}) => {
      const binding = bindingInput(payload);
      const key = idempotencyKey(payload.idempotencyKey ?? payload.idempotency_key) ||
        (binding ? `mcp-rotate:${binding.bindingId}` : undefined);
      if (!binding || payload.confirmed !== true || !key) return { ok: false, state: 'degraded' };
      return request({ action: 'deployment_provider_rotate', ...binding, confirmed: true, idempotencyKey: key });
    },
    revoke: async (payload = {}) => {
      const binding = bindingInput(payload);
      if (!binding || payload.confirmed !== true) return { ok: false, state: 'degraded' };
      return request({ action: 'deployment_provider_revoke', ...binding, confirmed: true, errorCode: 'owner_revoked' });
    },
  };
}

async function resolveDeploymentLifecycle(config, context = {}) {
  if (isPlainObject(config.deploymentLifecycle)) return config.deploymentLifecycle;
  if (typeof config.createDeploymentLifecycle === 'function') {
    try {
      const lifecycle = await config.createDeploymentLifecycle(context);
      return isPlainObject(lifecycle) ? lifecycle : null;
    } catch {
      return null;
    }
  }
  return createOwnerDeploymentLifecycle(config, context);
}

async function callDeploymentLifecycle(config, action, payload = {}, lifecycle = null) {
  const resolved = lifecycle || await resolveDeploymentLifecycle(config, payload);
  if (!resolved) return { available: false, value: null };
  const method = (LIFECYCLE_METHODS[action] || []).find((name) => typeof resolved[name] === 'function');
  try {
    if (method) return { available: true, value: await resolved[method](payload) };
    if (typeof resolved.call === 'function') return { available: true, value: await resolved.call(action, payload) };
    if (typeof resolved.invoke === 'function') return { available: true, value: await resolved.invoke(action, payload) };
  } catch {
    return { available: true, value: { ok: false, state: 'degraded' } };
  }
  return { available: false, value: null };
}

function lifecycleIdentifiers(value) {
  if (!isPlainObject(value)) return { bindingId: undefined, attemptId: undefined };
  const bindingId = typeof (value.bindingId ?? value.binding_id) === 'string'
    ? (value.bindingId ?? value.binding_id).trim() || undefined
    : undefined;
  const attemptId = typeof (value.attemptId ?? value.attempt_id) === 'string'
    ? (value.attemptId ?? value.attempt_id).trim() || undefined
    : undefined;
  return { bindingId, attemptId };
}

function lifecycleBeginAuthorized(value) {
  if (!isPlainObject(value) || value.ok === false || value.authorized === false || value.ownerAuthorized === false) return false;
  const { bindingId, attemptId } = lifecycleIdentifiers(value);
  return Boolean(bindingId && attemptId);
}

// A lifecycle adapter may omit `ok` for backwards compatibility, but an
// explicit failure (or a public failure state) can never authorize a provider
// mutation. Keep this separate from `lifecycleBeginAuthorized`: rotate has
// different required identifiers and revoke is followed by a fresh debt read.
function lifecycleActionSucceeded(value) {
  if (!isPlainObject(value) || value.ok === false || value.authorized === false || value.ownerAuthorized === false) {
    return false;
  }
  const state = typeof (value.state ?? value.status) === 'string'
    ? String(value.state ?? value.status).trim().toLowerCase()
    : '';
  return ![
    'degraded', 'failed', 'unknown', 'manual_setup_required',
    'cleanup_required', 'cleanup_status_unavailable',
    'repair_not_available', 'confirmation_required',
  ].includes(state);
}

function durableCleanupDebt(value) {
  if (!isPlainObject(value)) return undefined;
  const cleanupDebtId = value.cleanupDebtId ?? value.cleanup_debt_id;
  return typeof cleanupDebtId === 'string' && UUID_V4ISH.test(cleanupDebtId.trim()) ? cleanupDebtId.trim() : undefined;
}

function internalProviderIdentifier(value) {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  // Provider resource identifiers are intentionally allowed through this
  // private boundary only. They are never copied into an MCP response.
  return normalized && normalized.length <= 512 ? normalized : undefined;
}

function cleanupKind(value) {
  return value === 'rotation' || value === 'revocation' ? value : undefined;
}

function exactRepairCompletion(payload, context) {
  if (!isPlainObject(payload)) return null;
  const projectId = internalProviderIdentifier(context.projectId);
  const bindingId = internalProviderIdentifier(context.bindingId);
  const attemptId = internalProviderIdentifier(context.attemptId);
  const provider = publicProvider(context.provider);
  const providerReadBackAt = typeof (payload.providerReadBackAt ?? payload.provider_read_back_at) === 'string'
    ? (payload.providerReadBackAt ?? payload.provider_read_back_at)
    : '';
  const repairOutcome = payload.repairOutcome ?? payload.repair_outcome;
  const providerWebhookId = privateProviderFact(
    payload.providerWebhookId ?? payload.provider_webhook_id,
    { webhook: true },
  );
  const replacesProviderWebhookId = privateProviderFact(
    payload.replacesProviderWebhookId ?? payload.replaces_provider_webhook_id,
    { webhook: true },
  );
  const payloadProjectId = internalProviderIdentifier(payload.projectId ?? payload.project_id);
  const payloadBindingId = internalProviderIdentifier(payload.bindingId ?? payload.binding_id);
  const payloadAttemptId = internalProviderIdentifier(payload.attemptId ?? payload.attempt_id);
  const payloadProvider = publicProvider(payload.provider);

  // Do not synthesize an absence/deletion proof from an adapter status. The
  // provider's exact readback timestamp and disposition must survive unchanged
  // through the owner RPC, and any adapter-supplied ownership IDs must agree
  // with the lifecycle's already-resolved attempt.
  if (!projectId || !bindingId || !attemptId || !provider ||
    !providerReadBackAt || providerReadBackAt !== providerReadBackAt.trim() || Number.isNaN(Date.parse(providerReadBackAt)) ||
    !PRIVATE_REPAIR_OUTCOMES.has(repairOutcome) ||
    (repairOutcome === 'provider_scope_absent' && providerWebhookId !== undefined) ||
    (repairOutcome !== 'provider_scope_absent' && !providerWebhookId) ||
    (providerWebhookId && providerWebhookId === replacesProviderWebhookId) ||
    (payloadProjectId && payloadProjectId !== projectId) ||
    (payloadBindingId && payloadBindingId !== bindingId) ||
    (payloadAttemptId && payloadAttemptId !== attemptId) ||
    (payloadProvider && payloadProvider !== provider)) return null;

  return {
    projectId,
    bindingId,
    attemptId,
    provider,
    providerReadBackAt,
    repairOutcome,
    ...(providerWebhookId ? { providerWebhookId } : {}),
    ...(replacesProviderWebhookId ? { replacesProviderWebhookId } : {}),
  };
}

function exactCleanupCompletion(payload, context) {
  if (!isPlainObject(payload)) return null;
  const cleanupDebtId = durableCleanupDebt(payload);
  // Do not normalize this timestamp. It is the adapter's exact provider
  // readback evidence; changing it would turn a retry into a false claim of a
  // newer provider observation. Whitespace is rejected rather than trimmed.
  const providerReadBackAt = typeof payload.providerReadBackAt === 'string'
    ? payload.providerReadBackAt
    : typeof payload.provider_read_back_at === 'string'
      ? payload.provider_read_back_at
      : '';
  const providerReadBackOutcome = payload.providerReadBackOutcome ?? payload.provider_read_back_outcome;
  const activeProviderWebhookId = internalProviderIdentifier(
    payload.activeProviderWebhookId ?? payload.active_provider_webhook_id,
  );
  const cleanupTargetProviderWebhookId = internalProviderIdentifier(
    payload.cleanupTargetProviderWebhookId ?? payload.cleanup_target_provider_webhook_id,
  );
  const bindingId = internalProviderIdentifier(context.bindingId);
  const projectId = internalProviderIdentifier(context.projectId);
  const provider = publicProvider(context.provider);
  const payloadBindingId = internalProviderIdentifier(payload.bindingId ?? payload.binding_id);
  const payloadProjectId = internalProviderIdentifier(payload.projectId ?? payload.project_id);
  const payloadProvider = publicProvider(payload.provider);
  const resolvedCleanupKind = cleanupKind(context.cleanupKind) || (activeProviderWebhookId ? 'rotation' : undefined);
  const completesRotation = resolvedCleanupKind === 'rotation';
  const completesRevocation = resolvedCleanupKind === 'revocation';

  // The adapter owns the provider readback. Core verifies its shape but
  // preserves its original timestamp string exactly; inventing a later time
  // would falsely imply a fresh absence proof on a retry.
  if (!cleanupDebtId || !bindingId || !projectId || !provider || !resolvedCleanupKind ||
    !providerReadBackAt || providerReadBackAt !== providerReadBackAt.trim() || Number.isNaN(Date.parse(providerReadBackAt)) ||
    !cleanupTargetProviderWebhookId ||
    (completesRotation && (
      providerReadBackOutcome !== 'target_absent_retained_present' ||
      !activeProviderWebhookId ||
      activeProviderWebhookId === cleanupTargetProviderWebhookId
    )) ||
    (completesRevocation && (
      providerReadBackOutcome !== 'target_absent' ||
      activeProviderWebhookId !== undefined
    )) ||
    (payloadBindingId && payloadBindingId !== bindingId) ||
    (payloadProjectId && payloadProjectId !== projectId) ||
    (payloadProvider && payloadProvider !== provider)) return null;

  return {
    bindingId,
    projectId,
    provider,
    cleanupDebtId,
    cleanupTargetProviderWebhookId,
    ...(activeProviderWebhookId ? { activeProviderWebhookId } : {}),
    providerReadBackAt,
    providerReadBackOutcome,
  };
}

function lifecycleCallbacks(config, lifecycle, {
  projectId,
  bindingId,
  attemptId,
  provider,
  canonicalOrigins,
  deployHookId,
  cleanupKind: pendingCleanupKind,
} = {}) {
  // These callbacks are intentionally private to an injected provider adapter.
  // In particular, `completeExternalCleanup` will never issue a provider DELETE:
  // it only asks the owner-keyed lifecycle to complete a previously durable debt.
  const callerSecretIdentity = { projectId, bindingId, attemptId, provider };
  const mintPrivateReadback = (value) => mintCallerSecretProviderReadback(value, callerSecretIdentity);
  const reserveCallerGeneratedCredential = async (payload = {}) => {
    const credential = typeof payload.credential === 'string'
      ? payload.credential
      : typeof payload.callerGeneratedCredential === 'string'
        ? payload.callerGeneratedCredential
        : '';
    if (!credential) return { ok: false, state: 'degraded' };
    const result = await callDeploymentLifecycle(config, 'reserveCredential', {
      projectId,
      bindingId,
      attemptId,
      provider,
      credential,
    }, lifecycle);
    return result.available ? result.value : { ok: false, state: 'degraded' };
  };
  const bindReservedCredential = async (payload = {}) => {
    const providerWebhookId = privateProviderFact(payload.providerWebhookId ?? payload.provider_webhook_id, { webhook: true });
    const replacesProviderWebhookId = privateProviderFact(
      payload.replacesProviderWebhookId ?? payload.replaces_provider_webhook_id,
      { webhook: true },
    );
    if (!providerWebhookId || providerWebhookId === replacesProviderWebhookId) {
      return { ok: false, state: 'degraded' };
    }
    const result = await callDeploymentLifecycle(config, 'bindReservedCredential', {
      projectId,
      bindingId,
      attemptId,
      provider,
      providerWebhookId,
      ...(replacesProviderWebhookId ? { replacesProviderWebhookId } : {}),
    }, lifecycle);
    return result.available ? result.value : { ok: false, state: 'degraded' };
  };
  const markCallerGeneratedCredentialWriteStarted = async () => {
    const result = await callDeploymentLifecycle(config, 'markReservedCredentialWriteStarted', {
      projectId,
      bindingId,
      attemptId,
      provider,
    }, lifecycle);
    if (!result.available || !isPlainObject(result.value) || result.value.ok === false ||
      result.value.state !== 'external_write_started') {
      return { ok: false, state: 'degraded' };
    }
    // Defense in depth for a stale Edge deployment: an idempotent marker says
    // a prior process already crossed the external-write boundary. It is not
    // a replay-safe POST capability. Require the freshly committed false
    // receipt before exposing authorization to the admitted adapter.
    if (result.value.idempotent !== false) return { ok: false, state: 'repair_required' };
    return result.value;
  };
  const recoverCallerGeneratedCredential = async (payload = {}) => {
    const providerReadback = sealedCallerSecretProviderReadback(payload.providerReadback, callerSecretIdentity);
    if (!providerReadback) return { ok: false, state: 'degraded' };
    const recovered = await callDeploymentLifecycle(config, 'recoverReservedCredential', {
      projectId,
      bindingId,
      attemptId,
      provider,
      providerReadback,
    }, lifecycle);
    if (!recovered.available || !isPlainObject(recovered.value)) return { ok: false, state: 'degraded' };
    if (recovered.value.ok === false || recovered.value.state !== 'new_attempt_required') return recovered.value;

    // Exact provider absence closes the old envelope atomically. Re-enter the
    // original fixed setup key so Edge can resolve its durable absence receipt
    // to one linked child. That child has its own server-generated key and
    // receives a new secret; this never renews or transports the old custody.
    const idempotencyKey = `mcp-setup:${projectId}:${provider}`;
    if (idempotencyKey.length < 8 || idempotencyKey.length > 200) return { ok: false, state: 'degraded' };
    const nextBegin = await callDeploymentLifecycle(config, 'begin', {
      projectId,
      provider,
      ...(internalProviderIdentifier(deployHookId) ? { deployHookId: internalProviderIdentifier(deployHookId) } : {}),
      idempotencyKey,
      deploymentAutomation: 'auto',
      ownerConsent: true,
      ownerAuthorized: true,
      writesAllowed: true,
    }, lifecycle);
    if (!nextBegin.available || !lifecycleBeginAuthorized(nextBegin.value)) return { ok: false, state: 'degraded' };
    const next = lifecycleIdentifiers(nextBegin.value);
    if (!next.bindingId || !next.attemptId || next.attemptId === attemptId) return { ok: false, state: 'degraded' };
    const nextCallbacks = lifecycleCallbacks(config, lifecycle, {
      projectId,
      bindingId: next.bindingId,
      attemptId: next.attemptId,
      provider,
      canonicalOrigins,
      deployHookId,
      cleanupKind: pendingCleanupKind,
    });
    return {
      ok: true,
      state: 'new_attempt_ready',
      // This object is a private adapter capability. No IDs, credential, or
      // proof facts are serializable from it, and publicDeploymentResult drops
      // it before any MCP tool response is constructed.
      nextAttempt: Object.freeze(nextCallbacks),
    };
  };
  return {
    // GitHub/Netlify-style adapters call this before their provider create
    // request. The callback's return stays within the adapter boundary; the
    // eventual MCP-facing setup result is projected by publicDeploymentResult.
    mintCallerSecretProviderReadback: mintPrivateReadback,
    reserveCallerGeneratedCredential,
    markCallerGeneratedCredentialWriteStarted,
    recoverCallerGeneratedCredential,
    // This is deliberately separate from the provider-generated upload path:
    // a caller-secret is decrypted only by the Edge function after provider
    // create/read-back has supplied an exact non-secret webhook identifier.
    bindReservedCredential,
    captureProviderGeneratedCredential: async (payload = {}) => {
      const result = await callDeploymentLifecycle(config, 'uploadCredential', {
        ...payload,
        projectId,
        bindingId,
        attemptId,
        provider,
      }, lifecycle);
      return result.available ? result.value : { ok: false, state: 'degraded' };
    },
    finalizeProvisioning: async (payload = {}) => {
      const finalization = exactProviderFinalization(payload, {
        projectId,
        bindingId,
        attemptId,
        provider,
        canonicalOrigins,
      });
      // Missing provider readback facts are not a degraded success. In
      // particular, core never invents a project/resource ID, an event shape,
      // a readback timestamp, or an origin to make an adapter appear ready.
      if (!finalization) return { ok: false, state: 'degraded', reason: 'provider_binding_facts_required' };
      const result = await callDeploymentLifecycle(config, 'finalizeProvisioning', finalization, lifecycle);
      return result.available ? result.value : { ok: false, state: 'degraded' };
    },
    markAttemptDegraded: async (payload = {}) => {
      const result = await callDeploymentLifecycle(config, 'markDegraded', {
        ...payload,
        projectId,
        bindingId,
        attemptId,
        provider,
      }, lifecycle);
      return result.available ? result.value : { ok: false, state: 'degraded' };
    },
    // Compatibility for the previous Vercel adapter. New rotation paths use
    // `completeExternalCleanup`; legacy adapters can only record an already
    // durable cleanup requirement and never receive a delete capability here.
    markExternalCleanupRequired: async (payload = {}) => {
      const result = await callDeploymentLifecycle(config, 'markCleanupRequired', {
        ...payload,
        projectId,
        bindingId,
        attemptId,
        provider,
      }, lifecycle);
      return result.available ? result.value : { ok: false, state: 'degraded' };
    },
    hasUsableCredential: async (payload = {}) => {
      const result = await callDeploymentLifecycle(config, 'getActive', {
        ...payload,
        projectId,
        bindingId,
        provider,
      }, lifecycle);
      if (!result.available || !isPlainObject(result.value) || result.value.ok === false) return false;
      const expectedWebhookId = internalProviderIdentifier(payload.providerWebhookId ?? payload.provider_webhook_id);
      const activeWebhookId = internalProviderIdentifier(
        result.value.providerWebhookId ?? result.value.provider_webhook_id ?? result.value.webhookId,
      );
      return result.value.credentialUsable === true && (!expectedWebhookId || activeWebhookId === expectedWebhookId);
    },
    getAttemptOwnedWebhook: async (payload = {}) => {
      const result = await callDeploymentLifecycle(config, 'getRepair', {
        ...payload,
        projectId,
        bindingId,
        attemptId,
        provider,
      }, lifecycle);
      return result.available && isPlainObject(result.value) ? result.value : { ok: false };
    },
    getActiveBinding: async (payload = {}) => {
      const result = await callDeploymentLifecycle(config, 'getActive', {
        ...payload,
        projectId,
        bindingId,
        provider,
      }, lifecycle);
      return result.available && isPlainObject(result.value) ? result.value : { ok: false };
    },
    // This callback is intentionally invoked by the provider adapter itself
    // immediately before a cleanup DELETE. The prior MCP cleanup read is only
    // an authorization gate; it cannot substitute for a fresh owner-scoped
    // exact debt read at the adapter's destructive boundary.
    getCleanupDebt: async (payload = {}) => {
      const expectedDebtId = durableCleanupDebt(payload);
      const expectedActiveWebhookId = internalProviderIdentifier(
        payload.activeProviderWebhookId ?? payload.active_provider_webhook_id,
      );
      const expectedTargetWebhookId = internalProviderIdentifier(
        payload.cleanupTargetProviderWebhookId ?? payload.cleanup_target_provider_webhook_id,
      );
      const expectedKind = cleanupKind(payload.cleanupKind ?? payload.cleanup_kind);
      const result = await callDeploymentLifecycle(config, 'getCleanup', {
        projectId,
        bindingId,
        provider,
      }, lifecycle);
      const cleanup = result.available
        ? cleanupStateFromLifecycle(result.value, { projectId, bindingId, provider })
        : { known: false, pending: true };
      const exact = cleanup.known && cleanup.pending &&
        cleanup.bindingId === bindingId && cleanup.provider === provider &&
        cleanup.cleanupDebtId === expectedDebtId &&
        cleanup.cleanupTargetProviderWebhookId === expectedTargetWebhookId &&
        cleanup.activeProviderWebhookId === expectedActiveWebhookId &&
        (!expectedKind || cleanup.cleanupKind === expectedKind);
      if (!exact) return { ok: false, cleanupRequired: true };
      return {
        ok: true,
        cleanupRequired: true,
        bindingId,
        projectId,
        provider,
        cleanupDebtId: cleanup.cleanupDebtId,
        ...(cleanup.cleanupKind ? { cleanupKind: cleanup.cleanupKind } : {}),
        cleanupTargetProviderWebhookId: cleanup.cleanupTargetProviderWebhookId,
        ...(cleanup.activeProviderWebhookId ? { activeProviderWebhookId: cleanup.activeProviderWebhookId } : {}),
      };
    },
    completeExternalCleanup: async (payload = {}) => {
      const completion = exactCleanupCompletion(payload, {
        projectId,
        bindingId,
        provider,
        cleanupKind: pendingCleanupKind,
      });
      if (!completion) return { ok: false, reason: 'cleanup_debt_required' };
      const result = await callDeploymentLifecycle(config, 'completeExternalCleanup', completion, lifecycle);
      return result.available ? result.value : { ok: false, state: 'degraded' };
    },
  };
}

function admittedProviderWriterAvailable(config, provider) {
  const adapters = config.deploymentProviderAdapters || config.adapters;
  if (isPlainObject(adapters) && isPlainObject(adapters[provider]) && typeof adapters[provider].ensure === 'function') {
    return true;
  }
  return typeof config.createDeploymentProviderAdapter === 'function' ||
    typeof config.createDeploymentProviderAdapters === 'function';
}

async function withDetectedProviderActionContext(config, context = {}) {
  const provider = publicProvider(context.provider);
  if (!provider || internalProviderIdentifier(context.providerProjectId)) return context;
  const candidates = await detectDeploymentCandidates(config, projectRootForDeployment(config));
  const candidate = selectedProviderCandidate(candidates, provider);
  const providerMetadata = privateProviderMetadata(candidate);
  const providerProjectId = providerMetadata.projectId;
  if (!providerProjectId) return context;
  // This is read-only local detection. The provider ID is passed only to the
  // private adapter factory/action context; it is never projected to MCP.
  const canonicalOrigins = Array.isArray(context.canonicalOrigins)
    ? canonicalProductionOrigins(context.canonicalOrigins)
    : await configuredCanonicalProductionOrigins(config, context.projectId);
  return {
    ...context,
    providerCandidate: candidate,
    providerMetadata,
    providerProjectId,
    ...(canonicalOrigins.length ? { canonicalOrigins } : {}),
  };
}

function publicAdapterActionResponse(action, value, provider, fallback) {
  const redacted = publicDeploymentResult(value, {});
  if (!redacted.status) return fallback;
  const output = {
    action,
    ...(redacted.provider || publicProvider(provider) ? { provider: redacted.provider || publicProvider(provider) } : {}),
    status: redacted.status,
  };
  for (const key of [
    'verification',
    'firstProductionReceipt',
    'ingestionMode',
    'authenticationMethod',
    'assuranceLevel',
    'writesPerformed',
    'ownerAuthorizationRequired',
  ]) {
    if (redacted[key] !== undefined) output[key] = redacted[key];
  }
  return output;
}

async function runOwnerAdapterAction(config, lifecycle, context, action) {
  const resolved = await resolveOwnerAdapterAction(config, lifecycle, context, [action]);
  if (!resolved.available) return { available: false, value: null };
  try {
    return { available: true, value: await resolved.adapter[resolved.method](resolved.adapterContext) };
  } catch {
    // Do not surface an adapter exception: it can contain a provider response
    // body. The attempt is marked degraded below using a fixed safe code.
    return { available: true, value: { requested: true, provider: resolved.provider, status: 'degraded', reason: 'provider_unavailable' } };
  }
}

async function resolveOwnerAdapterAction(config, lifecycle, context, actions) {
  const provider = publicProvider(context.provider);
  if (!provider) return { available: false, value: null };
  const adapterContext = await withDetectedProviderActionContext(config, context);
  const adapters = await providerAdaptersForLifecycle(config, lifecycle, adapterContext);
  const adapter = isPlainObject(adapters) ? adapters[provider] : null;
  const method = adapter && actions.find((name) => typeof adapter[name] === 'function');
  if (!method) return { available: false, value: null };
  return { available: true, provider, adapter, adapterContext, method };
}

async function providerAdaptersForLifecycle(config, lifecycle, context) {
  const provider = publicProvider(context.provider);
  if (!provider) return config.deploymentProviderAdapters || config.adapters;
  const factory = config.createDeploymentProviderAdapter || config.createDeploymentProviderAdapters;
  if (typeof factory !== 'function') return config.deploymentProviderAdapters || config.adapters;
  try {
    const providerMetadata = isPlainObject(context.providerMetadata)
      ? context.providerMetadata
      : privateProviderMetadata(context.providerCandidate);
    const providerProjectId = internalProviderIdentifier(context.providerProjectId) || providerMetadata.projectId;
    const receiver = privateReceiverHandoff({
      deployHookId: context.deployHookId,
      receiverEndpoint: context.receiverEndpoint,
    }, context.projectId);
    const adapter = await factory({
      provider,
      projectId: context.projectId,
      // Keep the Pincushion project ID distinct from the provider project ID.
      // The latter is used only by the adapter for an exact provider readback.
      pincushionProjectId: context.projectId,
      ...(providerProjectId ? { providerProjectId } : {}),
      ...(Object.keys(providerMetadata).length ? { providerMetadata } : {}),
      ...(Array.isArray(context.canonicalOrigins) ? { canonicalOrigins: context.canonicalOrigins } : {}),
      ...(receiver?.receiverEndpoint ? { receiverEndpoint: receiver.receiverEndpoint } : {}),
      bindingId: context.bindingId,
      attemptId: context.attemptId,
      ...lifecycleCallbacks(config, lifecycle, context),
    });
    if (!adapter || typeof adapter !== 'object') return config.deploymentProviderAdapters || config.adapters;
    return { ...(isPlainObject(config.deploymentProviderAdapters) ? config.deploymentProviderAdapters : {}), [provider]: adapter };
  } catch {
    return config.deploymentProviderAdapters || config.adapters;
  }
}

function safeState(value, allowed, fallback = 'unknown') {
  const state = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return allowed.has(state) ? state : fallback;
}

function statusObject(value, allowed, fallback = 'unknown') {
  const source = typeof value === 'string' ? { state: value } : (isPlainObject(value) ? value : {});
  return { state: safeState(source.state ?? source.status, allowed, fallback) };
}

function sourceObject(source, keys) {
  for (const key of keys) {
    if (isPlainObject(source?.[key])) return source[key];
  }
  return {};
}

function publicBinding(source) {
  const raw = sourceObject(source, ['providerBinding', 'provider_binding', 'binding', 'deploymentBinding']);
  const output = statusObject(raw, PUBLIC_BINDING_STATES);
  const provider = publicProvider(raw.provider ?? source?.provider);
  if (provider) output.provider = provider;
  return output;
}

function publicCritique(source) {
  if (source?.autoCritique === false || source?.auto_critique === false) return { state: 'not_requested' };
  return statusObject(sourceObject(source, ['critique']), PUBLIC_CRIT_STATES);
}

function publicExternalCritEvidence(source) {
  const evidence = source?.externalCritEvidence ?? source?.external_crit_evidence;
  const hasEvidence = typeof evidence === 'string' || isPlainObject(evidence);
  if (!hasEvidence && (source?.autoCritique === false || source?.auto_critique === false)) {
    return { state: 'not_requested' };
  }
  return statusObject(evidence, PUBLIC_CRIT_STATES);
}

function publicLifecycleResponse(action, value, provider) {
  const source = isPlainObject(value) ? value : {};
  const output = {
    action,
    ...(publicProvider(source.provider) || publicProvider(provider)
      ? { provider: publicProvider(source.provider) || publicProvider(provider) }
      : {}),
    status: safeState(source.status ?? source.state, PUBLIC_LIFECYCLE_STATES),
  };
  if (source.cleanupRequired === true || source.cleanup_required === true) output.cleanupRequired = true;
  return output;
}

function cleanupStateFromLifecycle(value, context = {}) {
  if (!isPlainObject(value) || value.ok === false) return { known: false, pending: false };
  const cleanupRequired = value.cleanupRequired ?? value.cleanup_required;
  if (cleanupRequired !== true && cleanupRequired !== false) return { known: false, pending: false };
  const identifiers = lifecycleIdentifiers(value);
  const bindingId = identifiers.bindingId || internalProviderIdentifier(context.bindingId);
  const provider = publicProvider(value.provider) || publicProvider(context.provider);
  if (cleanupRequired === false) {
    return { known: true, pending: false, bindingId, provider };
  }
  return {
    known: true,
    pending: true,
    bindingId,
    provider,
    cleanupKind: cleanupKind(value.cleanupKind ?? value.cleanup_kind),
    cleanupDebtId: durableCleanupDebt(value),
    activeProviderWebhookId: internalProviderIdentifier(
      value.activeProviderWebhookId ?? value.active_provider_webhook_id,
    ),
    cleanupTargetProviderWebhookId: internalProviderIdentifier(
      value.cleanupTargetProviderWebhookId ?? value.cleanup_target_provider_webhook_id,
    ),
  };
}

function cleanupMatchesOwnerScope(cleanup, context = {}) {
  if (!cleanup.known) return false;
  const expectedBindingId = internalProviderIdentifier(context.bindingId);
  const expectedProvider = publicProvider(context.provider);
  return (!expectedBindingId || !cleanup.bindingId || cleanup.bindingId === expectedBindingId) &&
    (!expectedProvider || !cleanup.provider || cleanup.provider === expectedProvider);
}

function cleanupResponseMatchesRequestedBinding(value, context = {}) {
  const expectedBindingId = internalProviderIdentifier(context.bindingId);
  const responseBindingId = lifecycleIdentifiers(value).bindingId;
  const expectedProvider = publicProvider(context.provider);
  const responseProvider = publicProvider(value?.provider);
  // The owner binding is the durable scope proof. A transport/lifecycle seam
  // that cannot echo it gives this layer no safe basis for a later provider
  // mutation. The current edge cleanup response deliberately omits provider,
  // so a missing provider is inherited from the already-resolved binding; an
  // explicit disagreement is still rejected.
  // Concrete runtime lifecycle clients always resolve getBinding first. A
  // legacy injected seam may expose only getCleanup; it still must return a
  // real binding ID, but has no prior value to compare. That compatibility
  // case never applies when a binding lookup was available.
  return Boolean(responseBindingId && (!expectedBindingId || responseBindingId === expectedBindingId)) &&
    (!responseProvider || !expectedProvider || responseProvider === expectedProvider);
}

async function readOwnerCleanupState(config, lifecycle, context) {
  const direct = await callDeploymentLifecycle(config, 'getCleanup', context, lifecycle);
  if (direct.available) {
    if (!cleanupResponseMatchesRequestedBinding(direct.value, context)) {
      return { known: false, pending: false };
    }
    const cleanup = cleanupStateFromLifecycle(direct.value, context);
    // Lifecycle reads are owner-scoped, but keep the MCP orchestration boundary
    // fail-closed too: a mismatched injected/transport response can never be
    // used to authorize recovery, rotation, or revocation.
    return cleanupMatchesOwnerScope(cleanup, context)
      ? cleanup
      : { known: false, pending: false };
  }

  // Older injected lifecycle factories may expose an active inspection rather
  // than a separately named cleanup read. It is an acceptable fallback only
  // when it explicitly reports cleanupRequired; a bare "active" is not proof
  // that a destructive action is safe.
  const inspected = await callDeploymentLifecycle(config, 'inspect', context, lifecycle);
  if (!inspected.available) return { known: false, pending: false };
  const cleanup = cleanupStateFromLifecycle(inspected.value, context);
  return cleanupMatchesOwnerScope(cleanup, context)
    ? cleanup
    : { known: false, pending: false };
}

async function recoverOwnerCleanup(config, lifecycle, cleanup) {
  const provider = publicProvider(cleanup.provider);
  const pendingCleanupKind = cleanupKind(cleanup.cleanupKind) ||
    (cleanup.activeProviderWebhookId ? 'rotation' : undefined);
  const hasExactRotationPair = pendingCleanupKind === 'rotation' &&
    cleanup.activeProviderWebhookId && cleanup.cleanupTargetProviderWebhookId &&
    cleanup.activeProviderWebhookId !== cleanup.cleanupTargetProviderWebhookId;
  const hasExactRevocationTarget = pendingCleanupKind === 'revocation' &&
    !cleanup.activeProviderWebhookId && cleanup.cleanupTargetProviderWebhookId;
  if (!provider || !cleanup.bindingId || !cleanup.cleanupDebtId ||
    (!hasExactRotationPair && !hasExactRevocationTarget)) {
    return { available: false };
  }
  const context = {
    projectId: cleanup.projectId,
    provider,
    bindingId: cleanup.bindingId,
    cleanupDebtId: cleanup.cleanupDebtId,
    cleanupTargetProviderWebhookId: cleanup.cleanupTargetProviderWebhookId,
    ...(cleanup.activeProviderWebhookId ? { activeProviderWebhookId: cleanup.activeProviderWebhookId } : {}),
    ...(pendingCleanupKind ? { cleanupKind: pendingCleanupKind } : {}),
    // Recovery is a narrowly scoped continuation of already-owner-consented
    // automation, never an implicit new provisioning attempt. The adapter
    // must still fresh-read the exact provider resources before it invokes the
    // private completion callback.
    deploymentAutomation: 'auto',
    ownerConsent: true,
    ownerAuthorized: true,
    writesAllowed: true,
    confirmed: true,
    cleanupOnly: true,
  };
  const adapterContext = await withDetectedProviderActionContext(config, context);
  const adapters = await providerAdaptersForLifecycle(config, lifecycle, adapterContext);
  const adapter = isPlainObject(adapters) ? adapters[provider] : null;
  const method = adapter && [
    'recoverCleanup',
    'recoverPendingCleanup',
    'completeCleanupRecovery',
  ].find((name) => typeof adapter[name] === 'function');
  if (!method) return { available: false };
  try {
    // Ignore the response as a source of truth. The provider adapter may lose
    // the completion response after the owner RPC commits; a fresh owner
    // cleanup read below is the only classification used for authorization.
    await adapter[method](adapterContext);
    return { available: true };
  } catch {
    return { available: true };
  }
}

// Free-plan project cap (402 free_project_limit, or legacy project_limit /
// current_count from older servers). Only numeric fields are echoed, and the
// upgrade link is the fixed pricing/checkout URL, never provider text.
function freeProjectLimitHint(status, body) {
  if (status !== 402 || !body || typeof body !== 'object') return null;
  const code = typeof body.error === 'string' ? body.error : '';
  const legacy = body.current_count !== undefined && body.cap !== undefined;
  if (code !== 'free_project_limit' && code !== 'project_limit' && !legacy) return null;
  const count = (value) => (Number.isInteger(value) && value >= 0 && value < 100000 ? value : null);
  const used = count(body.used) ?? count(body.current_count);
  const cap = count(body.cap) ?? 1;
  const usage = used === null ? '' : ` (${used} of ${cap} used)`;
  return `Free plan project limit reached${usage}: the Free plan includes ${cap} project${cap === 1 ? '' : 's'}. `
    + 'Existing projects keep working. Upgrade to Pro for unlimited projects: https://www.pincushion.io/pricing?ref=mcp-project-limit';
}

export async function toolConfigureProject(config, {
  name: projectName,
  urls = [],
  projectId: requestedProjectId,
  // Set only by a caller that has established this invocation is a signed-in
  // cloud-registration attempt. The successful PUT remains the proof of
  // acceptance. A raw config.licenseKey may also serve other core seams
  // (annotation/deployment lifecycle) and is not enough on its own to turn a
  // direct/local registration into a deferred cloud identity mutation.
  deferLocalWriteUntilCloudAck = false,
  domain,
  commitTrailers,
  attributionComments,
  recordCommitSha,
  commentAccess,
  allowedDomains,
  brandContext,
  autoCritique,
  critiqueSignals,
  critiquePolicy,
  critiqueContext,
  deploymentAutomation,
  deploymentProvider,
} = {}) {
  if (!projectName) throw new Error('name is required');

  // Validate the traceability knobs up-front so a typo doesn't silently fall
  // back to a different behavior than the developer expected.
  if (commitTrailers !== undefined && !TRAILER_PRESET_VALUES.has(commitTrailers)) {
    throw new Error(`commitTrailers must be one of: ${[...TRAILER_PRESET_VALUES].join(', ')}`);
  }
  if (attributionComments !== undefined && !ATTRIBUTION_COMMENT_VALUES.has(attributionComments)) {
    throw new Error(`attributionComments must be one of: ${[...ATTRIBUTION_COMMENT_VALUES].join(', ')}`);
  }
  if (recordCommitSha !== undefined && typeof recordCommitSha !== 'boolean') {
    throw new Error('recordCommitSha must be a boolean');
  }
  if (commentAccess !== undefined && !COMMENT_ACCESS_VALUES.has(commentAccess)) {
    throw new Error(`commentAccess must be one of: ${[...COMMENT_ACCESS_VALUES].join(', ')}`);
  }
  if (commentAccess === 'domain' && !(Array.isArray(allowedDomains) && allowedDomains.length)) {
    throw new Error('allowedDomains is required when commentAccess is "domain" (e.g. ["acme.com"])');
  }
  if (allowedDomains !== undefined && !Array.isArray(allowedDomains)) {
    throw new Error('allowedDomains must be an array of bare domains');
  }
  if (brandContext !== undefined && typeof brandContext !== 'string') {
    throw new Error('brandContext must be a string (max 2048 chars)');
  }
  if (typeof brandContext === 'string' && brandContext.length > 2048) {
    throw new Error(`brandContext is too long (${brandContext.length} chars, max 2048). Trim it to the most load-bearing brand/business notes — the critic uses this on every prompt.`);
  }
  if (autoCritique !== undefined && typeof autoCritique !== 'boolean') {
    throw new Error('autoCritique must be a boolean');
  }
  if (deploymentAutomation !== undefined && deploymentAutomation !== 'auto') {
    throw new Error('deploymentAutomation must be "auto" when supplied');
  }
  if (deploymentProvider !== undefined && (typeof deploymentProvider !== 'string' || !DEPLOYMENT_PROVIDER_SET.has(deploymentProvider))) {
    throw new Error(`deploymentProvider must be one of: ${PROVIDER_IDS.join(', ')}`);
  }
  if (critiqueSignals !== undefined && critiqueSignals !== null && (typeof critiqueSignals !== 'object' || Array.isArray(critiqueSignals))) {
    throw new Error('critiqueSignals must be a plain object (or null to clear)');
  }
  if (critiquePolicy !== undefined && critiquePolicy !== null && typeof critiquePolicy !== 'string') {
    throw new Error('critiquePolicy must be a string (or null to clear)');
  }
  if (typeof critiquePolicy === 'string' && critiquePolicy.length > 4096) {
    throw new Error(`critiquePolicy is too long (${critiquePolicy.length} chars, max 4096). Trim it to the load-bearing rules — the critic reads it on every pin.`);
  }
  if (critiqueContext !== undefined && critiqueContext !== null && typeof critiqueContext !== 'string') {
    throw new Error('critiqueContext must be a string (or null to clear)');
  }
  if (typeof critiqueContext === 'string' && critiqueContext.length > 8192) {
    throw new Error(`critiqueContext is too long (${critiqueContext.length} chars, max 8192). Compile it down to the essentials — every pin pays this cost.`);
  }

  // Normalize URLs consistently with startup identity matching.
  const normalisedUrls = normalizeProjectUrls(urls);
  const licenseKey = typeof config.licenseKey === 'string' && config.licenseKey.trim()
    ? config.licenseKey.trim()
    : null;
  // Acknowledgement-first durability is reserved for an actual authenticated
  // cloud registration: the authenticated server wrapper and signed-in setup
  // gate supply the explicit defer signal. Direct/legacy callers can
  // carry a key for other operations without accidentally losing the local
  // registry that preserves a stable project ID across retries. A no-key
  // invocation remains immediate local-only mode even if it receives the
  // defer hint by mistake.
  const cloudRegistrationRequiresAck = Boolean(licenseKey && deferLocalWriteUntilCloudAck);
  const persistLocalRegistryBeforeCloudAck = !cloudRegistrationRequiresAck;

  // Load or create the local projects registry. A malformed existing registry
  // is never silently replaced by a new object.
  const registry = await readProjectRegistry(config);
  if (registry.malformed) throw new Error('projects.json is malformed; refusing to overwrite it');
  const projectsFile = registry.projectsFile;
  const projects = { ...registry.projects };

  // Explicit IDs are authoritative. Legacy direct calls without an ID retain
  // the historical name lookup for backwards compatibility; startup discovery
  // always supplies an ID (or stays read-only when one cannot be resolved).
  const requestedId = safeProjectId(requestedProjectId);
  const existingKey = requestedId
    ? (projects[requestedId] ? requestedId : null)
    : Object.keys(projects).find(k => projects[k]?.name === projectName);

  let projectId;
  const isNew = !existingKey;
  let changeStatus = isNew ? 'created' : 'existing';
  if (existingKey) {
    projectId = existingKey;
    // Merge URLs
    const existingProject = projects[existingKey];
    existingProject.projectId = projectId;
    const previousUrls = existingProject.urls || [];
    const merged = new Set([...previousUrls, ...normalisedUrls]);
    const mergedUrls = [...merged];
    const domainChanged = Boolean(domain && domain !== existingProject.domain);
    const urlsChanged = mergedUrls.length !== previousUrls.length ||
      mergedUrls.some(url => !previousUrls.includes(url));

    existingProject.urls = mergedUrls;
    if (domain) existingProject.domain = domain;

    // Only update each knob when explicitly supplied — `undefined` means
    // "leave it alone" so a partial reconfigure can't accidentally reset
    // a previously-tuned setting.
    let knobsChanged = false;
    if (commitTrailers !== undefined && existingProject.commitTrailers !== commitTrailers) {
      existingProject.commitTrailers = commitTrailers;
      knobsChanged = true;
    }
    if (attributionComments !== undefined && existingProject.attributionComments !== attributionComments) {
      existingProject.attributionComments = attributionComments;
      knobsChanged = true;
    }
    if (recordCommitSha !== undefined && existingProject.recordCommitSha !== recordCommitSha) {
      existingProject.recordCommitSha = recordCommitSha;
      knobsChanged = true;
    }
    if (commentAccess !== undefined && existingProject.commentAccess !== commentAccess) {
      existingProject.commentAccess = commentAccess;
      knobsChanged = true;
    }
    if (allowedDomains !== undefined) {
      const incoming = allowedDomains.map(d => String(d).toLowerCase().trim()).filter(Boolean);
      const prev = existingProject.allowedDomains || [];
      if (incoming.length !== prev.length || incoming.some(d => !prev.includes(d))) {
        existingProject.allowedDomains = incoming;
        knobsChanged = true;
      }
    }
    if (brandContext !== undefined && existingProject.brandContext !== brandContext) {
      existingProject.brandContext = brandContext;
      knobsChanged = true;
    }
    if (autoCritique !== undefined && existingProject.autoCritique !== autoCritique) {
      existingProject.autoCritique = autoCritique;
      knobsChanged = true;
    }
    // Layered critique fields. Each is updated independently so a partial
    // call (e.g. just policy from the dashboard) doesn't clobber signals.
    if (critiqueSignals !== undefined) {
      existingProject.critiqueSignals = critiqueSignals;
      knobsChanged = true;
    }
    if (critiquePolicy !== undefined) {
      existingProject.critiquePolicy = critiquePolicy;
      knobsChanged = true;
    }
    if (critiqueContext !== undefined) {
      existingProject.critiqueContext = critiqueContext;
      // Stamp the compile time + pin baseline whenever the compiled context
      // changes. This is what staleness checks read.
      if (critiqueContext) {
        existingProject.critiqueContextCompiledAt = new Date().toISOString();
        existingProject.critiqueContextPinsAtCompile = await countResolvedPinsForProject(config, projectId).catch(() => 0);
      } else {
        existingProject.critiqueContextCompiledAt = null;
        existingProject.critiqueContextPinsAtCompile = 0;
      }
      knobsChanged = true;
    }

    if (urlsChanged || domainChanged || knobsChanged) {
      changeStatus = 'updated';
    }
  } else {
    projectId = requestedId || `pc_proj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    projects[projectId] = {
      projectId,
      name: projectName,
      urls: normalisedUrls,
      domain: domain || (normalisedUrls[0] || null),
      createdAt: new Date().toISOString(),
      // Knobs are only written when explicitly set — absence means "use the
      // hardcoded default" (commitTrailers='minimal', attributionComments='off',
      // recordCommitSha=true, commentAccess='open') so existing projects
      // continue to behave identically.
      ...(commitTrailers !== undefined && { commitTrailers }),
      ...(attributionComments !== undefined && { attributionComments }),
      ...(recordCommitSha !== undefined && { recordCommitSha }),
      ...(commentAccess !== undefined && { commentAccess }),
      ...(allowedDomains !== undefined && {
        allowedDomains: allowedDomains.map(d => String(d).toLowerCase().trim()).filter(Boolean)
      }),
      ...(brandContext !== undefined && { brandContext }),
      ...(autoCritique !== undefined && { autoCritique }),
      ...(critiqueSignals !== undefined && { critiqueSignals }),
      ...(critiquePolicy !== undefined && { critiquePolicy }),
      ...(critiqueContext !== undefined && {
        critiqueContext,
        critiqueContextCompiledAt: critiqueContext ? new Date().toISOString() : null,
        critiqueContextPinsAtCompile: 0,
      }),
    };
  }

  if (persistLocalRegistryBeforeCloudAck) {
    await writeProjectRegistryAtomic(config, projects, projectsFile);
  }

  // Push to Supabase so the extension can pick up the URL registrations
  const supabaseBase = config.supabaseBase || 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1';
  const fetchImpl = config.fetchImpl || fetch;
  let cloudStatus = 'skipped — not signed in. Run `npx pincushion-mcp login` to enable cloud sync (shared projects, pins, share reports).';
  if (licenseKey) {
    try {
      const resp = await fetchImpl(`${supabaseBase}/sync-annotations/projects`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          'x-license-key': licenseKey,
          'x-pincushion-client': `mcp/${config.pkgVersion || '0'}`,
        },
        body: JSON.stringify({
          projectId,
          name: projectName,
          urls: projects[projectId].urls,
          commentAccess: projects[projectId].commentAccess,
          allowedDomains: projects[projectId].allowedDomains,
          brandContext: projects[projectId].brandContext,
          autoCritique: projects[projectId].autoCritique,
          critiqueSignals: projects[projectId].critiqueSignals,
          critiquePolicy: projects[projectId].critiquePolicy,
          critiqueContext: projects[projectId].critiqueContext,
          critiqueContextCompiledAt: projects[projectId].critiqueContextCompiledAt,
          critiqueContextPinsAtCompile: projects[projectId].critiqueContextPinsAtCompile,
        }),
      });
      if (resp.ok) {
        cloudStatus = 'synced';
        if (cloudRegistrationRequiresAck) {
          await writeProjectRegistryAtomic(config, projects, projectsFile);
        }
      } else {
        // Convert the provider response into a bounded message rather than
        // copying its error text into the setup result. Common cases are 402
        // plan limits, 403 ownership, and 401 license rejection.
        let serverMessage = '';
        let providerError = null;
        let projectLimit = null;
        try {
          const body = await resp.json();
          providerError = safeProviderError(body, resp.status, { fallback: 'provider_request_failed' });
          serverMessage = providerError.message;
          projectLimit = freeProjectLimitHint(resp.status, body);
        } catch { /* non-JSON response */ }
        // A 403 here is ambiguous: the server returns it both for an invalid/
        // unrecognized license and for "you don't own this project". Use only
        // the provider's allowlisted code to select a fixed recovery hint.
        const ownerHint = 'You are not the owner of this project. Use a different name to create your own, or pass a projectId you own/edit.';
        const loginHint = 'run `npx pincushion-mcp login` (or set PINCUSHION_LICENSE_KEY / ~/.pincushion/license-key).';
        const looksLikeLicense = ['invalid_license', 'license_required', 'license_key_required'].includes(providerError?.error);
        const hint = projectLimit
          ? projectLimit
          : providerError?.error === 'project_read_only'
          ? serverMessage
          : resp.status === 402
          ? 'Plan limit reached. See https://www.pincushion.io/pricing?ref=mcp-plan-limit'
          : resp.status === 401
            ? `License key is invalid or expired — ${loginHint}`
            : resp.status === 403
              ? (looksLikeLicense
                  ? `${serverMessage} — ${loginHint}`
                  : `${serverMessage || 'Not authorized'} — ${ownerHint}`)
              : (serverMessage || `The Pincushion service rejected the request (HTTP ${resp.status}).`);
        cloudStatus = hint
          ? `error ${resp.status} — ${hint}`
          : `error ${resp.status}`;
      }
    } catch {
      cloudStatus = 'error: network failure while contacting the Pincushion service';
    }
  }

  const finalUrls = projects[projectId].urls;
  const snippet = `<meta name="pincushion-project" content="${projectId}">`;
  // The embeddable widget script: one line that lets ANYONE who opens the site
  // drop a pin — no extension install. This is the highest-leverage activation
  // move (the binding constraint is configure→first-pin, and the extension
  // install never happens for stakeholders). The dev's agent can paste this
  // into the app's layout in the same turn it reads this response.
  const widgetSnippet = `<script src="https://www.pincushion.io/widget/pin.js" data-project="${projectId}" defer></script>`;

  // A project ID is usable for provider custody only after the cloud has
  // acknowledged this exact registration. In acknowledgement-first setup
  // mode, `projectId` above may still be an in-memory candidate after a
  // rejected, unavailable, or malformed PUT response. Do not even ask a
  // provider adapter to inspect that candidate: a later retry must reconcile
  // cloud identity before it can begin a durable lifecycle attempt.
  const cloudRegistrationAcknowledged = cloudStatus === 'synced';
  const projectRoot = projectRootForDeployment(config);
  let deployPlatform = null;
  let deploymentAutomationResult = null;

  // Provider-neutral detection is read-only. It deliberately collects every
  // candidate first; an ambiguous workspace is not a license to guess or to
  // make any provider call. It is also deferred until cloud registration is
  // acknowledged, because injected detectors can be backed by a provider API.
  const detectedDeploymentCandidates = cloudRegistrationAcknowledged
    ? await detectDeploymentCandidates(config, projectRoot)
    : [];
  const providerSelection = selectProviderCandidate(detectedDeploymentCandidates, deploymentProvider);
  const selectedDeploymentProvider = publicProvider(providerSelection?.provider);
  const detectedProviderIds = candidateProviderIds(detectedDeploymentCandidates);
  const selectedDeploymentCandidate = selectedProviderCandidate(detectedDeploymentCandidates, selectedDeploymentProvider);
  const selectedProviderMetadata = privateProviderMetadata(selectedDeploymentCandidate);
  const canonicalOrigins = canonicalProductionOrigins(finalUrls);
  deployPlatform = selectedDeploymentProvider || (detectedProviderIds.length === 1 ? detectedProviderIds[0] : null);

  if (!cloudRegistrationAcknowledged) {
    deploymentAutomationResult = {
      requested: deploymentAutomation === 'auto',
      status: 'registration_unacknowledged',
      verification: 'cloud_registration',
      writesPerformed: false,
      ownerAuthorizationRequired: true,
      candidates: [],
    };
  } else if (deploymentAutomation === 'auto') {
    if (!selectedDeploymentProvider) {
      deploymentAutomationResult = manualDeploymentResult({
        requested: true,
        selection: providerSelection,
        candidates: detectedDeploymentCandidates,
      });
    } else if (!admittedProviderWriterAvailable(config, selectedDeploymentProvider)) {
      // Do not create a durable owner setup attempt that no admitted adapter
      // can consume. This is intentionally checked before `begin`: an explicit
      // auto request is consent for a real lifecycle, not permission to leave a
      // pending provider attempt behind when the local runtime is manual-only.
      deploymentAutomationResult = withRedactedOwnerSetupReference(manualDeploymentResult({
        requested: true,
        provider: selectedDeploymentProvider,
        selection: providerSelection,
        candidates: detectedDeploymentCandidates,
      }), redactedOwnerSetupReference({
        provider: selectedDeploymentProvider,
        canonicalOrigins,
      }));
    } else {
      const lifecycle = await resolveDeploymentLifecycle(config, {
        projectId,
        provider: selectedDeploymentProvider,
        deploymentAutomation: 'auto',
      });
      if (canonicalOrigins.length === 0) {
        deploymentAutomationResult = withRedactedOwnerSetupReference(manualDeploymentResult({
          requested: true,
          provider: selectedDeploymentProvider,
          selection: providerSelection,
          candidates: detectedDeploymentCandidates,
        }), redactedOwnerSetupReference({
          provider: selectedDeploymentProvider,
          canonicalOrigins,
        }));
      } else {
      // A host may provide an explicit private receiver factory. The MCP
      // result never contains its output; this narrow seam lets the concrete
      // owner lifecycle consume it only after the admitted-adapter gate.
      const canBootstrapReceiver = lifecycle?.requiresReceiverBootstrap === true &&
        (typeof config.createDeploymentReceiverHandoff === 'function' ||
          typeof config.createOwnerDeploymentReceiverHandoff === 'function');
      const receiver = canBootstrapReceiver
        ? await prepareOwnerDeploymentReceiver(config, { projectId, provider: selectedDeploymentProvider })
        : null;
      const receiverReady = lifecycle?.requiresReceiverBootstrap !== true ||
        Boolean(receiver?.deployHookId && receiver?.receiverEndpoint);
      if (!receiverReady) {
        deploymentAutomationResult = withRedactedOwnerSetupReference(manualDeploymentResult({
          requested: true,
          provider: selectedDeploymentProvider,
          selection: providerSelection,
          candidates: detectedDeploymentCandidates,
        }), redactedOwnerSetupReference({
          provider: selectedDeploymentProvider,
          canonicalOrigins,
        }));
      } else {
      const begin = await callDeploymentLifecycle(config, 'begin', {
        projectId,
        provider: selectedDeploymentProvider,
        deploymentProvider: selectedDeploymentProvider,
        ...(receiver?.deployHookId ? { deployHookId: receiver.deployHookId } : {}),
        idempotencyKey: `mcp-setup:${projectId}:${selectedDeploymentProvider}`,
        deploymentAutomation: 'auto',
        ownerConsent: true,
        ownerAuthorized: true,
        writesAllowed: true,
        candidates: publicCandidateList(detectedDeploymentCandidates),
      }, lifecycle);
      if (!begin.available || !lifecycleBeginAuthorized(begin.value)) {
        deploymentAutomationResult = manualDeploymentResult({
          requested: true,
          provider: selectedDeploymentProvider,
          selection: providerSelection,
          candidates: detectedDeploymentCandidates,
        });
      } else {
        const { bindingId, attemptId } = lifecycleIdentifiers(begin.value);
        const adapters = await providerAdaptersForLifecycle(config, lifecycle, {
          provider: selectedDeploymentProvider,
          projectId,
          bindingId,
          attemptId,
          providerCandidate: selectedDeploymentCandidate,
          providerMetadata: selectedProviderMetadata,
          providerProjectId: selectedProviderMetadata.projectId,
          canonicalOrigins,
          ...(receiver?.deployHookId ? { deployHookId: receiver.deployHookId } : {}),
          ...(receiver?.receiverEndpoint ? { receiverEndpoint: receiver.receiverEndpoint } : {}),
        });
        const ensure = config.ensureDeploymentProvider || ensureDeploymentProviderFromRegistry;
        try {
          const ensured = await ensure({
            cwd: projectRoot,
            projectRoot,
            // Registry context is adapter-facing. When detection has an exact
            // provider project identifier, do not confuse it with Pincushion's
            // project ID; lifecycle callbacks have already closed over ours.
            projectId: selectedProviderMetadata.projectId || projectId,
            bindingId,
            attemptId,
            candidates: detectedDeploymentCandidates,
            deploymentProvider: selectedDeploymentProvider,
            deploymentAutomation: 'auto',
            ownerConsent: true,
            ownerAuthorized: true,
            writesAllowed: true,
            adapters,
          });
          deploymentAutomationResult = publicDeploymentResult(ensured, manualDeploymentResult({
            requested: true,
            provider: selectedDeploymentProvider,
            selection: providerSelection,
            candidates: detectedDeploymentCandidates,
          }));
        } catch {
          deploymentAutomationResult = manualDeploymentResult({
            requested: true,
            provider: selectedDeploymentProvider,
            selection: providerSelection,
            candidates: detectedDeploymentCandidates,
          });
        }
      }
      }
      }
    }
  } else {
    // Registration never mutates a provider. The agent gets a redacted,
    // provider-neutral manual handoff and must ask before changing source/CI.
    deploymentAutomationResult = manualDeploymentResult({
      requested: false,
      provider: selectedDeploymentProvider,
      selection: providerSelection,
      candidates: detectedDeploymentCandidates,
    });
  }

  // Every known-provider manual outcome includes an actionable but redacted
  // owner handoff reference. It deliberately names neither a receiver endpoint
  // nor credential material; those stay in a separately authorized private
  // channel.
  deploymentAutomationResult = withManualOwnerSetupReference(deploymentAutomationResult, {
    provider: selectedDeploymentProvider,
    canonicalOrigins,
  });

  const automationSucceeded =
    (deploymentAutomationResult.status === 'configured' || deploymentAutomationResult.status === 'already_configured');
  let deployInstructions = '';
  if (!cloudRegistrationAcknowledged) {
    deployInstructions = '\n\n📦 Deployment setup is paused until Pincushion cloud acknowledges this project registration. No provider detection, lifecycle, or provider write was attempted.';
  } else if (automationSucceeded) {
    deployInstructions = '\n\n📦 Deployment automation: the selected provider binding was verified by provider read-back. The first accepted production receipt is still pending; binding verification alone does not prove a deployment was received. Use get_deployment_reconciliation_status for receipt, reconciliation, fresh desktop/mobile frames, queue, and external Crit evidence.';
  } else if (deploymentAutomationResult.status === 'ambiguous_provider') {
    deployInstructions = '\n\n📦 Deployment setup: multiple deployment providers were detected. Ask the owner to choose deploymentProvider before any provider action. No provider was contacted and no source or CI configuration was changed.';
  } else if (deploymentAutomationResult.status === 'unsupported_provider_api') {
    deployInstructions = '\n\n📦 Deployment setup: this provider has no admitted automation API in the current environment. Use the redacted manual setup handoff after owner approval; do not modify source or CI configuration without that approval.';
  } else {
    deployInstructions = '\n\n📦 Deployment setup: project registration is complete. Provider automation remains manual unless the owner explicitly requests deploymentAutomation: "auto" and approves the lifecycle. Do not modify source or CI configuration without owner approval. Use manage_deployment_automation to inspect a binding or perform a confirmed rotate/revoke.';
  }

  const projectRecord = projects[projectId];
  // Preserve the public field for backwards-compatible response parsing while
  // never putting endpoint/token/signing material on the MCP boundary.
  const publicDeployHook = null;
  return {
    projectId,
    projectName,
    urls: finalUrls,
    status: changeStatus,
    snippet,
    widgetSnippet,
    cloudSync: cloudStatus,
    deployHook: publicDeployHook,
    deployPlatform,
    deploymentAutomation: deploymentAutomationResult,
    traceability: {
      commitTrailers: projectRecord.commitTrailers || 'minimal',
      attributionComments: projectRecord.attributionComments || 'off',
      recordCommitSha: projectRecord.recordCommitSha !== false,
    },
    ai: {
      // The Pincushion AI critic reads this block before every run. brandContext
      // is the noise filter — without it, /critique tends toward generic UX
      // advice. autoCritique gates whether deploy-hook triggers enqueue a
      // critique request (queue-and-poll model; LLM still runs in dev's IDE).
      brandContext: projectRecord.brandContext || null,
      autoCritique: projectRecord.autoCritique !== false,
      critique: {
        // Compiled context the bot loads at pin time — supersedes brandContext
        // when present. effectiveContext is what callers should read.
        effectiveContext: projectRecord.critiqueContext || projectRecord.brandContext || null,
        compiledContext: projectRecord.critiqueContext || null,
        policy: projectRecord.critiquePolicy || null,
        signals: projectRecord.critiqueSignals || null,
        compiledAt: projectRecord.critiqueContextCompiledAt || null,
        pinsAtCompile: Number(projectRecord.critiqueContextPinsAtCompile || 0),
        staleness: stalenessLabel(projectRecord.critiqueContext, projectRecord.critiqueContextCompiledAt),
      },
    },
    instructions: [
      `Project "${projectName}" configured (ID: ${projectId}).`,
      `Optional ownership proof only: after owner approval, add this to your app HTML head:\n  ${snippet}`,
      `Optional embedded widget: after owner approval, paste this one line into your app's HTML (e.g. the root layout) so anyone who opens the site can drop a pin without an extension:\n  ${widgetSnippet}\nDo not modify source or CI configuration without that approval.`,
      finalUrls.length
        ? `Registered URLs:\n${finalUrls.map(u => `  • ${u}`).join('\n')}\nAnyone visiting these URLs with Pincushion installed will automatically connect to this project.`
        : `No URLs registered yet. Add them with:\n  configure_project({ name: "${projectName}", urls: ["localhost:3000", "yourapp.vercel.app"] })`,
      cloudStatus === 'synced'
        // The activation hand-off. Registering URLs is necessary but NOT sufficient
        // for the pin UI to appear: the extension scopes activation to the signed-in
        // account, so the FAB only lights up when the extension is signed into the
        // SAME account that owns this project. Because sign-in returns the same
        // license key per Google email, "same account" is the whole trick — and the
        // #1 reason a fresh install configures a project but never sees the FAB.
        ? `To make the pin UI appear on these URLs: open the Pincushion extension and sign in with the SAME Google account you used for \`npx pincushion-mcp login\`. Same account = same workspace = the FAB activates automatically (within ~30s). No browser extension at all? Drop the embedded widget on your page instead — ask me for the Pincushion widget snippet (projectId ${projectId}) to capture a real pin with no install.`
        : `Not signed in, so this project is saved locally only and the extension can't see it yet. Run \`npx pincushion-mcp login\` to sync, then sign the extension into that same account so the pin UI activates on these URLs.`,
    ].join('\n\n') + deployInstructions,
  };
}

async function readDeploymentReconciliationPayload(config, projectId) {
  if (typeof config.getDeploymentReconciliationStatus === 'function') {
    try {
      const value = await config.getDeploymentReconciliationStatus({ projectId });
      return isPlainObject(value) ? value : {};
    } catch {
      return {};
    }
  }
  const licenseKey = config.licenseKey || null;
  if (!licenseKey) return {};
  const supabaseBase = config.supabaseBase || 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1';
  const fetchImpl = config.fetchImpl || fetch;
  try {
    const url = `${supabaseBase}/sync-annotations?deployment_reconciliation_status=1&project_id=${encodeURIComponent(projectId)}`;
    const response = await fetchImpl(url, { headers: { 'x-license-key': licenseKey } });
    if (!response?.ok) return {};
    const value = await response.json().catch(() => ({}));
    return isPlainObject(value?.data) ? value.data : (isPlainObject(value) ? value : {});
  } catch {
    return {};
  }
}

/**
 * Read a redacted, provider-neutral reconciliation diagnostic. This function
 * intentionally has no lifecycle/ensure branch: it reads status and, when an
 * adapter is injected, performs at most its read-only inspection operation.
 */
export async function toolGetDeploymentReconciliationStatus(config, { projectId } = {}) {
  if (!projectId || typeof projectId !== 'string') throw new Error('projectId is required');
  const source = await readDeploymentReconciliationPayload(config, projectId);
  const binding = publicBinding(source);
  const projectRoot = projectRootForDeployment(config);
  const provider = binding.provider;
  if (provider) {
    const inspect = config.inspectDeploymentProvider || inspectDeploymentProviderFromRegistry;
    try {
      const inspected = await inspect({
        cwd: projectRoot,
        projectRoot,
        projectId,
        deploymentProvider: provider,
        candidates: [{ provider }],
        adapters: config.deploymentProviderAdapters || config.adapters,
      });
      const redactedInspection = redactProviderResult(inspected);
      if (redactedInspection.status) {
        binding.inspection = {
          status: redactedInspection.status,
          ...(redactedInspection.verification ? { verification: redactedInspection.verification } : {}),
        };
      }
    } catch {
      binding.inspection = { status: 'degraded' };
    }
  }

  const frame = sourceObject(source, ['frameRefresh', 'frame_refresh', 'freshFrames', 'fresh_frames']);
  const critique = publicCritique(source);
  const externalCritEvidence = publicExternalCritEvidence(source);
  return {
    projectId,
    binding,
    firstAcceptedReceipt: statusObject(
      sourceObject(source, ['firstAcceptedReceipt', 'first_accepted_receipt', 'firstProductionReceipt']),
      PUBLIC_RECEIPT_STATES,
    ),
    reconciliation: statusObject(
      sourceObject(source, ['reconciliation', 'deploymentReconciliation', 'deployment_reconciliation']),
      PUBLIC_RECONCILIATION_STATES,
    ),
    frameRefresh: {
      desktop: statusObject(frame.desktop ?? frame.desktopFrame ?? source.desktopFrame, PUBLIC_FRAME_STATES),
      mobile: statusObject(frame.mobile ?? frame.mobileFrame ?? source.mobileFrame, PUBLIC_FRAME_STATES),
      run: statusObject(frame.run ?? frame.captureRun ?? source.captureRun, PUBLIC_FRAME_STATES),
    },
    queue: statusObject(sourceObject(source, ['queue', 'critiqueQueue', 'critique_queue']), PUBLIC_QUEUE_STATES),
    critique,
    externalCritEvidence,
  };
}

/**
 * Owner-keyed lifecycle management. The real lifecycle/RPC is injected by the
 * server integration; this MCP layer never calls a provider DELETE directly,
 * and only exposes a compact redacted action result.
 */
export async function toolManageDeploymentAutomation(config, {
  projectId,
  action = 'inspect',
  deploymentProvider,
  confirmed = false,
} = {}) {
  if (!projectId || typeof projectId !== 'string') throw new Error('projectId is required');
  if (!['inspect', 'repair', 'rotate', 'revoke'].includes(action)) {
    throw new Error('action must be one of: inspect, repair, rotate, revoke');
  }
  if (deploymentProvider !== undefined && !publicProvider(deploymentProvider)) {
    throw new Error(`deploymentProvider must be one of: ${PROVIDER_IDS.join(', ')}`);
  }
  if (['rotate', 'revoke'].includes(action) && confirmed !== true) {
    return {
      action,
      ...(publicProvider(deploymentProvider) ? { provider: deploymentProvider } : {}),
      status: 'confirmation_required',
    };
  }

  const lifecycle = await resolveDeploymentLifecycle(config, { projectId, provider: deploymentProvider, action });
  if (!lifecycle) {
    return {
      action,
      ...(publicProvider(deploymentProvider) ? { provider: deploymentProvider } : {}),
      status: 'manual_setup_required',
    };
  }

  // Concrete owner RPCs require a binding ID, but MCP callers must never see
  // or supply it. Resolve it owner-side from the project/provider pair when
  // that capability exists; older injected lifecycle seams remain supported.
  let lifecycleProvider = publicProvider(deploymentProvider);
  let bindingId;
  const bindingLookup = await callDeploymentLifecycle(config, 'getBinding', {
    projectId,
    ...(lifecycleProvider ? { provider: lifecycleProvider } : {}),
  }, lifecycle);
  if (bindingLookup.available) {
    const binding = isPlainObject(bindingLookup.value) ? bindingLookup.value : {};
    const resolvedBindingId = internalProviderIdentifier(binding.bindingId ?? binding.binding_id);
    const resolvedProvider = publicProvider(binding.provider) || lifecycleProvider;
    if (binding.ok === true && binding.found === true && resolvedBindingId && resolvedProvider) {
      bindingId = resolvedBindingId;
      lifecycleProvider = resolvedProvider;
    } else if (action === 'inspect') {
      return publicLifecycleResponse(action, {
        provider: resolvedProvider,
        state: binding.found === false ? 'missing' : 'manual_setup_required',
      }, resolvedProvider);
    } else {
      return {
        action,
        ...(resolvedProvider ? { provider: resolvedProvider } : {}),
        status: binding.found === false ? 'manual_setup_required' : 'cleanup_status_unavailable',
      };
    }
  }

  let repairCompletion = null;
  if (action === 'repair') {
    const inspect = await callDeploymentLifecycle(config, 'inspect', {
      projectId,
      ...(lifecycleProvider ? { provider: lifecycleProvider } : {}),
      ...(bindingId ? { bindingId } : {}),
    }, lifecycle);
    const state = isPlainObject(inspect.value) ? inspect.value : {};
    if (!inspect.available || state.errorCode !== 'orphaned_external') {
      return {
        action,
        ...(publicProvider(state.provider) || publicProvider(deploymentProvider)
          ? { provider: publicProvider(state.provider) || publicProvider(deploymentProvider) }
          : {}),
        status: 'repair_not_available',
      };
    }
    const inspectedIds = lifecycleIdentifiers(state);
    const repairAttemptId = inspectedIds.attemptId;
    const inspectedBindingId = inspectedIds.bindingId;
    const inspectedProvider = publicProvider(state.provider);
    if (!repairAttemptId || (bindingId && inspectedBindingId && bindingId !== inspectedBindingId) ||
      (lifecycleProvider && inspectedProvider && lifecycleProvider !== inspectedProvider)) {
      return {
        action,
        ...(lifecycleProvider || inspectedProvider ? { provider: lifecycleProvider || inspectedProvider } : {}),
        status: 'repair_not_available',
      };
    }
    bindingId = bindingId || inspectedBindingId;
    lifecycleProvider = lifecycleProvider || inspectedProvider;
    if (!bindingId || !lifecycleProvider) {
      return {
        action,
        ...(lifecycleProvider ? { provider: lifecycleProvider } : {}),
        status: 'repair_not_available',
      };
    }
    const compensated = await runOwnerAdapterAction(config, lifecycle, {
      projectId,
      provider: lifecycleProvider,
      bindingId,
      attemptId: repairAttemptId,
      deploymentAutomation: 'auto',
      ownerConsent: true,
      ownerAuthorized: true,
      writesAllowed: true,
      confirmed: true,
    }, 'compensateAttempt');
    if (!compensated.available) {
      return {
        action,
        ...(lifecycleProvider || publicProvider(state.provider) ? { provider: lifecycleProvider || publicProvider(state.provider) } : {}),
        status: 'repair_not_available',
      };
    }
    const compensatedState = isPlainObject(compensated.value) ? compensated.value : {};
    if (!['degraded', 'manual_setup_required'].includes(compensatedState.status)) {
      return publicAdapterActionResponse('repair', compensatedState, lifecycleProvider, {
        action,
        ...(lifecycleProvider ? { provider: lifecycleProvider } : {}),
        status: 'repair_not_available',
      });
    }
    repairCompletion = exactRepairCompletion(compensatedState, {
      projectId,
      provider: lifecycleProvider,
      bindingId,
      attemptId: repairAttemptId,
    });
    if (!repairCompletion) {
      return {
        action,
        ...(lifecycleProvider ? { provider: lifecycleProvider } : {}),
        status: 'repair_not_available',
      };
    }
  }

  if (action === 'rotate' || action === 'revoke') {
    const cleanupContext = {
      projectId,
      ...(lifecycleProvider ? { provider: lifecycleProvider } : {}),
      ...(bindingId ? { bindingId } : {}),
    };
    const beforeCleanup = await readOwnerCleanupState(config, lifecycle, cleanupContext);
    if (!beforeCleanup.known) {
      return {
        action,
        ...(lifecycleProvider ? { provider: lifecycleProvider } : {}),
        status: 'cleanup_status_unavailable',
      };
    }
    lifecycleProvider = beforeCleanup.provider || lifecycleProvider;
    bindingId = beforeCleanup.bindingId;
    if (beforeCleanup.pending) {
      // A rotate/revoke is not a cleanup primitive. Recover the one already
      // durable, exact debt first; no new provider lifecycle action is
      // authorized until an owner-keyed read says it is no longer pending.
      await recoverOwnerCleanup(config, lifecycle, { ...beforeCleanup, projectId });
      const afterCleanup = await readOwnerCleanupState(config, lifecycle, {
        projectId,
        provider: lifecycleProvider,
        bindingId,
      });
      if (!afterCleanup.known || afterCleanup.pending) {
        return {
          action,
          ...(afterCleanup.provider || lifecycleProvider ? { provider: afterCleanup.provider || lifecycleProvider } : {}),
          status: 'cleanup_required',
        };
      }
      lifecycleProvider = afterCleanup.provider || lifecycleProvider;
      bindingId = afterCleanup.bindingId || bindingId;
    }

    // Provider capability must be constructible before a lifecycle mutation.
    // In particular, the concrete runtime deliberately cannot reconstruct a
    // bearer receiver endpoint after restart without a separately authorized
    // private resolver. Do not create a replacement attempt or revoke the
    // binding and only then discover that no provider action can finish it.
    const providerCapability = await resolveOwnerAdapterAction(
      config,
      lifecycle,
      { projectId, provider: lifecycleProvider, bindingId },
      action === 'rotate'
        ? ['rotate']
        : ['recoverCleanup', 'recoverPendingCleanup', 'completeCleanupRecovery', 'revoke'],
    );
    if (!providerCapability.available) {
      return {
        action,
        ...(lifecycleProvider ? { provider: lifecycleProvider } : {}),
        status: 'cleanup_required',
      };
    }
  }

  const lifecyclePayload = action === 'repair'
    ? {
      ...repairCompletion,
      deploymentAutomation: 'auto',
      ownerConsent: true,
      ownerAuthorized: true,
      writesAllowed: true,
      confirmed: true,
    }
    : {
      projectId,
      ...(lifecycleProvider ? { provider: lifecycleProvider } : {}),
      ...(bindingId ? { bindingId } : {}),
      confirmed: confirmed === true,
    };
  const lifecycleResult = await callDeploymentLifecycle(config, action, lifecyclePayload, lifecycle);
  if (!lifecycleResult.available) {
    return {
      action,
      ...(lifecycleProvider || publicProvider(deploymentProvider)
        ? { provider: lifecycleProvider || publicProvider(deploymentProvider) }
        : {}),
      status: 'manual_setup_required',
    };
  }
  if (action === 'rotate') {
    const rotation = isPlainObject(lifecycleResult.value) ? lifecycleResult.value : {};
    const rotationIds = lifecycleIdentifiers(rotation);
    if (!lifecycleActionSucceeded(rotation)) {
      return publicLifecycleResponse(action, rotation, lifecycleProvider || deploymentProvider);
    }
    if (!rotationIds.bindingId || !rotationIds.attemptId) {
      // A provider adapter must never be asked to replace a webhook without
      // the exact durable attempt it is allowed to finalize/compensate.
      return {
        action,
        ...(lifecycleProvider ? { provider: lifecycleProvider } : {}),
        status: 'cleanup_required',
      };
    }
    const adapterRotate = await runOwnerAdapterAction(config, lifecycle, {
      projectId,
      provider: lifecycleProvider,
      bindingId: rotationIds.bindingId,
      attemptId: rotationIds.attemptId,
      deploymentAutomation: 'auto',
      ownerConsent: true,
      ownerAuthorized: true,
      writesAllowed: true,
      confirmed: true,
    }, 'rotate');
    if (!adapterRotate.available) {
      // The owner RPC has created a durable replacement attempt, but no
      // provider replacement has happened. Never call it a completed rotate.
      return {
        action,
        ...(lifecycleProvider ? { provider: lifecycleProvider } : {}),
        status: 'cleanup_required',
      };
    }
    return publicAdapterActionResponse('rotate', adapterRotate.value, lifecycleProvider, {
      action,
      ...(lifecycleProvider ? { provider: lifecycleProvider } : {}),
      status: 'cleanup_required',
    });
  }
  if (action === 'revoke') {
    const revocation = isPlainObject(lifecycleResult.value) ? lifecycleResult.value : {};
    if (!lifecycleActionSucceeded(revocation)) {
      return publicLifecycleResponse(action, revocation, lifecycleProvider || deploymentProvider);
    }
    // The revoke RPC makes the durable debt before any provider cleanup. Its
    // response is not itself a DELETE authorization: re-read the exact owner
    // debt immediately, then give the adapter only that private context.
    const revocationCleanup = await readOwnerCleanupState(config, lifecycle, {
      projectId,
      provider: lifecycleProvider,
      bindingId,
    });
    if (!revocationCleanup.known || !revocationCleanup.pending ||
      revocationCleanup.cleanupKind !== 'revocation' ||
      !revocationCleanup.cleanupDebtId || !revocationCleanup.cleanupTargetProviderWebhookId ||
      revocationCleanup.activeProviderWebhookId) {
      return {
        action,
        ...(revocationCleanup.provider || lifecycleProvider
          ? { provider: revocationCleanup.provider || lifecycleProvider }
          : {}),
        status: 'cleanup_required',
      };
    }
    lifecycleProvider = revocationCleanup.provider || lifecycleProvider;
    bindingId = revocationCleanup.bindingId || bindingId;
    const exactRevocationCleanup = { ...revocationCleanup, projectId };

    // Prefer an adapter's exact cleanup recovery protocol. It can fresh-list
    // the provider resource and call the private completion callback. An older
    // provider may instead expose a revoke cleanup method; it receives the
    // same debt facts and must still invoke getCleanupDebt immediately before
    // any external DELETE.
    const recovered = await recoverOwnerCleanup(config, lifecycle, exactRevocationCleanup);
    if (!recovered.available) {
      await runOwnerAdapterAction(config, lifecycle, {
        projectId,
        provider: lifecycleProvider,
        bindingId,
        cleanupDebtId: revocationCleanup.cleanupDebtId,
        cleanupKind: 'revocation',
        cleanupTargetProviderWebhookId: revocationCleanup.cleanupTargetProviderWebhookId,
        deploymentAutomation: 'auto',
        ownerConsent: true,
        ownerAuthorized: true,
        writesAllowed: true,
        confirmed: true,
        cleanupOnly: true,
      }, 'revoke');
    }

    // A provider response (or a lost completion response) is not sufficient
    // to call the binding clean. Only the fresh owner read below can prove the
    // exact debt was completed. This also keeps adapters without revocation
    // support fail-closed as cleanup_required.
    const afterRevocationCleanup = await readOwnerCleanupState(config, lifecycle, {
      projectId,
      provider: lifecycleProvider,
      bindingId,
    });
    if (!afterRevocationCleanup.known || afterRevocationCleanup.pending) {
      return {
        action,
        ...(afterRevocationCleanup.provider || lifecycleProvider
          ? { provider: afterRevocationCleanup.provider || lifecycleProvider }
          : {}),
        status: 'cleanup_required',
      };
    }
    return {
      action,
      ...(afterRevocationCleanup.provider || lifecycleProvider
        ? { provider: afterRevocationCleanup.provider || lifecycleProvider }
        : {}),
      status: 'revoked',
    };
  }
  return publicLifecycleResponse(action, lifecycleResult.value, lifecycleProvider || deploymentProvider);
}

// ─── Update Critique Context ─────────────────────────────────────────────────
// Lightweight write-only path for /setup and /refresh-brand. Persists the
// compiled critique brief + signals + policy without doing the heavy work
// configure_project does (deploy-hook creation, bot-member upsert, URL
// validation, platform detection). The dev agent calls this after gathering
// signals from the repo (README, theme tokens, sample copy, etc.) and
// synthesizing them into a compiled brief.
//
// The brief itself is computed by the dev's agent — we don't run an LLM
// on the Pincushion side. This tool only stores what the agent produced.

export async function toolUpdateCritiqueContext(config, {
  projectId,
  name: projectName,
  critiqueContext,
  critiquePolicy,
  critiqueSignals,
} = {}) {
  if (!projectId && !projectName) {
    throw new Error('projectId or name is required to identify which project to update');
  }
  if (critiqueContext === undefined && critiquePolicy === undefined && critiqueSignals === undefined) {
    throw new Error('At least one of critiqueContext, critiquePolicy, or critiqueSignals must be supplied');
  }
  if (critiqueSignals !== undefined && critiqueSignals !== null && (typeof critiqueSignals !== 'object' || Array.isArray(critiqueSignals))) {
    throw new Error('critiqueSignals must be a plain object (or null to clear)');
  }
  if (critiquePolicy !== undefined && critiquePolicy !== null && typeof critiquePolicy !== 'string') {
    throw new Error('critiquePolicy must be a string (or null to clear)');
  }
  if (typeof critiquePolicy === 'string' && critiquePolicy.length > 4096) {
    throw new Error(`critiquePolicy is too long (${critiquePolicy.length} chars, max 4096).`);
  }
  if (critiqueContext !== undefined && critiqueContext !== null && typeof critiqueContext !== 'string') {
    throw new Error('critiqueContext must be a string (or null to clear)');
  }
  if (typeof critiqueContext === 'string' && critiqueContext.length > 8192) {
    throw new Error(`critiqueContext is too long (${critiqueContext.length} chars, max 8192).`);
  }

  const projectsFile = join(config.feedbackDir, 'projects.json');
  let projects = {};
  try {
    projects = JSON.parse(await readFile(projectsFile, 'utf8'));
  } catch {
    throw new Error('No projects.json yet — run configure_project once before update_critique_context.');
  }

  let resolvedId = projectId;
  if (!resolvedId) {
    const entry = Object.entries(projects).find(([, p]) => p.name === projectName);
    if (!entry) {
      throw new Error(`No project named "${projectName}" in this workspace. Run configure_project first.`);
    }
    resolvedId = entry[0];
  }
  const record = projects[resolvedId];
  if (!record) {
    throw new Error(`No project with id "${resolvedId}" in this workspace.`);
  }

  if (critiqueSignals !== undefined) record.critiqueSignals = critiqueSignals;
  if (critiquePolicy !== undefined) record.critiquePolicy = critiquePolicy;
  if (critiqueContext !== undefined) {
    record.critiqueContext = critiqueContext;
    // Only re-stamp compile metadata when the compiled context itself
    // changed. Editing just the policy or signals doesn't count as a
    // compile — the bot still reads the old compiled context until the
    // next /refresh-brand run.
    if (critiqueContext) {
      record.critiqueContextCompiledAt = new Date().toISOString();
      record.critiqueContextPinsAtCompile = await countResolvedPinsForProject(config, resolvedId).catch(() => 0);
    } else {
      record.critiqueContextCompiledAt = null;
      record.critiqueContextPinsAtCompile = 0;
    }
  }

  if (!existsSync(config.feedbackDir)) mkdirSync(config.feedbackDir, { recursive: true });
  await writeFile(projectsFile, JSON.stringify(projects, null, 2));

  // Push to cloud. We reuse the existing /projects PUT — the edge function
  // now accepts the layered critique fields. Best-effort; local write is
  // authoritative if the user is offline.
  const supabaseBase = config.supabaseBase || 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1';
  const licenseKey = config.licenseKey || null;
  let cloudStatus = 'skipped — not signed in. Run `npx pincushion-mcp login` to enable cloud sync (shared projects, pins, share reports).';
  if (licenseKey) {
    try {
      const resp = await fetch(`${supabaseBase}/sync-annotations/projects`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-license-key': licenseKey },
        body: JSON.stringify({
          projectId: resolvedId,
          name: record.name,
          urls: record.urls,
          critiqueSignals: record.critiqueSignals ?? null,
          critiquePolicy: record.critiquePolicy ?? null,
          critiqueContext: record.critiqueContext ?? null,
          critiqueContextCompiledAt: record.critiqueContextCompiledAt ?? null,
          critiqueContextPinsAtCompile: record.critiqueContextPinsAtCompile ?? 0,
        }),
      });
      cloudStatus = resp.ok ? 'synced' : `error ${resp.status}`;
    } catch {
      cloudStatus = 'error: network failure while contacting the Pincushion service';
    }
  }

  return {
    success: true,
    projectId: resolvedId,
    projectName: record.name,
    cloudSync: cloudStatus,
    critique: {
      effectiveContext: record.critiqueContext || record.brandContext || null,
      compiledContext: record.critiqueContext || null,
      policy: record.critiquePolicy || null,
      signals: record.critiqueSignals || null,
      compiledAt: record.critiqueContextCompiledAt || null,
      pinsAtCompile: Number(record.critiqueContextPinsAtCompile || 0),
      staleness: stalenessLabel(record.critiqueContext, record.critiqueContextCompiledAt),
    },
    message: critiqueContext !== undefined
      ? `Critique context recompiled for "${record.name}". The AI critic will use this brief on the next /critique run.`
      : `Critique inputs updated for "${record.name}". Run /refresh-brand to recompile the brief.`,
  };
}

// ─── Auto-Discovery ──────────────────────────────────────────────────────────
// Scans the project directory for package.json, .env, vercel config, framework
// configs, etc. to infer the project name, local dev URL, and production URL.
// Returns { name, urls } ready for toolConfigureProject.

export async function discoverProjectConfig(projectDir) {
  let name = null;
  const urls = new Set();

  // 1. package.json — project name + dev script port
  const pkgPath = join(projectDir, 'package.json');
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    name = pkg.name || null;
    if (pkg.homepage) urls.add(pkg.homepage.replace(/\/+$/, ''));

    // Sniff port from dev script: --port 3001, -p 8080, PORT=4000
    const devScript = pkg.scripts?.dev || pkg.scripts?.start || '';
    const portMatch = devScript.match(/(?:--port|-p)\s+(\d+)/) ||
                      devScript.match(/PORT=(\d+)/);
    if (portMatch) {
      urls.add(`http://localhost:${portMatch[1]}`);
    }
  } catch { /* no package.json */ }

  // 2. .env / .env.local — look for PORT, URL-like vars
  for (const envFile of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    try {
      const content = await readFile(join(projectDir, envFile), 'utf8');
      // PORT=3001
      const portMatch = content.match(/^PORT=(\d+)/m);
      if (portMatch) urls.add(`http://localhost:${portMatch[1]}`);
      // Common URL vars
      for (const pattern of [
        /^(?:NEXT_PUBLIC_|VITE_|REACT_APP_)?(?:APP_URL|SITE_URL|BASE_URL|PUBLIC_URL|VERCEL_URL|DEPLOY_URL)=(.+)$/gm
      ]) {
        let m;
        while ((m = pattern.exec(content)) !== null) {
          let val = m[1].trim().replace(/['"]/g, '');
          if (val && !val.includes('${') && !val.startsWith('#')) {
            if (!val.startsWith('http')) val = `https://${val}`;
            urls.add(val.replace(/\/+$/, ''));
          }
        }
      }
    } catch { /* file doesn't exist — skip */ }
  }

  // 3. .vercel/project.json — Vercel project name → <name>.vercel.app
  try {
    const vercelProj = JSON.parse(await readFile(join(projectDir, '.vercel', 'project.json'), 'utf8'));
    if (vercelProj.projectId) {
      // We can't derive the URL from projectId alone, but the project name is often the subdomain
      // Check vercel.json for alias
    }
  } catch { /* no vercel config */ }

  // 4. vercel.json — alias / custom domains
  try {
    const vercelConf = JSON.parse(await readFile(join(projectDir, 'vercel.json'), 'utf8'));
    for (const alias of (vercelConf.alias || [])) {
      urls.add(alias.startsWith('http') ? alias : `https://${alias}`);
    }
  } catch { /* no vercel.json */ }

  // 5. Framework defaults — if no port was found, add common defaults
  if (![...urls].some(u => u.includes('localhost'))) {
    // Check which framework is in use
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next'])    urls.add('http://localhost:3000');
      else if (deps['nuxt'] || deps['nuxt3']) urls.add('http://localhost:3000');
      else if (deps['vite'] || deps['@vitejs/plugin-react']) urls.add('http://localhost:5173');
      else if (deps['@angular/core']) urls.add('http://localhost:4200');
      else if (deps['gatsby']) urls.add('http://localhost:8000');
      else if (deps['svelte'] || deps['@sveltejs/kit']) urls.add('http://localhost:5173');
      else if (deps['react-scripts']) urls.add('http://localhost:3000');
      else urls.add('http://localhost:3000'); // safe default
    } catch {
      urls.add('http://localhost:3000'); // fallback
    }
  }

  // Clean up name: strip @scope/, convert hyphens to title case
  if (name) {
    name = name.replace(/^@[^/]+\//, ''); // strip npm scope
  }

  return {
    name: name || projectDir.split('/').pop() || 'Untitled Project',
    urls: [...urls].filter(Boolean),
  };
}

// ─── Live PINS.md Generator ──────────────────────────────────────────────────
/**
 * Analyze a CSS selector to detect if the pin's target element is inside a
 * dynamic container (modal, sidebar, dropdown, etc.) and return a short
 * human-readable description. Returns null for static elements.
 */
function describeDynamicContext(selector) {
  if (!selector) return null;
  const s = selector.toLowerCase();

  // Common dynamic container patterns in selectors
  const patterns = [
    { test: /\[role=["']?dialog["']?\]|\[aria-modal/, label: 'pin is inside a modal dialog (may be hidden when closed)' },
    { test: /dialog\b/, label: 'pin is inside a <dialog> element (may be hidden when closed)' },
    { test: /\.modal|\.lightbox/, label: 'pin is inside a modal (may be hidden when closed)' },
    { test: /\.sidebar|\.side-bar|\.drawer|\.offcanvas|\.off-canvas/, label: 'pin is inside a sidebar/drawer (may be hidden when collapsed)' },
    { test: /\.dropdown|\.drop-down|\.popover|\.pop-over/, label: 'pin is inside a dropdown/popover (may be hidden when closed)' },
    { test: /\[role=["']?tabpanel["']?\]/, label: 'pin is inside a tab panel (only visible when that tab is active)' },
    { test: /\.accordion/, label: 'pin is inside an accordion section (may be collapsed)' },
    { test: /\.overlay/, label: 'pin is inside an overlay (may be hidden)' },
    { test: /\.tooltip/, label: 'pin is inside a tooltip (only visible on hover)' },
    { test: /\.toast|\.snackbar/, label: 'pin is on a toast/notification (appears briefly)' },
  ];

  for (const { test, label } of patterns) {
    if (test.test(s)) return label;
  }
  return null;
}

/**
 * Build a deep link URL for a pin that opens the page and auto-focuses it.
 */
function buildDeepLink(pageUrl, pinId) {
  try {
    const u = new URL(pageUrl);
    u.searchParams.set('pincushion_pin', pinId);
    return u.toString();
  } catch {
    return pageUrl.includes('?')
      ? `${pageUrl}&pincushion_pin=${pinId}`
      : `${pageUrl}?pincushion_pin=${pinId}`;
  }
}

/**
 * Collect ALL pins (open + resolved) from annotation data, sorted by date.
 */
function collectAllPins(allData) {
  const open = [];
  const resolved = [];
  const terminal = [];

  for (const [entryKey, data] of Object.entries(allData)) {
    const pageUrl = annotationPageUrl(entryKey, data);
    for (const ann of (data.annotations || [])) {
      const userComments = (ann.thread || []).filter(
        m => m.type !== 'code-note' && m.type !== 'decline' && m.author !== 'AI Agent'
      );
      if (!userComments.length && !ann.thread?.length) continue;

      const pin = {
        id: ann.id,
        pageUrl,
        pageTitle: data.pageTitle || pageUrl,
        status: ann.status || 'open',
        action: ann.action || null,
        element: ann.element || {},
        thread: ann.thread || [],
        createdAt: ann.createdAt,
        updatedAt: ann.updatedAt,
        resolvedAt: ann.resolvedAt,
        approvedAt: ann.approvedAt,
        approvedBy: ann.approvedBy,
        implementedAt: ann.implementedAt,
        implementer: ann.implementer,
        projectId: ann.projectId,
        dismissedAt: ann.dismissedAt,
        dismissedBy: ann.dismissedBy,
      };

      if (ann.status === 'resolved') {
        resolved.push(pin);
      } else if (isTerminalStatus(ann.status)) {
        terminal.push(pin);
      } else {
        open.push(pin);
      }
    }
  }

  open.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  resolved.sort((a, b) => new Date(b.resolvedAt || b.updatedAt || 0) - new Date(a.resolvedAt || a.updatedAt || 0));
  terminal.sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

  return { open, resolved, terminal };
}

// Generates a structured markdown file that stays in sync with open feedback.
// Designed to be opened in any IDE alongside code — the developer's feedback
// dashboard. Each pin is a section with full context + agent-ready instructions.
// Includes checkboxes for selecting pins and a resolved section at the bottom.

export async function generatePinsMarkdown(config, fetchRemote = null) {
  const allData = await readAllAnnotations(config, fetchRemote);
  const { open: pins, resolved: resolvedPins, terminal: terminalPins } = collectAllPins(allData);

  // Group open pins by page
  const byPage = {};
  for (const pin of pins) {
    const key = pin.pageUrl;
    if (!byPage[key]) byPage[key] = { title: pin.pageTitle, pins: [] };
    byPage[key].pins.push(pin);
  }

  // Build markdown
  const lines = [];
  lines.push('# Pincushion — Feedback Dashboard');
  lines.push('');
  const approvedCount = pins.filter(p => isReadyStatus(p.status)).length;
  const openCount = pins.filter(p => !isReadyStatus(p.status)).length;
  lines.push(`> ${openCount} open · ${approvedCount} ready · ${resolvedPins.length} resolved · ${terminalPins.length} terminal · Updated ${new Date().toLocaleString()}`);
  lines.push('>');
  lines.push('> **How to use:** Check the boxes next to pins you want to implement, then tell your agent:');
  lines.push('> `implement the checked pins` or `resolve <pin-id>`');
  lines.push('>');
  lines.push('> [Open Dashboard](./dashboard.html) for an interactive view with filters and selection.');
  lines.push('');

  if (pins.length === 0 && resolvedPins.length === 0 && terminalPins.length === 0) {
    lines.push('No feedback pins yet. Drop a pin using the Pincushion Chrome extension on any registered URL.');
    return lines.join('\n');
  }

  // ── Open Pins ──────────────────────────────────────────────────────────────

  if (pins.length > 0) {
    lines.push('## Open Pins');
    lines.push('');

    for (const [pageUrl, group] of Object.entries(byPage)) {
      lines.push(`### ${group.title}`);
      lines.push(`<${pageUrl}>`);
      lines.push('');

      for (const pin of group.pins) {
        const userComment = firstUserThreadMessage(pin.thread || []);
        const parsedComment = parseRichComment(userComment?.body || '');
        const commentBody = parsedComment.plainText || '(no comment)';
        const author = userComment?.author || 'Unknown';
        const age = pin.createdAt ? timeAgo(new Date(pin.createdAt)) : '';
        const deepLink = buildDeepLink(pin.pageUrl, pin.id);
        const statusTag = isReadyStatus(pin.status) ? ' ✅ **ready**'
          : pin.action === 'implemented' ? ' *(implemented — awaiting review)*'
          : pin.action === 'implementing' ? ' *(in progress)*'
          : '';

        // Checkbox + pin header
        lines.push(`- [ ] **[\`${pin.id}\`](${deepLink})** — ${commentBody.split('\n')[0].slice(0, 80)}${statusTag}`);
        lines.push(`  *by ${author} · ${age}${pin.approvedBy ? ` · approved by ${pin.approvedBy}` : ''}*`);
        lines.push('');

        // Element context + dynamic visibility hint
        if (pin.element.selector || pin.element.tagName) {
          const selector = pin.element.selector || pin.element.tagName;
          const dynamicHint = describeDynamicContext(selector);
          lines.push('  **Target element:**');
          lines.push('  ```css');
          lines.push(`  ${selector}`);
          lines.push('  ```');
          if (dynamicHint) {
            lines.push(`  ⚡ *Dynamic element — ${dynamicHint}*`);
          }
          if (pin.element.textContent) {
            lines.push(`  Content: "${pin.element.textContent.slice(0, 120)}"`);
          }
          lines.push('');
        }

        // Full thread
        if (pin.thread.length > 0) {
          lines.push('  **Thread:**');
          for (const msg of pin.thread) {
            const enriched = serializeThreadMessage(msg);
            const who = msg.author || 'Unknown';
            const when = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '';
            const prefix = msg.type === 'code-note' ? '🤖' : msg.type === 'decline' ? '❌' : '💬';
            lines.push(`  - ${prefix} **${who}** ${when ? `(${when})` : ''}: ${(enriched.plainText || '').split('\n')[0] || ''}`);
            if (enriched.links.length > 0) {
              lines.push(`    Links: ${enriched.links.map(link => link.url).join(', ')}`);
            }
            if (enriched.images.length > 0) {
              lines.push(`    Images: ${enriched.images.map(image => image.url).join(', ')}`);
            }
          }
          lines.push('');
        }

        // Agent action block
        lines.push('  <details><summary>Agent instructions</summary>');
        lines.push('');
        lines.push('  ```');
        lines.push(`  claim_pin({ annotationId: "${pin.id}" })`);
        lines.push(`  // ... implement the change ...`);
        lines.push(`  fix_and_resolve({ annotationId: "${pin.id}", fixDescription: "..." })`);
        lines.push('  ```');
        lines.push('  </details>');
        lines.push('');
      }
    }
  }

  // ── Resolved Pins ──────────────────────────────────────────────────────────

  if (resolvedPins.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push(`## Resolved (${resolvedPins.length})`);
    lines.push('');

    for (const pin of resolvedPins.slice(0, 50)) { // cap at 50 most recent
      const userComment = firstUserThreadMessage(pin.thread || []);
      const commentBody = parseRichComment(userComment?.body || '').plainText || '(no comment)';
      const author = userComment?.author || 'Unknown';
      const resolvedDate = pin.resolvedAt ? new Date(pin.resolvedAt).toLocaleDateString() : '';
      const deepLink = buildDeepLink(pin.pageUrl, pin.id);

      // Find the resolution message (last code-note or resolution type)
      const resolution = [...(pin.thread || [])].reverse().find(
        m => m.type === 'code-note' || m.type === 'resolution'
      );
      const resolutionText = resolution?.body
        ? ` → ${parseRichComment(resolution.body).plainText.split('\n')[0].slice(0, 80)}`
        : '';

      lines.push(`- [x] ~~[\`${pin.id}\`](${deepLink})~~ — ${commentBody.split('\n')[0].slice(0, 60)}${resolutionText}`);
      lines.push(`  *by ${author} · resolved ${resolvedDate}*`);
    }
    lines.push('');
  }

  // Dismissed and archived pins are deliberately rendered as historical state,
  // without checkboxes or implementation snippets. That prevents a stale local
  // export from turning an owner decision into an agent instruction.
  if (terminalPins.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push(`## Terminal History (${terminalPins.length})`);
    lines.push('');
    for (const pin of terminalPins.slice(0, 50)) {
      const userComment = firstUserThreadMessage(pin.thread || []);
      const commentBody = parseRichComment(userComment?.body || '').plainText || '(no comment)';
      const closedAt = pin.dismissedAt || pin.updatedAt;
      const closedDate = closedAt ? new Date(closedAt).toLocaleDateString() : '';
      lines.push(`- **${pin.status}** — \`${pin.id}\`: ${commentBody.split('\n')[0].slice(0, 80)}${closedDate ? ` (${closedDate})` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Structured JSON Export ──────────────────────────────────────────────────
// Generates a machine-readable JSON file with all pin data for the dashboard.

export async function generatePinsJson(config, fetchRemote = null) {
  const allData = await readAllAnnotations(config, fetchRemote);
  const { open, resolved, terminal } = collectAllPins(allData);

  // Read selections file if it exists
  let selections = [];
  try {
    const selectionsPath = join(config.feedbackDir, 'selections.json');
    if (existsSync(selectionsPath)) {
      const raw = JSON.parse(await readFile(selectionsPath, 'utf-8'));
      selections = raw.selectedPins || [];
    }
  } catch { /* no selections */ }
  // Selection storage is local and may pre-date an owner dismissal. Do not
  // mutate it here (a remote lookup may be unavailable), but never return a
  // terminal id to an implementation consumer.
  const eligibleIds = new Set(open.map((pin) => pin.id));
  selections = selections.filter((id) => eligibleIds.has(id));

  const mapPin = (pin) => {
    const firstUserMessage = firstUserThreadMessage(pin.thread || []);

    return {
      id: pin.id,
      projectId: pin.projectId || null,
      pageUrl: pin.pageUrl,
      pageTitle: pin.pageTitle,
      status: pin.status,
      action: pin.action,
      selected: selections.includes(pin.id),
      element: {
        selector: pin.element?.selector || null,
        tagName: pin.element?.tagName || null,
        textContent: pin.element?.textContent?.slice(0, 200) || null,
        lwcComponent: pin.element?.lwcComponent || null,
      },
      dynamicContext: describeDynamicContext(pin.element?.selector),
      deepLink: buildDeepLink(pin.pageUrl, pin.id),
      thread: (pin.thread || []).map((message) => {
        const enriched = serializeThreadMessage(message);
        return {
          ...enriched,
          // Keep the existing rich HTML export for API compatibility, but the
          // dashboard consumes this token list with DOM text nodes instead of
          // assigning any remotely sourced HTML to innerHTML.
          tokens: parseRichComment(enriched.body).tokens,
          renderedHtml: renderRichCommentHtml(enriched.body),
        };
      }),
      author: firstUserMessage?.author || 'Unknown',
      comment: summarizeRichComment(firstUserMessage?.body || '', 200),
      createdAt: pin.createdAt,
      resolvedAt: pin.resolvedAt,
      approvedAt: pin.approvedAt,
      approvedBy: pin.approvedBy,
      implementedAt: pin.implementedAt,
      implementer: pin.implementer,
    };
  };

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalOpen: open.filter(p => !isReadyStatus(p.status)).length,
      totalApproved: open.filter(p => isReadyStatus(p.status)).length,
      totalResolved: resolved.length,
      totalTerminal: terminal.length,
      totalSelected: selections.length,
    },
    open: open.map(mapPin),
    resolved: resolved.slice(0, 50).map(mapPin),
    terminal: terminal.slice(0, 50).map(mapPin),
    selections,
  };
}

// Write pins.json to disk in the feedback directory
export async function writePinsJson(config, fetchRemote = null) {
  const data = await generatePinsJson(config, fetchRemote);
  const jsonPath = join(config.feedbackDir, 'pins.json');
  if (!existsSync(config.feedbackDir)) mkdirSync(config.feedbackDir, { recursive: true });
  await writeFile(jsonPath, JSON.stringify(data, null, 2));
  return jsonPath;
}

// ─── Interactive HTML Dashboard ──────────────────────────────────────────────
// Generates a self-contained HTML file with embedded pin data. Opens in any
// browser, no server needed for viewing. Selection posts back to the local
// bridge server if running. A process-bound dashboard capability is embedded
// only in the owner-readable generated file; callers that do not provide one
// get a view-only dashboard.

function serializeForInlineScript(value) {
  // JSON is valid JavaScript data, but a literal `</script>` within it closes
  // this generated script block before the browser parses the JSON. Escape the
  // HTML-significant characters and JavaScript line separators without changing
  // the value available to the dashboard runtime.
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export async function generateDashboardHtml(config, fetchRemote = null, bridgePort = 3456, dashboardCapability = '') {
  const pinsData = await generatePinsJson(config, fetchRemote);
  const safeBridgePort = Number.isInteger(bridgePort) && bridgePort >= 0 && bridgePort <= 65535 ? bridgePort : 3456;
  const safeDashboardCapability = typeof dashboardCapability === 'string' ? dashboardCapability : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pincushion — Feedback Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3;
    --text-muted: #8b949e; --accent: #58a6ff; --green: #3fb950; --yellow: #d29922;
    --red: #f85149; --purple: #bc8cff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand-logo { width: 32px; height: 32px; background: var(--accent); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; }
  .brand-name { font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }
  .brand-name span { color: var(--accent); }
  .brand-tagline { font-size: 12px; color: var(--text-muted); margin-top: 1px; }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 18px; text-align: center; min-width: 90px; }
  .stat .num { font-size: 24px; font-weight: 700; }
  .stat .label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat.open .num { color: var(--yellow); }
  .stat.approved .num { color: var(--green); }
  .stat.resolved .num { color: var(--text-muted); }
  .stat.selected .num { color: var(--accent); }

  .toolbar { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
  .toolbar select, .toolbar input { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 6px; font-size: 13px; }
  .toolbar input { flex: 1; min-width: 200px; }
  .btn { background: var(--accent); color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.secondary { background: var(--surface); border: 1px solid var(--border); color: var(--text); }
  .btn.green { background: var(--green); }

  .tabs { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
  .tab { padding: 8px 18px; cursor: pointer; color: var(--text-muted); border-bottom: 2px solid transparent; font-size: 14px; }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .tab .count { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1px 7px; font-size: 11px; margin-left: 6px; }

  .pin-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 12px; transition: border-color 0.15s; }
  .pin-card:hover { border-color: var(--accent); }
  .pin-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .pin-card.resolved-card { opacity: 0.7; }

  .pin-header { display: flex; align-items: flex-start; gap: 10px; }
  .pin-check { margin-top: 3px; width: 18px; height: 18px; accent-color: var(--accent); cursor: pointer; flex-shrink: 0; }
  .pin-body { flex: 1; min-width: 0; }
  .pin-id { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: var(--accent); cursor: pointer; text-decoration: none; }
  .pin-id:hover { text-decoration: underline; }
  .pin-comment { font-size: 15px; font-weight: 500; margin: 4px 0; }
  .pin-meta { font-size: 12px; color: var(--text-muted); display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .pin-meta .author { font-weight: 500; color: var(--text); }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
  .badge.approved-badge { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge.implemented { background: rgba(188,140,255,0.15); color: var(--purple); }
  .badge.resolved-badge { background: rgba(63,185,80,0.15); color: var(--green); }

  .approve-btn { background: none; border: 1px solid var(--green); color: var(--green); padding: 2px 10px; border-radius: 10px; font-size: 11px; cursor: pointer; transition: all 0.15s; margin-left: 6px; }
  .approve-btn:hover { background: var(--green); color: #fff; }

  .live-indicator { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--green); }
  .live-dot { width: 6px; height: 6px; background: var(--green); border-radius: 50%; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

  .pin-element { margin-top: 10px; background: var(--bg); border-radius: 6px; padding: 10px 12px; font-size: 12px; }
  .pin-element code { font-family: 'SF Mono', 'Fira Code', monospace; color: var(--accent); word-break: break-all; }
  .pin-element .content { color: var(--text-muted); margin-top: 4px; }
  .pin-element .dynamic { color: var(--yellow); margin-top: 4px; font-style: italic; }

  .thread { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; }
  .thread-msg { font-size: 13px; margin-bottom: 6px; padding-left: 12px; border-left: 2px solid var(--border); }
  .thread-msg .msg-author { font-weight: 600; }
  .thread-msg .msg-time { color: var(--text-muted); font-size: 11px; margin-left: 6px; }
  .thread-msg .thread-body { margin-top: 4px; color: var(--text); }
  .thread-msg.code-note { border-left-color: var(--purple); }
  .thread-msg.resolution { border-left-color: var(--green); }
  .rich-link { color: var(--accent); text-decoration: underline; }
  .rich-image-wrap { display: block; margin-top: 8px; }
  .rich-image-link { display: inline-block; max-width: 100%; }
  .rich-image { display: block; max-width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--border); }
  .rich-image-alt { display: block; margin-top: 4px; color: var(--text-muted); font-size: 11px; }

  .actions-bar { position: sticky; bottom: 0; background: var(--surface); border-top: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; gap: 12px; justify-content: space-between; z-index: 10; }
  .actions-bar .left { display: flex; gap: 8px; align-items: center; }
  .actions-bar .right { display: flex; gap: 8px; }
  .actions-bar .count-label { font-size: 13px; color: var(--text-muted); }

  .toast { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); background: var(--green); color: #fff; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; display: none; z-index: 100; animation: fadeIn 0.2s; }
  @keyframes fadeIn { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

  .empty { text-align: center; padding: 60px 20px; color: var(--text-muted); }
  .empty h3 { font-size: 18px; margin-bottom: 8px; color: var(--text); }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="brand">
      <div class="brand-logo">📌</div>
      <div>
        <div class="brand-name">Pin<span>cushion</span></div>
        <div class="brand-tagline">Feedback → Code</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat open"><div class="num" id="statOpen">0</div><div class="label">Open</div></div>
      <div class="stat approved"><div class="num" id="statApproved">0</div><div class="label">Approved</div></div>
      <div class="stat selected"><div class="num" id="statSelected">0</div><div class="label">Selected</div></div>
      <div class="stat resolved"><div class="num" id="statResolved">0</div><div class="label">Resolved</div></div>
      <span class="live-indicator" id="liveIndicator" style="display:none;"><span class="live-dot"></span> Live</span>
    </div>
  </header>

  <div class="toolbar">
    <select id="filterPage"><option value="">All Pages</option></select>
    <select id="filterAuthor"><option value="">All Authors</option></select>
    <input type="text" id="searchBox" placeholder="Search pins...">
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="open">Open <span class="count" id="tabOpenCount">0</span></div>
    <div class="tab" data-tab="approved">Approved <span class="count" id="tabApprovedCount">0</span></div>
    <div class="tab" data-tab="resolved">Resolved <span class="count" id="tabResolvedCount">0</span></div>
  </div>

  <div id="pinList"></div>
</div>

<div class="actions-bar" id="actionsBar" style="display:none;">
  <div class="left">
    <input type="checkbox" id="selectAll" style="width:18px;height:18px;accent-color:var(--accent);cursor:pointer;">
    <span class="count-label"><strong id="selectedCount">0</strong> pin(s) selected</span>
  </div>
  <div class="right">
    <button class="btn secondary" onclick="clearSelections()">Clear</button>
    <button class="btn green" onclick="approveSelected()">Approve Selected</button>
    <button class="btn" onclick="copyCommand()">Copy Agent Command</button>
    <button class="btn green" onclick="sendToAgent()">Send to Agent</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const BRIDGE_PORT = ${serializeForInlineScript(safeBridgePort)};
const DASHBOARD_CAPABILITY = ${serializeForInlineScript(safeDashboardCapability)};
const DATA = ${serializeForInlineScript(pinsData)};

let activeTab = 'open';
let selected = new Set(DATA.selections || []);

// ── Init ──
function init() {
  // Populate page filter
  const pages = [...new Set(DATA.open.map(p => p.pageTitle))];
  const pageSel = document.getElementById('filterPage');
  pages.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; pageSel.appendChild(o); });

  // Populate author filter
  const authors = [...new Set(DATA.open.map(p => p.author).filter(Boolean))];
  const authSel = document.getElementById('filterAuthor');
  authors.forEach(a => { const o = document.createElement('option'); o.value = a; o.textContent = a; authSel.appendChild(o); });

  // Stats
  document.getElementById('statOpen').textContent = DATA.summary.totalOpen;
  document.getElementById('statApproved').textContent = DATA.summary.totalApproved;
  document.getElementById('statResolved').textContent = DATA.summary.totalResolved;

  // Event listeners
  document.getElementById('filterPage').addEventListener('change', render);
  document.getElementById('filterAuthor').addEventListener('change', render);
  document.getElementById('searchBox').addEventListener('input', render);
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    activeTab = t.dataset.tab;
    render();
  }));
  document.getElementById('selectAll').addEventListener('change', (e) => {
    const visible = getVisiblePins();
    if (e.target.checked) visible.forEach(p => selected.add(p.id));
    else visible.forEach(p => selected.delete(p.id));
    render();
  });

  render();
}

function isReady(s) { return s === 'ready' || s === 'approved'; }
function getVisiblePins() {
  let pins;
  // 'approved' tab really means "implementation-ready" — accept the modern
  // 'ready' status too. Pre-rename-migration files used 'approved'; post-
  // migration uses 'ready'. Bot pins land as 'ready' by design.
  if (activeTab === 'approved') pins = DATA.open.filter(p => isReady(p.status));
  else if (activeTab === 'resolved') pins = DATA.resolved;
  else pins = DATA.open.filter(p => !isReady(p.status));
  const page = document.getElementById('filterPage').value;
  const author = document.getElementById('filterAuthor').value;
  const search = document.getElementById('searchBox').value.toLowerCase();

  return pins.filter(p => {
    const element = p.element || {};
    if (page && p.pageTitle !== page) return false;
    if (author && p.author !== author) return false;
    if (search && ![p.comment, p.id, element.selector, element.textContent].map(textValue).join('').toLowerCase().includes(search)) return false;
    return true;
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function textValue(value) { return value === undefined || value === null ? '' : String(value); }

function makeElement(tagName, className) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  return element;
}

function safeHttpHref(value) {
  try {
    const parsed = new URL(textValue(value));
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function messageClass(value) {
  return ['comment', 'code-note', 'resolution', 'decline', 'approval'].includes(value) ? value : 'comment';
}

function appendRichMessage(container, message) {
  const tokens = Array.isArray(message?.tokens) ? message.tokens : [];
  if (!tokens.length) {
    container.textContent = textValue(message?.plainText || message?.body);
    return;
  }
  for (const token of tokens) {
    if (!token || typeof token !== 'object') continue;
    if (token.type === 'text') {
      const lines = textValue(token.text).split('\\n');
      lines.forEach((line, index) => {
        if (index) container.appendChild(document.createElement('br'));
        container.appendChild(document.createTextNode(line));
      });
      continue;
    }
    const href = safeHttpHref(token.url);
    if (token.type === 'link') {
      if (!href) {
        container.appendChild(document.createTextNode(textValue(token.label || token.url)));
        continue;
      }
      const link = makeElement('a', 'rich-link');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = textValue(token.label || href);
      container.appendChild(link);
      continue;
    }
    if (token.type === 'image') {
      if (!href) {
        container.appendChild(document.createTextNode(textValue(token.alt || token.url)));
        continue;
      }
      const wrap = makeElement('span', 'rich-image-wrap');
      const link = makeElement('a', 'rich-image-link');
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      const image = makeElement('img', 'rich-image');
      image.src = href;
      image.alt = textValue(token.alt || 'Embedded image');
      image.loading = 'lazy';
      link.appendChild(image);
      wrap.appendChild(link);
      if (token.alt) {
        const caption = makeElement('span', 'rich-image-alt');
        caption.textContent = textValue(token.alt);
        wrap.appendChild(caption);
      }
      container.appendChild(wrap);
    }
  }
}

function appendBadge(parent, className, label) {
  const badge = makeElement('span', className);
  badge.textContent = label;
  parent.appendChild(badge);
}

function renderPin(pin) {
  const pinId = textValue(pin.id);
  const element = pin.element || {};
  const thread = Array.isArray(pin.thread) ? pin.thread : [];
  const isSelected = selected.has(pinId);
  const isResolved = pin.status === 'resolved';
  const isApproved = isReady(pin.status);
  const card = makeElement('div', 'pin-card' + (isSelected ? ' selected' : '') + (isResolved ? ' resolved-card' : ''));
  card.id = 'card-' + pinId;

  const header = makeElement('div', 'pin-header');
  if (!isResolved) {
    const checkbox = makeElement('input', 'pin-check');
    checkbox.type = 'checkbox';
    checkbox.checked = isSelected;
    checkbox.addEventListener('change', () => togglePin(pinId));
    header.appendChild(checkbox);
  }
  const body = makeElement('div', 'pin-body');
  const deepLink = safeHttpHref(pin.deepLink);
  const idLink = makeElement('a', 'pin-id');
  idLink.href = deepLink || '#';
  idLink.target = '_blank';
  idLink.rel = 'noopener noreferrer';
  idLink.textContent = pinId;
  body.appendChild(idLink);
  if (isApproved) appendBadge(body, 'badge approved-badge', 'Approved');
  else if (pin.action === 'implemented') appendBadge(body, 'badge implemented', 'Implemented');
  else if (isResolved) appendBadge(body, 'badge resolved-badge', 'Resolved');
  if (!isResolved && !isApproved) {
    const approve = makeElement('button', 'approve-btn');
    approve.type = 'button';
    approve.textContent = 'Approve';
    approve.addEventListener('click', () => approvePin(pinId));
    body.appendChild(approve);
  }
  const comment = makeElement('div', 'pin-comment');
  comment.textContent = textValue(pin.comment).split('\\n')[0].slice(0, 120) || '(no comment)';
  body.appendChild(comment);
  const meta = makeElement('div', 'pin-meta');
  const by = document.createElement('span');
  by.appendChild(document.createTextNode('by '));
  const author = makeElement('span', 'author');
  author.textContent = textValue(pin.author);
  by.appendChild(author);
  meta.appendChild(by);
  const created = document.createElement('span');
  created.textContent = timeAgo(pin.createdAt);
  meta.appendChild(created);
  const page = document.createElement('span');
  page.textContent = textValue(pin.pageTitle);
  meta.appendChild(page);
  if (thread.length > 1) {
    const count = document.createElement('span');
    count.textContent = thread.length + ' messages';
    meta.appendChild(count);
  }
  body.appendChild(meta);
  header.appendChild(body);
  card.appendChild(header);

  if (element.selector) {
    const pinElement = makeElement('div', 'pin-element');
    const selector = document.createElement('code');
    selector.textContent = textValue(element.selector);
    pinElement.appendChild(selector);
    if (element.textContent) {
      const content = makeElement('div', 'content');
      content.textContent = 'Content: "' + textValue(element.textContent).slice(0, 120) + '"';
      pinElement.appendChild(content);
    }
    if (pin.dynamicContext) {
      const dynamic = makeElement('div', 'dynamic');
      dynamic.textContent = '⚡ ' + textValue(pin.dynamicContext);
      pinElement.appendChild(dynamic);
    }
    card.appendChild(pinElement);
  }

  if (thread.length) {
    const threadElement = makeElement('div', 'thread');
    for (const message of thread) {
      const row = makeElement('div', 'thread-msg ' + messageClass(message?.type));
      const messageAuthor = makeElement('span', 'msg-author');
      messageAuthor.textContent = textValue(message?.author);
      row.appendChild(messageAuthor);
      const timestamp = makeElement('span', 'msg-time');
      try { timestamp.textContent = message?.timestamp ? new Date(message.timestamp).toLocaleString() : ''; } catch { timestamp.textContent = ''; }
      row.appendChild(timestamp);
      const threadBody = makeElement('div', 'thread-body');
      appendRichMessage(threadBody, message);
      row.appendChild(threadBody);
      threadElement.appendChild(row);
    }
    card.appendChild(threadElement);
  }
  return card;
}

function render() {
  const visible = getVisiblePins();
  const list = document.getElementById('pinList');

  document.getElementById('tabOpenCount').textContent = DATA.open.filter(p => !isReady(p.status)).length;
  document.getElementById('tabApprovedCount').textContent = DATA.open.filter(p => isReady(p.status)).length;
  document.getElementById('tabResolvedCount').textContent = DATA.resolved.length;
  document.getElementById('statSelected').textContent = selected.size;

  // Actions bar
  const bar = document.getElementById('actionsBar');
  if (selected.size > 0) {
    bar.style.display = 'flex';
    document.getElementById('selectedCount').textContent = selected.size;
  } else {
    bar.style.display = 'none';
  }

  if (visible.length === 0) {
    const empty = makeElement('div', 'empty');
    const title = document.createElement('h3');
    title.textContent = 'No pins here';
    const detail = document.createElement('p');
    detail.textContent = activeTab === 'open' ? 'Drop a pin using the Pincushion Chrome extension.' : 'No resolved pins yet.';
    empty.append(title, detail);
    list.replaceChildren(empty);
    return;
  }

  const cards = document.createDocumentFragment();
  visible.forEach(pin => cards.appendChild(renderPin(pin)));
  list.replaceChildren(cards);
}

function togglePin(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  render();
}

function clearSelections() { selected.clear(); render(); }

function dashboardHeaders(json = false) {
  const headers = {};
  if (json) headers['Content-Type'] = 'application/json';
  if (DASHBOARD_CAPABILITY) headers['X-Pincushion-Local-Capability'] = DASHBOARD_CAPABILITY;
  return headers;
}

async function approvePin(id) {
  try {
    const res = await fetch(\`http://127.0.0.1:\${BRIDGE_PORT}/approve-pin\`, {
      method: 'POST',
      headers: dashboardHeaders(true),
      body: JSON.stringify({ annotationId: id })
    });
    if (res.status === 202) {
      showToast('Approval outcome unknown — refresh before retrying');
      return false;
    }
    const outcome = await res.json().catch(() => null);
    if (res.ok && outcome && outcome.success === true) {
      // Update local data optimistically
      const pin = DATA.open.find(p => p.id === id);
      if (pin) {
        pin.status = 'approved';
        pin.approvedAt = new Date().toISOString();
      }
      render();
      showToast('Pin approved for implementation');
      return true;
    } else {
      showToast('Failed to approve — bridge returned error');
    }
  } catch {
    showToast('Bridge not running — approve via your agent: approve_pin');
  }
  return false;
}

async function approveSelected() {
  const ids = [...selected].filter(id => {
    const pin = DATA.open.find(p => p.id === id);
    return pin && pin.status !== 'approved';
  });
  if (ids.length === 0) { showToast('No unapproved pins selected'); return; }

  for (const id of ids) {
    if (!await approvePin(id)) return;
  }
  showToast(\`\${ids.length} pin(s) approved\`);
}

function copyCommand() {
  const ids = [...selected];
  const cmd = ids.length === 1
    ? \`Implement pin \${ids[0]}: read its thread in .feedback/PINS.md, make the change, then call fix_and_resolve.\`
    : \`Implement these \${ids.length} pins in order: \${ids.join(', ')}. For each, read its context in .feedback/PINS.md, make the change, then call fix_and_resolve.\`;
  navigator.clipboard.writeText(cmd).then(() => showToast('Copied to clipboard!'));
}

async function sendToAgent() {
  const ids = [...selected];
  try {
    const res = await fetch(\`http://127.0.0.1:\${BRIDGE_PORT}/select-pins\`, {
      method: 'POST',
      headers: dashboardHeaders(true),
      body: JSON.stringify({ selectedPins: ids, timestamp: new Date().toISOString() })
    });
    if (res.ok) {
      showToast(\`\${ids.length} pin(s) queued for agent — check your IDE\`);
    } else {
      showToast('Saved locally — paste the agent command into your IDE');
      // Fallback: copy to clipboard
      copyCommand();
    }
  } catch {
    showToast('Bridge not running — command copied to clipboard');
    copyCommand();
  }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 3000);
}

init();

// ── Supabase Realtime live-refresh ──
// For Pro/Team: auto-refresh dashboard when annotations change in real time.
// Falls back to periodic polling (30s) on free tier.
(function() {
  const REFRESH_INTERVAL_FREE = 30000;
  let realtimeActive = false;

  // Attempt Realtime connection via bridge server
  async function tryRealtimeRefresh() {
    try {
      const resp = await fetch('http://127.0.0.1:' + BRIDGE_PORT + '/health', {
        headers: dashboardHeaders(),
      });
      if (!resp.ok) return false;
      // Bridge is alive — use it for change detection
      // We poll bridge /status quickly since Realtime handles server-side notifications
      return true;
    } catch { return false; }
  }

  // Smart refresh: reload page data without full page reload
  async function softRefresh() {
    try {
      const resp = await fetch('http://127.0.0.1:' + BRIDGE_PORT + '/call-tool', {
        method: 'POST',
        headers: dashboardHeaders(true),
        body: JSON.stringify({ toolName: 'get_feedback_summary', args: {} })
      });
      if (resp.status === 200) {
        // Full reload to pick up new data — simple and reliable
        location.reload();
      }
    } catch { /* bridge offline — skip refresh */ }
  }

  // Start polling as baseline (works on all tiers)
  setInterval(softRefresh, REFRESH_INTERVAL_FREE);

  // Show live indicator if bridge is reachable
  tryRealtimeRefresh().then(ok => {
    if (ok) {
      const liveEl = document.querySelector('.live-indicator');
      if (liveEl) liveEl.style.display = 'flex';
    }
  });
})();
</script>
</body>
</html>`;
}

// Write dashboard.html to disk. It contains the process-bound dashboard
// capability when generated by server.js, so it must never inherit a broader
// mode from an older dashboard file.
export async function writeDashboardHtml(config, fetchRemote = null, bridgePort = 3456, dashboardCapability = '') {
  const html = await generateDashboardHtml(config, fetchRemote, bridgePort, dashboardCapability);
  const htmlPath = join(config.feedbackDir, 'dashboard.html');
  if (!existsSync(config.feedbackDir)) mkdirSync(config.feedbackDir, { recursive: true });
  // Write a new owner-only inode before replacing the previous dashboard. A
  // direct overwrite of an older world-readable file could expose a freshly
  // rotated dashboard capability between writeFile() and chmod().
  const tempPath = htmlPath + '.' + process.pid + '.' + randomBytes(12).toString('hex') + '.tmp';
  try {
    await writeFile(tempPath, html, { encoding: 'utf8', mode: 0o600 });
    await chmod(tempPath, 0o600);
    await rename(tempPath, htmlPath);
  } catch (error) {
    await unlink(tempPath).catch(() => {});
    throw error;
  }
  return htmlPath;
}

// Read the current selections file
export async function readSelections(config) {
  try {
    const selectionsPath = join(config.feedbackDir, 'selections.json');
    if (existsSync(selectionsPath)) {
      return JSON.parse(await readFile(selectionsPath, 'utf-8'));
    }
  } catch { /* no selections */ }
  return { selectedPins: [], timestamp: null };
}

// Write selections file
export async function writeSelections(config, data) {
  const selectionsPath = join(config.feedbackDir, 'selections.json');
  if (!existsSync(config.feedbackDir)) mkdirSync(config.feedbackDir, { recursive: true });
  await writeFile(selectionsPath, JSON.stringify(data, null, 2));
  return selectionsPath;
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Write PINS.md to disk in the feedback directory
export async function writePinsFile(config, fetchRemote = null) {
  const md = await generatePinsMarkdown(config, fetchRemote);
  const pinsPath = join(config.feedbackDir, 'PINS.md');
  if (!existsSync(config.feedbackDir)) mkdirSync(config.feedbackDir, { recursive: true });
  await writeFile(pinsPath, md);
  return pinsPath;
}
