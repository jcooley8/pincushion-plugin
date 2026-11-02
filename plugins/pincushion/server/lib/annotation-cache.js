// Versioned, scope-bound annotation cache.
//
// Legacy annotation files were keyed by a lossy URL slug. This module keeps
// those files intact for recovery, but makes every authoritative cache record
// addressable only by the exact project ID and exact page URL that produced it.
// It contains no network client: migration never uploads, repairs, or guesses
// a legacy record's missing identity.

import { runAnnotationSyncCommit } from './annotation-sync-fence.js';
import { createHash, randomUUID } from 'crypto';
import { open, lstat, mkdir, readdir, readFile, rename, rm } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { acquirePinsRefreshLease } from './pins-refresh.js';

export const ANNOTATION_BOOTSTRAP_FILE = '.bootstrap-state.json';
export const ANNOTATION_CACHE_VERSION = 2;

export async function annotationBootstrapActive(annotationsDir) {
  if (typeof annotationsDir !== 'string') return false;
  return Boolean(await statOrNull(join(annotationsDir, ANNOTATION_BOOTSTRAP_FILE)));
}
async function assertBootstrapWriteAllowed(annotationsDir, bootstrapAccess) {
  if (!bootstrapAccess && await annotationBootstrapActive(annotationsDir)) throw cacheError('annotation_sync_bootstrap_pending');
}
export const ANNOTATION_CACHE_ROOT = 'v2';
const MANIFEST_FILE = '.manifest.json';
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_LEGACY_FILES = 4096;
const DEFAULT_LEASE_TTL_MS = 60_000;
const DEFAULT_SCOPE_UPDATE_WAIT_MS = 2_000;
const HEX_SHA256 = /^[a-f0-9]{64}$/;

function cacheError(code, message = code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function positiveDuration(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireLeaseWithCreationRaceRetry(options, { retries = 3 } = {}) {
  // The shared directory-token primitive atomically owns an existing lease,
  // but a second process can observe its just-created empty lease directory
  // before its token file is written. In that narrow window it may reclaim
  // the directory, leaving the first create's utime with ENOENT. No owner has
  // reached a critical section yet, so a few bounded retries are sufficient
  // to convert that transient into the ordinary acquired/busy result.
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await acquirePinsRefreshLease(options);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      lastError = error;
      if (attempt < retries) await delay(Math.max(5, (attempt + 1) * 5));
    }
  }
  throw lastError;
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function exactProjectId(value) {
  if (typeof value !== 'string' || !value || value.length > 512 || value.trim() !== value) {
    throw cacheError('annotation_cache_scope_invalid', 'projectId must be a non-empty exact string.');
  }
  return value;
}

function exactPageUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192 || value.trim() !== value) {
    throw cacheError('annotation_cache_scope_invalid', 'pageUrl must be a non-empty exact URL string.');
  }
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
      throw cacheError('annotation_cache_scope_invalid', 'pageUrl must use http or https and include a hostname.');
    }
  } catch (error) {
    if (error?.code === 'annotation_cache_scope_invalid') throw error;
    throw cacheError('annotation_cache_scope_invalid', 'pageUrl must be a valid http(s) URL.');
  }
  // Do not use URL#toString() here. Query strings, fragments, casing, and
  // trailing slashes are part of the caller's exact page identity.
  return value;
}

export function annotationCacheScope({ projectId, pageUrl } = {}) {
  const exactProject = exactProjectId(projectId);
  const exactPage = exactPageUrl(pageUrl);
  const scopeHash = sha256(`pincushion-annotation-cache-v2\0${exactProject}\0${exactPage}`);
  const projectHash = sha256(`pincushion-annotation-cache-v2-project\0${exactProject}`);
  return {
    projectId: exactProject,
    pageUrl: exactPage,
    scopeHash,
    projectHash,
    entryKey: `v2:${scopeHash}`,
  };
}

