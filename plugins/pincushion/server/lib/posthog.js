// lib/posthog.js — PostHog product analytics for the Pincushion MCP server.
//
// Privacy posture (this server runs on developers' own machines):
//   - PRODUCT EVENTS ONLY (pin lifecycle, project configured, …). Never code, pin bodies,
//     URLs or file contents, and no email.
//     Application errors go to Sentry, not here.
//   - distinctId is a SHA-256 hash of the license key — the raw license key (an auth
//     secret) is NEVER sent. Unauthenticated sessions report as a random per-machine
//     install ID (~/.pincushion/install-id, `inst_<uuid>`) instead of one shared
//     'anonymous' bucket, so real installs can be counted apart from each other.
//   - Identity stitching: an explicit `pincushion login` aliases the install ID into the
//     hashed license id. The account's own PostHog id is a server-side hash of the email;
//     sync-annotations aliases the hashed license id to it. No email, raw or hashed, is
//     ever sent from this client. Authenticated boots carry the install ID as an
//     `installId` property. That alias makes the lic_ person identified, so the server
//     joins it with `$merge_dangerously` (PostHog refuses `$create_alias` into an
//     identified person); never switch that server call back to `$create_alias`.
//   - Opt out entirely with PINCUSHION_NO_TELEMETRY=1 or the standard DO_NOT_TRACK=1.
//     Test runs are opted out automatically (see testHarnessDetected) so test
//     suites and local harnesses never send events to the production project.
//   - The project API key below is a PUBLIC, write-only PostHog key — safe to ship in a
//     distributed client, exactly like a posthog-js snippet or the Sentry DSN already
//     embedded in server.js. The env var overrides it (forks / self-hosting).
import { createHash, randomUUID } from 'crypto';
import { chmodSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';

const _key = process.env.POSTHOG_API_KEY || 'phc_pswPopgwAmPXx2h6TXVPvojRS2n7o8nkaZ3m7Y37GKTW';
const _host = process.env.POSTHOG_HOST || 'https://us.i.posthog.com';

export function telemetryDisabled() {
  return (
    process.env.PINCUSHION_NO_TELEMETRY === '1' ||
    process.env.DO_NOT_TRACK === '1' ||
    !_key ||
    testHarnessDetected()
  );
}

// ── Test-run guard ──────────────────────────────────────────────────────────
// Test suites boot this server too, and their events landed in the production
// PostHog project (e.g. critique-generation-topology-test). A run is a test
// when a test runner is in the environment, or when its sync URL points at a
// loopback mock — how every harness boots the server, often with a scrubbed
// env that hides the runner. Telemetry stays on only when POSTHOG_HOST is
// itself a loopback capture server, which is how telemetry tests observe events.
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);

function isLoopbackUrl(value) {
  if (!value) return false;
  try {
    const host = new URL(String(value)).hostname.toLowerCase();
    return LOOPBACK_HOSTS.has(host) || host.endsWith('.localhost') || /^127\./.test(host);
  } catch {
    return false;
  }
}

function argValue(argv, flag) {
  for (let i = 0; i < argv.length; i += 1) {
    const arg = String(argv[i]);
    if (arg === flag) return argv[i + 1];
    if (arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1);
  }
  return undefined;
}

export function testHarnessDetected(env = process.env, argv = process.argv) {
  if (isLoopbackUrl(env.POSTHOG_HOST)) return false;
  if (env.NODE_TEST_CONTEXT || env.JEST_WORKER_ID || env.VITEST || env.NODE_ENV === 'test') return true;
  if (envFlag(env.PINCUSHION_TEST_HARNESS)) return true;
  return isLoopbackUrl(argValue(argv, '--sync-url') || env.PINCUSHION_SYNC_URL);
}

let _client = null;
let _PostHog = null;       // posthog-node ctor, loaded lazily via dynamic import
let _phLoadStarted = false;
let _phUnavailable = false;
let _phLoadPromise = null;

// Events captured BEFORE the lazy import resolves are buffered here, then drained
// once the client is ready. Without this, the very first event in a process — always
// the `mcp boot` startup event — fires while `_PostHog` is still null and is silently
// dropped. (Symptom seen in prod: 0 `mcp boot` events ever, while later tool-handler
// events landed fine.) Bounded so a never-resolving import can't grow it unbounded.
const _pending = [];
const _PENDING_MAX = 100;

