// Client-side contract helpers for the commit-ordered annotation journal.
//
// This module contains no network or filesystem access. Keeping state parsing
// and event merging pure makes the durable cursor boundary easy to test and
// prevents an untrusted cloud response from becoming a local authorization
// decision.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REVISION_RE = /^(?:0|[1-9][0-9]{0,18})$/;
const MAX_REVISION = 9_223_372_036_854_775_807n;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function revision(value) {
  if (typeof value !== 'string' || !REVISION_RE.test(value)) return null;
  try { return BigInt(value) <= MAX_REVISION ? value : null; } catch { return null; }
}

function boundedString(value, max) {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

export const ANNOTATION_SYNC_STATE_VERSION = 1;

export function parseAnnotationSyncState(value) {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value).sort();
  const allowed = ['cursor', 'licenseId', 'syncVersion', 'version'];
  if (keys.some((key, index) => key !== allowed[index])) return null;
  if (value.version !== ANNOTATION_SYNC_STATE_VERSION ||
      typeof value.licenseId !== 'string' || !UUID_RE.test(value.licenseId) ||
      typeof value.syncVersion !== 'string' || !revision(value.syncVersion) ||
      (value.cursor !== null && (typeof value.cursor !== 'string' || value.cursor.length < 3 || value.cursor.length > 4096))) {
    return null;
  }
  return Object.freeze({
    version: ANNOTATION_SYNC_STATE_VERSION,
    licenseId: value.licenseId.toLowerCase(),
    syncVersion: value.syncVersion,
    cursor: value.cursor,
  });
}

export function buildAnnotationSyncState({ licenseId, syncVersion, cursor = null } = {}) {
  const parsed = parseAnnotationSyncState({
    version: ANNOTATION_SYNC_STATE_VERSION,
    licenseId,
    syncVersion,
    cursor,
  });
  if (!parsed) throw new Error('annotation_sync_state_invalid');
  return parsed;
}

export function annotationSyncRequestPlan(state) {
  const parsed = parseAnnotationSyncState(state);
  if (!parsed) return null;
  const params = new URLSearchParams({ sync_cursor: '1' });
  if (parsed.cursor) params.set('cursor', parsed.cursor);
  else params.set('after_revision', parsed.syncVersion);
  return Object.freeze({ mode: 'journal', params, state: parsed });
}

function safeMessage(value) {
  if (!isRecord(value)) return null;
  const id = boundedString(value.id, 200);
  if (!id) return null;
  const message = { id };
  for (const [source, target, max] of [
    ['author', 'author', 500],
    ['authorEmail', 'authorEmail', 500],
    ['author_email', 'authorEmail', 500],
    ['authorAvatar', 'authorAvatar', 2_000],
    ['author_avatar', 'authorAvatar', 2_000],
    ['timestamp', 'timestamp', 100],
    ['body', 'body', 8_000],
    ['type', 'type', 80],
    ['editedAt', 'editedAt', 100],
    ['edited_at', 'editedAt', 100],
    ['deletedAt', 'deletedAt', 100],
    ['deleted_at', 'deletedAt', 100],
  ]) {
    if (message[target] !== undefined || typeof value[source] !== 'string') continue;
    message[target] = value[source].slice(0, max);
  }
  if (typeof value.isBot === 'boolean') message.isBot = value.isBot;
  else if (typeof value.is_bot === 'boolean') message.isBot = value.is_bot;
  if (Array.isArray(value.attachments)) {
    message.attachments = value.attachments.slice(0, 5).filter(isRecord).map((attachment) => {
      const result = {};
      if (typeof attachment.id === 'string') result.id = attachment.id.slice(0, 200);
      if (typeof attachment.mime === 'string') result.mime = attachment.mime.slice(0, 200);
      if (typeof attachment.name === 'string') result.name = attachment.name.slice(0, 500);
      if (Number.isSafeInteger(attachment.size) && attachment.size >= 0) result.size = attachment.size;
      return result;
    });
  }
  return message;
}