export function annotationCachePath(annotationsDir, scope) {
  if (!annotationsDir || typeof annotationsDir !== 'string') {
    throw cacheError('annotation_cache_directory_invalid', 'annotationsDir is required.');
  }
  const normalized = annotationCacheScope(scope);
  return {
    ...normalized,
    root: join(annotationsDir, ANNOTATION_CACHE_ROOT),
    directory: join(annotationsDir, ANNOTATION_CACHE_ROOT, normalized.projectHash),
    file: join(annotationsDir, ANNOTATION_CACHE_ROOT, normalized.projectHash, `${normalized.scopeHash}.json`),
  };
}

export function pageUrlFromAnnotationEntry(entryKey, pageData) {
  return typeof pageData?.pageUrl === 'string' && pageData.pageUrl
    ? pageData.pageUrl
    : entryKey;
}

export function findAnnotationPage(allData, { projectId, pageUrl } = {}) {
  const scope = annotationCacheScope({ projectId, pageUrl });
  for (const [entryKey, pageData] of Object.entries(allData || {})) {
    if (pageUrlFromAnnotationEntry(entryKey, pageData) !== scope.pageUrl) continue;
    const pageProjectId = typeof pageData?.projectId === 'string' ? pageData.projectId : null;
    if (pageProjectId === scope.projectId) return pageData;
    const rows = Array.isArray(pageData?.annotations) ? pageData.annotations : [];
    if (rows.length > 0 && rows.every((row) => row?.projectId === scope.projectId && row?.pageUrl === scope.pageUrl)) {
      return pageData;
    }
  }
  return null;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertScopedRows(pageData, scope) {
  if (!pageData || typeof pageData !== 'object' || Array.isArray(pageData) ||
      pageData.pageUrl !== scope.pageUrl || !Array.isArray(pageData.annotations)) {
    throw cacheError('annotation_cache_record_invalid', 'Cache page data does not match its requested scope.');
  }
  if (Object.prototype.hasOwnProperty.call(pageData, 'projectId') && pageData.projectId !== scope.projectId) {
    throw cacheError('annotation_cache_record_invalid', 'Cache page data has a conflicting projectId.');
  }
  for (const annotation of pageData.annotations) {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation) ||
        annotation.projectId !== scope.projectId || annotation.pageUrl !== scope.pageUrl) {
      throw cacheError('annotation_cache_record_invalid', 'Every cached annotation must carry the exact page and project scope.');
    }
    if (Object.prototype.hasOwnProperty.call(annotation, 'project_id') && annotation.project_id !== scope.projectId) {
      throw cacheError('annotation_cache_record_invalid', 'A cached annotation has conflicting project scope aliases.');
    }
  }
}

function makeCacheRecord(pageData, scope) {
  assertScopedRows(pageData, scope);
  const record = cloneJson(pageData);
  record.cacheVersion = ANNOTATION_CACHE_VERSION;
  record.projectId = scope.projectId;
  record.pageUrl = scope.pageUrl;
  record.scope = {
    projectId: scope.projectId,
    pageUrl: scope.pageUrl,
    scopeHash: scope.scopeHash,
  };
  return record;
}

function validateCacheRecord(record, expectedScope) {
  if (!record || typeof record !== 'object' || Array.isArray(record) ||
      record.cacheVersion !== ANNOTATION_CACHE_VERSION ||
      record.projectId !== expectedScope.projectId || record.pageUrl !== expectedScope.pageUrl ||
      record.scope?.projectId !== expectedScope.projectId || record.scope?.pageUrl !== expectedScope.pageUrl ||
      record.scope?.scopeHash !== expectedScope.scopeHash) {
    throw cacheError('annotation_cache_record_invalid', 'A versioned annotation cache record does not match its path scope.');
  }
  assertScopedRows(record, expectedScope);
  return record;
}

async function statOrNull(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureDirectory(path) {
  const existing = await statOrNull(path);
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw cacheError('annotation_cache_directory_invalid', `Refusing non-directory cache path ${path}.`);
    }
    return;
  }
  await mkdir(path, { recursive: true, mode: 0o700 });
  const created = await statOrNull(path);
  if (!created?.isDirectory() || created.isSymbolicLink()) {
    throw cacheError('annotation_cache_directory_invalid', `Refusing non-directory cache path ${path}.`);
  }
}

