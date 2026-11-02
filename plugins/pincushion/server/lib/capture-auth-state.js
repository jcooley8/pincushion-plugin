// Guarded local authentication-state handling for browser captures. This is a
// Node-only boundary: it reads no credential values into receipts or logs and
// returns only a mode plus bounded failure code to the capture caller.

import { createHash } from 'node:crypto';
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';

export const AUTH_CAPTURE_FAILURE_EXIT_CODE = 6;
export const MAX_AUTH_STATE_BYTES = 4 * 1024 * 1024;
export const MAX_AUTH_PROOF_BYTES = 16 * 1024;
export const MAX_AUTH_PROOF_SELECTOR_LENGTH = 512;
export const AUTH_PROOF_VERSION = 1;

const AUTHISH_NAME = /(?:auth|session|token|sid|jwt|identity|credential|login|bearer)/i;

function failure(code) {
  return { ok: false, code };
}

function privateFields(result, fields) {
  Object.defineProperties(result, Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, {
    value,
    enumerable: false,
    configurable: false,
    writable: false,
  }])));
  return result;
}

function targetDescriptor(targetUrl) {
  try {
    const url = new URL(String(targetUrl || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return { origin: url.origin, hostname: url.hostname.toLowerCase(), protocol: url.protocol };
  } catch {
    return null;
  }
}

function safePath(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function hasSafePosixPermissions(stat) {
  return Number.isInteger(stat?.mode) && (stat.mode & 0o077) === 0;
}

function secureReadRegularFile({
  filePath,
  label,
  maxBytes,
  platform = process.platform,
  currentUid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const path = safePath(filePath);
  if (!path) return failure(`${label}_missing`);
  if (platform === 'win32') return failure(`${label}_permissions_unverifiable`);

  let initial;
  try {
    initial = lstatSync(path);
  } catch {
    return failure(`${label}_missing_or_unreadable`);
  }
  if (initial.isSymbolicLink()) return failure(`${label}_symlink_rejected`);
  if (!initial.isFile()) return failure(`${label}_not_regular_file`);
  if (initial.size <= 0 || initial.size > maxBytes) return failure(`${label}_size_invalid`);
  if (!hasSafePosixPermissions(initial)) return failure(`${label}_permissions_insecure`);
  if (!Number.isInteger(currentUid) || !Number.isInteger(initial.uid)) return failure(`${label}_owner_unverifiable`);
  if (initial.uid !== currentUid) return failure(`${label}_owner_mismatch`);
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) return failure(`${label}_no_follow_unavailable`);

  let descriptor;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  } catch {
    return failure(`${label}_missing_or_unreadable`);
  }

  let raw;
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isFile()) return failure(`${label}_not_regular_file`);
    if (opened.dev !== initial.dev || opened.ino !== initial.ino) return failure(`${label}_changed_during_read`);
    if (!hasSafePosixPermissions(opened)) return failure(`${label}_permissions_insecure`);
    if (!Number.isInteger(opened.uid) || opened.uid !== currentUid) return failure(`${label}_owner_mismatch`);
    raw = readFileSync(descriptor, 'utf8');
    const after = fstatSync(descriptor);
    if (after.dev !== opened.dev || after.ino !== opened.ino || after.size !== opened.size) {
      return failure(`${label}_changed_during_read`);
    }
  } catch {
    return failure(`${label}_missing_or_unreadable`);
  } finally {
    try { closeSync(descriptor); } catch { /* descriptor is best-effort cleanup */ }
  }

  return { ok: true, raw };
}

function isCookieBoundToTarget(cookie, target, nowSeconds) {
  if (!cookie || typeof cookie !== 'object') return false;
  const rawDomain = String(cookie.domain || '').trim().toLowerCase().replace(/^\.+/, '');
  if (!rawDomain || (target.hostname !== rawDomain && !target.hostname.endsWith(`.${rawDomain}`))) return false;
  const expires = Number(cookie.expires);
  if (Number.isFinite(expires) && expires > 0 && expires <= nowSeconds) return false;
  if (cookie.secure === true && target.protocol !== 'https:') return false;
  return true;
}