export function mergeAnnotationThread(existing, delta = [], full = null) {
  const byId = new Map();
  const order = [];
  const add = (candidate) => {
    const message = safeMessage(candidate);
    if (!message) return;
    if (!byId.has(message.id)) order.push(message.id);
    byId.set(message.id, { ...(byId.get(message.id) || {}), ...message });
  };
  if (Array.isArray(existing)) existing.forEach(add);
  if (Array.isArray(full)) {
    byId.clear();
    order.length = 0;
    full.forEach(add);
  }
  if (Array.isArray(delta)) {
    for (const candidate of delta) {
      const message = safeMessage(candidate);
      if (!message) continue;
      if (candidate.deleted === true || message.deletedAt) {
        byId.delete(message.id);
        continue;
      }
      if (!byId.has(message.id)) order.push(message.id);
      byId.set(message.id, { ...(byId.get(message.id) || {}), ...message });
    }
  }
  return order.filter((id) => byId.has(id)).map((id) => byId.get(id));
}

function annotationField(value, snake, camel) {
  if (!isRecord(value)) return undefined;
  return value[camel] !== undefined ? value[camel] : value[snake];
}

export function journalAnnotationToLocal(value, { existing = null, messageDelta = [], hydration = null } = {}) {
  if (!isRecord(value)) return null;
  const id = boundedString(annotationField(value, 'id', 'id'), 200);
  const projectId = boundedString(annotationField(value, 'project_id', 'projectId'), 512);
  const pageUrl = boundedString(annotationField(value, 'page_url', 'pageUrl'), 8192);
  if (!id || !projectId || !pageUrl) return null;
  const result = existing && isRecord(existing) ? { ...existing } : {};
  const fields = [
    ['page_title', 'pageTitle'], ['element', 'element'], ['pin', 'pin'],
    ['status', 'status'], ['priority', 'priority'], ['visibility', 'visibility'], ['tags', 'tags'],
    ['author', 'author'], ['author_email', 'authorEmail'], ['author_avatar', 'authorAvatar'],
    ['author_class', 'authorClass'], ['is_bot', 'isBot'], ['action', 'action'],
    ['implementer', 'implementer'], ['implemented_at', 'implementedAt'],
    ['commit_sha', 'commitSha'], ['branch_name', 'branchName'], ['pr_url', 'prUrl'],
    ['deploy_url', 'deployUrl'], ['deployed_at', 'deployedAt'],
    ['verification_status', 'verificationStatus'], ['verification_notes', 'verificationNotes'],
    ['verified_at', 'verifiedAt'], ['viewport', 'viewport'], ['dom_snippet', 'domSnippet'],
    ['likely_files', 'likelyFiles'], ['acceptance_criteria', 'acceptanceCriteria'],
    ['screenshot_url', 'screenshotUrl'], ['viewport_screenshot_url', 'viewportScreenshotUrl'],
    ['ready_at', 'readyAt'], ['ready_by', 'readyBy'], ['resolved_at', 'resolvedAt'],
    ['dismissed_at', 'dismissedAt'], ['dismissed_by', 'dismissedBy'],
    ['created_at', 'createdAt'], ['updated_at', 'updatedAt'],
  ];
  for (const [snake, camel] of fields) {
    const candidate = annotationField(value, snake, camel);
    if (candidate !== undefined) result[camel] = candidate;
  }
  result.id = id;
  result.projectId = projectId;
  result.pageUrl = pageUrl;
  const fullThread = hydration && Array.isArray(hydration.messages) ? hydration.messages : null;
  result.thread = mergeAnnotationThread(result.thread, messageDelta, fullThread);
  return result;
}

