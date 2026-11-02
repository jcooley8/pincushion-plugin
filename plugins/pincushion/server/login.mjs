// `pincushion login` — one browser login per machine, no manual key entry.
//
// Flow (no new secret in this package; reuses the web Google OAuth + init-session):
//   1. start a loopback HTTP server on an ephemeral 127.0.0.1 port
//   2. open the browser to  <PINCUSHION_LOGIN_URL>?port=<p>&state=<s>
//   3. that page does Google sign-in -> init-session -> gets a license key,
//      then redirects to  http://127.0.0.1:<p>/callback?key=..&state=..&email=..&plan=..
//   4. we verify `state`, write ~/.pincushion/license-key (0600), and exit
//
// The user-level key is read by resolveCloudSyncKey() in server.js, so after
// one login every project and worktree syncs with zero per-project config.
//
// PREREQUISITE (Google Cloud Console, one-time — DONE 2026-06-25): the cli-login
// page uses a WEB-type Google OAuth client (331177407450-e7rdriqi…, the client
// named "Brave" in Credentials — distinct from the old extension-type client).
// That client MUST list this page's LIVE origin under "Authorized JavaScript
// origins". Because pincushion.io 307-redirects to www, the live origin GIS
// validates is https://www.pincushion.io — so BOTH https://www.pincushion.io and
// https://pincushion.io are registered. Missing the www origin yields
// "invalid_client / no registered origin" at sign-in (the JS-origin allowlist is
// separate from the extension's redirect-URI allowlist, which is why the
// Chrome/Brave extension could sign in while this CLI page failed).
//
// Env hooks: PINCUSHION_LOGIN_URL (override the page), PINCUSHION_LICENSE_FILE
// (override where the key is written — used by tests), PINCUSHION_NO_BROWSER=1
// (skip auto-opening the browser — headless/CI/testing).

import http from 'http';
import { spawn } from 'child_process';
import { writeFileSync, mkdirSync, chmodSync } from 'fs';
import { homedir, platform } from 'os';
import { join, dirname } from 'path';
import { randomBytes } from 'crypto';

// Open the canonical www host directly — pincushion.io 307-redirects to www, and
// the post-redirect origin (https://www.pincushion.io) is what GIS checks against
// the OAuth client's "Authorized JavaScript origins". Opening www up front avoids
// the redirect hop and pins the origin we register.
const DEFAULT_LOGIN_URL = 'https://www.pincushion.io/cli-login';
const DEFAULT_SYNC_URL = 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1/sync-annotations';
const TIMEOUT_MS = 5 * 60 * 1000;
const DEVELOPER_SETUP_SOURCES = new Set(['setup', 'claim']);
const LOOPBACK_SECURITY_HEADERS = Object.freeze({
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
});

function keyFilePath() {
  return process.env.PINCUSHION_LICENSE_FILE || join(homedir(), '.pincushion', 'license-key');
}

function functionsBase() {
  return (process.env.PINCUSHION_SYNC_URL || DEFAULT_SYNC_URL).replace(/\/sync-annotations$/, '');
}

export function normalizeDeveloperSetupSource(value) {
  const source = String(value || '').trim().toLowerCase();
  return DEVELOPER_SETUP_SOURCES.has(source) ? source : null;
}

// Analytics-only: which surface started this login, recorded as the new
// account's signup entry path. An editor plugin sets PINCUSHION_ENTRY=plugin
// (Claude Code also exposes CLAUDE_PLUGIN_ROOT to plugin processes); anything
// else is a plain CLI login. It never changes how sign-in works.
export function loginEntryPath(env = process.env) {
  const explicit = String(env.PINCUSHION_ENTRY || '').trim().toLowerCase();
  if (explicit === 'plugin' || explicit === 'cli') return explicit;
  return env.CLAUDE_PLUGIN_ROOT ? 'plugin' : 'cli';
}

export function buildLoginUrl({
  base = process.env.PINCUSHION_LOGIN_URL || DEFAULT_LOGIN_URL,
  port,
  state,
  developerSetupIntent = false,
  developerSetupSource,
  entry = loginEntryPath(),
} = {}) {
  const url = new URL(base);
  url.searchParams.set('port', String(port));
  url.searchParams.set('state', String(state));
  if (entry === 'plugin') url.searchParams.set('entry', 'plugin');
  // Ask the sign-in page to deliver the key in a POST body. A GET callback
  // puts the account key in the browser's history. GET stays accepted below
  // for sign-in pages deployed before this transport existed.
  url.searchParams.set('transport', 'post');
  const source = developerSetupIntent === true
    ? normalizeDeveloperSetupSource(developerSetupSource)
    : null;
  if (source) {
    url.searchParams.set('developerSetupIntent', 'true');
    url.searchParams.set('developerSetupSource', source);
  }
  return url.toString();
}