// CRITICAL: posthog-node is loaded LAZILY and NON-FATALLY. A static top-level
// `import` would throw ERR_MODULE_NOT_FOUND at startup if the dependency were ever
// missing/broken, killing the MCP handshake → "Could not attach to MCP server".
// Here a failed load just disables telemetry forever; the transport is untouched.
function ensurePostHogLoading() {
  if (_phLoadStarted) return _phLoadPromise;
  _phLoadStarted = true;
  _phLoadPromise = import('posthog-node')
    .then((m) => { _PostHog = m.PostHog; _drainPending(); })
    .catch((err) => {
      _phUnavailable = true;
      _pending.length = 0; // module truly unavailable — drop the buffer, never grow it
      console.error(`[posthog] analytics disabled — module unavailable: ${err?.message || err}`);
    });
  return _phLoadPromise;
}

// Flush events captured before the client loaded, in FIFO order, once it's ready.
function _drainPending() {
  if (!_pending.length) return;
  const queued = _pending.splice(0, _pending.length);
  for (const e of queued) {
    try { _emit(e); } catch { /* telemetry must never throw */ }
  }
}

function _emit(entry) {
  const ph = client();
  if (!ph) return;
  if (entry.kind === 'alias') {
    ph.alias({ distinctId: entry.distinctId, alias: entry.alias });
    return;
  }
  if (entry.kind === 'identify') {
    ph.identify({ distinctId: entry.distinctId, properties: entry.properties });
    return;
  }
  if (entry.kind === 'capture_person') {
    // Already a person id (the signed-in email): never hashed or replaced.
    ph.capture({ distinctId: entry.distinctId, event: entry.event, properties: entry.properties });
    return;
  }
  const { distinctId, event, properties } = entry;
  ph.capture({ distinctId: resolveEventDistinctId(distinctId), event, properties });
}

// Queue (pre-load) or emit (post-load) one telemetry call. Shared by capture,
// alias and identify so all three survive the lazy-import startup race.
function _enqueue(entry) {
  if (telemetryDisabled()) return;
  ensurePostHogLoading();
  if (!_PostHog) {
    if (!_phUnavailable) {
      _pending.push(entry);
      if (_pending.length > _PENDING_MAX) _pending.shift(); // bound the buffer (drop oldest)
    }
    return;
  }
  _emit(entry);
}

function client() {
  if (telemetryDisabled()) return null;
  ensurePostHogLoading();
  if (!_PostHog) return null; // not loaded yet (or unavailable) — skip this event
  if (!_client) {
    _client = new _PostHog(_key, {
      host: _host,
      // Errors go to Sentry; PostHog is product events only. No unhandled-exception autocapture.
      enableExceptionAutocapture: false,
    });
  }
  return _client;
}

// Hash the license key so the raw auth secret never leaves the machine, while still giving a
// stable per-account id for funnels/cohorts. 'anonymous' (unauthenticated) passes through.
export function anonymizeDistinctId(distinctId) {
  if (!distinctId || distinctId === 'anonymous') return 'anonymous';
  return 'lic_' + createHash('sha256').update(String(distinctId)).digest('hex').slice(0, 32);
}

// Unauthenticated events use the persisted install ID; authenticated ones the
// hashed license id. Falls back to 'anonymous' only if no install ID is available.
function resolveEventDistinctId(distinctId) {
  const id = anonymizeDistinctId(distinctId);
  return id === 'anonymous' ? (getInstallId() || 'anonymous') : id;
}

export function captureEvent(distinctId, event, properties = {}) {
  try {
    // Client not ready yet (lazy import still in flight) — _enqueue buffers instead
    // of dropping. This is the path the `mcp boot` startup event always takes;
    // _drainPending() flushes it the moment the import resolves.
    _enqueue({ kind: 'capture', distinctId, event, properties });
  } catch {
    // Telemetry must never break a tool call.
  }
}

// ── Install ID ──────────────────────────────────────────────────────────────
// A random, per-machine id (never derived from hardware, user, or paths) that
// stands in for the person until they authenticate. Persisted with mode 0600
// next to the license key file. Never written when telemetry is disabled.
const INSTALL_ID_RE = /^inst_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
let _installIdCache = null; // { file, id } — resolved once per process per path

// PINCUSHION_INSTALL_ID_FILE overrides the location (tests), mirroring
// login.mjs's PINCUSHION_LICENSE_FILE.
export function installIdPath() {
  return process.env.PINCUSHION_INSTALL_ID_FILE || join(homedir(), '.pincushion', 'install-id');
}

export function isInstallId(value) {
  return INSTALL_ID_RE.test(String(value || ''));
}

function readInstallIdFile(file) {
  try {
    const id = readFileSync(file, 'utf8').trim();
    return isInstallId(id) ? id : null;
  } catch {
    return null;
  }
}

