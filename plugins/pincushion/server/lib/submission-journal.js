// Durable local receipt for new cloud-backed pin submissions. Entries live in
// the user's private Pincushion config, never in the workspace's actionable
// .feedback cache. The only secret-bearing input is deliberately absent.

import { chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

const JOURNAL_VERSION = 1;
const MAX_JOURNAL_BYTES = 1_048_576;
const MAX_ENTRIES = 512;
const MAX_TERMINAL_RECEIPT_BYTES = 8_192;
const MAX_OPERATION_LENGTH = 128;
const LOCK_WAIT_MS = 2_000;
const LOCK_POLL_MS = 20;
const MALFORMED_LOCK_RECOVERY_MS = 5 * 60_000;

export const SUBMISSION_DELIVERY_STATUSES = Object.freeze({
  accepted: 'accepted',
  pending: 'pending_reconciliation',
  journalUnavailable: 'journal_unavailable',
  journalBusy: 'journal_busy',
  rejectedAuthentication: 'rejected_authentication',
  rejectedValidation: 'rejected_validation',
  rejectedQuota: 'rejected_quota',
  rejectedRemote: 'rejected_remote',
  rejectedCanonical: 'rejected_canonical_mismatch',
  reconciledAbsent: 'rejected_canonical_absent',
});

const RETRYABLE_PENDING = new Set([
  SUBMISSION_DELIVERY_STATUSES.pending,
  SUBMISSION_DELIVERY_STATUSES.journalBusy,
  SUBMISSION_DELIVERY_STATUSES.journalUnavailable,
]);

class JournalError extends Error {
  constructor(code, message = code) {
    super(message);
    this.code = code;
  }
}

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function now() {
  return new Date().toISOString();
}

function safeString(value, field, { max = 4096 } = {}) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized || normalized.length > max) {
    throw new JournalError('journal_scope_invalid', `${field} must be a bounded non-empty string`);
  }
  return normalized;
}

function canonicalSyncUrl(value) {
  const raw = safeString(value, 'syncServerUrl');
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new JournalError('journal_scope_invalid', 'syncServerUrl must be a valid http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new JournalError('journal_scope_invalid', 'syncServerUrl must use http(s)');
  }
  // Query strings, fragments, and user info are not part of the endpoint
  // identity and could contain a capability. Refuse them instead of copying
  // them into any journal-derived state.
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new JournalError('journal_scope_invalid', 'syncServerUrl cannot contain credentials, a query, or a fragment');
  }
  return parsed.toString();
}

function exactPageUrl(value) {
  // Page URLs are user-visible annotation data and may include query variants.
  // Preserve the exact trimmed value for scope separation rather than reducing
  // it to an origin or route.
  return safeString(value, 'pageUrl', { max: 8192 });
}

function privateConfigRoot(value) {
  const configured = typeof value === 'string' && value.trim()
    ? value.trim()
    : join(homedir(), '.pincushion');
  return resolve(configured);
}

function within(parent, child) {
  const relation = relative(parent, child);
  return relation === '' || (!relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) && relation !== '..' && !isAbsolute(relation));
}

function operationId(value) {
  const normalized = safeString(value, 'operationId', { max: MAX_OPERATION_LENGTH });
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(normalized)) {
    throw new JournalError('operation_id_invalid', 'operationId must be 8-128 URL-safe identifier characters');
  }
  return normalized;
}

function operationName(value) {
  const normalized = safeString(value, 'operation', { max: 80 });
  if (!/^[a-z][a-z0-9_:-]{2,79}$/.test(normalized)) {
    throw new JournalError('journal_operation_invalid', 'operation must be a stable lowercase identifier');
  }
  return normalized;
}

function jsonClone(value, field) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new JournalError('journal_payload_invalid', `${field} is not JSON serializable`);
  }
  if (!encoded || encoded.length > 262_144) {
    throw new JournalError('journal_payload_invalid', `${field} is missing or too large`);
  }
  try {
    return JSON.parse(encoded);
  } catch {
    throw new JournalError('journal_payload_invalid', `${field} could not be normalized`);
  }
}

