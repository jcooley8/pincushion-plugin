// Commit locks do not expire while their process is alive. Lease takeover and
// publication use the same lock; a paused committer cannot be overtaken.
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { link, mkdir, open, lstat, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const fences = new AsyncLocalStorage();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function alive(token) {
  if (!/^[1-9][0-9]*-[a-f0-9-]{36}$/.test(token)) return true;
  try { process.kill(Number(token.split('-')[0]), 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}
async function owner(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 128) throw new Error('annotation_sync_commit_owner_invalid');
    return await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export async function createOwner(path, token, { openFile = open, linkFile = link, unlinkFile = unlink } = {}) {
  // Write a complete token first, then publish it with an atomic no-clobber
  // hard link. A crash or ENOSPC during the write leaves no empty owner lock.
  const temporary = `${path}.${randomUUID()}.pending`;
  let handle;
  let published = false;
  try {
    handle = await openFile(temporary, 'wx', 0o600);
    await handle.writeFile(token);
    await handle.sync();
    await handle.close();
    handle = null;
    await linkFile(temporary, path);
    published = true;
  } finally {
    if (handle) await handle.close();
    // Once linked, this caller owns the live lock. A failure to remove only
    // the temporary name must not escape before the mutex can release it.
    await unlinkFile(temporary).catch(error => {
      if (error.code !== 'ENOENT' && !published) throw error;
    });
  }
}
export async function withAnnotationCommitMutex(directory, operation, { waitMs = 2000 } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = join(directory, '.commit-owner');
  const reclaim = join(directory, '.commit-reclaim');
  const token = `${process.pid}-${randomUUID()}`;
  const deadline = Date.now() + waitMs;
  while (true) {
    try { await createOwner(lock, token); break; }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    const observed = await owner(lock);
    if (observed && !alive(observed)) {
      // Serialize dead-owner removal and re-read inside this guard. Another
      // contender may already have installed a live owner since our first read.
      // An abandoned reclamation guard is deliberately not age-reclaimed: an
      // uncertain owner requires explicit repair, not unsafe recursive takeover.
      let recoveryOwned = false;
      try {
        await createOwner(reclaim, token); recoveryOwned = true;
        const current = await owner(lock);
        if (current && !alive(current)) await unlink(lock);
      } catch (error) { if (!['EEXIST', 'ENOENT'].includes(error.code)) throw error; }
      finally { if (recoveryOwned) await unlink(reclaim); }
    }
    if (Date.now() >= deadline) throw new Error('annotation_sync_commit_busy');
    await delay(10);
  }
  try { return await operation(); }
  finally { if (await owner(lock) === token) await unlink(lock); }
}
export function withAnnotationSyncFence(directory, assertOwned, operation) {
  return fences.run([...(fences.getStore() || []), { directory, assertOwned }], operation);
}
export async function runAnnotationSyncCommit(operation) {
  const contexts = fences.getStore() || [];
  // Ordering: scoped page/approval lease, then outer sync commit lock, then
  // nested approval commit lock. Takeover never acquires a scoped page lock.
  async function acquire(index) {
    if (index === contexts.length) return operation();
    const { directory, assertOwned } = contexts[index];
    return withAnnotationCommitMutex(directory, async () => {
      await assertOwned();
      return acquire(index + 1);
    });
  }
  return acquire(0);
}