// On filesystems without hard links another process publishes with a plain
// exclusive create, so its file may briefly be empty. Re-read a few times
// before treating it as corrupt and replacing it.
function readInstallIdFileSettled(file) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const id = readInstallIdFile(file);
    if (id) return id;
    if (attempt < 4) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
  }
  return null;
}

// Returns the persisted install ID, creating it on first use. If the file can't
// be written the generated id still serves this process, so a read-only home
// directory degrades to per-process ids rather than the shared 'anonymous'.
export function getInstallId({ file = installIdPath() } = {}) {
  if (telemetryDisabled()) return null;
  if (_installIdCache?.file === file) return _installIdCache.id;
  let id = readInstallIdFile(file);
  if (!id) {
    const generated = `inst_${randomUUID()}`;
    try {
      mkdirSync(dirname(file), { recursive: true });
      try {
        // Write a complete temp file, then hard-link it into place: the link is
        // an atomic exclusive create, so two servers booting at once converge on
        // one id and neither can read a half-written file.
        const staged = `${file}.${process.pid}.${randomUUID()}.new`;
        try {
          writeFileSync(staged, generated + '\n', { mode: 0o600 });
          try {
            linkSync(staged, file);
          } catch (linkErr) {
            if (linkErr?.code === 'EEXIST') throw linkErr;
            // No hard links on this filesystem: plain exclusive create.
            writeFileSync(file, generated + '\n', { mode: 0o600, flag: 'wx' });
          }
        } finally {
          try { rmSync(staged, { force: true }); } catch { /* best-effort */ }
        }
        id = generated;
      } catch (err) {
        if (err?.code !== 'EEXIST') throw err;
        id = readInstallIdFileSettled(file);
        if (!id) {
          // Corrupt/foreign content — replace atomically.
          const tmp = `${file}.${process.pid}.tmp`;
          try {
            writeFileSync(tmp, generated + '\n', { mode: 0o600 });
            renameSync(tmp, file);
          } finally {
            try { rmSync(tmp, { force: true }); } catch { /* best-effort */ }
          }
          id = generated;
        }
      }
      try { chmodSync(file, 0o600); } catch { /* mode is best-effort on exotic filesystems */ }
    } catch {
      id = generated;
    }
  }
  _installIdCache = { file, id };
  return id;
}

// ── CI / client classification (measurement only) ───────────────────────────
// npm mirrors and CI pipelines boot the server too. Flag them so dashboards can
// filter them out; nothing about behavior changes.
const CI_PROVIDERS = [
  ['GITHUB_ACTIONS', 'github-actions'],
  ['GITLAB_CI', 'gitlab'],
  ['CIRCLECI', 'circleci'],
  ['BUILDKITE', 'buildkite'],
  ['TRAVIS', 'travis'],
  ['JENKINS_URL', 'jenkins'],
  ['TF_BUILD', 'azure-pipelines'],
  ['BITBUCKET_BUILD_NUMBER', 'bitbucket'],
  ['TEAMCITY_VERSION', 'teamcity'],
  ['CODEBUILD_BUILD_ID', 'aws-codebuild'],
  ['DRONE', 'drone'],
  ['SEMAPHORE', 'semaphore'],
  ['APPVEYOR', 'appveyor'],
  ['NETLIFY', 'netlify'],
  ['VERCEL', 'vercel'],
];

function envFlag(value) {
  if (value === undefined || value === null) return false;
  const v = String(value).trim().toLowerCase();
  return v !== '' && v !== '0' && v !== 'false';
}

export function detectCi(env = process.env) {
  for (const [name, provider] of CI_PROVIDERS) {
    if (envFlag(env[name])) return { ci: true, ciProvider: provider };
  }
  if (envFlag(env.CI) || envFlag(env.CONTINUOUS_INTEGRATION)) {
    return { ci: true, ciProvider: 'generic' };
  }
  return { ci: false, ciProvider: null };
}

// The MCP host's self-reported clientInfo.name (e.g. "claude-code", "cursor-vscode"),
// reduced to a short safe token. 'unknown' before the handshake has completed.
export function normalizeClientName(name) {
  const cleaned = String(name || '').trim().toLowerCase().replace(/[^a-z0-9._ -]/g, '').slice(0, 40).trim();
  return cleaned || 'unknown';
}

