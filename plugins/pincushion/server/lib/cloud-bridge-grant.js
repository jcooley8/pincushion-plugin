// Cloud verifier for the Chrome-to-loopback bridge grant.
//
// This module deliberately has one job: exchange the opaque localhost grant
// plus its exact request bindings for a small cloud verdict. The MCP process
// resolves its current account key for *each* call; it never receives a key
// from localhost and it never caches a successful verdict.

export const LOCAL_BRIDGE_GRANT_AUDIENCE = 'pincushion-local-bridge';
export const CLOUD_BRIDGE_GRANT_VERIFY_TIMEOUT_MS = 3_000;
export const CLOUD_BRIDGE_GRANT_MAX_RESPONSE_BYTES = 16 * 1024;
export const CLOUD_BRIDGE_GRANT_MAX_TTL_MS = 2 * 60 * 1000;

const GRANT_RE = /^[A-Za-z0-9_-]{43}$/;
const PROCESS_NONCE_RE = /^[A-Za-z0-9_-]{16,256}$/;
const CHROME_EXTENSION_ORIGIN_RE = /^chrome-extension:\/\/[a-p]{32}$/;
const MAX_PROJECT_ID_LENGTH = 512;
const MAX_PAGE_URL_LENGTH = 8 * 1024;
const MAX_PATHNAME_LENGTH = 256;

function invalid(code = 'cloud_bridge_grant_invalid') {
  return { valid: false, code };
}

function nonBlankString(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && value.trim() === value
    ? value
    : null;
}

function validPageUrl(value) {
  const pageUrl = nonBlankString(value, MAX_PAGE_URL_LENGTH);
  if (!pageUrl) return null;
  try {
    const parsed = new URL(pageUrl);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname ? pageUrl : null;
  } catch {
    return null;
  }
}

function validChromeOrigin(value) {
  const origin = nonBlankString(value, 128);
  return origin && CHROME_EXTENSION_ORIGIN_RE.test(origin) ? origin : null;
}

function validRoute(scope, method, pathname) {
  const requestMethod = typeof method === 'string' ? method.toUpperCase() : '';
  if (scope === 'bridge:read-status') {
    return requestMethod === 'GET' && (pathname === '/status' || pathname === '/resolved');
  }
  return scope === 'bridge:push'
    && requestMethod === 'POST'
    && (pathname === '/push-annotation' || pathname === '/push-annotations');
}

function normalizeFunctionsBase(value) {
  const raw = nonBlankString(value, 2_048);
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) return null;
    const pathname = parsed.pathname.replace(/\/+$/, '');
    if (!pathname || !pathname.endsWith('/functions/v1')) return null;
    return `${parsed.origin}${pathname}`;
  } catch {
    return null;
  }
}

function validateRequest(request) {
  if (!request || typeof request !== 'object') return null;
  const grant = nonBlankString(request.grant, 128);
  const processNonce = nonBlankString(request.processNonce, 256);
  const projectId = nonBlankString(request.expectedProjectId, MAX_PROJECT_ID_LENGTH);
  const pageUrl = validPageUrl(request.requestedPageUrl);
  const origin = validChromeOrigin(request.origin);
  const pathname = nonBlankString(request.pathname, MAX_PATHNAME_LENGTH);
  const scope = request.scope === 'bridge:read-status' || request.scope === 'bridge:push' ? request.scope : null;
  if (!grant || !GRANT_RE.test(grant) || !processNonce || !PROCESS_NONCE_RE.test(processNonce)
    || !projectId || !pageUrl || !origin || !pathname || request.audience !== LOCAL_BRIDGE_GRANT_AUDIENCE || !scope
    || !validRoute(scope, request.method, pathname)) {
    return null;
  }
  return {
    grant,
    audience: LOCAL_BRIDGE_GRANT_AUDIENCE,
    processNonce,
    scope,
    method: String(request.method).toUpperCase(),
    pathname,
    origin,
    expectedProjectId: projectId,
    requestedPageUrl: pageUrl,
  };
}

function timeoutError() {
  const error = new Error('cloud_bridge_grant_timeout');
  error.code = 'cloud_bridge_grant_timeout';
  return error;
}

