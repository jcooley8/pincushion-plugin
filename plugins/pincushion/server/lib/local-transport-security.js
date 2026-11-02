// Local HTTP transport boundaries for the MCP process.
//
// The REST wrapper and dashboard bridge are intentionally different trust
// domains. A local port is reachable by every browser process on the machine,
// so loopback binding alone is not authorization. Each MCP process creates
// separate opaque capabilities for REST and for its generated dashboard.
//
// Cloud-attested Chrome bridge grants are deliberately injected here rather
// than implemented in this module. Until a verifier is supplied, Chrome bridge
// reads and pushes fail closed. The verifier owns any cloud credential; no
// account key is ever accepted or forwarded by a localhost request.

import { randomBytes, timingSafeEqual } from 'crypto';
import { chmod, mkdir, rm, stat, writeFile } from 'fs/promises';
import { homedir } from 'os';
import { join } from 'path';

export const LOCAL_CAPABILITY_HEADER = 'x-pincushion-local-capability';
export const CLOUD_BRIDGE_GRANT_HEADER = 'x-pincushion-bridge-grant';
export const CHROME_ORIGIN_CLAIM_HEADER = 'x-pincushion-chrome-origin';
const BRIDGE_CORS_REQUEST_HEADERS = new Set(['content-type', CLOUD_BRIDGE_GRANT_HEADER, CHROME_ORIGIN_CLAIM_HEADER]);
export const LOCAL_BRIDGE_AUDIENCE = 'pincushion-local-bridge';
export const DEFAULT_LOCAL_BODY_LIMIT_BYTES = 256 * 1024;
export const DEFAULT_LOCAL_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_LOCAL_HEADER_TIMEOUT_MS = 15_000;
export const DEFAULT_LOCAL_RECEIVE_TIMEOUT_MS = 90_000;
export const DEFAULT_LOCAL_TOOL_EXECUTION_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_BRIDGE_CHALLENGE_TTL_MS = 120_000;
const DASHBOARD_CORS_REQUEST_HEADERS = new Set([
  'content-type',
  LOCAL_CAPABILITY_HEADER,
]);

export class LocalTransportError extends Error {
  constructor(code, status, message = code) {
    super(message);
    this.name = 'LocalTransportError';
    this.code = code;
    this.status = status;
  }
}

function fail(code, status, message) {
  return new LocalTransportError(code, status, message);
}

function nonBlankString(value, maxLength = 4096) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed && trimmed.length <= maxLength ? trimmed : '';
}

function lifecycleTimestamp(value) {
  const raw = nonBlankString(value, 128);
  const timestamp = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : '';
}

/**
 * The Chrome bridge only needs lifecycle facts to update an existing local
 * pin. Never return a cached annotation object wholesale: old cache formats
 * can carry account aliases, provider data, screenshots, or workspace paths.
 * The page and project bindings come from the already-authorized request,
 * rather than from a mutable annotation row.
 */
export function projectBridgeStatusAnnotation(annotation, { pageUrl, projectId } = {}) {
  if (!annotation || typeof annotation !== 'object' || Array.isArray(annotation)) return null;
  const id = nonBlankString(annotation.id, 512);
  const boundPageUrl = nonBlankString(pageUrl, 8 * 1024);
  const boundProjectId = nonBlankString(projectId, 512);
  if (!id || !boundPageUrl || !boundProjectId) return null;

  const projected = {
    id,
    pageUrl: boundPageUrl,
    projectId: boundProjectId,
  };
  // The status route only uses these terminal lifecycle markers. Do not echo
  // arbitrary legacy values merely because they occupy a familiar key.
  if (annotation.status === 'resolved') projected.status = 'resolved';
  if (annotation.action === 'implemented') projected.action = 'implemented';
  for (const field of ['updatedAt', 'resolvedAt', 'implementedAt']) {
    const value = lifecycleTimestamp(annotation[field]);
    if (value) projected[field] = value;
  }
  return projected;
}

function headerValue(request, name) {
  const value = request?.headers?.[name];
  if (Array.isArray(value)) return '';
  return typeof value === 'string' ? value : '';
}

function requestedCorsHeaders(request) {
  const raw = headerValue(request, 'access-control-request-headers');
  if (!raw) return [];
  return raw.split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
}