// ── Identity stitching ──────────────────────────────────────────────────────
// Explicit sign-in (`pincushion login`): the callback's email only proves the
// user signed in. It is NEVER sent to PostHog, as an id or a property. The
// person's PostHog id is a server-side hash of the email (the edge functions'
// `usr_<hmac>`), which this client cannot and need not compute: sync-annotations
// aliases the hashed license id (`lic_…`) to it on the first cloud project. So
// here the install ID joins the hashed license id, which keeps `mcp boot` and
// tool events on one person that the server then merges into the account.
export function identifySignedInUser({ email, licenseKey } = {}) {
  try {
    if (telemetryDisabled()) return false;
    const normalized = String(email || '').trim();
    if (!normalized || !normalized.includes('@')) return false;
    const installId = getInstallId();
    if (!licenseKey || !installId) return true;
    _enqueue({ kind: 'alias', distinctId: anonymizeDistinctId(licenseKey), alias: installId });
    return true;
  } catch {
    return false;
  }
}

// One event on the signed-in email person, carrying this machine's install ID,
// so "which install became which account" is a queryable event and not only an
// alias merge. Called by `pincushion login` right after identifySignedInUser.
// `source` is how the sign-in started (login, setup or claim).
export function captureLoginCompleted({ email, source = 'login', plan = null } = {}) {
  try {
    if (telemetryDisabled()) return false;
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) return false;
    const installId = getInstallId();
    _enqueue({
      kind: 'capture_person',
      distinctId: normalized,
      event: 'mcp_login_completed',
      properties: {
        install_id: installId,
        source: ['login', 'setup', 'claim'].includes(source) ? source : 'login',
        plan: typeof plan === 'string' ? plan.slice(0, 20) : null,
        ...detectCi(),
      },
    });
    return true;
  } catch {
    return false;
  }
}

// Why a person trying to connect an agent did not get connected. `reason` is
// a closed enum (CONNECT_FAILED_REASONS); anything else is dropped so free text
// (paths, URLs, server messages) can never reach analytics. Sent as the
// install ID person, or the hashed license id when one is supplied.
export const CONNECT_FAILED_REASONS = Object.freeze([
  'login_state_mismatch',
  'login_no_key',
  'login_key_write_failed',
  'login_timeout',
  'login_loopback_error',
  'signin_incomplete',
  'project_registration_failed',
  'project_identity_unresolved',
  'runtime_install_failed',
  'editor_config_failed',
  'license_rejected',
  'cloud_unreachable',
]);
const CONNECT_FAILED_STAGES = new Set(['login', 'setup', 'claim', 'mcp']);

export function captureConnectFailed({ reason, stage, detail = null, licenseKey = null } = {}) {
  try {
    if (!CONNECT_FAILED_REASONS.includes(reason) || !CONNECT_FAILED_STAGES.has(stage)) return false;
    const properties = { reason, stage, install_id: getInstallId(), ...detectCi() };
    // `detail` is an internal machine code (e.g. runtime_dependencies_timeout).
    if (typeof detail === 'string' && /^[a-z0-9_]{1,60}$/.test(detail)) properties.detail = detail;
    _enqueue({ kind: 'capture', distinctId: licenseKey || 'anonymous', event: 'connect_failed', properties });
    return true;
  } catch {
    return false;
  }
}

export function captureException(err, distinctId) {
  try {
    const ph = client();
    if (!ph) return;
    ph.captureException(err, anonymizeDistinctId(distinctId) || undefined);
  } catch {
    // Never throw from telemetry.
  }
}

// Deliver queued events without shutting the client down — for short-lived
// commands (login, claim) that keep running or exit right after. Bounded so a
// slow network can never hold up the caller.
export async function flushPostHog(timeoutMs = 2000) {
  let timer;
  try {
    const work = (async () => {
      if (_phLoadPromise && !_PostHog && !_phUnavailable) await _phLoadPromise;
      if (_client) await _client.flush();
    })();
    await Promise.race([work, new Promise((r) => { timer = setTimeout(r, timeoutMs); })]);
  } catch {
    // Best-effort.
  } finally {
    clearTimeout(timer);
  }
}

const SHUTDOWN_TIMEOUT_MS = 3000;

export async function shutdownPostHog() {
  try {
    // One-shot commands may capture their only event before the lazy import
    // resolves. Finish loading/draining first so shutdown can flush it.
    if (_phLoadPromise && !_PostHog && !_phUnavailable) await _phLoadPromise;
    // Bounded: a one-shot command waits for this before exiting, and the SDK
    // default (30 s) would stall `login` on a slow or blocked network.
    if (_client) await _client.shutdown(SHUTDOWN_TIMEOUT_MS);
  } catch {
    // Best-effort flush on exit.
  }
}