async function withDeadline(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(work),
      new Promise((_, reject) => { timer = setTimeout(() => reject(timeoutError()), timeoutMs); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function readBoundedJson(response, remainingMs) {
  const declared = response?.headers?.get?.('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > CLOUD_BRIDGE_GRANT_MAX_RESPONSE_BYTES)) return null;

  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const result = await withDeadline(() => reader.read(), remainingMs());
        if (result.done) break;
        const chunk = result.value instanceof Uint8Array ? result.value : new Uint8Array(result.value);
        total += chunk.byteLength;
        if (total > CLOUD_BRIDGE_GRANT_MAX_RESPONSE_BYTES) return null;
        chunks.push(chunk);
      }
    } catch {
      return null;
    } finally {
      // Cancellation can itself hang in a broken transport. Never let it
      // extend the authorization deadline; the outer AbortController closes
      // the native connection independently.
      try { void Promise.resolve(reader.cancel()).catch(() => {}); } catch { /* already closed */ }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try {
      return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return null;
    }
  }

  // The fallback makes the adapter testable with minimal Response-like mocks.
  // Native fetch responses use the bounded stream path above.
  try {
    const body = typeof response?.text === 'function'
      ? await withDeadline(() => response.text(), remainingMs())
      : await withDeadline(() => response?.json?.(), remainingMs());
    const source = typeof body === 'string' ? body : JSON.stringify(body);
    if (!source || Buffer.byteLength(source, 'utf8') > CLOUD_BRIDGE_GRANT_MAX_RESPONSE_BYTES) return null;
    return typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return null;
  }
}

function validVerdict(body, request, now) {
  if (!body || typeof body !== 'object' || body.valid !== true) return null;
  const projectId = nonBlankString(body.projectId, MAX_PROJECT_ID_LENGTH);
  const actorId = nonBlankString(body.actorId, 512);
  const expiresAt = nonBlankString(body.expiresAt, 128);
  const expiryMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  if (!projectId || projectId !== request.expectedProjectId || !actorId || !Number.isFinite(expiryMs)
    || expiryMs <= now || expiryMs > now + CLOUD_BRIDGE_GRANT_MAX_TTL_MS + 5_000) {
    return null;
  }
  return { valid: true, projectId, actorId, expiresAt: new Date(expiryMs).toISOString() };
}

/**
 * Create the local transport's injected cloud verifier.
 *
 * `getLicenseKey` must resolve the MCP process's own current cloud credential.
 * It is called for every verification, deliberately after locally validating
 * the presented grant and request shape. The resulting key is only sent to
 * the configured HTTPS Edge endpoint and is never returned or logged here.
 */
export function createCloudBridgeGrantVerifier({
  functionsBase,
  getLicenseKey,
  fetchImpl = globalThis.fetch,
  timeoutMs = CLOUD_BRIDGE_GRANT_VERIFY_TIMEOUT_MS,
  now = () => Date.now(),
} = {}) {
  const base = normalizeFunctionsBase(functionsBase);
  const deadline = Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 30_000
    ? timeoutMs
    : CLOUD_BRIDGE_GRANT_VERIFY_TIMEOUT_MS;
  if (!base || typeof getLicenseKey !== 'function' || typeof fetchImpl !== 'function') {
    return async () => invalid('cloud_bridge_grant_verifier_unavailable');
  }

  return async function verifyCloudBridgeGrant(request) {
    const verifiedRequest = validateRequest(request);
    if (!verifiedRequest) return invalid();

    const deadlineAt = Date.now() + deadline;
    const remainingMs = () => {
      const remaining = deadlineAt - Date.now();
      if (remaining <= 0) throw timeoutError();
      return remaining;
    };
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), deadline);
    try {
      let licenseKey;
      try {
        licenseKey = await withDeadline(() => getLicenseKey(), remainingMs());
      } catch {
        return invalid('cloud_bridge_authorization_unavailable');
      }
      if (!nonBlankString(licenseKey, 512)) return invalid('cloud_bridge_authorization_unavailable');
      const response = await withDeadline(() => fetchImpl(`${base}/local-bridge-grant?action=verify`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-License-Key': licenseKey,
        },
        body: JSON.stringify(verifiedRequest),
        signal: controller.signal,
      }), remainingMs());
      if (!response?.ok) return invalid();
      // One absolute budget covers credential resolution, headers and every
      // body chunk. A peer cannot extend it by dribbling a bounded payload.
      const body = await withDeadline(() => readBoundedJson(response, remainingMs), remainingMs());
      const verdict = validVerdict(body, verifiedRequest, now());
      return verdict || invalid();
    } catch {
      return invalid('cloud_bridge_authorization_unavailable');
    } finally {
      clearTimeout(abortTimer);
      controller.abort();
    }
  };
}