function timingSafeTokenMatch(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const expectedBytes = Buffer.from(expected, 'utf8');
  const receivedBytes = Buffer.from(received, 'utf8');
  return expectedBytes.length === receivedBytes.length && timingSafeEqual(expectedBytes, receivedBytes);
}

function privateStateDirectory() {
  return join(homedir(), '.pincushion', 'local-transports');
}

function opaqueToken(randomBytesFactory, byteLength = 32) {
  return randomBytesFactory(byteLength).toString('base64url');
}

function validChromeExtensionOrigin(origin) {
  // Browser Origin serialization never includes a path, credentials, port,
  // query, or fragment. Require that exact canonical wire form so the local
  // grant boundary and the cloud issuer bind the same origin string.
  return typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
}

// MV3 background GETs omit Origin. The explicit claim is public routing
// metadata only: the cloud-attested grant remains the authorization boundary.
// A web page cannot use the claim to override its browser-supplied Origin.
function bridgeRequestOrigin(request) {
  const nativeOrigin = headerValue(request, 'origin');
  const claim = headerValue(request, CHROME_ORIGIN_CLAIM_HEADER);
  if ((nativeOrigin && !validChromeExtensionOrigin(nativeOrigin))
    || (claim && !validChromeExtensionOrigin(claim))
    || (nativeOrigin && claim && nativeOrigin !== claim)) {
    throw fail('bridge_origin_not_allowed', 403);
  }
  const origin = nativeOrigin || claim;
  if (!validChromeExtensionOrigin(origin)) throw fail('bridge_origin_not_allowed', 403);
  return origin;
}

function validGrantResult(result, { expectedProjectId, now }) {
  if (!result || result.valid !== true) return null;
  const projectId = nonBlankString(result.projectId, 512);
  const actorId = nonBlankString(result.actorId, 512);
  const expiresAt = typeof result.expiresAt === 'string' ? Date.parse(result.expiresAt) : NaN;
  if (!projectId || !actorId || projectId !== expectedProjectId || !Number.isFinite(expiresAt) || expiresAt <= now) {
    return null;
  }
  return { projectId, actorId, expiresAt: new Date(expiresAt).toISOString() };
}

async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const info = await stat(directory);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0) {
    throw fail('local_state_permissions_invalid', 500, 'Local transport state directory is not owner-only');
  }
}

function declaredContentLength(request) {
  const raw = headerValue(request, 'content-length');
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return NaN;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : NaN;
}

/**
 * Read one bounded JSON request body. This helper owns the request deadline so
 * every local HTTP mutation has the same body-size and slow-client boundary.
 */
export function readBoundedJsonBody(request, {
  limitBytes = DEFAULT_LOCAL_BODY_LIMIT_BYTES,
  timeoutMs = DEFAULT_LOCAL_REQUEST_TIMEOUT_MS,
} = {}) {
  const maximum = Number.isSafeInteger(limitBytes) && limitBytes > 0 ? limitBytes : DEFAULT_LOCAL_BODY_LIMIT_BYTES;
  const deadline = Number.isSafeInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_LOCAL_REQUEST_TIMEOUT_MS;
  const declared = declaredContentLength(request);
  if (Number.isNaN(declared)) return Promise.reject(fail('invalid_content_length', 400));
  if (declared !== null && declared > maximum) return Promise.reject(fail('request_body_too_large', 413));

  return new Promise((resolve, reject) => {
    let completed = false;
    let total = 0;
    const chunks = [];

    const cleanup = () => {
      clearTimeout(timer);
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('aborted', onAborted);
      request.off('error', onError);
    };
    const rejectOnce = (error) => {
      if (completed) return;
      completed = true;
      cleanup();
      // Keep a timed-out/oversized peer from holding the parser in paused mode.
      // The caller closes the response; resuming only drains this one socket.
      request.resume?.();
      reject(error);
    };
    const resolveOnce = (value) => {
      if (completed) return;
      completed = true;
      cleanup();
      resolve(value);
    };
    const onData = (chunk) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      total += bytes;
      if (total > maximum) {
        rejectOnce(fail('request_body_too_large', 413));
        return;
      }
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    };
    const onEnd = () => {
      const source = Buffer.concat(chunks).toString('utf8');
      if (!source) {
        rejectOnce(fail('invalid_json', 400));
        return;
      }
      try {
        const parsed = JSON.parse(source);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          rejectOnce(fail('invalid_json', 400));
          return;
        }
        resolveOnce(parsed);
      } catch {
        rejectOnce(fail('invalid_json', 400));
      }
    };
    const onAborted = () => rejectOnce(fail('request_aborted', 400));
    const onError = () => rejectOnce(fail('request_stream_error', 400));
    const timer = setTimeout(() => rejectOnce(fail('request_timeout', 408)), deadline);
    timer.unref?.();

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('aborted', onAborted);
    request.once('error', onError);
  });
}

