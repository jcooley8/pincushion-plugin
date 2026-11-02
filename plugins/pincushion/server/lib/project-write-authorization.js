import { readClaimResumeAuthorization } from '../claim.mjs';

// Reuse the shipped exact-project role predicate without changing claim behavior.
// The caller supplies only its already configured endpoint, credential and scope.
export async function readProjectWriteAuthorization({ projectId, expectedProjectId, functionsBase, licenseKey } = {}) {
  const candidate = typeof projectId === 'string' ? projectId.trim() : '';
  const id = /^[A-Za-z0-9_-]{1,128}$/.test(candidate) ? candidate : '';
  const denied = (reason) => ({ projectId: id, authorized: false, reason });
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || id !== expectedProjectId) return denied('denied');
  if (!licenseKey) return denied('unavailable');
  let base;
  try {
    base = new URL(functionsBase);
    if (base.username || base.password || base.search || base.hash ||
        !(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
      return denied('unavailable');
    }
  } catch { return denied('unavailable'); }
  const controller = new AbortController();
  let timer;
  const deadline = new Promise(resolve => {
    timer = setTimeout(() => { controller.abort(); resolve({ authorized: false, reason: 'unavailable' }); }, 5000);
  });
  try {
    const result = await Promise.race([deadline, readClaimResumeAuthorization({
      projectId: id, licenseKey, functionsBase: base.href.replace(/\/$/, ''),
      fetchImpl: async (url, options) => {
        const response = await fetch(url, { ...options, signal: controller.signal, redirect: 'error' });
        if (response.redirected || (response.status >= 300 && response.status < 400)) return { ok: false };
        return response;
      },
    })]);
    return { projectId: id, authorized: result.authorized === true,
      reason: result.authorized === true ? 'authorized' : result.reason === 'denied' ? 'denied' : 'unavailable' };
  } catch { return denied('unavailable'); }
  finally { clearTimeout(timer); controller.abort(); }
}