function stateHasTargetCredential(state, target, nowSeconds) {
  let targetBound = false;
  let credentialBound = false;
  for (const cookie of state.cookies) {
    if (!isCookieBoundToTarget(cookie, target, nowSeconds)) continue;
    targetBound = true;
    // Require a credential-shaped key even for HttpOnly cookies. Any target
    // cookie can be HttpOnly (for example consent/feature state), so that flag
    // alone cannot prove a session rather than a signed-out browser shell.
    if (AUTHISH_NAME.test(String(cookie.name || ''))) credentialBound = true;
  }
  for (const originState of state.origins) {
    if (!originState || typeof originState !== 'object' || targetDescriptor(originState.origin)?.origin !== target.origin) continue;
    const localStorage = Array.isArray(originState.localStorage) ? originState.localStorage : [];
    if (!localStorage.length) continue;
    targetBound = true;
    if (localStorage.some((entry) => entry && AUTHISH_NAME.test(String(entry.name || '')))) credentialBound = true;
  }
  return { targetBound, credentialBound };
}

export function authProofPathForStorageState(statePath) {
  const path = safePath(statePath);
  return path ? `${path}.proof.json` : null;
}

export function normalizeCaptureAuthProofSelector(value) {
  if (typeof value !== 'string') return null;
  const selector = value.trim();
  if (!selector || selector.length > MAX_AUTH_PROOF_SELECTOR_LENGTH || /[\u0000-\u001f\u007f]/.test(selector)) return null;
  // Do not allow a document-wide shell as "proof". The selector remains an
  // explicit application contract, but these trivial forms can never prove a
  // signed-in state rather than a neutral 200 page.
  if (['*', 'html', 'body', 'html body', 'body html'].includes(selector.replace(/\s+/g, ' ').toLowerCase())) return null;
  return selector;
}

export function buildCaptureAuthProof({ targetUrl, selector, storageStateDigest } = {}) {
  const target = targetDescriptor(targetUrl);
  const proofSelector = normalizeCaptureAuthProofSelector(selector);
  if (!target) return failure('auth_proof_target_origin_invalid');
  if (!proofSelector) return failure('auth_proof_selector_invalid');
  if (!/^[a-f0-9]{64}$/i.test(String(storageStateDigest || ''))) return failure('auth_proof_state_digest_invalid');
  return {
    ok: true,
    proof: {
      version: AUTH_PROOF_VERSION,
      origin: target.origin,
      selector: proofSelector,
      state_digest: String(storageStateDigest).toLowerCase(),
    },
  };
}

// Validate an already-parsed Playwright state against the exact bytes that will
// be persisted. Snapshot creation uses this form so it can bind the proof to
// the state before publishing either file; capture itself uses the guarded
// pathname reader below and then passes this parsed object to Playwright.
export function validateCaptureStorageStateObject({
  storageState,
  rawState,
  targetUrl,
  now = Date.now(),
} = {}) {
  const target = targetDescriptor(targetUrl);
  if (!target) return failure('auth_target_origin_invalid');
  if (typeof rawState !== 'string' || !rawState || Buffer.byteLength(rawState, 'utf8') > MAX_AUTH_STATE_BYTES) {
    return failure('auth_state_size_invalid');
  }
  const state = storageState;
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !Array.isArray(state.cookies) || !Array.isArray(state.origins)) {
    return failure('auth_state_malformed');
  }
  const binding = stateHasTargetCredential(state, target, Number(now) / 1000);
  if (!binding.targetBound) return failure('auth_state_origin_mismatch');
  if (!binding.credentialBound) return failure('auth_state_lacks_auth_credential');

  return privateFields({
    ok: true,
    mode: 'authenticated',
    expected: true,
  }, {
    storageState: state,
    storageStateDigest: createHash('sha256').update(rawState).digest('hex'),
    targetOrigin: target.origin,
  });
}

