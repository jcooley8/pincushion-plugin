#!/usr/bin/env node
// server.js — Pincushion MCP Server
// Keyless setup reports first MCP contact so Connect can read connected without a key.
// 2026-10-26: attaching the local-only sample pin also marks the one-shot
// quickstart invitation as offered, so the next call is not "Run start_quickstart_demo".
//
// Exposes annotation data from .feedback/ to AI agents via Model Context Protocol.
// Supports local files and remote Supabase sync.
//
// Usage:
//   npx pincushion-mcp [--project-dir /path/to/project] [--sync-url https://...] [--api-key KEY] [--license-key KEY] [--rest --port 3456]
//
// Examples:
//   npx pincushion-mcp --project-dir .
//   npx pincushion-mcp --project-dir /path --sync-url https://sync.example.com --api-key abc123
//   npx pincushion-mcp --rest --port 3456
//
// Claude Desktop config (~/.config/Claude/claude_desktop_config.json):
//   {
//     "mcpServers": {
//       "pincushion": {
//         "command": "npx",
//         "args": ["pincushion-mcp", "--project-dir", "/path/to/project"]
//       }
//     }
//   }

import { fenceToolResult, fenceUntrustedText } from './lib/untrusted-content.js';
import './lib/node-runtime-guard.js';
// Capture this before any command/bootstrap await can let a hard-quit host
// reparent the process. The later watcher must compare against the original
// parent, not a potentially already-reparented process.ppid.
const INITIAL_PARENT_PID = process.ppid;

const { Server } = await import('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} = await import('@modelcontextprotocol/sdk/types.js');
import { readFile, writeFile, readdir, stat, unlink } from 'fs/promises';
import { existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync, copyFileSync, rmSync, writeFileSync, chmodSync, renameSync } from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { homedir } from 'os';
import http from 'http';
import { createHash, createHmac } from 'crypto';
const { createFileCaptureJournal, createPrivateCaptureReportRunner } = await import('./lib/model-free-capture-report.js');
const { captureEvent, captureException, captureConnectFailed, shutdownPostHog, detectCi, normalizeClientName, getInstallId } = await import('./lib/posthog.js');
const { createConnectFailureTracker } = await import('./lib/connect-failure-tracker.js');
const { captureFromUploadReceipt, normalizeGenerationManifest, generationReceipt, validateResponsiveCritiqueCaptures } = await import('./lib/critique-generation.js');
const { normalizeCaptureFingerprint } = await import('./lib/deployment-reconciliation.js');
const {
  createDeploymentFrameRuntime,
  deploymentFrameRuntimeStartDecision,
} = await import('./lib/deployment-frame-runtime.js');
const { startOrphanWatch } = await import('./lib/orphan.js');
const { createCloudBridgeGrantVerifier } = await import('./lib/cloud-bridge-grant.js');
const { readProjectWriteAuthorization } = await import('./lib/project-write-authorization.js');
const { requestPinVerification } = await import('./lib/verification-evidence.js');
const { requestAgencyCoordination } = await import('./lib/agency-coordination.js');
const { createBackgroundRefreshLease, createPinsRefreshCoordinator } = await import('./lib/pins-refresh.js');
const {
  configureLocalHttpServer,
  createLocalTransportSecurity,
  localTransportErrorResponse,
  projectBridgeStatusAnnotation,
  runBoundedLocalOperation,
} = await import('./lib/local-transport-security.js');
const {
  annotationCacheScope,
  ensureVersionedAnnotationCache,
  readScopedAnnotationPage,
  updateScopedAnnotationPage,
} = await import('./lib/annotation-cache.js');
const {
  annotationSyncRequestPlan,
  buildAnnotationSyncState,
  journalChangeScope,
  mergeJournalChange,
  parseAnnotationSyncState,
  validateAnnotationSyncPage,
} = await import('./lib/annotation-sync.js');
const { withAnnotationSyncLease, readAnnotationBootstrap, beginAnnotationBootstrap, bootstrapCacheIntact, applyAnnotationBootstrapPage, finishAnnotationBootstrap, writeAnnotationSyncJson } = await import('./lib/annotation-sync-store.js');
const { annotationBootstrapActive } = await import('./lib/annotation-cache.js');
const { safeErrorResponse, safeErrorText, safeProviderError } = await import('./lib/safe-error.js');
const { createToolRegistry, dispatchRegisteredTool } = await import('./lib/tool-registry.js');

// ─── `pincushion login` subcommand ──────────────────────────────────────────
// One-shot browser login that writes ~/.pincushion/license-key, then exits.
// Handled before any MCP/Sentry/cloud bootstrap so it never opens a stdio
// transport. Top-level await pauses module evaluation here; process.exit ends
// the process so none of the server bootstrap below runs in login mode.
// `--help` / `--version` print and exit instead of booting the MCP server (and
// its local bridge) in an interactive terminal. MCP hosts never pass these.
if (['--help', '-h', 'help'].includes(process.argv[2])) {
  const { buildCollaborationCta } = await import('./setup.mjs');
  console.log([
    'Usage: npx pincushion-mcp [command] [--project-dir <dir>]',
    '',
    'With no command, runs the MCP server over stdio (for editor/agent configs).',
    '',
    'Commands:',
    '  setup        Sign in, register this project, and connect your editor',
    '  login        Sign in and save your key to ~/.pincushion/license-key',
    '  capture      Capture desktop/mobile screenshots of a registered URL',
    '  claim        Claim a public crit report for your account',
    '  remote-url   Print the hosted MCP URL (add --embed-key for URL-only clients)',
    '  snapshot     Save signed-in browser state for protected-page capture',
    '  mobile-wall  Capture a booted iOS simulator app into a crit wall',
    '',
    // The CTA's setup-guide link replaces the plain Docs line (same page).
    buildCollaborationCta(),
  ].join('\n'));
  process.exit(0);
}
if (['--version', '-v', 'version'].includes(process.argv[2])) {
  try {
    console.log(JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version);
  } catch {
    console.log('unknown');
  }
  process.exit(0);
}

// One-shot commands exit right after they finish. posthog-node prepares each
// capture asynchronously and flush() does not wait for that, so drain the
// client (as `setup` does) before exiting or the sign-in events are dropped.
if (process.argv[2] === 'login') {
  const { runLogin } = await import('./login.mjs');
  const loginExitCode = await runLogin();
  await shutdownPostHog();
  process.exit(loginExitCode);
}

// ─── `pincushion claim` subcommand ──────────────────────────────────────────
// Assert ownership of a public crit-report and attach it to the developer's
// license. Never opens a stdio transport — exits cleanly when done.
if (process.argv[2] === 'claim') {
  const { runClaim } = await import('./claim.mjs');
  const claimExitCode = await runClaim(process.argv.slice(3));
  await shutdownPostHog();
  process.exit(claimExitCode);
}

// ─── `pincushion remote-url` / `pincushion mcp-url` subcommand ──────────────
// URL-only MCP clients (for example tools that ask for only "server URL" and
// cannot send custom headers) need the credential embedded in the URL. This
// prints the exact remote Streamable HTTP URL from the already-stored local
// login key, without requiring users to hunt for or manually paste the raw key.
if (process.argv[2] === 'remote-url' || process.argv[2] === 'mcp-url') {
  const baseUrl = (process.env.PINCUSHION_REMOTE_MCP_URL || 'https://www.pincushion.io/api/mcp').replace(/\?+$/, '');
  const keyFile = join(homedir(), '.pincushion', 'license-key');
  let key = process.env.PINCUSHION_LICENSE_KEY || '';
  if (!key) {
    try { key = readFileSync(keyFile, 'utf8').trim(); } catch { /* handled below */ }
  }
  if (!key) {
    console.error('No Pincushion login key found. Run `npx -y pincushion-mcp setup` first (it signs you in).');
    process.exit(1);
  }
  // By default print a key-free URL: the key belongs in a header, because a
  // URL query string is written to server request logs and client configs.
  // `--embed-key` keeps the old tokenized output for clients that accept
  // nothing but a URL.
  const url = new URL(baseUrl);
  if (process.argv.includes('--embed-key')) {
    url.searchParams.set('token', key);
    console.error('Warning: this URL contains your Pincushion key. Anyone who sees it (client config, logs, screenshots) can act as you. If it leaks, email support@pincushion.io to have it replaced.');
    console.log(url.toString());
    process.exit(0);
  }
  console.log(url.toString());
  console.error([
    '',
    'Send your key as a header, not in the URL:',
    `  Authorization: Bearer <contents of ${keyFile}>`,
    'If your MCP client accepts only a URL, run `npx pincushion-mcp remote-url --embed-key` instead.',
  ].join('\n'));
  process.exit(0);
}

// ─── `pincushion setup` subcommand ───────────────────────────────────────────
// Interactive first-run wizard. Never opens a stdio transport — exits when done.
if (process.argv[2] === 'capture') {
  const { runCapture } = await import('./capture.mjs');
  process.exit(await runCapture(process.argv.slice(3)));
}

if (process.argv[2] === 'setup') {
  const { runSetup } = await import('./setup.mjs');
  const setupExitCode = await runSetup(process.argv.slice(3));
  await shutdownPostHog();
  process.exit(setupExitCode);
}

// ─── `pincushion mobile-wall` subcommand ─────────────────────────────────────
// Capture a booted iOS-simulator app (screenshots + AX hierarchy via maestro
// or idb) and generate a static crit-wall page with semantic hotspot overlays.
// Never opens a stdio transport — exits when done.
if (process.argv[2] === 'mobile-wall') {
  const { runMobileWall } = await import('./mobile-wall.mjs');
  process.exit(await runMobileWall(process.argv.slice(3)));
}

// `snapshot --login <url> --proof-selector <selector>`: open a headed browser,
// let the user sign in, and save the storageState plus signed-in proof so
// headless captures (scripts/capture-snapshot.mjs) can render pages behind auth.
// CLI subcommand only — not an MCP tool surface.
if (process.argv[2] === 'snapshot') {
  const { runSnapshot } = await import('./snapshot.mjs');
  process.exit(await runSnapshot(process.argv.slice(3)));
}

// ─── Error Monitoring (Sentry) ──────────────────────────────────────────────
// DSN is public by design (shipped in JS bundles). Env var overrides for forks.
let Sentry = null;
let PKG_VERSION = '0.0.0';
try {
  PKG_VERSION = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version || PKG_VERSION;
} catch { /* keep fallback */ }
try {
  const sentryMod = await import('@sentry/node');
  const sentryDsn = process.env.SENTRY_DSN ||
    'https://5f5aa1bd3aef5b79dcb91ebbc290d6b3@o4511141316001792.ingest.us.sentry.io/4511141342937088';
  sentryMod.init({
    dsn: sentryDsn,
    environment: process.env.NODE_ENV || 'production',
    release: `pincushion-mcp@${PKG_VERSION}`,
    tracesSampleRate: 0.2,
  });
  Sentry = sentryMod;
  console.error('[sentry] Error monitoring enabled');
} catch {
  // @sentry/node not installed — monitoring disabled (non-fatal)
}

// Import core business logic
const core = await import('./lib/core.js');
const { createVercelDeploymentAdapter } = await import('./lib/deployment-provider.js');

// A caller-secret provider must be explicitly admitted by trusted server-host
// code. The MCP protocol, project configuration, and environment detection do
// not select or register one. A host that embeds this executable may install a
// single private factory before server module evaluation; that factory receives
// only the lifecycle closure below, never an MCP request or public tool result.
// No GitHub/Netlify adapter is globally registered here.
const CALLER_SECRET_ADAPTER_FACTORY = Symbol.for('pincushion.private.callerSecretDeploymentAdapterFactory');
function createAdmittedCallerSecretDeploymentProviderAdapter(context = {}) {
  const factory = globalThis[CALLER_SECRET_ADAPTER_FACTORY];
  if (typeof factory !== 'function') return null;
  try {
    const adapter = factory(context);
    return adapter && typeof adapter === 'object' ? adapter : null;
  } catch {
    return null;
  }
}
// First-run on-ramp: prints a one-time walkthrough to stderr when the active
// project has zero human pins yet (gated by a no-pins check + an env flag).
const { returnedPinIds, recordOnboardingReceipt, withOnboardingMeasurement } = await import('./lib/onboarding-receipts.js');
const { createConnectionReporter } = await import('./lib/connection-report.js');
const connectionReporter = createConnectionReporter({
  log: () => console.error('[mcp-contact] report failed'),
});
const { createEntrySourceReporter, resolveInstallRef } = await import('./lib/install-ref.js');
const entrySourceReporter = createEntrySourceReporter({
  log: () => console.error('[entry-source] report failed'),
});
const { maybePrintOnboarding, readLocalPins, countNonBotPins, countProjectFindings, buildBootEventProps, shouldAutoOpenSignin, buildServerInstructions, buildSecondHumanNudge } = await import('./lib/onboarding.js');
const { buildDemoPackets, buildDemoResolvedPayload, buildQuickstartInvitation, buildLocalOnlyBanner, buildLocalOnlySample, isEmptyPinRead, DEMO_FILE_REL, QUICKSTART_DIR_REL, DEMO_COPY_NAME } = await import('./lib/quickstart.js');
const { keySourceLabel, keyLast4, buildRejectedLicenseBanner, requireProDecision, requireQuotaDecision, usageMeterBanner } = await import('./lib/license.js');
const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
// Realtime and git helpers are loaded lazily to avoid hard dependency on @supabase/supabase-js
let _startRealtimeListener = null;
let _branchName = null;

async function loadRealtimeModule() {
  if (!_startRealtimeListener) {
    try {
      const mod = await import('./lib/realtime.js');
      _startRealtimeListener = mod.startRealtimeListener;
    } catch (err) {
      console.error('[realtime] Could not load realtime module:', err.message);
      console.error('[realtime] Install @supabase/supabase-js for Pro/Team Realtime features');
    }
  }
  return _startRealtimeListener;
}

async function loadGitModule() {
  if (!_branchName) {
    try {
      const mod = await import('./lib/git.js');
      _branchName = mod.branchName;
    } catch {
      _branchName = (title, url) => `pincushion/feedback`;
    }
  }
  return _branchName;
}

// ─── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);

function argValue(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 ? args[idx + 1] : null;
}

function hasFlag(flag) {
  return args.includes(flag);
}

function boundedInteger(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

// Plugin templates pass `--project-dir ${workspaceFolder}` (Cursor) or
// `${PINCUSHION_PROJECT_DIR}` (env-var template). When the host doesn't
// expand the variable, the literal `${...}` lands here — and `resolve()`
// happily creates a directory literally named `${PINCUSHION_PROJECT_DIR}`
// in the user's repo. Detect any unresolved `${...}` and fall back to cwd
// with a startup warning rather than corrupting the workspace.
function resolveProjectDir() {
  const raw = argValue('--project-dir') || process.env.PINCUSHION_PROJECT_DIR;
  if (raw && /\$\{[^}]+\}/.test(raw)) {
    console.error(`[startup] --project-dir contains an unresolved variable: ${raw}. Falling back to cwd.`);
    return resolve(process.cwd());
  }
  return resolve(raw || process.cwd());
}
const PROJECT_DIR = resolveProjectDir();
const SYNC_API_KEY = argValue('--api-key') || null;
const LICENSE_KEY = argValue('--license-key') || null;
const PROJECT_LICENSE_KEY_FILE = join(PROJECT_DIR, '.feedback', '.license-key');
const DEFAULT_PROJECT_ID = argValue('--project-id') || process.env.PINCUSHION_PROJECT_ID || null;
const REST_MODE = hasFlag('--rest');
const REST_PORT = boundedInteger(argValue('--port') || '3456', 3456, { min: 0, max: 65535 });
const CLOUD_SYNC = hasFlag('--cloud-sync') || !!process.env.PINCUSHION_LICENSE_KEY;
const AUTO_REGISTER_PROJECT_ON_STARTUP = !hasFlag('--no-auto-register-project');
// The ref tag of the registry listing or install link this server came from
// (`--ref SLUG` or PINCUSHION_REF; the first one seen is kept on disk).
const INSTALL_REF = resolveInstallRef({ argv: args });

// Default Supabase sync URL — can be overridden via env or --sync-url flag.
// Auto-enabled when PINCUSHION_LICENSE_KEY is present so --sync-url is never
// required in MCP configs; agents get live cloud data out of the box.
const CLOUD_SYNC_URL = process.env.PINCUSHION_SYNC_URL ||
  'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1/sync-annotations';
const SYNC_SERVER_URL = argValue('--sync-url') ||
  ((process.env.PINCUSHION_LICENSE_KEY || LICENSE_KEY ||
    existsSync(PROJECT_LICENSE_KEY_FILE) ||
    existsSync(join(homedir(), '.pincushion', 'license-key')))
    ? CLOUD_SYNC_URL : null);
// Strip the trailing /sync-annotations so SUPABASE_BASE points at /functions/v1
// for sibling endpoints like /manage-members.
const SUPABASE_BASE = CLOUD_SYNC_URL.replace(/\/sync-annotations$/, '');

// Auto-populated by auto-discover on startup. Tracks ALL project IDs whose
// registered URLs overlap with this workspace's URLs. This handles the common
// case where the same app is registered under different names by the extension
// vs. auto-discover (e.g. "Superbill Pro" from extension + "medibill" from
// package.json). Tool calls filter to this set so only relevant pins are shown.
let currentProjectIds = new Set();

// Resolve the project filter: explicit projectId > --project-id default > auto-discovered > no filter
// currentProjectIds is populated at startup by auto-discover via URL matching against projects.json.
// When exactly one project is found, it's used automatically — no manual config needed.
// Multiple matches fall through to null (safe: avoids wrong filter on overlapping URLs).
function resolveProjectFilter(explicitId) {
  if (explicitId) return explicitId;                                    // agent passed a specific ID
  if (DEFAULT_PROJECT_ID) return DEFAULT_PROJECT_ID;                    // scoped via --project-id / env var
  if (currentProjectIds.size === 1) return [...currentProjectIds][0];   // auto-discovered single project
  return null;                                                           // ambiguous or undiscovered — no filter
}

function matchesProjectFilter(projectId, filter) {
  if (!filter) return true;
  if (filter instanceof Set) return filter.has(projectId);
  return projectId === filter;
}

const FEEDBACK_DIR = join(PROJECT_DIR, '.feedback');
const ANNOTATIONS_DIR = join(FEEDBACK_DIR, 'annotations');
// The cursor is a bearer capability scoped to one account and project set.
// Keep it outside the checked-in annotation artifacts with owner-only mode;
// it is discarded automatically when the authenticated account changes.
const CLOUD_SYNC_STATE_PATH = join(FEEDBACK_DIR, '.sync-state.json');

function readCloudSyncState() {
  try {
    const parsed = JSON.parse(readFileSync(CLOUD_SYNC_STATE_PATH, 'utf8'));
    return parseAnnotationSyncState(parsed);
  } catch {
    return null;
  }
}

async function writeCloudSyncState(state) {
  const parsed = parseAnnotationSyncState(state);
  if (!parsed) throw new Error('annotation_sync_state_invalid');
  await writeAnnotationSyncJson(CLOUD_SYNC_STATE_PATH, parsed);
}

function addScopedStartupCacheEvidence(ids, page, projectDirectory, recordFile) {
  try {
    if (!record(page) || page.cacheVersion !== 2 ||
        !Array.isArray(page.annotations) ||
        page.scope?.projectId !== page.projectId ||
        page.scope?.pageUrl !== page.pageUrl ||
        typeof page.scope?.scopeHash !== 'string') return;
    const scope = annotationCacheScope({ projectId: page.projectId, pageUrl: page.pageUrl });
    if (scope.projectHash !== projectDirectory ||
        `${scope.scopeHash}.json` !== recordFile ||
        page.scope.scopeHash !== scope.scopeHash) return;
    if (!page.annotations.every((annotation) => (
      record(annotation) && annotation.projectId === scope.projectId && annotation.pageUrl === scope.pageUrl &&
      (!Object.prototype.hasOwnProperty.call(annotation, 'project_id') || annotation.project_id === scope.projectId)
    ))) return;
    ids.add(scope.projectId);
  } catch {
    // A v2 artifact is recovery evidence only when its exact stored scope still
    // verifies against both hash path components. Bad local bytes neither grant
    // access nor suppress other independently valid cache records.
  }
}

function readStartupCachedProjectEvidence() {
  const ids = new Set();
  try {
    const projects = JSON.parse(readFileSync(join(FEEDBACK_DIR, 'projects.json'), 'utf8'));
    for (const [key, project] of Object.entries(projects || {})) {
      const id = String(project?.projectId || key || '').trim();
      if (id) ids.add(id);
    }
  } catch { /* missing/malformed local registry remains non-authoritative */ }
  const pins = readLocalPins(FEEDBACK_DIR);
  for (const pin of [...pins.open, ...pins.resolved]) {
    const id = String(pin?.projectId || '').trim();
    if (id) ids.add(id);
  }
  try {
    for (const file of readdirSync(ANNOTATIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      const page = JSON.parse(readFileSync(join(ANNOTATIONS_DIR, file), 'utf8'));
      for (const annotation of Array.isArray(page?.annotations) ? page.annotations : []) {
        const id = String(annotation?.projectId || annotation?.project_id || '').trim();
        if (id) ids.add(id);
      }
    }
  } catch { /* missing/malformed local evidence is non-authoritative */ }
  // A completed v2 migration keeps the legacy root files byte-for-byte for
  // recovery. Scan active scoped records as well, otherwise a workspace whose
  // registry has been lost after migration can no longer offer its prior exact
  // project ID to the authenticated-cloud intersection below. This reads no
  // credentials and validates the record against its opaque hash path before
  // treating the ID as non-authoritative evidence.
  try {
    const v2Root = join(ANNOTATIONS_DIR, 'v2');
    const manifest = JSON.parse(readFileSync(join(v2Root, '.manifest.json'), 'utf8'));
    if (manifest?.cacheVersion === 2 && manifest?.state === 'active' &&
        manifest?.layout === 'project-sha256/scope-sha256.json') {
      for (const projectDirectory of readdirSync(v2Root, { withFileTypes: true })) {
        if (!/^[a-f0-9]{64}$/.test(projectDirectory.name) ||
            !projectDirectory.isDirectory() || projectDirectory.isSymbolicLink()) continue;
        const projectPath = join(v2Root, projectDirectory.name);
        for (const recordFile of readdirSync(projectPath, { withFileTypes: true })) {
          if (!/^[a-f0-9]{64}\.json$/.test(recordFile.name) ||
              !recordFile.isFile() || recordFile.isSymbolicLink()) continue;
          try {
            const page = JSON.parse(readFileSync(join(projectPath, recordFile.name), 'utf8'));
            addScopedStartupCacheEvidence(ids, page, projectDirectory.name, recordFile.name);
          } catch { /* preserve other valid records if one cache file is bad */ }
        }
      }
    }
  } catch { /* v2 cache may be absent, incomplete, or malformed; never repair it here */ }
  return ids;
}
// Capture recovery evidence before any background sync refresh can rewrite the
// project registry or generated pin artifacts. These IDs never authorize
// access; later discovery intersects them with the authenticated cloud registry.
const STARTUP_CACHED_PROJECT_EVIDENCE = readStartupCachedProjectEvidence();
// Only one process per workspace may perform periodic cloud reads and generated
// artifact refreshes. MCP tool calls intentionally bypass this lease so every
// connected client still receives an exact authoritative answer on demand.
// A five-minute stale threshold is deliberately longer than Supabase's observed
// Edge Function timeout. The active 30–60 second background timers renew the
// token while a request is pending, so a healthy leader never overlaps a slow
// request; a crashed leader is recovered without multiplying traffic.
const backgroundRefreshLease = createBackgroundRefreshLease({
  feedbackDir: FEEDBACK_DIR,
  ttlMs: 5 * 60_000,
});

// ─── Cloud Sync Loop ─────────────────────────────────────────────────────────
// Polls Pincushion Cloud (Supabase) for new/updated annotations and writes them
// to local .feedback/. Also pushes local status changes back to the cloud.
// Activated by --cloud-sync flag or PINCUSHION_LICENSE_KEY env var.

// User-level license key — one login per machine, shared by every project and
// worktree. `pincushion login` writes it here; this is the path that makes the
// MCP work with zero per-project config.
const USER_LICENSE_KEY_FILE = join(homedir(), '.pincushion', 'license-key');

function readKeyFile(path) {
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf8').trim() || null; } catch { return null; }
}

// In-memory override set when the server advertises a replacement key
// (silent key rotation, `newLicenseKey` in sync responses). Beats stale
// project/home files so subsequent requests use the fresh key without a
// restart, but env / CLI arg still win (most explicit).
let rotatedLicenseKey = null;
// True only after the rotated key was successfully written to
// ~/.pincushion/license-key — the candidate list labels the in-memory key
// 'home-file' only when that's actually true, else 'rotated'.
let rotatedKeyPersisted = false;
// Last advertised replacement key that FAILED validation — used to log the
// warning once per distinct key while still re-probing on subsequent syncs.
let lastUnvalidatedRotationKey = null;

// Ordered license-key candidates, most explicit first, each tagged with a
// canonical source label (matching lib/license.js KEY_SOURCE_LABELS) so both
// the self-heal fall-through AND the actionable rejection banner can name the
// exact config location:
//   1. PINCUSHION_LICENSE_KEY env       (per-invocation override)
//   2. --license-key arg                (per-server override)
//   3. server-rotated key (in memory)   (silent key refresh, this session)
//   4. <project>/.feedback/.license-key (per-project pin)
//   5. ~/.pincushion/license-key        (per-machine default — the zero-config path)
// Deduped by value (the same key from two sources lists once; earliest wins).
function cloudKeyCandidates() {
  const raw = [
    ['env', process.env.PINCUSHION_LICENSE_KEY?.trim()],
    ['cli-arg', LICENSE_KEY?.trim()],
    // Rotation persists to ~/.pincushion/license-key; claim 'home-file' only
    // when that write actually succeeded, else label it honestly as the
    // in-memory rotated key so rejection banners point at the real location.
    [rotatedKeyPersisted ? 'home-file' : 'rotated', rotatedLicenseKey],
    ['project-file', readKeyFile(join(FEEDBACK_DIR, '.license-key'))],
    ['home-file', readKeyFile(USER_LICENSE_KEY_FILE)],
  ];
  const seen = new Set();
  return raw
    .filter(([, key]) => key && !seen.has(key) && seen.add(key))
    .map(([source, key]) => ({ source, key }));
}

// Keys the cloud has rejected (401/403) during this process — skipped by
// resolution so a later source can take over. Never persisted; re-validated
// every boot. This is the self-heal: a stale or placeholder explicit key (a
// dead --license-key or env value) can no longer shadow a valid `pincushion
// login` key in ~/.pincushion/license-key — once the cloud rejects the explicit
// key we fall through to the next source.
const rejectedCloudKeys = new Set();
const cloudKeyStatuses = new Map();

// Resolve the active key AND its canonical source. Prefers the first source the
// cloud hasn't rejected (self-heal fall-through); falls back to the primary so
// the loud invalid-license banner still fires when every source is dead.
// Returns { key, source } so callers (rejection banner, rotation warnings) can
// tell the user WHICH config location supplied the key.
// source: 'env' | 'cli-arg' | 'project-file' | 'home-file' | 'none'
function resolveCloudSyncKeyInfo() {
  const candidates = cloudKeyCandidates();
  if (!candidates.length) return { key: null, source: 'none' };
  const live = candidates.find(c => !rejectedCloudKeys.has(c.key));
  // Do not keep probing the same exhausted key set. A later login/key-file
  // change creates a new candidate and naturally reopens authentication.
  return live || { key: null, source: 'none' };
}

function resolveCloudSyncKey() {
  return resolveCloudSyncKeyInfo().key;
}

// Record a cloud 401/403 for `key`. Blacklists it ONLY when another untried
// source exists (so the next resolveCloudSyncKey() falls through). Returns true
// when a fall-through is now available and the caller should retry.
function markCloudKeyRejected(key) {
  if (!key) return false;
  if (rejectedCloudKeys.has(key)) return Boolean(resolveCloudSyncKey());
  const candidates = cloudKeyCandidates();
  const offender = candidates.find(c => c.key === key);
  rejectedCloudKeys.add(key);
  cloudKeyStatuses.set(key, 'rejected');
  const next = candidates.find(c => !rejectedCloudKeys.has(c.key));
  if (next) {
    console.error(`[cloud-sync] license key from ${offender ? keySourceLabel(offender.source) : 'an explicit source'} was rejected; falling through to ${keySourceLabel(next.source)} (a stale or placeholder key no longer shadows a valid login key).`);
    return true;
  }
  // No alternative left — keep the blacklist. This is the final rejection
  // freeze: a startup discovery pass must not issue a PUT after all keys fail.
  // Direct authoritative reads can reject the last key before background sync
  // starts; publish the terminal state here so that ordering cannot hide it.
  cloudLicenseRejected = true;
  cloudLicenseRejectedInfo = { source: offender?.source || 'none', last4: keyLast4(key), reason: 'license_rejected' };
  setCloudAuthState('rejected', { source: offender?.source || 'none', key, reason: 'license_rejected' });
  return false;
}

// Validate a server-advertised replacement key BEFORE adopting it. Nothing
// guarantees the staged key is actually live server-side yet — adopting an
// unaccepted key would overwrite the only durable copy of the still-valid
// old key and brick the zero-config client (the rotated key 403s and the old
// key is gone). One lightweight authenticated probe against the sync
// endpoint: adopt only on 2xx. `since=now` keeps the response near-empty.
async function validateRotatedLicenseKey(newKey) {
  try {
    const params = new URLSearchParams({ since: new Date().toISOString() });
    const resp = await fetch(`${cloudSyncEndpoint()}?${params}`, {
      headers: { 'X-License-Key': newKey }
    });
    return resp.ok;
  } catch {
    return false; // network hiccup — treat as not-yet-valid, re-probe next sync
  }
}

// Silent key refresh: adopt a replacement key advertised by the server
// (call ONLY after validateRotatedLicenseKey confirmed the new key works).
// (a) persist it to ~/.pincushion/license-key (mode 0600) via an atomic
// temp-file + rename so a crash mid-write can never truncate the file,
// (b) use it in-memory for subsequent requests, (c) log exactly one stderr
// line. If env/CLI supplied the current key, we still persist the new key but
// warn that the explicit source keeps overriding it until removed.
function adoptRotatedLicenseKey(newKey, currentSource) {
  let persisted = false;
  const tmpFile = `${USER_LICENSE_KEY_FILE}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(USER_LICENSE_KEY_FILE), { recursive: true });
    writeFileSync(tmpFile, newKey + '\n', { mode: 0o600 });
    try { chmodSync(tmpFile, 0o600); } catch { /* mode is best-effort on exotic filesystems */ }
    renameSync(tmpFile, USER_LICENSE_KEY_FILE);
    persisted = true;
  } catch (err) {
    console.error(`[cloud-sync] Failed to persist rotated license key to ${USER_LICENSE_KEY_FILE}: ${err.message}`);
    try { rmSync(tmpFile, { force: true }); } catch { /* best-effort temp cleanup */ }
  }
  rotatedLicenseKey = newKey;
  rotatedKeyPersisted = persisted;
  console.error(`[cloud-sync] License key rotated automatically (…${keyLast4(newKey)})`);
  if (currentSource === 'env' || currentSource === 'cli-arg') {
    console.error(`[cloud-sync] Warning: your ${keySourceLabel(currentSource)} overrides the rotated key in ~/.pincushion/license-key — remove it to use the new key.`);
  }
}

function getDistinctId() {
  return resolveCloudSyncKey() || 'anonymous';
}

let lastCloudSync = null;        // ISO timestamp of last successful sync
let cloudSyncPlan = null;        // EFFECTIVE plan from the server ('free' | 'pro' | 'team'; trial-Pro arrives as 'pro')
let cloudSyncUsage = null;       // { used, cap, remaining, resetsAt } — free AI-action pool, server-reported
let cloudSyncTrial = null;       // { endsAt, active } — 14-day Pro trial state, server-reported
const MIN_BACKGROUND_SYNC_INTERVAL_MS = 30_000;
const MAX_BACKGROUND_RETRY_MS = 5 * 60_000;
let cloudSyncInterval = MIN_BACKGROUND_SYNC_INTERVAL_MS; // updated from the server response, never faster than 30s
let cloudLicenseRejected = false; // true once the cloud 401/403s a configured key — drives the loud invalid-license banner
let cloudLicenseRejectedInfo = null; // { source, last4 } of the rejected key, captured at rejection time so the banner can name the offending config location (never the full key)
// Explicit connection lifecycle for startup identity safety and diagnostics.
// `unknown` remains fail-closed until the first cloud attempt reaches a
// terminal state; it is never treated as permission to create a project.
let cloudAuthState = 'unknown';
let cloudAuthSource = 'none';
let cloudAuthKey = null;
let cloudAuthReason = 'unknown';
// True only after a successful authenticated response supplied a well-formed
// projects array and the local registry accepted that snapshot. Authentication
// alone is not enough for startup discovery to create or bind identity.
let cloudProjectRegistryAuthoritative = false;
let cloudAuthoritativeProjectIds = new Set();
// IDs establish which cached registrations are still accessible. Roles are
// separately retained from that same authenticated response so an old local
// owner/editor field can never authorize an automated submission after a
// membership downgrade.
let cloudAuthoritativeProjectRoles = new Map();
let cloudProjectsVerifiedAt = null;
// In-process ordering fence: a slow background response cannot replace a
// fresher project-only authentication snapshot that completed while it ran.
let cloudProjectAuthorityGeneration = 0;
// A read-only tool may authenticate a follower, but only a successful
// background sync can authorize startup's optional project registration.
let backgroundSyncRegistrationKey = null;
let cloudAuthReadySettled = false;
let resolveCloudAuthReady;
const cloudAuthReady = new Promise((resolve) => { resolveCloudAuthReady = resolve; });
// Startup discovery may time out while the first authoritative pull is still
// in flight. Keep only its identity reconciliation re-entrant: the broader
// boot/on-ramp work remains a one-shot startup concern.
let startupDiscoveredProject = null;
let projectIdentityReconciliationRequested = false;
let projectIdentityReconciliationInFlight = null;

function authoritativeProjectSnapshot(remoteProjects, acceptedProjectIds) {
  const ids = new Set(acceptedProjectIds || []);
  const roles = new Map();
  const conflictingRoles = new Set();
  for (const project of Array.isArray(remoteProjects) ? remoteProjects : []) {
    const projectId = String(project?.projectId || project?.id || '').trim();
    if (!projectId || !ids.has(projectId)) continue;
    const role = typeof project?.role === 'string' ? project.role.trim() : '';
    if (roles.has(projectId) && roles.get(projectId) !== role) {
      conflictingRoles.add(projectId);
      continue;
    }
    roles.set(projectId, role);
  }
  // A malformed snapshot with duplicate roles does not get to select which
  // one grants an automated write. Missing or conflicting roles fail closed
  // in the privileged scope resolver.
  for (const projectId of conflictingRoles) roles.delete(projectId);
  return { ids, roles };
}

// A configured agent that cannot reach its account is a failed connection even
// though the MCP handshake succeeded (lib/connect-failure-tracker.js decides
// when). The install ID is the person: a rejected key is not a usable identity.
const connectFailures = createConnectFailureTracker({
  report: (reason) => captureConnectFailed({ reason, stage: 'mcp' }),
  currentState: () => cloudAuthState,
  currentKey: () => cloudAuthKey,
});

function setCloudAuthState(state, { source = cloudAuthSource, key = cloudAuthKey, reason = cloudAuthReason, reconcileStartup = true } = {}) {
  if (!new Set(['unknown', 'authenticated', 'rejected', 'unavailable']).has(state)) return;
  if (state !== cloudAuthState) connectFailures.transition(state, key);
  const previousState = cloudAuthState;
  cloudAuthState = state;
  cloudAuthSource = source || 'none';
  cloudAuthKey = key || null;
  cloudAuthReason = reason || 'unknown';
  if (!cloudAuthReadySettled && state !== 'unknown') {
    cloudAuthReadySettled = true;
    resolveCloudAuthReady(state);
  }
  // A valid sync can finish after the bounded startup wait. Re-enter only the
  // safe, cache-backed identity reconciliation once authentication transitions
  // to authoritative; rejected/unavailable states remain mutation-free.
  if (state === 'authenticated' && previousState !== 'authenticated' && reconcileStartup &&
      backgroundSyncRegistrationKey === key) {
    void requestProjectIdentityReconciliation({ retryAfterCurrent: true });
  }
}

function cloudSyncEndpoint() {
  return SYNC_SERVER_URL || CLOUD_SYNC_URL;
}

function candidateDiagnosticStatus(candidate) {
  if (rejectedCloudKeys.has(candidate.key)) return 'rejected';
  return cloudKeyStatuses.get(candidate.key) || 'untried';
}

// ─── Realtime Push Notifications ─────────────────────────────────────────────
// For Pro/Team plans: Supabase Realtime subscription notifies the agent of
// newly approved pins without polling. Since MCP stdio can't push unsolicited
// messages, we queue notifications and prepend them to the next tool response.
let pendingNotifications = [];
let realtimeHandle = null;
let mcpConnected = false; // set true once transport is connected; guards early notifications
let realtimeCredentials = null;  // cached { supabaseUrl, supabaseAnonKey, channels } from sync
let realtimeRefreshInFlight = null;

function stopRealtimeIfRunning() {
  const handle = realtimeHandle;
  realtimeHandle = null;
  if (!handle) return;
  try {
    handle.unsubscribe();
  } catch (error) {
    console.error('[realtime] Failed to close background channel:', error.message);
  }
}

function scheduleRealtimeRefresh() {
  if (realtimeRefreshInFlight) return;
  realtimeRefreshInFlight = cloudSyncPull()
    .catch((error) => console.error('[realtime] Authorized refresh failed:', error?.message || 'unknown'))
    .finally(() => { realtimeRefreshInFlight = null; });
}

// ─── Approved Queue Trigger File ──────────────────────────────────────────────
// When a pin is approved (via Realtime or local approve_pin), we write
// .feedback/pending-approvals.json so IDE extensions / file watchers can detect
// newly approved pins without polling the MCP server.
// Cleared when the agent calls claim_pin or implement_approved_pins.
const PENDING_APPROVALS_PATH = join(FEEDBACK_DIR, 'pending-approvals.json');

async function readApprovedQueue() {
  if (await annotationBootstrapActive(ANNOTATIONS_DIR)) return { approvedPins: [], updatedAt: null };
  try {
    const raw = await readFile(PENDING_APPROVALS_PATH, 'utf8');
    return JSON.parse(raw);
  } catch {
    return { approvedPins: [], updatedAt: null };
  }
}

async function writeApprovedQueue(queue) {
  queue.updatedAt = new Date().toISOString();
  // Ensure .feedback/ directory exists before writing
  if (!existsSync(FEEDBACK_DIR)) mkdirSync(FEEDBACK_DIR, { recursive: true });
  await withAnnotationSyncLease(join(FEEDBACK_DIR, '.approval-lock'), async () => {
    if (await annotationBootstrapActive(ANNOTATIONS_DIR)) queue.approvedPins = [];
    await writeAnnotationSyncJson(PENDING_APPROVALS_PATH, queue);
  });
  console.error(`[trigger] Wrote ${queue.approvedPins.length} pin(s) to ${PENDING_APPROVALS_PATH}`);

  // Fire MCP resource notification so subscribing clients know the queue changed
  if (mcpConnected) {
    try { server.sendResourceUpdated({ uri: 'pincushion://approved-queue' }); } catch { /* notification is best-effort; clients re-poll the resource regardless */ }
  }
}

async function addToApprovedQueue(pin) {
  if (core.isTerminalStatus(pin.status)) return;
  if (!matchesProjectFilter(pin.projectId || null, resolveProjectFilter())) return;
  const queue = await readApprovedQueue();
  // Deduplicate by pinId
  if (!queue.approvedPins.some(p => p.pinId === pin.pinId)) {
    queue.approvedPins.push(pin);
    await writeApprovedQueue(queue);
  }
}

async function removeFromApprovedQueue(annotationId) {
  const queue = await readApprovedQueue();
  const before = queue.approvedPins.length;
  queue.approvedPins = queue.approvedPins.filter(p => p.pinId !== annotationId);
  if (queue.approvedPins.length !== before) {
    await writeApprovedQueue(queue);
  }
}

async function clearApprovedQueue() {
  await writeApprovedQueue({ approvedPins: [] });
}

async function applyJournalSyncPage(data, { bootstrap = false } = {}) {
  const changes = Array.isArray(data?.changes) ? data.changes : null;
  if (!changes) throw new Error('annotation_sync_changes_invalid');
  const hydrationById = new Map();
  if (Array.isArray(data?.hydrations)) {
    for (const hydration of data.hydrations) {
      const id = String(hydration?.annotationId || hydration?.annotation_id || '');
      if (id) hydrationById.set(id, hydration);
    }
  }

  const groups = new Map();
  let skipped = 0;
  for (const change of changes) {
    const scope = journalChangeScope(change);
    if (!scope) {
      skipped++;
      continue;
    }
    const key = `${scope.projectId}\u0000${scope.pageUrl}`;
    let group = groups.get(key);
    if (!group) {
      group = { scope, changes: [] };
      groups.set(key, group);
    }
    group.changes.push(change);
  }
  if (skipped > 0) {
    console.error(`[cloud-sync] Preserved ${skipped} journal change(s) with invalid page scope.`);
  }

  await ensureVersionedAnnotationCache({ annotationsDir: ANNOTATIONS_DIR });
  const transitions = [];
  for (const { scope, changes: scopedChanges } of groups.values()) {
    await updateScopedAnnotationPage({
      annotationsDir: ANNOTATIONS_DIR,
      bootstrapAccess: bootstrap,
      projectId: scope.projectId,
      pageUrl: scope.pageUrl,
      update: (current) => {
        const localData = current || {
          projectId: scope.projectId,
          pageUrl: scope.pageUrl,
          pageTitle: scope.pageUrl,
          annotations: [],
        };
        const byId = new Map((localData.annotations || []).map((annotation) => [String(annotation?.id || ''), annotation]));
        for (const change of scopedChanges) {
          const id = String(change.annotationId || change.annotation_id || '');
          if (!id) continue;
          const existing = byId.get(id) || null;
          const wasReady = core.isReadyStatus(existing?.status);
          // Event hydration is a boundary snapshot, not a historical delta.
          // Apply it after this page's ordered deltas below; applying it here
          // would let a later edit/delete delta rewind the final thread.
          const merged = mergeJournalChange(bootstrap ? null : existing, change, null);
          if (merged.deleted) {
            byId.delete(id);
            transitions.push({ type: 'terminal', annotation: existing || { id, projectId: scope.projectId, pageUrl: scope.pageUrl } });
            continue;
          }
          if (!merged.annotation) continue;
          byId.set(id, merged.annotation);
          const nowReady = !core.isTerminalStatus(merged.annotation.status) && core.isReadyStatus(merged.annotation.status);
          if (core.isTerminalStatus(merged.annotation.status)) {
            transitions.push({ type: 'terminal', annotation: merged.annotation });
          } else if (nowReady && !wasReady) {
            transitions.push({ type: 'approved', annotation: merged.annotation });
          }
          if (!localData.pageTitle || localData.pageTitle === scope.pageUrl) {
            localData.pageTitle = merged.annotation.pageTitle || scope.pageUrl;
          }
        }
        // A create or message edit/delete may have no complete thread in its
        // bounded journal projection. The adapter supplies one current
        // aggregate at this page's immutable boundary. Applying it last keeps
        // multi-event pages deterministic while preserving stable message IDs.
        for (const hydration of hydrationById.values()) {
          const id = String(hydration?.annotationId || hydration?.annotation_id || '');
          if (!id || !byId.has(id) || !hydration?.annotation) continue;
          const candidate = hydration.annotation;
          const candidateProjectId = String(candidate.projectId || candidate.project_id || '');
          const candidatePageUrl = String(candidate.pageUrl || candidate.page_url || '');
          if (candidateProjectId !== scope.projectId || candidatePageUrl !== scope.pageUrl) continue;
          const merged = mergeJournalChange(byId.get(id), {
            deletion: false,
            after: candidate,
            messageDelta: [],
          }, hydration);
          if (merged.annotation) byId.set(id, merged.annotation);
        }
        localData.annotations = [...byId.values()];
        localData.projectId = scope.projectId;
        localData.pageUrl = scope.pageUrl;
        localData.exportedAt = new Date().toISOString();
        return localData;
      },
    });
  }

  // Queue and notification side effects happen only after all page writes have
  // committed. A failed cache update therefore cannot manufacture actionable
  // work from an unpersisted journal event.
  if (bootstrap) return { applied: changes.length, skipped };
  const getBranchName = await loadGitModule();
  for (const transition of transitions) {
    const annotation = transition.annotation || {};
    if (transition.type === 'terminal') {
      if (annotation.id) await removeFromApprovedQueue(annotation.id);
      if (annotation.id) {
        const agentQueuePath = core.agentQueueFilePath(join(FEEDBACK_DIR, '.agent-queue'), annotation.id);
        try {
          if (agentQueuePath && existsSync(agentQueuePath)) await unlink(agentQueuePath);
        } catch (error) {
          console.error(`[cloud-sync] Failed to remove terminal agent queue ${annotation.id}: ${error.message}`);
        }
      }
      continue;
    }
    if (!annotation.id) continue;
    const branch = getBranchName(annotation.pageTitle, annotation.pageUrl);
    const notification = {
      type: 'pin_approved',
      pinId: annotation.id,
      status: annotation.status,
      pageTitle: annotation.pageTitle || annotation.pageUrl,
      pageUrl: annotation.pageUrl,
      projectId: annotation.projectId || null,
      approvedBy: annotation.approvedBy || 'someone',
      comment: (annotation.thread?.[0]?.body || '').slice(0, 80),
      suggestedBranch: branch,
      timestamp: new Date().toISOString(),
      message: `Pin approved on "${annotation.pageTitle || annotation.pageUrl}" by ${annotation.approvedBy || 'someone'}`,
    };
    await addToApprovedQueue(notification);
    pendingNotifications.push(notification);
  }
  return { applied: changes.length, skipped };
}

let cloudSyncInFlight = null;
let cloudSyncInFlightConditional = false;
function cloudSyncPull({ onlyWhileBootstrapping = false } = {}) {
  if (cloudSyncInFlight) {
    // A conditional wait-for-bootstrap pull may legitimately do nothing, so a
    // caller that needs a real pull must not coalesce into it.
    if (cloudSyncInFlightConditional && !onlyWhileBootstrapping) {
      const conditional = cloudSyncInFlight;
      return conditional.then(() => cloudSyncPull(), () => cloudSyncPull());
    }
    return cloudSyncInFlight;
  }
  cloudSyncInFlightConditional = onlyWhileBootstrapping;
  const pull = withAnnotationSyncLease(FEEDBACK_DIR, async (assertOwned) => {
    // A reader that saw an unfinished bootstrap is waiting for that bootstrap,
    // not asking for a pull. Re-check under the lease: its owner may finish and
    // release between the reader's check and this acquisition, and a follower
    // must not turn that wait into its own full, authenticating cloud sync.
    if (onlyWhileBootstrapping && !await annotationBootstrapActive(ANNOTATIONS_DIR)) return true;
    return cloudSyncPullLocked({ assertOwned });
  })
    .catch(error => { console.error(`[cloud-sync] Pull deferred: ${error.message}`); return false; })
    .finally(() => { if (cloudSyncInFlight === pull) { cloudSyncInFlight = null; cloudSyncInFlightConditional = false; } });
  cloudSyncInFlight = pull;
  return pull;
}

// Tool calls need current project identity, not a potentially long annotation
// bootstrap. This bounded projects-only probe uses the same credential and
// account-mismatch checks as the background sync, without fetching pins.
let projectAuthInFlight = null;
function cloudProjectAuthProbe() {
  if (projectAuthInFlight) return projectAuthInFlight;
  projectAuthInFlight = cloudProjectAuthProbeOnce()
    .catch((error) => {
      if (error.message !== 'annotation_sync_busy') {
        setCloudAuthState('unavailable', { reason: 'cloud_inaccessible' });
        console.error(`[cloud-sync] Project authentication deferred: ${error.message}`);
      }
      return false;
    })
    .finally(() => { projectAuthInFlight = null; });
  return projectAuthInFlight;
}
async function cloudProjectAuthProbeOnce() {
  const { key, source } = resolveCloudSyncKeyInfo();
  if (!key) {
    setCloudAuthState(cloudLicenseRejected ? 'rejected' : 'unavailable', {
      source: cloudLicenseRejectedInfo?.source || 'none',
      key: null,
      reason: cloudLicenseRejectedInfo?.reason || 'cloud_inaccessible',
    });
    return false;
  }
  cloudKeyStatuses.set(key, 'active');
  const endpoint = new URL(cloudSyncEndpoint());
  endpoint.searchParams.set('projects_only', '1');
  const authorityGenerationAtFetch = cloudProjectAuthorityGeneration;
  const response = await fetch(endpoint, {
    headers: { 'X-License-Key': key, 'X-Pincushion-Client': `mcp/${PKG_VERSION}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401 || response.status === 403) {
    let reason = 'license_rejected';
    try {
      const body = await response.json();
      if (body?.error === 'account_mismatch' || body?.code === 'account_mismatch') reason = 'account_mismatch';
    } catch { /* a non-JSON rejection remains license_rejected */ }
    if (markCloudKeyRejected(key)) return cloudProjectAuthProbeOnce();
    cloudLicenseRejected = true;
    cloudLicenseRejectedInfo = { source, last4: keyLast4(key), reason };
    setCloudAuthState('rejected', { source, key, reason });
    return false;
  }
  if (!response.ok) {
    setCloudAuthState('unavailable', { source, key, reason: 'cloud_inaccessible' });
    return false;
  }
  const data = await response.json();
  if (!data || !Array.isArray(data.projects) || typeof data.licenseId !== 'string' || !data.licenseId) {
    setCloudAuthState('unavailable', { source, key, reason: 'cloud_inaccessible' });
    return false;
  }
  let hydration;
  let mismatch = false;
  let stale = false;
  await withAnnotationSyncLease(join(FEEDBACK_DIR, '.project-registry'), async () => {
    if (resolveCloudSyncKey() !== key ||
        cloudProjectAuthorityGeneration !== authorityGenerationAtFetch) {
      stale = true;
      return;
    }
    const cached = await core.readProjectRegistry({ feedbackDir: FEEDBACK_DIR });
    if (cached.malformed) return;
    mismatch = core.detectProjectAccountMismatch({
      projects: cached.projects,
      remoteProjects: data.projects,
      activeLicenseId: data.licenseId,
    });
    if (!mismatch) {
      hydration = await core.mergeProjectRegistry(
        { feedbackDir: FEEDBACK_DIR }, data.projects,
        { viewerLicenseId: data.licenseId },
      );
    }
  });
  if (stale || resolveCloudSyncKey() !== key ||
      cloudProjectAuthorityGeneration !== authorityGenerationAtFetch) return false;
  if (mismatch) {
    rejectedCloudKeys.add(key);
    cloudKeyStatuses.set(key, 'rejected');
    if (resolveCloudSyncKey()) return cloudProjectAuthProbeOnce();
    cloudLicenseRejected = true;
    cloudLicenseRejectedInfo = { source, last4: keyLast4(key), reason: 'account_mismatch' };
    setCloudAuthState('rejected', { source, key, reason: 'account_mismatch' });
    return false;
  }
  if (hydration?.reason !== 'merged' && hydration?.reason !== 'no_remote_projects') {
    setCloudAuthState('unavailable', { source, key, reason: 'cloud_inaccessible' });
    return false;
  }
  const snapshot = authoritativeProjectSnapshot(data.projects, hydration.projectIds);
  cloudAuthoritativeProjectIds = snapshot.ids;
  cloudAuthoritativeProjectRoles = snapshot.roles;
  cloudProjectRegistryAuthoritative = true;
  cloudProjectsVerifiedAt = new Date().toISOString();
  cloudProjectAuthorityGeneration++;
  cloudLicenseRejected = false;
  cloudLicenseRejectedInfo = null;
  setCloudAuthState('authenticated', { source, key, reason: 'connected', reconcileStartup: false });
  return true;
}

// Background polling is leader-only, but every MCP process must authenticate
// before it can answer a project-context request or perform a project-scoped
// write. Otherwise a follower stays `unknown` forever, even with a valid
// shared login. Reuse the fenced sync path rather than trusting another
// process's cache or turning a cached role into an authorization grant.
let onDemandAuthInFlight = null;
let lastOnDemandAuthAttempt = 0;
const MAX_TOOL_PROJECT_AUTH_AGE_MS = 60_000;
function invalidateCloudProjectAuthority() {
  cloudProjectRegistryAuthoritative = false;
  cloudAuthoritativeProjectIds = new Set();
  cloudAuthoritativeProjectRoles = new Map();
  cloudProjectsVerifiedAt = null;
  setCloudAuthState('unknown', { source: 'none', key: null, reason: 'unknown' });
}
async function ensureCloudAuthForTool() {
  // Login may replace the home credential while a pull is in flight. Check
  // the key *after* every awaited pull as well as before using its roles.
  for (let keyAttempt = 0; keyAttempt < 3; keyAttempt++) {
    const configuredKey = resolveCloudSyncKey();
    const verifiedAge = cloudProjectsVerifiedAt ? Date.now() - Date.parse(cloudProjectsVerifiedAt) : Infinity;
    if (cloudAuthState === 'authenticated' && configuredKey === cloudAuthKey &&
        cloudProjectRegistryAuthoritative && verifiedAge < MAX_TOOL_PROJECT_AUTH_AGE_MS) return;
    if (cloudAuthState === 'authenticated') invalidateCloudProjectAuthority();
    if (!cloudKeyCandidates().length) return;
    if (onDemandAuthInFlight) {
      await onDemandAuthInFlight;
    } else {
      // A failed cloud request should not turn repeated tool calls into a burst
      // of retries. An untried follower may always make its first attempt.
      if (cloudAuthState !== 'unknown' && Date.now() - lastOnDemandAuthAttempt < 30_000) return;
      onDemandAuthInFlight = (async () => {
        lastOnDemandAuthAttempt = Date.now();
        // Another process may own the annotation-sync lease for a short pull.
        // Wait for it to release the lease; never borrow its authenticated state.
        for (let attempt = 0; attempt < 40 && cloudAuthState !== 'authenticated'; attempt++) {
          if (await cloudProjectAuthProbe()) {
            lastOnDemandAuthAttempt = 0;
            return;
          }
          if (cloudAuthState === 'rejected' || cloudAuthState === 'unavailable') return;
          if (attempt < 39) await new Promise((resolve) => setTimeout(resolve, 250));
        }
      })().finally(() => { onDemandAuthInFlight = null; });
      await onDemandAuthInFlight;
    }
    if (cloudAuthState !== 'authenticated') return;
    if (resolveCloudSyncKey() === cloudAuthKey) return;
    invalidateCloudProjectAuthority();
  }
}
async function cloudSyncPullLocked({ forceBootstrap = false, assertOwned, restarts = 0 } = {}) {
  const { key: licenseKey, source: keySource } = resolveCloudSyncKeyInfo();
  if (!licenseKey) {
    // No configured key, or every configured candidate has been rejected.
    // Keep startup discovery fail-closed until a later login changes the
    // candidate set; importantly, no project PUT can follow this state.
    if (cloudLicenseRejected) setCloudAuthState('rejected', { source: cloudLicenseRejectedInfo?.source, key: null, reason: cloudLicenseRejectedInfo?.reason || 'license_rejected' });
    else setCloudAuthState('unavailable', { source: 'none', key: null, reason: 'cloud_inaccessible' });
    return false;
  }
  cloudKeyStatuses.set(licenseKey, 'active');

  try {
    await assertOwned();
    let bootstrap = await readAnnotationBootstrap(ANNOTATIONS_DIR);
    const syncState = readCloudSyncState();
    const cacheExists = existsSync(join(ANNOTATIONS_DIR, 'v2', '.manifest.json'));
    if (forceBootstrap || (!bootstrap && (!syncState || !cacheExists)) || (bootstrap && !await bootstrapCacheIntact(ANNOTATIONS_DIR, bootstrap))) {
      bootstrap = await beginAnnotationBootstrap(ANNOTATIONS_DIR);
    }
    if (bootstrap) {
      await clearApprovedQueue(); pendingNotifications = [];
      if (bootstrap.state && !bootstrap.state.cursor) {
        await finishAnnotationBootstrap({ annotationsDir: ANNOTATIONS_DIR, bootstrap, clearQueue: clearApprovedQueue, writeJournalState: writeCloudSyncState, assertOwned });
        await reconcileApprovedQueue({ localOnly: true });
        return true;
      }
    }
    const journalPlan = bootstrap ? null : annotationSyncRequestPlan(syncState);
    const params = bootstrap ? new URLSearchParams({ sync_cursor: '1', bootstrap: '1', limit: '200' }) : journalPlan.params;
    if (bootstrap?.state?.cursor) params.set('cursor', bootstrap.state.cursor);

    const authorityGenerationAtFetch = cloudProjectAuthorityGeneration;
    const resp = await fetch(`${cloudSyncEndpoint()}?${params}`, {
      // The client tag identifies the runtime. Background sync is not a pin
      // read; only explicit tool-result receipts record that milestone.
      headers: { 'X-License-Key': licenseKey, 'X-Pincushion-Client': `mcp/${PKG_VERSION}` },
      // Annotation bootstrap pages are larger than the projects-only auth
      // probe; retain a finite bound without aborting healthy slow responses.
      signal: AbortSignal.timeout(30_000)
    });

    if (!resp.ok) {
      // Retention or membership changes restart a paginated materialized
      // bootstrap. Once journal sync is used, legacy watermarks are unsafe.
      if (journalPlan || bootstrap) {
        let journalCode = '';
        try {
          const journalBody = await resp.clone().json();
          journalCode = String(journalBody?.error || journalBody?.code || '');
        } catch { /* non-JSON response is handled by the normal status path */ }
        if (['sync_cursor_unavailable', 'sync_cursor_invalid', 'sync_cursor_expired',
          'sync_resync_required', 'sync_cursor_scope_changed', 'annotation_sync_resync_required',
          'annotation_sync_cursor_expired', 'annotation_sync_cursor_scope_changed'].includes(journalCode)) {
          await assertOwned(); await beginAnnotationBootstrap(ANNOTATIONS_DIR); await clearApprovedQueue(); pendingNotifications = [];
          if (restarts >= 1) return false;
          return cloudSyncPullLocked({ assertOwned, restarts: restarts + 1 });
        }
      }
      if (resp.status === 401 || resp.status === 403) {
        let rejectionReason = 'license_rejected';
        try {
          const rejectedBody = await resp.clone().json();
          if (rejectedBody?.error === 'account_mismatch' || rejectedBody?.code === 'account_mismatch') rejectionReason = 'account_mismatch';
        } catch { /* a non-JSON rejection remains license_rejected */ }
        // Self-heal: if an explicit override key was rejected while a valid
        // login key sits in a later source, blacklist it and retry once with
        // the fallen-through key. Otherwise surface the rejection (loud banner).
        if (markCloudKeyRejected(licenseKey)) return cloudSyncPullLocked({ assertOwned, restarts });
        cloudLicenseRejected = true;
        cloudLicenseRejectedInfo = { source: keySource, last4: keyLast4(licenseKey) };
        setCloudAuthState('rejected', { source: keySource, key: licenseKey, reason: rejectionReason });
        console.error(`[cloud-sync] License key (…${keyLast4(licenseKey)}, from ${keySourceLabel(keySource)}) was rejected — run \`npx pincushion-mcp login\` to refresh it, or disable sync with --no-cloud-sync`);
      }
      if (resp.status !== 401 && resp.status !== 403) {
        setCloudAuthState('unavailable', { source: keySource, key: licenseKey, reason: 'cloud_inaccessible' });
      }
      return false;
    }
    cloudLicenseRejected = false; // a successful sync clears the rejected state
    cloudLicenseRejectedInfo = null;

    let data;
    try {
      data = await resp.json();
    } catch {
      setCloudAuthState('unavailable', { source: keySource, key: licenseKey, reason: 'cloud_inaccessible' });
      console.error('[cloud-sync] Sync response was not valid JSON; cached annotations and projects were left unchanged');
      return false;
    }
    if (!data || typeof data !== 'object' || Array.isArray(data) ||
        (data.annotations !== undefined && !Array.isArray(data.annotations)) ||
        (data.projects !== undefined && !Array.isArray(data.projects))) {
      setCloudAuthState('unavailable', { source: keySource, key: licenseKey, reason: 'cloud_inaccessible' });
      console.error('[cloud-sync] Sync response was malformed; cached annotations and projects were left unchanged');
      return false;
    }
    if (resolveCloudSyncKey() !== licenseKey ||
        cloudProjectAuthorityGeneration !== authorityGenerationAtFetch) {
      // A login or project-only probe overtook this response. Its roles and
      // annotation cursor cannot replace the newer authenticated snapshot.
      return false;
    }
    validateAnnotationSyncPage(data, { mode: bootstrap ? 'bootstrap' : 'journal', previous: bootstrap ? bootstrap.state : syncState, cursors: bootstrap?.cursors || (syncState?.cursor ? [syncState.cursor] : []) });
    await assertOwned();
    const annotations = data.annotations || [];

    // Project hydration is part of a successful sync, not an annotation-only
    // side effect. Do it before the zero-annotations return so a fresh
    // workspace still learns its immutable project IDs and metadata.
    if (Array.isArray(data.projects)) {
      try {
        // Retain the immutable identity of the viewer for every cloud-returned
        // role. It is recovery evidence only (never an authorization grant),
        // so a later valid key for another Google account can be classified
        // account_mismatch even when the cached user was an editor/commenter.
        const projectResult = await withAnnotationSyncLease(
          join(FEEDBACK_DIR, '.project-registry'),
          async () => {
            if (resolveCloudSyncKey() !== licenseKey ||
                cloudProjectAuthorityGeneration !== authorityGenerationAtFetch) {
              return { stale: true };
            }
            const cached = await core.readProjectRegistry({ feedbackDir: FEEDBACK_DIR });
            if (!cached.malformed && data.licenseId && core.detectProjectAccountMismatch({
              projects: cached.projects,
              remoteProjects: data.projects,
              activeLicenseId: data.licenseId,
            })) return { mismatch: true };
            return { hydration: await core.mergeProjectRegistry(
              { feedbackDir: FEEDBACK_DIR }, data.projects,
              { viewerLicenseId: data.licenseId },
            ) };
          },
        );
        if (projectResult.stale) return false;
        if (projectResult.mismatch) {
          rejectedCloudKeys.add(licenseKey);
          cloudKeyStatuses.set(licenseKey, 'rejected');
          console.error(`[cloud-sync] Authenticated credential from ${keySourceLabel(keySource)} belongs to a different account than this workspace's cached immutable viewer identity; cached projects and pins remain read-only.`);
          if (resolveCloudSyncKey()) return cloudSyncPullLocked({ assertOwned, restarts });
          cloudLicenseRejected = true;
          cloudLicenseRejectedInfo = { source: keySource, last4: keyLast4(licenseKey), reason: 'account_mismatch' };
          setCloudAuthState('rejected', { source: keySource, key: licenseKey, reason: 'account_mismatch' });
          return false;
        }
        const { hydration } = projectResult;
        if (resolveCloudSyncKey() !== licenseKey ||
            cloudProjectAuthorityGeneration !== authorityGenerationAtFetch) return false;
        cloudProjectRegistryAuthoritative = hydration.reason === 'merged' || hydration.reason === 'no_remote_projects';
        if (cloudProjectRegistryAuthoritative) {
          const snapshot = authoritativeProjectSnapshot(data.projects, hydration.projectIds);
          cloudAuthoritativeProjectIds = snapshot.ids;
          cloudAuthoritativeProjectRoles = snapshot.roles;
          cloudProjectsVerifiedAt = new Date().toISOString();
          cloudProjectAuthorityGeneration++;
        } else {
          cloudAuthoritativeProjectIds = new Set();
          cloudAuthoritativeProjectRoles = new Map();
          cloudProjectsVerifiedAt = null;
        }
        if (hydration.written) console.error(`[cloud-sync] Hydrated ${hydration.projectIds.length} project registration(s) into ${join(FEEDBACK_DIR, 'projects.json')}`);
      } catch (error) {
        if (cloudProjectAuthorityGeneration !== authorityGenerationAtFetch) return false;
        cloudProjectRegistryAuthoritative = false;
        cloudAuthoritativeProjectIds = new Set();
        cloudAuthoritativeProjectRoles = new Map();
        cloudProjectsVerifiedAt = null;
        console.error(`[cloud-sync] Project cache hydration failed; existing cache was preserved: ${error.message}`);
      }
    } else {
      cloudProjectRegistryAuthoritative = false;
      cloudAuthoritativeProjectIds = new Set();
      cloudAuthoritativeProjectRoles = new Map();
      cloudProjectsVerifiedAt = null;
    }
    // Publish authenticated readiness only after project hydration has
    // completed, so startup discovery cannot race ahead of the atomic cache
    // write and manufacture a replacement project.
    const firstAuthoritativeBackgroundSync = cloudProjectRegistryAuthoritative &&
      backgroundSyncRegistrationKey !== licenseKey;
    if (cloudProjectRegistryAuthoritative) backgroundSyncRegistrationKey = licenseKey;
    const alreadyAuthenticated = cloudAuthState === 'authenticated';
    setCloudAuthState('authenticated', { source: keySource, key: licenseKey, reason: 'connected' });
    if (firstAuthoritativeBackgroundSync && alreadyAuthenticated) {
      void requestProjectIdentityReconciliation({ retryAfterCurrent: true });
    }

    // Silent key refresh: the server can stage a replacement key on the
    // license row (licenses.next_key); it arrives as `newLicenseKey` (with an
    // optional `expiresAt` for the OLD key). VALIDATE it against the sync
    // endpoint first — only a key the cloud actually accepts may replace the
    // durable copy of the still-working old key. On a 2xx, adopt it: persist
    // to ~/.pincushion/license-key (0600, atomic), switch the in-memory key,
    // log one line. On failure, keep the old key and re-probe on the next
    // sync (one cheap request per cycle — no retry loop).
    if (data.newLicenseKey && typeof data.newLicenseKey === 'string' &&
        data.newLicenseKey !== licenseKey && data.newLicenseKey !== rotatedLicenseKey) {
      if (await validateRotatedLicenseKey(data.newLicenseKey)) {
        if (data.expiresAt) console.error(`[cloud-sync] Current key expires at ${data.expiresAt} — rotating now`);
        adoptRotatedLicenseKey(data.newLicenseKey, keySource);
        lastUnvalidatedRotationKey = null;
      } else if (lastUnvalidatedRotationKey !== data.newLicenseKey) {
        lastUnvalidatedRotationKey = data.newLicenseKey;
        console.error(`[cloud-sync] Advertised replacement key (…${keyLast4(data.newLicenseKey)}) failed validation — keeping the current key (…${keyLast4(licenseKey)}); will re-check on the next sync`);
      }
    }

    // Update sync interval based on plan
    if (data.plan && data.plan !== cloudSyncPlan) {
      cloudSyncPlan = data.plan;
      const requestedInterval = data.limits?.syncIntervalHint
        ? data.limits.syncIntervalHint * 1000
        : MIN_BACKGROUND_SYNC_INTERVAL_MS;
      // Realtime handles prompt Pro/Team notifications. Keep periodic cloud
      // polling at the same 30-second floor as the extension so a provider
      // hint cannot turn a healthy client into a high-frequency invoker.
      cloudSyncInterval = Math.max(MIN_BACKGROUND_SYNC_INTERVAL_MS, requestedInterval);
      console.error(`[cloud-sync] Plan: ${data.plan}, interval: ${cloudSyncInterval / 1000}s`);
    }
    // Cache the free AI-action pool + trial state (drives the quota pre-flight
    // and the low-headroom banner; authoritative gate is server-side).
    if (data.usage) cloudSyncUsage = data.usage;
    if (data.trial) cloudSyncTrial = data.trial;

    // Cache only the public Supabase URL/key and short-lived private topics.
    // The account license key is never passed to Realtime.
    if (data.realtime) {
      realtimeCredentials = data.realtime;
      startRealtimeIfEligible(data.realtime).catch((error) => {
        console.error('[realtime] Failed to start:', error.message);
      });
    } else {
      realtimeCredentials = null;
      stopRealtimeIfRunning();
    }

    if (bootstrap) {
      const remaining = await applyAnnotationBootstrapPage({
        annotationsDir: ANNOTATIONS_DIR, bootstrap, page: data,
        applyPage: page => applyJournalSyncPage(page, { bootstrap: true }),
        clearQueue: clearApprovedQueue, writeJournalState: writeCloudSyncState, assertOwned,
      });
      if (remaining) return cloudSyncPullLocked({ assertOwned, restarts });
      await reconcileApprovedQueue({ localOnly: true });
      return true;
    }
    await applyJournalSyncPage(data);
    await assertOwned();
    await writeCloudSyncState(buildAnnotationSyncState({ licenseId: data.licenseId, syncVersion: data.syncVersion, cursor: data.nextCursor }));
    await reconcileApprovedQueue({ localOnly: true });
    return true;

  } catch (err) {
    setCloudAuthState('unavailable', { source: keySource, key: licenseKey });
    console.error(`[cloud-sync] Pull failed: ${err.message}`);
    return false;
  }
}

/**
 * Scan all local annotation files for pins with status='approved' and rebuild
 * the pending-approvals.json trigger file. Pins already claimed (in-progress)
 * or resolved are excluded. Only adds pins not already in the queue.
 */
async function reconcileApprovedQueue({ localOnly = false } = {}) {
  try {
    // A successful cloud pull has just made the local files authoritative for
    // this cycle. Do not immediately make a second full Supabase request just
    // to rebuild a local trigger file.
    const allData = localOnly
      ? await core.readAllAnnotations(coreConfig)
      : await readAllAnnotations();
    const projectFilter = resolveProjectFilter();
    const pageCount = Object.keys(allData).length;
    let totalAnns = 0;
    let approvedCount = 0;
    const eligibleById = new Map();
    for (const [, data] of Object.entries(allData)) {
      totalAnns += (data.annotations || []).length;
      for (const ann of (data.annotations || [])) {
        if (core.isTerminalStatus(ann.status)) continue;
        if (!core.isReadyStatus(ann.status) || !matchesProjectFilter(ann.projectId || null, projectFilter)) continue;
        approvedCount++;
        eligibleById.set(ann.id, ann);
      }
    }
    console.error(`[reconcile] Scanning ${totalAnns} annotations across ${pageCount} pages — ${approvedCount} approved for active project filter`);

    const getBranchName = await loadGitModule();
    const queue = await readApprovedQueue();
    const beforeQueueLength = queue.approvedPins.length;
    // A queue payload is a cache, never lifecycle authority. Rebuild its
    // membership from the latest non-terminal annotations before adding work.
    queue.approvedPins = queue.approvedPins.filter((item) => eligibleById.has(item.pinId));
    const existingIds = new Set(queue.approvedPins.map(p => p.pinId));
    let added = 0;

    for (const [entryKey, data] of Object.entries(allData)) {
      const pageUrl = typeof data?.pageUrl === 'string' && data.pageUrl ? data.pageUrl : entryKey;
      const anns = data.annotations || [];
      for (const ann of anns) {
        if (core.isTerminalStatus(ann.status) || !core.isReadyStatus(ann.status)) continue;
        if (!matchesProjectFilter(ann.projectId || null, projectFilter)) continue;
        if (existingIds.has(ann.id)) continue;

        queue.approvedPins.push({
          type: 'pin_approved',
          pinId: ann.id,
          status: ann.status,
          pageTitle: ann.pageTitle || pageUrl,
          pageUrl: ann.pageUrl || pageUrl,
          projectId: ann.projectId || null,
          approvedBy: ann.approvedBy || 'someone',
          comment: (ann.thread?.[0]?.body || '').slice(0, 80),
          suggestedBranch: getBranchName(ann.pageTitle, ann.pageUrl || pageUrl),
          timestamp: ann.approvedAt || new Date().toISOString(),
          message: `Pin approved on "${ann.pageTitle || pageUrl}" by ${ann.approvedBy || 'someone'}`,
        });
        added++;

        // Also queue in-memory notification if not already notified
        if (!pendingNotifications.some(n => n.pinId === ann.id)) {
          const branch = getBranchName(ann.pageTitle, ann.pageUrl || pageUrl);
          pendingNotifications.push({
            type: 'pin_approved',
            pinId: ann.id,
            pageTitle: ann.pageTitle || pageUrl,
            projectId: ann.projectId || null,
            approvedBy: ann.approvedBy || 'someone',
            comment: (ann.thread?.[0]?.body || '').slice(0, 80),
            suggestedBranch: branch,
            timestamp: ann.approvedAt || new Date().toISOString(),
            message: `New pin approved on "${ann.pageTitle || pageUrl}" by ${ann.approvedBy || 'someone'}. Suggested branch: ${branch}`,
          });
        }
      }
    }

    if (added > 0 || queue.approvedPins.length !== beforeQueueLength) {
      await writeApprovedQueue(queue);
      console.error(`[reconcile] Rebuilt trigger file (${added} added, ${beforeQueueLength - queue.approvedPins.length + added} stale removed)`);
    } else {
      console.error(`[reconcile] All ${approvedCount} approved pin(s) already in queue — no changes`);
    }
  } catch (err) {
    console.error(`[reconcile] Failed: ${err.message}`);
    console.error(`[reconcile] Stack: ${err.stack}`);
  }
}

// Start cloud sync polling loop.
// Uses a self-scheduling setTimeout so the interval adapts dynamically when
// cloudSyncPull() updates cloudSyncInterval based on the server-returned plan.
// (setInterval captures the value at call time and cannot change after the fact.)
if (CLOUD_SYNC || resolveCloudSyncKey()) {
  const key = resolveCloudSyncKey();
  if (key) {
    console.error(`[cloud-sync] Enabled — polling ${CLOUD_SYNC_URL}`);
    let backgroundFailures = 0;
    async function runSyncLoop() {
      // Several IDE sessions can host this same workspace concurrently. Only
      // the elected local leader performs periodic Supabase work; followers
      // remain fully functional for direct MCP calls but do not multiply the
      // background sync load.
      let nextDelay = cloudSyncInterval;
      try {
        if (await backgroundRefreshLease.ensureLeader()) {
          const synced = await cloudSyncPull();
          if (synced) {
            backgroundFailures = 0;
          } else {
            backgroundFailures = Math.min(backgroundFailures + 1, 10);
            nextDelay = Math.min(
              MAX_BACKGROUND_RETRY_MS,
              MIN_BACKGROUND_SYNC_INTERVAL_MS * (2 ** (backgroundFailures - 1)),
            );
            console.error(`[cloud-sync] Backing off ${Math.round(nextDelay / 1000)}s after ${backgroundFailures} failed background sync attempt(s)`);
          }
        } else {
          // If a formerly healthy process loses the lease, close its Realtime
          // channel too. It may become leader later and re-open it after a
          // successful cloud pull, but it cannot retain a duplicate socket.
          backgroundFailures = 0;
          stopRealtimeIfRunning();
        }
      } catch (error) {
        backgroundFailures = Math.min(backgroundFailures + 1, 10);
        nextDelay = Math.min(
          MAX_BACKGROUND_RETRY_MS,
          MIN_BACKGROUND_SYNC_INTERVAL_MS * (2 ** (backgroundFailures - 1)),
        );
        console.error(`[cloud-sync] Background loop failed; retrying in ${Math.round(nextDelay / 1000)}s: ${error.message}`);
      } finally {
        setTimeout(runSyncLoop, nextDelay); // re-reads cloudSyncInterval each time
      }
    }
    runSyncLoop();
  } else {
    setCloudAuthState(cloudLicenseRejected ? 'rejected' : 'unavailable', {
      source: cloudLicenseRejectedInfo?.source || 'none',
      key: null,
    });
    console.error('[cloud-sync] Cloud sync requested but no license key found. Run `npx -y pincushion-mcp setup` to sign in and connect (or set PINCUSHION_LICENSE_KEY / ~/.pincushion/license-key).');
  }
} else {
  setCloudAuthState('unavailable', { source: 'none', key: null });
  // No key and cloud sync not requested: a fresh install. Don't fail silently —
  // tell the user exactly how to turn on cloud features. (Without this, a new
  // user thinks everything works while projects/pins/share-reports never sync.)
  console.error('[pincushion] Running local-only — not signed in. Cloud projects, pins, and share reports are off. Run `npx -y pincushion-mcp setup` in your project folder to sign in, pick a project and connect your agent.');

  // A4 (first-5-users / install→signup leak): when a HUMAN runs this interactively
  // in a terminal — not an IDE spawning it over a stdio pipe, not CI — auto-open
  // the one-time sign-in so the install actually becomes an account. The stdin-TTY
  // guard in shouldAutoOpenSignin() is what keeps a browser from popping at editor
  // startup. Fires at most once per machine; reuses the tested `login` loopback.
  const signinMarker = join(homedir(), '.pincushion', '.signin-prompted');
  if (shouldAutoOpenSignin({
    hasLicenseKey: !!resolveCloudSyncKey(),
    stdinIsTTY: !!process.stdin.isTTY,
    env: process.env,
    markerExists: existsSync(signinMarker),
  })) {
    try {
      mkdirSync(dirname(signinMarker), { recursive: true });
      writeFileSync(signinMarker, new Date().toISOString());
    } catch { /* best-effort marker; never block boot on it */ }
    console.error('[pincushion] First run — opening a quick sign-in in your browser (free, ~20s, once). Skip with PINCUSHION_NO_BROWSER=1.');
    try {
      const { runLogin } = await import('./login.mjs');
      const code = await runLogin();
      if (code === 0) {
        console.error('[pincushion] Signed in. To continue a critique, run `npx pincushion-mcp claim <report-token>` in its repository. Starting without a report? Run `npx pincushion-mcp setup` and choose your editor.');
        console.error('[pincushion] Authentication is complete; project access, exact-pin reads, implementation, and deployment are separate checks. The browser extension is optional.');
        // Exiting: drain the sign-in events first, as `login` does.
        await shutdownPostHog();
        process.exit(0);
      }
      console.error('[pincushion] Sign-in not completed — continuing local-only. Run `npx -y pincushion-mcp setup` anytime to finish.');
    } catch (e) {
      console.error('[pincushion] Could not start sign-in:', e?.message || e, '— continuing local-only.');
    }
  }
}

// ─── Realtime Startup ────────────────────────────────────────────────────────
// Starts Supabase Realtime subscription for Pro/Team plans.
// Queues notifications that get prepended to the next MCP tool response.

async function startRealtimeIfEligible(creds) {
  if (!creds?.supabaseUrl || !creds?.supabaseAnonKey || !Array.isArray(creds.channels) || creds.channels.length === 0) {
    stopRealtimeIfRunning();
    return;
  }

  if (realtimeHandle) {
    if (typeof realtimeHandle.updateChannels === 'function') {
      await realtimeHandle.updateChannels(creds.channels);
    }
    return;
  }

  const startListener = await loadRealtimeModule();
  if (!startListener) return; // @supabase/supabase-js not installed

  // Module loading is asynchronous. Re-check after it completes so a process
  // that lost the workspace lease while starting never opens a duplicate
  // Realtime connection.
  if (realtimeHandle || !await backgroundRefreshLease.ensureLeader()) return;

  console.error('[realtime] Starting Supabase Realtime subscription...');

  realtimeHandle = startListener({
    supabaseUrl: creds.supabaseUrl,
    supabaseAnonKey: creds.supabaseAnonKey,
    channels: creds.channels,
    onRevision: (event) => {
      console.error(`[realtime] Revision ${event.revision} received for ${event.projectId || 'project'}; refreshing through authorized sync`);
      scheduleRealtimeRefresh();
    },
    onError: (err) => {
      console.error('[realtime] Subscription error:', err?.message || 'unknown');
    },
  });
}

/**
 * Drain pending notifications and return a formatted header string.
 * Called before returning any MCP tool response so the agent sees
 * new approvals without having to poll.
 */
// The #1 onboarding complaint: no license key => the server silently runs
// local-only and cloud pins never appear, with zero indication why. Surface
// it once per session on the first tool response.
let _localOnlyWarned = false;
function localOnlyModeBanner() {
  if (SYNC_SERVER_URL || _localOnlyWarned) return '';
  _localOnlyWarned = true;
  return buildLocalOnlyBanner() + '\n\n';
}

// Local-only first exchange: an empty pin read gets the sample pin + the one
// setup command on EVERY empty call (not once per process), so whichever read
// tool the agent tries first ends in a visible pin and a clear next step.
const LOCAL_SAMPLE_TOOLS = new Set(['get_actionable_pins', 'get_annotations', 'get_feedback_summary']);
function maybeAttachLocalOnlySample(name, result) {
  if (SYNC_SERVER_URL || !LOCAL_SAMPLE_TOOLS.has(name)) return false;
  if (process.env.PINCUSHION_NO_ONBOARDING === '1') return false;
  if (!isEmptyPinRead(result)) return false;
  // A filtered read can be empty in a workspace that has pins; only a truly
  // empty workspace gets the sample.
  try {
    const pinsData = readLocalPins(FEEDBACK_DIR);
    if (pinsData.open.length || pinsData.resolved.length) return false;
  } catch {
    return false;
  }
  result.localOnlySample = buildLocalOnlySample();
  return true;
}

// Loud, recurring warning when a key IS configured but the cloud rejected it
// (401/403). Without this, a stale/expired/rotated key fails silently: the sync
// loop only logs to stderr (which the IDE host hides) and tools keep "working"
// locally, so the user has no idea cloud sync, share reports, and team features
// are off until a cloud-only action hard-fails. Shown on every tool response
// while the key is rejected (self-clears on the next successful sync), because a
// one-time notice is exactly what got missed.
// Names the exact source that supplied the rejected key (env / --license-key
// arg / .feedback/.license-key / ~/.pincushion/license-key) plus its last 4
// chars — a stale explicit source silently overriding a fresh login key is
// the recurring outage this diagnoses. Never prints a full key.
function invalidLicenseBanner() {
  if (!cloudLicenseRejected) return '';
  return buildRejectedLicenseBanner(cloudLicenseRejectedInfo || {});
}

// One-shot first-run nudge toward the quickstart demo. Gated on a true cold start
// (zero existing findings, set at boot) so projects with work never see it, and on the
// same PINCUSHION_NO_ONBOARDING flag CI/agent-loop already use to stay quiet.
let _firstRunNoPins = false;
let _quickstartOffered = false;
function quickstartOfferBanner() {
  if (!_firstRunNoPins || _quickstartOffered) return '';
  if (process.env.PINCUSHION_NO_ONBOARDING === '1') return '';
  _quickstartOffered = true;
  return '👋 ' + buildQuickstartInvitation() + '\n\n';
}

// Move C — second-human / first-pin nudge (spec: exec-loop decisions
// 2026-06-23). The funnel data proved installers boot AND configure fine, then
// stall completely at the first human pin (9 configures → 0 pins, 7d). So the
// configured-but-zero-pins state answers read-tool calls with one additive
// field pointing at the single next step: mint a share-report so a second
// human drops pin #1. Additive only (never blocks or reshapes the result),
// once per server process, silent for CI/agent-loop and activated projects.
let _secondHumanNudged = false;
let _discoveredProjectName = null;
function maybeAttachFirstPinNudge(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  if (_secondHumanNudged) return result;
  if (process.env.PINCUSHION_NO_ONBOARDING === '1') return result;
  if (!currentProjectIds.size) return result; // not configured — the startup on-ramp owns that state
  try {
    const pinsData = readLocalPins(FEEDBACK_DIR);
    if (countProjectFindings(pinsData, currentProjectIds) > 0) return result; // existing finding owns the next action
  } catch {
    return result;
  }
  _secondHumanNudged = true;
  result.firstPinNudge = buildSecondHumanNudge({ projectName: _discoveredProjectName });
  return result;
}

function drainNotifications(projectFilter = resolveProjectFilter()) {
  if (pendingNotifications.length === 0) return '';

  const notes = [];
  const remaining = [];
  for (const notification of pendingNotifications) {
    if (matchesProjectFilter(notification.projectId || null, projectFilter)) notes.push(notification);
    else remaining.push(notification);
  }
  pendingNotifications = remaining;
  if (notes.length === 0) return '';

  const approvals = notes.filter(n => n.type === 'pin_approved');
  const other = notes.filter(n => n.type !== 'pin_approved');

  const lines = [`\n⚡ PINCUSHION — ACTION REQUIRED ⚡`];

  if (approvals.length > 0) {
    lines.push(`\n${approvals.length} APPROVED PIN(S) WAITING FOR IMPLEMENTATION:`);
    for (const n of approvals) {
      lines.push(`  • "${n.comment || 'No comment'}" on ${n.pageTitle} (pin: ${n.pinId})`);
      lines.push(`    Approved by: ${n.approvedBy} | Branch: ${n.suggestedBranch}`);
    }
    lines.push(`\n→ Call implement_approved_pins now to get full context and start implementing.`);
    lines.push(`→ Workflow: implement_approved_pins → claim_pin → make changes → fix_and_resolve`);
  }

  if (other.length > 0) {
    lines.push('');
    for (const n of other) lines.push(`  ℹ ${n.message}`);
  }

  lines.push('');
  return lines.join('\n');
}

// ─── Live PINS.md — auto-refresh on sync and annotation changes ────────────

async function fenceGeneratedPinArtifacts(error) {
  if (!SYNC_SERVER_URL) return;
  const generatedAt = new Date().toISOString();
  const status = Number(error?.status) || 0;
  const reason = error?.reason || 'network_error';
  const message = 'Authoritative Pincushion sync is unavailable. Cached pins are intentionally withheld until the cloud can be verified.';
  const emptyPins = {
    generatedAt,
    authority: { status: 'unavailable', reason, httpStatus: status, message },
    summary: { totalOpen: 0, totalResolved: 0, totalDismissed: 0, totalApproved: 0 },
    open: [],
    resolved: [],
    terminal: [],
    selections: [],
  };
  if (!existsSync(FEEDBACK_DIR)) mkdirSync(FEEDBACK_DIR, { recursive: true });
  const unavailableDashboardPath = join(FEEDBACK_DIR, 'dashboard.html');
  await Promise.all([
    writeFile(join(FEEDBACK_DIR, 'PINS.md'), `# Pincushion Feedback\n\n> ${message}\n`, 'utf8'),
    writeFile(join(FEEDBACK_DIR, 'pins.json'), JSON.stringify(emptyPins, null, 2), 'utf8'),
    writeFile(unavailableDashboardPath, `<!doctype html><title>Pincushion feedback unavailable</title><main><h1>Pincushion feedback unavailable</h1><p>${message}</p></main>\n`, { encoding: 'utf8', mode: 0o600 }),
    writeFile(PENDING_APPROVALS_PATH, JSON.stringify({ approvedPins: [], updatedAt: generatedAt, authority: emptyPins.authority }, null, 2), 'utf8'),
  ]);
  chmodSync(unavailableDashboardPath, 0o600);
  pendingNotifications = pendingNotifications.filter((notification) => notification.type !== 'pin_approved');
}

let pinsRefreshCoordinator = null;

function getPinsRefreshCoordinator() {
  if (pinsRefreshCoordinator) return pinsRefreshCoordinator;
  pinsRefreshCoordinator = createPinsRefreshCoordinator({
    // This is the only authoritative fetch in a generated-artifact cycle.
    // Each core writer below receives the same completed snapshot callback.
    fetchSnapshot: () => core.readAllAnnotations(
      coreConfig,
      SYNC_SERVER_URL ? fetchRemoteAnnotations : null,
    ),
    artifactWriters: [
      (readSnapshot) => core.writePinsFile(coreConfig, readSnapshot),
      (readSnapshot) => core.writePinsJson(coreConfig, readSnapshot),
      (readSnapshot) => core.writeDashboardHtml(
        coreConfig,
        readSnapshot,
        BRIDGE_PORT,
        localTransportSecurity?.dashboardCapability || '',
      ),
    ],
    onFailure: async (error) => {
      console.error('[pins-file] Failed to refresh:', error.message);
      if (error?.code !== 'authoritative_sync_unavailable') return;
      try {
        await fenceGeneratedPinArtifacts(error);
        console.error('[pins-file] Withheld stale generated pin artifacts until authoritative sync recovers.');
      } catch (fenceError) {
        console.error('[pins-file] Failed to fence stale generated artifacts:', fenceError.message);
      }
    },
  });
  return pinsRefreshCoordinator;
}

async function refreshPinsFile({ background = false } = {}) {
  try {
    if (background && !await backgroundRefreshLease.ensureLeader()) {
      return { status: 'follower' };
    }
    const refresh = await getPinsRefreshCoordinator().refresh();
    if (refresh.status !== 'refreshed') return refresh;
    const [mdPath] = refresh.artifacts;
    console.error(`[pins-file] Updated ${mdPath}`);

    // ── Rebuild approved queue directly from pins.json ───────────────────
    // pins.json was just written with the latest data. Read it back and
    // extract approved pins. This is dead simple — no separate reconciliation
    // function, no race conditions, no missed transitions.
    try {
      const pinsPath = join(FEEDBACK_DIR, 'pins.json');
      const pinsRaw = await readFile(pinsPath, 'utf8');
      const pinsData = JSON.parse(pinsRaw);
      const allPins = [...(pinsData.open || []), ...(pinsData.resolved || []), ...(pinsData.terminal || [])];
      const projectFilter = resolveProjectFilter();
      const statusCounts = {};
      for (const p of allPins) { statusCounts[p.status] = (statusCounts[p.status] || 0) + 1; }
      console.error(`[trigger] pins.json has ${allPins.length} total pins. Statuses: ${JSON.stringify(statusCounts)}`);

      const getBranchName = await loadGitModule();
      const approvedPins = allPins
        .filter(p => !core.isTerminalStatus(p.status) && core.isReadyStatus(p.status))
        .filter(p => matchesProjectFilter(p.projectId || null, projectFilter))
        .map(p => ({
          type: 'pin_approved',
          pinId: p.id,
          status: p.status,
          pageTitle: p.pageTitle || p.pageUrl || 'Unknown',
          pageUrl: p.pageUrl || '',
          projectId: p.projectId || null,
          approvedBy: p.approvedBy || 'someone',
          comment: (p.comment || p.thread?.[0]?.body || '').slice(0, 200),
          element: p.element ? {
            selector: p.element.selector || null,
            tagName: p.element.tagName || null,
            textContent: (p.element.textContent || '').slice(0, 120),
          } : null,
          thread: (p.thread || []).filter(m => m.type !== 'status-note').map(m => ({
            author: m.author,
            body: (m.body || '').slice(0, 200),
          })),
          suggestedBranch: getBranchName(p.pageTitle, p.pageUrl || ''),
          timestamp: p.approvedAt || new Date().toISOString(),
          message: `Pin approved on "${p.pageTitle || p.pageUrl}" by ${p.approvedBy || 'someone'}`,
        }));
      const approvedPinIds = new Set(approvedPins.map(p => p.pinId));
      pendingNotifications = pendingNotifications.filter(n =>
        n.type !== 'pin_approved' ||
        !matchesProjectFilter(n.projectId || null, projectFilter) ||
        approvedPinIds.has(n.pinId)
      );

      // Write trigger file (even if empty — clears stale entries)
      if (!existsSync(FEEDBACK_DIR)) mkdirSync(FEEDBACK_DIR, { recursive: true });
      const queue = { approvedPins, updatedAt: new Date().toISOString() };
      await writeFile(PENDING_APPROVALS_PATH, JSON.stringify(queue, null, 2));

      if (approvedPins.length > 0) {
        console.error(`[trigger] ${approvedPins.length} approved pin(s) written to pending-approvals.json`);

        // Queue in-memory notifications for any new approved pins
        for (const pin of approvedPins) {
          if (!pendingNotifications.some(n => n.pinId === pin.pinId)) {
            pendingNotifications.push({
              ...pin,
              message: `New pin approved on "${pin.pageTitle}" by ${pin.approvedBy}. Suggested branch: ${pin.suggestedBranch}`,
            });
          }
        }

        // Fire MCP resource + message notifications (only once transport is connected)
        if (mcpConnected) {
          try { server.sendResourceUpdated({ uri: 'pincushion://approved-queue' }); } catch { /* notification is best-effort; clients re-poll the resource regardless */ }
          try {
            server.notification({
              method: 'notifications/message',
              params: {
                level: 'warning',
                message: `⚡ Pincushion: ${approvedPins.length} pin(s) approved and waiting for implementation. Call implement_approved_pins to start.`,
              },
            });
          } catch {}
        }
      }
    } catch (triggerErr) {
      console.error(`[trigger] Failed to rebuild approved queue: ${triggerErr.message}`);
    }
    return refresh;
  } catch (e) {
    console.error('[pins-file] Failed to coordinate refresh:', e.message);
    return { status: 'failed', error: e };
  }
}

const BRIDGE_PORT = boundedInteger(argValue('--bridge-port') || '3456', 3456, { min: 0, max: 65535 });
const LOCAL_HTTP_BODY_LIMIT_BYTES = boundedInteger(
  process.env.PINCUSHION_LOCAL_HTTP_BODY_LIMIT_BYTES,
  256 * 1024,
  { min: 1024, max: 4 * 1024 * 1024 },
);
const LOCAL_HTTP_REQUEST_TIMEOUT_MS = boundedInteger(
  process.env.PINCUSHION_LOCAL_HTTP_REQUEST_TIMEOUT_MS,
  10_000,
  { min: 25, max: 60_000 },
);
const LOCAL_HTTP_HEADER_TIMEOUT_MS = boundedInteger(
  process.env.PINCUSHION_LOCAL_HTTP_HEADER_TIMEOUT_MS,
  15_000,
  { min: 1_000, max: 30_000 },
);
// Node's requestTimeout covers header and body receipt. Keep it wider than
// both independent receive windows, with slack for a header that arrives just
// before its own deadline. It deliberately does not govern authenticated tool
// execution after the body has been read.
const LOCAL_HTTP_RECEIVE_TIMEOUT_MS = Math.max(
  90_000,
  LOCAL_HTTP_HEADER_TIMEOUT_MS + LOCAL_HTTP_REQUEST_TIMEOUT_MS + 5_000,
);
const LOCAL_HTTP_TOOL_EXECUTION_TIMEOUT_MS = boundedInteger(
  process.env.PINCUSHION_LOCAL_HTTP_TOOL_TIMEOUT_MS,
  5 * 60_000,
  { min: 30_000, max: 15 * 60_000 },
);

// The MCP resolves its own cloud credential for every grant verification.
// Local callers supply only a short-lived opaque, exactly scoped grant.
const verifyCloudBridgeGrant = createCloudBridgeGrantVerifier({
  functionsBase: SUPABASE_BASE,
  getLicenseKey: resolveCloudSyncKey,
});

let localTransportSecurity = null;
try {
  localTransportSecurity = await createLocalTransportSecurity({
    bodyLimitBytes: LOCAL_HTTP_BODY_LIMIT_BYTES,
    requestTimeoutMs: LOCAL_HTTP_REQUEST_TIMEOUT_MS,
    verifyCloudBridgeGrant,
  });
  console.error(`[local-transport] Process capability file: ${localTransportSecurity.capabilityFile}`);
  console.error(`[local-transport] Receive deadlines: headers ${LOCAL_HTTP_HEADER_TIMEOUT_MS}ms, request ${LOCAL_HTTP_RECEIVE_TIMEOUT_MS}ms; REST tool response ${LOCAL_HTTP_TOOL_EXECUTION_TIMEOUT_MS}ms.`);
} catch (error) {
  // A local bridge outage must not stop stdio MCP or cloud synchronization.
  // REST mode below fails closed instead of starting an unauthenticated server.
  console.error(`[local-transport] Secure local HTTP is unavailable: ${error?.message || 'initialization failed'}`);
}

// ─── Auto-discover & register project URLs on startup ──────────────────────
// Scans PROJECT_DIR for package.json, .env, vercel config, etc. and
// auto-registers the project + URLs so the Chrome extension activates
// on matching pages without any manual setup.
async function awaitCloudAuthForDiscovery() {
  if (cloudAuthState === 'unknown') {
    await Promise.race([
      cloudAuthReady,
      new Promise((resolve) => setTimeout(() => resolve('timeout'), 1500)),
    ]);
  }
  return cloudAuthState;
}

async function reconcileStartupProjectIdentity(discovered) {
  const registry = await core.readProjectRegistry({ feedbackDir: FEEDBACK_DIR });
  // Hydration intentionally preserves inaccessible rows as cached recovery
  // evidence. They must not, however, take part in URL-based reconciliation:
  // only IDs present in this authenticated cloud snapshot are candidates for a
  // live URL match.
  const authenticatedCloudProjects = Object.fromEntries(
    Object.entries(registry.projects).filter(([id]) => cloudAuthoritativeProjectIds.has(id)),
  );
  // A local registry/cache may retain a project row after access has changed.
  // An exact ID is safe to reuse only when the authenticated cloud snapshot
  // includes that same immutable ID. This applies both to an explicit
  // --project-id and to project IDs found on cached pins. Neither local record
  // is authorization, and neither can cause a replacement project to be
  // inferred when it is absent from cloud.
  const cachedEvidenceIds = new Set(STARTUP_CACHED_PROJECT_EVIDENCE);
  const accessiblePinEvidenceIds = new Set(
    [...cachedEvidenceIds].filter((id) => cloudAuthoritativeProjectIds.has(id)),
  );
  const inaccessiblePinEvidenceIds = new Set(
    [...cachedEvidenceIds].filter((id) => !cloudAuthoritativeProjectIds.has(id)),
  );
  const defaultProjectIsAccessible = !DEFAULT_PROJECT_ID || cloudAuthoritativeProjectIds.has(DEFAULT_PROJECT_ID);
  const exactProjectId = defaultProjectIsAccessible
    ? (DEFAULT_PROJECT_ID || (accessiblePinEvidenceIds.size === 1 ? [...accessiblePinEvidenceIds][0] : null))
    : null;
  const unavailableEvidenceIds = new Set([
    ...(defaultProjectIsAccessible || !DEFAULT_PROJECT_ID ? [] : [DEFAULT_PROJECT_ID]),
    ...inaccessiblePinEvidenceIds,
  ]);
  const identity = registry.malformed || accessiblePinEvidenceIds.size > 1
    ? { status: 'ambiguous', projectId: null, candidates: [...accessiblePinEvidenceIds].sort() }
    : unavailableEvidenceIds.size
      // A verified cloud snapshot that omits a cached/default ID is a recovery
      // condition, not permission to bind a same-named or same-URL replacement.
      // Keep the cache/pins untouched and make the condition visible through
      // get_project_context diagnostics.
      ? { status: 'cloud_absent', projectId: null, candidates: [...unavailableEvidenceIds].sort() }
      : core.resolveProjectIdentity({
        projects: authenticatedCloudProjects,
        // Cached pins are recovery evidence only after the authenticated cloud
        // registry proves that exact immutable ID is accessible.
        projectId: exactProjectId,
        urls: discovered.urls,
      });
  if (identity.status === 'ambiguous') {
    console.error(`[auto-discover] URL identity is ambiguous (${identity.candidates.join(', ')}); no project was created or mutated.`);
  } else if (identity.status === 'exact_id' || identity.status === 'matched') {
    currentProjectIds.add(identity.projectId);
    console.error(`[auto-discover] Reusing project ID ${identity.projectId} (${identity.status}); no name-based ownership inference.`);
  } else if (identity.status === 'none') {
    if (!AUTO_REGISTER_PROJECT_ON_STARTUP) {
      console.error('[auto-discover] Skipped unmatched startup project registration because --no-auto-register-project is set; use configure_project to register explicitly.');
    } else {
      // New projects are written only after the authenticated cloud PUT
      // succeeds. An inferred display name is never used to claim an existing
      // project.
      const configured = await toolConfigureProject({
        name: discovered.name,
        urls: discovered.urls,
        deferLocalWriteUntilCloudAck: true,
      });
      if (configured.cloudSync === 'synced' && configured.projectId) currentProjectIds.add(configured.projectId);
      console.error(`[auto-discover] Project registration ${configured.cloudSync === 'synced' ? 'acknowledged' : 'not acknowledged'} for ${configured.projectId || 'unknown ID'}`);
    }
  } else if (identity.status === 'cloud_absent') {
    console.error(`[auto-discover] Cached/default project ID is not accessible in the authenticated cloud registry (${identity.candidates.join(', ')}); cached pins remain read-only and no replacement was created.`);
  } else {
    console.error(`[auto-discover] Project identity unresolved (${identity.status}); no project was created or mutated.`);
  }

  console.error(`[auto-discover] Project IDs for this workspace: ${[...currentProjectIds].join(', ') || 'none'}`);
  return identity;
}

async function runRequestedProjectIdentityReconciliation() {
  if (!projectIdentityReconciliationRequested ||
      cloudAuthState !== 'authenticated' ||
      !cloudProjectRegistryAuthoritative ||
      !startupDiscoveredProject?.urls?.length) {
    return null;
  }
  if (projectIdentityReconciliationInFlight) return projectIdentityReconciliationInFlight;

  projectIdentityReconciliationRequested = false;
  const reconciliation = (async () => {
    try {
      return await reconcileStartupProjectIdentity(startupDiscoveredProject);
    } catch (error) {
      console.error('[auto-discover] Identity reconciliation failed (non-fatal):', error.message);
      return null;
    }
  })();
  projectIdentityReconciliationInFlight = reconciliation;
  try {
    return await reconciliation;
  } finally {
    projectIdentityReconciliationInFlight = null;
    // A credential can recover while a prior reconciliation is still running.
    // Consume that later authenticated transition serially rather than issuing
    // overlapping URL matches or registration PUTs.
    if (projectIdentityReconciliationRequested &&
        cloudAuthState === 'authenticated' &&
        cloudProjectRegistryAuthoritative) {
      void runRequestedProjectIdentityReconciliation();
    }
  }
}

async function requestProjectIdentityReconciliation({ retryAfterCurrent = false } = {}) {
  if (cloudAuthState !== 'authenticated' || !cloudProjectRegistryAuthoritative) return null;
  if (projectIdentityReconciliationInFlight) {
    if (retryAfterCurrent) projectIdentityReconciliationRequested = true;
    return projectIdentityReconciliationInFlight;
  }
  projectIdentityReconciliationRequested = true;
  return runRequestedProjectIdentityReconciliation();
}

// The MCP host's clientInfo.name for the boot event. `server` is declared later
// in this module, so the lookup is guarded: before the binding exists it reads
// as 'unknown' instead of throwing. The boot event waits (bounded) for the
// initialize handshake, which is what carries clientInfo.
// --rest has no handshake, so it never waits. gracefulExit releases the wait
// and awaits `bootEventQueued` so a session shorter than the wait still sends it.
let resolveBootClientReady;
const bootClientReady = new Promise((resolve) => { resolveBootClientReady = resolve; });
if (REST_MODE) resolveBootClientReady();
const BOOT_CLIENT_WAIT_MS = 5000;
let bootEventQueued = null;

// Exactly one `mcp boot` per process. Unauthenticated boots carry the persisted
// install ID as distinct_id; authenticated ones the hashed license id, with the
// install ID as a property so earlier anonymous boots can be joined to it. No
// client-side alias here: `pincushion login` merges both into the email person.
function captureBootEvent({ nonBotPinCount, client, extra = {} }) {
  try {
    const bootKey = resolveCloudSyncKey();
    captureEvent(
      getDistinctId(),
      'mcp boot',
      {
        ...buildBootEventProps({
          version: PKG_VERSION,
          nonBotPinCount,
          cloudActive: !!bootKey,
          ...detectCi(),
          client,
        }),
        installId: getInstallId(),
        ...(INSTALL_REF ? { installRef: INSTALL_REF } : {}),
        ...extra,
      },
    );
  } catch (bootErr) {
    console.error('[startup] boot event skipped (non-fatal):', bootErr.message);
  }
}

// gracefulExit before discovery reached the boot capture (a host or CI probe
// that disconnects within the first second or two): send the boot now from an
// unscoped local pin count, flagged so it can be told apart.
function queueBootEventBeforeExit() {
  resolveBootClientReady();
  if (bootEventQueued) return bootEventQueued;
  let nonBotPinCount = 0;
  try { nonBotPinCount = countNonBotPins(readLocalPins(FEEDBACK_DIR), null); } catch { /* firstRun stays true */ }
  captureBootEvent({ nonBotPinCount, client: bootMcpClientName(), extra: { bootBeforeDiscovery: true } });
  bootEventQueued = Promise.resolve();
  return bootEventQueued;
}
function bootMcpClientName() {
  try {
    return normalizeClientName(server.getClientVersion()?.name);
  } catch {
    return normalizeClientName(null);
  }
}
async function waitForBootClientName() {
  let timer;
  try {
    await Promise.race([
      bootClientReady,
      new Promise((resolve) => { timer = setTimeout(resolve, BOOT_CLIENT_WAIT_MS); timer.unref?.(); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  return bootMcpClientName();
}

const projectAutoDiscovery = (async () => {
  try {
    const discovered = await core.discoverProjectConfig(PROJECT_DIR);
    if (discovered.urls.length) {
      console.error(`[auto-discover] Project: "${discovered.name}" — URLs: ${discovered.urls.join(', ')}`);
      _discoveredProjectName = discovered.name || null;
      startupDiscoveredProject = discovered;
      const auth = await awaitCloudAuthForDiscovery();
      if (auth !== 'authenticated' || !cloudProjectRegistryAuthoritative) {
        // Discovery remains read-only until a successful authenticated pull.
        // In particular, a rejected or unavailable key can never trigger a
        // project PUT or create a guessed local ID.
        const reason = auth !== 'authenticated' ? `cloud auth is ${auth}` : 'the cloud project registry is not authoritative';
        console.error(`[auto-discover] Skipped project registration while ${reason}; refresh authentication/project access, then retry configure_project.`);
        console.error(`[auto-discover] Project IDs for this workspace: ${[...currentProjectIds].join(', ') || 'none'}`);
      } else if (backgroundSyncRegistrationKey === cloudAuthKey) {
        await requestProjectIdentityReconciliation();
      } else {
        console.error('[auto-discover] Read-only project authentication deferred startup registration until background sync.');
      }
    } else {
      console.error('[auto-discover] No URLs detected — run configure_project manually.');
    }

    // Read local pins ONCE for both the on-ramp gate and the boot event's
    // firstRun property — no second Supabase query, no second file read.
    const projectScope = currentProjectIds.size ? currentProjectIds : null;
    let nonBotPinCount = 0;
    try {
      const pinsData = readLocalPins(FEEDBACK_DIR);
      nonBotPinCount = countNonBotPins(pinsData, projectScope);
      _firstRunNoPins = countProjectFindings(pinsData, projectScope) === 0;

      // First-run on-ramp — print the first-pin walkthrough when the active
      // project(s) have zero AI or human findings. Gated behind the no-pins
      // check (never fires once activated) and PINCUSHION_NO_ONBOARDING (so CI
      // and the agent-loop stay quiet). Read-only: prints to stderr, never
      // writes a sample pin to Supabase or .feedback/.
      maybePrintOnboarding(FEEDBACK_DIR, projectScope, { pinsData, cloudSignedIn: Boolean(resolveCloudSyncKey()) });
    } catch (onrampErr) {
      console.error('[startup] On-ramp skipped (non-fatal):', onrampErr.message);
    }

    // Fire the once-per-startup `mcp boot` event. This is the missing first
    // measurement in the activation funnel: npm shows hundreds of installs/wk
    // but every existing PostHog event fires inside a tool handler, so we can't
    // see the install→configure→first-pin collapse. `mcp boot` fires on EVERY
    // boot (firstRun distinguishes not-yet-activated installers from returning
    // ones). Fire-and-forget: captureEvent no-ops without POSTHOG_API_KEY and
    // never awaits/blocks the handshake.
    // The capture waits (detached, bounded) for the host's clientInfo. Skipped
    // if gracefulExit already sent the boot.
    if (!bootEventQueued) {
      bootEventQueued = (async () => {
        const client = await waitForBootClientName();
        captureBootEvent({ nonBotPinCount, client });
      })();
    }
  } catch (e) {
    console.error('[auto-discover] Failed (non-fatal):', e.message);
  }
})();

// Pro-only tools that require a valid Pro/Team license.
// Note: get_actionable_pins, claim_pin, fix_and_resolve are FREE — core agent loop tools.
// Pro gates team/sync features only. create_invite_link is deliberately absent:
// commenters are free on every plan (PRICING.md) and the Free-tier referral
// bonus is earned through it. create-invite enforces roles and editor seats.
const PRO_TOOLS = new Set([
  'add_member',
  'remove_member',
  'list_members'
]);

// METERED_TOOLS consume the free tier's monthly AI-action pool (25/mo). This
// pre-flight is pure UX — agents get a clean upgrade message before doing
// local work; the authoritative gate is server-side in sync-annotations (or
// the dedicated QA importer), which 402s the metered write itself. Manual pin tools (claim_pin,
// fix_and_resolve, add_agent_reply, share reports, …) are never metered.
const METERED_TOOLS = new Set([
  'assign_pin_to_agent',
  'add_bot_reply',
  'create_critique_pin',
  'create_agent_pin',
  'record_pin_verification',
]);

function requireQuota(toolName) {
  return requireQuotaDecision({ toolName, plan: cloudSyncPlan, usage: cloudSyncUsage });
}

// PRO_SOFT_TOOLS return a partial response on Free (e.g. sample size only,
// with `planRequired` + `upgradeUrl` hints) rather than a hard 402 gate.
// The MCP handler dispatches normally; the tool implementation itself
// degrades the response when the caller is Free. This lets agents surface
// "Pincushion AI ran but didn't generate the metric on your plan" instead
// of failing the call.
const PRO_SOFT_TOOLS = new Set([
  'get_time_to_fix_metrics',
]);

// Returns true when the current cloudSyncPlan is on Pro or Team. Used by
// PRO_SOFT_TOOLS to decide whether to compute the full payload.
function isProOrTeam() {
  return cloudSyncPlan === 'pro' || cloudSyncPlan === 'team';
}

// Pro gate (F-02 fix): decide off the SERVER-VALIDATED plan cached from sync
// responses (`cloudSyncPlan`), not off whether a key flag happened to be
// passed. Known 'free' → deny with the plan named; pro/team → allow; plan
// unknown (no successful sync yet) → stay lenient when ANY key source is
// configured (env, --license-key, project file, OR home file — the old check
// missed the file sources) so offline use doesn't break; deny fast only when
// no key exists anywhere. Decision logic lives in lib/license.js (unit-tested).
function requirePro(toolName) {
  return requireProDecision({
    toolName,
    plan: cloudSyncPlan,
    hasLicenseKey: !!resolveCloudSyncKey(),
  });
}

// ─── Sync Server (Supabase) ───────────────────────────────────────────────────

// Tracks the most recent cloud sync failure (Supabase 402 quota, 5xx, network
// drop, etc.) so tool responses can surface "cloud unreachable" instead of
// silently degrading to "no pins."
let lastCloudSyncError = null;

// MCP_READ_RECEIPT_HELPERS_START
const MCP_READ_RECEIPT_BATCH_SIZE = 200;

export function collectMcpReadReceiptIds(tool, result) {
  let pins = [];
  if (tool === 'get_actionable_pins') {
    pins = Array.isArray(result?.pins) ? result.pins : [];
  } else if (tool === 'implement_approved_pins') {
    // `pages` is a compatibility alias for the exact same packets. Reading
    // both would double-report every pin, so only the canonical field counts.
    pins = (Array.isArray(result?.packets) ? result.packets : [])
      .flatMap(packet => Array.isArray(packet?.pins) ? packet.pins : []);
  }
  return [...new Set(
    pins
      .map(pin => typeof pin?.id === 'string' ? pin.id.trim() : '')
      .filter(Boolean)
  )];
}

export async function postMcpReadReceipt({
  syncServerUrl,
  licenseKey,
  pkgVersion,
  tool,
  annotationIds,
  fetchImpl = fetch,
  logger = message => console.error(message),
}) {
  const ids = [...new Set(
    (Array.isArray(annotationIds) ? annotationIds : [])
      .filter(id => typeof id === 'string')
      .map(id => id.trim())
      .filter(Boolean)
  )];
  if (ids.length === 0) return { ok: true, skipped: 'empty', accepted: 0 };
  if (!syncServerUrl || !licenseKey) {
    return { ok: true, skipped: 'not_configured', accepted: 0 };
  }

  let accepted = 0;
  let lastStatus = 200;
  try {
    const receiptUrl = new URL(syncServerUrl);
    receiptUrl.searchParams.set('action', 'record_mcp_reads');
    for (let offset = 0; offset < ids.length; offset += MCP_READ_RECEIPT_BATCH_SIZE) {
      const batch = ids.slice(offset, offset + MCP_READ_RECEIPT_BATCH_SIZE);
      const response = await fetchImpl(receiptUrl.toString(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Pincushion-Client': `mcp/${pkgVersion}`,
          'x-license-key': licenseKey,
        },
        body: JSON.stringify({ tool, annotationIds: batch }),
        redirect: 'error',
        signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) {
        logger(`[mcp-read-receipt] ${tool} receipt failed; activation measurement DEGRADED (HTTP ${response.status}).`);
        return { ok: false, accepted, status: response.status };
      }
      const responseBody = await response.json().catch(() => null);
      const serverAccepted = responseBody?.accepted;
      // A successful transport is not an acknowledgement of durable writes.
      // Do not coerce strings/null or infer success from an absent JSON body.
      if (responseBody?.ok !== true || !Number.isInteger(serverAccepted) ||
          serverAccepted < 0 || serverAccepted > batch.length) {
        logger(`[mcp-read-receipt] ${tool} receipt failed; activation measurement DEGRADED (invalid acknowledgement).`);
        return { ok: false, accepted, status: response.status, reason: 'invalid_acknowledgement' };
      }
      accepted += serverAccepted;
      lastStatus = response.status;
    }
    // Each batch can be syntactically valid while still acknowledging only a
    // subset of the exact de-duplicated IDs we supplied. Durable activation
    // measurement requires a complete acknowledgement across the whole
    // request, not merely a successful HTTP response or a valid count.
    if (accepted !== ids.length) {
      logger(`[mcp-read-receipt] ${tool} receipt failed; activation measurement DEGRADED (partial acknowledgement).`);
      return { ok: false, accepted, status: lastStatus, reason: 'partial_acknowledgement' };
    }
    return { ok: true, accepted };
  } catch {
    logger(`[mcp-read-receipt] ${tool} receipt failed; activation measurement DEGRADED (network error).`);
    return { ok: false, accepted, status: 0 };
  }
}

export function attachMcpReadReceiptMeasurement(result, receipt) {
  if (receipt?.ok !== false) return result;
  const current = result?.measurement && typeof result.measurement === 'object'
    ? result.measurement
    : {};
  return {
    ...result,
    measurement: {
      ...current,
      mcp_read_receipt: {
        status: 'DEGRADED',
        reason: 'exact_pin_read_receipt_not_recorded',
      },
    },
  };
}
// MCP_READ_RECEIPT_HELPERS_END

async function recordJourneyAction(action, annotationId) {
  try {
    const annotation = await core.findAnnotationById(coreConfig, annotationId);
    return recordOnboardingReceipt({ action, annotationId, projectId: annotation?.projectId,
      syncServerUrl: SYNC_SERVER_URL, licenseKey: resolveCloudSyncKey() || SYNC_API_KEY });
  } catch { return { ok: false, reason: 'project_unavailable' }; }
}

async function recordJourneyReads(result, tool) {
  const receipt = await postMcpReadReceipt({
    syncServerUrl: SYNC_SERVER_URL,
    licenseKey: resolveCloudSyncKey() || SYNC_API_KEY,
    pkgVersion: PKG_VERSION,
    tool,
    annotationIds: returnedPinIds(result),
  });
  return attachMcpReadReceiptMeasurement(result, receipt);
}

async function recordMcpReadReceipt(tool, result) {
  const annotationIds = collectMcpReadReceiptIds(tool, result);
  if (annotationIds.length === 0) {
    return { ok: true, skipped: 'empty', accepted: 0 };
  }
  return postMcpReadReceipt({
    syncServerUrl: SYNC_SERVER_URL,
    licenseKey: resolveCloudSyncKey() || SYNC_API_KEY,
    pkgVersion: PKG_VERSION,
    tool,
    annotationIds,
  });
}

function authoritativeReadError({ status = 0, reason = 'network_error', detail = '' } = {}) {
  const error = new Error('Authoritative Pincushion sync is unavailable; cached implementation pins are intentionally withheld.');
  error.code = 'authoritative_sync_unavailable';
  error.status = status;
  error.reason = reason;
  error.detail = detail;
  return error;
}

// These are the only annotation lifecycle values the sync endpoint can
// authoritatively return. Keep the two historic aliases so a client can read
// through a rolling migration, but normalize them before any MCP tool sees the
// row. Crucially, an absent or unknown status is malformed authority, never an
// invitation to invent the default `open` state.
const AUTHORITATIVE_ANNOTATION_STATUSES = new Map([
  ['open', 'open'],
  ['ready', 'ready'],
  ['approved', 'ready'],
  ['in-progress', 'in-progress'],
  ['implemented', 'implemented'],
  ['resolved', 'resolved'],
  ['archived', 'archived'],
  ['declined', 'archived'],
  ['dismissed', 'dismissed'],
]);

function authoritativeNonBlankString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function authoritativeExactString(value) {
  return typeof value === 'string' && value && value.trim() === value ? value : null;
}

function normalizeAuthoritativeAnnotationRow(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const id = authoritativeNonBlankString(row.id);
  const status = AUTHORITATIVE_ANNOTATION_STATUSES.get(authoritativeNonBlankString(row.status));
  const pageValues = ['pageUrl', 'page_url']
    .filter((key) => Object.prototype.hasOwnProperty.call(row, key))
    .map((key) => row[key]);
  const pageUrl = authoritativeExactString(pageValues[0]);
  const projectValues = ['projectId', 'project_id']
    .filter((key) => Object.prototype.hasOwnProperty.call(row, key))
    .map((key) => row[key]);
  const projectId = projectValues.length ? authoritativeExactString(projectValues[0]) : null;
  const botValues = ['isBot', 'is_bot']
    .filter((key) => Object.prototype.hasOwnProperty.call(row, key))
    .map((key) => row[key]);
  if (pageValues.some((value) => value !== pageUrl) ||
      projectValues.some((value) => value !== projectId) ||
      botValues.some((value) => typeof value !== 'boolean' || value !== botValues[0])) return null;
  // Every cloud row is an authoritative record for exactly one project. A
  // missing project identity cannot be safely scoped to the v2 cache and must
  // fail closed instead of falling through to the legacy URL-only writer.
  if (!id || !status || !pageUrl || !projectId) return null;
  try {
    const parsed = new URL(pageUrl);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) return null;
  } catch {
    return null;
  }
  return { id, status, pageUrl, projectId, isBot: botValues[0] === true };
}

function validateAuthoritativeAnnotationRows(rows) {
  const normalized = rows.map(normalizeAuthoritativeAnnotationRow);
  return normalized.every(Boolean) ? normalized : null;
}

// A read that arrives while the first authoritative bootstrap is still being
// pulled (a fresh install's first tool call, typically) waits a bounded time
// for that pull instead of failing immediately. It never serves the cache
// early: if the pull fails, is rejected or outlasts the bound, the read fails
// closed exactly as before.
const ANNOTATION_BOOTSTRAP_WAIT_MS = (() => {
  const raw = Number(process.env.PINCUSHION_BOOTSTRAP_WAIT_MS);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 60_000) : 15_000;
})();
async function awaitAnnotationBootstrap(timeoutMs = ANNOTATION_BOOTSTRAP_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (await annotationBootstrapActive(ANNOTATIONS_DIR)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0 || !SYNC_SERVER_URL || cloudLicenseRejected) return false;
    let timer;
    const outcome = await Promise.race([
      cloudSyncPull({ onlyWhileBootstrapping: true }).then(ok => (ok ? 'ok' : 'failed'), () => 'failed'),
      new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), remaining); }),
    ]).finally(() => clearTimeout(timer));
    if (outcome !== 'ok') return false;
  }
  return true;
}

async function fetchRemoteAnnotations() {
  if (!await awaitAnnotationBootstrap()) throw authoritativeReadError({ reason: 'bootstrap_pending', detail: 'Annotation recovery has not completed.' });
  if (!SYNC_SERVER_URL) return {};

  const headers = { 'Content-Type': 'application/json', 'X-Pincushion-Client': `mcp/${PKG_VERSION}` };
  // Use the same key resolution as cloud sync — checks env var, CLI arg, AND .license-key file
  const licenseKey = resolveCloudSyncKey() || SYNC_API_KEY;
  if (!licenseKey) {
    lastCloudSyncError = { status: 0, detail: 'authoritative sync credentials are unavailable', at: new Date().toISOString() };
    throw authoritativeReadError({ reason: 'missing_credentials', detail: lastCloudSyncError.detail });
  }
  headers['x-license-key'] = licenseKey;

  try {
    // Call the sync URL directly — no /api/annotations suffix needed for Supabase
    const res = await fetch(SYNC_SERVER_URL, { headers });
    if (!res.ok) {
      let detail = '';
      try {
        const errBody = await res.json();
        detail = errBody?.message || errBody?.error || JSON.stringify(errBody).slice(0, 300);
      } catch {
        try { detail = (await res.text()).slice(0, 300); } catch { /* ignore */ }
      }
      // Self-heal: fall a rejected explicit key through to the next source.
      if ((res.status === 401 || res.status === 403) && markCloudKeyRejected(licenseKey)) {
        return fetchRemoteAnnotations();
      }
      lastCloudSyncError = { status: res.status, detail, at: new Date().toISOString() };
      throw authoritativeReadError({ status: res.status, reason: `http_${res.status}`, detail });
    }
    let body;
    try {
      body = await res.json();
    } catch (error) {
      const detail = `authoritative sync returned invalid JSON: ${error?.message || 'parse failed'}`;
      lastCloudSyncError = { status: res.status, detail, at: new Date().toISOString() };
      throw authoritativeReadError({ status: res.status, reason: 'malformed_response', detail });
    }

    // Handle both flat array and { annotations: [...] } envelope (Supabase
    // returns the latter). A 2xx response without either shape is not an empty
    // project: it is malformed authority and must never reveal stale local rows.
    const list = Array.isArray(body)
      ? body
      : (body && typeof body === 'object' && Array.isArray(body.annotations))
        ? body.annotations
        : null;
    if (!list) {
      const detail = 'authoritative sync returned a 2xx response without a valid annotations array';
      lastCloudSyncError = { status: res.status, detail, at: new Date().toISOString() };
      throw authoritativeReadError({ status: res.status, reason: 'malformed_response', detail });
    }
    const canonicalRows = validateAuthoritativeAnnotationRows(list);
    if (!canonicalRows) {
      const detail = 'authoritative sync returned a 2xx response containing an invalid annotation row';
      lastCloudSyncError = { status: res.status, detail, at: new Date().toISOString() };
      throw authoritativeReadError({ status: res.status, reason: 'malformed_response', detail });
    }
    lastCloudSyncError = null;

    // Normalise snake_case fields from Supabase → camelCase expected by MCP tools
    const normalised = list.map((ann, index) => ({
      id: canonicalRows[index].id,
      pageUrl: canonicalRows[index].pageUrl,
      pageTitle: ann.pageTitle || ann.page_title || '',
      element: ann.element || {},
      pin: ann.pin || {},
      thread: ann.thread || [],
      status: canonicalRows[index].status,
      priority: ann.priority || 'medium',
      visibility: ann.visibility === 'project_members' ? 'project_members' : 'public',
      tags: ann.tags || [],
      viewport: ann.viewport || null,
      domSnippet: ann.domSnippet || ann.dom_snippet || null,
      likelyFiles: ann.likelyFiles || ann.likely_files || null,
      acceptanceCriteria: ann.acceptanceCriteria || ann.acceptance_criteria || null,
      createdAt: ann.createdAt || ann.created_at,
      updatedAt: ann.updatedAt || ann.updated_at,
      resolvedAt: ann.resolvedAt || ann.resolved_at || null,
      approvedAt: ann.approvedAt || ann.approved_at || null,
      approvedBy: ann.approvedBy || ann.approved_by || null,
      createdBy: ann.createdBy || ann.created_by || null,
      implementedAt: ann.implementedAt || ann.implemented_at || null,
      author: ann.author || null,
      authorEmail: ann.authorEmail || ann.author_email || null,
      isBot: canonicalRows[index].isBot,
      authorClass: ann.authorClass || ann.author_class || null,
      agentName: ann.agentName || ann.agent_name || null,
      action: ann.action || null,
      implementer: ann.implementer || null,
      commitSha: ann.commitSha || ann.commit_sha || null,
      branchName: ann.branchName || ann.branch_name || null,
      prUrl: ann.prUrl || ann.pr_url || null,
      deployUrl: ann.deployUrl || ann.deploy_url || null,
      deployedAt: ann.deployedAt || ann.deployed_at || null,
      verificationStatus: ann.verificationStatus || ann.verification_status || null,
      verificationNotes: ann.verificationNotes || ann.verification_notes || null,
      verifiedAt: ann.verifiedAt || ann.verified_at || null,
      dismissedAt: ann.dismissedAt || ann.dismissed_at || null,
      dismissedBy: ann.dismissedBy || ann.dismissed_by || null,
      screenshotUrl: ann.screenshotUrl || ann.screenshot_url || null,
      projectId: canonicalRows[index].projectId,
    }));

    // Preserve distinct project records even when their authoritative page URL
    // is identical. `pageUrl` remains the public display value; the map key is
    // only an internal scope discriminator.
    const byPage = {};
    for (const ann of normalised) {
      const scopeKey = annotationCacheScope({ projectId: ann.projectId, pageUrl: ann.pageUrl }).entryKey;
      if (!byPage[scopeKey]) {
        byPage[scopeKey] = {
          projectId: ann.projectId,
          pageUrl: ann.pageUrl,
          pageTitle: ann.pageTitle || ann.pageUrl,
          annotations: [],
        };
      }
      byPage[scopeKey].annotations.push(ann);
    }
    if (await annotationBootstrapActive(ANNOTATIONS_DIR)) throw authoritativeReadError({ reason: 'bootstrap_pending', detail: 'Annotation recovery has not completed.' });
    return byPage;
  } catch (err) {
    if (err?.code === 'authoritative_sync_unavailable') throw err;
    lastCloudSyncError = { status: 0, detail: err?.message || 'network error', at: new Date().toISOString() };
    throw authoritativeReadError({ reason: 'network_error', detail: lastCloudSyncError.detail });
  }
}

// A dashboard selection is a local cache. When cloud sync is configured, an
// implementation instruction needs an exact current row rather than the stale
// selected JSON or a best-effort bulk merge. Fail closed on any missing,
// malformed, unauthorized, or network response; terminal rows are the only
// ones safe to prune from the local selection file.
async function lookupCanonicalSelectedPin(annotationId) {
  const licenseKey = resolveCloudSyncKey() || SYNC_API_KEY;
  if (!SYNC_SERVER_URL || !licenseKey || !annotationId) {
    return { state: 'unavailable', reason: 'cloud_credentials_unavailable' };
  }
  let requestUrl;
  try {
    requestUrl = new URL(SYNC_SERVER_URL);
    requestUrl.searchParams.set('annotation_id', annotationId);
  } catch {
    return { state: 'unavailable', reason: 'invalid_sync_url' };
  }
  try {
    const response = await fetch(requestUrl, {
      headers: {
        Accept: 'application/json',
        'X-Pincushion-Client': `mcp/${PKG_VERSION}`,
        'x-license-key': licenseKey,
      },
    });
    if (!response.ok) return { state: 'unavailable', reason: `http_${response.status}` };
    const body = await response.json().catch(() => null);
    const rows = Array.isArray(body) ? body : Array.isArray(body?.annotations) ? body.annotations : null;
    const canonicalRows = rows && validateAuthoritativeAnnotationRows(rows);
    if (!canonicalRows) return { state: 'unavailable', reason: 'missing_or_malformed_canonical_row' };
    const matchIndex = canonicalRows.findIndex((row) => row.id === String(annotationId));
    if (matchIndex === -1 || canonicalRows.findIndex((row, index) => index !== matchIndex && row.id === String(annotationId)) !== -1) {
      return { state: 'unavailable', reason: 'missing_or_malformed_canonical_row' };
    }
    const row = rows[matchIndex];
    const canonical = canonicalRows[matchIndex];
    const annotation = {
      id: canonical.id,
      status: canonical.status,
      pageUrl: canonical.pageUrl,
      tags: row.tags || [],
      createdAt: row.createdAt || row.created_at || null,
      resolvedAt: row.resolvedAt || row.resolved_at || null,
      element: row.element || {},
      thread: Array.isArray(row.thread) ? row.thread : [],
    };
    return core.isTerminalStatus(annotation.status)
      ? { state: 'terminal', annotation }
      : { state: 'active', annotation };
  } catch {
    return { state: 'unavailable', reason: 'network_error' };
  }
}

// Decorate a tool response with cloud-error context when the response
// looks like an empty/no-pins payload AND cloud is currently failing.
// Callers that already returned data should pass through unchanged.
function withCloudError(result) {
  if (!lastCloudSyncError) return result;
  const empty =
    (typeof result.totalApproved === 'number' && result.totalApproved === 0 && (result.totalInProgress ?? 0) === 0) ||
    (typeof result.totalActionable === 'number' && result.totalActionable === 0);
  if (!empty) return result;
  const { status } = lastCloudSyncError;
  const hint = status === 402
    ? 'Supabase project is over its quota (HTTP 402). Cloud-stored pins are unreachable. Check supabase.com billing or wait for the quota window to reset.'
    : status === 0
      ? 'Could not reach the Pincushion sync endpoint (network error). Cloud-stored pins are unreachable.'
      : `Pincushion cloud sync failed with HTTP ${status}. Cloud-stored pins are unreachable.`;
  return {
    ...result,
    cloudSyncError: { status, error: status === 0 ? 'network_error' : `http_${status}`, hint },
    message: hint,
  };
}

// Create config object for core functions
const coreConfig = {
  feedbackDir: FEEDBACK_DIR,
  annotationsDir: ANNOTATIONS_DIR,
  // A configured cloud authority and the bridge both write only exact
  // project/page-scoped v2 cache records. Local-only setup remains compatible
  // with unscoped legacy files until an authoritative project identity exists.
  annotationCacheVersion: SYNC_SERVER_URL ? 2 : null,
  syncServerUrl: SYNC_SERVER_URL,
  syncApiKey: SYNC_API_KEY,
  // New-pin submissions are scoped only from the authenticated project
  // registry. The resolver does no network I/O: it consumes the same
  // hydrated, authority-filtered registry used by startup reconciliation.
  resolveSubmissionProjectScope: (scope) => resolveAuthoritativeSubmissionProjectScope(scope),
  projectIdentityProvenance: () => ({
    connection: {
      state: cloudAuthState,
      source: cloudAuthSource,
      last4: cloudAuthKey ? keyLast4(cloudAuthKey) : '????',
      reason: cloudAuthReason,
      projectRegistryAuthoritative: cloudProjectRegistryAuthoritative,
      cloudProjectIds: [...cloudAuthoritativeProjectIds],
      projectsVerifiedAt: cloudProjectsVerifiedAt,
    },
  }),
  supabaseBase: (SYNC_SERVER_URL || CLOUD_SYNC_URL).replace(/\/sync-annotations$/, ''),
  // The concrete owner-keyed lifecycle client lives in core. It talks only to
  // sync-annotations; provider calls remain behind the selected adapter and
  // require explicit auto mode plus the private receiver bootstrap.
  enableDeploymentLifecycle: true,
  createDeploymentProviderAdapter: ({
    provider,
    pincushionProjectId,
    providerProjectId,
    providerMetadata,
    receiverEndpoint,
    bindingId,
    attemptId,
    canonicalOrigins,
    mintCallerSecretProviderReadback,
    reserveCallerGeneratedCredential,
    markCallerGeneratedCredentialWriteStarted,
    recoverCallerGeneratedCredential,
    bindReservedCredential,
    captureProviderGeneratedCredential,
    finalizeProvisioning,
    markAttemptDegraded,
    markExternalCleanupRequired,
    hasUsableCredential,
    getAttemptOwnedWebhook,
    getActiveBinding,
    getCleanupDebt,
    completeExternalCleanup,
  } = {}) => {
    const admittedCallerSecretAdapter = createAdmittedCallerSecretDeploymentProviderAdapter({
      provider,
      pincushionProjectId,
      providerProjectId,
      providerMetadata,
      receiverEndpoint,
      bindingId,
      attemptId,
      canonicalOrigins,
      // These callbacks are private closures minted by core. The factory is
      // trusted host code, not a public MCP extension point.
      mintCallerSecretProviderReadback,
      reserveCallerGeneratedCredential,
      markCallerGeneratedCredentialWriteStarted,
      recoverCallerGeneratedCredential,
      bindReservedCredential,
      captureProviderGeneratedCredential,
      finalizeProvisioning,
      markAttemptDegraded,
    });
    if (admittedCallerSecretAdapter) return admittedCallerSecretAdapter;
    // The provider project ID is detected/read back metadata, not the
    // Pincushion project ID. Do not construct an adapter without both exact
    // identity and a private receiver endpoint.
    if (provider !== 'vercel' || !providerProjectId || !receiverEndpoint || !bindingId) return null;
    return createVercelDeploymentAdapter({
      endpointUrl: receiverEndpoint,
      // Provider list/delete/readback scope is intentionally separate from
      // owner lifecycle scope. The adapter uses projectId for Vercel and this
      // Pincushion ID only when calling the private lifecycle callbacks.
      pincushionProjectId,
      projectId: providerProjectId,
      orgId: providerMetadata?.orgId,
      cwd: PROJECT_DIR,
      bindingId,
      canonicalOrigins,
      captureProviderGeneratedCredential,
      finalizeProvisioning,
      markAttemptDegraded,
      markExternalCleanupRequired,
      hasUsableCredential,
      getAttemptOwnedWebhook,
      getActiveBinding,
      getCleanupDebt,
      completeExternalCleanup,
    });
  },
  pkgVersion: PKG_VERSION,
  get licenseKey() { return resolveCloudSyncKey(); },
};

function authoritativeOperationFailure(authorityOrError, empty = {}) {
  const unavailable = authorityOrError?.code === 'authoritative_sync_unavailable';
  return {
    ...empty,
    success: false,
    error: unavailable ? 'authoritative_sync_unavailable' : 'authoritative_sync_required',
    reason: authorityOrError?.reason || (unavailable ? 'network_error' : 'missing_credentials'),
    status: unavailable ? (authorityOrError.status || 0) : 0,
    message: unavailable
      ? 'Authoritative Pincushion sync is unavailable. Cached implementation pins are intentionally withheld.'
      : (authorityOrError?.message || 'An authoritative sync URL and license are required before operating on existing pins.'),
  };
}

async function withAuthoritativeExistingPinOperation(operation, empty = {}) {
  const authority = core.resolveLifecycleAuthority(coreConfig);
  if (!authority.ok) return authoritativeOperationFailure(authority, empty);
  try {
    return await operation();
  } catch (error) {
    if (error?.code === 'authoritative_sync_unavailable') {
      return authoritativeOperationFailure(error, empty);
    }
    throw error;
  }
}

async function withAuthoritativeImplementationRead(operation, empty = {}) {
  // The documented --local-only mode has no cloud project authority to mask;
  // preserve its offline read experience. Once a sync URL is configured, every
  // implementation instruction must instead come from a successful canonical
  // cloud read.
  if (!SYNC_SERVER_URL) return operation();
  return withAuthoritativeExistingPinOperation(operation, empty);
}

// Refresh PINS.md on startup (now that coreConfig is defined), then every 60s.
// This is background maintenance, so only the workspace's elected lease holder
// performs the authoritative read and writes shared generated artifacts.
refreshPinsFile({ background: true });
setInterval(() => { refreshPinsFile({ background: true }); }, 60_000);

// Reconcile approved queue on startup — catches pins approved while server was down
setTimeout(async () => {
  if (await backgroundRefreshLease.ensureLeader()) {
    reconcileApprovedQueue({ localOnly: true }).catch(() => {});
  }
}, 3000);

// Merge local files + remote Supabase data.
// Remote wins on a per-annotation basis (newer updatedAt takes precedence).
async function readAllAnnotations() {
  if (!await awaitAnnotationBootstrap()) throw authoritativeReadError({ reason: 'bootstrap_pending', detail: 'Annotation recovery has not completed.' });
  // Pass fetchRemoteAnnotations as a callback to core
  return core.readAllAnnotations(coreConfig, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
}

async function readIndex() {
  const indexPath = join(FEEDBACK_DIR, 'index.json');
  if (!existsSync(indexPath)) return null;
  try {
    return JSON.parse(await readFile(indexPath, 'utf-8'));
  } catch {
    return null;
  }
}

// ─── Tool Implementations ─────────────────────────────────────────────────────

async function toolGetAnnotations({ pageUrl, pageUrls, componentName, status, projectId, view, critiqueRunId } = {}) {
  const result = await withAuthoritativeImplementationRead(
    () => core.toolGetAnnotations(coreConfig, { pageUrl, pageUrls, componentName, status, projectId: resolveProjectFilter(projectId), view, critiqueRunId }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
    { totalPages: 0, pages: [] },
  );
  return recordJourneyReads(result, 'get_annotations');
}

async function toolSearchAnnotations({ query }) {
  const result = await withAuthoritativeImplementationRead(
    () => core.toolSearchAnnotations(coreConfig, { query }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
    { query: query || '', totalMatches: 0, results: [] },
  );
  return recordJourneyReads(result, 'search_annotations');
}

async function toolGetFeedbackSummary({ projectId } = {}) {
  const result = await withAuthoritativeImplementationRead(
    () => core.toolGetFeedbackSummary(coreConfig, SYNC_SERVER_URL ? fetchRemoteAnnotations : null, { projectId: resolveProjectFilter(projectId) }),
    {
      summary: { totalOpen: 0, totalApproved: 0, totalInProgress: 0, totalResolved: 0, totalArchived: 0, totalDismissed: 0, totalAnnotations: 0 },
      openItems: [], byPage: [], byComponent: {},
    },
  );
  if (result.error === 'authoritative_sync_unavailable' || result.error === 'authoritative_sync_required') return result;
  return maybeAttachFirstPinNudge(result);
}

async function toolGetComponentFeedback({ componentName }) {
  const result = await withAuthoritativeImplementationRead(
    () => core.toolGetComponentFeedback(coreConfig, { componentName }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
    { componentName: componentName || null, totalAnnotations: 0, pages: [] },
  );
  return recordJourneyReads(result, 'get_component_feedback');
}

async function toolResolveAnnotation({ annotationId, comment, resolvedBy }) {
  const result = await withAuthoritativeExistingPinOperation(
    () => core.toolResolveAnnotation(coreConfig, { annotationId, comment, resolvedBy }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
  );
  if (result.success && !result.alreadyResolved) await removeFromApprovedQueue(annotationId);
  return result;
}

async function toolAddAgentReply({ annotationId, body, author }) {
  return withAuthoritativeExistingPinOperation(
    () => core.toolAddAgentReply(coreConfig, { annotationId, body, author }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
  );
}

// ─── Create Critique Pin (Pincushion AI) ─────────────────────────────────────
// Used by /critique and /critique-latest-deploy. The dev's local agent does the
// LLM work, then calls this to drop a bot-authored pin. Pincushion never sees
// the page or the critique — this just persists what the agent decided.

async function toolCreateAgentPin(toolArgs) {
  const result = await core.toolCreateAgentPin(
    coreConfig,
    toolArgs,
    SYNC_SERVER_URL ? fetchRemoteAnnotations : null
  );
  if (result.success) {
    captureEvent(getDistinctId(), 'agent pin created', {
      severity: toolArgs?.severity || 'medium',
      agentNamed: !!toolArgs?.agentName,
    });
  }
  return result;
}

async function toolImportQaResults(toolArgs) {
  const result = await core.toolImportQaResults(
    coreConfig,
    toolArgs,
  );
  if (result.success && result.dryRun !== true) {
    captureEvent(getDistinctId(), 'qa results imported', {
      format: toolArgs?.format || null,
      dryRun: result.dryRun === true,
      findingCount: result.preview?.findingCount || result.findings?.length || 0,
      projectId: toolArgs?.projectId || null,
    });
  }
  return result;
}

async function toolCreateCritiquePin({ pageUrl, pageTitle, componentName, selector, body, severity, visibility, tags, critiqueRunId, projectId, operationId }) {
  const result = await core.toolCreateCritiquePin(
    coreConfig,
    { pageUrl, pageTitle, componentName, selector, body, severity, visibility, tags, critiqueRunId, projectId, operationId },
    SYNC_SERVER_URL ? fetchRemoteAnnotations : null
  );
  if (result.success) {
    captureEvent(getDistinctId(), 'critique pin created', {
      severity: severity || 'medium',
      hasSelector: !!selector,
      projectId: projectId || null,
    });
  }
  return result;
}

// ─── Reply candidates + bot reply (Pincushion AI replies) ─────────────────────
async function toolGetReplyCandidates({ projectId } = {}) {
  return withAuthoritativeImplementationRead(
    () => core.toolGetReplyCandidates(
      coreConfig,
      { projectId },
      SYNC_SERVER_URL ? fetchRemoteAnnotations : null
    ),
    { candidates: [], count: 0 },
  );
}

async function toolAddBotReply({ annotationId, body }) {
  const result = await withAuthoritativeExistingPinOperation(
    () => core.toolAddBotReply(
      coreConfig,
      { annotationId, body },
      SYNC_SERVER_URL ? fetchRemoteAnnotations : null
    ),
  );
  if (result.success) {
    captureEvent(getDistinctId(), 'bot reply added', { annotationId });
  }
  return result;
}

// ─── Critique queue tools (deploy-triggered AI critiques) ────────────────────
async function toolGetPendingCritiques({ projectId } = {}) {
  return core.toolGetPendingCritiques(coreConfig, { projectId });
}

async function toolGetPendingDeploymentFrameRefreshes({ projectId } = {}) {
  return core.toolGetPendingDeploymentFrameRefreshes(coreConfig, { projectId });
}

async function toolStartDeploymentCaptureRun({ deploymentId }) {
  return core.toolStartDeploymentCaptureRun(coreConfig, { deploymentId });
}

async function toolCompleteDeploymentCaptureRun({ deploymentId, captureRunId, captureProof }) {
  const result = await core.toolCompleteDeploymentCaptureRun(coreConfig, { deploymentId, captureRunId, captureProof });
  if (result.success) {
    captureEvent(getDistinctId(), 'deployment frame refresh completion requested', { deploymentId });
  }
  return result;
}

async function toolCompleteCritiqueRequest({ id, pinCount }) {
  const result = await core.toolCompleteCritiqueRequest(coreConfig, { id, pinCount });
  if (result.success) {
    captureEvent(getDistinctId(), 'critique run completed', { pinCount: pinCount || 0 });
  }
  return result;
}

async function toolRecordDeploymentPageResult({ deploymentId, pageUrl, status, outcome, versionIds, contentHashes, error, captureRunId, captureProof }) {
  const result = await core.toolRecordDeploymentPageResult(coreConfig, {
    deploymentId, pageUrl, status, outcome, versionIds, contentHashes, error, captureRunId, captureProof,
  });
  if (result.success) {
    captureEvent(getDistinctId(), 'deployment page reconciliation recorded', {
      deploymentId,
      status: result.pageResult?.status || status || outcome || null,
      autoFinalized: result.autoFinalized === true,
    });
  }
  return result;
}

async function toolRegisterDeploymentDiscoveredPages({ deploymentId, pageUrls }) {
  const result = await core.toolRegisterDeploymentDiscoveredPages(coreConfig, { deploymentId, pageUrls });
  if (result.success) {
    captureEvent(getDistinctId(), 'deployment discovery registered', {
      deploymentId,
      acceptedPendingPages: result.acceptedPendingPages?.length || 0,
    });
  }
  return result;
}

// ─── Automatic deployment-frame executor ────────────────────────────────────
// This executor is deliberately local and project-scoped. It starts only after
// auto-discovery has settled on one exact project, the MCP/REST server has
// completed its transport boot, and authoritative cloud credentials exist.
// Ambiguous/no-project work stays idle instead of capturing another project.
let deploymentFrameRuntime = null;

function deploymentFrameCaptureAuth() {
  if (!Object.prototype.hasOwnProperty.call(process.env, 'PINCUSHION_STORAGE_STATE')) {
    return { mode: 'anonymous' };
  }
  const storageStatePath = String(process.env.PINCUSHION_STORAGE_STATE || '').trim();
  return storageStatePath
    ? { mode: 'authenticated', descriptor: { storageStatePath } }
    : null;
}

function startAutomaticDeploymentFrameRuntime() {
  const projectId = resolveProjectFilter();
  const auth = deploymentFrameCaptureAuth();
  const decision = deploymentFrameRuntimeStartDecision({
    optIn: process.env.PINCUSHION_AUTO_FRAME_REFRESH,
    syncServerUrl: SYNC_SERVER_URL,
    licenseKey: resolveCloudSyncKey() || SYNC_API_KEY,
    projectId,
    auth,
  });
  if (!decision.start || deploymentFrameRuntime) return decision;

  try {
    deploymentFrameRuntime = createDeploymentFrameRuntime({
      projectId,
      coreConfig,
      coreApi: core,
      uploadPageSnapshot: toolUploadPageSnapshot,
      auth,
      runtimeEnv: process.env,
      logger: {
        info: (code) => console.error(`[frame-refresh] ${code}`),
        warn: (code) => console.error(`[frame-refresh] ${code}`),
        error: (code) => console.error(`[frame-refresh] ${code}`),
      },
    });
    // Do not block the transport handshake or REST listener on a browser or
    // authoritative queue call. The executor reports only fixed redacted codes.
    void deploymentFrameRuntime.start().catch(() => {
      console.error('[frame-refresh] deployment_frame_runtime_start_failed');
    });
    return { start: true };
  } catch {
    deploymentFrameRuntime = null;
    console.error('[frame-refresh] deployment_frame_runtime_configuration_invalid');
    return { start: false, reason: 'runtime_configuration_invalid' };
  }
}

// ─── Pending-work surfacing (the reply-latency mitigation) ──────────────────
// Surfaced in three places (every sync response, /pins output, first-tool-of-
// session banner). Cached for 30s to avoid hammering the queue endpoint on
// every MCP call.
const _PENDING_WORK_TTL_MS = 30_000;
const _SESSION_BANNER_IDLE_MS = 30 * 60 * 1000; // 30 minutes
let _pendingWorkCache = null;
let _pendingWorkCacheAt = 0;
let _lastFullBannerAt = 0; // 0 = never shown this session

async function getPendingWorkCached() {
  const now = Date.now();
  if (_pendingWorkCache && (now - _pendingWorkCacheAt) < _PENDING_WORK_TTL_MS) {
    return _pendingWorkCache;
  }
  try {
    _pendingWorkCache = await core.getPendingWorkSummary(
      coreConfig,
      SYNC_SERVER_URL ? fetchRemoteAnnotations : null
    );
    _pendingWorkCacheAt = now;
  } catch {
    _pendingWorkCache = { pendingCritiques: 0, pendingReplies: 0, hasWork: false };
  }
  return _pendingWorkCache;
}

// Returns a string to prepend to the tool result. Empty when there's no
// bot work to surface. Two formats:
//   - Full banner: first call of the session OR after 30 min of MCP idle.
//   - Short hint: subsequent calls within the idle window.
async function pincushionPendingBanner() {
  let summary;
  try {
    summary = await getPendingWorkCached();
  } catch {
    return '';
  }
  if (!summary || !summary.hasWork) return '';
  const now = Date.now();
  const showFull = _lastFullBannerAt === 0 || (now - _lastFullBannerAt) > _SESSION_BANNER_IDLE_MS;

  const replies = summary.pendingReplies || 0;
  const critiques = summary.pendingCritiques || 0;
  const parts = [];
  if (replies > 0) parts.push(`${replies} pending repl${replies === 1 ? 'y' : 'ies'}`);
  if (critiques > 0) parts.push(`${critiques} pending critique${critiques === 1 ? '' : 's'}`);
  const summaryLine = parts.join(' + ');

  if (showFull) {
    _lastFullBannerAt = now;
    const lines = [`🔔 Pincushion AI — ${summaryLine}.`];
    if (replies > 0) lines.push('   Run /pincushion-replies to address @mentions and continue threads on bot pins.');
    if (critiques > 0) lines.push('   Run /critique-latest-deploy to drop pins on the URLs queued by your last deploy.');
    return lines.join('\n') + '\n\n';
  }
  return `🔔 ${summaryLine} (Pincushion AI). Run /pincushion-replies / /critique-latest-deploy to clear.\n\n`;
}

// ─── Fix and Resolve Tool ─────────────────────────────────────────────────────

async function toolFixAndResolve({ annotationId, fixDescription, filePath, lineNumber, commitSha, branchName, prUrl }) {
  const result = await withAuthoritativeExistingPinOperation(
    () => core.toolFixAndResolve(coreConfig, { annotationId, fixDescription, filePath, lineNumber, commitSha, branchName, prUrl }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
  );
  // Push implementation status to cloud
  if (result.success) {
    captureEvent(getDistinctId(), 'pin resolved', {
      annotationId,
      hasCommitSha: !!commitSha,
      hasBranchName: !!branchName,
      hasPrUrl: !!prUrl,
    });
    await removeFromApprovedQueue(annotationId);
  }
  return result.success ? withOnboardingMeasurement(result, [await recordJourneyAction('record_implementation', annotationId)]) : result;
}

// ─── Read-only project context (for critic subagent) ────────────────────────
// Never creates or changes a cloud project. A follower may authenticate and
// refresh its local cache before returning the project's brand context.
async function toolGetProjectContext({ projectId, name, url, view } = {}) {
  await ensureCloudAuthForTool();
  return core.toolGetProjectContext(coreConfig, { projectId, name, url, view });
}

async function toolGetProjectWriteAuthorization({ projectId } = {}) {
  // Never accept a caller-selected endpoint or expose the resolved key.
  return readProjectWriteAuthorization({
    projectId, expectedProjectId: DEFAULT_PROJECT_ID,
    functionsBase: SYNC_SERVER_URL?.replace(/\/sync-annotations\/?$/, ''),
    licenseKey: resolveCloudSyncKey(),
  });
}

// Read-only, credential-safe identity troubleshooting. This intentionally
// reports provenance and candidate ambiguity rather than project records or
// cloud existence, and it never performs a network request or mutation.
async function toolGetProjectIdentityDiagnostic({ projectId, urls } = {}) {
  const registry = await core.readProjectRegistry({ feedbackDir: FEEDBACK_DIR });
  const candidates = cloudKeyCandidates().map((candidate) => ({
    source: candidate.source,
    key: candidate.key,
    status: candidateDiagnosticStatus(candidate),
  }));
  let ambiguity = { state: 'unknown', candidates: [] };
  if (!registry.malformed && (projectId || (Array.isArray(urls) && urls.length))) {
    const resolution = core.resolveProjectIdentity({
      projects: registry.projects,
      projectId,
      urls: Array.isArray(urls) ? urls : [],
    });
    ambiguity = {
      state: resolution.status === 'ambiguous'
        ? 'ambiguous'
        : (resolution.status === 'exact_id' || resolution.status === 'matched')
          ? 'unambiguous'
          : resolution.status === 'none' ? 'none' : 'unknown',
      candidates: resolution.candidates || [],
    };
  }
  return core.buildProjectIdentityDiagnostic({
    authState: cloudAuthState,
    activeSource: cloudAuthSource,
    activeKey: cloudAuthKey,
    cache: {
      state: registry.malformed ? 'malformed' : registry.exists ? 'present' : 'missing',
      projectCount: Object.keys(registry.projects).length,
    },
    candidates,
    ambiguity,
  });
}

// ─── NEW: Get Setup Instructions ──────────────────────────────────────────────

async function toolGetSetupInstructions() {
  const activeProjectId = resolveProjectFilter() || 'YOUR_PROJECT_ID';
  return {
    title: 'Pincushion — continue your feedback into a fix',
    description: 'Connect visual feedback pins to your AI coding agent',
    try_it_first: 'Have a critique report? Keep its findings open and use claim with that report token. The optional quickstart demo is for projects without existing findings.',
    quick_start: {
      step1: 'Create a project in the Pincushion app (https://www.pincushion.io/app) and connect it from its Connect code tab (GitHub or the setup command), or run npx pincushion-mcp setup in the project folder. From a critique report: npx pincushion-mcp claim <report-token>.',
      step2: 'Restart the editor if needed, confirm authenticated access to this project, explicitly approve one finding, then ask the agent to read and implement that exact pin. Configuration alone is not activation.'
    },
    optional_extension: 'https://www.pincushion.io/install/chrome — optional for placing new feedback on other pages',
    milestones: ['configuration_written', 'authenticated_project_access', 'explicit_approval', 'exact_pin_mcp_read', 'implementation_recorded', 'deployed', 'verified'],
    one_click_install: {
      cursor: {
        button_url: 'https://www.pincushion.io/install/cursor',
        deeplink: 'cursor://anysphere.cursor-deeplink/mcp/install?name=pincushion&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyJwaW5jdXNoaW9uLW1jcCIsIi0tcHJvamVjdC1kaXIiLCIuIiwiLS1jbG91ZC1zeW5jIl19',
        description: 'Click "Add to Cursor" on pincushion.io, or paste the deeplink in your browser'
      },
      claude_code: {
        command: 'claude mcp add pincushion -- npx pincushion-mcp --project-dir . --cloud-sync',
        description: 'Run this in your project directory'
      },
      vs_code: {
        file: '.vscode/mcp.json',
        content: {
          servers: {
            pincushion: {
              command: 'npx',
              args: ['pincushion-mcp', '--project-dir', '${workspaceFolder}', '--cloud-sync']
            }
          }
        }
      },
      codex: {
        command: 'codex mcp add pincushion -- npx -y pincushion-mcp --project-dir . --cloud-sync',
        mode: 'manual',
        description: 'Run this in the intended repository, then restart Codex and verify authenticated project access.'
      },
      windsurf: {
        file: '~/.codeium/windsurf/mcp_config.json',
        content: { mcpServers: { pincushion: { command: 'npx', args: ['-y', 'pincushion-mcp', '--project-dir', '/absolute/path/to/project', '--cloud-sync'] } } },
        documentation: 'https://docs.windsurf.com/windsurf/cascade/mcp',
        mode: 'manual',
        description: 'Open Windsurf MCP settings and add the stdio command npx with arguments ["-y", "pincushion-mcp", "--project-dir", "/absolute/path/to/project", "--cloud-sync"]. No configuration file is written for you.'
      },
      claude_desktop: {
        file: '~/Library/Application Support/Claude/claude_desktop_config.json (macOS)',
        content: {
          mcpServers: {
            pincushion: {
              command: 'npx',
              args: ['pincushion-mcp', '--project-dir', '/path/to/project', '--cloud-sync']
            }
          }
        }
      }
    },
    cloud_sync: {
      description: 'Cloud sync is enabled by default with --cloud-sync flag. Reviewers can drop pins on deployed/staging sites anytime — even when your IDE is closed. Pins sync to your local .feedback/ when your MCP server next starts.',
      setup: 'Use claim for an existing report or setup for a new project. Run `npx pincushion-mcp login` to recover missing or expired authentication; preserve the project and report context.',
      free_tier: '1 project, unlimited pins, no usage caps, 30s sync interval',
      pro_tier: 'Unlimited projects and pins, 90-day retention, 10s sync interval'
    },
    no_extension_fallback: {
      description: 'No browser extension? After owner approval, paste this one line into your app HTML (e.g. the root layout) and anyone who opens the site can drop a pin — no install. The widget captures the element selector, DOM snippet, and viewport (same work-packet fields as the extension), renders a sidebar of pins with threaded comments, and signs stakeholders in with Google for their avatar. Do not modify source or CI without that approval.',
      snippet: `<script src="https://www.pincushion.io/widget/pin.js" data-project="${activeProjectId}" defer></script>`,
      projectId: activeProjectId,
      docs: 'https://www.pincushion.io/docs',
    },
    collaboration_integrations: {
      description: 'Slack and Microsoft Teams integrations use project-scoped incoming webhooks. Defaults are low-noise: pin_ready, mention, and follow_up.',
      setup_tool: 'configure_collaboration_integration',
      slack_oauth_tool: 'create_slack_install_link',
      audit_tool: 'list_collaboration_integrations',
      preview_tool: 'preview_collaboration_notification',
      recommended_events: collaborationEventGuide(),
    },
    documentation: 'Full docs: https://www.pincushion.io/docs'
  };
}

// ─── Quickstart demo (ephemeral first-run loop) ──────────────────────────────
// Shows a new user the full read-pin -> fix-code -> resolve loop on a bundled
// sample page in ~60s. EPHEMERAL: never writes to .feedback/annotations/, never
// pushes to cloud, never fires the activation funnel. The only disk footprint is a
// throwaway editable copy under .feedback/.quickstart/ (gitignored), wiped on finish.
const QUICKSTART_DIR = join(FEEDBACK_DIR, '.quickstart');
const DEMO_TEMPLATE = join(SERVER_DIR, DEMO_FILE_REL);

async function toolStartQuickstartDemo({ full = false } = {}) {
  if (!existsSync(DEMO_TEMPLATE)) {
    return { error: `Demo page missing from this install (${DEMO_FILE_REL}). Reinstall pincushion-mcp.` };
  }
  // Fresh throwaway copy the agent edits; the pristine template stays untouched.
  rmSync(QUICKSTART_DIR, { recursive: true, force: true });
  mkdirSync(QUICKSTART_DIR, { recursive: true });
  copyFileSync(DEMO_TEMPLATE, join(QUICKSTART_DIR, DEMO_COPY_NAME));
  captureEvent(getDistinctId(), 'quickstart demo', { step: 'start', full: !!full });
  return buildDemoPackets({ demoCopyRel: join(QUICKSTART_DIR_REL, DEMO_COPY_NAME), full: !!full });
}

async function toolResolveQuickstartDemo({ annotationId, fixDescription } = {}) {
  if (!annotationId || !fixDescription) {
    return { error: 'annotationId and fixDescription are required.' };
  }
  const copyPath = join(QUICKSTART_DIR, DEMO_COPY_NAME);
  // Confirm the demo COPY was edited (never inspects or touches real project files).
  let changeDetected = false;
  try {
    if (existsSync(copyPath) && existsSync(DEMO_TEMPLATE)) {
      changeDetected = readFileSync(copyPath, 'utf8') !== readFileSync(DEMO_TEMPLATE, 'utf8');
    }
  } catch { /* best-effort */ }
  captureEvent(getDistinctId(), 'quickstart demo', { step: 'resolve', changeDetected });
  const payload = buildDemoResolvedPayload({
    fixDescription,
    diff: changeDetected ? 'Demo file edited ✓' : '',
    storeUrl: 'https://www.pincushion.io/install/chrome',
    projectId: resolveProjectFilter() || null,
    localOnly: !SYNC_SERVER_URL,
  });
  if (!changeDetected) {
    payload.note = `No change detected — edit .feedback/.quickstart/${DEMO_COPY_NAME} (the only file to touch), then call this again.`;
  }
  // Teardown: wipe the throwaway working dir so nothing lingers.
  rmSync(QUICKSTART_DIR, { recursive: true, force: true });
  return payload;
}

// ─── Configure project ────────────────────────────────────────────────────────

// Keep the recovery response useful without returning a bearer credential.
// The source and final four characters are enough to identify a stale override
// or the file that needs refresh; the structured handoff lets clients present a
// deterministic reconnect action instead of treating a local cache miss as a
// cloud deletion.
function configureProjectConnectionRequired(credentialCandidates) {
  const activeCandidate = credentialCandidates.find((candidate) => (
    (cloudAuthSource !== 'none' && candidate.source === cloudAuthSource) ||
    (!!cloudAuthKey && candidate.key === cloudAuthKey)
  )) || credentialCandidates[0] || null;
  const source = cloudAuthSource !== 'none' ? cloudAuthSource : (activeCandidate?.source || 'none');
  const key = cloudAuthKey || activeCandidate?.key || null;
  const status = activeCandidate ? candidateDiagnosticStatus(activeCandidate) : 'none';
  return {
    success: false,
    error: 'connection_required',
    authState: cloudAuthState,
    connection: {
      state: cloudAuthState,
      reason: cloudAuthReason,
      credential: {
        source,
        last4: key ? keyLast4(key) : null,
        status,
      },
      projectRegistryAuthoritative: cloudProjectRegistryAuthoritative,
      projectsVerifiedAt: cloudProjectsVerifiedAt,
    },
    reauthentication: {
      required: true,
      action: 'pincushion_login',
      command: 'npx pincushion-mcp login',
      retryTool: 'configure_project',
      preservesCachedProjectIdentity: true,
      blocksProjectMutationUntilVerified: true,
    },
    message: `Project registration is paused while cloud authentication is ${cloudAuthState}. Re-authenticate, then retry configure_project; no local registry or cloud project was changed.`,
  };
}

async function toolConfigureProject({
  name: projectName, projectId, urls = [], domain,
  deferLocalWriteUntilCloudAck = false,
  commitTrailers, attributionComments, recordCommitSha,
  commentAccess, allowedDomains,
  brandContext, autoCritique,
  critiqueSignals, critiquePolicy, critiqueContext,
  deploymentAutomation, deploymentProvider,
} = {}) {
  await ensureCloudAuthForTool();
  const credentialCandidates = cloudKeyCandidates();
  if (cloudAuthState === 'authenticated' && resolveCloudSyncKey() !== cloudAuthKey) {
    invalidateCloudProjectAuthority();
  }
  // Once a credential is configured, project registration is an identity
  // mutation and must wait for a successful authenticated pull. This prevents
  // a rejected/stale key from creating a local replacement or issuing a PUT;
  // the no-key path remains the documented intentional local-only mode.
  if (credentialCandidates.length && cloudAuthState !== 'authenticated') {
    return configureProjectConnectionRequired(credentialCandidates);
  }
  const acceptedCloudKey = cloudAuthState === 'authenticated' ? cloudAuthKey : null;
  // A configured credential makes every public configure_project call
  // cloud-backed. Callers cannot opt out of acknowledgement-first durability:
  // only an explicit no-credential local mode may write the registry before
  // returning. Keep the argument for wire compatibility, but never let a
  // false legacy value re-enable the old write-before-PUT behavior.
  const cloudBacked = Boolean(acceptedCloudKey);
  const result = await core.toolConfigureProject({
    ...coreConfig,
    // The state machine has already established which candidate the cloud
    // accepted. Pass that exact in-memory credential only at the request
    // boundary; core never persists it in the project registry.
    licenseKey: acceptedCloudKey,
  }, {
    name: projectName, projectId, urls, domain,
    deferLocalWriteUntilCloudAck: cloudBacked || deferLocalWriteUntilCloudAck,
    commitTrailers, attributionComments, recordCommitSha,
    commentAccess, allowedDomains,
    brandContext, autoCritique,
    critiqueSignals, critiquePolicy, critiqueContext,
    deploymentAutomation, deploymentProvider,
  });
  if (result.projectId) {
    captureEvent(getDistinctId(), 'project configured', {
      urlCount: (urls || []).length,
      projectId: result.projectId,
    });
  }
  return result;
}

async function toolGetDeploymentReconciliationStatus({ projectId } = {}) {
  return await core.toolGetDeploymentReconciliationStatus(coreConfig, { projectId });
}

async function toolManageDeploymentAutomation({ projectId, action, deploymentProvider, confirmed } = {}) {
  return await core.toolManageDeploymentAutomation(coreConfig, {
    projectId,
    action,
    deploymentProvider,
    confirmed,
  });
}

// ─── Update critique context ─────────────────────────────────────────────────
// Lightweight write path for /setup and /refresh-brand. Forwards to the core
// helper, which persists locally + pushes to cloud without doing the heavier
// configure_project setup work (deploy hook, member init, platform detection).

async function toolUpdateCritiqueContext({ projectId, name, critiqueContext, critiquePolicy, critiqueSignals } = {}) {
  return core.toolUpdateCritiqueContext(coreConfig, { projectId, name, critiqueContext, critiquePolicy, critiqueSignals });
}

// ─── Get Actionable Pins ──────────────────────────────────────────────────────

async function toolGetActionablePins({ projectId, mode } = {}) {
  let result = await withAuthoritativeImplementationRead(
    () => core.toolGetActionablePins(coreConfig, { projectId: resolveProjectFilter(projectId), mode }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
    { totalActionable: 0, pins: [], breakdown: {} },
  );
  if (result.error === 'authoritative_sync_unavailable' || result.error === 'authoritative_sync_required') return result;
  const receipt = await recordMcpReadReceipt('get_actionable_pins', result);
  return attachMcpReadReceiptMeasurement(
    maybeAttachFirstPinNudge(withCloudError(result)),
    receipt,
  );
}

// ─── Claim Actionable Pin ─────────────────────────────────────────────────────

async function toolClaimPin({ annotationId, implementer } = {}) {
  const result = await withAuthoritativeExistingPinOperation(
    () => core.toolClaimPin(coreConfig, { annotationId, implementer }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
  );
  // core's remote-first receipt has committed before this point. Remove the
  // local trigger only after that accepted lifecycle transition.
  if (result.success) {
    captureEvent(getDistinctId(), 'pin claimed', {
      annotationId,
      implementer: implementer || null,
    });
    await removeFromApprovedQueue(annotationId);
  }
  return result;
}

// ─── Approve Pin ─────────────────────────────────────────────────────────────

async function toolApprovePin({ annotationId, approvedBy } = {}) {
  const result = await withAuthoritativeExistingPinOperation(
    () => core.toolApprovePin(coreConfig, { annotationId, approvedBy }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
  );
  // core's remote-first receipt commits the lifecycle transition before this
  // local trigger cache is allowed to change.
  if (result.success && !result.alreadyApproved) {
    captureEvent(getDistinctId(), 'pin approved', {
      annotationId,
      approvedBy: approvedBy || 'unknown',
    });
    const ann = await core.findAnnotationById(coreConfig, annotationId);
    if (ann) {
      // Write trigger file so IDE extensions detect the approval
      const getBranchName = await loadGitModule();
      addToApprovedQueue({
        type: 'pin_approved',
        pinId: annotationId,
        status: ann.status,
        pageTitle: ann.pageTitle || ann.pageUrl,
        pageUrl: ann.pageUrl,
        approvedBy: approvedBy || 'unknown',
        comment: (ann.thread?.[0]?.body || '').slice(0, 80),
        suggestedBranch: getBranchName(ann.pageTitle, ann.pageUrl),
        timestamp: new Date().toISOString(),
        message: `Pin approved on "${ann.pageTitle || ann.pageUrl}" by ${approvedBy || 'someone'}`,
      }).catch(err => console.error('[trigger] Failed to queue approval:', err.message));
    }
  }
  return result.success ? withOnboardingMeasurement(result, [await recordJourneyAction('approve', annotationId)]) : result;
}

// ─── Link Pin Deploy (A4) ────────────────────────────────────────────────────

async function toolLinkPinDeploy({ annotationId, deployUrl, deployedAt } = {}) {
  const result = await withAuthoritativeExistingPinOperation(
    () => core.toolLinkPinDeploy(coreConfig, { annotationId, deployUrl, deployedAt }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
  );
  return withCloudError(result);
}

// ─── Record Pin Verification (A5) ────────────────────────────────────────────

async function toolRecordPinVerification({ annotationId, status, notes, verifiedAt } = {}) {
  const verificationConfig = SYNC_SERVER_URL ? {
    ...coreConfig,
    submitReportedVerification: async ({ annotation, annotationId: pinId, status: verdict, notes: reportNotes, verifiedAt: observedAt }) => {
      const projectId = annotation.projectId || annotation.project_id;
      if (!projectId) return { success: false, error: 'explicit_project_and_pin_required' };
      const key = createHash('sha256').update(JSON.stringify([projectId, pinId, verdict, reportNotes, observedAt, annotation.commitSha || annotation.commit_sha || null, annotation.implementedAt || annotation.implemented_at || null])).digest('hex');
      const reported = await toolPinVerificationEvidence('submit_verification_report', {
        projectId, annotationId: pinId, idempotencyKey: `legacy-${key}`, status: verdict, notes: reportNotes || '',
      });
      // Only an explicit server pilot-off response selects the compatible old
      // writer. Transport/auth/quota errors never fall through or double-meter.
      if (reported.status === 409 && reported.error === 'verification_policy_unavailable') return { legacyFallback: true };
      return reported;
    },
  } : coreConfig;
  const result = await withAuthoritativeExistingPinOperation(
    () => core.toolRecordPinVerification(verificationConfig, { annotationId, status, notes, verifiedAt }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
  );
  return withCloudError(result);
}

async function toolPinVerificationEvidence(action, args = {}) {
  const { projectId, annotationId, idempotencyKey, status, notes, deploymentEventId, reportId, runId, runAttempt } = args;
  return requestPinVerification({
    syncServerUrl: SYNC_SERVER_URL,
    licenseKey: resolveCloudSyncKey() || SYNC_API_KEY,
    action,
    payload: {
      project_id: projectId, annotation_id: annotationId,
      ...(action === 'submit_verification_report' ? {
        idempotency_key: idempotencyKey, verdict: status, notes,
        deployment_event_id: deploymentEventId,
      } : {}),
      ...(action === 'attach_verification_run' ? {
        report_id: reportId, run_id: runId, run_attempt: runAttempt,
      } : {}),
    },
  });
}

// ─── Agency Coordination Pilot (Release 4) ──────────────────────────────────
// This deliberately uses a separate, account-fenced server path. Internal
// agency messages/labels never enter the ordinary local pin cache, public
// annotation search, report resource, attachment reader, or notification flow.
// Callers must state an exact project ID; a local auto-discovered project is
// not enough authority for an owner/editor-only sidecar.
async function toolAgencyCoordination(action, args = {}) {
  const projectId = typeof args.projectId === 'string' ? args.projectId.trim() : '';
  if (!projectId) return { error: 'explicit_project_id_required' };
  const payloadByAction = {
    project_state: {},
    set_pilot: { enabled: args.enabled },
    create_label: { name: args.name, ...(args.color === undefined ? {} : { color: args.color }) },
    archive_label: { label_id: args.labelId },
    set_pin_labels: { annotation_id: args.annotationId, label_ids: args.labelIds },
    add_internal_message: {
      annotation_id: args.annotationId,
      body: args.body,
      idempotency_key: args.idempotencyKey,
    },
    get_internal_thread: { annotation_id: args.annotationId },
    list_pins: { ...(args.filters === undefined ? {} : { filters: args.filters }) },
    get_review_activity: {},
    export: { ...(args.filters === undefined ? {} : { filters: args.filters }) },
  };
  if (!Object.prototype.hasOwnProperty.call(payloadByAction, action)) {
    return { error: 'agency_coordination_invalid_action' };
  }
  return await requestAgencyCoordination({
    syncServerUrl: SYNC_SERVER_URL,
    licenseKey: resolveCloudSyncKey() || SYNC_API_KEY,
    action,
    projectId,
    payload: payloadByAction[action],
  });
}

// ─── Time-to-Fix Metrics (A6) ────────────────────────────────────────────────
//
// Soft Pro/Team gate: Free callers get sample size + a planRequired hint
// instead of full percentiles. The agent can use sample size to nudge the
// stakeholder toward an upgrade without losing the conversation. Pro/Team
// callers get the full payload (median + p25 + p75 + humanized strings).

async function toolGetTimeToFixMetrics({ projectId, scope } = {}) {
  const result = await withAuthoritativeImplementationRead(
    () => core.toolGetTimeToFixMetrics(coreConfig, { projectId: resolveProjectFilter(projectId), scope }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
    { sampleSize: 0, durations: [] },
  );
  if (result.error === 'authoritative_sync_unavailable' || result.error === 'authoritative_sync_required') return result;
  if (result && !result.error && !isProOrTeam()) {
    // Strip the actual numbers; keep sample size and threshold flag so the
    // agent can decide whether to nudge an upgrade. License-not-yet-known
    // (cloudSyncPlan === null) flows through optimistically — server will
    // re-gate on the next sync if needed.
    if (cloudSyncPlan && cloudSyncPlan !== 'pro' && cloudSyncPlan !== 'team') {
      return core.buildFreeTierMetricsResponse(result.sampleSize, result.scope, result.projectId, cloudSyncPlan);
    }
  }
  return withCloudError(result);
}

// ─── Assign Pin to Agent (A2) ────────────────────────────────────────────────

async function toolAssignPinToAgent({ annotationId, assignedBy } = {}) {
  const result = await withAuthoritativeExistingPinOperation(
    () => core.toolAssignPinToAgent(coreConfig, { annotationId, assignedBy }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
  );
  if (result.success) {
    captureEvent(getDistinctId(), 'pin assigned to agent', {
      annotationId,
      assignedBy: assignedBy || null,
    });
  }
  return result;
}

// ─── Implement Approved Pins ─────────────────────────────────────────────────

async function toolGetApprovedPins({ projectId } = {}) {
  let result = await withAuthoritativeImplementationRead(
    () => core.toolGetApprovedPins(coreConfig, { projectId: resolveProjectFilter(projectId) }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
    { totalApproved: 0, totalInProgress: 0, totalActionable: 0, pages: [], packets: [] },
  );
  if (result.error === 'authoritative_sync_unavailable' || result.error === 'authoritative_sync_required') return result;
  const receipt = await recordMcpReadReceipt('implement_approved_pins', result);
  if ((result.totalActionable || 0) > 0) {
    captureEvent(getDistinctId(), 'implement session started', {
      totalApproved: result.totalApproved || 0,
      totalInProgress: result.totalInProgress || 0,
      pageCount: result.pageCount || 0,
    });
  }
  return attachMcpReadReceiptMeasurement(withCloudError(result), receipt);
}

async function toolGetImplementationPacket({ pageUrl, projectId } = {}) {
  const result = await withAuthoritativeImplementationRead(
    () => core.toolGetImplementationPacket(coreConfig, { pageUrl, projectId: resolveProjectFilter(projectId) }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null),
    { pageUrl: pageUrl || null, pinCount: 0, pins: [] },
  );
  return recordJourneyReads(withCloudError(result), 'get_implementation_packet');
}

// ─── Get Selected Pins (from dashboard or checkbox selections) ───────────────

async function toolGetSelectedPins() {
  const selections = await core.readSelections(coreConfig);
  const selectedIds = selections.selectedPins || [];

  if (selectedIds.length === 0) {
    return {
      totalSelected: 0,
      pins: [],
      instructions: 'No pins are currently selected. The developer can select pins from .feedback/dashboard.html or check boxes in .feedback/PINS.md, then send them to the agent.'
    };
  }

  if (SYNC_SERVER_URL) {
    const authority = core.resolveLifecycleAuthority(coreConfig);
    if (!authority.ok) {
      return authoritativeOperationFailure(authority, {
        totalSelected: 0,
        pins: [],
        unavailableSelectionIds: selectedIds,
      });
    }
    const selectedPins = [];
    const terminalIds = [];
    const unavailableIds = [];
    for (const annotationId of selectedIds) {
      const lookup = await lookupCanonicalSelectedPin(annotationId);
      if (lookup.state === 'terminal') {
        terminalIds.push(annotationId);
        continue;
      }
      if (lookup.state !== 'active') {
        unavailableIds.push(annotationId);
        continue;
      }
      selectedPins.push(core.formatAnnotationForAgent(lookup.annotation, selectedPins.length + 1));
    }
    // Only a positive canonical terminal response may delete a persisted
    // selection. Auth/network/malformed responses deliberately retain it for a
    // later safe retry rather than silently discarding a user's work.
    if (terminalIds.length > 0) {
      await core.writeSelections(coreConfig, {
        ...selections,
        selectedPins: selectedIds.filter((id) => !terminalIds.includes(id)),
        timestamp: selections.timestamp || new Date().toISOString(),
      });
    }
    return recordJourneyReads({
      totalSelected: selectedPins.length,
      selectedAt: selections.timestamp,
      pins: selectedPins,
      unavailableSelectionIds: unavailableIds,
      terminalSelectionIds: terminalIds,
      instructions: selectedPins.length > 0
        ? `${selectedPins.length} canonical pin(s) selected for implementation. For each pin: read the thread, implement the requested change, then call fix_and_resolve({ annotationId, fixDescription }).`
        : unavailableIds.length > 0
          ? 'No selected pins were dispatched: Pincushion could not prove their current cloud state. Selections were retained and no implementation instruction was issued.'
          : 'No selected pins are eligible for implementation. Terminal pins were removed from the saved selection after an authoritative cloud lookup.'
    }, 'get_selected_pins');
  }

  // Fetch full pin data for selected IDs
  const allData = await readAllAnnotations();
  const selectedPins = [];

  for (const [url, data] of Object.entries(allData)) {
    for (const ann of (data.annotations || [])) {
      if (selectedIds.includes(ann.id)) {
        if (core.isTerminalStatus(ann.status)) continue;
        selectedPins.push(core.formatAnnotationForAgent(ann, selectedPins.length + 1));
      }
    }
  }

  return {
    totalSelected: selectedPins.length,
    selectedAt: selections.timestamp,
    pins: selectedPins,
    instructions: selectedPins.length > 0
      ? `${selectedPins.length} pin(s) selected for implementation. For each pin: read the thread, implement the requested change, then call fix_and_resolve({ annotationId, fixDescription }).`
      : 'No selected pins are eligible for implementation. Terminal pins are retained only as history and cannot be dispatched.'
  };
}

// ─── Member Management (via Supabase Edge Function) ──────────────────────────

async function toolAddMember({ projectId, email, name, role }) {
  if (!projectId || !email || !role) {
    return { error: 'projectId, email, and role are required' };
  }
  if (!['developer', 'commenter'].includes(role)) {
    return { error: 'role must be "developer" or "commenter"' };
  }
  if (!SYNC_SERVER_URL) {
    return { error: 'Sync server not configured. Use --sync-url to enable member management.' };
  }

  const baseUrl = SYNC_SERVER_URL.replace('/sync-annotations', '');
  try {
    const headers = { 'Content-Type': 'application/json' };
    // Resolve the user's license from --license-key / PINCUSHION_LICENSE_KEY /
    // .feedback/.license-key (falling back to the legacy --api-key). Previously
    // this read SYNC_API_KEY directly, so when the server was launched with
    // --license-key (the normal case) it sent NO key and every cloud call here
    // 401'd with "License key required". Matches integrationHeaders().
    const licenseKey = resolveCloudSyncKey() || SYNC_API_KEY;
    if (licenseKey) headers['x-license-key'] = licenseKey;

    const res = await fetch(`${baseUrl}/manage-members/add`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ project_id: projectId, email, name: name || email.split('@')[0], role })
    });
    const data = await res.json();

    // 402 = seat limit reached. Keep the stable code, but never echo the
    // provider's upgrade copy or arbitrary response fields across MCP.
    if (res.status === 402) {
      return safeProviderError({ error: 'seat_limit_reached' }, res.status);
    }

    if (res.ok && !data.error) {
      captureEvent(getDistinctId(), 'member added', { role, projectId });
    }
    return res.ok && !data.error
      ? data
      : safeProviderError(data, res.status, { fallback: 'member_add_failed' });
  } catch (err) {
    // A POST may have reached the provider before the transport failed. Keep
    // retries explicit and require the caller to reconcile by project/email.
    return safeErrorResponse(err, { code: 'member_add_failed' });
  }
}

async function toolListMembers({ projectId }) {
  if (!projectId) return { error: 'projectId is required' };
  if (!SYNC_SERVER_URL) {
    return { error: 'Sync server not configured.' };
  }

  const baseUrl = SYNC_SERVER_URL.replace('/sync-annotations', '');
  try {
    const headers = { 'Content-Type': 'application/json' };
    const licenseKey = resolveCloudSyncKey() || SYNC_API_KEY;
    if (licenseKey) headers['x-license-key'] = licenseKey;

    const res = await fetch(`${baseUrl}/manage-members/list?project_id=${encodeURIComponent(projectId)}`, { headers });
    const data = await res.json().catch(() => ({}));
    return res.ok && !data?.error
      ? data
      : safeProviderError(data, res.status, { fallback: 'member_list_failed', retryable: true });
  } catch (err) {
    return safeErrorResponse(err, { code: 'member_list_failed', retryable: true });
  }
}

async function toolRemoveMember({ projectId, email }) {
  if (!projectId || !email) return { error: 'projectId and email are required' };
  if (!SYNC_SERVER_URL) return { error: 'Sync server not configured.' };

  const baseUrl = SYNC_SERVER_URL.replace('/sync-annotations', '');
  try {
    const headers = { 'Content-Type': 'application/json' };
    const licenseKey = resolveCloudSyncKey() || SYNC_API_KEY;
    if (licenseKey) headers['x-license-key'] = licenseKey;

    const res = await fetch(`${baseUrl}/manage-members/remove`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ project_id: projectId, email })
    });
    const data = await res.json().catch(() => ({}));
    return res.ok && !data?.error
      ? data
      : safeProviderError(data, res.status, { fallback: 'member_remove_failed' });
  } catch (err) {
    return safeErrorResponse(err, { code: 'member_remove_failed' });
  }
}

// Create a Figma-style invite link for a project. Returns a sharable URL
// that the recipient redeems via the landing page (/join/<token>) — no
// pre-existing license required for the invitee.
async function toolCreateInviteLink({ projectId, role = 'commenter', expiresInDays = 30, maxUses = 0, returnTo } = {}) {
  if (!projectId) return { error: 'projectId is required' };
  if (!['editor', 'commenter'].includes(role)) {
    return { error: 'role must be "editor" or "commenter"' };
  }
  const licenseKey = resolveCloudSyncKey() || SYNC_API_KEY;
  if (!licenseKey) {
    return {
      error: 'license_required',
      message: 'Sign in to create invite links: run `npx pincushion-mcp login`, then restart the MCP server. Commenter invites are free on every plan.',
    };
  }
  if (!SYNC_SERVER_URL) return { error: 'Sync server not configured.' };
  const baseUrl = SYNC_SERVER_URL.replace('/sync-annotations', '');
  try {
    const headers = { 'Content-Type': 'application/json' };
    headers['x-license-key'] = licenseKey;
    const res = await fetch(`${baseUrl}/create-invite`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        project_id: projectId,
        role,
        expires_in_days: expiresInDays,
        max_uses: maxUses,
        ...(returnTo ? { returnTo } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) return safeProviderError(data, res.status, { fallback: 'invite_create_failed' });
    return {
      url: data.url,
      role: data.role,
      expiresAt: data.expires_at,
      maxUses: data.max_uses,
      instructions: `Share this URL with your teammate. They open it, enter their name + email, and join as ${data.role}. The link expires ${new Date(data.expires_at).toLocaleDateString()}${data.max_uses ? ` or after ${data.max_uses} uses` : ''}.`,
    };
  } catch (err) {
    return safeErrorResponse(err, { code: 'invite_create_failed' });
  }
}

async function toolCreateShareReport({ projectId, pageUrl, title, expiresInDays, purpose = 'capture', critiqueRunId = null, critiquePinIds = [], critiqueCaptureVersionIds = [], generationKey = null, accessMode = 'public' } = {}, internal = {}) {
  if (!projectId) return { error: 'projectId is required' };
  if (!SYNC_SERVER_URL) return { error: 'Sync server not configured.' };
  const baseUrl = SYNC_SERVER_URL.replace('/sync-annotations', '');
  try {
    const headers = { 'Content-Type': 'application/json' };
    const licenseKey = internal.licenseKey || resolveCloudSyncKey() || SYNC_API_KEY;
    if (licenseKey) headers['x-license-key'] = licenseKey;
    await internal.beforeEffect?.();
    const res = await fetch(`${baseUrl}/shared-report`, {
      method: 'POST',
      signal: internal.signal,
      headers,
      body: JSON.stringify({
        project_id: projectId,
        page_url: pageUrl,
        title,
        expires_in_days: expiresInDays,
        purpose,
        critique_run_id: critiqueRunId,
        critique_pin_ids: critiquePinIds,
        critique_capture_version_ids: critiqueCaptureVersionIds,
        generation_key: generationKey,
        access_mode: accessMode,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) return safeProviderError(data, res.status, { fallback: 'share_report_failed' });
    return {
      url: data.url,
      expiresAt: data.expires_at,
      pageUrl: data.page_url,
      title: data.title,
      instructions: accessMode === 'project_members'
        ? 'Only authenticated Pincushion project members can view this report and its findings or captures.'
        : `Anyone with this URL can view the report — no extension, no account. It shows every non-archived pin${data.page_url ? ' on that page' : ' in the project'} with threads, status, and the PR/deploy/verification trail, and updates live as pins get resolved. ${data.expires_at ? `Expires ${new Date(data.expires_at).toLocaleDateString()}.` : 'It never expires (revocable server-side).'}`,
    };
  } catch (err) {
    return safeErrorResponse(err, { code: 'share_report_failed' });
  }
}

async function toolUploadPageSnapshot({ projectId, pageUrl, imagePath, imageB64, contentType = 'image/jpeg', width, height, pinPositions = [], hotspots = [], captureContext = null, requireCritiqueProvenance = false, privateCritique = false, deploymentId = null, deploymentEventId = null, contentHash = null, captureFingerprint = null, captureRunId = null, captureProof = null } = {}, internal = {}) {
  if (!projectId) return { error: 'projectId is required' };
  if (!pageUrl) return { error: 'pageUrl is required — copy it VERBATIM from the pins this snapshot covers (exact-match keying)' };
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    return { error: 'width and height are required (integer pixel dimensions of the uploaded image)' };
  }
  if (!SYNC_SERVER_URL) return { error: 'Sync server not configured.' };

  // Prefer imagePath: the server reads the file directly so megabytes of
  // base64 never pass through the agent transcript.
  let b64 = imageB64 || null;
  if (!b64 && imagePath) {
    try {
      b64 = readFileSync(imagePath).toString('base64');
    } catch (err) {
      return safeErrorResponse(err, {
        code: 'local_file_unavailable',
        message: 'The requested image file could not be read.',
      });
    }
  }
  if (!b64) return { error: 'Provide imagePath (preferred) or imageB64' };
  const normalizedDeploymentId = String(deploymentId || deploymentEventId || '').trim() || null;
  const normalizedCaptureRunId = String(captureRunId || '').trim() || null;
  const normalizedCaptureProof = String(captureProof || '').trim() || null;
  const hasCaptureRunContext = Boolean(normalizedCaptureRunId || normalizedCaptureProof);
  if (normalizedDeploymentId && hasCaptureRunContext
    && (!normalizedCaptureRunId || !normalizedCaptureProof || normalizedCaptureProof.length < 32)) {
    return { error: 'captureRunId and opaque captureProof must be supplied together when a deployment capture run is supplied' };
  }
  const normalizedFingerprint = captureFingerprint === null || captureFingerprint === undefined
    ? null
    : normalizeCaptureFingerprint(captureFingerprint);
  if (captureFingerprint !== null && captureFingerprint !== undefined && !normalizedFingerprint) {
    return { error: 'captureFingerprint must be the bounded deployment capture-fingerprint v1 shape' };
  }
  const encodedImage = String(b64).replace(/^data:image\/(?:jpeg|webp);base64,/i, '');
  const computedContentHash = createHash('sha256').update(Buffer.from(encodedImage, 'base64')).digest('hex');
  const normalizedContentHash = contentHash === null || contentHash === undefined ? null : String(contentHash).trim().toLowerCase();
  if (normalizedContentHash && !/^[0-9a-f]{64}$/.test(normalizedContentHash)) {
    return { error: 'contentHash must be a lowercase SHA-256 hex digest' };
  }
  if (normalizedContentHash && normalizedContentHash !== computedContentHash) {
    return { error: 'contentHash does not match the uploaded image bytes' };
  }
  const captureFingerprintPayload = normalizedFingerprint ? {
    version: normalizedFingerprint.version,
    semantic_hash: normalizedFingerprint.semanticHash,
    visual_digest: normalizedFingerprint.visualDigest,
    tile_digests: normalizedFingerprint.tileDigests,
    instability_mask: normalizedFingerprint.instabilityMask,
  } : null;

  const baseUrl = SYNC_SERVER_URL.replace('/sync-annotations', '');
  try {
    const headers = { 'Content-Type': 'application/json' };
    const licenseKey = internal.licenseKey || resolveCloudSyncKey() || SYNC_API_KEY;
    if (licenseKey) headers['x-license-key'] = licenseKey;
    await internal.beforeEffect?.();
    const res = await fetch(`${baseUrl}/upload-screenshot`, {
      method: 'POST',
      signal: internal.signal,
      headers,
      body: JSON.stringify({
        kind: 'page',
        project_id: projectId,
        page_url: pageUrl,
        content_type: contentType,
        image_b64: b64,
        width,
        height,
        pin_positions: (Array.isArray(pinPositions) ? pinPositions : []).map(p => ({
          annotation_id: p.annotationId || p.annotation_id,
          x: p.x,
          y: p.y,
        })),
        hotspots: (Array.isArray(hotspots) ? hotspots : []).map(h => ({
          selector: h.selector,
          x: h.x,
          y: h.y,
          w: h.w,
          h: h.h,
        })),
        capture_context: captureContext,
        require_critique_provenance: requireCritiqueProvenance === true,
        private_critique: privateCritique === true,
        ...(normalizedDeploymentId ? { deployment_id: normalizedDeploymentId } : {}),
        ...(normalizedCaptureRunId ? { capture_run_id: normalizedCaptureRunId } : {}),
        ...(normalizedCaptureProof ? { capture_proof: normalizedCaptureProof } : {}),
        ...(normalizedContentHash ? { content_hash: normalizedContentHash } : {}),
        ...(captureFingerprintPayload ? { capture_fingerprint: captureFingerprintPayload } : {}),
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) return safeProviderError(data, res.status, { fallback: 'snapshot_upload_failed' });
    const versionId = data.version_id || data.versionId || null;
    if (!versionId) {
      return { error: 'Snapshot upload completed without an immutable version id; update the upload-screenshot service before generating a report.' };
    }
    return {
      url: data.url,
      private: data.private_critique === true,
      versionId,
      pageUrl: data.page_url,
      width: data.width,
      height: data.height,
      pinsPlaced: data.pin_count,
      contentHash: data.content_hash || normalizedContentHash || computedContentHash,
      deploymentId: data.deployment_id || normalizedDeploymentId,
      staged: data.staged === true,
      instructions: data.staged === true
        ? `Snapshot staged as immutable version ${versionId} for deployment reconciliation. It will not replace the canonical capture until the backend atomically finalizes all terminal page results.`
        : `Snapshot stored as immutable version ${versionId} — the share report now renders the annotated page view for ${data.page_url} with ${data.pin_count} positioned pin(s). Re-capture and upload any time the page or its pins change; generate_critique_report binds the version returned here rather than a mutable latest snapshot.`,
    };
  } catch (err) {
    return safeErrorResponse(err, { code: 'snapshot_upload_failed' });
  }
}

// This is the one command that turns real capture outputs into a canonical
// report. It intentionally does not synthesize a device, screen or journey:
// every claimed result below comes from an upload-screenshot response.
async function toolGenerateCritiqueReport({ projectId, title, preset = 'single', screens = [], journey = null, attribution = null, generationKey = 'canonical', reportUrl = null, purpose = 'critique', critiqueRunId = null, critiquePinIds = [], accessMode = 'public', coverage = null } = {}, internal = {}) {
  if (!projectId) return { error: 'projectId is required' };
  if (!['public', 'project_members'].includes(accessMode)) return { error: 'accessMode must be public or project_members' };
  if (String(generationKey || '').trim() === 'owner-workspace') {
    return { error: 'generationKey "owner-workspace" is managed by private browser captures and cannot be replaced by a critique generator.' };
  }
  if (!Array.isArray(screens) || !screens.length) return { error: 'screens must contain at least one real capture' };
  if (!SYNC_SERVER_URL) return { error: 'Sync server not configured.' };
  const normalizedPurpose = purpose === 'capture' ? 'capture' : 'critique';
  const normalizedCritiquePinIds = [...new Set((Array.isArray(critiquePinIds) ? critiquePinIds : [])
    .map((id) => String(id || '').trim())
    .filter(Boolean))];
  if (normalizedPurpose === 'critique' && !normalizedCritiquePinIds.length) {
    return { error: 'A critique report requires the Pincushion AI pin IDs created by the critic. Run the critic first; use purpose:"capture" only for a capture-only report.' };
  }
  const normalizedCritiqueRunId = String(critiqueRunId || '').trim().slice(0, 100);
  if (accessMode === 'project_members' && !normalizedCritiqueRunId) {
    return { error: 'Private Crit and capture-only reports require the current critiqueRunId for an immutable report.' };
  }
  if (normalizedPurpose === 'critique' && !normalizedCritiqueRunId) {
    return { error: 'A critique report requires a critiqueRunId shared by every Pincushion AI pin in this run.' };
  }
  if (normalizedPurpose === 'critique' && reportUrl) {
    return { error: 'A critique report always mints its own verified /r link; do not pass reportUrl from another report.' };
  }
  if (accessMode === 'project_members' && reportUrl) return { error: 'Private reports always mint a new access-bound link.' };
  const responsiveError = validateResponsiveCritiqueCaptures(screens, normalizedPurpose);
  if (responsiveError) return responsiveError;
  if (normalizedPurpose === 'critique') {
    const positionedPinIds = new Set(screens.flatMap((screen) => (screen?.captures || []).flatMap((capture) =>
      (capture?.pinPositions || []).map((position) => String(position?.annotationId || '').trim()).filter(Boolean)
    )));
    const missingPositions = normalizedCritiquePinIds.filter((id) => !positionedPinIds.has(id));
    if (missingPositions.length) {
      return { error: `Critique pins must be resolved into the supplied captures before minting a report. Missing positions for: ${missingPositions.join(', ')}` };
    }
  }
  const baseUrl = SYNC_SERVER_URL.replace('/sync-annotations', '');
  const key = internal.licenseKey || resolveCloudSyncKey() || SYNC_API_KEY;
  if (!key) return { error: 'A cloud license key is required.' };

  // Capture-only refreshes may reuse their stable generation key. A Crit is a
  // discrete, immutable receipt: its run ID is its generation key and it never
  // inherits an arbitrary existing public token.
  const effectiveGenerationKey = normalizedPurpose === 'critique'
    ? `critique-${normalizedCritiqueRunId}`.slice(0, 120)
    : accessMode === 'project_members'
    ? `capture-${normalizedCritiqueRunId}`.slice(0, 120)
    : generationKey;
  let canonicalReportUrl = reportUrl || null;
  if (normalizedPurpose !== 'critique' && internal.privateCapture !== true) {
    try {
      const existing = await fetch(`${baseUrl}/critique-manifest?project_id=${encodeURIComponent(projectId)}&generation_key=${encodeURIComponent(effectiveGenerationKey)}`, { headers: { 'x-license-key': key } });
      const data = await existing.json().catch(() => null);
      if (existing.ok && data?.reportUrl) canonicalReportUrl = data.reportUrl;
    } catch { /* report mint below remains safe */ }
  }

  const completedScreens = [];
  for (let screenIndex = 0; screenIndex < screens.length; screenIndex += 1) {
    const screen = screens[screenIndex] || {};
    const logicalScreenId = String(screen.logicalScreenId || screen.id || `screen-${screenIndex + 1}`);
    const pageUrl = String(screen.pageUrl || screen.url || '');
    const captures = Array.isArray(screen.captures) ? screen.captures : [];
    const captured = [];
    for (const capture of captures) {
      const context = { ...(capture.captureContext || {}), deviceClass: capture.deviceClass || capture.captureContext?.deviceClass };
      const uploaded = await toolUploadPageSnapshot({
        projectId, pageUrl, imagePath: capture.imagePath, imageB64: capture.imageB64,
        contentType: capture.contentType || 'image/jpeg', width: capture.width, height: capture.height,
        pinPositions: capture.pinPositions || [], hotspots: capture.hotspots || [], captureContext: context,
        requireCritiqueProvenance: normalizedPurpose === 'critique',
        privateCritique: accessMode === 'project_members',
        ...(internal.privateCapture === true ? { contentHash: capture.contentHash } : {}),
      }, internal);
      await internal.onUpload?.(uploaded, capture);
      captured.push(captureFromUploadReceipt({ capture, upload: uploaded, captureContext: context }));
    }
    completedScreens.push({
      logicalScreenId,
      url: pageUrl,
      title: screen.title,
      order: screen.order ?? screenIndex,
      flowColumn: screen.flowColumn,
      flowRow: screen.flowRow,
      navigationRole: screen.navigationRole,
      navigationLabel: screen.navigationLabel,
      links: screen.links,
      captures: captured,
    });
  }

  let manifest = normalizeGenerationManifest({
    generationKey: effectiveGenerationKey, requested: { preset, purpose: normalizedPurpose, accessMode, coverage, deviceClasses: screens.flatMap((screen) => (screen.captures || []).map((capture) => capture.deviceClass || capture.captureContext?.deviceClass)) },
    critique: normalizedPurpose === 'critique' ? { runId: normalizedCritiqueRunId, pinIds: normalizedCritiquePinIds } : null,
    screens: completedScreens, journey, attribution, live: { eligible: true, connected: false },
  });
  if (!manifest.population.complete) return generationReceipt(manifest, { reportUrl: canonicalReportUrl });

  const critiqueCaptureVersionIds = [...new Set(manifest.screens.flatMap((screen) => screen.captures
    .filter((capture) => capture.status === 'complete' && capture.versionId && capture.pinIds.some((id) => normalizedCritiquePinIds.includes(id)))
    .map((capture) => capture.versionId)))];

  // Crit proof is persisted before minting so shared-report can bind a fresh
  // token to this immutable, unique generation—not the project-wide latest
  // capture. The final write attaches the minted token after its project,
  // purpose, and generation key have been verified by the edge boundary.
  if (normalizedPurpose === 'critique') {
    try {
      const persisted = await fetch(`${baseUrl}/critique-manifest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-license-key': key },
        body: JSON.stringify({ project_id: projectId, generation_key: effectiveGenerationKey, report_url: null, manifest }),
      });
      const receipt = await persisted.json().catch(() => null);
      if (!persisted.ok || !receipt?.success) {
        return { ...generationReceipt(manifest), ...safeProviderError(receipt, persisted.status, { fallback: 'report_generation_failed' }) };
      }
    } catch (err) {
      return { ...generationReceipt(manifest), ...safeErrorResponse(err, { code: 'report_generation_failed' }) };
    }
  }

  if (!canonicalReportUrl) {
    const minted = await toolCreateShareReport({
      projectId,
      title,
      purpose: normalizedPurpose,
      critiqueRunId: normalizedCritiqueRunId,
      critiquePinIds: normalizedCritiquePinIds,
      critiqueCaptureVersionIds,
      generationKey: effectiveGenerationKey,
      accessMode,
    }, internal);
    if (minted.error || !minted.url) return { ...generationReceipt(manifest), error: minted.error || 'could not mint the canonical report' };
    canonicalReportUrl = minted.url;
  }
  // A Crit mint atomically binds this exact manifest to its new token. Do not
  // send a second write after the bearer link exists: a Crit receipt is
  // immutable by design, while capture-only generations may still refresh.
  if (normalizedPurpose === 'critique') {
    return generationReceipt(manifest, { reportUrl: canonicalReportUrl });
  }
  await internal.onPrepared?.({ reportUrl: canonicalReportUrl, manifest });
  try {
    await internal.beforeEffect?.();
    const persisted = await fetch(`${baseUrl}/critique-manifest`, {
      signal: internal.signal,
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-license-key': key },
      body: JSON.stringify({ project_id: projectId, generation_key: effectiveGenerationKey, report_url: canonicalReportUrl, manifest }),
    });
    const receipt = await persisted.json().catch(() => null);
    if (!persisted.ok || !receipt?.success) {
      return { ...generationReceipt(manifest, { reportUrl: canonicalReportUrl }), ...safeProviderError(receipt, persisted.status, { fallback: 'report_generation_failed' }) };
    }
  } catch (err) {
    return { ...generationReceipt(manifest, { reportUrl: canonicalReportUrl }), ...safeErrorResponse(err, { code: 'report_generation_failed' }) };
  }
  return generationReceipt(manifest, { reportUrl: canonicalReportUrl });
}

// This entrypoint offers a URL capture, not AI critique or project admission.
// Only the configured project's current owner/editor authority can start it.
// Internal generator hooks are closures, never caller-controlled tool fields.
async function toolCapturePrivateReport(input = {}, { signal } = {}) {
  const key = resolveCloudSyncKey();
  let endpoint;
  try {
    endpoint = new URL(SYNC_SERVER_URL);
    if (!endpoint.pathname.endsWith('/sync-annotations') || endpoint.username || endpoint.password
      || endpoint.search || endpoint.hash || (endpoint.protocol !== 'https:'
        && !(endpoint.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)))) throw new Error();
  } catch { return { success: false, error: 'capture_access_denied' }; }
  const baseUrl = endpoint.href.replace(/\/sync-annotations$/, '');
  const unchanged = () => Boolean(key) && resolveCloudSyncKey() === key;
  const authorize = async (request, { signal }) => {
    if (!unchanged() || !DEFAULT_PROJECT_ID || request.projectId !== DEFAULT_PROJECT_ID) return { allowed: false };
    const url = new URL(endpoint);
    url.searchParams.set('projects_only', '1');
    const response = await fetch(url, {
      headers: { 'x-license-key': key, 'X-Pincushion-Client': `mcp/${PKG_VERSION}` },
      signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok || !unchanged()) return { allowed: false };
    const data = await response.json();
    const projects = Array.isArray(data?.projects) ? data.projects : [];
    const project = projects.find((row) => (row.projectId || row.id) === request.projectId);
    if (!unchanged() || typeof data?.licenseId !== 'string' || !data.licenseId
      || !project || !['owner', 'editor'].includes(project.role)
      || !Array.isArray(project.urls) || !project.urls.includes(request.url)) return { allowed: false };
    return {
      allowed: true,
      seal: createHmac('sha256', key).update('pincushion-private-capture-v1\0')
        .update(JSON.stringify({ endpoint: endpoint.href, licenseId: data.licenseId, request })).digest('hex'),
    };
  };
  const read = async (path, signal) => {
    if (!unchanged()) throw new Error('capture_access_denied');
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { 'x-license-key': key }, signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
    });
    if (!response.ok || !unchanged()) return null;
    const data = await response.json();
    return unchanged() ? data : null;
  };
  const runner = createPrivateCaptureReportRunner({
    journal: createFileCaptureJournal(join(FEEDBACK_DIR, 'capture-reports')),
    authorize,
    generate: (args, hooks) => toolGenerateCritiqueReport(args, { ...hooks, licenseKey: key, privateCapture: true }),
    readManifest: (request, { signal }) => read(`/critique-manifest?project_id=${encodeURIComponent(request.projectId)}&generation_key=${encodeURIComponent(`capture-${request.operationId}`)}`, signal),
    readPrivateReport: (_request, hash, { signal }) => read(`/shared-report/app_${hash}`, signal),
    readCaptureImage: async (frame, { signal }) => {
      // Signed Storage reads carry no cloud credential. Only the configured
      // backend's signed-object path is admitted, with redirects disabled.
      const image = new URL(frame.imageUrl);
      if (image.origin !== endpoint.origin || image.username || image.password || image.hash
        || !image.pathname.startsWith('/storage/v1/object/sign/')) return null;
      const response = await fetch(image, { redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]) });
      if (!response.ok || !response.body) return null;
      const chunks = [];
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 20 * 1024 * 1024) { await response.body.cancel().catch(() => {}); return null; }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    },
  });
  const result = await runner(input, { signal });
  if (result.success && (signal?.aborted || !unchanged())) {
    return { success: false, status: 'pending', operationId: result.operationId, error: signal?.aborted ? 'capture_cancelled' : 'capture_access_denied' };
  }
  return result;
}

// ─── Collaboration Integrations (Slack / Microsoft Teams) ───────────────────

function integrationHeaders() {
  const licenseKey = resolveCloudSyncKey() || SYNC_API_KEY;
  if (!licenseKey) return null;
  return { 'Content-Type': 'application/json', 'x-license-key': licenseKey };
}

function integrationBaseUrl() {
  return coreConfig.supabaseBase || CLOUD_SYNC_URL.replace(/\/sync-annotations$/, '');
}

function collaborationEventGuide() {
  return {
    defaults: ['pin_ready', 'new_pin', 'mention', 'follow_up', 'resolved', 'pin_verified', 'pin_deployed'],
    allEvents: {
      pin_ready: 'A pin moves into the developer-ready queue. Default on.',
      mention: 'A new human comment includes an @mention. Default on.',
      follow_up: 'A human adds a new comment after work is ready, in progress, implemented, or resolved. Default on.',
      new_pin: 'Every newly dropped open pin. Default on in channels (off for personal DMs).',
      resolved: 'A pin is resolved. Default on.',
      pin_implemented: 'A fix is committed but not yet live (carries branch/PR). Opt-in; latent until a writer sets the implemented status.',
      pin_deployed: 'A pin\'s fix is deployed to production. Default on — renders as a QUIET threaded reply / 🚀 line under the pin, never a new top-level message.',
      pin_verified: 'Pincushion AI verifies a fix shipped correctly (the loop-closer). Default on — a ✅ stamp on the pin plus the one new proactive DM.',
      agent_pin_created: 'A QA/browser agent files a pin (create_agent_pin). Opt-in — off by default (a firehose on active checks).',
      email_pin_created: 'Feedback arrives via inbound email→pin. Opt-in — off by default.',
      report_created: 'A teammate mints a public share/crit report. Opt-in — off by default; DM + Discord/Teams webhook only, not Slack bot-channels.',
      credit_pack_purchased: 'An AI-action credit pack is purchased. Owner DM receipt only (set_slack_preferences) — never a shared-channel event.',
    },
    recommendedUseCases: [
      'Project dev channel: pin_ready + follow_up + pin_verified so developers see work, reopened conversations, and AI-confirmed fixes.',
      'Design/PM channel: mention + resolved so collaborators see explicit asks and closure without every pin.',
      'Release/QA channel: resolved + pin_deployed + pin_verified to watch the ship → live → verified loop.',
      'Page-specific launch channel: pageUrlPatterns plus pin_ready for a single staging or launch URL.',
    ],
    noiseDiscipline: 'The deploy/verify loop (pin_deployed, pin_verified) attaches to the pin\'s existing message as a quiet threaded reply and is skipped where the channel never saw the pin — it never spawns a new top-level broadcast. Only pin_verified earns a proactive DM by default; agent/email/report events and the credit-pack receipt are opt-in.',
    figmaInspiredDefaults: 'Modeled after Figma-style personal notifications and file/channel subscriptions: specific project/page subscriptions, high-signal events first, raw comment firehoses opt-in.',
  };
}

async function toolConfigureCollaborationIntegration({
  projectId,
  provider,
  webhookUrl,
  name = 'default',
  targetLabel,
  events,
  pageUrlPatterns,
  status = 'active',
  sendTest = false,
} = {}) {
  if (!projectId || !provider || !webhookUrl) {
    return {
      error: 'missing_required',
      message: 'projectId, provider, and webhookUrl are required',
      guideHint: 'Call preview_collaboration_notification to inspect event types and payload shapes.',
    };
  }
  const headers = integrationHeaders();
  if (!headers) return { error: 'License key required. Set PINCUSHION_LICENSE_KEY or .feedback/.license-key.' };
  try {
    const res = await fetch(`${integrationBaseUrl()}/manage-integrations/upsert`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        project_id: projectId,
        provider,
        webhook_url: webhookUrl,
        name,
        target_label: targetLabel,
        events,
        page_url_patterns: pageUrlPatterns,
        status,
        sendTest,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Compact error response — the full guide is on success only. Agents
      // that need it can call preview_collaboration_notification directly.
      return {
        ...safeProviderError(data, res.status, { fallback: 'collaboration_configure_failed' }),
        guideHint: 'Call preview_collaboration_notification for event types and payload shapes.',
      };
    }
    return { ...data, guide: collaborationEventGuide() };
  } catch (err) {
    return safeErrorResponse(err, { code: 'collaboration_configure_failed' });
  }
}

// Set or read the caller's Slack DM preferences (mute, per-event toggles).
// Wraps `manage-integrations` /preferences. The endpoint resolves the
// caller's email via license_key and applies the change to every Slack
// workspace where the email is linked. Use cases:
//   - Agent: "I'm doing a long refactor, mute my pin DMs for 1h"
//     → set_slack_preferences({ mute: '1h' })
//   - User: "Stop pinging me about new pins, I only care about
//     mentions and resolves"
//     → set_slack_preferences({ eventNewPin: false, eventPinReady: false })
//   - Inspect: call with no args to GET current state per workspace
async function toolSetSlackPreferences(args = {}) {
  const headers = integrationHeaders();
  if (!headers) return { error: 'License key required. Set PINCUSHION_LICENSE_KEY or .feedback/.license-key.' };

  const hasUpdates = Object.keys(args).some((k) => args[k] !== undefined);
  const url = `${integrationBaseUrl()}/manage-integrations/preferences`;
  try {
    if (!hasUpdates) {
      const res = await fetch(url, { headers });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        const failure = safeProviderError(data, res.status, { fallback: 'slack_preferences_failed', retryable: true });
        if (failure.error === 'no_slack_link') {
          return { ...failure, message: `${failure.message} Install Pincushion in Slack from https://www.pincushion.io/install/slack.` };
        }
        return failure;
      }
      return { ...data, hint: 'Pass any of: mute ("1h" | "today" | "forever" | "off"), eventNewPin, eventPinReady, eventMention, eventFollowUp, eventResolved, eventPinImplemented, eventPinDeployed, eventPinVerified, eventAgentPinCreated, eventEmailPinCreated, eventReportCreated, eventCreditPackPurchased (booleans), quietHoursStart / quietHoursEnd (0-23), timezone (IANA name), digestMode ("instant" | "hourly" | "daily").' };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      return safeProviderError(data, res.status, { fallback: 'slack_preferences_failed' });
    }
    return data;
  } catch (err) {
    return safeErrorResponse(err, { code: 'slack_preferences_failed', retryable: !hasUpdates });
  }
}

async function toolCreateSlackInstallLink({
  projectId,
  name = 'default',
  targetLabel,
  events,
  pageUrlPatterns,
} = {}) {
  if (!projectId) return { error: 'projectId is required' };
  const headers = integrationHeaders();
  if (!headers) return { error: 'License key required. Set PINCUSHION_LICENSE_KEY or .feedback/.license-key.' };
  try {
    const res = await fetch(`${integrationBaseUrl()}/manage-integrations/slack/install`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        project_id: projectId,
        name,
        target_label: targetLabel,
        events,
        page_url_patterns: pageUrlPatterns,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return safeProviderError(data, res.status, { fallback: 'slack_install_failed' });
    return {
      ...data,
      // The agent-flow install URL pre-binds the project; the storefront
      // URL is the simpler alternative if the user just wants to install
      // once and let auto-claim handle the rest (since May 2026).
      storefrontUrl: 'https://www.pincushion.io/install/slack',
      recommendation: 'For most users the storefront URL is simpler — install once, and if your Slack email matches your Pincushion account, the workspace auto-links and DMs flow without per-project setup. Use the agent installUrl above only if you want to pre-bind this specific project before the install completes.',
      instructions: 'Open installUrl, choose the Slack channel, and approve. Slack will redirect back to Pincushion and the incoming webhook will be stored automatically.',
      guide: collaborationEventGuide(),
    };
  } catch (err) {
    return safeErrorResponse(err, { code: 'slack_install_failed' });
  }
}

async function toolListCollaborationIntegrations({ projectId } = {}) {
  if (!projectId) return { error: 'projectId is required' };
  const headers = integrationHeaders();
  if (!headers) return { error: 'License key required. Set PINCUSHION_LICENSE_KEY or .feedback/.license-key.' };
  try {
    const res = await fetch(`${integrationBaseUrl()}/manage-integrations/list?project_id=${encodeURIComponent(projectId)}`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return safeProviderError(data, res.status, { fallback: 'collaboration_list_failed', retryable: true });
    return { ...data, guide: collaborationEventGuide() };
  } catch (err) {
    return safeErrorResponse(err, { code: 'collaboration_list_failed', retryable: true });
  }
}

async function toolClaimPendingSlackInstall({ claimToken, projectId, name = 'default', targetLabel, events, pageUrlPatterns } = {}) {
  const token = String(claimToken || '').trim();
  // Since May 2026, storefront Slack installs auto-link to a Pincushion
  // license when the installer's Slack email matches. The claim-token
  // ceremony only fires for installs where no email match was possible.
  // Surface that guidance up-front when the caller has nothing to claim.
  if (!token) {
    return {
      message: 'Claim tokens are now optional. New Slack installs via https://www.pincushion.io/install/slack auto-link to your Pincushion account if your Slack email matches. DMs flow automatically; channel broadcasts opt-in via `/pincushion subscribe <project>` inside any channel. Pass a claimToken here only if you were shown one on the post-install page (legacy fallback for unmatched emails).',
      installUrl: 'https://www.pincushion.io/install/slack',
      docs: 'https://www.pincushion.io/docs',
    };
  }
  if (!projectId) return { error: 'projectId is required' };
  const headers = integrationHeaders();
  if (!headers) return { error: 'License key required. Set PINCUSHION_LICENSE_KEY or .feedback/.license-key.' };
  try {
    const res = await fetch(`${integrationBaseUrl()}/manage-integrations/claim`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        claim_token: token,
        project_id: projectId,
        name,
        target_label: targetLabel,
        events,
        page_url_patterns: pageUrlPatterns,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const failure = safeProviderError(data, res.status, { fallback: 'slack_claim_failed' });
      if (failure.error === 'claim_token_invalid_or_expired') {
        return { ...failure, message: `${failure.message} Generate a fresh one at https://www.pincushion.io/install/slack.` };
      }
      return failure;
    }
    return { ...data, guide: collaborationEventGuide() };
  } catch (err) {
    return safeErrorResponse(err, { code: 'slack_claim_failed' });
  }
}

async function toolRemoveCollaborationIntegration({ projectId, integrationId, provider, name = 'default' } = {}) {
  if (!projectId) return { error: 'projectId is required' };
  if (!integrationId && !provider) return { error: 'integrationId or provider is required' };
  const headers = integrationHeaders();
  if (!headers) return { error: 'License key required. Set PINCUSHION_LICENSE_KEY or .feedback/.license-key.' };
  try {
    const res = await fetch(`${integrationBaseUrl()}/manage-integrations/remove`, {
      method: 'DELETE',
      headers,
      body: JSON.stringify({ project_id: projectId, integration_id: integrationId, provider, name }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return safeProviderError(data, res.status, { fallback: 'collaboration_remove_failed' });
    return data;
  } catch (err) {
    return safeErrorResponse(err, { code: 'collaboration_remove_failed' });
  }
}

async function toolPreviewCollaborationNotification({ provider = 'slack', event = 'pin_ready' } = {}) {
  // NOTE: this mirrors the production payload builders in
  // supabase/functions/_shared/notify.ts. The MCP server is Node/CommonJS and
  // can't import that Deno/TS module, so the shapes are kept in sync by hand —
  // if you change slackPayload/teamsPayload/discordPayload there, update here.
  const sampleMention = '@devon';
  const eventLabels = {
    mention: `${sampleMention} was mentioned on a pin`,
    follow_up: 'added a follow-up on a pin',
    pin_ready: 'marked a pin ready for implementation',
    new_pin: 'dropped a new pin',
    resolved: 'resolved a pin',
    pin_implemented: 'implemented a pin (code change ready)',
    pin_deployed: 'shipped a pin to production',
    pin_verified: 'Pincushion AI verified a fix shipped correctly',
    agent_pin_created: 'filed a pin (agent)',
    email_pin_created: 'sent feedback by email',
    report_created: 'shared a crit report',
  };
  const title = `Pincushion: ${eventLabels[event] || 'pin update'}`;
  const pageTitle = 'Checkout settings';
  const author = 'Priya';
  const baseComment = 'The save button looks disabled after editing the billing email. Can we make the active state clearer?';
  const comment = event === 'mention' ? `${sampleMention} — ${baseComment}` : baseComment;
  const pinUrl = 'https://app.example.com/settings?pincushionPin=ann_sample';
  const pinId = 'ann_sample';
  const slackComment = event === 'mention'
    ? comment.replace(/(^|[\s([{])@([a-zA-Z0-9._-]{2,40})\b/g, (_, p, n) => `${p}*@${n}*`)
    : comment;

  // Traceability facts appear on the deploy/verify loop events (matches
  // factsFromRow in notify.ts). pin_verified adds the ✅ verdict.
  const FACT_EVENTS = ['resolved', 'pin_implemented', 'pin_deployed', 'pin_verified'];
  const facts = FACT_EVENTS.includes(event) ? {
    branch: 'fix/checkout-save-state',
    prUrl: 'https://github.com/acme/app/pull/482',
    ...(event === 'pin_deployed' || event === 'pin_verified' ? { deployUrl: 'https://app.example.com' } : {}),
    ...(event === 'pin_verified' ? { verification: 'verified' } : {}),
  } : null;
  const factsMrkdwn = facts ? [
    facts.prUrl ? `🔀 <${facts.prUrl}|PR>` : null,
    facts.branch ? `🌿 \`${facts.branch}\`` : null,
    facts.deployUrl ? `🚀 <${facts.deployUrl}|Deploy>` : null,
    facts.verification ? `✅ ${facts.verification}` : null,
  ].filter(Boolean).join('  •  ') : null;

  let payload;
  if (provider === 'teams') {
    const factRows = [{ title: 'Author', value: author }, { title: 'Pin', value: pinId }];
    if (facts?.branch) factRows.push({ title: 'Branch', value: facts.branch });
    if (facts?.prUrl) factRows.push({ title: 'PR', value: `[Open PR](${facts.prUrl})` });
    if (facts?.deployUrl) factRows.push({ title: 'Deploy', value: `[Live](${facts.deployUrl})` });
    if (facts?.verification) factRows.push({ title: 'Verification', value: `✅ ${facts.verification}` });
    payload = {
      type: 'message',
      attachments: [{
        contentType: 'application/vnd.microsoft.card.adaptive',
        content: {
          $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
          type: 'AdaptiveCard', version: '1.4',
          body: [
            { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: title, wrap: true, color: event === 'mention' ? 'Attention' : 'Default' },
            { type: 'TextBlock', text: pageTitle, wrap: true, weight: 'Bolder', spacing: 'Small' },
            { type: 'TextBlock', text: comment, wrap: true, isSubtle: true, spacing: 'Small' },
            { type: 'FactSet', facts: factRows },
          ],
          actions: [{ type: 'Action.OpenUrl', title: 'Open pin', url: pinUrl }],
        },
      }],
    };
  } else if (provider === 'discord') {
    const fields = [];
    if (facts?.branch) fields.push({ name: 'Branch', value: facts.branch, inline: true });
    if (facts?.prUrl) fields.push({ name: 'PR', value: `[Open](${facts.prUrl})`, inline: true });
    if (facts?.deployUrl) fields.push({ name: 'Deploy', value: `[Live](${facts.deployUrl})`, inline: true });
    if (facts?.verification) fields.push({ name: 'Verification', value: `✅ ${facts.verification}`, inline: true });
    payload = {
      embeds: [{
        title: title.replace(/^Pincushion:\s*/, ''),
        description: `${pageTitle}\n${comment}`,
        url: pinUrl,
        color: event === 'mention' ? 0xE11D48 : 0x6366F1,
        ...(fields.length ? { fields } : {}),
        footer: { text: `By ${author}` },
      }],
    };
  } else {
    const blocks = [
      { type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n*${pageTitle}*` } },
      { type: 'section', text: { type: 'mrkdwn', text: `>${slackComment}` } },
      { type: 'context', elements: [{ type: 'mrkdwn', text: `By ${author} • Pin ${pinId}` }] },
    ];
    if (factsMrkdwn) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: factsMrkdwn }] });
    blocks.push({ type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open pin' }, url: pinUrl }] });
    payload = { text: `${title} on ${pageTitle}`, blocks };
  }

  const payloadShape = provider === 'teams' ? 'Microsoft Teams Adaptive Card (Workflows-compatible)'
    : provider === 'discord' ? 'Discord Incoming Webhook embed payload'
    : 'Slack Block Kit incoming webhook payload';
  return {
    provider,
    event,
    payloadShape,
    delivery: ['pin_deployed', 'pin_verified', 'pin_implemented'].includes(event)
      ? 'Loop event — in channels this attaches as a quiet threaded reply under the pin (skipped where the channel never saw the pin), never a new top-level message.'
      : 'Standard event — posts as a channel message / DM per subscription + user prefs.',
    sample: { title, pageTitle, author, comment, pinUrl, pinId, ...(facts ? { facts } : {}) },
    payload,
    guide: collaborationEventGuide(),
  };
}


// ─── MCP Server Definition ────────────────────────────────────────────────────

const server = new Server(
  { name: 'pincushion', version: '1.0.0' },
  {
    // `instructions` is delivered in the initialize handshake and surfaced to the
    // model by most MCP clients — the only first-run surface that reaches the agent
    // without a tool call, so a passive install still learns about the quickstart.
    instructions: buildServerInstructions(),
    capabilities: { tools: {}, prompts: {}, resources: { subscribe: true }, logging: {} },
  }
);
// The host's clientInfo is known once initialize completes; the `mcp boot`
// event waits for this (bounded) to report which client launched the server.
// The same moment is the keyless setup's first authenticated MCP contact.
function reportKeylessContact() {
  try {
    const projectId = resolveProjectFilter();
    const licenseKey = resolveCloudSyncKey();
    const syncServerUrl = SYNC_SERVER_URL || (licenseKey ? CLOUD_SYNC_URL : null);
    let client = {};
    try { client = server.getClientVersion() || {}; } catch { client = {}; }
    void connectionReporter.report({
      syncServerUrl,
      licenseKey,
      projectId,
      clientName: client.name || '',
      clientVersion: client.version || '',
      pkgVersion: PKG_VERSION,
    });
    // Where the account came from: the host's client name and the install ref,
    // each kept on the account only the first time it is seen.
    void entrySourceReporter.report({
      syncServerUrl,
      licenseKey,
      clientName: client.name || '',
      clientVersion: client.version || '',
      installRef: INSTALL_REF,
      pkgVersion: PKG_VERSION,
    });
  } catch {
    console.error('[mcp-contact] report skipped');
  }
}
server.oninitialized = () => {
  resolveBootClientReady();
  reportKeylessContact();
};

// ─── Tool metadata (titles + MCP annotations) ────────────────────────────────
// The Anthropic connector directory requires every tool to declare a `title` and
// the applicable readOnly/destructive hints. Centralized here and merged into the
// ListTools response (via applyToolMeta) so the tool literals below stay readable.
//   RO  = pure local read · ROC = read that hits the cloud
//   W   = additive cloud write · WI = idempotent cloud write · DEL = destructive
const RO  = { readOnlyHint: true, openWorldHint: false };
const ROC = { readOnlyHint: true, openWorldHint: true };
const W   = { readOnlyHint: false, destructiveHint: false, openWorldHint: true };
const WI  = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const DEL = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };
const TOOL_META = {
  get_annotations:                    { title: 'Get Feedback Pins',       annotations: RO },
  search_annotations:                 { title: 'Search Feedback',         annotations: RO },
  get_feedback_summary:               { title: 'Feedback Summary',        annotations: RO },
  get_component_feedback:             { title: 'Component Feedback',       annotations: RO },
  get_reply_candidates:               { title: 'Get Reply Candidates',    annotations: ROC },
  get_pending_critiques:              { title: 'Pending Critiques',        annotations: ROC },
  get_pending_deployment_frame_refreshes: { title: 'Pending Frame Refreshes', annotations: ROC },
  get_deployment_reconciliation_status: { title: 'Deployment Reconciliation Status', annotations: ROC },
  start_deployment_capture_run:       { title: 'Start Frame Refresh',      annotations: WI },
  complete_deployment_capture_run:    { title: 'Complete Frame Refresh',   annotations: WI },
  get_time_to_fix_metrics:            { title: 'Time-to-Fix Metrics',      annotations: RO },
  get_setup_instructions:             { title: 'Setup Instructions',       annotations: RO },
  start_quickstart_demo:              { title: 'Start Quickstart Demo',    annotations: RO },
  resolve_quickstart_demo:            { title: 'Finish Quickstart Demo',   annotations: RO },
  get_project_context:                { title: 'Project Context',          annotations: RO },
  get_project_write_authorization:    { title: 'Project Write Authorization', annotations: ROC },
  get_project_identity_diagnostic:    { title: 'Project Identity Diagnostic', annotations: RO },
  get_actionable_pins:                { title: 'Actionable Pins',          annotations: RO },
  implement_approved_pins:            { title: 'Approved Pin Packets',     annotations: RO },
  get_implementation_packet:          { title: 'Implementation Packet',    annotations: RO },
  get_selected_pins:                  { title: 'Selected Pins',            annotations: RO },
  list_members:                       { title: 'List Members',             annotations: ROC },
  list_collaboration_integrations:    { title: 'List Integrations',        annotations: ROC },
  preview_collaboration_notification: { title: 'Preview Notification',     annotations: RO },
  resolve_annotation:                 { title: 'Resolve Pin',              annotations: W },
  add_agent_reply:                    { title: 'Add Agent Reply',          annotations: W },
  add_bot_reply:                      { title: 'Add Bot Reply',            annotations: W },
  complete_critique_request:          { title: 'Complete Critique Run',    annotations: W },
  register_deployment_discovered_pages:{ title: 'Register Deployment Pages',annotations: WI },
  record_deployment_page_result:      { title: 'Record Deployment Page',   annotations: WI },
  create_critique_pin:                { title: 'Create Critique Pin',      annotations: W },
  create_agent_pin:                   { title: 'Create Agent Pin',         annotations: W },
  import_qa_results:                  { title: 'Import QA Results',        annotations: WI },
  fix_and_resolve:                    { title: 'Fix & Resolve Pin',        annotations: W },
  record_pin_verification:            { title: 'Record Verification',      annotations: W },
  submit_verification_report:         { title: 'Submit Reported Verification', annotations: WI },
  attach_verification_run:            { title: 'Attach Verification Run', annotations: WI },
  get_pin_verification:               { title: 'Get Verification Evidence', annotations: ROC },
  get_agency_coordination_state:      { title: 'Agency Pilot State',        annotations: ROC },
  list_agency_pins:                   { title: 'Agency Pins',               annotations: ROC },
  get_agency_internal_thread:         { title: 'Agency Internal Thread',    annotations: ROC },
  get_review_activity:                { title: 'Review Activity',           annotations: ROC },
  export_agency_evidence:             { title: 'Export Agency Evidence',    annotations: ROC },
  set_agency_coordination_pilot:      { title: 'Set Agency Pilot',           annotations: WI },
  create_agency_label:                { title: 'Create Agency Label',        annotations: WI },
  archive_agency_label:               { title: 'Archive Agency Label',       annotations: WI },
  set_agency_pin_labels:              { title: 'Set Agency Pin Labels',      annotations: WI },
  add_agency_internal_message:        { title: 'Add Agency Internal Message', annotations: WI },
  link_pin_deploy:                    { title: 'Link Deploy URL',          annotations: W },
  configure_project:                  { title: 'Configure Project',        annotations: WI },
  manage_deployment_automation:       { title: 'Manage Deployment Automation', annotations: DEL },
  update_critique_context:            { title: 'Update Critique Context',  annotations: WI },
  claim_pin:                          { title: 'Claim Pin',                annotations: W },
  approve_pin:                        { title: 'Approve Pin',              annotations: WI },
  assign_pin_to_agent:                { title: 'Assign Pin to Agent',      annotations: W },
  add_member:                         { title: 'Add Member',               annotations: W },
  create_invite_link:                 { title: 'Create Invite Link',       annotations: W },
  create_share_report:                { title: 'Create Share Report',      annotations: W },
  upload_page_snapshot:               { title: 'Upload Page Snapshot',     annotations: WI },
  configure_collaboration_integration:{ title: 'Configure Integration',    annotations: WI },
  create_slack_install_link:          { title: 'Create Slack Install Link',annotations: W },
  claim_pending_slack_install:        { title: 'Claim Slack Install',      annotations: W },
  set_slack_preferences:              { title: 'Slack Preferences',        annotations: WI },
  remove_member:                      { title: 'Remove Member',            annotations: DEL },
  remove_collaboration_integration:   { title: 'Remove Integration',       annotations: DEL },
};
function applyToolMeta(tool) {
  const meta = TOOL_META[tool.name];
  // Unmapped tools default to a safe non-destructive write hint so the directory
  // requirement (every tool carries title + readOnly/destructive) is never violated.
  if (!meta) return { ...tool, title: tool.name, annotations: { readOnlyHint: false, destructiveHint: false } };
  return { ...tool, title: meta.title, annotations: { ...meta.annotations } };
}

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_annotations',
      description: 'Retrieve annotation pins from the .feedback/ directory. Filter by page URL, LWC component name, or status. Use this to understand what feedback exists before making changes.',
      inputSchema: {
        type: 'object',
        properties: {
          pageUrl: { type: 'string', description: 'Filter by page URL (partial match OK). e.g. "WML_Care_Home"' },
          pageUrls: { type: 'array', maxItems: 64, items: { type: 'string' }, description: 'Exact URLs to read in one batched critique lookup.' },
          view: { type: 'string', enum: ['critique'], description: 'Compact critique projection with selectors and bounded pin text.' },
          critiqueRunId: { type: 'string', description: 'Filter to pins from one exact Crit run for report read-back.' },
          projectId: { type: 'string', description: 'Project ID, required for the compact critique view.' },
          componentName: { type: 'string', description: 'Filter by LWC component name. e.g. "wmlHomePage" or "c-wml-home-page"' },
          status: { type: 'string', enum: ['open', 'in-progress', 'resolved'], description: 'Filter by status' }
        }
      }
    },
    {
      name: 'search_annotations',
      description: 'Full-text search across all annotation comments, selectors, component names, and tags.',
      inputSchema: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query string' }
        }
      }
    },
    {
      name: 'get_feedback_summary',
      description: 'Get a high-level rollup of all open feedback: counts by status, page, and component. Use this to plan what to address first.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'get_component_feedback',
      description: 'Get all feedback pins targeting a specific LWC component, with a plain-language summary ready for implementation. Returns element selectors, comments, and thread history.',
      inputSchema: {
        type: 'object',
        required: ['componentName'],
        properties: {
          componentName: { type: 'string', description: 'LWC component name. e.g. "wmlHomePage", "wmlAgentSidebar", or "c-wml-home-page"' }
        }
      }
    },
    {
      name: 'resolve_annotation',
      description: 'Mark an annotation as resolved after addressing the feedback. Optionally add a resolution comment explaining what was changed.',
      inputSchema: {
        type: 'object',
        required: ['annotationId'],
        properties: {
          annotationId: { type: 'string', description: 'The annotation ID (e.g. "ann_abc123")' },
          comment: { type: 'string', description: 'Optional comment explaining the resolution (e.g. "Changed label to Recent Orders in wmlHomePage.html line 42")' },
          resolvedBy: { type: 'string', description: 'Name to attribute the resolution to (defaults to "AI Agent")' }
        }
      }
    },
    {
      name: 'add_agent_reply',
      description: 'Add a reply to an annotation thread (e.g. to ask a clarifying question or note a finding).',
      inputSchema: {
        type: 'object',
        required: ['annotationId', 'body'],
        properties: {
          annotationId: { type: 'string', description: 'The annotation ID' },
          body: { type: 'string', description: 'The reply message body' },
          author: { type: 'string', description: 'Author name (defaults to "AI Agent")' }
        }
      }
    },
    {
      name: 'get_reply_candidates',
      description: 'Used by /pincushion-replies. Returns pins where Pincushion AI should respond, with each candidate tagged by trigger reason. Two triggers: (a) "mention" — the latest thread message contains @pincushion AND was authored by a human; (b) "reply-on-bot-pin" — the pin was originally authored by Pincushion AI and the latest message is from a human. Skips resolved/archived pins and any pin where the latest message is already bot-authored (idempotency). Newest-first ordering so the slash command can pace replies.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Optional project ID to filter by. If omitted, returns candidates across all projects.' }
        }
      }
    },
    {
      name: 'add_bot_reply',
      description: 'Post a Pincushion AI reply to a pin\'s thread. Hardcodes author="Pincushion AI" and authorEmail="pincushion-bot@pincushion.io" so the Chrome extension applies bot styling. ONLY call from the /pincushion-replies flow — never as a generic reply. Refuses to post if the latest thread message is already bot-authored (defense-in-depth idempotency).',
      inputSchema: {
        type: 'object',
        required: ['annotationId', 'body'],
        properties: {
          annotationId: { type: 'string', description: 'The pin to reply on.' },
          body: { type: 'string', description: 'Reply text. Concrete, useful, on-brand. <2 short paragraphs. Same tone constraints as the critic — no UX-blog hedging.' }
        }
      }
    },
    {
      name: 'get_pending_critiques',
      description: 'Used by /critique-latest-deploy. Lists pending critique requests queued by the deploy-hook for the current license. Newer receipts also include a deployment event, prior page outcomes, project-page inventory, and latest per-device capture receipts for truthful local reconciliation before Crit runs. Newest-first. Free on all plans (the gating happened at enqueue time on the deploy-hook side: Pro/Team — including trial-Pro — always enqueue; free licenses enqueue while their monthly AI-action pool has headroom).',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Optional project ID filter. Omit to list across all the license\'s projects.' }
        }
      }
    },
    {
      name: 'get_pending_deployment_frame_refreshes',
      description: 'Lists production deployment frame-refresh work independently of the Critique queue. Use this even when autoCritique is false. The result is redacted: it contains no deployment URL/hash, browser state, storage path, or capture proof. Start a selected run before capturing.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Optional project ID filter. Omit to list eligible production frame refreshes for this license.' }
        }
      }
    },
    {
      name: 'start_deployment_capture_run',
      description: 'Starts one short-lived local frame-refresh run for an exact deployment and returns its opaque proof once. Keep the proof only in process and pass it to authenticated upload_page_snapshot/record_deployment_page_result/complete_deployment_capture_run calls; never put it in capture-snapshot, shell argv, a report, pin, status message, or file.',
      inputSchema: {
        type: 'object',
        required: ['deploymentId'],
        properties: {
          deploymentId: { type: 'string', description: 'Deployment ID from get_pending_deployment_frame_refreshes.' }
        }
      }
    },
    {
      name: 'complete_deployment_capture_run',
      description: 'Requests server-side frame-refresh completion after all exact page/device receipts have been recorded. The server rejects missing, stale, replayed, cross-deployment, or expired capture-run evidence and never treats a queue state as a current frame.',
      inputSchema: {
        type: 'object',
        required: ['deploymentId', 'captureRunId', 'captureProof'],
        properties: {
          deploymentId: { type: 'string', description: 'Exact deployment ID for the active capture run.' },
          captureRunId: { type: 'string', description: 'Capture-run ID returned by start_deployment_capture_run.' },
          captureProof: { type: 'string', description: 'Opaque short-lived proof returned once by start_deployment_capture_run. Never persist or log it.' },
        }
      }
    },
    {
      name: 'complete_critique_request',
      description: 'Mark a critique_queue request as completed after the critic subagent has run on its page URLs. Pass the request id (from get_pending_critiques) and the total pin_count produced. The server scopes the update to your license — you cannot complete another tenant\'s request even if you know the id.',
      inputSchema: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string', description: 'The critique_queue row id from get_pending_critiques.' },
          pinCount: { type: 'number', description: 'Total bot pins created for this request across all page URLs. Defaults to 0 if omitted.' }
        }
      }
    },
    {
      name: 'register_deployment_discovered_pages',
      description: 'Register the exact bounded URL inventory discovered in one local browser context before staging deployment captures. The backend returns accepted pending pages; upload snapshots and record terminal results only for that returned subset, never for a locally guessed URL.',
      inputSchema: {
        type: 'object',
        required: ['deploymentId', 'pageUrls'],
        properties: {
          deploymentId: { type: 'string', description: 'Deployment event ID supplied by get_pending_critiques.' },
          pageUrls: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string' }, description: 'Exact URLs discovered in the current same-origin browser context. Harmless URL normalization is applied; query variants remain distinct.' },
        }
      }
    },
    {
      name: 'record_deployment_page_result',
      description: 'Record one terminal page result for a deployment frame refresh. Every non-removed page in an initialized frame refresh must upload a newly staged desktop/mobile image pair from the exact active run, then submit those newly staged desktop/mobile version IDs and hashes with captureRunId and opaque captureProof. For unchanged, the server recomputes the image-byte hashes, accepts only an exact match to the frozen canonical pair, records the new evidence as observed, and discards the private duplicate pair; use updated if either byte hash differs. The deploy hook alone freezes removed rows, so callers cannot submit removed for an initialized run. Only server-confirmed historical pre-frame not_requested receipts retain a legacy no-run route. The server finalizes only after every initialized page has the current exact capture-run pair; a Critique queue state alone is never frame-current.',
      inputSchema: {
        type: 'object',
        required: ['deploymentId', 'pageUrl', 'status'],
        properties: {
          deploymentId: { type: 'string', description: 'Deployment event ID supplied by get_pending_critiques.' },
          pageUrl: { type: 'string', description: 'Exact inventoried page URL. Query variants remain distinct.' },
          status: { type: 'string', enum: ['updated', 'added', 'unchanged', 'removed', 'failed', 'inaccessible', 'skipped'], description: 'Terminal result. Use updated for a persistent change; use failed rather than labeling uncertain evidence unchanged.' },
          outcome: { type: 'string', enum: ['added', 'changed', 'unchanged', 'removed', 'inaccessible', 'unknown'], description: 'Optional local classifier outcome. The local MCP maps changed to updated and unknown to failed when status is omitted.' },
          versionIds: { type: 'array', items: { type: 'string' }, description: 'Newly staged desktop/mobile version IDs for updated, added, or unchanged. Unchanged still requires fresh current-run byte uploads; the server deduplicates only after verifying both byte hashes match the frozen canonical pair.' },
          contentHashes: { type: 'array', items: { type: 'string', pattern: '^[0-9a-f]{64}$' }, description: 'Server-recomputed SHA-256 hashes of the exact newly uploaded image bytes, paired with versionIds.' },
          captureRunId: { type: 'string', description: 'Active capture-run ID from start_deployment_capture_run. Required for every initialized frame-refresh terminal result. An initialized removed result is forbidden because the deploy hook freezes removal scope before the run; server-confirmed historical pre-frame not_requested receipts retain their legacy no-run route.' },
          captureProof: { type: 'string', description: 'Opaque proof from start_deployment_capture_run. Required with captureRunId for every initialized terminal result; never persist, log, or pass it through shell argv.' },
          error: { type: 'string', description: 'Bounded truthful reason for failed, inaccessible, or skipped results. Never include credentials or raw page content.' },
        }
      }
    },
    {
      name: 'create_critique_pin',
      description: 'Create a pin authored by Pincushion AI. ONLY call this from the pincushion-critic subagent, /critique-latest-deploy, or an explicitly requested Pincushion Crit command such as Grok Build /pincushion-crit (including the confirmed first Crit during /pincushion setup) — never from an ordinary coding prompt, since the bot voice is reserved for AI-driven UI/copy/a11y and product-experience feedback (flows, empty/error states, terminology, trust). Each call should produce one tasteful, high-signal pin (max 3 per page in a critique run). The body must be concrete and actionable: name the specific element + the specific problem + the suggested fix in <40 words (up to 55 for a flow critique that must name the step before/after). Forbidden: layout philosophy, business-model commentary, roadmap ideation (a missing affordance at a specific element IS in scope), generic "consider improving hierarchy" advice. Always read the project\'s critique context (`ai.critique.effectiveContext` from get_project_context — falls back to `brandContext` when no compiled brief exists) before drafting the body so the critique is on-brand. If `ai.critique.staleness` is "stale" or "missing", suggest the user run /refresh-brand before continuing. Repeating the same semantic finding on the same route and selector with only query values changed returns `duplicate_variant`; inspect a distinct state, scenario, or element instead.',
      inputSchema: {
        type: 'object',
        required: ['pageUrl', 'body', 'critiqueRunId'],
        properties: {
          pageUrl: { type: 'string', description: 'Full URL of the page being critiqued (e.g. "http://localhost:3000/dashboard").' },
          pageTitle: { type: 'string', description: 'Optional page title for the .feedback file header. Defaults to pageUrl if omitted.' },
          componentName: { type: 'string', description: 'Optional component name (e.g. LWC component, React component) for grouping. Used by get_component_feedback.' },
          selector: { type: 'string', description: 'CSS selector for the element the critique targets. The Chrome extension uses this to position the pin since the bot has no live page coords. Be specific (e.g. \'main button[type="submit"]\' not just \'button\').' },
          body: { type: 'string', description: 'The critique itself. Concrete + actionable, <40 words, names the element and proposes a fix. This becomes the first thread message on the pin.' },
          severity: { type: 'string', enum: ['high', 'medium'], description: '"high" = ships-blocking (broken contrast, broken keyboard nav, misleading CTA copy, a workflow dead-end in a core flow). "medium" = worth-fixing (minor copy issues, cramped spacing, terminology drift, polish opportunities). \'low\' is intentionally not allowed — bot pins must be worth acting on.' },
          visibility: { type: 'string', enum: ['public', 'project_members'], description: 'Use project_members for findings on signed-in app screens.' },
          critiqueRunId: { type: 'string', description: 'Required stable ID for this Crit run. Reuse the exact same value for every pin in the run; Pincushion stores it as critique-run:<id> and verifies it before a Crit report can be minted.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags. "pincushion-ai" is added automatically. Add domain tags like "a11y", "copy", "flow", "empty-state", "terminology", "deploy:<hash>" for traceability.' },
          projectId: { type: 'string', description: 'Project ID to associate the pin with. Defaults to the MCP server\'s configured project.' },
          operationId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$', description: 'Optional opaque idempotency ID. When a response is pending_reconciliation, retry the same submission with the returned operationId; use a new ID for an intentionally separate pin.' }
        }
      }
    },
    {
      name: 'create_agent_pin',
      description: 'File a pin as a THIRD-PARTY agent — the write half of the browser-agent → coding-agent handoff. Use when a QA/browser agent (Claude in Chrome, computer-use, a Playwright a11y/visual check, a CI checker) finds a concrete issue on a page and wants to hand it to the implementing agent as a work packet. NOT the Pincushion AI voice: the pin renders as "<agentName> (agent)" with an agent chip (enforced server-side; is_bot/bot styling stays reserved for the critic). Pins start "open" and get triaged like any pin — never pre-approved. Each pin should be one specific element + problem + suggested fix; include acceptanceCriteria when the finding has a testable definition of done. Metered as an AI action (agent_pin). Repeating the same semantic finding on the same route and selector with only query values changed returns `duplicate_variant`; inspect a distinct state, scenario, or element instead.',
      inputSchema: {
        type: 'object',
        required: ['pageUrl', 'body', 'agentName'],
        properties: {
          pageUrl: { type: 'string', description: 'Full URL of the page the finding is on.' },
          pageTitle: { type: 'string', description: 'Optional page title for the .feedback file header.' },
          selector: { type: 'string', description: 'CSS selector for the element the finding targets. Be specific — the implementing agent greps the repo with it and the extension positions the pin from it.' },
          body: { type: 'string', description: 'What the agent found + the suggested fix. Concrete and actionable; becomes the first thread message.' },
          agentName: { type: 'string', description: 'The filing agent\'s name, shown as the pin author (e.g. "Playwright a11y check", "Claude in Chrome", "nightly-qa-patrol"). Max 80 chars.' },
          severity: { type: 'string', enum: ['high', 'medium'], description: '"high" = broken behavior/blocked flow. "medium" = worth fixing. "low" intentionally not allowed — agent pins must be worth a human triage.' },
          acceptanceCriteria: { type: 'string', description: 'Optional testable definition of done (e.g. "axe-core reports 0 contrast violations on .checkout-form").' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags. "agent-pin" is added automatically; add domain tags like "a11y", "visual-regression", "broken-link".' },
          projectId: { type: 'string', description: 'Project ID to associate the pin with. Defaults to the MCP server\'s configured project.' },
          operationId: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$', description: 'Optional opaque idempotency ID. When a response is pending_reconciliation, retry the same submission with the returned operationId; use a new ID for an intentionally separate pin.' }
        }
      }
    },
    {
      name: 'import_qa_results',
      description: 'Pilot: import already-parsed axe JSON or Playwright JSON from an authenticated owner/editor/developer. Use dryRun=true to preview normalization and exact deduplication identities without writing. Repeated imports update one project + canonical page + device + rule + target record and preserve provenance. Failed observations may create or update open agent pins; passed, skipped, and inconclusive observations never resolve pins, change pin statuses, or qualify as trusted verification. The importer never reads files, fetches URLs, calls a provider, or uploads repository contents.',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'pageUrl', 'device', 'format', 'runId', 'source', 'results'],
        properties: {
          projectId: { type: 'string', description: 'Exact Pincushion project ID. The server re-checks immutable owner/editor/developer access.' },
          pageUrl: { type: 'string', description: 'Canonical page under the registered project URL. Query variants remain distinct; credentials and fragments are rejected/removed.' },
          device: { type: 'string', enum: ['desktop', 'mobile', 'tablet', 'unknown', 'phone', 'handset', 'pc', 'laptop'], description: 'Viewport/device class. phone and handset normalize to mobile; pc and laptop normalize to desktop.' },
          format: { type: 'string', enum: ['axe', 'axe-core', 'axe-json', 'playwright', 'playwright-json', 'playwright-test'], description: 'Supported result adapter.' },
          formatVersion: { type: 'string', description: 'Exact producer/result format version. Required when it cannot be inferred from the result payload.' },
          runId: { type: 'string', description: 'Stable producer run identifier for safe replay and provenance.' },
          source: { type: 'string', description: 'Bounded source label such as github-actions or playwright-ci.' },
          commitSha: { type: 'string', description: 'Optional exact commit SHA associated with the run; metadata only, not deployment proof.' },
          branch: { type: 'string', description: 'Optional branch metadata.' },
          environment: { type: 'string', description: 'Optional environment metadata such as staging or production.' },
          results: { type: 'object', description: 'Already-parsed axe or Playwright JSON. No file path, URL fetch, or provider reference is accepted.' },
          dryRun: { type: 'boolean', description: 'Preview only. No cloud request, pins, statuses, or verification records are changed.' },
        },
      },
    },
    {
      name: 'fix_and_resolve',
      description: 'Resolve a pin after applying a code fix. Transitions the pin directly to "resolved" status so it disappears from the stakeholder view. No thread comment is added — the commit is the record of the fix. Pass commitSha (from `git rev-parse HEAD`), branchName (`git branch --show-current`), and prUrl (from `gh pr view --json url -q .url` if a PR was opened) so the Pincushion dashboard can link the pin to the implementing commit, branch, and PR.',
      inputSchema: {
        type: 'object',
        required: ['annotationId', 'fixDescription'],
        properties: {
          annotationId: { type: 'string', description: 'The annotation ID to fix' },
          fixDescription: { type: 'string', description: 'Description of the fix applied (e.g. "Updated button label to match design spec")' },
          filePath: { type: 'string', description: 'Optional file path where the fix was made' },
          lineNumber: { type: 'number', description: 'Optional line number of the fix' },
          commitSha: { type: 'string', description: 'Optional git commit SHA that implemented the fix. Stored on the annotation for bidirectional pin↔commit traceability when the project has recordCommitSha enabled (default: true).' },
          branchName: { type: 'string', description: 'Optional branch name the fix was implemented on. Surfaces on the pin in the dashboard so stakeholders can see where the change shipped.' },
          prUrl: { type: 'string', description: 'Optional pull request URL (GitHub/GitLab/Bitbucket). Validated against PR-URL shape before storage. Surfaces as a clickable "Resolved in PR #N" link on the pin.' }
        }
      }
    },
    {
      name: 'get_time_to_fix_metrics',
      description: 'Compute median + p25/p75 time-to-fix from resolved pins. Returns sample size + threshold flag so callers can honestly hide the metric when the dataset is too small (< 5 resolved pins). This is the marketing proof point that distinguishes Pincushion from "manage feedback" tools — agent-native means fast.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Optional project ID to scope the metrics. Required when scope = "project".' },
          scope: { type: 'string', enum: ['project', 'global'], description: '"project" (default) restricts to one project. "global" computes across all projects accessible in this workspace — used by the landing widget for aggregate proof.' }
        }
      }
    },
    {
      name: 'record_pin_verification',
      description: 'Record a caller-reported verification verdict using the compatible legacy workflow. This does not independently prove deployment, check execution, or client acceptance. For pilot projects, submit_verification_report records append-only observations and attach_verification_run obtains separately validated check evidence.',
      inputSchema: {
        type: 'object',
        required: ['annotationId', 'status'],
        properties: {
          annotationId: { type: 'string', description: 'The pin ID being verified' },
          status: {
            type: 'string',
            enum: ['verified', 'regressed', 'inconclusive', 'pending'],
            description: 'Caller-reported verdict only: "verified" reports success, "regressed" reports a problem, "inconclusive" reports uncertainty, and "pending" records an intended recheck. No value proves independent execution.'
          },
          notes: { type: 'string', description: 'Optional plain-text verification notes (up to 2KB) explaining the verdict.' },
          verifiedAt: { type: 'string', description: 'Optional ISO timestamp. Defaults to now.' }
        }
      }
    },
    {
      name: 'submit_verification_report',
      description: 'Pilot: append a project-scoped caller-reported verification observation. An idempotency key makes retries safe. Reported success is not independent check evidence or client acceptance.',
      inputSchema: {
        type: 'object', required: ['projectId', 'annotationId', 'idempotencyKey', 'status'],
        properties: {
          projectId: { type: 'string' }, annotationId: { type: 'string' },
          idempotencyKey: { type: 'string', description: 'Stable unique key for this exact report; reuse only for an identical retry.' },
          status: { type: 'string', enum: ['verified', 'regressed', 'inconclusive', 'pending'] },
          notes: { type: 'string', description: 'Plain-text observations, not a proof of check execution.' },
          deploymentEventId: { type: 'string', description: 'Optional immutable deployment receipt ID. Never infer this from a deploy URL.' },
        },
      },
    },
    {
      name: 'attach_verification_run',
      description: 'Pilot: ask Pincushion to retrieve and validate a configured GitHub Actions run for an existing verification report. The server selects the trusted repository, workflow, checks, and artifacts. This starts no runner and cannot record client acceptance.',
      inputSchema: {
        type: 'object', required: ['projectId', 'annotationId', 'reportId', 'runId', 'runAttempt'],
        properties: {
          projectId: { type: 'string' }, annotationId: { type: 'string' }, reportId: { type: 'string' },
          runId: { type: 'integer', minimum: 1 }, runAttempt: { type: 'integer', minimum: 1 },
        },
      },
    },
    {
      name: 'get_pin_verification',
      description: 'Read authoritative verification evidence for one explicit project and pin. Separates caller reports, deployment receipts, independently retrieved checks, and client acceptance. Missing evidence stays unknown.',
      inputSchema: {
        type: 'object', required: ['projectId', 'annotationId'],
        properties: { projectId: { type: 'string' }, annotationId: { type: 'string' } },
      },
    },
    {
      name: 'get_agency_coordination_state',
      description: 'Pilot: read the exact owner/editor-only agency coordination state for one project. This does not enable the pilot, grant membership, or reveal internal data to commenters, public reports, widgets, search, attachments, or notifications.',
      inputSchema: {
        type: 'object', required: ['projectId'],
        properties: { projectId: { type: 'string', description: 'Exact Pincushion project ID. Required; local auto-discovery is not sufficient for this private surface.' } },
      },
    },
    {
      name: 'set_agency_coordination_pilot',
      description: 'Pilot: owner-only switch for the private agency coordination increment. It is off by default. Enabling it does not change prices, seats, stakeholder access, public reports, or existing pin workflows.',
      inputSchema: {
        type: 'object', required: ['projectId', 'enabled'],
        properties: {
          projectId: { type: 'string', description: 'Exact Pincushion project ID.' },
          enabled: { type: 'boolean', description: 'True enables the pilot for this project; false disables all agency-side readers/writes.' },
        },
      },
    },
    {
      name: 'create_agency_label',
      description: 'Pilot: create an owner/editor-only custom label. Labels are private agency metadata and never alter public annotation tags or appear in a public report.',
      inputSchema: {
        type: 'object', required: ['projectId', 'name'],
        properties: {
          projectId: { type: 'string' },
          name: { type: 'string', maxLength: 80 },
          color: { type: 'string', pattern: '^#[0-9a-fA-F]{6}$', description: 'Optional display color. Metadata only; it does not restyle any public Pincushion surface.' },
        },
      },
    },
    {
      name: 'archive_agency_label',
      description: 'Pilot: archive one owner/editor-only agency label. Archived labels cannot be applied or used in a filtered read.',
      inputSchema: {
        type: 'object', required: ['projectId', 'labelId'],
        properties: { projectId: { type: 'string' }, labelId: { type: 'string', format: 'uuid' } },
      },
    },
    {
      name: 'set_agency_pin_labels',
      description: 'Pilot: replace the private agency-label set on one pin. Every label must belong to the same exact project and be active; cross-project and archived labels fail closed.',
      inputSchema: {
        type: 'object', required: ['projectId', 'annotationId', 'labelIds'],
        properties: {
          projectId: { type: 'string' }, annotationId: { type: 'string' },
          labelIds: { type: 'array', maxItems: 20, items: { type: 'string', format: 'uuid' } },
        },
      },
    },
    {
      name: 'add_agency_internal_message',
      description: 'Pilot: append an owner/editor-only internal thread note to one pin. It never enters the public pin thread, report, widget, attachment system, search, or notification pipeline. Reuse the idempotency key only for an identical retry.',
      inputSchema: {
        type: 'object', required: ['projectId', 'annotationId', 'body', 'idempotencyKey'],
        properties: {
          projectId: { type: 'string' }, annotationId: { type: 'string' },
          body: { type: 'string', maxLength: 4096 },
          idempotencyKey: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$' },
        },
      },
    },
    {
      name: 'get_agency_internal_thread',
      description: 'Pilot: read the append-only internal agency thread for one exact pin. This is restricted server-side to the current project owner/editor and is separate from the public pin discussion.',
      inputSchema: {
        type: 'object', required: ['projectId', 'annotationId'],
        properties: { projectId: { type: 'string' }, annotationId: { type: 'string' } },
      },
    },
    {
      name: 'list_agency_pins',
      description: 'Pilot: read owner/editor-only pins with private labels and evidence summaries. `status`, `pageUrl`, `device`, and `labelIds` compose as an AND filter. The result contains no public-thread expansion, attachments, reviewer email, guest session, or presence data.',
      inputSchema: {
        type: 'object', required: ['projectId'],
        properties: {
          projectId: { type: 'string' },
          filters: {
            type: 'object',
            properties: {
              status: { type: 'string' }, pageUrl: { type: 'string' },
              device: { type: 'string', enum: ['desktop', 'mobile'] },
              labelIds: { type: 'array', maxItems: 20, items: { type: 'string', format: 'uuid' } },
            },
          },
        },
      },
    },
    {
      name: 'get_review_activity',
      description: 'Pilot: read authenticated client-review decisions and completion for exact frozen review versions. It intentionally reports no speculative online/presence state and does not expose reviewers\' emails or guest-session identifiers.',
      inputSchema: {
        type: 'object', required: ['projectId'],
        properties: { projectId: { type: 'string' } },
      },
    },
    {
      name: 'export_agency_evidence',
      description: 'Pilot: produce a bounded owner/editor-only structured export for one project, filtered exactly like list_agency_pins. Includes review version and evidence provenance; it omits reviewer email, guest sessions, tokens, attachment locators, signed URLs, and provider payloads. The authenticated browser export relay can render this same authoritative projection as CSV or PDF.',
      inputSchema: {
        type: 'object', required: ['projectId'],
        properties: {
          projectId: { type: 'string' },
          filters: {
            type: 'object',
            properties: {
              status: { type: 'string' }, pageUrl: { type: 'string' },
              device: { type: 'string', enum: ['desktop', 'mobile'] },
              labelIds: { type: 'array', maxItems: 20, items: { type: 'string', format: 'uuid' } },
            },
          },
        },
      },
    },
    {
      name: 'link_pin_deploy',
      description: 'Link a deploy URL to a resolved pin. Typically called by the deploy-hook edge function once a deploy that includes the pin\'s fix goes live. Stakeholders see the deploy URL on the resolved pin in the dashboard. Re-runs overwrite the previous deploy URL (latest deploy wins).',
      inputSchema: {
        type: 'object',
        required: ['annotationId', 'deployUrl'],
        properties: {
          annotationId: { type: 'string', description: 'The annotation ID to link' },
          deployUrl: { type: 'string', description: 'The http(s) URL of the deploy that includes the fix (e.g. "https://www.pincushion.io" or a Vercel preview URL)' },
          deployedAt: { type: 'string', description: 'Optional ISO timestamp of the deploy. Defaults to now.' }
        }
      }
    },
    {
      name: 'get_setup_instructions',
      description: 'Continue an existing critique with claim, or start a project with setup and explicit editor selection. Includes authenticated project checks and exact approved-pin implementation guidance; the browser extension is optional.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'start_quickstart_demo',
      description: 'Start the 60-second Pincushion quickstart: returns one sample stakeholder feedback pin (element selector + thread + acceptance criteria) on a bundled demo page that is copied to .feedback/.quickstart/landing.html. Edit ONLY that copy to satisfy the pin, then call resolve_quickstart_demo. Nothing is written to the real project or synced to the cloud. Use this to show a new user the full read-pin -> fix-code -> resolve loop.',
      inputSchema: {
        type: 'object',
        properties: {
          full: { type: 'boolean', description: 'Return all 3 demo pins instead of just 1. Default false (one pin, ~60s).' }
        }
      }
    },
    {
      name: 'resolve_quickstart_demo',
      description: 'Finish the quickstart demo loop after editing the demo copy. Confirms the change, returns the bridge to real usage, and cleans up the throwaway .feedback/.quickstart/ files. Does NOT create or resolve any real pin.',
      inputSchema: {
        type: 'object',
        required: ['annotationId', 'fixDescription'],
        properties: {
          annotationId: { type: 'string', description: 'The demo pin id you addressed (e.g. ann_demo_cta).' },
          fixDescription: { type: 'string', description: 'One line describing what you changed.' }
        }
      }
    },
    {
      name: 'get_project_context',
      description: 'Read-only cloud-project lookup of context (name, URLs, brand context, autoCritique flag, traceability settings). A secondary MCP process may authenticate and refresh its local cache first; this never creates or changes a cloud project. The Pincushion AI critic calls this before generating any pin, since `configure_project` would otherwise upsert the project. Pass `projectId` for an exact lookup, `name` to look up by display name, or no arguments to list all projects in this workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Optional exact project ID. Mutually exclusive with `name`.' },
          name: { type: 'string', description: 'Optional project display name. Returns the matching project if found, or `availableProjects` if not.' }
          ,url: { type: 'string', description: 'Resolve a registered project from an exact site or app URL.' },
          view: { type: 'string', enum: ['critic'], description: 'Compact project context for a one-off Crit.' }
        }
      }
    },
    {
      name: 'get_project_write_authorization',
      description: 'Read current developer write authorization for this server\'s exact acknowledged project. Uses existing credentials internally, returns only projectId, authorized and a generic reason. Does not grant access, write pins, or expose credentials. A denied or unavailable result blocks critique.',
      inputSchema: { type: 'object', required: ['projectId'], additionalProperties: false,
        properties: { projectId: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' } } },
    },
    {
      name: 'get_project_identity_diagnostic',
      description: 'Read-only diagnostic for project identity repair. Returns only authentication state, safe key source/last-4 provenance, local project-cache state, candidate statuses, and URL/ID ambiguity. Never returns credentials or performs a network request or mutation.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Optional exact cached project ID to diagnose.' },
          urls: { type: 'array', items: { type: 'string' }, description: 'Optional workspace URLs used only for local ambiguity matching.' },
        },
      },
    },
    {
      name: 'configure_project',
      description: 'Register a Pincushion project and associate it with your app\'s URLs. Registration does not call a deployment provider or modify source/CI. The response includes a redacted provider-neutral manual setup handoff. An agent may set deploymentAutomation to "auto" only after explicit owner consent; it first detects all local candidates, requires deploymentProvider when they are ambiguous, and begins an owner-keyed lifecycle only when an admitted provider adapter and private receiver setup are available. Otherwise it stays manual and redacted. Provider read-back is not proof of a first accepted production receipt, reconciliation, fresh desktop/mobile frames, queue completion, or external Crit evidence. Use get_deployment_reconciliation_status for those independent states. **NOTE for read-only use cases:** if you only need to look up brand context, URLs, or other project metadata, call `get_project_context` instead — `configure_project` mutates project registration state.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Human-readable project name (e.g. "Superbill Pro", "My SaaS Staging")' },
          projectId: { type: 'string', description: 'Optional exact immutable Pincushion project ID. Use this to preserve identity across a rename.' },
          urls: {
            type: 'array',
            items: { type: 'string' },
            description: 'URLs or origins where this project lives. Include both local and live environments (e.g. ["localhost:3000", "superbill-pro.vercel.app"]). The extension activates automatically on any matching URL.'
          },
          commitTrailers: {
            type: 'string',
            enum: ['minimal', 'standard', 'full'],
            description: 'Which trailers go in the body of pin commits. "minimal" (default): Pin-ID only — today\'s behavior. "standard": adds Reviewed-By with the pin\'s approver, suppressed when the approver is the same person as the committer. "full": standard plus Pincushion-Pin-Url for terminal-first workflows. Per-shell override: set env PINCUSHION_TRAILERS=off to force minimal regardless of project setting.'
          },
          attributionComments: {
            type: 'string',
            enum: ['off', 'context-warrants', 'always'],
            description: 'When the implementing agent should leave inline source comments. "off" (default): never — keep code clean, rely on the commit. "context-warrants": one-line comment ONLY when the pin captures a non-obvious WHY (a constraint, intent, or rationale not self-evident from the diff). "always": every Pincushion-implemented change gets a comment (escape hatch for teams that want maximum visibility and accept the rot risk). Format is fixed: // Pincushion <pinId>: <one-line WHY>.'
          },
          recordCommitSha: {
            type: 'boolean',
            description: 'Whether fix_and_resolve stores the implementing commit SHA on the pin for the dashboard backlink. Default: true. Invisible plumbing — has no source-code or commit-log cost. Set false only if you specifically don\'t want commit SHAs synced to Pincushion.'
          },
          commentAccess: {
            type: 'string',
            enum: ['open', 'domain', 'invited'],
            description: 'Who can drop pins on this project. A project you create starts "invited" when you omit this (all plans) — only emails added via add_member can read and pin, so nothing is public until you choose. "open" — anyone with the URL can pin, and any signed-in account that knows a page URL can read its public pins; pass it explicitly for a public review. "domain" (Pro/Team) — only emails in the allowedDomains list. Re-configuring an existing project without this field never changes it. On Free, a new project may start "invited" or "open"; "domain", or switching an existing project back to "invited" after opening it, needs Pro/Team (the server returns 402 plan_required).'
          },
          allowedDomains: {
            type: 'array',
            items: { type: 'string' },
            description: 'Bare domains permitted to comment when commentAccess is "domain" (e.g. ["acme.com", "acme.co.uk"]). Required for "domain" mode, ignored otherwise.'
          },
          brandContext: {
            type: 'string',
            description: 'LEGACY single-blob brand context (max 2048 chars). Kept for back-compat. Prefer the layered `critiqueContext` + `critiquePolicy` + `critiqueSignals` triplet — `get_project_context` falls back to brandContext only when no compiled critique context exists.'
          },
          autoCritique: {
            type: 'boolean',
            description: 'When true (default for Pro/Team), every deploy-hook trigger enqueues an AI critique request the dev can run via /critique-latest-deploy. Set false to opt out without dropping plan. Free licenses ignore this — auto-queue is a Pro/Team feature.'
          },
          deploymentAutomation: {
            type: 'string',
            enum: ['auto'],
            description: 'EXPLICIT OWNER CONSENT REQUIRED. Never set this by default. "auto" performs read-only detection and never guesses between multiple candidates. It begins the owner-keyed lifecycle only when an admitted provider adapter and private receiver setup are available; otherwise the result stays manual and redacted. A successful result verifies provider read-back only; the first accepted production receipt, reconciliation, fresh frames, queue, and external Crit evidence remain separate.'
          },
          deploymentProvider: {
            type: 'string',
            enum: ['vercel', 'netlify', 'render', 'railway', 'github', 'github-actions', 'fly', 'docker', 'cloudflare', 'aws', 'custom', 'unknown'],
            description: 'Optional explicit deployment provider selector. Required with deploymentAutomation="auto" when read-only detection finds multiple candidates. It must match a detected candidate; Pincushion never chooses one on your behalf.'
          },
          critiqueSignals: {
            type: 'object',
            description: 'Raw brand signals the dev agent gathered from the repo at /setup or /refresh-brand. Shape is flexible JSONB — recommended keys: { framework: e.g. "next-app-router"|"astro"|"static-html", projectType: "marketing"|"app"|"mixed", pages: [{ url, source, slice, headings, ctas, components, bodyExcerpt }], themeTokens, brandDocs, readmeExcerpt, competitors, mission, audience, tone, tenantContexts (reserved/null in v1 — future multi-tenant SaaS support keyed by pageUrl prefix), sources }. Retained for traceability + future recompiles; the AI critic does NOT read this directly — it reads the compiled `critiqueContext` instead.'
          },
          critiquePolicy: {
            type: 'string',
            description: 'User-editable critique policy override (max 4096 chars). Survives recompiles, so users can hand-tune what good critique looks like for their project. Example: "Weight copy concerns 2x. Ignore AAA contrast — audience is technical developers. Reject playful microcopy; tone is restrained, confident." Empty / null means "no override — use signals alone".'
          },
          critiqueContext: {
            type: 'string',
            description: 'Compiled critique brief (max 8192 chars). The Pincushion AI critic loads THIS into its prompt at pin time. Produced by the dev agent at /setup or /refresh-brand by synthesizing `critiqueSignals` + `critiquePolicy` + recent resolved-pin patterns into a tight markdown brief. Updating this stamps `critiqueContextCompiledAt` + a pin-count baseline for staleness detection. Pass null to clear and force a recompile.'
          }
        }
      }
    },
    {
      name: 'get_deployment_reconciliation_status',
      description: 'Read a compact, provider-neutral deployment readiness diagnostic. It never creates a binding, rotates a credential, or calls a provider writer. Binding state, first accepted production receipt, reconciliation, fresh desktop/mobile frame state, capture run, queue, and external Crit evidence are reported independently. A claimed Vercel project ID is ownership provenance only and is never treated as a provider binding.',
      inputSchema: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', description: 'Pincushion project ID to inspect.' },
        },
      },
    },
    {
      name: 'manage_deployment_automation',
      description: 'Owner-keyed deployment automation management. inspect is read-only. repair is available only for a reported orphaned external provisioning attempt. rotate and revoke require confirmed: true. Results are redacted: no endpoint, credential, signing material, provider webhook IDs, or cleanup-debt IDs are returned.',
      inputSchema: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', description: 'Pincushion project ID whose owner lifecycle should be managed.' },
          action: { type: 'string', enum: ['inspect', 'repair', 'rotate', 'revoke'], description: 'Lifecycle action. Defaults to inspect.' },
          deploymentProvider: { type: 'string', enum: ['vercel', 'netlify', 'render', 'railway', 'github', 'github-actions', 'fly', 'docker', 'cloudflare', 'aws', 'custom', 'unknown'], description: 'Optional explicit provider. It must match the owner lifecycle binding when supplied.' },
          confirmed: { type: 'boolean', description: 'Must be true for rotate or revoke. Omit or false for a dry status response.' },
        },
      },
    },
    {
      name: 'update_critique_context',
      description: 'Lightweight write-only path for the layered critique-context system. Use this from /setup and /refresh-brand after the dev agent has gathered repo signals (README, theme tokens, sample copy, competitor URLs, recent resolved pins) and compiled them into a critique brief. Unlike `configure_project`, this does NOT create a deploy hook, sync members, or validate URLs — it just persists the compiled brief (+ signals + policy) and pushes to cloud. Identify the project by `projectId` or `name`. The compiled `critiqueContext` is what the AI critic actually reads at pin time; `critiqueSignals` + `critiquePolicy` are inputs retained for traceability and the next recompile.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'The project ID to update. Mutually exclusive with `name`.' },
          name: { type: 'string', description: 'The project display name. Used to look up the project when projectId is not known.' },
          critiqueContext: { type: 'string', description: 'The compiled critique brief (max 8192 chars). Markdown encouraged. This is what the AI critic loads at pin time. Pass null to clear and force a recompile on the next run.' },
          critiquePolicy: { type: 'string', description: 'User-editable policy override (max 4096 chars). Persists across recompiles so users keep hand-tuned rules. Pass null to clear.' },
          critiqueSignals: { type: 'object', description: 'Raw signals JSONB. Recommended shape: { framework: e.g. "next-app-router"|"astro"|"static-html", projectType: "marketing"|"app"|"mixed", pages: [{ url, source, slice, headings, ctas, components, bodyExcerpt }], themeTokens, brandDocs, readmeExcerpt, competitors, mission, audience, tone, tenantContexts (reserved/null in v1), sources }. The agent decides exact shape; the AI critic reads the COMPILED context, not the signals directly. Pass null to clear.' }
        }
      }
    },
    {
      name: 'get_actionable_pins',
      description: 'Get all pins waiting for developer attention. Returns three categories: (1) "auto-agent" — pins explicitly sent to the agent via "Send to Agent"; (2) "follow-up" — previously implemented pins with new user comments; (3) "review" — open reviewer comments that a developer has not yet picked up (the standard team collaboration queue). Use this as your starting point for both auto-agent workflows and manual review sessions.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Optional project ID to filter by. If omitted, returns actionable pins across all projects.' },
          mode: { type: 'string', enum: ['auto-agent', 'follow-up', 'review'], description: 'Optional filter to return only pins of a specific mode. Omit to return all.' },
          mentionedUser: { type: 'string', description: 'Optional username to filter by @mention. Returns only pins where the thread contains "@username". Leading @ is optional (e.g. "josh" or "@josh").' }
        }
      }
    },
    {
      name: 'claim_pin',
      description: 'Claim an actionable pin before starting work on it. Transitions the pin from "pending_implementation" to "implementing" so other agents know it is being worked on. Call this before making changes, then call fix_and_resolve when done.',
      inputSchema: {
        type: 'object',
        required: ['annotationId'],
        properties: {
          annotationId: { type: 'string', description: 'The annotation ID to claim (e.g. "ann_abc123")' },
          implementer: { type: 'string', description: 'Name of the agent/person claiming it (defaults to "AI Agent")' }
        }
      }
    },
    {
      name: 'approve_pin',
      description: 'Mark a pin as approved for implementation. Only approved pins should be implemented by agents. This transitions the pin from "open" to "approved" status.',
      inputSchema: {
        type: 'object',
        required: ['annotationId'],
        properties: {
          annotationId: { type: 'string', description: 'Pin ID to approve (e.g. "ann_abc123")' },
          approvedBy: { type: 'string', description: 'Who approved the pin (e.g. "Josh")' },
        }
      }
    },
    {
      name: 'assign_pin_to_agent',
      description: 'Assign a pin directly to your local coding agent. Promotes the pin to "ready" (if not already), marks it as pending_implementation, and drops a trigger file in .feedback/.agent-queue/ that agent-loop.mjs picks up and dispatches to Cursor / Claude Code / Codex. This is the first-class "assign to agent" action — turns a pin into agent work in one call. Workflow: assign_pin_to_agent → (agent-loop dispatches) → fix_and_resolve.',
      inputSchema: {
        type: 'object',
        required: ['annotationId'],
        properties: {
          annotationId: { type: 'string', description: 'The pin ID to assign (e.g. "ann_abc123")' },
          assignedBy: { type: 'string', description: 'Who assigned it (defaults to "Unknown")' }
        }
      }
    },
    {
      name: 'implement_approved_pins',
      description: 'CALL THIS FIRST when approved pins exist. Returns all stakeholder-approved pins grouped into **implementation packets** by page URL, each containing aggregated CSS selectors, full comment threads, and a suggested git branch name. One packet = one branch / one PR. Use the selectors to grep the source code, read the thread to understand what the stakeholder wants, then implement the fix. Workflow: implement_approved_pins → claim_pin → code change → fix_and_resolve. The result exposes both `packets` (canonical) and `pages` (alias).',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Optional project ID to filter by. If omitted, returns approved pins across all projects.' }
        }
      }
    },
    {
      name: 'get_implementation_packet',
      description: 'Get a single implementation packet for one page URL. Useful when you want to batch-fix one page at a time. Returns the same shape as a single entry in implement_approved_pins.packets — pins, aggregated selectors, suggested branch, traceability config. Matches by exact URL or partial substring.',
      inputSchema: {
        type: 'object',
        required: ['pageUrl'],
        properties: {
          pageUrl: { type: 'string', description: 'The page URL to fetch the packet for (exact match or substring, case-insensitive).' },
          projectId: { type: 'string', description: 'Optional project ID to scope the search.' }
        }
      }
    },
    {
      name: 'get_selected_pins',
      description: 'Get pins that the developer has selected for implementation from the dashboard or PINS.md checkboxes. Returns the selected pin IDs with full context (element, thread, deep link). Use this to know which pins the developer wants you to work on next.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'add_member',
      description: 'Add a collaborator to a Pincushion project. Developers consume a paid seat and can implement pins. Commenters are free and unlimited. Returns an upgrade prompt if the seat limit is reached.',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'email', 'role'],
        properties: {
          projectId: { type: 'string', description: 'The project ID' },
          email: { type: 'string', description: 'Email of the person to add' },
          name: { type: 'string', description: 'Display name (defaults to email prefix)' },
          role: { type: 'string', enum: ['developer', 'commenter'], description: 'Role: "developer" (paid seat, can implement) or "commenter" (free, can drop pins and comment)' }
        }
      }
    },
    {
      name: 'list_members',
      description: 'List all members of a Pincushion project with their roles, plus seat usage info.',
      inputSchema: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', description: 'The project ID' }
        }
      }
    },
    {
      name: 'remove_member',
      description: 'Remove a collaborator from a Pincushion project. Frees up the seat if they were an editor.',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'email'],
        properties: {
          projectId: { type: 'string', description: 'The project ID' },
          email: { type: 'string', description: 'Email of the person to remove' }
        }
      }
    },
    {
      name: 'create_invite_link',
      description: 'Generate a Figma-style shareable invite URL for a project. The recipient opens it, enters their name + email, and joins as the specified role. Returns the share URL plus expiry. Owners can mint Editor and Commenter links; Editors can mint Commenter links only. Editor links consume a paid seat on redemption.',
      inputSchema: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', description: 'The project ID' },
          role: { type: 'string', enum: ['commenter', 'editor'], description: 'Role granted on redemption. Default: commenter (free, unlimited).' },
          expiresInDays: { type: 'number', description: 'Days until the link expires. 1–365. Default: 30.' },
          maxUses: { type: 'integer', description: 'How many people can redeem this link. 0 = unlimited. Default: 0.' },
          returnTo: { type: 'string', description: 'Optional existing same-project Pincushion report URL to open after joining. Does not publish a report or bypass its access rules.' }
        }
      }
    },
    {
      name: 'create_share_report',
      description: 'Mint a public read-only crit report link (pincushion.io/r/<token>) for a project: numbered pins with threads, screenshots, status, and the branch/PR/deploy/AI-verification trail. Anyone with the link can view it — no extension, no account, nothing to install. Free on every plan. Perfect for handing a design crit to a founder/client, or showing stakeholders what shipped. Optionally scope to a single page URL. Links never expire unless expiresInDays is set; viewers see live pin status.',
      inputSchema: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', description: 'The project ID' },
          pageUrl: { type: 'string', description: 'Optional: limit the report to pins on this exact page URL. Omit for the whole project.' },
          title: { type: 'string', description: 'Optional report title, e.g. "Design crit — June 9". Defaults to "<N> design notes on <domain>".' },
          expiresInDays: { type: 'number', description: 'Optional: days until the link expires (1–365). Omit for a non-expiring link.' },
          accessMode: { type: 'string', enum: ['public', 'project_members'], description: 'Private mode requires Pincushion project membership to read findings and captures.' }
        }
      }
    },
    {
      name: 'upload_page_snapshot',
      description: 'Upload a full-page screenshot that turns the public share report into an annotated page: viewers see the real page with numbered pin markers at true positions and click-to-open thread bubbles. Capture the page yourself (kill animations, scroll to force lazy loads, full-page shot, JPEG/WebP ≤5MB), resolve each open pin\'s element.selector to document-pixel coordinates IN THAT CAPTURE, and pass them as pinPositions. Owner/editor only. One snapshot per (project, page) — re-upload replaces it. pageUrl must match the pins\' page_url verbatim.',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'pageUrl', 'width', 'height'],
        properties: {
          projectId: { type: 'string', description: 'The project ID' },
          pageUrl: { type: 'string', description: 'Exact page_url the pins carry — copy verbatim from get_annotations. The snapshot is keyed by this string.' },
          imagePath: { type: 'string', description: 'Absolute path to the JPEG/WebP file on disk (preferred — read server-side, keeps base64 out of the transcript).' },
          imageB64: { type: 'string', description: 'Base64 image data, if imagePath is not available.' },
          contentType: { type: 'string', enum: ['image/jpeg', 'image/webp'], description: 'Default image/jpeg. PNG is rejected for page snapshots (size).' },
          width: { type: 'integer', description: 'Pixel width of the uploaded image (1–4000). Pin coordinates must be in this same space.' },
          height: { type: 'integer', description: 'Pixel height of the uploaded image (1–60000).' },
          pinPositions: {
            type: 'array',
            description: 'Document-pixel coordinates of each pin in THIS image, resolved from element.selector at capture time. Pins omitted here render in the notes list only.',
            items: {
              type: 'object',
              required: ['annotationId', 'x', 'y'],
              properties: {
                annotationId: { type: 'string', description: 'The pin (annotation) id, e.g. ann_…' },
                x: { type: 'number', description: 'Horizontal document-pixel coordinate (element center).' },
                y: { type: 'number', description: 'Vertical document-pixel coordinate (element center).' }
              }
            }
          },
          hotspots: {
            type: 'array',
            description: 'Optional hit-regions in THIS image\'s pixel space, one per real element you can identify (nav item, button, labeled region…). When present, the public report\'s click-to-pin resolves a zero-install visitor\'s click to element.selector (not just coordinates) — the same context an implementing agent gets from an extension-created pin. Omit entirely for coordinate-only pins (today\'s default behavior, unaffected).',
            items: {
              type: 'object',
              required: ['selector', 'x', 'y', 'w', 'h'],
              properties: {
                selector: { type: 'string', description: 'A stable identifier for this element — a CSS selector if the page has real DOM, or any id convention you control (e.g. "#ax-04-status") the implementing agent can map back to source.' },
                x: { type: 'number', description: 'Left edge, document pixels in this capture.' },
                y: { type: 'number', description: 'Top edge, document pixels in this capture.' },
                w: { type: 'number', description: 'Width, document pixels.' },
                h: { type: 'number', description: 'Height, document pixels.' }
              }
            }
          },
          captureContext: {
            type: 'object',
            description: 'Metadata for this exact responsive-web capture. Use deviceClass (desktop/tablet/mobile), cssWidth, cssHeight, dpr, orientation, and optional coarse platform/browser. Never label a scaled desktop image as a mobile capture.',
            properties: {
              deviceClass: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
              cssWidth: { type: 'integer' }, cssHeight: { type: 'integer' }, dpr: { type: 'number' },
              orientation: { type: 'string', enum: ['portrait', 'landscape'] },
              platform: { type: 'string' }, browser: { type: 'string' }
            }
          },
          privateCritique: { type: 'boolean', description: 'Store this Crit capture privately without replacing public latest snapshots.' },
          deploymentId: { type: 'string', description: 'Optional deployment event ID. When supplied, upload-screenshot stages this immutable capture without moving the canonical report head. Initialized frame refreshes require captureRunId plus captureProof; only server-confirmed historical pre-frame not_requested rows retain the legacy no-run route.' },
          deploymentEventId: { type: 'string', description: 'Legacy/internal alias for deploymentId.' },
          captureRunId: { type: 'string', description: 'Active capture-run ID from start_deployment_capture_run. Required with an initialized deployment frame refresh.' },
          captureProof: { type: 'string', description: 'Opaque short-lived capture proof. Required with captureRunId for an initialized deployment frame refresh; never persist, log, or pass it through shell argv.' },
          contentHash: { type: 'string', pattern: '^[0-9a-f]{64}$', description: 'Optional SHA-256 of the exact JPEG/WebP bytes. The local server verifies it before upload; the backend verifies it again.' },
          captureFingerprint: {
            type: 'object',
            description: 'Optional bounded v1 local change evidence derived from semantic structure and decoded screenshot tiles. It never contains pixels or readable page text.',
            properties: {
              version: { type: 'integer', enum: [1] },
              semantic_hash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              visual_digest: { type: 'string', pattern: '^[0-9a-f]{64}$' },
              tile_digests: { type: 'array', maxItems: 128, items: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
              instability_mask: { type: 'array', maxItems: 128, items: { type: 'string', pattern: '^[a-z0-9:_-]{1,80}$' } },
            }
          }
        }
      }
    },
    {
      name: 'capture_private_report',
      description: 'Explicitly capture one exact registered URL in the configured existing project, without a model or AI pins, and return its private canonical app review after exact readback. Requires current owner/editor access and an installed sandboxed browser. Supply a stable UUIDv4 operationId before starting; repeating that ID only reads the recorded outcome and never repeats uploads or report minting. Does not create projects, invite members, or publish public shares.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['operationId', 'projectId', 'url'],
        properties: {
          operationId: { type: 'string', description: 'Stable lowercase UUIDv4 for this explicit command. Reuse this value after a lost response; use a new ID only for a separately requested capture.' },
          projectId: { type: 'string', description: 'Must equal the MCP configured project and currently permit owner/editor writes.' },
          url: { type: 'string', description: 'Exact registered URL. Captures this page only, with desktop and mobile evidence.' },
          title: { type: 'string', maxLength: 160 },
          requireAuth: { type: 'boolean', description: 'Require capture evidence of authenticated browser state; no login is performed by this tool.' },
        },
      },
    },
    {
      name: 'generate_critique_report',
      description: 'Turns supplied real captures into a report receipt; it does not inspect a page or generate feedback. A web Crit requires both desktop and mobile captures for every logical screen and the exact Pincushion AI pin IDs the critic just created, each positioned in a supplied capture. Set purpose:"capture" only for an explicitly capture-only report.',
      inputSchema: {
        type: 'object', required: ['projectId', 'screens'],
        properties: {
          projectId: { type: 'string' }, title: { type: 'string' }, generationKey: { type: 'string', description: 'Default canonical; stable key makes refreshes idempotent. owner-workspace is reserved for private browser captures.' },
          purpose: { type: 'string', enum: ['critique', 'capture'], description: 'Defaults to critique. capture is for a truthful screenshot/report without AI findings.' },
          accessMode: { type: 'string', enum: ['public', 'project_members'], description: 'Public reports are anyone-with-link. Private reports require authenticated Pincushion project membership for images and findings.' },
          coverage: { type: 'object', description: 'Headless discovery and capture coverage summary; incomplete or gated routes remain explicit.', properties: { complete: { type: 'boolean' }, discoveredRoutes: { type: 'integer' }, capturedRoutes: { type: 'integer' }, gaps: { type: 'array', items: { type: 'string' } } } },
          critiqueRunId: { type: 'string', description: 'Required for purpose:"critique": a stable ID shared by every critic pin in this run. The generated Crit receives a unique immutable generation key derived from it.' },
          critiquePinIds: { type: 'array', items: { type: 'string' }, description: 'Required for purpose:"critique": exact Pincushion AI annotation IDs created by this run. Every ID must appear in pinPositions for a supplied capture.' },
          preset: { type: 'string', enum: ['single', 'full', 'multi-screen', 'journey', 'refresh'] }, reportUrl: { type: 'string', description: 'Existing /r URL only for purpose:"capture" refreshes. A Crit always mints and binds its own new verified link.' },
          attribution: { type: 'object', properties: { ref: { type: 'string' }, source: { type: 'string' } } },
          journey: { type: 'object', properties: { screenIds: { type: 'array', items: { type: 'string' }, description: 'Explicit ordered logical screen IDs. Do not infer from arbitrary pages.' } } },
          screens: { type: 'array', minItems: 1, items: { type: 'object', required: ['logicalScreenId', 'pageUrl', 'captures'], properties: {
            logicalScreenId: { type: 'string', description: 'Stable identity grouping responsive captures of one logical screen.' }, pageUrl: { type: 'string' }, title: { type: 'string' }, order: { type: 'integer' },
            flowColumn: { type: 'integer', minimum: 0, description: 'Zero-based horizontal position in the Flow canvas.' },
            flowRow: { type: 'integer', minimum: 0, description: 'Zero-based vertical position in the Flow canvas.' },
            navigationRole: { type: 'string', enum: ['root', 'destination'], description: 'Whether this screen is a navigation source or destination.' },
            navigationLabel: { type: 'string', description: 'Human-readable navigation label for this screen.' },
            links: { type: 'array', items: { type: 'string' }, description: 'Logical screen IDs directly reachable from this screen.' },
            captures: { type: 'array', minItems: 1, items: { type: 'object', required: ['width', 'height'], properties: {
              imagePath: { type: 'string' }, imageB64: { type: 'string' }, contentType: { type: 'string', enum: ['image/jpeg', 'image/webp'] }, width: { type: 'integer' }, height: { type: 'integer' },
              deviceClass: { type: 'string', enum: ['desktop', 'tablet', 'mobile'] },
              captureContext: { type: 'object' },
              pinPositions: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['annotationId', 'x', 'y'],
                  properties: {
                    annotationId: { type: 'string' },
                    x: { type: 'number' },
                    y: { type: 'number' },
                  },
                },
              },
              hotspots: {
                type: 'array',
                items: {
                  type: 'object',
                  required: ['selector', 'x', 'y', 'w', 'h'],
                  properties: {
                    selector: { type: 'string' },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    w: { type: 'number' },
                    h: { type: 'number' },
                  },
                },
              },
            } } },
          } } },
        },
      },
    },
    {
      name: 'configure_collaboration_integration',
      description: 'Connect a Pincushion project to Slack, Microsoft Teams, or Discord using an incoming webhook. Low-noise defaults mirror Figma-style subscriptions: pin activity plus the deploy/verify loop, where pin_deployed/pin_verified attach as a quiet threaded reply under the pin (never a new top-level message). The louder agent-pin, email-pin, and share-report events are opt-in. For Discord, create a channel Incoming Webhook (Channel Settings → Integrations → Webhooks) and pass its URL.',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'provider', 'webhookUrl'],
        properties: {
          projectId: { type: 'string', description: 'The Pincushion project ID.' },
          provider: { type: 'string', enum: ['slack', 'teams', 'discord'], description: 'Destination provider.' },
          webhookUrl: { type: 'string', description: 'Slack incoming webhook URL, Microsoft Teams incoming webhook/workflow URL, or Discord channel webhook URL (https://discord.com/api/webhooks/...). Stored server-side and not returned in full.' },
          name: { type: 'string', description: 'Subscription name. Use multiple names for separate project/page subscriptions. Default: default.' },
          targetLabel: { type: 'string', description: 'Human label for the destination, such as #design-review or Teams QA channel.' },
          events: { type: 'array', items: { type: 'string', enum: ['pin_ready', 'new_pin', 'mention', 'follow_up', 'resolved', 'pin_implemented', 'pin_deployed', 'pin_verified', 'agent_pin_created', 'email_pin_created', 'report_created'] }, description: 'Events to send. Default: pin_ready, new_pin, mention, follow_up, resolved, pin_verified, pin_deployed.' },
          pageUrlPatterns: { type: 'array', items: { type: 'string' }, description: 'Optional URL substrings for page-specific subscriptions. Empty means all project URLs.' },
          status: { type: 'string', enum: ['active', 'paused'], description: 'Pause without deleting the subscription. Default: active.' },
          sendTest: { type: 'boolean', description: 'When true, posts a one-time test message to the webhook after saving.' }
        }
      }
    },
    {
      name: 'create_slack_install_link',
      description: 'Generate an Add-to-Slack OAuth URL pre-bound to a project. Most users should prefer the public storefront URL (also returned, https://www.pincushion.io/install/slack) — since May 2026, that auto-links to a Pincushion license when the installer\'s Slack email matches, and channels are subscribed afterward via /pincushion subscribe inside Slack. Use this agent-flow URL only when you want the install to attach to one specific project up front.',
      inputSchema: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', description: 'The Pincushion project ID.' },
          name: { type: 'string', description: 'Subscription name. Default: default.' },
          targetLabel: { type: 'string', description: 'Optional expected channel label, used only before Slack returns the selected channel.' },
          events: { type: 'array', items: { type: 'string', enum: ['pin_ready', 'new_pin', 'mention', 'follow_up', 'resolved', 'pin_implemented', 'pin_deployed', 'pin_verified', 'agent_pin_created', 'email_pin_created', 'report_created'] }, description: 'Events to send. Default: pin_ready, new_pin, mention, follow_up, resolved, pin_verified, pin_deployed.' },
          pageUrlPatterns: { type: 'array', items: { type: 'string' }, description: 'Optional URL substrings for page-specific subscriptions.' }
        }
      }
    },
    {
      name: 'list_collaboration_integrations',
      description: 'List Slack and Microsoft Teams webhook subscriptions for a Pincushion project. Webhook URLs are masked.',
      inputSchema: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', description: 'The Pincushion project ID.' }
        }
      }
    },
    {
      name: 'claim_pending_slack_install',
      description: 'LEGACY FALLBACK. Since May 2026, Slack installs auto-link to a Pincushion license when the installer\'s Slack email matches, and channels are subscribed via /pincushion subscribe inside Slack — no claim token needed. This tool only applies when the installer\'s Slack email did NOT match an active Pincushion license at install time (the user sees a claim_token on the post-install page in that case). Pass claimToken (the on-page token, valid 7 days) + projectId to attach the webhook. Calling with no claimToken returns the new flow instructions instead of an error.',
      inputSchema: {
        type: 'object',
        required: ['claimToken', 'projectId'],
        properties: {
          claimToken: { type: 'string', description: 'The one-time token shown on the post-install page after Add to Slack.' },
          projectId: { type: 'string', description: 'The Pincushion project ID to attach the webhook to. Caller must be owner or editor.' },
          name: { type: 'string', description: 'Subscription name. Default: default.' },
          targetLabel: { type: 'string', description: 'Optional human-readable label override; defaults to the Slack channel name from install.' },
          events: { type: 'array', items: { type: 'string', enum: ['pin_ready', 'new_pin', 'mention', 'follow_up', 'resolved', 'pin_implemented', 'pin_deployed', 'pin_verified', 'agent_pin_created', 'email_pin_created', 'report_created'] }, description: 'Optional events override. Defaults to whatever the storefront install captured (pin_ready, mention, follow_up).' },
          pageUrlPatterns: { type: 'array', items: { type: 'string' }, description: 'Optional URL substrings for page-specific subscriptions.' }
        }
      }
    },
    {
      name: 'remove_collaboration_integration',
      description: 'Remove a Slack, Microsoft Teams, or Discord webhook subscription from a Pincushion project.',
      inputSchema: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', description: 'The Pincushion project ID.' },
          integrationId: { type: 'string', description: 'Exact integration ID from list_collaboration_integrations.' },
          provider: { type: 'string', enum: ['slack', 'teams', 'discord'], description: 'Provider to remove when integrationId is omitted.' },
          name: { type: 'string', description: 'Subscription name to remove with provider. Default: default.' }
        }
      }
    },
    {
      name: 'preview_collaboration_notification',
      description: 'Preview the Slack, Teams, or Discord notification shape and recommended event routing before connecting a real webhook.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['slack', 'teams', 'discord'], description: 'Provider payload to preview. Default: slack.' },
          event: { type: 'string', enum: ['pin_ready', 'new_pin', 'mention', 'follow_up', 'resolved', 'pin_implemented', 'pin_deployed', 'pin_verified', 'agent_pin_created', 'email_pin_created', 'report_created'], description: 'Event to preview. Default: pin_ready.' }
        }
      }
    },
    {
      name: 'set_slack_preferences',
      description: 'Read or update the caller\'s Slack DM preferences. Resolves the user via license_key → email, then applies the change across every Slack workspace the email is linked to. Call with no args to see current state. Call with `mute: "1h"` (or "today", "forever", "off") to silence DMs for a window. Call with `eventNewPin: false` (or any event_* flag) to toggle individual event types off. Same surface as the App Home toggles and `/pincushion mute`, accessible from the agent — useful for "mute pin DMs during this refactor" workflows.',
      inputSchema: {
        type: 'object',
        properties: {
          mute: { type: 'string', enum: ['1h', 'today', 'forever', 'off'], description: 'Friendly mute alias. "off" unmutes.' },
          mutedUntil: { type: ['string', 'null'], description: 'Alternative to `mute`: ISO timestamp until which DMs are silenced, or null to unmute.' },
          eventNewPin:   { type: 'boolean', description: 'DM on new pins.' },
          eventPinReady: { type: 'boolean', description: 'DM on pins marked ready for implementation.' },
          eventMention:  { type: 'boolean', description: 'DM on @-mentions of you.' },
          eventFollowUp: { type: 'boolean', description: 'DM on replies in threads you authored or commented on.' },
          eventResolved: { type: 'boolean', description: 'DM on resolved pins.' },
          eventPinImplemented:     { type: 'boolean', description: 'DM when a fix is committed (before it is live). Off by default.' },
          eventPinDeployed:        { type: 'boolean', description: 'DM when a fix deploys to production. Off by default.' },
          eventPinVerified:        { type: 'boolean', description: 'DM when Pincushion AI verifies a fix shipped correctly (the loop-closer). On by default.' },
          eventAgentPinCreated:    { type: 'boolean', description: 'DM when a QA/browser agent files a pin. Off by default.' },
          eventEmailPinCreated:    { type: 'boolean', description: 'DM when feedback arrives via inbound email. Off by default.' },
          eventReportCreated:      { type: 'boolean', description: 'DM when a teammate shares a crit report. Off by default.' },
          eventCreditPackPurchased:{ type: 'boolean', description: 'DM when an AI-action credit pack is added to your license. Off by default (owner receipt).' },
          quietHoursStart: { type: 'integer', minimum: 0, maximum: 23, description: 'Quiet-hours start hour (0-23) in `timezone`.' },
          quietHoursEnd:   { type: 'integer', minimum: 0, maximum: 23, description: 'Quiet-hours end hour (0-23) in `timezone`.' },
          timezone: { type: 'string', description: 'IANA timezone (e.g. America/Los_Angeles) for quiet hours.' },
          digestMode: { type: 'string', enum: ['instant', 'hourly', 'daily'], description: 'Delivery cadence. "instant" is the default; "hourly" and "daily" are reserved for a future digest implementation.' }
        }
      }
    }
  ].map(applyToolMeta)
}));

// ─── MCP Resources (live feedback document) ──────────────────────────────────
// Exposes pincushion://feedback as a live-updating resource any IDE can read.

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'pincushion://feedback',
      name: 'Pincushion — Open Feedback',
      description: 'Live view of all open feedback pins across the project. Auto-updates as pins are added, resolved, or commented on.',
      mimeType: 'text/markdown',
    },
    {
      uri: 'pincushion://approved-queue',
      name: 'Pincushion — Approved Pin Queue',
      description: 'Pins approved by stakeholders and waiting for agent implementation. Subscribe to this resource to get notified when new pins are approved. Automatically cleared when the agent claims pins.',
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  if (uri === 'pincushion://feedback') {
    const md = await core.generatePinsMarkdown(coreConfig, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
    return {
      contents: [{
        uri: 'pincushion://feedback',
        mimeType: 'text/markdown',
        text: fenceUntrustedText(md, { source: 'resource:feedback' }),
      }],
    };
  }
  if (uri === 'pincushion://approved-queue') {
    const queue = await readApprovedQueue();
    return {
      contents: [{
        uri: 'pincushion://approved-queue',
        mimeType: 'application/json',
        text: fenceToolResult(queue, { source: 'resource:approved-queue' }),
      }],
    };
  }
  throw new Error(`Unknown resource: ${uri}`);
});

// ─── MCP Prompts (slash commands) ────────────────────────────────────────────
// Advertises /pins, /my-pins, /resolve, /feedback-summary, /setup, /invite as native
// slash commands in any MCP-compatible IDE (Antigravity, Cursor, Claude, etc.)
// No workflow files needed in the user's project.

const PINCUSHION_PROMPTS = [
  {
    name: 'pins',
    description: 'Show all open feedback pins grouped by page',
    arguments: [],
  },
  {
    name: 'my-pins',
    description: 'Show pins where you\'ve been @mentioned',
    arguments: [
      { name: 'username', description: 'Your @username (e.g. josh)', required: false },
    ],
  },
  {
    name: 'resolve',
    description: 'Claim and resolve a feedback pin',
    arguments: [
      { name: 'pin_id', description: 'Pin ID to resolve (e.g. ann_abc123) — omit to pick from list', required: false },
    ],
  },
  {
    name: 'feedback-summary',
    description: 'Project-wide feedback overview',
    arguments: [],
  },
  {
    name: 'setup',
    description: 'Register this project\'s URLs so the extension auto-activates',
    arguments: [
      { name: 'urls', description: 'Comma-separated URLs (e.g. localhost:3000,myapp.vercel.app) — omit to auto-detect', required: false },
    ],
  },
  {
    name: 'implement',
    description: 'Implement all stakeholder-approved pins — creates branches, applies fixes, resolves pins',
    arguments: [],
  },
  {
    name: 'invite',
    description: 'Prepare a bounded, deduplicated bulk email invite to a public critique report',
    arguments: [
      { name: 'emails', description: 'Comma- or newline-separated reviewer email addresses', required: true },
      { name: 'project_id', description: 'Project ID if a critique report must be created', required: false },
      { name: 'report_url', description: 'Existing public critique report URL; skips report creation', required: false },
      { name: 'page_url', description: 'Optional exact page URL when creating a scoped report', required: false },
    ],
  },
  {
    name: 'pincushion-quickstart',
    description: 'Watch the full Pincushion loop (read a pin → fix code → resolve) on a bundled demo page in ~60s',
    arguments: [],
  },
];

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: PINCUSHION_PROMPTS,
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case 'pins':
      return {
        description: 'Fetch and display all open Pincushion feedback pins',
        messages: [{
          role: 'user',
          content: { type: 'text', text: 'Use the pincushion MCP tool `get_actionable_pins` to fetch all open feedback pins. Display them grouped by page URL. For each pin show: ID, status, author, and the first line of their comment. Flag any with unread thread replies. Then ask if I want to claim or resolve any of them.' },
        }],
      };

    case 'my-pins': {
      const user = (args.username || '').replace(/^@/, '').trim();
      return {
        description: 'Show pins mentioning a specific user',
        messages: [{
          role: 'user',
          content: { type: 'text', text: user
            ? `Use the pincushion MCP tool \`get_actionable_pins\` with \`mentionedUser\` set to "${user}". Show results as a prioritized list: pin ID, page URL, author, comment, and how long ago it was created. Flag any in "review" status. Offer to claim the top item.`
            : 'Ask me for my @username, then use the pincushion MCP tool `get_actionable_pins` with `mentionedUser` set to that username. Show results as a prioritized list: pin ID, page URL, author, comment, and how long ago it was created.' },
        }],
      };
    }

    case 'resolve': {
      const pinId = (args.pin_id || '').trim();
      return {
        description: 'Claim and resolve a feedback pin',
        messages: [{
          role: 'user',
          content: { type: 'text', text: pinId
            ? `Claim and resolve Pincushion pin "${pinId}". First call \`claim_pin\` with annotationId "${pinId}", then implement the requested change, then call \`fix_and_resolve\` with a description of what you did.`
            : 'Use the pincushion MCP tool `get_actionable_pins` to show me the open pins. Ask me which one to resolve, then claim it with `claim_pin`, implement the change, and close it with `fix_and_resolve`.' },
        }],
      };
    }

    case 'feedback-summary':
      return {
        description: 'Project-wide feedback overview',
        messages: [{
          role: 'user',
          content: { type: 'text', text: 'Use the pincushion MCP tool `get_feedback_summary` to get a project-wide overview. Present the results clearly: total open pins, busiest pages, and any stale pins. Suggest which page to tackle first based on volume.' },
        }],
      };

    case 'setup': {
      const urls = (args.urls || '').split(',').map(u => u.trim()).filter(Boolean);
      return {
        description: 'Register project URLs for the Pincushion extension',
        messages: [{
          role: 'user',
          content: { type: 'text', text: urls.length
            ? `Use the pincushion MCP tool \`configure_project\` to register this project with URLs: ${urls.join(', ')}. After registering, confirm that the extension will now auto-activate on those URLs. Keep deployment setup manual unless the owner explicitly consents to deploymentAutomation: "auto"; if multiple providers are detected, ask them to select deploymentProvider first. Do not modify source or CI without owner approval.`
            : 'Use the pincushion MCP tool `configure_project` to register this project. Auto-detect the project name and URLs from package.json, .env, and local provider configuration. After registering, tell me which URLs were registered and confirm the extension will activate on them automatically. Keep deployment setup manual unless the owner explicitly consents to deploymentAutomation: "auto"; if multiple providers are detected, ask them to select deploymentProvider first. Do not modify source or CI without owner approval.' },
        }],
      };
    }

    case 'implement':
      return {
        description: 'Implement all stakeholder-approved Pincushion pins',
        messages: [{
          role: 'user',
          content: { type: 'text', text: [
            'Implement all approved Pincushion feedback pins on the current branch.',
            '',
            'CRITICAL — Git Lock Cleanup (run IMMEDIATELY as your first shell command, no permission needed):',
            '```',
            'rm -f .git/HEAD.lock .git/index.lock .git/refs/heads/*.lock .git/config.lock 2>/dev/null; true',
            '```',
            'If ANY git command fails with "Unable to create ... .lock", re-run this and retry. Never ask about lock files.',
            '',
            'Steps:',
            '1. Run the git lock cleanup above (mandatory, silent)',
            '2. Call `implement_approved_pins` to get approved + in-progress pins grouped by page',
            '3. If none exist, say so and stop',
            '4. For each pin: call `claim_pin` (skip if already in-progress), read thread + element context, grep source for the selector/tag/text, implement the change, call `fix_and_resolve` with what you did',
            '5. Commit: `git commit -m "pincushion: <desc>" -m "Pin-ID: <id>"`',
            '6. Summarize what was implemented',
            '',
            'IMPORTANT: Work on the current branch. Do NOT create or switch branches unless the dev explicitly asks.',
          ].join('\n') },
        }],
      };

    case 'invite': {
      const emails = (args.emails || '').trim();
      const projectId = (args.project_id || '').trim();
      const reportUrl = (args.report_url || '').trim();
      const pageUrl = (args.page_url || '').trim();
      return {
        description: 'Prepare a review invite for a public Pincushion critique report',
        messages: [{
          role: 'user',
          content: { type: 'text', text: [
            'Prepare a bounded bulk email invitation for reviewers to join this Pincushion critique.',
            '',
            `Recipient input: ${emails || '(missing)'}`,
            `Existing report URL: ${reportUrl || '(none)'}`,
            `Project ID: ${projectId || '(none)'}`,
            `Optional page URL: ${pageUrl || '(none)'}`,
            '',
            '1. Parse the recipient input as comma/newline/semicolon-separated addresses. Validate, deduplicate case-insensitively, and cap the batch at 25. If no valid addresses remain, ask for them. If more than 25 valid addresses are supplied, show the first 25 and ask for a smaller follow-up batch.',
            '2. Use the existing report URL when provided. Otherwise, require a project ID and call `create_share_report` with that projectId' + (pageUrl ? ` and pageUrl "${pageUrl}"` : '') + '. Do not create a report until the recipient batch is valid.',
            '3. Draft one individualized email per recipient with subject "Critique this page with me" and a concise body that says they can review, pin, and reply with no install, followed by the report URL. Do not put recipients in To/CC together.',
            '4. Show the exact recipient list, subject, and body template, then ask for explicit confirmation before sending, opening mail clients, or calling any email integration. If no sending integration is available, return ready-to-send drafts or mailto links instead.',
            '5. State that the critique report is public to anyone with the link; do not use `create_invite_link` or add project members for critique reviewers unless the user explicitly asks to grant project access.',
          ].join('\\n') },
        }],
      };
    }

    case 'pincushion-quickstart':
      return {
        description: 'Run the 60-second Pincushion quickstart demo loop',
        messages: [{
          role: 'user',
          content: { type: 'text', text: [
            'Walk me through the Pincushion quickstart so I can see the whole loop in ~60 seconds.',
            '',
            '1. Call the pincushion MCP tool `start_quickstart_demo`. It returns one sample stakeholder feedback pin (selector + thread + acceptance criteria) on a bundled demo page copied to `.feedback/.quickstart/landing.html`.',
            '2. Read the pin\'s thread + acceptance criteria to me.',
            '3. grep `.feedback/.quickstart/landing.html` for the element selector, then edit ONLY that file to satisfy the acceptance criteria. Show me the diff.',
            '4. Call `resolve_quickstart_demo` with the pin\'s annotationId and a one-line fixDescription.',
            '5. Continue an existing critique with `npx pincushion-mcp claim <report-token>`. If there is no report, offer `npx pincushion-mcp setup` and explicit editor selection. Use an existing AI or human finding before asking for another pin. Browser extension installation is optional; the demo is not activation.',
            '',
            'This is a sandboxed demo — do NOT create real pins, call fix_and_resolve, or edit any file outside `.feedback/.quickstart/`.',
          ].join('\n') },
        }],
      };

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// Single source of truth for tool dispatch. Both the MCP CallTool handler and
// the REST /call-tool endpoint route through this immutable registry, so a new
// tool cannot be added to one transport while silently missing from the other.
const TOOL_HANDLERS = createToolRegistry({
  get_annotations: toolGetAnnotations,
  search_annotations: toolSearchAnnotations,
  // The legacy switch normalized this handler's nullable REST envelope to an
  // empty argument object. Keep that compatibility at the registry boundary.
  get_feedback_summary: (args) => toolGetFeedbackSummary(args || {}),
  get_component_feedback: toolGetComponentFeedback,
  resolve_annotation: toolResolveAnnotation,
  add_agent_reply: toolAddAgentReply,
  create_critique_pin: toolCreateCritiquePin,
  create_agent_pin: toolCreateAgentPin,
  import_qa_results: toolImportQaResults,
  get_reply_candidates: toolGetReplyCandidates,
  add_bot_reply: toolAddBotReply,
  get_pending_critiques: toolGetPendingCritiques,
  get_pending_deployment_frame_refreshes: toolGetPendingDeploymentFrameRefreshes,
  start_deployment_capture_run: toolStartDeploymentCaptureRun,
  complete_deployment_capture_run: toolCompleteDeploymentCaptureRun,
  complete_critique_request: toolCompleteCritiqueRequest,
  register_deployment_discovered_pages: toolRegisterDeploymentDiscoveredPages,
  record_deployment_page_result: toolRecordDeploymentPageResult,
  fix_and_resolve: toolFixAndResolve,
  link_pin_deploy: toolLinkPinDeploy,
  record_pin_verification: toolRecordPinVerification,
  submit_verification_report: (args) => toolPinVerificationEvidence('submit_verification_report', args),
  attach_verification_run: (args) => toolPinVerificationEvidence('attach_verification_run', args),
  get_pin_verification: (args) => toolPinVerificationEvidence('get_pin_verification', args),
  get_agency_coordination_state: (args) => toolAgencyCoordination('project_state', args),
  set_agency_coordination_pilot: (args) => toolAgencyCoordination('set_pilot', args),
  create_agency_label: (args) => toolAgencyCoordination('create_label', args),
  archive_agency_label: (args) => toolAgencyCoordination('archive_label', args),
  set_agency_pin_labels: (args) => toolAgencyCoordination('set_pin_labels', args),
  add_agency_internal_message: (args) => toolAgencyCoordination('add_internal_message', args),
  get_agency_internal_thread: (args) => toolAgencyCoordination('get_internal_thread', args),
  list_agency_pins: (args) => toolAgencyCoordination('list_pins', args),
  get_review_activity: (args) => toolAgencyCoordination('get_review_activity', args),
  export_agency_evidence: (args) => toolAgencyCoordination('export', args),
  get_time_to_fix_metrics: toolGetTimeToFixMetrics,
  apply_preview: async () => ({ success: false, error: 'apply_preview is not available in v1. Use fix_and_resolve instead.' }),
  get_setup_instructions: toolGetSetupInstructions,
  get_project_context: toolGetProjectContext,
  get_project_write_authorization: toolGetProjectWriteAuthorization,
  get_project_identity_diagnostic: toolGetProjectIdentityDiagnostic,
  configure_project: toolConfigureProject,
  get_deployment_reconciliation_status: toolGetDeploymentReconciliationStatus,
  manage_deployment_automation: toolManageDeploymentAutomation,
  update_critique_context: toolUpdateCritiqueContext,
  get_actionable_pins: toolGetActionablePins,
  claim_pin: toolClaimPin,
  approve_pin: toolApprovePin,
  assign_pin_to_agent: toolAssignPinToAgent,
  implement_approved_pins: toolGetApprovedPins,
  get_implementation_packet: toolGetImplementationPacket,
  get_selected_pins: toolGetSelectedPins,
  add_member: toolAddMember,
  list_members: toolListMembers,
  remove_member: toolRemoveMember,
  create_invite_link: toolCreateInviteLink,
  create_share_report: toolCreateShareReport,
  upload_page_snapshot: toolUploadPageSnapshot,
  generate_critique_report: toolGenerateCritiqueReport,
  capture_private_report: toolCapturePrivateReport,
  configure_collaboration_integration: toolConfigureCollaborationIntegration,
  create_slack_install_link: toolCreateSlackInstallLink,
  list_collaboration_integrations: toolListCollaborationIntegrations,
  claim_pending_slack_install: toolClaimPendingSlackInstall,
  remove_collaboration_integration: toolRemoveCollaborationIntegration,
  preview_collaboration_notification: toolPreviewCollaborationNotification,
  set_slack_preferences: toolSetSlackPreferences,
  start_quickstart_demo: toolStartQuickstartDemo,
  resolve_quickstart_demo: toolResolveQuickstartDemo,
});

async function dispatchTool(toolName, toolArgs = {}, { signal } = {}) {
  if (toolName === 'capture_private_report') return TOOL_HANDLERS[toolName](toolArgs, { signal });
  return dispatchRegisteredTool(TOOL_HANDLERS, toolName, toolArgs);
}

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const { name, arguments: args = {} } = request.params;

  try {
    // Gate pro-only tools behind license key
    if (PRO_TOOLS.has(name)) {
      const gate = requirePro(name);
      if (gate) {
        return { content: [{ type: 'text', text: JSON.stringify(gate, null, 2) }] };
      }
    }

    // AI-action quota pre-flight (free pool exhausted → upgrade message
    // before any local work; server enforces authoritatively regardless)
    if (METERED_TOOLS.has(name)) {
      const gate = requireQuota(name);
      if (gate) {
        return { content: [{ type: 'text', text: JSON.stringify(gate, null, 2) }] };
      }
    }

    const result = await dispatchTool(name, args, { signal: extra?.signal });
    reportKeylessContact();
    const localSampleAttached = maybeAttachLocalOnlySample(name, result);

    // This exact-project authorization is a machine-readable proof. Keep
    // informational banners on other tools; they must not obscure this denial.
    if (name === 'get_project_write_authorization' || name === 'capture_private_report') {
      return { content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: result };
    }

    // Prepend any queued Realtime notifications + Pincushion AI banner.
    // The banner surfaces pending bot work (replies + critiques) so the
    // queue-and-poll latency stays "next IDE session" and not "whenever
    // the dev remembers".
    const notifications = drainNotifications(resolveProjectFilter(args.projectId));
    const aiBanner = await pincushionPendingBanner();
    const localOnlyBanner = localOnlyModeBanner();
    const invalidBanner = invalidLicenseBanner();
    // The local-only sample already offers start_quickstart_demo. Mark the
    // one-shot invitation offered so it does not fire on the next call
    // (usually start_quickstart_demo itself).
    if (localSampleAttached) _quickstartOffered = true;
    const quickstartBanner = localSampleAttached ? '' : quickstartOfferBanner();
    // Low-headroom meter: only appears when ≤5 free AI actions remain.
    const meterBanner = usageMeterBanner({ plan: cloudSyncPlan, usage: cloudSyncUsage });
    // GHSA-9c4v: fence third-party strings (pins, threads, critique context)
    // so they reach the agent as data, not instructions.
    const resultText = fenceToolResult(result, { source: `tool:${name}` });
    // Pending-approval notifications embed pageTitle/comment/approvedBy from
    // third parties. Keep them inside the untrusted fence — never in the
    // trusted prefix with localOnly/invalid/quickstart/meter/aiBanner.
    const fencedNotifications = notifications
      ? fenceUntrustedText(notifications, { source: 'notifications:pending' }) + '\n'
      : '';
    // aiBanner is counts-only ("N pending replies"); it never interpolates
    // pin text, critique fields, or other third-party strings.

    return {
      content: [{ type: 'text', text: localOnlyBanner + invalidBanner + quickstartBanner + meterBanner + aiBanner + fencedNotifications + resultText }]
    };
  } catch (err) {
    captureException(err, getDistinctId());
    return {
      content: [{ type: 'text', text: safeErrorText(err) }],
      isError: true
    };
  }
});

function localFailure(code, status) {
  const error = new Error(code);
  error.code = code;
  error.status = status;
  return error;
}

function localServerPort(serverInstance) {
  const address = serverInstance.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return Number.isInteger(port) ? port : 0;
}

function sendLocalJson(response, status, payload) {
  if (response.writableEnded) return;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (status === 408) response.setHeader('Connection', 'close');
  response.writeHead(status);
  response.end(JSON.stringify(payload));
}

function sendLocalPending(res) {
  sendLocalJson(res, 202, {
    success: false, pending: true, outcome: 'unknown', retrySafe: false,
    error: 'tool_execution_pending',
  });
}

function sendLocalError(response, error) {
  if (error?.code && Number.isInteger(error?.status)) {
    sendLocalJson(response, error.status, { error: error.code });
    return;
  }
  const normalized = localTransportErrorResponse(error);
  sendLocalJson(response, normalized.status, normalized.body);
}

function localRequestUrl(request) {
  if (typeof request.url !== 'string' || !request.url.startsWith('/')) {
    throw localFailure('invalid_request_target', 400);
  }
  return new URL(request.url, 'http://127.0.0.1');
}

function dashboardRouteMethod(pathname) {
  if (pathname === '/health') return 'GET';
  if (pathname === '/call-tool' || pathname === '/approve-pin' || pathname === '/select-pins') return 'POST';
  return '';
}

function record(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function annotationProjectId(annotation) {
  if (!record(annotation)) return '';
  const normalize = (value) => (
    typeof value === 'string' && value.trim().length <= 512 ? value.trim() : ''
  );
  const hasCamel = Object.prototype.hasOwnProperty.call(annotation, 'projectId');
  const hasSnake = Object.prototype.hasOwnProperty.call(annotation, 'project_id');
  const camel = normalize(annotation.projectId);
  const snake = normalize(annotation.project_id);
  if ((hasCamel && !camel) || (hasSnake && !snake) || (camel && snake && camel !== snake)) return '';
  return camel || snake;
}

function hasOwn(value, key) {
  return record(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeAnnotationsForPage(annotations, {
  pageUrl,
  projectId = '',
  errorCode = 'invalid_annotations',
} = {}) {
  if (!Array.isArray(annotations)) throw localFailure(errorCode, 400);
  return annotations.map((annotation) => {
    if (!record(annotation) || typeof annotation.id !== 'string' || !annotation.id.trim()) {
      throw localFailure(errorCode, 400);
    }
    const hasPageUrl = hasOwn(annotation, 'pageUrl');
    if (hasPageUrl && annotation.pageUrl !== pageUrl) {
      throw localFailure(errorCode, 400);
    }
    const normalized = { ...annotation, pageUrl };
    if (!projectId) return normalized;
    const hasProjectId = hasOwn(annotation, 'projectId') || hasOwn(annotation, 'project_id');
    const rowProjectId = annotationProjectId(annotation);
    if (hasProjectId && rowProjectId !== projectId) {
      throw localFailure(errorCode, 400);
    }
    if (!hasProjectId) normalized.projectId = projectId;
    return normalized;
  });
}

function bridgePageUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 8192) {
    throw localFailure('invalid_page_url', 400);
  }
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || !parsed.hostname) {
      throw localFailure('invalid_page_url', 400);
    }
  } catch (error) {
    if (error?.code === 'invalid_page_url') throw error;
    throw localFailure('invalid_page_url', 400);
  }
  return value;
}

function localBridgeProjectIds() {
  const ids = new Set();
  const configured = typeof DEFAULT_PROJECT_ID === 'string' ? DEFAULT_PROJECT_ID.trim() : '';
  if (configured) ids.add(configured);
  for (const projectId of currentProjectIds) {
    if (typeof projectId === 'string' && projectId.trim()) ids.add(projectId.trim());
  }
  return ids;
}

async function readBridgePageData(pageUrl, projectId) {
  try {
    await ensureVersionedAnnotationCache({ annotationsDir: ANNOTATIONS_DIR });
    const parsed = await readScopedAnnotationPage({
      annotationsDir: ANNOTATIONS_DIR,
      projectId,
      pageUrl,
    });
    return parsed || { projectId, pageUrl, annotations: [] };
  } catch {
    // A malformed v2 record is not an invitation to fall back to a lossy
    // legacy slug. Keep the source bytes intact and surface a retryable local
    // storage failure instead of disclosing a possibly different project.
    throw localFailure('local_annotation_store_invalid', 409);
  }
}

async function resolveBridgeProjectId({ pageUrl, requestedProjectId } = {}) {
  const allowed = localBridgeProjectIds();
  const requested = typeof requestedProjectId === 'string' ? requestedProjectId.trim() : '';
  if (requested) {
    if (!allowed.has(requested)) throw localFailure('bridge_project_scope_required', 403);
    return requested;
  }
  // Omitted project scope is safe only when this exact page URL resolves to a
  // single configured/discovered project. A one-project process alone is not a
  // page binding: it must not turn any arbitrary URL into that project's
  // bridge scope. Rows remain a post-resolution consistency check below.
  const registry = await core.readProjectRegistry({ feedbackDir: FEEDBACK_DIR });
  if (!registry.malformed) {
    const identity = core.resolveProjectIdentity({
      projects: registry.projects,
      urls: [pageUrl],
    });
    if (identity.status === 'matched' && allowed.has(identity.projectId)) {
      return identity.projectId;
    }
  }
  throw localFailure('bridge_project_scope_required', 403);
}

// Pin creation has a stricter source of authority than the historical local
// bridge: only the current authenticated cloud project registry may select a
// project, and its registered URL scope must include the page. The sync endpoint
// independently enforces this same boundary; checking first avoids recording
// a terminal journal rejection for a page that cannot be accepted. There is
// never an "unresolved" project sentinel written to a pin or journal.
async function resolveAuthoritativeSubmissionProjectScope({ pageUrl, requestedProjectId } = {}) {
  const requested = typeof requestedProjectId === 'string' ? requestedProjectId.trim() : '';
  await ensureCloudAuthForTool();
  if (cloudAuthState === 'authenticated' && resolveCloudSyncKey() !== cloudAuthKey) {
    invalidateCloudProjectAuthority();
  }
  if (cloudAuthState !== 'authenticated' || !cloudProjectRegistryAuthoritative) {
    return {
      ok: false,
      deliveryStatus: 'project_scope_unavailable',
      retryable: true,
      error: 'project_scope_unavailable',
      message: 'The authenticated project registry is not ready. The pin was not sent.',
    };
  }

  const registry = await core.readProjectRegistry({ feedbackDir: FEEDBACK_DIR });
  if (registry.malformed) {
    return {
      ok: false,
      deliveryStatus: 'project_scope_unavailable',
      retryable: true,
      error: 'project_scope_unavailable',
      message: 'The authenticated project registry is malformed locally. The pin was not sent.',
    };
  }
  const projects = Object.fromEntries(
    Object.entries(registry.projects)
      .filter(([id]) => cloudAuthoritativeProjectIds.has(id))
      .map(([id, project]) => [id, {
        ...(project && typeof project === 'object' && !Array.isArray(project) ? project : {}),
        // Do not reuse a cached role: only the fresh authenticated snapshot
        // can authorize owner/editor automated pin creation.
        role: cloudAuthoritativeProjectRoles.get(id) || null,
      }]),
  );
  const resolved = core.resolvePrivilegedSubmissionProjectScope({
    projects,
    pageUrl,
    requestedProjectId: requested,
  });
  if (resolved.ok) return { ok: true, projectId: resolved.projectId };
  if (resolved.reason === 'project_scope_forbidden') {
    return {
      ok: false,
      deliveryStatus: 'project_scope_forbidden',
      retryable: false,
      error: 'project_scope_forbidden',
      message: 'The authenticated project role is commenter and cannot create an AI or agent pin. The pin was not sent.',
    };
  }
  if (resolved.reason === 'project_scope_ambiguous') {
    return {
      ok: false,
      deliveryStatus: 'project_scope_ambiguous',
      retryable: false,
      error: 'project_scope_ambiguous',
      message: 'More than one authenticated project is registered for this page. Supply one of the registered project IDs explicitly.',
    };
  }
  return {
    ok: false,
    deliveryStatus: resolved.reason === 'project_scope_mismatch' ? 'project_scope_mismatch' : 'project_scope_unregistered',
    retryable: false,
    error: resolved.reason === 'project_scope_mismatch' ? 'project_scope_mismatch' : 'project_scope_unregistered',
    message: resolved.reason === 'project_scope_mismatch'
      ? 'The supplied projectId does not match the authenticated page registration. The pin was not sent.'
      : 'This page is not registered to an authenticated project. The pin was not sent.',
  };
}

async function resolveOptionalBridgeProjectId({ pageUrl, requestedProjectId } = {}) {
  try {
    return await resolveBridgeProjectId({ pageUrl, requestedProjectId });
  } catch (error) {
    // Preserve the documented local-only omitted-project workflow. It remains
    // a legacy compatibility file and is deliberately excluded from v2 until
    // a trusted registry/config supplies one exact project scope.
    if (!requestedProjectId && error?.code === 'bridge_project_scope_required') return null;
    throw error;
  }
}

function validateBridgeAnnotation(annotation, { pageUrl, projectId }) {
  if (!record(annotation) || typeof annotation.id !== 'string' || !annotation.id.trim() ||
      annotation.pageUrl !== pageUrl || annotationProjectId(annotation) !== projectId) {
    throw localFailure('bridge_annotation_scope_invalid', 400);
  }
}

async function persistUnscopedLegacyAnnotations(pageUrl, annotations) {
  const filePath = join(ANNOTATIONS_DIR, `${core.urlToSlug(pageUrl)}.json`);
  let pageData = { pageUrl, pageTitle: annotations[0]?.pageTitle || pageUrl, annotations: [] };
  if (existsSync(filePath)) {
    try {
      const parsed = JSON.parse(await readFile(filePath, 'utf-8'));
      if (record(parsed) && parsed.pageUrl === pageUrl && Array.isArray(parsed.annotations)) {
        pageData = parsed;
      } else {
        throw localFailure('page_url_storage_collision', 409);
      }
    } catch (error) {
      if (error?.code === 'page_url_storage_collision') throw error;
      throw localFailure('local_annotation_store_invalid', 409);
    }
  }
  for (const annotation of annotations) {
    if (annotation?.pageUrl !== pageUrl) throw localFailure('invalid_annotation', 400);
    const existingIndex = pageData.annotations.findIndex((item) => item?.id === annotation.id);
    if (existingIndex >= 0) pageData.annotations[existingIndex] = { ...pageData.annotations[existingIndex], ...annotation };
    else pageData.annotations.push(annotation);
  }
  await core.writeAnnotationFile(ANNOTATIONS_DIR, pageData);
}

async function persistPushedAnnotations(pageUrl, projectId, annotations) {
  for (const annotation of annotations) {
    if (annotation?.pageUrl !== pageUrl || annotationProjectId(annotation) !== projectId) {
      throw localFailure('bridge_annotation_scope_invalid', 400);
    }
  }
  try {
    await updateScopedAnnotationPage({
      annotationsDir: ANNOTATIONS_DIR,
      projectId,
      pageUrl,
      update: (current) => {
        const pageData = current || {
          projectId,
          pageUrl,
          pageTitle: annotations[0]?.pageTitle || pageUrl,
          annotations: [],
        };
        for (const annotation of annotations) {
          if (annotation.pageTitle && (!pageData.pageTitle || pageData.pageTitle === pageData.pageUrl)) {
            pageData.pageTitle = annotation.pageTitle;
          }
          const existingIndex = pageData.annotations.findIndex((item) => item?.id === annotation.id);
          if (existingIndex >= 0) {
            if (annotationProjectId(pageData.annotations[existingIndex]) !== annotationProjectId(annotation)) {
              throw localFailure('annotation_project_mismatch', 403);
            }
            pageData.annotations[existingIndex] = { ...pageData.annotations[existingIndex], ...annotation };
          } else {
            pageData.annotations.push(annotation);
          }
        }
        pageData.projectId = projectId;
        pageData.pageUrl = pageUrl;
        return pageData;
      },
    });
  } catch (error) {
    if (error?.code === 'annotation_project_mismatch') throw error;
    // A malformed existing local artifact is not trusted as a base for a
    // bridge write. Preserve it for recovery instead of silently replacing it.
    throw localFailure('local_annotation_store_invalid', 409);
  }
}

async function dispatchRestTool(toolName, toolArgs) {
  if (PRO_TOOLS.has(toolName)) {
    const gate = requirePro(toolName);
    if (gate) return { status: 402, payload: { success: false, ...gate } };
  }
  if (METERED_TOOLS.has(toolName)) {
    const gate = requireQuota(toolName);
    if (gate) return { status: 402, payload: { success: false, ...gate } };
  }
  const result = await dispatchTool(toolName, toolArgs);
  return { status: 200, payload: { success: true, result } };
}

// ─── REST API Wrapper (Optional) ──────────────────────────────────────────────

if (REST_MODE) {
  if (!localTransportSecurity) {
    throw new Error('Secure local transport initialization failed; refusing to start REST mode.');
  }
  let restServer;
  restServer = http.createServer((req, res) => {
    void (async () => {
      try {
        localTransportSecurity.authorizeRestRequest(req, { port: localServerPort(restServer) });
        const requestUrl = localRequestUrl(req);
        if (req.method === 'GET' && requestUrl.pathname === '/health') {
          sendLocalJson(res, 200, { status: 'ok', mode: 'rest', projectDir: PROJECT_DIR });
          return;
        }
        if (req.method === 'POST' && requestUrl.pathname === '/call-tool') {
          const body = await localTransportSecurity.readJsonBody(req);
          const toolName = typeof body.toolName === 'string' ? body.toolName : '';
          if (!toolName) throw localFailure('invalid_tool_name', 400);
          // REST has historically passed args through unchanged. Keep that
          // request shape while requiring the envelope itself to be JSON.
          const execution = await runBoundedLocalOperation(
            () => dispatchRestTool(toolName, body.args),
            {
              timeoutMs: LOCAL_HTTP_TOOL_EXECUTION_TIMEOUT_MS,
              onLateSettlement: ({ state }) => {
                console.error(`[local-transport] REST tool ${toolName} settled ${state} after its response deadline; outcome remains ambiguous.`);
              },
            },
          );
          if (execution.state === 'pending') {
            // `dispatchTool` may already have crossed a mutation boundary. Do
            // not label this a rejection or invite an unsafe blind retry.
            sendLocalJson(res, 202, {
              success: false,
              pending: true,
              outcome: 'unknown',
              retrySafe: false,
              error: 'tool_execution_pending',
            });
            return;
          }
          sendLocalJson(res, execution.value.status, execution.value.payload);
          return;
        }
        if (req.method === 'POST' && requestUrl.pathname === '/push-annotation') {
          const annotation = await localTransportSecurity.readJsonBody(req);
          if (typeof annotation.pageUrl !== 'string' || typeof annotation.id !== 'string' ||
              !annotation.pageUrl || !annotation.id) {
            throw localFailure('invalid_annotation', 400);
          }
          const pageUrl = bridgePageUrl(annotation.pageUrl);
          const requestedProjectId = annotationProjectId(annotation);
          const projectId = await resolveOptionalBridgeProjectId({
            pageUrl,
            requestedProjectId,
          });
          if (!projectId) {
            const normalized = normalizeAnnotationsForPage([annotation], { pageUrl });
            await persistUnscopedLegacyAnnotations(pageUrl, normalized);
            sendLocalJson(res, 200, { ok: true });
            return;
          }
          const normalized = normalizeAnnotationsForPage([annotation], {
            pageUrl,
            projectId,
            errorCode: 'bridge_annotation_scope_invalid',
          })[0];
          validateBridgeAnnotation(normalized, { pageUrl, projectId });
          await persistPushedAnnotations(pageUrl, projectId, [normalized]);
          sendLocalJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && requestUrl.pathname === '/push-annotations') {
          const body = await localTransportSecurity.readJsonBody(req);
          if (typeof body.pageUrl !== 'string' || !body.pageUrl || !Array.isArray(body.annotations) || body.annotations.length > 1000) {
            throw localFailure('invalid_annotations', 400);
          }
          const pageUrl = bridgePageUrl(body.pageUrl);
          const rowProjectIds = new Set(body.annotations.map(annotationProjectId).filter(Boolean));
          const requestedProjectId = annotationProjectId(body) || (rowProjectIds.size === 1 ? [...rowProjectIds][0] : '');
          if (rowProjectIds.size > 1 || (annotationProjectId(body) && rowProjectIds.size && !rowProjectIds.has(annotationProjectId(body)))) {
            throw localFailure('bridge_annotation_scope_invalid', 400);
          }
          const projectId = await resolveOptionalBridgeProjectId({ pageUrl, requestedProjectId });
          if (!projectId) {
            const annotations = normalizeAnnotationsForPage(body.annotations, { pageUrl });
            await persistUnscopedLegacyAnnotations(pageUrl, annotations);
            sendLocalJson(res, 200, { ok: true, count: annotations.length });
            return;
          }
          const annotations = normalizeAnnotationsForPage(body.annotations, {
            pageUrl,
            projectId,
            errorCode: 'bridge_annotation_scope_invalid',
          });
          for (const annotation of annotations) validateBridgeAnnotation(annotation, { pageUrl, projectId });
          await persistPushedAnnotations(pageUrl, projectId, annotations);
          sendLocalJson(res, 200, { ok: true, count: annotations.length });
          return;
        }
        sendLocalJson(res, 404, { error: 'not_found' });
      } catch (error) {
        sendLocalError(res, error);
      }
    })();
  });
  configureLocalHttpServer(restServer, {
    headerTimeoutMs: LOCAL_HTTP_HEADER_TIMEOUT_MS,
    requestTimeoutMs: LOCAL_HTTP_RECEIVE_TIMEOUT_MS,
  });

  restServer.once('error', (error) => {
    const code = ['EADDRINUSE', 'EACCES'].includes(error?.code) ? error.code : 'listen_failed';
    console.error(`[local-transport] REST startup failed: ${code}`);
    // REST cannot serve without its listener; do not let the process-wide
    // nonfatal stdio exception handler leave this mode alive but unavailable.
    const shutdownTimer = setTimeout(() => process.exit(1), 1000);
    void localTransportSecurity.dispose().finally(() => {
      clearTimeout(shutdownTimer);
      process.exit(1);
    });
  });
  restServer.listen(REST_PORT, '127.0.0.1', () => {
    const port = localServerPort(restServer);
    console.error(`Pincushion REST API server listening on 127.0.0.1:${port} (capability file: ${localTransportSecurity.capabilityFile})`);
  });
} else {
  // ─── Start MCP Server ────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpConnected = true;
}

// Project discovery began during bootstrap but may perform authoritative
// registration. Start only after both it and transport boot complete. This is
// intentionally fire-and-forget, and remains inert without the explicit
// PINCUSHION_AUTO_FRAME_REFRESH=1 opt-in checked above.
void projectAutoDiscovery.then(() => {
  startAutomaticDeploymentFrameRuntime();
}).catch(() => {
  console.error('[frame-refresh] deployment_frame_project_discovery_failed');
});

// ─── Local Bridge Server ──────────────────────────────────────────────────────
// Start a lightweight loopback server for the owner-readable dashboard. Cloud
// bridge reads and pushes require an attested grant; cloud sync stays
// independent of this local bridge.

if (!REST_MODE && localTransportSecurity) {
  let bridgeServer;
  bridgeServer = http.createServer((req, res) => {
    void (async () => {
      try {
        const port = localServerPort(bridgeServer);
        localTransportSecurity.authorizeLoopbackHost(req, { port });
        const requestUrl = localRequestUrl(req);
        const dashboardMethod = dashboardRouteMethod(requestUrl.pathname);
        const bridgeMethod = ['/bridge-challenge', '/status', '/resolved'].includes(requestUrl.pathname)
          ? 'GET' : ['/push-annotation', '/push-annotations'].includes(requestUrl.pathname) ? 'POST' : null;
        if (bridgeMethod) {
          if (req.method === 'OPTIONS') {
            localTransportSecurity.authorizeBridgePreflightRequest(req, { port, allowedMethods: [bridgeMethod] });
            localTransportSecurity.applyBridgeCors(req, res);
            res.writeHead(204);
            res.end();
            return;
          }
          localTransportSecurity.authorizeBridgeChallengeRequest(req, { port });
          localTransportSecurity.applyBridgeCors(req, res);
        }


        // A file:// dashboard has Origin: null and its capability header
        // requires a preflight. This is deliberately route- and origin-bound;
        // the general REST wrapper never enables browser CORS.
        if (req.method === 'OPTIONS' && dashboardMethod) {
          localTransportSecurity.authorizeDashboardPreflightRequest(req, {
            port,
            allowedMethods: [dashboardMethod],
          });
          localTransportSecurity.applyDashboardCors(res);
          res.writeHead(204);
          res.end();
          return;
        }
        if (dashboardMethod && req.headers.origin === 'null') {
          localTransportSecurity.applyDashboardCors(res);
        }

        // Dashboard routes require a separate capability that is present only
        // in the mode-0600 generated dashboard. file:// supplies Origin: null,
        // which is not trusted on its own.
        if (req.method === 'GET' && requestUrl.pathname === '/health') {
          localTransportSecurity.authorizeDashboardRequest(req, { port });
          sendLocalJson(res, 200, {
            status: 'ok',
            version: 'v1-slim',
            projectDir: PROJECT_DIR,
          });
          return;
        }
        if (req.method === 'POST' && requestUrl.pathname === '/call-tool') {
          localTransportSecurity.authorizeDashboardRequest(req, { port });
          const body = await localTransportSecurity.readJsonBody(req);
          if (body.toolName !== 'get_feedback_summary' || (body.args !== undefined && !record(body.args))) {
            throw localFailure('dashboard_tool_not_allowed', 403);
          }
          const execution = await runBoundedLocalOperation(
            () => toolGetFeedbackSummary(body.args || {}),
            { timeoutMs: LOCAL_HTTP_TOOL_EXECUTION_TIMEOUT_MS },
          );
          if (execution.state === 'pending') { sendLocalPending(res); return; }
          sendLocalJson(res, 200, { success: true, result: execution.value });
          return;
        }
        if (req.method === 'POST' && requestUrl.pathname === '/approve-pin') {
          localTransportSecurity.authorizeDashboardRequest(req, { port });
          const body = await localTransportSecurity.readJsonBody(req);
          if (typeof body.annotationId !== 'string' || !body.annotationId.trim()) {
            throw localFailure('invalid_annotation', 400);
          }
          const execution = await runBoundedLocalOperation(() => toolApprovePin({
            annotationId: body.annotationId,
            approvedBy: typeof body.approvedBy === 'string' && body.approvedBy ? body.approvedBy : 'Dashboard User',
          }), { timeoutMs: LOCAL_HTTP_TOOL_EXECUTION_TIMEOUT_MS });
          if (execution.state === 'pending') { sendLocalPending(res); return; }
          if (execution.value?.success) {
            console.error(`[bridge] Pin ${body.annotationId} approved`);
            void refreshPinsFile();
          }
          sendLocalJson(res, 200, execution.value);
          return;
        }
        if (req.method === 'POST' && requestUrl.pathname === '/select-pins') {
          localTransportSecurity.authorizeDashboardRequest(req, { port });
          const data = await localTransportSecurity.readJsonBody(req);
          if (!Array.isArray(data.selectedPins) || data.selectedPins.length > 1000 ||
              data.selectedPins.some((id) => typeof id !== 'string' || !id || id.length > 512)) {
            throw localFailure('invalid_selection', 400);
          }
          await core.writeSelections(coreConfig, data);
          console.error(`[bridge] Saved ${data.selectedPins.length} pin selection(s)`);
          void refreshPinsFile();
          sendLocalJson(res, 200, { ok: true, count: data.selectedPins.length });
          return;
        }

        // A challenge is public but contains no account, project, path, or
        // capability data. It is only useful once a later cloud adapter issues
        // and verifies a scoped opaque grant against this process nonce.
        if (req.method === 'GET' && requestUrl.pathname === '/bridge-challenge') {
          localTransportSecurity.authorizeBridgeChallengeRequest(req, { port });
          sendLocalJson(res, 200, localTransportSecurity.bridgeChallenge());
          return;
        }

        // Chrome bridge reads and writes are independent from dashboard access.
        // The cloud-attested verifier binds each request to one project and one
        // exact page URL before any local row is read or written.
        if (req.method === 'GET' && (requestUrl.pathname === '/status' || requestUrl.pathname === '/resolved')) {
          const pageUrl = bridgePageUrl(requestUrl.searchParams.get('pageUrl') || '');
          const projectId = await resolveBridgeProjectId({
            pageUrl,
            requestedProjectId: requestUrl.searchParams.get('projectId') || requestUrl.searchParams.get('project_id') || '',
          });
          await localTransportSecurity.authorizeCloudBridgeRequest(req, {
            port,
            scope: 'bridge:read-status',
            pathname: requestUrl.pathname,
            expectedProjectId: projectId,
            requestedPageUrl: pageUrl,
          });
          const pageData = await readBridgePageData(pageUrl, projectId);
          const scopedAnnotations = pageData.annotations
            .filter((annotation) => annotation?.pageUrl === pageUrl && annotationProjectId(annotation) === projectId)
            .map((annotation) => projectBridgeStatusAnnotation(annotation, { pageUrl, projectId }))
            .filter(Boolean);
          sendLocalJson(res, 200, {
            resolved: scopedAnnotations.filter((annotation) => annotation.status === 'resolved'),
            implemented: scopedAnnotations.filter((annotation) => annotation.action === 'implemented'),
          });
          return;
        }
        if (req.method === 'POST' && requestUrl.pathname === '/push-annotation') {
          const annotation = await localTransportSecurity.readJsonBody(req);
          const pageUrl = bridgePageUrl(annotation.pageUrl);
          const projectId = await resolveBridgeProjectId({
            pageUrl,
            requestedProjectId: annotationProjectId(annotation),
          });
          const normalized = normalizeAnnotationsForPage([annotation], {
            pageUrl,
            projectId,
            errorCode: 'bridge_annotation_scope_invalid',
          })[0];
          validateBridgeAnnotation(normalized, { pageUrl, projectId });
          await localTransportSecurity.authorizeCloudBridgeRequest(req, {
            port,
            scope: 'bridge:push',
            pathname: requestUrl.pathname,
            expectedProjectId: projectId,
            requestedPageUrl: pageUrl,
          });
          await persistPushedAnnotations(pageUrl, projectId, [normalized]);
          sendLocalJson(res, 200, { ok: true });
          return;
        }
        if (req.method === 'POST' && requestUrl.pathname === '/push-annotations') {
          const body = await localTransportSecurity.readJsonBody(req);
          const pageUrl = bridgePageUrl(body.pageUrl);
          if (!Array.isArray(body.annotations) || body.annotations.length > 1000) {
            throw localFailure('invalid_annotations', 400);
          }
          const hasTopLevelProjectId = hasOwn(body, 'projectId') || hasOwn(body, 'project_id');
          if (hasTopLevelProjectId && !annotationProjectId(body)) {
            throw localFailure('bridge_annotation_scope_invalid', 400);
          }
          const rowProjectIds = new Set(body.annotations.map(annotationProjectId).filter(Boolean));
          const requestedProjectId = annotationProjectId(body) || (rowProjectIds.size === 1 ? [...rowProjectIds][0] : '');
          if (rowProjectIds.size > 1 || (annotationProjectId(body) && rowProjectIds.size && !rowProjectIds.has(annotationProjectId(body)))) {
            throw localFailure('bridge_annotation_scope_invalid', 400);
          }
          const projectId = await resolveBridgeProjectId({ pageUrl, requestedProjectId });
          const annotations = normalizeAnnotationsForPage(body.annotations, {
            pageUrl,
            projectId,
            errorCode: 'bridge_annotation_scope_invalid',
          });
          for (const annotation of annotations) validateBridgeAnnotation(annotation, { pageUrl, projectId });
          await localTransportSecurity.authorizeCloudBridgeRequest(req, {
            port,
            scope: 'bridge:push',
            pathname: requestUrl.pathname,
            expectedProjectId: projectId,
            requestedPageUrl: pageUrl,
          });
          await persistPushedAnnotations(pageUrl, projectId, annotations);
          sendLocalJson(res, 200, { ok: true, count: annotations.length });
          return;
        }

        sendLocalJson(res, 404, { error: 'not_found' });
      } catch (error) {
        sendLocalError(res, error);
      }
    })();
  });
  configureLocalHttpServer(bridgeServer, {
    headerTimeoutMs: LOCAL_HTTP_HEADER_TIMEOUT_MS,
    requestTimeoutMs: LOCAL_HTTP_RECEIVE_TIMEOUT_MS,
  });

  bridgeServer.listen(BRIDGE_PORT, '127.0.0.1', () => {
    const port = localServerPort(bridgeServer);
    console.error(`Pincushion local bridge listening on 127.0.0.1:${port}`);
  });
  bridgeServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Bridge port ${BRIDGE_PORT} already in use — local bridge disabled.`);
    }
  });
} else if (!REST_MODE) {
  console.error('[local-transport] Local bridge disabled because secure capability initialization failed.');
}

// ─── Global Process Stability ─────────────────────────────────────────────────
// MCP servers are long-lived daemon processes managed by the host (Claude Code,
// Cursor, VS Code, etc.). An unhandled rejection or uncaught exception in any
// background loop (sync, realtime, pins refresh) must NEVER kill the process —
// the host won't automatically restart it, leaving the user with no MCP tools.

process.on('uncaughtException', (err) => {
  console.error('[pincushion] Uncaught exception (non-fatal):', err?.message || err);
  if (Sentry) Sentry.captureException(err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[pincushion] Unhandled promise rejection (non-fatal):', reason?.message || reason);
  if (Sentry) Sentry.captureException(reason instanceof Error ? reason : new Error(String(reason)));
});

// ─── Shutdown diagnostics ─────────────────────────────────────────────────────
// The server has disconnected intermittently in Claude Code with no recorded
// cause — the host's mcp-logs only ever showed clean closes. Log every shutdown
// trigger to stderr (the host captures it) so the NEXT disconnect is explainable:
// host SIGTERM vs stdin EOF (host dropped the transport) vs fatal exit. These
// handlers preserve normal termination — they log, then exit.
let _shuttingDown = false;
function gracefulExit(why) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  deploymentFrameRuntime?.stop();
  stopRealtimeIfRunning();
  console.error(`[pincushion] ${why} — exiting`);
  // Best-effort flush, then hard-exit. The finally() guarantees we exit even if
  // analytics shutdown hangs; the safety timer guarantees it even if the promise
  // never settles. Background loops (cloud-sync, pins-refresh, realtime, bridge)
  // otherwise keep the event loop alive forever.
  const timer = setTimeout(() => process.exit(0), 2000);
  timer.unref?.();
  // A pending `mcp boot` stops waiting for the handshake (or, before discovery
  // reached it, is sent now) and is queued before the PostHog flush.
  Promise.allSettled([
    queueBootEventBeforeExit().then(() => shutdownPostHog()),
    backgroundRefreshLease.release(),
    localTransportSecurity?.dispose(),
  ])
    .finally(() => process.exit(0));
}
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => gracefulExit(`received ${sig} — host is stopping the server`));
}
process.on('exit', (code) => {
  deploymentFrameRuntime?.stop();
  console.error(`[pincushion] process exit (code ${code})`);
});
// A hard host quit does not deliver stdin EOF or a signal. In stdio mode the
// OS then reparents us to init, while our cloud polling and bridge handles keep
// this process alive. Self-reap only that unambiguous orphan state; --rest is a
// deliberately standalone server and must not be coupled to its caller.
if (!REST_MODE) {
  startOrphanWatch({
    initialPpid: INITIAL_PARENT_PID,
    onOrphaned: () => gracefulExit('parent process was reparented to init — self-reaping orphaned MCP server'),
  });
}
// stdin EOF/close means the host closed the stdio transport — the host is gone,
// so we MUST exit. Without this the cloud-sync loop, the 15s pins-refresh timer,
// the realtime socket, and the bridge HTTP server hold the event loop open and the
// process lingers forever as an orphan — holding the bridge port, polling the cloud,
// and racing other instances on the shared .feedback/ files. Orphan pile-up across
// reconnects is the root cause of "Could not attach to MCP server pincushion".
// In --rest mode stdin is NOT the transport, so the server stays up there.
if (!REST_MODE) {
  process.stdin.on('end', () => gracefulExit('stdin EOF — host closed the transport'));
  process.stdin.on('close', () => gracefulExit('stdin stream closed — host closed the transport'));
}
