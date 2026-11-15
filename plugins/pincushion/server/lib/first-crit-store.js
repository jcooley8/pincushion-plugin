// first-crit-store.js — the files the agent setup flow keeps on disk, so no
// safeguard and no project-scope decision lives only in process memory.
//
// 2026-11-12 (pre-release source review of 1.14.0, second round):
// - Folder selection (`.feedback/.first-crit/setup-project.json`): the project
//   confirm_project_setup confirmed for this folder, with a hash of the
//   account's license id and the time. One record, no cap, no expiry. Read on
//   every call. A file that exists but cannot be read is reported as
//   unreadable, never as "no selection", so a damaged file cannot widen a read.
// - First-crit jobs (`.feedback/.first-crit/jobs.json`): one record per crit
//   started in this folder (token, page, bound project, account hash, start
//   time, result once copied). At most MAX_JOBS, each kept JOB_TTL_MS. This is
//   history only: a record that is gone makes the token unattachable (the
//   status answer says so); it never sends findings anywhere else.
// - Agent-added hosts (`~/.pincushion/agent-added-hosts.json`): per project,
//   the hosts a configure_project tool call added, and whether the user has
//   since agreed they belong to the project (confirm_project_setup's shown
//   proposal, or start_first_crit with hostAddedByAgentConfirmed). No cap, no
//   expiry. An unreadable file refuses the first crit; it is never rewritten
//   as empty.
// Every read-modify-write holds a lock file (exclusive create, retried with
// backoff, broken only when stale) and a per-process queue, and writes through
// a temp file and a rename with mode 0600. Nothing here holds a license key or
// an email address.
import { createHash, randomBytes } from 'crypto';
import { readFileSync } from 'fs';
import { chmod, link, mkdir, open, readFile, rename, stat, unlink, writeFile } from 'fs/promises';
import { homedir, hostname } from 'os';
import { dirname, join, resolve as resolvePath } from 'path';

export const MAX_JOBS = 10;
export const JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT_MS = 5000;
const LOCK_STALE_MS = 15000;

export function firstCritStateDir(feedbackDir) {
  return join(feedbackDir, '.first-crit');
}

export function defaultAgentHostsFile() {
  return join(homedir(), '.pincushion', 'agent-added-hosts.json');
}

export function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

const HASH = /^[0-9a-f]{64}$/;