function credentialBearingKey(key) {
  const normalized = String(key || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
  return normalized === 'token' || normalized.includes('authorization') || normalized.includes('password') ||
    normalized.includes('secret') || normalized.includes('credential') || normalized.includes('token') ||
    normalized === 'licensekey' || normalized === 'apikey' || normalized === 'servicerolekey' ||
    normalized === 'privatekey';
}

function assertNoCredentials(value, path = 'payload') {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertNoCredentials(value[index], `${path}[${index}]`);
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (credentialBearingKey(key)) {
      throw new JournalError('journal_payload_invalid', `${path}.${key} cannot be stored in a submission journal`);
    }
    assertNoCredentials(child, `${path}.${key}`);
  }
}

function cloneAnnotation(value) {
  const annotation = jsonClone(value, 'annotation');
  assertNoCredentials(annotation, 'annotation');
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation) ||
      typeof annotation.id !== 'string' || !annotation.id.trim() || annotation.id.length > 200) {
    throw new JournalError('journal_payload_invalid', 'annotation must carry a bounded stable id');
  }
  return annotation;
}

function modeIsOwnerOnly(info) {
  if (process.platform === 'win32') return true;
  if (typeof process.getuid === 'function' && info.uid !== process.getuid()) return false;
  return (info.mode & 0o077) === 0;
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new JournalError('journal_permissions', 'journal directory cannot be a symbolic link');
  if (!info.isDirectory()) throw new JournalError('journal_permissions', 'journal path is not a directory');
  if (typeof process.getuid === 'function' && process.platform !== 'win32' && info.uid !== process.getuid()) {
    throw new JournalError('journal_permissions', 'journal directory is not owned by this user');
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    await chmod(path, 0o700);
  }
  const verified = await lstat(path);
  if (!modeIsOwnerOnly(verified)) {
    throw new JournalError('journal_permissions', 'journal directory is not owner-only');
  }
}

async function ensurePrivateFile(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new JournalError('journal_permissions', 'journal file cannot be a symbolic link');
  if (!info.isFile()) throw new JournalError('journal_permissions', 'journal path is not a regular file');
  if (typeof process.getuid === 'function' && process.platform !== 'win32' && info.uid !== process.getuid()) {
    throw new JournalError('journal_permissions', 'journal file is not owned by this user');
  }
  if (process.platform !== 'win32' && (info.mode & 0o077) !== 0) {
    await chmod(path, 0o600);
  }
  const verified = await lstat(path);
  if (!modeIsOwnerOnly(verified)) {
    throw new JournalError('journal_permissions', 'journal file is not owner-only');
  }
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}

function parseLock(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || typeof parsed.pid !== 'number' ||
        !Number.isInteger(parsed.pid) || parsed.pid <= 0 || typeof parsed.nonce !== 'string' || !parsed.nonce) return null;
    return parsed;
  } catch {
    return null;
  }
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function inspectRecoverableLock(lockPath) {
  let details;
  try {
    details = await lstat(lockPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return { missing: true };
    return { recoverable: false };
  }
  if (details.isSymbolicLink() || !details.isFile()) return { recoverable: false };
  let raw;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch {
    return { recoverable: false };
  }
  const lock = parseLock(raw);
  const age = Date.now() - details.mtimeMs;
  return {
    missing: false,
    raw,
    recoverable: lock ? !processIsAlive(lock.pid) : age >= MALFORMED_LOCK_RECOVERY_MS,
  };
}

const RECOVERY_READY_MARKER = 'pincushion-journal-recovery-ready\n';
const RECOVERY_HOLD_COMMAND = `printf '${RECOVERY_READY_MARKER}'; cat >/dev/null`;

async function ensureRecoveryLockFile(path) {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new JournalError('journal_permissions', 'stale-lock recovery file must be a regular file');
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  let handle;
  try {
    handle = await open(path, 'a', 0o600);
  } finally {
    if (handle) await handle.close();
  }
  await ensurePrivateFile(path);
}

function recoveryLockCommand(recoveryPath, waitMs) {
  const seconds = String(Math.max(1, Math.ceil(waitMs / 1_000)));
  if (process.platform === 'darwin') {
    return {
      command: '/usr/bin/lockf',
      args: ['-t', seconds, recoveryPath, '/bin/sh', '-c', RECOVERY_HOLD_COMMAND],
    };
  }
  if (process.platform === 'linux') {
    return {
      command: '/usr/bin/flock',
      args: ['-x', '-w', seconds, recoveryPath, '/bin/sh', '-c', RECOVERY_HOLD_COMMAND],
    };
  }
  return null;
}

function waitForChildExit(child, timeoutMs = 1_000) {
  if (child.exitCode !== null || child.signalCode) return Promise.resolve();
  return new Promise((resolveExit) => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      resolveExit();
    };
    const timeout = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* best effort */ }
      // A child can exit immediately before the listener is attached. Do not
      // let that narrow event-ordering race hold the journal release forever.
      finish();
    }, timeoutMs);
    child.once('exit', finish);
    // Recheck after listener registration to cover an already-emitted exit.
    if (child.exitCode !== null || child.signalCode) finish();
  });
}