export function journalChangeScope(change) {
  if (!isRecord(change)) return null;
  const after = isRecord(change.after) ? change.after : null;
  const before = isRecord(change.before) ? change.before : null;
  const source = after || before || {};
  const projectId = boundedString(change.projectId || change.project_id || source.projectId || source.project_id, 512);
  const pageUrl = boundedString(source.pageUrl || source.page_url, 8192);
  const annotationId = boundedString(change.annotationId || change.annotation_id || source.id, 200);
  if (!projectId || !pageUrl || !annotationId) return null;
  return Object.freeze({ projectId, pageUrl, annotationId });
}

export function mergeJournalChange(existing, change, hydration = null) {
  if (!isRecord(change)) return { annotation: null, deleted: false };
  const deleted = change.deletion === true || !change.after;
  if (deleted) return { annotation: null, deleted: true };
  const after = change.after;
  const delta = Array.isArray(change.messageDelta)
    ? change.messageDelta
    : isRecord(after) && Array.isArray(after.message_delta) ? after.message_delta : [];
  const full = hydration && isRecord(hydration) && Array.isArray(hydration.messages)
    ? hydration.messages
    : null;
  return {
    annotation: journalAnnotationToLocal(after, {
      existing,
      messageDelta: delta,
      hydration: full ? { messages: full } : hydration,
    }),
    deleted: false,
  };
}

// Bootstrap and journal envelopes share canonical changes, but a bootstrap
// continuation must stay on the same materialized boundary and account.
export function validateAnnotationSyncPage(page, { mode = 'journal', previous = null, cursors = [] } = {}) {
  if (!isRecord(page) || page.syncMode !== (mode === 'bootstrap' ? 'bootstrap' : 'events') ||
      typeof page.hasMore !== 'boolean' || !Array.isArray(page.changes) || !Array.isArray(page.hydrations) ||
      !Array.isArray(page.projects) || (!Object.hasOwn(page, 'nextCursor') || (page.nextCursor !== null && typeof page.nextCursor !== 'string')) || (mode === 'bootstrap' && page.hasMore && page.changes.length === 0)) throw new Error('annotation_sync_page_invalid');
  const state = buildAnnotationSyncState({ licenseId: page.licenseId, syncVersion: page.syncVersion, cursor: page.nextCursor });
  if (page.hasMore !== Boolean(state.cursor) || (state.cursor && cursors.includes(state.cursor))) throw new Error('annotation_sync_cursor_invalid');
  if (previous && (state.licenseId !== previous.licenseId ||
      (mode === 'bootstrap' ? state.syncVersion !== previous.syncVersion : BigInt(state.syncVersion) < BigInt(previous.syncVersion)))) throw new Error('annotation_sync_boundary_invalid');
  const hydrations = new Map();
  for (const hydration of page.hydrations) {
    const id = hydration?.annotationId || hydration?.annotation_id;
    if (!id || hydrations.has(id) || !Array.isArray(hydration.messages) || !isRecord(hydration.annotation) || hydration.annotation.id !== id) throw new Error('annotation_sync_hydration_invalid');
    hydrations.set(id, hydration);
  }
  const seen = [];
  for (const change of page.changes) {
    const scope = journalChangeScope(change);
    if (!scope || (change.after && change.after.id !== scope.annotationId)) throw new Error('annotation_sync_change_invalid');
    if (mode === 'bootstrap') {
      const hydration = hydrations.get(scope.annotationId);
      if (change.deletion === true || !change.after || !hydration ||
          seen.some(e => e.annotationId === scope.annotationId) ||
          journalChangeScope({ after: hydration.annotation })?.projectId !== scope.projectId ||
          journalChangeScope({ after: hydration.annotation })?.pageUrl !== scope.pageUrl) throw new Error('annotation_sync_bootstrap_hydration_invalid');
      seen.push(scope);
    }
  }
  if (mode === 'bootstrap' && hydrations.size !== seen.length) throw new Error('annotation_sync_bootstrap_hydration_invalid');
  return { state, seen };
}