async function verifyScopedProjectDirectory(location) {
  const info = await statOrNull(location.directory);
  if (!info) return false;
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw cacheError('annotation_cache_record_invalid', 'Versioned cache project scope is not a local directory.');
  }
  return true;
}

async function readBoundedJson(path, { absent = null } = {}) {
  const info = await statOrNull(path);
  if (!info) return absent;
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) {
    throw cacheError('annotation_cache_record_invalid', `Refusing invalid cache file ${basename(path)}.`);
  }
  let text;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw cacheError('annotation_cache_record_invalid', `Unable to read cache file ${basename(path)}: ${error?.message || 'read failed'}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw cacheError('annotation_cache_record_invalid', `Unable to parse cache file ${basename(path)}.`);
  }
}

async function syncDirectory(path) {
  try {
    const handle = await open(path, 'r');
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Rename is still atomic on the local filesystem. Some filesystems do not
    // permit directory fsync, so do not turn a successful atomic activation
    // into a destructive cleanup path solely because that durability hint is
    // unavailable.
  }
}

function startLeaseHeartbeat(lease, {
  ttlMs,
  lostCode,
  onLeaseRenew,
} = {}) {
  const ttl = positiveDuration(ttlMs, DEFAULT_LEASE_TTL_MS);
  const intervalMs = Math.max(10, Math.min(10_000, Math.floor(ttl / 3)));
  let stopped = false;
  let lost = false;
  let renewal = Promise.resolve(true);

  const renew = () => {
    renewal = renewal.catch(() => false).then(async () => {
      if (lost || stopped) return !lost;
      let renewed = false;
      try { renewed = await lease.renew(); } catch { renewed = false; }
      if (!renewed) lost = true;
      try { await onLeaseRenew?.({ renewed }); } catch { /* test/report hooks cannot affect the lock */ }
      return renewed;
    });
    return renewal;
  };

  const timer = setInterval(() => { void renew(); }, intervalMs);
  timer.unref?.();
  return {
    async assertOwned() {
      if (!await renew()) {
        throw cacheError(lostCode || 'annotation_cache_lease_lost', 'Annotation cache lock ownership was lost before activation.');
      }
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await renewal.catch(() => {});
    },
  };
}

async function writeAtomicJson(path, value) {
  const parent = dirname(path);
  await ensureDirectory(parent);
  const temporary = join(parent, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle = null;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, path);
    await syncDirectory(parent);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

function manifestForMigration({ migrated, preserved }) {
  return {
    cacheVersion: ANNOTATION_CACHE_VERSION,
    state: 'active',
    layout: 'project-sha256/scope-sha256.json',
    migratedAt: new Date().toISOString(),
    migrated,
    preserved,
  };
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) ||
      manifest.cacheVersion !== ANNOTATION_CACHE_VERSION || manifest.state !== 'active' ||
      manifest.layout !== 'project-sha256/scope-sha256.json' ||
      !Array.isArray(manifest.migrated) || !Array.isArray(manifest.preserved)) {
    throw cacheError('annotation_cache_activation_invalid', 'The versioned annotation cache activation manifest is invalid.');
  }
  return manifest;
}

async function activeManifest(annotationsDir) {
  const root = join(annotationsDir, ANNOTATION_CACHE_ROOT);
  const rootInfo = await statOrNull(root);
  if (!rootInfo) return null;
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw cacheError('annotation_cache_activation_invalid', 'The versioned annotation cache root is invalid.');
  }
  const manifest = await readBoundedJson(join(root, MANIFEST_FILE));
  return validateManifest(manifest);
}

function legacyScope(pageData) {
  if (!pageData || typeof pageData !== 'object' || Array.isArray(pageData) || !Array.isArray(pageData.annotations)) {
    throw cacheError('legacy_annotation_invalid', 'Legacy file is not an annotation page.');
  }
  const pageUrl = exactPageUrl(pageData.pageUrl);
  if (!pageData.annotations.length) {
    throw cacheError('legacy_annotation_ambiguous', 'Legacy file has no project-scoped annotations.');
  }
  const projectIds = new Set();
  for (const annotation of pageData.annotations) {
    if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation) || annotation.pageUrl !== pageUrl) {
      throw cacheError('legacy_annotation_invalid', 'Legacy file has a row with a mismatched page URL.');
    }
    const projectId = exactProjectId(annotation.projectId);
    if (Object.prototype.hasOwnProperty.call(annotation, 'project_id') && annotation.project_id !== projectId) {
      throw cacheError('legacy_annotation_invalid', 'Legacy file has conflicting project ID aliases.');
    }
    projectIds.add(projectId);
  }
  if (projectIds.size !== 1) {
    throw cacheError('legacy_annotation_ambiguous', 'Legacy file contains more than one project scope.');
  }
  const projectId = [...projectIds][0];
  if (Object.prototype.hasOwnProperty.call(pageData, 'projectId') && pageData.projectId !== projectId) {
    throw cacheError('legacy_annotation_invalid', 'Legacy file has a conflicting page projectId.');
  }
  return annotationCacheScope({ projectId, pageUrl });
}

async function collectLegacyFiles(annotationsDir, { onProgress = async () => {} } = {}) {
  const entries = await readdir(annotationsDir, { withFileTypes: true }).catch((error) => {
    if (error?.code === 'ENOENT') return [];
    throw error;
  });
  const files = entries
    .filter((entry) => entry.name.endsWith('.json') && entry.name !== MANIFEST_FILE)
    .sort((a, b) => a.name.localeCompare(b.name));
  if (files.length > MAX_LEGACY_FILES) {
    throw cacheError('annotation_cache_migration_limit', 'Too many legacy annotation files to migrate safely.');
  }

  const candidates = [];
  const preserved = [];
  for (const entry of files) {
    await onProgress();
    const source = join(annotationsDir, entry.name);
    if (!entry.isFile() || entry.isSymbolicLink()) {
      preserved.push({ file: entry.name, reason: 'not_regular_file' });
      continue;
    }
    let text;
    let sourceHash = null;
    try {
      const info = await lstat(source);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_RECORD_BYTES) {
        preserved.push({ file: entry.name, reason: 'invalid_size_or_type' });
        continue;
      }
      text = await readFile(source, 'utf8');
      sourceHash = sha256(text);
    } catch {
      preserved.push({ file: entry.name, reason: 'unreadable' });
      continue;
    }
    let pageData;
    try {
      pageData = JSON.parse(text);
    } catch {
      preserved.push({ file: entry.name, sha256: sourceHash, reason: 'malformed_json' });
      continue;
    }
    try {
      const scope = legacyScope(pageData);
      candidates.push({ file: entry.name, sha256: sourceHash, pageData, scope });
    } catch (error) {
      preserved.push({ file: entry.name, sha256: sourceHash, reason: error?.code || 'invalid_scope' });
    }
  }

  const conflicts = new Set();
  const seen = new Map();
  for (const candidate of candidates) {
    const previous = seen.get(candidate.scope.scopeHash);
    if (previous) {
      conflicts.add(previous.file);
      conflicts.add(candidate.file);
    } else {
      seen.set(candidate.scope.scopeHash, candidate);
    }
  }
  const migratable = candidates.filter((candidate) => !conflicts.has(candidate.file));
  for (const candidate of candidates.filter((candidate) => conflicts.has(candidate.file))) {
    preserved.push({ file: candidate.file, sha256: candidate.sha256, reason: 'conflicting_scope' });
  }
  await onProgress();
  return { migratable, preserved };
}

async function createStage(annotationsDir) {
  const stage = join(annotationsDir, `.${ANNOTATION_CACHE_ROOT}-stage-${randomUUID()}`);
  await mkdir(stage, { mode: 0o700 });
  return stage;
}

async function writeStageRecord(stage, candidate) {
  const target = join(stage, candidate.scope.projectHash, `${candidate.scope.scopeHash}.json`);
  const record = makeCacheRecord(candidate.pageData, candidate.scope);
  await writeAtomicJson(target, record);
  return {
    file: candidate.file,
    sha256: candidate.sha256,
    scopeHash: candidate.scope.scopeHash,
  };
}

// Migrate all legacy root-level records as one activation. Source files are
// never renamed, removed, repaired, or uploaded. An invalid, ambiguous, or
// conflicting source remains exactly where it was and is recorded only as a
// preservation disposition in the active v2 manifest.
export async function migrateLegacyAnnotationCache({
  annotationsDir,
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  tokenFactory,
  clock,
  onLeaseRenew,
  onBeforeActivate,
} = {}) {
  if (!annotationsDir || typeof annotationsDir !== 'string') {
    throw cacheError('annotation_cache_directory_invalid', 'annotationsDir is required.');
  }
  await ensureDirectory(annotationsDir);
  const alreadyActive = await activeManifest(annotationsDir);
  if (alreadyActive) return { status: 'already_active', manifest: alreadyActive };

  // The existing directory-token lease uses atomic mkdir plus rename-before-
  // removal for stale owners. Keeping migration under that proven primitive
  // prevents two processes from exposing interleaved v2 trees.
  const ttl = positiveDuration(leaseTtlMs, DEFAULT_LEASE_TTL_MS);
  const lease = await acquireLeaseWithCreationRaceRetry({
    feedbackDir: annotationsDir,
    ttlMs: ttl,
    ...(tokenFactory ? { tokenFactory } : {}),
    ...(typeof clock === 'function' ? { clock } : {}),
  });
  if (!lease.acquired) {
    throw cacheError('annotation_cache_migration_busy', 'Another process is migrating this annotation cache.');
  }

  let stage = null;
  const heartbeat = startLeaseHeartbeat(lease, {
    ttlMs: ttl,
    lostCode: 'annotation_cache_migration_lease_lost',
    onLeaseRenew,
  });
  try {
    const activeAfterLease = await activeManifest(annotationsDir);
    if (activeAfterLease) return { status: 'already_active', manifest: activeAfterLease };

    await heartbeat.assertOwned();
    const { migratable, preserved } = await collectLegacyFiles(annotationsDir, {
      onProgress: () => heartbeat.assertOwned(),
    });
    await heartbeat.assertOwned();
    stage = await createStage(annotationsDir);
    const migrated = [];
    for (const candidate of migratable) {
      await heartbeat.assertOwned();
      migrated.push(await writeStageRecord(stage, candidate));
    }
    await heartbeat.assertOwned();
    const manifest = manifestForMigration({ migrated, preserved: preserved.sort((a, b) => a.file.localeCompare(b.file)) });
    await writeAtomicJson(join(stage, MANIFEST_FILE), manifest);
    if (typeof onBeforeActivate === 'function') await onBeforeActivate({ stage, manifest });

    // No owner may publish a stage after its renewable token disappeared or
    // was replaced. The private stage is removed below, leaving legacy bytes
    // untouched for a later clean migration attempt.
    await heartbeat.assertOwned();
    const root = join(annotationsDir, ANNOTATION_CACHE_ROOT);
    try {
      await rename(stage, root);
    } catch (error) {
      if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') {
        const concurrentManifest = await activeManifest(annotationsDir);
        if (concurrentManifest) return { status: 'already_active', manifest: concurrentManifest };
      }
      throw error;
    }
    await syncDirectory(annotationsDir);
    stage = null;
    return { status: 'migrated', manifest };
  } finally {
    if (stage) await rm(stage, { recursive: true, force: true }).catch(() => {});
    await heartbeat.stop();
    await lease.release();
  }
}

export async function ensureVersionedAnnotationCache({
  waitMs = 2_000,
  pollMs = 25,
  ...migrationOptions
} = {}) {
  try {
    return await migrateLegacyAnnotationCache(migrationOptions);
  } catch (error) {
    if (error?.code !== 'annotation_cache_migration_busy') throw error;
  }
  // A concurrent writer must never bypass an in-flight migration by falling
  // back to a legacy slug. Wait briefly for the one atomic activation, then
  // surface the busy state if its owner does not finish in a bounded window.
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  const interval = Math.max(5, Math.min(250, Number(pollMs) || 25));
  while (Date.now() <= deadline) {
    const manifest = await activeManifest(migrationOptions.annotationsDir);
    if (manifest) return { status: 'waited_for_active', manifest };
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
  throw cacheError('annotation_cache_migration_busy', 'Another process is still migrating this annotation cache.');
}

export async function readScopedAnnotationPage({ annotationsDir, projectId, pageUrl, bootstrapAccess = false } = {}) {
  if (!bootstrapAccess && await annotationBootstrapActive(annotationsDir)) return null;
  const location = annotationCachePath(annotationsDir, { projectId, pageUrl });
  const manifest = await activeManifest(annotationsDir);
  if (!manifest) return null;
  // `readBoundedJson()` protects the final record itself, but lstat on that
  // leaf would otherwise follow a symlinked project directory. Verify every
  // path component that this reader owns before opening the record.
  if (!await verifyScopedProjectDirectory(location)) return null;
  const record = await readBoundedJson(location.file);
  if (record === null) return null;
  if (!bootstrapAccess && await annotationBootstrapActive(annotationsDir)) return null;
  return validateCacheRecord(record, location);
}

async function writeScopedRecord(location, pageData) {
  await ensureDirectory(location.directory);
  const record = makeCacheRecord(pageData, location);
  await writeAtomicJson(location.file, record);
  return { file: location.file, pageData: record };
}

async function acquireScopedUpdateLease(location, {
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  waitMs = DEFAULT_SCOPE_UPDATE_WAIT_MS,
  pollMs = 25,
  tokenFactory,
} = {}) {
  // Keep the per-scope coordination primitive entirely under the activated v2
  // tree. The separate directory lets unrelated pages progress concurrently,
  // while same-scope read/modify/write callers cannot overwrite each other.
  await ensureDirectory(location.root);
  const locksRoot = join(location.root, '.scope-locks');
  await ensureDirectory(locksRoot);
  const lockDir = join(locksRoot, location.scopeHash);
  await ensureDirectory(lockDir);

  const ttl = positiveDuration(leaseTtlMs, DEFAULT_LEASE_TTL_MS);
  const deadline = Date.now() + Math.max(0, Number(waitMs) || 0);
  const interval = Math.max(5, Math.min(250, Number(pollMs) || 25));
  do {
    let lease;
    try {
      lease = await acquireLeaseWithCreationRaceRetry({
        feedbackDir: lockDir,
        ttlMs: ttl,
        ...(tokenFactory ? { tokenFactory } : {}),
      });
    } catch (error) {
      // A creation-race retry is intentionally tiny. If filesystem churn
      // keeps producing ENOENT, honor the caller's overall bounded wait
      // rather than surfacing a spurious raw filesystem error.
      if (error?.code !== 'ENOENT') throw error;
      if (Date.now() >= deadline) break;
      await delay(interval);
      continue;
    }
    if (lease.acquired) return { lease, ttl };
    if (Date.now() >= deadline) break;
    await delay(interval);
  } while (Date.now() <= deadline);
  throw cacheError('annotation_cache_update_busy', 'Another process is updating this exact annotation cache scope.');
}

// Serialize a single exact page/project read-modify-write transaction. The
// caller receives a detached current record and must return the complete next
// page (or undefined to leave it unchanged). This is deliberately local-only:
// no network work is allowed while the per-scope lease is held.
export async function updateScopedAnnotationPage({
  bootstrapAccess = false,
  annotationsDir,
  projectId,
  pageUrl,
  update,
  leaseTtlMs = DEFAULT_LEASE_TTL_MS,
  waitMs = DEFAULT_SCOPE_UPDATE_WAIT_MS,
  pollMs = 25,
  tokenFactory,
  onLeaseRenew,
} = {}) {
  if (typeof update !== 'function') {
    throw cacheError('annotation_cache_update_invalid', 'A scoped cache update callback is required.');
  }
  const location = annotationCachePath(annotationsDir, { projectId, pageUrl });
  await assertBootstrapWriteAllowed(annotationsDir, bootstrapAccess);
  await ensureVersionedAnnotationCache({ annotationsDir });
  // Re-read the activation marker after migration before any page write. A
  // malformed/partial root is never silently repaired by a write operation.
  await activeManifest(annotationsDir);
  await ensureDirectory(location.directory);
  const { lease, ttl } = await acquireScopedUpdateLease(location, {
    leaseTtlMs,
    waitMs,
    pollMs,
    tokenFactory,
  });
  const heartbeat = startLeaseHeartbeat(lease, {
    ttlMs: ttl,
    lostCode: 'annotation_cache_update_lease_lost',
    onLeaseRenew,
  });
  try {
    await heartbeat.assertOwned();
    const current = await readScopedAnnotationPage({ annotationsDir, projectId, pageUrl, bootstrapAccess });
    await assertBootstrapWriteAllowed(annotationsDir, bootstrapAccess);
    const next = await update(current ? cloneJson(current) : null, { ...location });
    if (next === undefined) {
      return { file: location.file, pageData: current, updated: false };
    }
    await heartbeat.assertOwned();
    await assertBootstrapWriteAllowed(annotationsDir, bootstrapAccess);
    const written = await runAnnotationSyncCommit(async () => {
      await heartbeat.assertOwned();
      await assertBootstrapWriteAllowed(annotationsDir, bootstrapAccess);
      return writeScopedRecord(location, next);
    });
    return { ...written, updated: true };
  } finally {
    await heartbeat.stop();
    await lease.release();
  }
}

export async function writeScopedAnnotationPage({ annotationsDir, projectId, pageUrl, pageData } = {}) {
  const result = await updateScopedAnnotationPage({
    annotationsDir,
    projectId,
    pageUrl,
    update: () => pageData,
  });
  return result.file;
}

export async function readVersionedAnnotationPages({ annotationsDir, ensureMigrated = false, bootstrapAccess = false } = {}) {
  if (!bootstrapAccess && await annotationBootstrapActive(annotationsDir)) return {};
  if (!annotationsDir || typeof annotationsDir !== 'string') {
    throw cacheError('annotation_cache_directory_invalid', 'annotationsDir is required.');
  }
  if (ensureMigrated) await ensureVersionedAnnotationCache({ annotationsDir });
  const manifest = await activeManifest(annotationsDir);
  if (!manifest) return {};
  const root = join(annotationsDir, ANNOTATION_CACHE_ROOT);
  const pages = {};
  const seen = new Set();
  const projectEntries = await readdir(root, { withFileTypes: true });
  for (const projectEntry of projectEntries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (projectEntry.name === MANIFEST_FILE || projectEntry.name.startsWith('.')) continue;
    if (!HEX_SHA256.test(projectEntry.name)) continue;
    if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) {
      throw cacheError('annotation_cache_record_invalid', 'Versioned cache contains an invalid project scope directory.');
    }
    const projectDir = join(root, projectEntry.name);
    // Dirent metadata is only a snapshot. Re-check the directory itself before
    // readdir so a replacement symlink cannot redirect a full-cache scan.
    const projectInfo = await statOrNull(projectDir);
    if (!projectInfo?.isDirectory() || projectInfo.isSymbolicLink()) {
      throw cacheError('annotation_cache_record_invalid', 'Versioned cache contains an invalid project scope directory.');
    }
    const recordEntries = await readdir(projectDir, { withFileTypes: true });
    for (const recordEntry of recordEntries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!recordEntry.name.endsWith('.json') || !HEX_SHA256.test(recordEntry.name.slice(0, -5))) continue;
      if (!recordEntry.isFile() || recordEntry.isSymbolicLink()) {
        throw cacheError('annotation_cache_record_invalid', 'Versioned cache contains an invalid page record.');
      }
      const path = join(projectDir, recordEntry.name);
      const raw = await readBoundedJson(path);
      let scope;
      try {
        scope = annotationCachePath(annotationsDir, { projectId: raw?.projectId, pageUrl: raw?.pageUrl });
      } catch {
        throw cacheError('annotation_cache_record_invalid', 'Versioned cache record has an invalid scope.');
      }
      if (scope.projectHash !== projectEntry.name || `${scope.scopeHash}.json` !== recordEntry.name || seen.has(scope.scopeHash)) {
        throw cacheError('annotation_cache_record_invalid', 'Versioned cache record path conflicts with its exact scope.');
      }
      seen.add(scope.scopeHash);
      pages[scope.entryKey] = validateCacheRecord(raw, scope);
    }
  }
  if (!bootstrapAccess && await annotationBootstrapActive(annotationsDir)) return {};
  return pages;
}