function text(value, max = 2048) {
  return typeof value === 'string' && value.length && value.length <= max ? value : null;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function lockError(code, message, file) {
  return Object.assign(new Error(message), { code, file });
}

// Whether the process that wrote a lock may still be running. Only a lock
// written on this machine can be checked; EPERM means it exists.
function ownerAlive(holder) {
  if (holder.host !== hostname()) return true;
  if (!Number.isSafeInteger(holder.pid) || holder.pid <= 0) return true;
  if (holder.pid === process.pid) return true;
  try {
    process.kill(holder.pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

// { state: 'missing' } | { state: 'held', raw, token, pid, host } |
// { state: 'garbled', raw, mtimeMs } | { state: 'unreadable' }
async function readLock(lock) {
  let raw;
  try {
    raw = await readFile(lock, 'utf8');
  } catch (error) {
    return error?.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' };
  }
  try {
    const value = JSON.parse(raw);
    if (value && typeof value.token === 'string' && value.token) {
      return { state: 'held', raw, token: value.token, pid: value.pid, host: value.host };
    }
  } catch { /* garbled */ }
  try {
    return { state: 'garbled', raw, mtimeMs: (await stat(lock)).mtimeMs };
  } catch (error) {
    return error?.code === 'ENOENT' ? { state: 'missing' } : { state: 'unreadable' };
  }
}

// Removes a lock only if it still holds exactly what was observed: it is moved
// aside first and put back if it turned out to be another (live) lock.
async function breakLock(lock, observedRaw) {
  const aside = `${lock}.${randomBytes(6).toString('hex')}.broken`;
  try {
    await rename(lock, aside);
  } catch {
    return true;
  }
  let moved = null;
  try { moved = await readFile(aside, 'utf8'); } catch { moved = null; }
  if (moved === observedRaw) {
    await unlink(aside).catch(() => {});
    return true;
  }
  // Not the lock we judged dead: restore it if nobody took the name since.
  // If someone did, its owner fails the ownership check before committing.
  await link(aside, lock).catch(() => {});
  await unlink(aside).catch(() => {});
  return false;
}

async function ownsLock(lock, token) {
  const holder = await readLock(lock);
  return holder.state === 'held' && holder.token === token;
}

async function acquireLock(lock, token, { timeoutMs, staleMs, clock }) {
  const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    let handle = null;
    try {
      handle = await open(lock, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname() }));
      return;
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    } finally {
      await handle?.close().catch(() => {});
    }
    const holder = await readLock(lock);
    if (holder.state === 'missing') continue;
    // A live owner is never broken, however old its lock is.
    const dead = holder.state === 'held' && !ownerAlive(holder);
    const abandoned = holder.state === 'garbled' && clock() - holder.mtimeMs > staleMs;
    if ((dead || abandoned) && await breakLock(lock, holder.raw)) continue;
    if (Date.now() - started > timeoutMs) {
      throw lockError('STATE_LOCKED', `${lock} is held by another process`, lock);
    }
    await sleep(Math.min(200, 10 * 2 ** Math.min(attempt, 5)) + Math.floor(Math.random() * 10));
  }
}

async function releaseLock(lock, token) {
  if (await ownsLock(lock, token)) await unlink(lock).catch(() => {});
}

const queues = new Map();

// One queue per file in this process, and a lock file across processes. The
// lock names its owner (a random token, the pid and the host). A contender
// breaks it only when that owner is a process on this machine that no longer
// runs, or when its content is unreadable garbage older than staleMs. The
// operation gets commit(value): it writes a temp file and, right before the
// rename, checks that the lock still carries its token; if not, the temp file
// is discarded and the whole read-modify-write runs again from a fresh read
// (at most three times, then STATE_LOCK_LOST). Release removes the lock only
// while it still carries the token. `beforeCommit` and `clock` are test hooks.
export async function withFileLock(file, operation, {
  timeoutMs = LOCK_TIMEOUT_MS,
  staleMs = LOCK_STALE_MS,
  clock = () => Date.now(),
  queue = true,
  beforeCommit = null,
} = {}) {
  const key = resolvePath(file);
  let release = () => {};
  let tail = null;
  if (queue) {
    const previous = queues.get(key) || Promise.resolve();
    const mine = new Promise((resolve) => { release = resolve; });
    tail = previous.then(() => mine);
    queues.set(key, tail);
    await previous;
  }
  const lock = `${file}.lock`;
  try {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    for (let round = 0; ; round += 1) {
      const token = randomBytes(16).toString('hex');
      await acquireLock(lock, token, { timeoutMs, staleMs, clock });
      try {
        const commit = async (value) => {
          const temp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
          try {
            await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
            await chmod(temp, 0o600);
            if (beforeCommit) await beforeCommit();
            if (!(await ownsLock(lock, token))) throw lockError('LOCK_LOST', `${lock} was taken over before this write committed`, lock);
            await rename(temp, file);
          } catch (error) {
            await unlink(temp).catch(() => {});
            throw error;
          }
        };
        return await operation(commit);
      } catch (error) {
        if (error?.code !== 'LOCK_LOST') throw error;
        if (round >= 2) throw lockError('STATE_LOCK_LOST', `${file} could not be written: its lock was taken over three times`, file);
      } finally {
        await releaseLock(lock, token);
      }
    }
  } finally {
    release();
    if (queue && queues.get(key) === tail) queues.delete(key);
  }
}

// { state: 'missing' } | { state: 'ok', value } | { state: 'unreadable', reason }
async function readJson(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'missing' };
    return { state: 'unreadable', reason: error?.code || 'read_failed' };
  }
  try {
    return { state: 'ok', value: JSON.parse(raw) };
  } catch {
    return { state: 'unreadable', reason: 'invalid_json' };
  }
}

// A short reason for a failed write, naming the file when it is known.
function describe(error) {
  const code = error?.code || error?.message || 'write_failed';
  const file = error?.file || error?.path;
  return file ? `${code}, ${file}` : code;
}
export { describe as persistenceReason };

// ─── Folder selection ─────────────────────────────────────────────────────────

export function setupSelectionFile(feedbackDir) {
  return join(firstCritStateDir(feedbackDir), 'setup-project.json');
}

// Synchronous: pin reads decide their default project from it on every call.
export function readSetupSelection(file) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'none', file };
    return { state: 'unreadable', file, reason: error?.code || 'read_failed' };
  }
  let value;
  try { value = JSON.parse(raw); } catch { return { state: 'unreadable', file, reason: 'invalid_json' }; }
  const projectId = text(value?.projectId, 200);
  const accountHash = typeof value?.accountHash === 'string' && HASH.test(value.accountHash) ? value.accountHash : null;
  const confirmedAt = Date.parse(value?.confirmedAt);
  if (!projectId || !accountHash || !Number.isFinite(confirmedAt)) return { state: 'unreadable', file, reason: 'invalid_record' };
  return { state: 'ok', file, projectId, accountHash, confirmedAt: new Date(confirmedAt).toISOString() };
}