async function acquireRecoveryLease(lockPath, { waitMs = LOCK_WAIT_MS } = {}) {
  const recoveryPath = `${lockPath}.recovery`;
  await ensureRecoveryLockFile(recoveryPath);
  const command = recoveryLockCommand(recoveryPath, waitMs);
  if (!command) throw new JournalError('journal_recovery_unavailable', 'safe stale-lock recovery is unavailable on this platform');
  return await new Promise((resolveLease, rejectLease) => {
    let child;
    let settled = false;
    let stdout = '';
    let timeout = null;
    const settleError = (error) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      try { child?.stdin?.end(); } catch { /* best effort */ }
      try { child?.kill('SIGTERM'); } catch { /* best effort */ }
      rejectLease(error instanceof JournalError ? error : new JournalError('journal_recovery_unavailable', 'safe stale-lock recovery could not be acquired'));
    };
    try {
      child = spawn(command.command, command.args, { stdio: ['pipe', 'pipe', 'ignore'] });
    } catch (error) {
      settleError(error);
      return;
    }
    child.once('error', settleError);
    child.once('exit', () => {
      if (!settled) settleError(new JournalError('journal_recovery_unavailable', 'safe stale-lock recovery was not acquired'));
    });
    child.stdout.on('data', (chunk) => {
      if (settled) return;
      stdout += String(chunk);
      if (!stdout.includes(RECOVERY_READY_MARKER)) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      resolveLease(async () => {
        try { child.stdin.end(); } catch { /* best effort */ }
        await waitForChildExit(child);
      });
    });
    timeout = setTimeout(() => {
      settleError(new JournalError('journal_recovery_unavailable', 'safe stale-lock recovery timed out'));
    }, Math.max(1_000, waitMs + 1_000));
  });
}

async function recoverDeadLock(lockPath, { waitMs = LOCK_WAIT_MS, beforeStaleLockRecovery } = {}) {
  const initial = await inspectRecoverableLock(lockPath);
  if (initial.missing) return true;
  if (!initial.recoverable) return false;
  if (typeof beforeStaleLockRecovery === 'function') await beforeStaleLockRecovery();
  let releaseRecovery = null;
  try {
    // `unlink` is safe only while this OS-level advisory lease is held. A
    // separate O_EXCL file cannot safely reclaim its own stale owner: two
    // reclaimers could otherwise remove a newly acquired live journal lock.
    releaseRecovery = await acquireRecoveryLease(lockPath, { waitMs });
    const current = await inspectRecoverableLock(lockPath);
    if (current.missing) return true;
    if (!current.recoverable) return false;
    await unlink(lockPath);
    return true;
  } finally {
    if (releaseRecovery) await releaseRecovery();
  }
}