/**
 * Explicitly configure Node's receive-side HTTP deadlines. `requestTimeout`
 * stops slow header/body delivery; it does not bound work after the request
 * body has been read. Keep the ordinary socket timeout disabled so a bounded,
 * authenticated tool execution can finish or report an ambiguous result on its
 * own deadline instead of being silently disconnected mid-operation.
 */
export function configureLocalHttpServer(server, {
  headerTimeoutMs = DEFAULT_LOCAL_HEADER_TIMEOUT_MS,
  requestTimeoutMs = DEFAULT_LOCAL_RECEIVE_TIMEOUT_MS,
} = {}) {
  if (!server || typeof server !== 'object') {
    throw new TypeError('server is required');
  }
  const headerTimeout = Number.isSafeInteger(headerTimeoutMs) && headerTimeoutMs >= 1_000
    ? headerTimeoutMs
    : DEFAULT_LOCAL_HEADER_TIMEOUT_MS;
  const requestTimeout = Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= headerTimeout
    ? requestTimeoutMs
    : Math.max(DEFAULT_LOCAL_RECEIVE_TIMEOUT_MS, headerTimeout);
  server.headersTimeout = headerTimeout;
  server.requestTimeout = requestTimeout;
  // Node checks expired parser sockets on this cadence. The platform default
  // is 30 seconds, which would make a 15-second header deadline observably
  // much looser; one second keeps the configured receive deadlines bounded.
  server.connectionsCheckingInterval = Math.min(1_000, headerTimeout);
  // Node's socket inactivity timeout includes response processing. Leave it
  // disabled explicitly: tool execution is governed by runBoundedLocalOperation
  // below, which can represent an uncancellable result truthfully.
  server.timeout = 0;
  return {
    headerTimeoutMs: headerTimeout,
    requestTimeoutMs: requestTimeout,
    connectionsCheckingIntervalMs: server.connectionsCheckingInterval,
  };
}

/**
 * Bound a local tool response without pretending an overrun was rejected. The
 * underlying work cannot be cancelled safely because it may already have
 * persisted a lifecycle mutation. A caller receives `{ state: 'pending' }`
 * and must treat the outcome as unknown; the supplied late-settlement callback
 * gets only settlement state, never a possibly sensitive result or error.
 */