// confirm_project_setup replaces the one record on purpose (it is also the
// documented repair for an unreadable file), so it does not read it first.
export async function writeSetupSelection(file, { projectId, accountHash, now = Date.now(), lock = {} } = {}) {
  if (!text(projectId, 200) || typeof accountHash !== 'string' || !HASH.test(accountHash)) {
    throw Object.assign(new Error('account identity unknown'), { code: 'ACCOUNT_UNKNOWN' });
  }
  await withFileLock(file, (commit) => commit({ version: 1, projectId, accountHash, confirmedAt: new Date(now).toISOString() }), lock);
}

// ─── First-crit jobs ──────────────────────────────────────────────────────────

export function firstCritJobsFile(feedbackDir) {
  return join(firstCritStateDir(feedbackDir), 'jobs.json');
}

function cleanAttached(value) {
  if (!value || typeof value !== 'object' || !text(value.projectId, 200)) return null;
  return {
    projectId: value.projectId,
    projectName: text(value.projectName, 300),
    pinCount: Number.isSafeInteger(value.pinCount) ? value.pinCount : null,
    mode: text(value.mode, 40) || 'copied',
    attachedAt: text(value.attachedAt, 40),
  };
}

export function cleanJob(value) {
  if (!value || typeof value !== 'object') return null;
  const token = text(value.token, 200);
  const projectId = text(value.projectId, 200);
  const accountHash = typeof value.accountHash === 'string' && HASH.test(value.accountHash) ? value.accountHash : null;
  const startedAt = Date.parse(value.startedAt);
  if (!token || !projectId || !accountHash || !Number.isFinite(startedAt) || !text(value.url) || !text(value.host, 300)) return null;
  return {
    token,
    url: value.url,
    host: value.host,
    projectId,
    projectName: text(value.projectName, 300),
    source: value.source === 'configured' ? 'configured' : 'confirmed',
    accountHash,
    startedAt: new Date(startedAt).toISOString(),
    attached: cleanAttached(value.attached),
  };
}

export function jobExpired(job, now) {
  return now - Date.parse(job.startedAt) > JOB_TTL_MS;
}

// Valid, unexpired, unique records, newest first, at most MAX_JOBS.
export function retainJobs(list, now) {
  const kept = [];
  const seen = new Set();
  const sorted = (Array.isArray(list) ? list : []).map(cleanJob).filter(Boolean)
    .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  for (const job of sorted) {
    if (seen.has(job.token) || jobExpired(job, now)) continue;
    seen.add(job.token);
    kept.push(job);
    if (kept.length >= MAX_JOBS) break;
  }
  return kept;
}

function unreadableError(file, reason) {
  return Object.assign(new Error(`${file} cannot be read (${reason})`), { code: 'STATE_UNREADABLE', file, reason });
}

export function createFirstCritJobStore({ file, now = () => Date.now(), lock = {} } = {}) {
  // Only a missing file is empty history. Any other read error, or content
  // that is not a job list, throws STATE_UNREADABLE and is never overwritten.
  async function load() {
    const read = await readJson(file);
    if (read.state === 'missing') return [];
    if (read.state === 'unreadable') throw unreadableError(file, read.reason);
    if (!Array.isArray(read.value?.jobs)) throw unreadableError(file, 'invalid_record');
    return retainJobs(read.value.jobs, now());
  }
  return {
    file,
    // The record of a token, or null; throws STATE_UNREADABLE.
    async getJob(token) {
      return (await load()).find((job) => job.token === token) || null;
    },
    // Writes the whole record (insert or replace, with its attach result if
    // any). Resolves when written; rejects with the reason otherwise.
    async putJob(record) {
      const job = cleanJob(record);
      if (!job) throw Object.assign(new Error('invalid job record'), { code: 'INVALID_RECORD', file });
      await withFileLock(file, async (commit) => {
        const jobs = await load();
        await commit({ version: 1, jobs: retainJobs([job, ...jobs.filter((entry) => entry.token !== job.token)], now()) });
      }, lock);
    },
  };
}

// The same interface in memory (tests, and callers with no folder).
export function createMemoryFirstCritJobStore({ now = () => Date.now() } = {}) {
  let jobs = [];
  return {
    file: null,
    async getJob(token) { jobs = retainJobs(jobs, now()); return jobs.find((job) => job.token === token) || null; },
    async putJob(record) {
      const job = cleanJob(record);
      if (!job) throw Object.assign(new Error('invalid job record'), { code: 'INVALID_RECORD' });
      jobs = retainJobs([job, ...jobs.filter((entry) => entry.token !== job.token)], now());
    },
  };
}

// ─── Agent-added hosts ────────────────────────────────────────────────────────

