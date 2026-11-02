// Where this install came from, recorded once on the account.
//
// Each registry listing and install link carries its own ref tag: the server
// reads `--ref SLUG` or PINCUSHION_REF, and `pincushion-mcp setup --ref SLUG`
// passes one too. The first tag seen on this machine is kept in
// ~/.pincushion/install-ref so a later login or plain launch still reports it.
// On connect the server sends that tag and the MCP host's clientInfo.name to
// sync-annotations (?action=record_entry_source), which keeps the first value
// of each on the account. Analytics only: it never changes sign-in or sync,
// never throws, never logs the license key, and honors PINCUSHION_NO_TELEMETRY
// and DO_NOT_TRACK.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// Same shape as setup's `--ref`: a short hyphenated slug starting with a
// letter, at most 21 characters (shorter than any secret this repo issues),
// never naming a token or secret.
const REF = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const SECRET_WORD = /token|secret|credential|password|bearer/;

export function normalizeInstallRef(value) {
  const ref = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return ref.length <= 21 && REF.test(ref) && !SECRET_WORD.test(ref) ? ref : null;
}

export function entrySourceOptedOut(env = process.env) {
  return env.PINCUSHION_NO_TELEMETRY === '1' || env.DO_NOT_TRACK === '1';
}

export function installRefPath(env = process.env) {
  return env.PINCUSHION_INSTALL_REF_FILE || join(homedir(), '.pincushion', 'install-ref');
}

export function readStoredInstallRef({ file = installRefPath() } = {}) {
  try {
    return normalizeInstallRef(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// First tag wins: an existing file is never overwritten.
export function rememberInstallRef(ref, { file = installRefPath(), env = process.env } = {}) {
  const tag = normalizeInstallRef(ref);
  if (!tag || entrySourceOptedOut(env)) return false;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, tag + '\n', { mode: 0o600, flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

// `--ref SLUG` / `--ref=SLUG` on the server's own argv.
export function refFromArgv(argv = []) {
  const args = Array.isArray(argv) ? argv : [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = String(args[index] || '');
    if (arg === '--ref') return normalizeInstallRef(String(args[index + 1] || ''));
    if (arg.startsWith('--ref=')) return normalizeInstallRef(arg.slice('--ref='.length));
  }
  return null;
}

// This launch's tag (flag, then env) is remembered if none is stored yet; the
// stored first tag is what gets reported.
export function resolveInstallRef({ argv = [], env = process.env, file = installRefPath(env) } = {}) {
  if (entrySourceOptedOut(env)) return null;
  const launched = refFromArgv(argv) || normalizeInstallRef(env.PINCUSHION_REF);
  if (launched) rememberInstallRef(launched, { file, env });
  return readStoredInstallRef({ file }) || launched;
}

function entrySourceUrl(syncServerUrl) {
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
  url.searchParams.set('action', 'record_entry_source');
  return url;
}

// Reports at most once per process once the server acknowledges it.
export function createEntrySourceReporter({ fetchImpl = fetch, env = process.env, log = () => {} } = {}) {
  let done = false;
  return {
    async report({ syncServerUrl, licenseKey, clientName, clientVersion, installRef, pkgVersion } = {}) {
      try {
        if (done) return { ok: true, already: true };
        if (entrySourceOptedOut(env)) return { ok: false, reason: 'opted_out' };
        if (!syncServerUrl || !licenseKey) return { ok: false, reason: 'signed_out' };
        const name = String(clientName || '').slice(0, 80);
        const ref = normalizeInstallRef(installRef);
        if (!name && !ref) return { ok: false, reason: 'nothing_to_report' };
        const url = entrySourceUrl(syncServerUrl);
        if (!url) return { ok: false, reason: 'sync_url_invalid' };
        const version = String(pkgVersion || '0.0.0').replace(/[^\d.]/g, '').slice(0, 40) || '0.0.0';
        const response = await fetchImpl(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-License-Key': licenseKey,
            'X-Pincushion-Client': `mcp/${version}`,
          },
          body: JSON.stringify({
            clientName: name,
            clientVersion: String(clientVersion || '').slice(0, 40),
            ...(ref ? { installRef: ref } : {}),
          }),
          redirect: 'error',
          signal: AbortSignal.timeout(8000),
        });
        const body = response && response.ok ? await response.json() : null;
        if (body && body.ok === true) {
          done = true;
          return { ok: true, recorded: body.recorded || null };
        }
        return { ok: false, reason: 'not_recorded' };
      } catch {
        log('entry source report failed');
        return { ok: false, reason: 'unavailable' };
      }
    },
  };
}