export async function runBoundedLocalOperation(operation, {
  timeoutMs = DEFAULT_LOCAL_TOOL_EXECUTION_TIMEOUT_MS,
  onLateSettlement = null,
} = {}) {
  if (typeof operation !== 'function') {
    throw new TypeError('operation must be a function');
  }
  const timeout = Number.isSafeInteger(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_LOCAL_TOOL_EXECUTION_TIMEOUT_MS;
  const completion = Promise.resolve().then(operation).then(
    (value) => ({ state: 'completed', value }),
    (error) => ({ state: 'failed', error }),
  );
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ state: 'pending' }), timeout);
    timer.unref?.();
  });
  try {
    const outcome = await Promise.race([completion, deadline]);
    if (outcome.state === 'pending') {
      void completion.then(({ state }) => {
        try { onLateSettlement?.({ state }); } catch { /* observability must not affect work */ }
      });
      return outcome;
    }
    if (outcome.state === 'failed') throw outcome.error;
    return outcome;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Creates one process-bound security context. `verifyCloudBridgeGrant` is the
 * intentionally narrow future cloud boundary. It receives only a presented
 * grant and request binding data, never an account key, and must return
 * `{ valid: true, projectId, actorId, expiresAt }` for the exact request.
 */
export async function createLocalTransportSecurity({
  stateDir = privateStateDirectory(),
  randomBytesFactory = randomBytes,
  now = () => Date.now(),
  processId = process.pid,
  bodyLimitBytes = DEFAULT_LOCAL_BODY_LIMIT_BYTES,
  requestTimeoutMs = DEFAULT_LOCAL_REQUEST_TIMEOUT_MS,
  challengeTtlMs = DEFAULT_BRIDGE_CHALLENGE_TTL_MS,
  verifyCloudBridgeGrant = async () => ({ valid: false, code: 'cloud_bridge_grant_verifier_unavailable' }),
} = {}) {
  if (typeof verifyCloudBridgeGrant !== 'function') {
    throw new TypeError('verifyCloudBridgeGrant must be a function');
  }
  const instanceId = opaqueToken(randomBytesFactory, 18);
  const restCapability = opaqueToken(randomBytesFactory);
  const dashboardCapability = opaqueToken(randomBytesFactory);
  const safeChallengeTtl = Number.isSafeInteger(challengeTtlMs) && challengeTtlMs >= 1_000
    ? challengeTtlMs
    : DEFAULT_BRIDGE_CHALLENGE_TTL_MS;
  const safeBodyLimit = Number.isSafeInteger(bodyLimitBytes) && bodyLimitBytes >= 1024
    ? bodyLimitBytes
    : DEFAULT_LOCAL_BODY_LIMIT_BYTES;
  const safeRequestTimeout = Number.isSafeInteger(requestTimeoutMs) && requestTimeoutMs >= 25
    ? requestTimeoutMs
    : DEFAULT_LOCAL_REQUEST_TIMEOUT_MS;
  const capabilityFile = join(stateDir, `transport-${processId}-${instanceId}.json`);
  // This identifies the current MCP process to a cloud-issued bridge grant.
  // It is not a credential: each challenge gives it a fresh short expiry, and
  // the injected verifier checks the grant expiry/membership on every request.
  const processNonce = opaqueToken(randomBytesFactory, 24);
  let disposed = false;

  await ensurePrivateDirectory(stateDir);
  const createdAt = new Date(now()).toISOString();
  await writeFile(capabilityFile, JSON.stringify({
    version: 1,
    processId,
    instanceId,
    createdAt,
    restCapability,
    dashboardCapability,
  }, null, 2), { encoding: 'utf8', mode: 0o600 });
  // `writeFile(..., mode)` does not change mode on an already-existing path.
  // This is a new random name, but chmod makes the owner-only postcondition
  // explicit and testable.
  await chmod(capabilityFile, 0o600);

  function authorizeExactLoopbackHost(request, port) {
    const safePort = Number.isInteger(port) && port > 0 && port <= 65535 ? port : 0;
    const expected = `127.0.0.1:${safePort}`;
    if (!safePort || headerValue(request, 'host') !== expected) {
      throw fail('invalid_host', 421);
    }
  }

  function requireCapability(request, expectedCapability) {
    const received = headerValue(request, LOCAL_CAPABILITY_HEADER);
    if (!received) throw fail('missing_capability', 401);
    if (!timingSafeTokenMatch(expectedCapability, received)) throw fail('invalid_capability', 403);
  }

  function authorizeRestRequest(request, { port }) {
    authorizeExactLoopbackHost(request, port);
    if (headerValue(request, 'origin')) throw fail('browser_origin_not_allowed', 403);
    requireCapability(request, restCapability);
  }

  function authorizeDashboardRequest(request, { port }) {
    authorizeExactLoopbackHost(request, port);
    const origin = headerValue(request, 'origin');
    if (origin && origin !== 'null') throw fail('dashboard_origin_not_allowed', 403);
    requireCapability(request, dashboardCapability);
  }

  function authorizeDashboardPreflightRequest(request, { port, allowedMethods = [] } = {}) {
    authorizeExactLoopbackHost(request, port);
    if (headerValue(request, 'origin') !== 'null') {
      throw fail('dashboard_origin_not_allowed', 403);
    }
    const requestedMethod = headerValue(request, 'access-control-request-method').toUpperCase();
    if (!Array.isArray(allowedMethods) || !allowedMethods.includes(requestedMethod)) {
      throw fail('dashboard_preflight_not_allowed', 403);
    }
    if (requestedCorsHeaders(request).some((name) => !DASHBOARD_CORS_REQUEST_HEADERS.has(name))) {
      throw fail('dashboard_preflight_not_allowed', 403);
    }
  }

  function authorizeBridgeChallengeRequest(request, { port }) {
    authorizeExactLoopbackHost(request, port);
    bridgeRequestOrigin(request);
  }

  async function authorizeCloudBridgeRequest(request, {
    port,
    scope,
    pathname,
    expectedProjectId,
    requestedPageUrl,
  } = {}) {
    authorizeExactLoopbackHost(request, port);
    const origin = bridgeRequestOrigin(request);
    const grant = nonBlankString(headerValue(request, CLOUD_BRIDGE_GRANT_HEADER), 16 * 1024);
    if (!grant) throw fail('missing_cloud_bridge_grant', 401);
    const projectId = nonBlankString(expectedProjectId, 512);
    const pageUrl = nonBlankString(requestedPageUrl, 8 * 1024);
    if (!projectId || !pageUrl) throw fail('bridge_project_scope_required', 403);
    let verdict;
    try {
      verdict = await verifyCloudBridgeGrant({
        grant,
        audience: LOCAL_BRIDGE_AUDIENCE,
        processNonce,
        scope: nonBlankString(scope, 128),
        method: String(request?.method || '').toUpperCase(),
        pathname: nonBlankString(pathname, 256),
        origin,
        expectedProjectId: projectId,
        requestedPageUrl: pageUrl,
      });
    } catch {
      throw fail('cloud_bridge_grant_invalid', 403);
    }
    const valid = validGrantResult(verdict, { expectedProjectId: projectId, now: now() });
    if (!valid) throw fail('cloud_bridge_grant_invalid', 403);
    return valid;
  }

  return {
    capabilityFile,
    restCapability,
    dashboardCapability,
    bodyLimitBytes: safeBodyLimit,
    requestTimeoutMs: safeRequestTimeout,
    authorizeLoopbackHost(request, { port } = {}) {
      authorizeExactLoopbackHost(request, port);
    },
    applyDashboardCors(response) {
      response.setHeader('Access-Control-Allow-Origin', 'null');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pincushion-Local-Capability');
      response.setHeader('Access-Control-Max-Age', '60');
      response.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    },
    authorizeRestRequest,
    authorizeDashboardRequest,
    authorizeDashboardPreflightRequest,
    authorizeBridgeChallengeRequest,
    authorizeBridgePreflightRequest(request, { port, allowedMethods = [] } = {}) {
      authorizeExactLoopbackHost(request, port);
      bridgeRequestOrigin(request);
      const method = headerValue(request, 'access-control-request-method').toUpperCase();
      if (!allowedMethods.includes(method)
        || requestedCorsHeaders(request).some(name => !BRIDGE_CORS_REQUEST_HEADERS.has(name))) {
        throw fail('bridge_preflight_not_allowed', 403);
      }
    },
    applyBridgeCors(request, response) {
      response.setHeader('Access-Control-Allow-Origin', bridgeRequestOrigin(request));
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      response.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Pincushion-Bridge-Grant, X-Pincushion-Chrome-Origin');
      response.setHeader('Access-Control-Max-Age', '60');
      response.setHeader('Vary', 'Origin, Access-Control-Request-Method, Access-Control-Request-Headers');
    },
    authorizeCloudBridgeRequest,
    readJsonBody(request) {
      return readBoundedJsonBody(request, {
        limitBytes: safeBodyLimit,
        timeoutMs: safeRequestTimeout,
      });
    },
    bridgeChallenge() {
      return {
        processNonce,
        audience: LOCAL_BRIDGE_AUDIENCE,
        expiresAt: new Date(now() + safeChallengeTtl).toISOString(),
      };
    },
    async dispose() {
      if (disposed) return false;
      disposed = true;
      try {
        await rm(capabilityFile, { force: true });
        return true;
      } catch {
        return false;
      }
    },
  };
}

export function localTransportErrorResponse(error) {
  if (error instanceof LocalTransportError) {
    return { status: error.status, body: { error: error.code } };
  }
  return { status: 500, body: { error: 'local_transport_error' } };
}