async function acquireLock(lockPath, { waitMs = LOCK_WAIT_MS, beforeStaleLockRecovery } = {}) {
  const boundedWait = Number.isFinite(waitMs) ? Math.max(0, Math.min(Math.floor(waitMs), 10_000)) : LOCK_WAIT_MS;
  const deadline = Date.now() + boundedWait;
  const nonce = randomBytes(18).toString('hex');
  while (true) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid, nonce, createdAt: now() }), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      await ensurePrivateFile(lockPath);
      return async () => {
        try {
          const current = parseLock(await readFile(lockPath, 'utf8'));
          if (current?.nonce === nonce) await unlink(lockPath);
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      if (await recoverDeadLock(lockPath, {
        waitMs: Math.max(1, deadline - Date.now()),
        beforeStaleLockRecovery,
      })) continue;
      if (Date.now() >= deadline) throw new JournalError('journal_busy', 'another submission is being recorded');
      await sleep(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  }
}

function emptyJournal(scope) {
  return {
    version: JOURNAL_VERSION,
    scope,
    entries: {},
  };
}

function validateJournal(value, scope) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.version !== JOURNAL_VERSION ||
      !value.scope || typeof value.scope !== 'object' || value.scope.scopeHash !== scope.scopeHash ||
      !value.entries || typeof value.entries !== 'object' || Array.isArray(value.entries)) {
    throw new JournalError('journal_corrupt', 'submission journal has an unexpected shape or scope');
  }
  if (Object.keys(value.entries).length > MAX_ENTRIES) {
    throw new JournalError('journal_corrupt', 'submission journal has too many entries');
  }
  return value;
}

async function readJournal(journalPath, scope) {
  try {
    const info = await lstat(journalPath);
    if (info.isSymbolicLink()) throw new JournalError('journal_permissions', 'submission journal cannot be a symbolic link');
    if (info.size > MAX_JOURNAL_BYTES) throw new JournalError('journal_corrupt', 'submission journal is too large');
    await ensurePrivateFile(journalPath);
    const parsed = JSON.parse(await readFile(journalPath, 'utf8'));
    return validateJournal(parsed, scope);
  } catch (error) {
    if (error?.code === 'ENOENT') return emptyJournal(scope);
    if (error instanceof JournalError) throw error;
    throw new JournalError('journal_corrupt', 'submission journal cannot be read');
  }
}

