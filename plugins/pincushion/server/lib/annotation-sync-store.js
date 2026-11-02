import { runAnnotationSyncCommit, withAnnotationCommitMutex, withAnnotationSyncFence } from './annotation-sync-fence.js';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rename, unlink, lstat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { acquirePinsRefreshLease } from './pins-refresh.js';
import { ANNOTATION_BOOTSTRAP_FILE, readVersionedAnnotationPages, updateScopedAnnotationPage } from './annotation-cache.js';
import { parseAnnotationSyncState, validateAnnotationSyncPage } from './annotation-sync.js';

async function syncDirectory(path) {
  const handle = await open(path, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export async function writeAnnotationSyncJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temp, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync();
    await handle.close(); handle = null;
    await runAnnotationSyncCommit(async () => { await rename(temp, path); await syncDirectory(dirname(path)); });
  } catch (error) { await handle?.close(); await unlink(temp).catch(() => {}); throw error; }
}
export async function withAnnotationSyncLease(feedbackDir, operation, { ttlMs = 60000 } = {}) {
  const dir = join(feedbackDir, '.annotation-sync-lock');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  let lease;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { lease = await withAnnotationCommitMutex(dir, () => acquirePinsRefreshLease({ feedbackDir: dir, ttlMs })); break; }
    catch (error) { if (error.code !== 'ENOENT' || attempt === 2) throw error; }
  }
  if (!lease?.acquired) throw new Error('annotation_sync_busy');
  let lost = false;
  const assertOwned = async () => { if (lost || !await lease.renew()) { lost = true; throw new Error('annotation_sync_lease_lost'); } };
  const timer = setInterval(() => { assertOwned().catch(() => {}); }, Math.max(10, ttlMs / 3)); timer.unref?.();
  try { await assertOwned(); return await withAnnotationSyncFence(dir, assertOwned, () => operation(assertOwned)); }
  finally { clearInterval(timer); await withAnnotationCommitMutex(dir, () => lease.release()); }
}
export async function readAnnotationBootstrap(annotationsDir) {
  const path = join(annotationsDir, ANNOTATION_BOOTSTRAP_FILE);
  let info;
  try { info = await lstat(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 32 * 1024 * 1024) throw new Error('annotation_sync_bootstrap_state_invalid');
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (value?.version !== 1 || !Array.isArray(value.seen) || !Array.isArray(value.cursors) ||
      (value.state !== null && !parseAnnotationSyncState(value.state)) ||
      value.seen.some(e => !e || typeof e.projectId !== 'string' || typeof e.pageUrl !== 'string' || typeof e.annotationId !== 'string') ||
      value.cursors.some(c => typeof c !== 'string' || c.length > 4096)) throw new Error('annotation_sync_bootstrap_state_invalid');
  return value;
}
export async function beginAnnotationBootstrap(annotationsDir) {
  const state = { version: 1, state: null, seen: [], cursors: [] };
  await writeAnnotationSyncJson(join(annotationsDir, ANNOTATION_BOOTSTRAP_FILE), state);
  return state;
}
export async function bootstrapCacheIntact(annotationsDir, bootstrap) {
  const pages = await readVersionedAnnotationPages({ annotationsDir, bootstrapAccess: true });
  const present = new Set(Object.values(pages).flatMap(page => page.annotations.map(ann => `${page.projectId}\0${page.pageUrl}\0${ann.id}`)));
  return bootstrap.seen.every(e => present.has(`${e.projectId}\0${e.pageUrl}\0${e.annotationId}`));
}
export async function applyAnnotationBootstrapPage({ annotationsDir, bootstrap, page, applyPage, clearQueue, writeJournalState, assertOwned = async () => {} }) {
  const { state, seen } = validateAnnotationSyncPage(page, { mode: 'bootstrap', previous: bootstrap.state, cursors: bootstrap.cursors });
  const prior = new Set(bootstrap.seen.map(e => e.annotationId));
  if (seen.some(e => prior.has(e.annotationId))) throw new Error('annotation_sync_bootstrap_duplicate');
  await assertOwned(); await applyPage(page); await assertOwned();
  const next = { version: 1, state, seen: [...bootstrap.seen, ...seen], cursors: state.cursor ? [...bootstrap.cursors, state.cursor] : bootstrap.cursors };
  // Apply-before-cursor: a crash before this fsync simply replays the same page.
  await writeAnnotationSyncJson(join(annotationsDir, ANNOTATION_BOOTSTRAP_FILE), next);
  if (page.hasMore) return next;
  await finishAnnotationBootstrap({ annotationsDir, bootstrap: next, clearQueue, writeJournalState, assertOwned });
  return null;
}
export async function finishAnnotationBootstrap({ annotationsDir, bootstrap: next, clearQueue, writeJournalState, assertOwned = async () => {} }) {
  if (!next.state || next.state.cursor !== null) throw new Error('annotation_sync_bootstrap_incomplete');
  const state = next.state;
  const allowed = new Set(next.seen.map(e => `${e.projectId}\0${e.pageUrl}\0${e.annotationId}`));
  const pages = await readVersionedAnnotationPages({ annotationsDir, bootstrapAccess: true });
  for (const page of Object.values(pages)) {
    await assertOwned();
    await updateScopedAnnotationPage({ annotationsDir, projectId: page.projectId, pageUrl: page.pageUrl, bootstrapAccess: true,
      update: current => ({ ...current, annotations: current.annotations.filter(ann => allowed.has(`${current.projectId}\0${current.pageUrl}\0${ann.id}`)) }),
    });
  }
  await assertOwned(); await clearQueue();
  await assertOwned(); await writeJournalState(state);
  await runAnnotationSyncCommit(async () => {
    await assertOwned(); await unlink(join(annotationsDir, ANNOTATION_BOOTSTRAP_FILE));
    await syncDirectory(annotationsDir);
  });
  return null;
}
