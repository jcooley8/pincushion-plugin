// Narrow local-MCP adapter for the Release 4 agency-coordination pilot.
//
// The account credential is sent only in the fixed Edge request header. It is
// never accepted from a tool argument, appended to a URL, cached, or echoed in
// a result. The Edge/database boundary rechecks current identity and exact
// owner/editor membership on every operation.

export const AGENCY_COORDINATION_MAX_RESPONSE_BYTES = 1024 * 1024;
export const AGENCY_COORDINATION_TIMEOUT_MS = 8_000;

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const SENSITIVE_KEY_RE = /(?:license(?:_?key)?|credential|secret|token|authorization|bearer|password|cookie)/i;

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function hasSensitiveKey(value, depth = 0) {
  if (depth > 24) return true;
  if (Array.isArray(value)) return value.some((entry) => hasSensitiveKey(entry, depth + 1));
  if (!isRecord(value)) return false;
  return Object.entries(value).some(([key, entry]) => SENSITIVE_KEY_RE.test(key) || hasSensitiveKey(entry, depth + 1));
}

export function agencyCoordinationEndpoint(syncServerUrl) {
  if (typeof syncServerUrl !== 'string' || !syncServerUrl) return null;
  try {
    const url = new URL(syncServerUrl);
    const loopback = LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
      || url.username || url.password || url.search || url.hash
      || url.pathname !== '/functions/v1/sync-annotations') return null;
    url.pathname = '/functions/v1/agency-coordination';
    return url.toString();
  } catch {
    return null;
  }
}

async function boundedJson(response) {
  const declared = response?.headers?.get?.('content-length');
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > AGENCY_COORDINATION_MAX_RESPONSE_BYTES)) return null;
  if (response?.body?.getReader) {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.byteLength;
        if (total > AGENCY_COORDINATION_MAX_RESPONSE_BYTES) return null;
        chunks.push(chunk);
      }
    } catch {
      return null;
    } finally {
      try { await reader.cancel(); } catch { /* best effort */ }
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    try { return JSON.parse(new TextDecoder().decode(bytes)); } catch { return null; }
  }
  try {
    const value = typeof response?.json === 'function' ? await response.json() : JSON.parse(await response.text());
    const serialized = JSON.stringify(value);
    return Buffer.byteLength(serialized, 'utf8') <= AGENCY_COORDINATION_MAX_RESPONSE_BYTES ? value : null;
  } catch {
    return null;
  }
}

function validEnvelope(value, action, projectId) {
  return isRecord(value) && value.action === action && value.project_id === projectId && isRecord(value.result)
    ? value.result
    : null;
}

export async function requestAgencyCoordination({
  syncServerUrl,
  licenseKey,
  action,
  projectId,
  payload = {},
  fetchImpl = fetch,
  timeoutMs = AGENCY_COORDINATION_TIMEOUT_MS,
} = {}) {
  const endpoint = agencyCoordinationEndpoint(syncServerUrl);
  if (!endpoint) return { error: 'agency_coordination_sync_unavailable' };
  if (typeof licenseKey !== 'string' || !licenseKey || licenseKey.length > 4096) {
    return { error: 'agency_coordination_account_credential_required' };
  }
  if (typeof action !== 'string' || typeof projectId !== 'string' || !isRecord(payload) || hasSensitiveKey(payload)) {
    return { error: 'agency_coordination_invalid_request' };
  }
  const requestBody = { action, project_id: projectId, ...payload };
  if (hasSensitiveKey(requestBody)) return { error: 'agency_coordination_invalid_request' };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(100, Math.min(Number(timeoutMs) || AGENCY_COORDINATION_TIMEOUT_MS, 30_000)));
  try {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json', 'x-license-key': licenseKey },
      body: JSON.stringify(requestBody),
      cache: 'no-store',
      redirect: 'error',
      signal: controller.signal,
    });
    const body = await boundedJson(response);
    if (response?.status === 402 && isRecord(body) && body.error === 'plan_required') {
      return {
        error: 'agency_plan_required',
        status: 402,
        message: typeof body.message === 'string' ? body.message.slice(0, 300) : 'This needs the Agency plan.',
        upgrade_url: 'https://www.pincushion.io/pricing?ref=mcp-agency#agency',
      };
    }
    if (!response?.ok) return { error: 'agency_coordination_not_authorized', status: response?.status || 0 };
    const result = validEnvelope(body, action, projectId);
    return result ? result : { error: 'agency_coordination_invalid_response' };
  } catch {
    return { error: 'agency_coordination_sync_unavailable' };
  } finally {
    clearTimeout(timer);
  }
}