async function writeJournal(journalPath, journal) {
  const encoded = JSON.stringify(journal, null, 2);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_JOURNAL_BYTES) {
    throw new JournalError('journal_corrupt', 'submission journal would exceed its size limit');
  }
  const tempPath = `${journalPath}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = await open(tempPath, 'wx', 0o600);
    await handle.writeFile(encoded, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(tempPath, 0o600);
    await rename(tempPath, journalPath);
    // The data file itself is synced before rename. Sync the containing
    // directory too so a sudden process/host stop cannot acknowledge a record
    // whose name was not durably linked into the journal directory.
    if (process.platform !== 'win32') {
      const directory = await open(dirname(journalPath), 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    await ensurePrivateFile(journalPath);
  } catch (error) {
    try { if (handle) await handle.close(); } catch { /* best effort */ }
    try { await unlink(tempPath); } catch { /* best effort */ }
    throw error;
  }
}

function terminalReceiptLocation(paths, operation, id) {
  const digest = sha256(`${paths.scope.scopeHash}\u0000${operation}\u0000${id}`);
  const directory = join(paths.receiptRoot, digest.slice(0, 2));
  if (!within(paths.scopeDirectory, directory)) {
    throw new JournalError('journal_scope_invalid', 'terminal receipt path escaped its private scope');
  }
  return { directory, path: join(directory, `${digest}.json`) };
}

function terminalError(value) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z0-9._:-]{1,160}$/.test(normalized) ? normalized : 'remote_rejected';
}

function terminalReceiptFromEntry(paths, entry) {
  return {
    version: JOURNAL_VERSION,
    scopeHash: paths.scope.scopeHash,
    operation: entry.operation,
    operationId: entry.operationId,
    annotationId: entry.annotationId,
    state: entry.state,
    deliveryStatus: entry.deliveryStatus,
    retryable: false,
    error: entry.state === 'rejected' ? terminalError(entry.error) : null,
    finalizedAt: entry.updatedAt || now(),
  };
}

function validateTerminalReceipt(value, paths, { operation, operationId: id }) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      value.version !== JOURNAL_VERSION || value.scopeHash !== paths.scope.scopeHash ||
      value.operation !== operation || value.operationId !== id ||
      typeof value.annotationId !== 'string' || !value.annotationId || value.annotationId.length > 200 ||
      !['accepted', 'rejected'].includes(value.state) ||
      typeof value.deliveryStatus !== 'string' || value.deliveryStatus.length > 120 ||
      value.retryable !== false || typeof value.finalizedAt !== 'string') {
    throw new JournalError('journal_corrupt', 'terminal submission receipt has an unexpected shape or scope');
  }
  if (value.error !== null && typeof value.error !== 'string') {
    throw new JournalError('journal_corrupt', 'terminal submission receipt has an invalid error');
  }
  assertNoCredentials(value, 'terminalReceipt');
  return value;
}

async function readTerminalReceipt(paths, operation, id) {
  const location = terminalReceiptLocation(paths, operation, id);
  try {
    const info = await lstat(location.path);
    if (info.isSymbolicLink() || !info.isFile() || info.size > MAX_TERMINAL_RECEIPT_BYTES) {
      throw new JournalError('journal_corrupt', 'terminal submission receipt is unsafe or too large');
    }
    await ensurePrivateFile(location.path);
    return validateTerminalReceipt(
      JSON.parse(await readFile(location.path, 'utf8')),
      paths,
      { operation, operationId: id },
    );
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    if (error instanceof JournalError) throw error;
    throw new JournalError('journal_corrupt', 'terminal submission receipt cannot be read');
  }
}

async function writeTerminalReceipt(paths, entry) {
  const receipt = terminalReceiptFromEntry(paths, entry);
  const location = terminalReceiptLocation(paths, entry.operation, entry.operationId);
  await ensurePrivateDirectory(paths.receiptRoot);
  await ensurePrivateDirectory(location.directory);
  const existing = await readTerminalReceipt(paths, entry.operation, entry.operationId);
  if (existing) {
    if (existing.annotationId !== receipt.annotationId || existing.state !== receipt.state ||
        existing.deliveryStatus !== receipt.deliveryStatus || existing.error !== receipt.error) {
      throw new JournalError('journal_operation_conflict', 'operationId already has a different terminal receipt');
    }
    return existing;
  }
  const encoded = JSON.stringify(receipt, null, 2);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_TERMINAL_RECEIPT_BYTES) {
    throw new JournalError('journal_corrupt', 'terminal submission receipt would exceed its size limit');
  }
  const temporary = `${location.path}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
  let handle = null;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(encoded, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporary, 0o600);
    await rename(temporary, location.path);
    if (process.platform !== 'win32') {
      const directory = await open(location.directory, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
    }
    await ensurePrivateFile(location.path);
    return receipt;
  } catch (error) {
    try { if (handle) await handle.close(); } catch { /* best effort */ }
    try { await unlink(temporary); } catch { /* best effort */ }
    throw error;
  }
}

function entryKey(operation, id) {
  return `${operation}:${id}`;
}

function assertExistingEntry(entry, { operation, operationId: id }) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry) || entry.operation !== operation ||
      entry.operationId !== id || typeof entry.annotationId !== 'string' ||
      !entry.annotation || typeof entry.annotation !== 'object' || Array.isArray(entry.annotation) ||
      entry.annotation.id !== entry.annotationId || !['pending', 'accepted', 'rejected'].includes(entry.state)) {
    throw new JournalError('journal_corrupt', 'submission journal entry has an unexpected shape');
  }
  assertNoCredentials(entry.annotation, 'annotation');
  return entry;
}