// Verify a Playwright storageState file without following a link or returning
// cookie/local-storage content. The parsed object is intentionally kept
// non-enumerable on the result and is passed directly to Playwright so the
// browser never reopens this pathname after the guarded read.
export function validateCaptureStorageState({
  statePath,
  targetUrl,
  now = Date.now(),
  platform = process.platform,
  currentUid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const target = targetDescriptor(targetUrl);
  if (!target) return failure('auth_target_origin_invalid');
  const file = secureReadRegularFile({
    filePath: statePath,
    label: 'auth_state',
    maxBytes: MAX_AUTH_STATE_BYTES,
    platform,
    currentUid,
  });
  if (!file.ok) return file;

  let state;
  try {
    state = JSON.parse(file.raw);
  } catch {
    return failure('auth_state_malformed');
  }
  return validateCaptureStorageStateObject({ storageState: state, rawState: file.raw, targetUrl, now });
}

export function validateCaptureAuthProof({
  proofPath,
  targetUrl,
  storageStateDigest,
  platform = process.platform,
  currentUid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const target = targetDescriptor(targetUrl);
  if (!target) return failure('auth_proof_target_origin_invalid');
  if (!/^[a-f0-9]{64}$/i.test(String(storageStateDigest || ''))) return failure('auth_proof_state_digest_invalid');
  const file = secureReadRegularFile({
    filePath: proofPath,
    label: 'auth_proof',
    maxBytes: MAX_AUTH_PROOF_BYTES,
    platform,
    currentUid,
  });
  if (!file.ok) return file;

  let proof;
  try {
    proof = JSON.parse(file.raw);
  } catch {
    return failure('auth_proof_malformed');
  }
  const selector = normalizeCaptureAuthProofSelector(proof?.selector);
  if (!proof || typeof proof !== 'object' || Array.isArray(proof) || proof.version !== AUTH_PROOF_VERSION || !selector) {
    return failure('auth_proof_malformed');
  }
  if (targetDescriptor(proof.origin)?.origin !== target.origin) return failure('auth_proof_origin_mismatch');
  if (String(proof.state_digest || '').toLowerCase() !== String(storageStateDigest).toLowerCase()) {
    return failure('auth_proof_state_mismatch');
  }
  return { ok: true, selector };
}

// A supplied state always means authenticated capture was expected. Public
// anonymous capture remains available only when no state was supplied or
// required. Every authenticated state also needs an explicit, origin-bound
// proof companion so a neutral signed-out 200 shell cannot be captured.
export function resolveCaptureAuthentication({
  targetUrl,
  storageStatePath,
  storageStateSupplied = storageStatePath !== undefined,
  requireAuthenticated = false,
  proofPath,
  platform = process.platform,
  currentUid = typeof process.getuid === 'function' ? process.getuid() : null,
} = {}) {
  const path = safePath(storageStatePath);
  const expected = requireAuthenticated === true || storageStateSupplied === true || Boolean(path);
  if (!path) {
    return expected
      ? failure('auth_state_required')
      : { ok: true, mode: 'anonymous', expected: false };
  }
  const state = validateCaptureStorageState({ statePath: path, targetUrl, platform, currentUid });
  if (!state.ok) return state;
  const proof = validateCaptureAuthProof({
    proofPath: proofPath === undefined ? authProofPathForStorageState(path) : proofPath,
    targetUrl,
    storageStateDigest: state.storageStateDigest,
    platform,
    currentUid,
  });
  if (!proof.ok) return proof;
  return privateFields(state, { proofSelector: proof.selector });
}

export function captureAuthReceipt(authentication) {
  return {
    mode: authentication?.mode === 'authenticated' ? 'authenticated' : 'anonymous',
    expected: authentication?.expected === true,
  };
}

function isAuthRoute(url) {
  try {
    return /(?:^|\/)(?:login|log-in|sign-in|signin|authenticate|authentication|session|sso)(?:\/|$)/i.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

// The browser collector deliberately returns only boolean categories. It never
// returns page text, selector values, cookies, local storage, or screenshots.
export function classifyAuthenticationChallenge({
  status = null,
  requestedUrl,
  finalUrl,
  authExpected = false,
  signals = {},
} = {}) {
  if (status === 401 || status === 403) return { reason: `http_${status}` };
  const requested = targetDescriptor(requestedUrl);
  const final = targetDescriptor(finalUrl);
  if (requested && final && requested.origin !== final.origin && authExpected) {
    return { reason: 'auth_cross_origin_redirect' };
  }
  if (requestedUrl !== finalUrl && isAuthRoute(finalUrl)) return { reason: 'auth_redirect' };
  if (signals.credentialControl === true || signals.signedOutAttribute === true) return { reason: 'auth_challenge' };
  // When auth was explicitly expected, a signed-out shell can present only a
  // sign-in affordance or status message and no password form. Treat it as an
  // auth challenge unless a signed-in marker is simultaneously visible.
  if (authExpected && signals.signedInMarker !== true &&
      (signals.authCopy === true || signals.signInControl === true || signals.challengeUninspectable === true)) {
    return { reason: signals.challengeUninspectable === true ? 'auth_challenge_uninspectable' : 'auth_challenge' };
  }
  return null;
}