function cleanHostEntry(value) {
  if (!value || typeof value !== 'object') return null;
  return {
    reason: value.reason === 'unverified' ? 'unverified' : 'added',
    addedAt: text(value.addedAt, 40),
    addedBy: typeof value.addedBy === 'string' && HASH.test(value.addedBy) ? value.addedBy : null,
    acknowledgedAt: text(value.acknowledgedAt, 40),
    acknowledgedBy: typeof value.acknowledgedBy === 'string' && HASH.test(value.acknowledgedBy) ? value.acknowledgedBy : null,
    acknowledgedVia: text(value.acknowledgedVia, 60),
  };
}

export function createAgentHostLedger({ file = defaultAgentHostsFile(), now = () => Date.now(), lock = {} } = {}) {
  // { ok: true, projects } or { ok: false, reason }. Never "empty" for a file
  // that exists but cannot be read.
  async function load() {
    const read = await readJson(file);
    if (read.state === 'missing') return { ok: true, projects: {} };
    if (read.state === 'unreadable') return { ok: false, reason: read.reason };
    const projects = read.value?.projects;
    if (!projects || typeof projects !== 'object' || Array.isArray(projects)) return { ok: false, reason: 'invalid_record' };
    return { ok: true, projects };
  }
  async function change(apply) {
    let changed = false;
    await withFileLock(file, async (commit) => {
      const state = await load();
      if (!state.ok) throw unreadableError(file, state.reason);
      changed = apply(state.projects);
      if (changed) await commit({ version: 1, projects: state.projects });
    }, lock);
    return changed;
  }
  return {
    file,
    // { ok: true, added: [site keys], unverified: [site keys] } for the hosts
    // not yet acknowledged, or { ok: false, reason }.
    async excluded(projectId) {
      const state = await load();
      if (!state.ok) return { ok: false, reason: state.reason };
      const added = [];
      const unverified = [];
      for (const [key, raw] of Object.entries(state.projects[projectId] || {})) {
        const entry = cleanHostEntry(raw);
        if (!entry || entry.acknowledgedAt) continue;
        (entry.reason === 'unverified' ? unverified : added).push(key);
      }
      return { ok: true, added: added.sort(), unverified: unverified.sort() };
    },
    // Hosts a configure_project tool call submitted that the account's list
    // did not have before ('added'), or that could not be compared
    // ('unverified'). A re-added host loses an earlier acknowledgment.
    async record(projectId, keys, { reason = 'added', accountHash = null } = {}) {
      if (!text(projectId, 200) || !keys.length) return false;
      return change((projects) => {
        const entries = projects[projectId] && typeof projects[projectId] === 'object' ? projects[projectId] : {};
        for (const key of keys) {
          entries[key] = { reason, addedAt: new Date(now()).toISOString(), addedBy: accountHash };
        }
        projects[projectId] = entries;
        return true;
      });
    },
    // The user agreed these hosts belong to the project. Only hosts already
    // recorded are touched; returns whether anything changed.
    async acknowledge(projectId, keys, { accountHash = null, via } = {}) {
      return change((projects) => {
        const entries = projects[projectId];
        if (!entries || typeof entries !== 'object') return false;
        let touched = false;
        for (const key of keys) {
          const entry = cleanHostEntry(entries[key]);
          if (!entry || entry.acknowledgedAt) continue;
          entries[key] = { ...entry, acknowledgedAt: new Date(now()).toISOString(), acknowledgedBy: accountHash, acknowledgedVia: via || null };
          touched = true;
        }
        return touched;
      });
    },
  };
}

// The same interface in memory, for unit tests.
export function createMemoryAgentHostLedger({ now = () => Date.now() } = {}) {
  const projects = {};
  return {
    file: null,
    async excluded(projectId) {
      const added = [];
      const unverified = [];
      for (const [key, entry] of Object.entries(projects[projectId] || {})) {
        if (entry.acknowledgedAt) continue;
        (entry.reason === 'unverified' ? unverified : added).push(key);
      }
      return { ok: true, added: added.sort(), unverified: unverified.sort() };
    },
    async record(projectId, keys, { reason = 'added', accountHash = null } = {}) {
      projects[projectId] ||= {};
      for (const key of keys) projects[projectId][key] = { reason, addedAt: new Date(now()).toISOString(), addedBy: accountHash };
      return keys.length > 0;
    },
    async acknowledge(projectId, keys, { accountHash = null, via } = {}) {
      let touched = false;
      for (const key of keys) {
        const entry = projects[projectId]?.[key];
        if (!entry || entry.acknowledgedAt) continue;
        Object.assign(entry, { acknowledgedAt: new Date(now()).toISOString(), acknowledgedBy: accountHash, acknowledgedVia: via || null });
        touched = true;
      }
      return touched;
    },
  };
}