function createEntry({ operation, operationId: id, annotation }) {
  const timestamp = now();
  return {
    operation,
    operationId: id,
    annotationId: annotation.id,
    annotation,
    state: 'pending',
    deliveryStatus: SUBMISSION_DELIVERY_STATUSES.pending,
    retryable: true,
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function normalizedOutcome(value, { allowAbsent = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'pending', deliveryStatus: SUBMISSION_DELIVERY_STATUSES.pending, retryable: true, error: 'submission_outcome_unavailable' };
  }
  if (value.kind === 'accepted') {
    try {
      return { kind: 'accepted', annotation: cloneAnnotation(value.annotation) };
    } catch {
      return { kind: 'pending', deliveryStatus: SUBMISSION_DELIVERY_STATUSES.pending, retryable: true, error: 'canonical_annotation_invalid' };
    }
  }
  if (allowAbsent && value.kind === 'absent') return { kind: 'absent' };
  if (value.kind === 'rejected') {
    return {
      kind: 'rejected',
      deliveryStatus: typeof value.deliveryStatus === 'string' ? value.deliveryStatus : SUBMISSION_DELIVERY_STATUSES.rejectedRemote,
      retryable: false,
      error: typeof value.error === 'string' ? value.error : 'remote_rejected',
    };
  }
  return {
    kind: 'pending',
    deliveryStatus: typeof value.deliveryStatus === 'string' && RETRYABLE_PENDING.has(value.deliveryStatus)
      ? value.deliveryStatus
      : SUBMISSION_DELIVERY_STATUSES.pending,
    retryable: true,
    error: typeof value.error === 'string' ? value.error : 'remote_unavailable',
  };
}

async function callAdapter(adapter, annotation, { allowAbsent = false } = {}) {
  try {
    return normalizedOutcome(await adapter(annotation), { allowAbsent });
  } catch {
    return { kind: 'pending', deliveryStatus: SUBMISSION_DELIVERY_STATUSES.pending, retryable: true, error: 'network_error' };
  }
}

async function persistEntry(paths, journal, key, entry, outcome) {
  const timestamp = now();
  if (outcome.kind === 'accepted') {
    entry.annotation = outcome.annotation;
    entry.annotationId = outcome.annotation.id;
    entry.state = 'accepted';
    entry.deliveryStatus = SUBMISSION_DELIVERY_STATUSES.accepted;
    entry.retryable = false;
    entry.error = null;
    entry.acceptedAt = timestamp;
  } else if (outcome.kind === 'rejected') {
    entry.state = 'rejected';
    entry.deliveryStatus = outcome.deliveryStatus;
    entry.retryable = false;
    entry.error = outcome.error;
  } else {
    entry.state = 'pending';
    entry.deliveryStatus = outcome.deliveryStatus;
    entry.retryable = true;
    entry.error = outcome.error;
  }
  entry.updatedAt = timestamp;
  if (entry.state === 'accepted' || entry.state === 'rejected') {
    // Write the compact, per-operation receipt first. A crash before the
    // active entry is removed leaves duplicate durable facts, never an
    // untracked cloud write. The receipt contains retry identity only; full
    // annotations remain only while a submission is pending reconciliation.
    await writeTerminalReceipt(paths, entry);
    delete journal.entries[key];
  }
  await writeJournal(paths.journalPath, journal);
}

function resultFromEntry(entry, { duplicate = false } = {}) {
  const outcome = entry.state === 'accepted' ? 'accepted' : entry.state === 'rejected' ? 'rejected' : 'pending';
  return {
    outcome,
    annotation: entry.annotation,
    annotationId: entry.annotationId,
    operationId: entry.operationId,
    deliveryStatus: entry.deliveryStatus,
    retryable: entry.retryable === true,
    error: typeof entry.error === 'string' ? entry.error : null,
    duplicate,
  };
}

function resultFromTerminalReceipt(receipt, {
  outcome = receipt.state,
  annotation = null,
  deliveryStatus = receipt.deliveryStatus,
  retryable = false,
  error = receipt.error,
  duplicate = true,
} = {}) {
  return {
    outcome,
    annotation,
    annotationId: receipt.annotationId,
    operationId: receipt.operationId,
    deliveryStatus,
    retryable,
    error: typeof error === 'string' ? error : null,
    duplicate,
  };
}

async function compactTerminalEntries(paths, journal) {
  let changed = false;
  for (const [key, entry] of Object.entries(journal.entries)) {
    assertExistingEntry(entry, { operation: entry?.operation, operationId: entry?.operationId });
    if (entry.state === 'pending') continue;
    await writeTerminalReceipt(paths, entry);
    delete journal.entries[key];
    changed = true;
  }
  if (changed) await writeJournal(paths.journalPath, journal);
}

async function replayAcceptedTerminalReceipt(receipt, annotation, reconcile) {
  // The local actionable cache might have failed after cloud acceptance. Never
  // replay its old creation row: an owner may have advanced, dismissed, or
  // deleted it while this process was down. A terminal receipt fences POST;
  // exact-ID GET is the only way to repair that cache.
  const candidate = { ...annotation, id: receipt.annotationId };
  const reconciled = await callAdapter(reconcile, candidate, { allowAbsent: true });
  if (reconciled.kind === 'accepted') {
    return resultFromTerminalReceipt(receipt, {
      outcome: 'accepted',
      annotation: reconciled.annotation,
      deliveryStatus: SUBMISSION_DELIVERY_STATUSES.accepted,
      retryable: false,
      error: null,
    });
  }
  if (reconciled.kind === 'absent') {
    return resultFromTerminalReceipt(receipt, {
      outcome: 'rejected',
      deliveryStatus: SUBMISSION_DELIVERY_STATUSES.reconciledAbsent,
      retryable: false,
      error: 'canonical_annotation_absent',
    });
  }
  if (reconciled.kind === 'rejected') {
    return resultFromTerminalReceipt(receipt, {
      outcome: 'rejected',
      deliveryStatus: reconciled.deliveryStatus,
      retryable: false,
      error: reconciled.error,
    });
  }
  return resultFromTerminalReceipt(receipt, {
    outcome: 'pending',
    deliveryStatus: reconciled.deliveryStatus,
    retryable: true,
    error: reconciled.error,
  });
}

async function settleAfterSend({ paths, journal, key, entry, send, reconcile }) {
  entry.attempts = Number.isInteger(entry.attempts) ? entry.attempts + 1 : 1;
  entry.lastAttemptAt = now();
  await writeJournal(paths.journalPath, journal);
  const sent = await callAdapter(send, entry.annotation);
  if (sent.kind === 'accepted' || sent.kind === 'rejected') {
    await persistEntry(paths, journal, key, entry, sent);
    return resultFromEntry(entry);
  }
  const reconciled = await callAdapter(reconcile, entry.annotation, { allowAbsent: true });
  if (reconciled.kind === 'accepted' || reconciled.kind === 'rejected') {
    await persistEntry(paths, journal, key, entry, reconciled);
    return resultFromEntry(entry);
  }
  await persistEntry(paths, journal, key, entry, reconciled.kind === 'absent' ? sent : reconciled);
  return resultFromEntry(entry);
}

function journalFailure(error, operationIdValue, annotation) {
  const busy = error?.code === 'journal_busy';
  const invalid = new Set(['operation_id_invalid', 'journal_operation_invalid', 'journal_payload_invalid']);
  return {
    outcome: invalid.has(error?.code) ? 'rejected' : 'pending',
    annotation: annotation || null,
    annotationId: annotation?.id || null,
    operationId: operationIdValue || null,
    deliveryStatus: invalid.has(error?.code)
      ? SUBMISSION_DELIVERY_STATUSES.rejectedValidation
      : busy ? SUBMISSION_DELIVERY_STATUSES.journalBusy : SUBMISSION_DELIVERY_STATUSES.journalUnavailable,
    retryable: !invalid.has(error?.code),
    error: typeof error?.code === 'string' ? error.code : 'journal_unavailable',
    duplicate: false,
  };
}

export function createSubmissionOperationId() {
  return `sub_${randomBytes(18).toString('base64url')}`;
}

export function submissionJournalPaths({ privateConfigDir, projectId, pageUrl, syncServerUrl } = {}) {
  const project = safeString(projectId, 'projectId', { max: 200 });
  const page = exactPageUrl(pageUrl);
  const endpoint = canonicalSyncUrl(syncServerUrl);
  const privateRoot = privateConfigRoot(privateConfigDir);
  const journalRoot = join(privateRoot, 'submission-journal');
  const scope = {
    projectHash: sha256(project),
    pageUrlHash: sha256(page),
    syncUrlHash: sha256(endpoint),
  };
  scope.scopeHash = sha256(`${JOURNAL_VERSION}\u0000${scope.projectHash}\u0000${scope.pageUrlHash}\u0000${scope.syncUrlHash}`);
  const scopeDirectory = join(journalRoot, `v${JOURNAL_VERSION}`, scope.projectHash, scope.pageUrlHash, scope.syncUrlHash);
  if (!within(journalRoot, scopeDirectory)) throw new JournalError('journal_scope_invalid', 'journal scope escaped its private root');
  return {
    journalRoot,
    scopeDirectory,
    journalPath: join(scopeDirectory, 'journal.json'),
    lockPath: join(scopeDirectory, '.journal.lock'),
    receiptRoot: join(scopeDirectory, 'receipts'),
    scope,
  };
}

// The callbacks are intentionally supplied by core. This module owns only
// durable local state and never receives a license key, authorization header,
// or provider capability.
export async function submitJournaledAnnotation({
  privateConfigDir,
  projectId,
  pageUrl,
  syncServerUrl,
  operation,
  operationId: suppliedOperationId,
  annotation: suppliedAnnotation,
  send,
  reconcile,
  lockWaitMs,
  beforeStaleLockRecovery,
} = {}) {
  let paths;
  let id;
  let name;
  let annotation;
  try {
    id = operationId(suppliedOperationId);
    name = operationName(operation);
    annotation = cloneAnnotation(suppliedAnnotation);
    if (typeof send !== 'function' || typeof reconcile !== 'function') {
      throw new JournalError('journal_adapter_invalid', 'submission adapters are required');
    }
    paths = submissionJournalPaths({ privateConfigDir, projectId, pageUrl, syncServerUrl });
    await ensurePrivateDirectory(paths.journalRoot);
    await ensurePrivateDirectory(join(paths.journalRoot, `v${JOURNAL_VERSION}`));
    await ensurePrivateDirectory(join(paths.journalRoot, `v${JOURNAL_VERSION}`, paths.scope.projectHash));
    await ensurePrivateDirectory(join(paths.journalRoot, `v${JOURNAL_VERSION}`, paths.scope.projectHash, paths.scope.pageUrlHash));
    await ensurePrivateDirectory(paths.scopeDirectory);
  } catch (error) {
    return journalFailure(error, id, annotation);
  }

  let release = null;
  try {
    release = await acquireLock(paths.lockPath, { waitMs: lockWaitMs, beforeStaleLockRecovery });
    const journal = await readJournal(paths.journalPath, paths.scope);
    await compactTerminalEntries(paths, journal);
    const key = entryKey(name, id);
    const terminalReceipt = await readTerminalReceipt(paths, name, id);
    if (terminalReceipt) {
      if (terminalReceipt.state === 'rejected') return resultFromTerminalReceipt(terminalReceipt);
      return await replayAcceptedTerminalReceipt(terminalReceipt, annotation, reconcile);
    }
    let entry = journal.entries[key];
    if (entry) {
      entry = assertExistingEntry(entry, { operation: name, operationId: id });
      if (entry.state !== 'pending') throw new JournalError('journal_corrupt', 'terminal entry was not compacted');
      const reconciled = await callAdapter(reconcile, entry.annotation, { allowAbsent: true });
      if (reconciled.kind === 'accepted' || reconciled.kind === 'rejected' || reconciled.kind === 'pending') {
        await persistEntry(paths, journal, key, entry, reconciled);
        return resultFromEntry(entry, { duplicate: true });
      }
      return await settleAfterSend({ paths, journal, key, entry, send, reconcile });
    }

    if (Object.keys(journal.entries).length >= MAX_ENTRIES) {
      throw new JournalError('journal_corrupt', 'submission journal has reached its entry limit');
    }
    entry = createEntry({ operation: name, operationId: id, annotation });
    journal.entries[key] = entry;
    // This durable write is intentionally complete before the first cloud call.
    await writeJournal(paths.journalPath, journal);
    return await settleAfterSend({ paths, journal, key, entry, send, reconcile });
  } catch (error) {
    return journalFailure(error, id, annotation);
  } finally {
    if (release) {
      try { await release(); } catch { /* a later stale-lock recovery preserves crash safety */ }
    }
  }
}