// Record only an explicit developer's setup or report-claim intent. This is
// deliberately separate from ordinary `pincushion login`: the presence of a
// CLI credential alone must never be treated as evidence of setup intent or a
// completed agent connection. Callers treat this as best effort because it
// creates no project, member, configuration, or pin.
export async function recordDeveloperSetupIntent({
  licenseKey,
  developerSetupIntent = true,
  developerSetupSource,
  functionsBase: baseOverride,
  fetchImpl = fetch,
} = {}) {
  const key = typeof licenseKey === 'string' ? licenseKey.trim() : '';
  const source = developerSetupIntent === true
    ? normalizeDeveloperSetupSource(developerSetupSource)
    : null;
  if (!key || !source || typeof fetchImpl !== 'function') {
    return { recorded: false, reason: 'not_requested' };
  }
  const base = typeof baseOverride === 'string' && baseOverride.trim()
    ? baseOverride.trim().replace(/\/$/, '')
    : functionsBase();
  try {
    const response = await fetchImpl(`${base}/onboarding-status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-license-key': key },
      body: JSON.stringify({ developerSetupIntent: true, developerSetupSource: source }),
    });
    if (!response?.ok) return { recorded: false, reason: 'not_acknowledged' };
    const data = await response.json().catch(() => ({}));
    return data?.success === true
      ? { recorded: true, source }
      : { recorded: false, reason: 'not_acknowledged' };
  } catch {
    return { recorded: false, reason: 'unavailable' };
  }
}

// Open a URL in the OS default browser. Exported so the server can reuse the
// exact same TTY-gated open for the post-sign-in extension-install hand-off.
// Respects PINCUSHION_NO_BROWSER and never throws (the caller always prints the
// URL too, so a failed spawn just means the user copies it).
export function openUrl(url) {
  if (process.env.PINCUSHION_NO_BROWSER === '1') return;
  const plat = platform();
  const [cmd, args] =
    plat === 'darwin' ? ['open', [url]] :
    plat === 'win32'  ? ['cmd', ['/c', 'start', '', url]] :
                        ['xdg-open', [url]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true }).unref(); } catch { /* user can copy the URL */ }
}

// Back-compat alias for the in-module call sites below.
const openBrowser = openUrl;

function loopbackHeaders(contentType) {
  return { ...LOOPBACK_SECURITY_HEADERS, ...(contentType ? { 'Content-Type': contentType } : {}) };
}

function page(title, message, { scrubCallbackQuery = false } = {}) {
  const historyScrubber = scrubCallbackQuery
    ? `<script>if (window.history && typeof window.history.replaceState === 'function') { window.history.replaceState(null, document.title, window.location.pathname); }</script>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} — Pincushion</title>
<style>body{font-family:-apple-system,sans-serif;background:#fafafa;color:#171717;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}main{text-align:center;padding:40px;max-width:420px}h1{font-size:22px;margin:0 0 8px}p{color:#525252;margin:0}</style>
</head><body><main><h1>${title}</h1><p>${message}</p></main>${historyScrubber}</body></html>`;
}

// Resolves to a process exit code (0 ok, 1 failure). An explicit setup/claim
// The sign-in page submits a small urlencoded form; anything larger is not ours.
const MAX_CALLBACK_BODY_BYTES = 8 * 1024;
function readCallbackBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size <= MAX_CALLBACK_BODY_BYTES) chunks.push(chunk);
    });
    req.on('end', () => {
      if (size > MAX_CALLBACK_BODY_BYTES) reject(new Error('callback_body_too_large'));
      else resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

// Analytics identity stitching after a successful sign-in: identify by the
// returned email and alias this machine's install ID + hashed license id to it
// (lib/posthog.js), then record `mcp_login_completed` on that person with the
// install ID, so the install-to-account link is a queryable event as well as an
// alias. A sign-in that does not complete records `connect_failed` with a
// closed-enum reason. Loaded lazily and fully non-fatal — login never depends on it.
async function defaultLoginTelemetry() {
  const m = await import('./lib/posthog.js');
  return {
    identify: m.identifySignedInUser,
    loginCompleted: m.captureLoginCompleted,
    connectFailed: m.captureConnectFailed,
    flush: m.flushPostHog,
  };
}

async function recordSignedInIdentity({ email, licenseKey, source, plan }, telemetry) {
  try {
    const t = telemetry || await defaultLoginTelemetry();
    const identified = t.identify({ email, licenseKey });
    const completed = typeof t.loginCompleted === 'function' && t.loginCompleted({ email, source, plan });
    if (identified || completed) await t.flush();
  } catch {
    // Telemetry must never fail a login.
  }
}

async function recordLoginFailure(reason, source, telemetry) {
  try {
    const t = telemetry || await defaultLoginTelemetry();
    if (typeof t.connectFailed === 'function' && t.connectFailed({ reason, stage: source === 'login' ? 'login' : source })) {
      await t.flush();
    }
  } catch {
    // Telemetry must never fail a login.
  }
}

// caller may attach paired intent fields for the browser's init-session step;
// direct `pincushion login` calls remain unmarked.
export async function runLogin({ developerSetupIntent = false, developerSetupSource, telemetry } = {}) {
  const state = randomBytes(16).toString('hex');
  const base = process.env.PINCUSHION_LOGIN_URL || DEFAULT_LOGIN_URL;
  const keyFile = keyFilePath();
  const telemetrySource = (developerSetupIntent === true && normalizeDeveloperSetupSource(developerSetupSource)) || 'login';
  let stateMismatchReported = false;

  return await new Promise((resolve) => {
    let settled = false;
    let failure = null;
    const finish = async (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { server.close(); } catch { /* noop */ }
      if (code !== 0 && failure) await recordLoginFailure(failure, telemetrySource, telemetry);
      resolve(code);
    };
    const fail = (reason) => { failure = reason; finish(1); };

    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (url.pathname !== '/callback') { res.writeHead(404, loopbackHeaders('text/plain; charset=utf-8')); res.end('not found'); return; }
      if (req.method !== 'GET' && req.method !== 'POST') { res.writeHead(405, loopbackHeaders('text/plain; charset=utf-8')); res.end('method not allowed'); return; }

      let params = url.searchParams;
      if (req.method === 'POST') {
        try { params = new URLSearchParams(await readCallbackBody(req)); }
        catch {
          res.writeHead(413, loopbackHeaders('text/plain; charset=utf-8'));
          res.end('callback body too large');
          return;
        }
      }
      const key = (params.get('key') || '').trim();
      const gotState = params.get('state') || '';
      const email = params.get('email') || '';
      const plan = params.get('plan') || 'free';

      // state must match the value we generated — blocks a hostile page from
      // POSTing a key to the loopback.
      if (gotState !== state) {
        res.writeHead(400, loopbackHeaders('text/html; charset=utf-8'));
        res.end(page('Login failed', 'Security check failed (state mismatch). Please run pincushion login again.'));
        console.error('login: state mismatch — ignoring callback');
        if (!stateMismatchReported) {
          stateMismatchReported = true;
          void recordLoginFailure('login_state_mismatch', telemetrySource, telemetry);
        }
        return; // keep listening; don't accept a forged callback
      }
      if (!key) {
        res.writeHead(400, loopbackHeaders('text/html; charset=utf-8'));
        res.end(page('Login failed', 'No license key was returned. Please try again.'));
        fail('login_no_key');
        return;
      }

      try {
        mkdirSync(dirname(keyFile), { recursive: true });
        writeFileSync(keyFile, key + '\n', { mode: 0o600 });
        chmodSync(keyFile, 0o600);
      } catch (e) {
        res.writeHead(500, loopbackHeaders('text/html; charset=utf-8'));
        res.end(page('Login failed', 'Could not write the key file: ' + e.message));
        console.error('login: failed to write', keyFile, '-', e.message);
        fail('login_key_write_failed');
        return;
      }

      res.writeHead(200, loopbackHeaders('text/html; charset=utf-8'));
      res.end(page("You're logged in", `Signed in${email ? ' as ' + email : ''} (${plan}). You can close this tab and return to your editor.`, { scrubCallbackQuery: true }));
      console.log(`\n✓ Logged in${email ? ' as ' + email : ''} (${plan}). Wrote ${keyFile}`);
      console.log('  Every Pincushion project and worktree on this machine will now sync.');
      await recordSignedInIdentity({ email, licenseKey: key, source: telemetrySource, plan }, telemetry);
      finish(0);
    });

    server.on('error', (e) => { console.error('login: loopback server error -', e.message); fail('login_loopback_error'); });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      const loginUrl = buildLoginUrl({ base, port, state, developerSetupIntent, developerSetupSource });
      console.log('Opening your browser to sign in with Google...');
      console.log('If it does not open, paste this into your browser:\n  ' + loginUrl + '\n');
      openBrowser(loginUrl);
    });

    const timer = setTimeout(() => {
      console.error('login: timed out after 5 minutes with no response.');
      fail('login_timeout');
    }, TIMEOUT_MS);
  });
}
