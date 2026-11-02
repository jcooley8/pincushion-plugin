// Keyless setup contact. Best-effort report of an authenticated MCP call so the
// app Connect step can read connected without a connection key. Never throws,
// never logs the license key, and retries until the ack is {ok:true, observed:true}.

const PROJECT_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/;
const THROTTLE_MS = 60_000;

function syncContactUrl(syncServerUrl) {
  let url;
  try {
    url = new URL(syncServerUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.username || url.password) return null;
  url.search = '';
  url.hash = '';
  if (!url.pathname.endsWith('/sync-annotations')) return null;
  url.searchParams.set('action', 'report_mcp_contact');
  return url;
}

export function createConnectionReporter({ fetchImpl = fetch, now = () => Date.now(), log = () => {} } = {}) {
  const lastAcceptedAt = new Map();
  return {
    async report({ syncServerUrl, licenseKey, projectId, clientName, clientVersion, pkgVersion } = {}) {
      try {
        const project = typeof projectId === 'string' ? projectId : '';
        if (!syncServerUrl || !licenseKey || !PROJECT_RE.test(project)) return { ok: false, reason: 'authenticated_project_required' };
        const url = syncContactUrl(syncServerUrl);
        if (!url) return { ok: false, reason: 'sync_url_invalid' };
        const stamped = lastAcceptedAt.get(project);
        if (stamped !== undefined && now() - stamped < THROTTLE_MS) return { ok: true, throttled: true };
        const version = String(pkgVersion || '0.0.0').replace(/[^\d.]/g, '').slice(0, 40) || '0.0.0';
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-License-Key': licenseKey,
            'X-Pincushion-Client': `mcp/${version}`,
          },
          body: JSON.stringify({
            projectId: project,
            clientName: String(clientName || '').slice(0, 80),
            clientVersion: String(clientVersion || '').slice(0, 40),
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
        });
        const body = response && response.ok ? await response.json() : null;
        if (body && body.ok === true && body.observed === true) {
          lastAcceptedAt.set(project, now());
          return { ok: true, observed: true };
        }
        return { ok: false, reason: 'contact_not_recorded' };
      } catch {
        log('mcp contact report failed');
        return { ok: false, reason: 'contact_unavailable' };
      }
    },
  };
}
