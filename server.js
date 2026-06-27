#!/usr/bin/env node
// server.js — PinCushion MCP Server
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

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { readFile, writeFile, readdir, stat } from 'fs/promises';
import { existsSync, mkdirSync, readdirSync, unlinkSync, readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import http from 'http';

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
import * as core from './lib/core.js';
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
const DEFAULT_PROJECT_ID = argValue('--project-id') || process.env.PINCUSHION_PROJECT_ID || null;
const REST_MODE = hasFlag('--rest');
const REST_PORT = parseInt(argValue('--port') || '3456', 10);
const CLOUD_SYNC = hasFlag('--cloud-sync') || !!process.env.PINCUSHION_LICENSE_KEY;

// Default Supabase sync URL — can be overridden via env or --sync-url flag.
// Auto-enabled when PINCUSHION_LICENSE_KEY is present so --sync-url is never
// required in MCP configs; agents get live cloud data out of the box.
const CLOUD_SYNC_URL = process.env.PINCUSHION_SYNC_URL ||
  'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1/sync-annotations';
const SYNC_SERVER_URL = argValue('--sync-url') ||
  ((process.env.PINCUSHION_LICENSE_KEY || LICENSE_KEY ||
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

// Resolution order, most explicit first:
//   1. PINCUSHION_LICENSE_KEY env       (per-invocation override)
//   2. --license-key arg                (per-server override)
//   3. <project>/.feedback/.license-key (per-project pin)
//   4. ~/.pincushion/license-key        (per-machine default — the zero-config path)
function resolveCloudSyncKey() {
  if (process.env.PINCUSHION_LICENSE_KEY) return process.env.PINCUSHION_LICENSE_KEY.trim();
  if (LICENSE_KEY) return LICENSE_KEY.trim();
  return readKeyFile(join(FEEDBACK_DIR, '.license-key')) || readKeyFile(USER_LICENSE_KEY_FILE);
}

let lastCloudSync = null;        // ISO timestamp of last successful sync
let cloudSyncPlan = null;        // 'free' | 'pro' | 'team'
let cloudSyncInterval = 30000;   // default 30s (free), updated from server response

// ─── Realtime Push Notifications ─────────────────────────────────────────────
// For Pro/Team plans: Supabase Realtime subscription notifies the agent of
// newly approved pins without polling. Since MCP stdio can't push unsolicited
// messages, we queue notifications and prepend them to the next tool response.
let pendingNotifications = [];
let realtimeHandle = null;
let mcpConnected = false; // set true once transport is connected; guards early notifications
let realtimeCredentials = null;  // cached { supabaseUrl, supabaseAnonKey } from first sync

// ─── Approved Queue Trigger File ──────────────────────────────────────────────
// When a pin is approved (via Realtime or local approve_pin), we write
// .feedback/pending-approvals.json so IDE extensions / file watchers can detect
// newly approved pins without polling the MCP server.
// Cleared when the agent calls claim_pin or implement_approved_pins.
const PENDING_APPROVALS_PATH = join(FEEDBACK_DIR, 'pending-approvals.json');

async function readApprovedQueue() {
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
  await writeFile(PENDING_APPROVALS_PATH, JSON.stringify(queue, null, 2));
  console.error(`[trigger] Wrote ${queue.approvedPins.length} pin(s) to ${PENDING_APPROVALS_PATH}`);

  // Fire MCP resource notification so subscribing clients know the queue changed
  if (mcpConnected) {
    try { server.sendResourceUpdated({ uri: 'pincushion://approved-queue' }); } catch { /* notification is best-effort; clients re-poll the resource regardless */ }
  }
}

async function addToApprovedQueue(pin) {
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

async function cloudSyncPull() {
  const licenseKey = resolveCloudSyncKey();
  if (!licenseKey) return;

  try {
    const params = new URLSearchParams();
    if (lastCloudSync) params.set('since', lastCloudSync);

    const resp = await fetch(`${CLOUD_SYNC_URL}?${params}`, {
      headers: { 'X-License-Key': licenseKey }
    });

    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403) {
        console.error('[cloud-sync] Invalid license key — disable sync with --no-cloud-sync');
      }
      return;
    }

    const data = await resp.json();
    const annotations = data.annotations || [];

    // Update sync interval based on plan
    if (data.plan && data.plan !== cloudSyncPlan) {
      cloudSyncPlan = data.plan;
      cloudSyncInterval = data.limits?.syncIntervalHint
        ? data.limits.syncIntervalHint * 1000
        : (data.plan === 'free' ? 30000 : 10000);
      console.error(`[cloud-sync] Plan: ${data.plan}, interval: ${cloudSyncInterval / 1000}s`);
    }

    // Cache Realtime credentials from server response (Pro/Team only)
    if (data.realtime && !realtimeCredentials) {
      realtimeCredentials = data.realtime;
      startRealtimeIfEligible(data.realtime);
    }

    if (annotations.length === 0) {
      lastCloudSync = data.ts;
      return;
    }

    console.error(`[cloud-sync] Received ${annotations.length} annotation(s) from cloud`);

    // Group by page_url and merge into local .feedback/annotations/
    const byPage = {};
    for (const ann of annotations) {
      const pageUrl = ann.page_url || ann.pageUrl;
      if (!pageUrl) continue;
      if (!byPage[pageUrl]) byPage[pageUrl] = [];
      // Convert from cloud schema (snake_case) to local schema (camelCase)
      byPage[pageUrl].push({
        id: ann.id,
        pageUrl: pageUrl,
        pageTitle: ann.page_title || ann.pageTitle,
        element: ann.element,
        pin: ann.pin,
        thread: ann.thread || [],
        status: ann.status || 'open',
        tags: ann.tags || [],
        action: ann.action || null,
        createdAt: ann.created_at || ann.createdAt,
        updatedAt: ann.updated_at || ann.updatedAt,
        resolvedAt: ann.resolved_at || ann.resolvedAt,
        approvedAt: ann.approved_at || ann.approvedAt,
        approvedBy: ann.approved_by || ann.approvedBy,
        createdBy: ann.created_by || ann.createdBy,
        implementedAt: ann.implemented_at || ann.implementedAt,
        author: ann.author,
        authorEmail: ann.author_email || ann.authorEmail,
        projectId: ann.project_id || ann.projectId,
        implementer: ann.implementer,
        commitSha: ann.commit_sha || ann.commitSha || null,
        branchName: ann.branch_name || ann.branchName || null,
        prUrl: ann.pr_url || ann.prUrl || null,
        deployUrl: ann.deploy_url || ann.deployUrl || null,
        deployedAt: ann.deployed_at || ann.deployedAt || null,
        verificationStatus: ann.verification_status || ann.verificationStatus || null,
        verificationNotes: ann.verification_notes || ann.verificationNotes || null,
        verifiedAt: ann.verified_at || ann.verifiedAt || null,
        viewport: ann.viewport || null,
        domSnippet: ann.dom_snippet || ann.domSnippet || null,
        likelyFiles: ann.likely_files || ann.likelyFiles || null,
        acceptanceCriteria: ann.acceptance_criteria || ann.acceptanceCriteria || null,
        screenshotUrl: ann.screenshot_url || ann.screenshotUrl || null,
      });
    }

    // Merge into local annotation files
    if (!existsSync(ANNOTATIONS_DIR)) mkdirSync(ANNOTATIONS_DIR, { recursive: true });

    for (const [pageUrl, cloudAnns] of Object.entries(byPage)) {
      const slug = core.urlToSlug(pageUrl);
      const filePath = join(ANNOTATIONS_DIR, `${slug}.json`);

      let localData = { pageUrl, pageTitle: cloudAnns[0]?.pageTitle || pageUrl, annotations: [] };
      if (existsSync(filePath)) {
        try { localData = JSON.parse(readFileSync(filePath, 'utf8')); } catch {}
      }

      const localAnns = localData.annotations || [];
      const localById = new Map(localAnns.map(a => [a.id, a]));

      for (const cloudAnn of cloudAnns) {
        const existing = localById.get(cloudAnn.id);
        const wasApproved = core.isReadyStatus(existing?.status);
        const nowApproved = core.isReadyStatus(cloudAnn.status);

        if (existing) {
          // Cloud wins if it has a newer updated_at
          const cloudTime = new Date(cloudAnn.updatedAt || 0).getTime();
          const localTime = new Date(existing.updatedAt || 0).getTime();
          if (cloudTime > localTime) {
            Object.assign(existing, cloudAnn);
          }
        } else {
          localAnns.push(cloudAnn);
        }

        // Detect approval transition: pin is now approved but wasn't before locally
        if (nowApproved && !wasApproved) {
          const getBranchName = await loadGitModule();
          addToApprovedQueue({
            type: 'pin_approved',
            pinId: cloudAnn.id,
            pageTitle: cloudAnn.pageTitle || cloudAnn.pageUrl,
            pageUrl: cloudAnn.pageUrl,
            projectId: cloudAnn.projectId || null,
            approvedBy: cloudAnn.approvedBy || 'someone',
            comment: (cloudAnn.thread?.[0]?.body || '').slice(0, 80),
            suggestedBranch: getBranchName(cloudAnn.pageTitle, cloudAnn.pageUrl),
            timestamp: new Date().toISOString(),
            message: `Pin approved on "${cloudAnn.pageTitle || cloudAnn.pageUrl}" by ${cloudAnn.approvedBy || 'someone'}`,
          }).catch(err => console.error('[cloud-sync] Failed to queue approval:', err.message));

          // Also queue an in-memory notification for the next MCP tool response
          const branch = getBranchName(cloudAnn.pageTitle, cloudAnn.pageUrl);
          pendingNotifications.push({
            type: 'pin_approved',
            pinId: cloudAnn.id,
            pageTitle: cloudAnn.pageTitle || cloudAnn.pageUrl,
            projectId: cloudAnn.projectId || null,
            approvedBy: cloudAnn.approvedBy || 'someone',
            comment: (cloudAnn.thread?.[0]?.body || '').slice(0, 80),
            suggestedBranch: branch,
            timestamp: new Date().toISOString(),
            message: `New pin approved on "${cloudAnn.pageTitle || cloudAnn.pageUrl}" by ${cloudAnn.approvedBy || 'someone'}. Suggested branch: ${branch}`,
          });
          console.error(`[cloud-sync] Detected approval: ${cloudAnn.id} on "${cloudAnn.pageTitle}" — queued trigger + notification`);
        }
      }

      localData.annotations = localAnns;
      localData.exportedAt = new Date().toISOString();
      await writeFile(filePath, JSON.stringify(localData, null, 2));
    }

    lastCloudSync = data.ts;
    console.error(`[cloud-sync] Merged ${annotations.length} annotation(s) to local .feedback/`);

    // ── Reconcile approved queue ──────────────────────────────────────────
    // After every sync, scan ALL local annotations for approved pins and
    // ensure they're in pending-approvals.json. This is more robust than
    // transition detection — it catches pins approved while the server was
    // down, during the first sync after a restart, or across code upgrades.
    await reconcileApprovedQueue();
  } catch (err) {
    console.error(`[cloud-sync] Pull failed: ${err.message}`);
  }
}

/**
 * Scan all local annotation files for pins with status='approved' and rebuild
 * the pending-approvals.json trigger file. Pins already claimed (in-progress)
 * or resolved are excluded. Only adds pins not already in the queue.
 */
async function reconcileApprovedQueue() {
  try {
    const allData = await readAllAnnotations();
    const projectFilter = resolveProjectFilter();
    const pageCount = Object.keys(allData).length;
    let totalAnns = 0;
    let approvedCount = 0;
    for (const [, data] of Object.entries(allData)) {
      totalAnns += (data.annotations || []).length;
      approvedCount += (data.annotations || []).filter(a =>
        core.isReadyStatus(a.status) && matchesProjectFilter(a.projectId || null, projectFilter)
      ).length;
    }
    console.error(`[reconcile] Scanning ${totalAnns} annotations across ${pageCount} pages — ${approvedCount} approved for active project filter`);

    if (approvedCount === 0) return;

    const getBranchName = await loadGitModule();
    const queue = await readApprovedQueue();
    const existingIds = new Set(queue.approvedPins.map(p => p.pinId));
    let added = 0;

    for (const [url, data] of Object.entries(allData)) {
      const anns = data.annotations || [];
      for (const ann of anns) {
        if (!core.isReadyStatus(ann.status)) continue;
        if (!matchesProjectFilter(ann.projectId || null, projectFilter)) continue;
        if (existingIds.has(ann.id)) continue;

        queue.approvedPins.push({
          type: 'pin_approved',
          pinId: ann.id,
          pageTitle: ann.pageTitle || url,
          pageUrl: ann.pageUrl || url,
          projectId: ann.projectId || null,
          approvedBy: ann.approvedBy || 'someone',
          comment: (ann.thread?.[0]?.body || '').slice(0, 80),
          suggestedBranch: getBranchName(ann.pageTitle, ann.pageUrl || url),
          timestamp: ann.approvedAt || new Date().toISOString(),
          message: `Pin approved on "${ann.pageTitle || url}" by ${ann.approvedBy || 'someone'}`,
        });
        added++;

        // Also queue in-memory notification if not already notified
        if (!pendingNotifications.some(n => n.pinId === ann.id)) {
          const branch = getBranchName(ann.pageTitle, ann.pageUrl || url);
          pendingNotifications.push({
            type: 'pin_approved',
            pinId: ann.id,
            pageTitle: ann.pageTitle || url,
            projectId: ann.projectId || null,
            approvedBy: ann.approvedBy || 'someone',
            comment: (ann.thread?.[0]?.body || '').slice(0, 80),
            suggestedBranch: branch,
            timestamp: ann.approvedAt || new Date().toISOString(),
            message: `New pin approved on "${ann.pageTitle || url}" by ${ann.approvedBy || 'someone'}. Suggested branch: ${branch}`,
          });
        }
      }
    }

    if (added > 0) {
      await writeApprovedQueue(queue);
      console.error(`[reconcile] Added ${added} approved pin(s) to trigger file`);
    } else {
      console.error(`[reconcile] All ${approvedCount} approved pin(s) already in queue — no changes`);
    }
  } catch (err) {
    console.error(`[reconcile] Failed: ${err.message}`);
    console.error(`[reconcile] Stack: ${err.stack}`);
  }
}

async function cloudSyncPush(annotation) {
  const licenseKey = resolveCloudSyncKey();
  if (!licenseKey) return { ok: false, reason: 'no_license_key' };

  let res;
  try {
    res = await fetch(CLOUD_SYNC_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-License-Key': licenseKey
      },
      body: JSON.stringify(annotation)
    });
  } catch (err) {
    return { ok: false, reason: 'network_error', detail: err?.message };
  }

  if (res.status === 401 || res.status === 403) {
    markCloudKeyRejected(licenseKey);
    return { ok: false, reason: 'license_rejected', status: res.status };
  }

  if (!res.ok) {
    return { ok: false, reason: 'server_error', status: res.status };
  }

  return { ok: true };
}

// Start cloud sync polling loop.
// Uses a self-scheduling setTimeout so the interval adapts dynamically when
// cloudSyncPull() updates cloudSyncInterval based on the server-returned plan.
// (setInterval captures the value at call time and cannot change after the fact.)
if (CLOUD_SYNC || resolveCloudSyncKey()) {
  const key = resolveCloudSyncKey();
  if (key) {
    console.error(`[cloud-sync] Enabled — polling ${CLOUD_SYNC_URL}`);
    async function runSyncLoop() {
      await cloudSyncPull();
      setTimeout(runSyncLoop, cloudSyncInterval); // re-reads cloudSyncInterval each time
    }
    runSyncLoop();
  } else {
    console.error('[cloud-sync] No license key found. Set PINCUSHION_LICENSE_KEY or create .feedback/.license-key');
  }
}

// ─── Realtime Startup ────────────────────────────────────────────────────────
// Starts Supabase Realtime subscription for Pro/Team plans.
// Queues notifications that get prepended to the next MCP tool response.

async function startRealtimeIfEligible(creds) {
  if (realtimeHandle) return; // already running
  if (!creds?.supabaseUrl || !creds?.supabaseAnonKey) return;

  const licenseKey = resolveCloudSyncKey();
  if (!licenseKey) return;

  const startListener = await loadRealtimeModule();
  if (!startListener) return; // @supabase/supabase-js not installed

  const getBranchName = await loadGitModule();

  console.error('[realtime] Starting Supabase Realtime subscription...');

  realtimeHandle = startListener({
    supabaseUrl: creds.supabaseUrl,
    supabaseAnonKey: creds.supabaseAnonKey,
    projectId: null, // listen to all projects for this license
    licenseKey,
    onPinApproved: (pin) => {
      const branch = getBranchName(pin.pageTitle, pin.pageUrl);
      const notification = {
        type: 'pin_approved',
        pinId: pin.id,
        pageTitle: pin.pageTitle || pin.pageUrl,
        projectId: pin.projectId || pin.project_id || null,
        approvedBy: pin.approvedBy || 'someone',
        comment: pin.comment,
        suggestedBranch: branch,
        timestamp: new Date().toISOString(),
        message: `New pin approved on "${pin.pageTitle || pin.pageUrl}" by ${pin.approvedBy || 'someone'}. Suggested branch: ${branch}`,
      };
      pendingNotifications.push(notification);
      console.error(`[realtime] Pin approved: ${pin.id} on "${pin.pageTitle}" — queued notification`);
      addToApprovedQueue(notification).catch(err => {
        console.error('[trigger] Failed to write approved queue:', err.message);
      });
      refreshPinsFile();
    },
    onPinCreated: (pin) => {
      console.error(`[realtime] New pin created: ${pin.id} on "${pin.pageTitle}" by ${pin.author}`);
      refreshPinsFile();
    },
    onPinUpdated: () => {
      // Generic refresh for any change
      refreshPinsFile();
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
  return [
    '⚠ PINCUSHION IS IN LOCAL-ONLY MODE — no license key found.',
    'Only pins in this workspace\'s .feedback/ directory are visible; cloud pins,',
    'share reports, invites, and team features are OFF. To connect: set',
    'PINCUSHION_LICENSE_KEY, pass --license-key, or write the key to',
    '~/.pincushion/license-key (sign up free at https://pincushion.io).',
    '', ''
  ].join('\n');
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

async function refreshPinsFile() {
  try {
    const fetchFn = SYNC_SERVER_URL ? fetchRemoteAnnotations : null;
    const mdPath = await core.writePinsFile(coreConfig, fetchFn);
    const jsonPath = await core.writePinsJson(coreConfig, fetchFn);
    const htmlPath = await core.writeDashboardHtml(coreConfig, fetchFn, BRIDGE_PORT);
    console.error(`[pins-file] Updated ${mdPath}`);

    // ── Rebuild approved queue directly from pins.json ───────────────────
    // pins.json was just written with the latest data. Read it back and
    // extract approved pins. This is dead simple — no separate reconciliation
    // function, no race conditions, no missed transitions.
    try {
      const pinsPath = join(FEEDBACK_DIR, 'pins.json');
      const pinsRaw = await readFile(pinsPath, 'utf8');
      const pinsData = JSON.parse(pinsRaw);
      const allPins = [...(pinsData.open || []), ...(pinsData.resolved || [])];
      const projectFilter = resolveProjectFilter();
      const statusCounts = {};
      for (const p of allPins) { statusCounts[p.status] = (statusCounts[p.status] || 0) + 1; }
      console.error(`[trigger] pins.json has ${allPins.length} total pins. Statuses: ${JSON.stringify(statusCounts)}`);

      const getBranchName = await loadGitModule();
      const approvedPins = allPins
        .filter(p => core.isReadyStatus(p.status))
        .filter(p => matchesProjectFilter(p.projectId || null, projectFilter))
        .map(p => ({
          type: 'pin_approved',
          pinId: p.id,
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
  } catch (e) {
    console.error('[pins-file] Failed to refresh:', e.message);
  }
}

const BRIDGE_PORT = parseInt(argValue('--bridge-port') || '3456', 10);

// ─── Auto-discover & register project URLs on startup ──────────────────────
// Scans PROJECT_DIR for package.json, .env, vercel config, etc. and
// auto-registers the project + URLs so the Chrome extension activates
// on matching pages without any manual setup.
(async () => {
  try {
    const discovered = await core.discoverProjectConfig(PROJECT_DIR);
    if (discovered.urls.length) {
      console.error(`[auto-discover] Project: "${discovered.name}" — URLs: ${discovered.urls.join(', ')}`);
      const configured = await toolConfigureProject({ name: discovered.name, urls: discovered.urls });
      if (configured.projectId) currentProjectIds.add(configured.projectId);

      // Also find any OTHER project registrations whose URLs overlap with ours.
      // This handles the common case where the same app was registered under a
      // different name by the Chrome extension (e.g. "Superbill Pro") vs.
      // auto-discover (e.g. "medibill" from package.json).
      const projectsFile = join(FEEDBACK_DIR, 'projects.json');
      try {
        const projects = JSON.parse(readFileSync(projectsFile, 'utf8'));
        const myUrls = new Set((configured.urls || discovered.urls).map(u => {
          try { return new URL(u.startsWith('http') ? u : `https://${u}`).origin; } catch { return u; }
        }));
        for (const [id, proj] of Object.entries(projects)) {
          const projUrls = (proj.urls || []).map(u => {
            try { return new URL(u.startsWith('http') ? u : `https://${u}`).origin; } catch { return u; }
          });
          if (projUrls.some(u => myUrls.has(u))) {
            currentProjectIds.add(id);
          }
        }
      } catch { /* projects.json not readable yet — that's fine */ }

      console.error(`[auto-discover] Project IDs for this workspace: ${[...currentProjectIds].join(', ')}`);
    } else {
      console.error('[auto-discover] No URLs detected — run configure_project manually.');
    }
  } catch (e) {
    console.error('[auto-discover] Failed (non-fatal):', e.message);
  }
})();

// Pro-only tools that require a valid Pro/Team license.
// Note: get_actionable_pins, claim_pin, fix_and_resolve are FREE — core agent loop tools.
// Pro gates team/sync features only.
const PRO_TOOLS = new Set([
  'add_member',
  'remove_member',
  'list_members',
  'create_invite_link'
]);

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

// `cloudSyncPlan` is populated from each /sync-annotations response. It's
// authoritative ("server says you're Pro/Team"). If we haven't synced yet
// but a license key is configured, allow through optimistically — the
// server will reject downstream if the license is actually Free, and we
// surface that error instead of double-blocking here. If NO license key is
// configured at all, fail fast with a clear "set --license-key" message.
function requirePro(toolName) {
  const hasLicense = !!LICENSE_KEY || !!process.env.PINCUSHION_LICENSE_KEY;
  if (!hasLicense) {
    return {
      error: 'license_required',
      message: `The "${toolName}" tool requires a PinCushion Pro or Team license. ` +
        `Pass --license-key YOUR_KEY when starting the MCP server, or upgrade at https://pincushion.io/pricing`,
      upgrade_url: 'https://pincushion.io/pricing'
    };
  }
  if (cloudSyncPlan && cloudSyncPlan !== 'pro' && cloudSyncPlan !== 'team') {
    return {
      error: 'plan_required',
      message: `The "${toolName}" tool requires Pro or Team. Your current plan is "${cloudSyncPlan}". Upgrade at https://pincushion.io/pricing`,
      current_plan: cloudSyncPlan,
      upgrade_url: 'https://pincushion.io/pricing'
    };
  }
  return null;
}

// ─── Sync Server (Supabase) ───────────────────────────────────────────────────

// Tracks the most recent cloud sync failure (Supabase 402 quota, 5xx, network
// drop, etc.) so tool responses can surface "cloud unreachable" instead of
// silently degrading to "no pins."
let lastCloudSyncError = null;

async function fetchRemoteAnnotations() {
  if (!SYNC_SERVER_URL) return {};

  const headers = { 'Content-Type': 'application/json' };
  // Use the same key resolution as cloud sync — checks env var, CLI arg, AND .license-key file
  const licenseKey = resolveCloudSyncKey() || SYNC_API_KEY;
  if (licenseKey) headers['x-license-key'] = licenseKey;

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
      lastCloudSyncError = { status: res.status, detail, at: new Date().toISOString() };
      return {};
    }
    const body = await res.json();
    lastCloudSyncError = null;

    // Handle both flat array and { annotations: [...] } envelope (Supabase returns envelope)
    const list = Array.isArray(body) ? body : (body.annotations || []);

    // Normalise snake_case fields from Supabase → camelCase expected by MCP tools
    const normalised = list.map(ann => ({
      id: ann.id,
      pageUrl: ann.pageUrl || ann.page_url || '',
      pageTitle: ann.pageTitle || ann.page_title || '',
      element: ann.element || {},
      pin: ann.pin || {},
      thread: ann.thread || [],
      status: ann.status || 'open',
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
      screenshotUrl: ann.screenshotUrl || ann.screenshot_url || null,
      licenseKey: ann.licenseKey || ann.license_key || null,
      projectId: ann.projectId || ann.project_id || null,
    }));

    // Group by pageUrl to match local file shape
    const byPage = {};
    for (const ann of normalised) {
      const url = ann.pageUrl || '';
      if (!byPage[url]) byPage[url] = { pageUrl: url, pageTitle: ann.pageTitle || url, annotations: [] };
      byPage[url].annotations.push(ann);
    }
    return byPage;
  } catch (err) {
    lastCloudSyncError = { status: 0, detail: err?.message || 'network error', at: new Date().toISOString() };
    return {};
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
  const { status, detail } = lastCloudSyncError;
  const hint = status === 402
    ? 'Supabase project is over its quota (HTTP 402). Cloud-stored pins are unreachable. Check supabase.com billing or wait for the quota window to reset.'
    : status === 0
      ? 'Could not reach the Pincushion sync endpoint (network error). Cloud-stored pins are unreachable.'
      : `Pincushion cloud sync failed with HTTP ${status}. Cloud-stored pins are unreachable.`;
  return {
    ...result,
    cloudSyncError: { status, detail, hint },
    message: `${hint} Detail: ${detail}`,
  };
}

// Create config object for core functions
const coreConfig = {
  feedbackDir: FEEDBACK_DIR,
  annotationsDir: ANNOTATIONS_DIR,
  syncServerUrl: SYNC_SERVER_URL,
  syncApiKey: SYNC_API_KEY,
  supabaseBase: CLOUD_SYNC_URL.replace(/\/sync-annotations$/, ''),
  get licenseKey() { return resolveCloudSyncKey(); },
};

// Refresh PINS.md on startup (now that coreConfig is defined), then every 15s
refreshPinsFile();
setInterval(refreshPinsFile, 15_000);

// Reconcile approved queue on startup — catches pins approved while server was down
setTimeout(() => reconcileApprovedQueue().catch(() => {}), 3000);

// Merge local files + remote Supabase data.
// Remote wins on a per-annotation basis (newer updatedAt takes precedence).
async function readAllAnnotations() {
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

async function toolGetAnnotations({ pageUrl, componentName, status, projectId } = {}) {
  return core.toolGetAnnotations(coreConfig, { pageUrl, componentName, status, projectId: resolveProjectFilter(projectId) }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
}

async function toolSearchAnnotations({ query }) {
  return core.toolSearchAnnotations(coreConfig, { query }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
}

async function toolGetFeedbackSummary({ projectId } = {}) {
  return core.toolGetFeedbackSummary(coreConfig, SYNC_SERVER_URL ? fetchRemoteAnnotations : null, { projectId: resolveProjectFilter(projectId) });
}

async function toolGetComponentFeedback({ componentName }) {
  return core.toolGetComponentFeedback(coreConfig, { componentName }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
}

async function toolResolveAnnotation({ annotationId, comment, resolvedBy }) {
  const result = await core.toolResolveAnnotation(coreConfig, { annotationId, comment, resolvedBy }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
  // Push resolution to cloud
  if (result.success) {
    const ann = await core.findAnnotationById(coreConfig, annotationId);
    if (ann) cloudSyncPush(ann).catch(() => {});
  }
  return result;
}

async function toolAddAgentReply({ annotationId, body, author }) {
  return core.toolAddAgentReply(coreConfig, { annotationId, body, author }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
}

// ─── Create Critique Pin (Pincushion AI) ─────────────────────────────────────
// Used by /critique and /critique-latest-deploy. The dev's local agent does the
// LLM work, then calls this to drop a bot-authored pin. Pincushion never sees
// the page or the critique — this just persists what the agent decided.

async function toolCreateCritiquePin({ pageUrl, pageTitle, componentName, selector, body, severity, tags, projectId }) {
  return core.toolCreateCritiquePin(
    coreConfig,
    { pageUrl, pageTitle, componentName, selector, body, severity, tags, projectId },
    SYNC_SERVER_URL ? fetchRemoteAnnotations : null
  );
}

// ─── Reply candidates + bot reply (Pincushion AI replies) ─────────────────────
async function toolGetReplyCandidates({ projectId } = {}) {
  return core.toolGetReplyCandidates(
    coreConfig,
    { projectId },
    SYNC_SERVER_URL ? fetchRemoteAnnotations : null
  );
}

async function toolAddBotReply({ annotationId, body }) {
  return core.toolAddBotReply(
    coreConfig,
    { annotationId, body },
    SYNC_SERVER_URL ? fetchRemoteAnnotations : null
  );
}

// ─── Critique queue tools (deploy-triggered AI critiques) ────────────────────
async function toolGetPendingCritiques({ projectId } = {}) {
  return core.toolGetPendingCritiques(coreConfig, { projectId });
}

async function toolCompleteCritiqueRequest({ id, pinCount }) {
  return core.toolCompleteCritiqueRequest(coreConfig, { id, pinCount });
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
  const result = await core.toolFixAndResolve(coreConfig, { annotationId, fixDescription, filePath, lineNumber, commitSha, branchName, prUrl }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
  if (result.success && CLOUD_SYNC) {
    const ann = await core.findAnnotationById(coreConfig, annotationId);
    if (ann) {
      const syncResult = await cloudSyncPush(ann);
      if (!syncResult.ok) {
        result.cloudSynced = false;
        result.cloudSyncError = syncResult.reason;
        if (syncResult.reason === 'license_rejected') {
          result.cloudSyncHint = "Run 'npx pincushion-mcp login' to refresh your session, then resolve again.";
        }
      } else {
        result.cloudSynced = true;
      }
    }
  }
  return result;
}

// ─── Read-only project context (for critic subagent) ────────────────────────
// Pure read — never mutates. Use this instead of configure_project when the
// caller only needs to inspect the project's brand context, URLs, etc.
async function toolGetProjectContext({ projectId, name } = {}) {
  return core.toolGetProjectContext(coreConfig, { projectId, name });
}

// ─── NEW: Get Setup Instructions ──────────────────────────────────────────────

async function toolGetSetupInstructions() {
  return {
    title: 'PinCushion Setup — 2 Steps',
    description: 'Connect visual feedback pins to your AI coding agent',
    quick_start: {
      step1: 'Install the Chrome extension: https://pincushion.io/install/chrome',
      step2: 'Add the MCP server to your IDE using one of the one-click methods below'
    },
    one_click_install: {
      cursor: {
        button_url: 'https://pincushion.io/install/cursor',
        deeplink: 'cursor://anysphere.cursor-mcp/install?name=pincushion&command=npx&args=pincushion-mcp%20--project-dir%20.%20--cloud-sync',
        description: 'Click "Add to Cursor" on pincushion.io, or paste the deeplink in your browser'
      },
      claude_code: {
        command: 'claude mcp add pincushion -- npx pincushion-mcp --project-dir . --cloud-sync',
        description: 'Run this in your project directory'
      },
      vs_code: {
        file: '.vscode/settings.json',
        content: {
          'mcp.servers': {
            pincushion: {
              command: 'npx',
              args: ['pincushion-mcp', '--project-dir', '${workspaceFolder}', '--cloud-sync']
            }
          }
        }
      },
      windsurf: {
        file: '~/.windsurf/mcp.json',
        content: {
          mcpServers: {
            pincushion: {
              command: 'npx',
              args: ['pincushion-mcp', '--project-dir', '.', '--cloud-sync']
            }
          }
        }
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
      setup: 'Set PINCUSHION_LICENSE_KEY env var or create .feedback/.license-key with your key from pincushion.io/dashboard',
      free_tier: '1 project, unlimited pins, no usage caps, 30s sync interval',
      pro_tier: 'Unlimited projects and pins, 90-day retention, 10s sync interval'
    },
    collaboration_integrations: {
      description: 'Slack and Microsoft Teams integrations use project-scoped incoming webhooks. Defaults are low-noise: pin_ready, mention, and follow_up.',
      setup_tool: 'configure_collaboration_integration',
      slack_oauth_tool: 'create_slack_install_link',
      audit_tool: 'list_collaboration_integrations',
      preview_tool: 'preview_collaboration_notification',
      recommended_events: collaborationEventGuide(),
    },
    documentation: 'Full docs: https://pincushion.io/docs'
  };
}

// ─── Configure project ────────────────────────────────────────────────────────

async function toolConfigureProject({
  name: projectName, urls = [], domain,
  commitTrailers, attributionComments, recordCommitSha,
  commentAccess, allowedDomains,
  brandContext, autoCritique,
  critiqueSignals, critiquePolicy, critiqueContext,
} = {}) {
  return core.toolConfigureProject(coreConfig, {
    name: projectName, urls, domain,
    commitTrailers, attributionComments, recordCommitSha,
    commentAccess, allowedDomains,
    brandContext, autoCritique,
    critiqueSignals, critiquePolicy, critiqueContext,
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
  const result = await core.toolGetActionablePins(coreConfig, { projectId: resolveProjectFilter(projectId), mode }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
  return withCloudError(result);
}

// ─── Claim Actionable Pin ─────────────────────────────────────────────────────

async function toolClaimPin({ annotationId, implementer } = {}) {
  const result = await core.toolClaimPin(coreConfig, { annotationId, implementer }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
  // Push claim status to cloud + remove from trigger file
  if (result.success) {
    const ann = await core.findAnnotationById(coreConfig, annotationId);
    if (ann) cloudSyncPush(ann).catch(() => {});
    removeFromApprovedQueue(annotationId).catch(() => {});
  }
  return result;
}

// ─── Approve Pin ─────────────────────────────────────────────────────────────

async function toolApprovePin({ annotationId, approvedBy } = {}) {
  const result = await core.toolApprovePin(coreConfig, { annotationId, approvedBy }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
  // Push approval to cloud + write trigger file
  if (result.success && !result.alreadyApproved) {
    const ann = await core.findAnnotationById(coreConfig, annotationId);
    if (ann) {
      cloudSyncPush(ann).catch(() => {});
      // Write trigger file so IDE extensions detect the approval
      const getBranchName = await loadGitModule();
      addToApprovedQueue({
        type: 'pin_approved',
        pinId: annotationId,
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
  return result;
}

// ─── Link Pin Deploy (A4) ────────────────────────────────────────────────────

async function toolLinkPinDeploy({ annotationId, deployUrl, deployedAt } = {}) {
  const result = await core.toolLinkPinDeploy(coreConfig, { annotationId, deployUrl, deployedAt }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
  return withCloudError(result);
}

// ─── Record Pin Verification (A5) ────────────────────────────────────────────

async function toolRecordPinVerification({ annotationId, status, notes, verifiedAt } = {}) {
  const result = await core.toolRecordPinVerification(coreConfig, { annotationId, status, notes, verifiedAt }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
  return withCloudError(result);
}

// ─── Time-to-Fix Metrics (A6) ────────────────────────────────────────────────
//
// Soft Pro/Team gate: Free callers get sample size + a planRequired hint
// instead of full percentiles. The agent can use sample size to nudge the
// stakeholder toward an upgrade without losing the conversation. Pro/Team
// callers get the full payload (median + p25 + p75 + humanized strings).

async function toolGetTimeToFixMetrics({ projectId, scope } = {}) {
  const result = await core.toolGetTimeToFixMetrics(coreConfig, { projectId: resolveProjectFilter(projectId), scope }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
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
  const result = await core.toolAssignPinToAgent(coreConfig, { annotationId, assignedBy }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
  if (result.success) {
    const ann = await core.findAnnotationById(coreConfig, annotationId);
    if (ann) cloudSyncPush(ann).catch(() => {});
  }
  return result;
}

// ─── Implement Approved Pins ─────────────────────────────────────────────────

async function toolGetApprovedPins({ projectId } = {}) {
  const result = await core.toolGetApprovedPins(coreConfig, { projectId: resolveProjectFilter(projectId) }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
  return withCloudError(result);
}

async function toolGetImplementationPacket({ pageUrl, projectId } = {}) {
  const result = await core.toolGetImplementationPacket(coreConfig, { pageUrl, projectId: resolveProjectFilter(projectId) }, SYNC_SERVER_URL ? fetchRemoteAnnotations : null);
  return withCloudError(result);
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

  // Fetch full pin data for selected IDs
  const allData = await readAllAnnotations();
  const selectedPins = [];

  for (const [url, data] of Object.entries(allData)) {
    for (const ann of (data.annotations || [])) {
      if (selectedIds.includes(ann.id)) {
        selectedPins.push(core.formatAnnotationForAgent(ann, selectedPins.length + 1));
      }
    }
  }

  return {
    totalSelected: selectedPins.length,
    selectedAt: selections.timestamp,
    pins: selectedPins,
    instructions: `${selectedPins.length} pin(s) selected for implementation. For each pin: read the thread, implement the requested change, then call fix_and_resolve({ annotationId, fixDescription }).`
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

    // 402 = seat limit reached — return upgrade info
    if (res.status === 402) {
      return {
        error: 'seat_limit_reached',
        message: data.message,
        currentSeats: data.currentSeats,
        maxSeats: data.maxSeats,
        upgrade: data.upgrade
      };
    }

    return data;
  } catch (err) {
    return { error: err.message };
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
    return await res.json();
  } catch (err) {
    return { error: err.message };
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
    return await res.json();
  } catch (err) {
    return { error: err.message };
  }
}

// Create a Figma-style invite link for a project. Returns a sharable URL
// that the recipient redeems via the landing page (/join/<token>) — no
// pre-existing license required for the invitee.
async function toolCreateInviteLink({ projectId, role = 'commenter', expiresInDays = 30, maxUses = 0 } = {}) {
  if (!projectId) return { error: 'projectId is required' };
  if (!['editor', 'commenter'].includes(role)) {
    return { error: 'role must be "editor" or "commenter"' };
  }
  if (!SYNC_SERVER_URL) return { error: 'Sync server not configured.' };
  const baseUrl = SYNC_SERVER_URL.replace('/sync-annotations', '');
  try {
    const headers = { 'Content-Type': 'application/json' };
    const licenseKey = resolveCloudSyncKey() || SYNC_API_KEY;
    if (licenseKey) headers['x-license-key'] = licenseKey;
    const res = await fetch(`${baseUrl}/create-invite`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        project_id: projectId,
        role,
        expires_in_days: expiresInDays,
        max_uses: maxUses,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      return { error: data.message || data.error || `Request failed (${res.status})` };
    }
    return {
      url: data.url,
      role: data.role,
      expiresAt: data.expires_at,
      maxUses: data.max_uses,
      instructions: `Share this URL with your teammate. They open it, enter their name + email, and join as ${data.role}. The link expires ${new Date(data.expires_at).toLocaleDateString()}${data.max_uses ? ` or after ${data.max_uses} uses` : ''}.`,
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function toolCreateShareReport({ projectId, pageUrl, title, expiresInDays } = {}) {
  if (!projectId) return { error: 'projectId is required' };
  if (!SYNC_SERVER_URL) return { error: 'Sync server not configured.' };
  const baseUrl = SYNC_SERVER_URL.replace('/sync-annotations', '');
  try {
    const headers = { 'Content-Type': 'application/json' };
    const licenseKey = resolveCloudSyncKey() || SYNC_API_KEY;
    if (licenseKey) headers['x-license-key'] = licenseKey;
    const res = await fetch(`${baseUrl}/shared-report`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        project_id: projectId,
        page_url: pageUrl,
        title,
        expires_in_days: expiresInDays,
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      return { error: data.message || data.error || `Request failed (${res.status})` };
    }
    return {
      url: data.url,
      expiresAt: data.expires_at,
      pageUrl: data.page_url,
      title: data.title,
      instructions: `Anyone with this URL can view the report — no extension, no account. It shows every non-archived pin${data.page_url ? ' on that page' : ' in the project'} with threads, status, and the PR/deploy/verification trail, and updates live as pins get resolved. ${data.expires_at ? `Expires ${new Date(data.expires_at).toLocaleDateString()}.` : 'It never expires (revocable server-side).'}`,
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function toolUploadPageSnapshot({ projectId, pageUrl, imagePath, imageB64, contentType = 'image/jpeg', width, height, pinPositions = [] } = {}) {
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
      return { error: `Could not read imagePath: ${err.message}` };
    }
  }
  if (!b64) return { error: 'Provide imagePath (preferred) or imageB64' };

  const baseUrl = SYNC_SERVER_URL.replace('/sync-annotations', '');
  try {
    const headers = { 'Content-Type': 'application/json' };
    const licenseKey = resolveCloudSyncKey() || SYNC_API_KEY;
    if (licenseKey) headers['x-license-key'] = licenseKey;
    const res = await fetch(`${baseUrl}/upload-screenshot`, {
      method: 'POST',
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
      }),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      return { error: data.message || data.error || `Request failed (${res.status})` };
    }
    return {
      url: data.url,
      pageUrl: data.page_url,
      width: data.width,
      height: data.height,
      pinsPlaced: data.pin_count,
      instructions: `Snapshot stored — the share report now renders the annotated page view for ${data.page_url} with ${data.pin_count} positioned pin(s). Re-capture and upload any time the page or its pins change; the latest snapshot wins.`,
    };
  } catch (err) {
    return { error: err.message };
  }
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
    defaults: ['pin_ready', 'mention', 'follow_up'],
    allEvents: {
      pin_ready: 'A pin moves into the developer-ready queue. Default on.',
      mention: 'A new human comment includes an @mention. Default on.',
      follow_up: 'A human adds a new comment after work is ready, in progress, implemented, or resolved. Default on.',
      new_pin: 'Every newly dropped open pin. Default off because it is noisy on active review days.',
      resolved: 'A pin is resolved. Default off for stakeholder-heavy channels; enable for release or QA channels.',
    },
    recommendedUseCases: [
      'Project dev channel: pin_ready + follow_up so developers see work and reopened conversations.',
      'Design/PM channel: mention + resolved so collaborators see explicit asks and closure without every pin.',
      'Page-specific launch channel: pageUrlPatterns plus pin_ready for a single staging or launch URL.',
      'Incident/QA channel: follow_up + resolved during a tight ship window, then pause the integration afterward.',
    ],
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
        error: data.error || `Request failed (${res.status})`,
        message: data.message,
        status: res.status,
        guideHint: 'Call preview_collaboration_notification for event types and payload shapes.',
      };
    }
    return { ...data, guide: collaborationEventGuide() };
  } catch (err) {
    return { error: err.message };
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
        if (data.error === 'no_slack_link') {
          return { error: data.error, message: data.message + ' Once linked, you can mute or toggle events from here.' };
        }
        return { error: data.error || `Request failed (${res.status})`, status: res.status };
      }
      return { ...data, hint: 'Pass any of: mute ("1h" | "today" | "forever" | "off"), eventNewPin, eventPinReady, eventMention, eventFollowUp, eventResolved (booleans), quietHoursStart / quietHoursEnd (0-23), timezone (IANA name), digestMode ("instant" | "hourly" | "daily").' };
    }
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(args),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.error === 'no_slack_link') {
        return { error: data.error, message: data.message };
      }
      return { error: data.error || `Request failed (${res.status})`, status: res.status, message: data.message };
    }
    return data;
  } catch (err) {
    return { error: err.message };
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
    if (!res.ok) return { error: data.error || `Request failed (${res.status})`, message: data.message, status: res.status, requiredScopes: data.requiredScopes };
    return {
      ...data,
      // The agent-flow install URL pre-binds the project; the storefront
      // URL is the simpler alternative if the user just wants to install
      // once and let auto-claim handle the rest (since May 2026).
      storefrontUrl: 'https://pincushion.io/install/slack',
      recommendation: 'For most users the storefront URL is simpler — install once, and if your Slack email matches your Pincushion account, the workspace auto-links and DMs flow without per-project setup. Use the agent installUrl above only if you want to pre-bind this specific project before the install completes.',
      instructions: 'Open installUrl, choose the Slack channel, and approve. Slack will redirect back to Pincushion and the incoming webhook will be stored automatically.',
      guide: collaborationEventGuide(),
    };
  } catch (err) {
    return { error: err.message };
  }
}

async function toolListCollaborationIntegrations({ projectId } = {}) {
  if (!projectId) return { error: 'projectId is required' };
  const headers = integrationHeaders();
  if (!headers) return { error: 'License key required. Set PINCUSHION_LICENSE_KEY or .feedback/.license-key.' };
  try {
    const res = await fetch(`${integrationBaseUrl()}/manage-integrations/list?project_id=${encodeURIComponent(projectId)}`, { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error || `Request failed (${res.status})`, status: res.status };
    return { ...data, guide: collaborationEventGuide() };
  } catch (err) {
    return { error: err.message };
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
      message: 'Claim tokens are now optional. New Slack installs via https://pincushion.io/install/slack auto-link to your Pincushion account if your Slack email matches. DMs flow automatically; channel broadcasts opt-in via `/pincushion subscribe <project>` inside any channel. Pass a claimToken here only if you were shown one on the post-install page (legacy fallback for unmatched emails).',
      installUrl: 'https://pincushion.io/install/slack',
      docs: 'https://pincushion.io/docs',
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
      if (data.error === 'claim_token_invalid_or_expired') {
        return { error: 'That claim token is invalid or has expired. Tokens are valid for 7 days from the time you clicked "Add to Slack". Generate a fresh one at https://pincushion.io/install/slack — note that auto-claim handles most installs without a token now.' };
      }
      return { error: data.error || `Request failed (${res.status})`, status: res.status };
    }
    return { ...data, guide: collaborationEventGuide() };
  } catch (err) {
    return { error: err.message };
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
    if (!res.ok) return { error: data.error || `Request failed (${res.status})`, status: res.status };
    return data;
  } catch (err) {
    return { error: err.message };
  }
}

async function toolPreviewCollaborationNotification({ provider = 'slack', event = 'pin_ready' } = {}) {
  // Mention events name the user in the title — the dispatcher does the
  // same in production. The sample comment includes the @mention so the
  // preview shows what the @mention bolding looks like in Slack.
  const sampleMention = '@devon';
  const eventLabels = {
    mention: `${sampleMention} was mentioned on a pin`,
    follow_up: 'added a follow-up on a pin',
    pin_ready: 'marked a pin ready for implementation',
    new_pin: 'dropped a new pin',
    resolved: 'resolved a pin',
  };
  const title = `Pincushion: ${eventLabels[event] || 'pin update'}`;
  const pageTitle = 'Checkout settings';
  const author = 'Priya';
  const baseComment = 'The save button looks disabled after editing the billing email. Can we make the active state clearer?';
  const comment = event === 'mention' ? `${sampleMention} — ${baseComment}` : baseComment;
  const pinUrl = 'https://app.example.com/settings?pincushionPin=ann_sample';
  const pinId = 'ann_sample';
  // For Slack mention previews, mirror production behavior of bolding the
  // @mention so the payload sample matches what the user actually sees.
  const slackComment = event === 'mention'
    ? comment.replace(/(^|[\s([{])@([a-zA-Z0-9._-]{2,40})\b/g, (_, p, n) => `${p}*@${n}*`)
    : comment;

  const payload = provider === 'teams'
    ? {
        type: 'message',
        attachments: [{
          contentType: 'application/vnd.microsoft.card.adaptive',
          content: {
            $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
            type: 'AdaptiveCard',
            version: '1.4',
            body: [
              { type: 'TextBlock', size: 'Medium', weight: 'Bolder', text: title, wrap: true, color: event === 'mention' ? 'Attention' : 'Default' },
              { type: 'TextBlock', text: pageTitle, wrap: true, weight: 'Bolder', spacing: 'Small' },
              { type: 'TextBlock', text: comment, wrap: true, isSubtle: true, spacing: 'Small' },
              { type: 'FactSet', facts: [
                { title: 'Author', value: author },
                { title: 'Pin', value: pinId },
              ]},
            ],
            actions: [
              { type: 'Action.OpenUrl', title: 'Open pin', url: pinUrl },
            ],
          },
        }],
      }
    : {
        text: `${title} on ${pageTitle}`,
        blocks: [
          { type: 'section', text: { type: 'mrkdwn', text: `*${title}*\n*${pageTitle}*` } },
          { type: 'section', text: { type: 'mrkdwn', text: `>${slackComment}` } },
          { type: 'context', elements: [{ type: 'mrkdwn', text: `By ${author} • Pin ${pinId}` }] },
          { type: 'actions', elements: [{ type: 'button', text: { type: 'plain_text', text: 'Open pin' }, url: pinUrl }] },
        ],
      };

  return {
    provider,
    event,
    payloadShape: provider === 'teams' ? 'Microsoft Teams Adaptive Card (Workflows-compatible)' : 'Slack Block Kit incoming webhook payload',
    sample: { title, pageTitle, author, comment, pinUrl, pinId },
    payload,
    guide: collaborationEventGuide(),
  };
}


// ─── MCP Server Definition ────────────────────────────────────────────────────

const server = new Server(
  { name: 'pincushion', version: '1.0.0' },
  { capabilities: { tools: {}, prompts: {}, resources: { subscribe: true }, logging: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_annotations',
      description: 'Retrieve annotation pins from the .feedback/ directory. Filter by page URL, LWC component name, or status. Use this to understand what feedback exists before making changes.',
      inputSchema: {
        type: 'object',
        properties: {
          pageUrl: { type: 'string', description: 'Filter by page URL (partial match OK). e.g. "WML_Care_Home"' },
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
      description: 'Used by /critique-latest-deploy. Lists pending critique requests queued by the deploy-hook for the current license. Returns request id + page URLs + deploy hash. Newest-first. Free on all plans (the gating happened at enqueue time on the deploy-hook side: only Pro/Team licenses produce queue entries).',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Optional project ID filter. Omit to list across all the license\'s projects.' }
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
      name: 'create_critique_pin',
      description: 'Create a pin authored by Pincushion AI. ONLY call this from the pincushion-critic subagent or the /critique-latest-deploy flow — never from a regular user prompt, since the bot voice is reserved for AI-driven UI/copy/a11y feedback. Each call should produce one tasteful, high-signal pin (max 3 per page in a critique run). The body must be concrete and actionable: name the specific element + the specific problem + the suggested fix in <40 words. Forbidden: layout philosophy, business-model commentary, generic "consider improving hierarchy" advice. Always read the project\'s critique context (`ai.critique.effectiveContext` from get_project_context — falls back to `brandContext` when no compiled brief exists) before drafting the body so the critique is on-brand. If `ai.critique.staleness` is "stale" or "missing", suggest the user run /refresh-brand before continuing.',
      inputSchema: {
        type: 'object',
        required: ['pageUrl', 'body'],
        properties: {
          pageUrl: { type: 'string', description: 'Full URL of the page being critiqued (e.g. "http://localhost:3000/dashboard").' },
          pageTitle: { type: 'string', description: 'Optional page title for the .feedback file header. Defaults to pageUrl if omitted.' },
          componentName: { type: 'string', description: 'Optional component name (e.g. LWC component, React component) for grouping. Used by get_component_feedback.' },
          selector: { type: 'string', description: 'CSS selector for the element the critique targets. The Chrome extension uses this to position the pin since the bot has no live page coords. Be specific (e.g. \'main button[type="submit"]\' not just \'button\').' },
          body: { type: 'string', description: 'The critique itself. Concrete + actionable, <40 words, names the element and proposes a fix. This becomes the first thread message on the pin.' },
          severity: { type: 'string', enum: ['high', 'medium'], description: '"high" = ships-blocking (broken contrast, broken keyboard nav, misleading CTA copy). "medium" = worth-fixing (minor copy issues, cramped spacing, polish opportunities). \'low\' is intentionally not allowed — bot pins must be worth acting on.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags. "pincushion-ai" is added automatically. Add domain tags like "a11y", "copy", "deploy:<hash>" for traceability.' },
          projectId: { type: 'string', description: 'Project ID to associate the pin with. Defaults to the MCP server\'s configured project.' }
        }
      }
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
      description: 'Record the outcome of Pincushion AI\'s post-deploy verification on a resolved pin. Called by the critic subagent after running auto-critique on a fresh deploy. Lets stakeholders see "Pincushion AI verified this fix" (or regressed/inconclusive) directly on the pin in the dashboard, closing the "did my feedback actually ship correctly?" loop.',
      inputSchema: {
        type: 'object',
        required: ['annotationId', 'status'],
        properties: {
          annotationId: { type: 'string', description: 'The pin ID being verified' },
          status: {
            type: 'string',
            enum: ['verified', 'regressed', 'inconclusive', 'pending'],
            description: '"verified" — fix is in place, no regressions. "regressed" — the fix introduced a new issue. "inconclusive" — couldn\'t determine outcome (e.g. element gone, page errored). "pending" — explicit reset.'
          },
          notes: { type: 'string', description: 'Optional plain-text verification notes (up to 2KB) explaining the verdict.' },
          verifiedAt: { type: 'string', description: 'Optional ISO timestamp. Defaults to now.' }
        }
      }
    },
    {
      name: 'link_pin_deploy',
      description: 'Link a deploy URL to a resolved pin. Typically called by the deploy-hook edge function once a deploy that includes the pin\'s fix goes live. Stakeholders see the deploy URL on the resolved pin in the dashboard. Re-runs overwrite the previous deploy URL (latest deploy wins).',
      inputSchema: {
        type: 'object',
        required: ['annotationId', 'deployUrl'],
        properties: {
          annotationId: { type: 'string', description: 'The annotation ID to link' },
          deployUrl: { type: 'string', description: 'The http(s) URL of the deploy that includes the fix (e.g. "https://pincushion.io" or a Vercel preview URL)' },
          deployedAt: { type: 'string', description: 'Optional ISO timestamp of the deploy. Defaults to now.' }
        }
      }
    },
    {
      name: 'get_setup_instructions',
      description: 'Get instructions for setting up and connecting the PinCushion browser extension to this MCP server. Includes configuration examples for Cursor, Claude Desktop, Claude Code, VS Code, Windsurf, and other agents.',
      inputSchema: { type: 'object', properties: {} }
    },
    {
      name: 'get_project_context',
      description: 'Read-only lookup of a project\'s context (name, URLs, brand context, autoCritique flag, traceability settings). Use this whenever you only need to inspect — never mutates, never touches the network. The Pincushion AI critic subagent calls this before generating any pin, since `configure_project` would otherwise upsert the project, sync to cloud, and create a deploy hook on a typo\'d project name. Pass `projectId` for an exact lookup, `name` to look up by display name, or no arguments to list all projects in this workspace.',
      inputSchema: {
        type: 'object',
        properties: {
          projectId: { type: 'string', description: 'Optional exact project ID. Mutually exclusive with `name`.' },
          name: { type: 'string', description: 'Optional project display name. Returns the matching project if found, or `availableProjects` if not.' }
        }
      }
    },
    {
      name: 'configure_project',
      description: 'Register a Pincushion project and associate it with your app\'s URLs. Once registered, anyone visiting those URLs with the Pincushion extension installed will automatically see the pin UI — no meta tag or manual setup needed. Pass both your local dev URL and your live/staging URL so the extension activates in all environments. Optional traceability knobs (commitTrailers, attributionComments, recordCommitSha) control how implemented pins are recorded in git and source — see each property\'s description. **NOTE for read-only use cases:** if you only need to look up brand context, URLs, or other project metadata, call `get_project_context` instead — `configure_project` mutates state (upserts the project row, syncs to cloud, creates a deploy hook, idempotently inserts the bot member).',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'Human-readable project name (e.g. "Superbill Pro", "My SaaS Staging")' },
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
            description: 'Who can drop pins on this project. "open" (default — Free, Pro, Team) — anyone with the URL. "domain" (Pro/Team) — only emails in the allowedDomains list. "invited" (Pro/Team) — only emails added via add_member. Free projects can only use "open"; the server returns 402 plan_required if a Free license attempts "domain" or "invited".'
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
      description: 'Get all pins waiting for developer attention. Returns three categories: (1) "auto-agent" — pins explicitly sent to the agent via "Send to Agent" or YOLO mode; (2) "follow-up" — previously implemented pins with new user comments; (3) "review" — open reviewer comments that a developer has not yet picked up (the standard team collaboration queue). Use this as your starting point for both auto-agent workflows and manual review sessions.',
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
      description: 'Add a collaborator to a PinCushion project. Developers consume a paid seat and can implement pins. Commenters are free and unlimited. Returns an upgrade prompt if the seat limit is reached.',
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
      description: 'List all members of a PinCushion project with their roles, plus seat usage info.',
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
      description: 'Remove a collaborator from a PinCushion project. Frees up the seat if they were an editor.',
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
          maxUses: { type: 'integer', description: 'How many people can redeem this link. 0 = unlimited. Default: 0.' }
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
          expiresInDays: { type: 'number', description: 'Optional: days until the link expires (1–365). Omit for a non-expiring link.' }
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
          }
        }
      }
    },
    {
      name: 'configure_collaboration_integration',
      description: 'Connect a Pincushion project to Slack or Microsoft Teams using an incoming webhook. Low-noise defaults mirror Figma-style subscriptions: notify on pins marked ready, @mentions, and follow-up comments on work already being handled. Raw new-pin and resolved updates are opt-in.',
      inputSchema: {
        type: 'object',
        required: ['projectId', 'provider', 'webhookUrl'],
        properties: {
          projectId: { type: 'string', description: 'The Pincushion project ID.' },
          provider: { type: 'string', enum: ['slack', 'teams'], description: 'Destination provider.' },
          webhookUrl: { type: 'string', description: 'Slack incoming webhook URL or Microsoft Teams incoming webhook/workflow URL. Stored server-side and not returned in full.' },
          name: { type: 'string', description: 'Subscription name. Use multiple names for separate project/page subscriptions. Default: default.' },
          targetLabel: { type: 'string', description: 'Human label for the destination, such as #design-review or Teams QA channel.' },
          events: { type: 'array', items: { type: 'string', enum: ['pin_ready', 'mention', 'follow_up', 'new_pin', 'resolved'] }, description: 'Events to send. Default: pin_ready, mention, follow_up.' },
          pageUrlPatterns: { type: 'array', items: { type: 'string' }, description: 'Optional URL substrings for page-specific subscriptions. Empty means all project URLs.' },
          status: { type: 'string', enum: ['active', 'paused'], description: 'Pause without deleting the subscription. Default: active.' },
          sendTest: { type: 'boolean', description: 'When true, posts a one-time test message to the webhook after saving.' }
        }
      }
    },
    {
      name: 'create_slack_install_link',
      description: 'Generate an Add-to-Slack OAuth URL pre-bound to a project. Most users should prefer the public storefront URL (also returned, https://pincushion.io/install/slack) — since May 2026, that auto-links to a Pincushion license when the installer\'s Slack email matches, and channels are subscribed afterward via /pincushion subscribe inside Slack. Use this agent-flow URL only when you want the install to attach to one specific project up front.',
      inputSchema: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', description: 'The Pincushion project ID.' },
          name: { type: 'string', description: 'Subscription name. Default: default.' },
          targetLabel: { type: 'string', description: 'Optional expected channel label, used only before Slack returns the selected channel.' },
          events: { type: 'array', items: { type: 'string', enum: ['pin_ready', 'mention', 'follow_up', 'new_pin', 'resolved'] }, description: 'Events to send. Default: pin_ready, mention, follow_up.' },
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
          events: { type: 'array', items: { type: 'string', enum: ['pin_ready', 'mention', 'follow_up', 'new_pin', 'resolved'] }, description: 'Optional events override. Defaults to whatever the storefront install captured (pin_ready, mention, follow_up).' },
          pageUrlPatterns: { type: 'array', items: { type: 'string' }, description: 'Optional URL substrings for page-specific subscriptions.' }
        }
      }
    },
    {
      name: 'remove_collaboration_integration',
      description: 'Remove a Slack or Microsoft Teams webhook subscription from a Pincushion project.',
      inputSchema: {
        type: 'object',
        required: ['projectId'],
        properties: {
          projectId: { type: 'string', description: 'The Pincushion project ID.' },
          integrationId: { type: 'string', description: 'Exact integration ID from list_collaboration_integrations.' },
          provider: { type: 'string', enum: ['slack', 'teams'], description: 'Provider to remove when integrationId is omitted.' },
          name: { type: 'string', description: 'Subscription name to remove with provider. Default: default.' }
        }
      }
    },
    {
      name: 'preview_collaboration_notification',
      description: 'Preview the Slack/Teams notification shape and recommended event routing before connecting a real webhook.',
      inputSchema: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['slack', 'teams'], description: 'Provider payload to preview. Default: slack.' },
          event: { type: 'string', enum: ['pin_ready', 'mention', 'follow_up', 'new_pin', 'resolved'], description: 'Event to preview. Default: pin_ready.' }
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
          quietHoursStart: { type: 'integer', minimum: 0, maximum: 23, description: 'Quiet-hours start hour (0-23) in `timezone`.' },
          quietHoursEnd:   { type: 'integer', minimum: 0, maximum: 23, description: 'Quiet-hours end hour (0-23) in `timezone`.' },
          timezone: { type: 'string', description: 'IANA timezone (e.g. America/Los_Angeles) for quiet hours.' },
          digestMode: { type: 'string', enum: ['instant', 'hourly', 'daily'], description: 'Delivery cadence. "instant" is the default; "hourly" and "daily" are reserved for a future digest implementation.' }
        }
      }
    }
  ]
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
        text: md,
      }],
    };
  }
  if (uri === 'pincushion://approved-queue') {
    const queue = await readApprovedQueue();
    return {
      contents: [{
        uri: 'pincushion://approved-queue',
        mimeType: 'application/json',
        text: JSON.stringify(queue, null, 2),
      }],
    };
  }
  throw new Error(`Unknown resource: ${uri}`);
});

// ─── MCP Prompts (slash commands) ────────────────────────────────────────────
// Advertises /pins, /my-pins, /resolve, /feedback-summary, /setup as native
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
            ? `Use the pincushion MCP tool \`configure_project\` to register this project with URLs: ${urls.join(', ')}. After registering, confirm that the extension will now auto-activate on those URLs.`
            : 'Use the pincushion MCP tool `configure_project` to register this project. Auto-detect the project name and URLs from package.json, .env, and vercel.json. After registering, tell me which URLs were registered and confirm the extension will activate on them automatically.' },
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

    default:
      throw new Error(`Unknown prompt: ${name}`);
  }
});

// Single source of truth for the tool dispatch table. Both the MCP CallTool
// handler and the REST /call-tool endpoint route through this — keeps the
// 24+ tool cases from drifting between transports.
async function dispatchTool(toolName, toolArgs = {}) {
  switch (toolName) {
    case 'get_annotations':           return await toolGetAnnotations(toolArgs);
    case 'search_annotations':        return await toolSearchAnnotations(toolArgs);
    case 'get_feedback_summary':      return await toolGetFeedbackSummary(toolArgs || {});
    case 'get_component_feedback':    return await toolGetComponentFeedback(toolArgs);
    case 'resolve_annotation':        return await toolResolveAnnotation(toolArgs);
    case 'add_agent_reply':           return await toolAddAgentReply(toolArgs);
    case 'create_critique_pin':       return await toolCreateCritiquePin(toolArgs);
    case 'get_reply_candidates':      return await toolGetReplyCandidates(toolArgs);
    case 'add_bot_reply':              return await toolAddBotReply(toolArgs);
    case 'get_pending_critiques':     return await toolGetPendingCritiques(toolArgs);
    case 'complete_critique_request': return await toolCompleteCritiqueRequest(toolArgs);
    case 'fix_and_resolve':            return await toolFixAndResolve(toolArgs);
    case 'link_pin_deploy':            return await toolLinkPinDeploy(toolArgs);
    case 'record_pin_verification':    return await toolRecordPinVerification(toolArgs);
    case 'get_time_to_fix_metrics':    return await toolGetTimeToFixMetrics(toolArgs);
    case 'apply_preview':
      return { success: false, error: 'apply_preview is not available in v1. Use fix_and_resolve instead.' };
    case 'get_setup_instructions':    return await toolGetSetupInstructions();
    case 'get_project_context':       return await toolGetProjectContext(toolArgs);
    case 'configure_project':          return await toolConfigureProject(toolArgs);
    case 'update_critique_context':    return await toolUpdateCritiqueContext(toolArgs);
    case 'get_actionable_pins':       return await toolGetActionablePins(toolArgs);
    case 'claim_pin':                  return await toolClaimPin(toolArgs);
    case 'approve_pin':                return await toolApprovePin(toolArgs);
    case 'assign_pin_to_agent':        return await toolAssignPinToAgent(toolArgs);
    case 'implement_approved_pins':   return await toolGetApprovedPins(toolArgs);
    case 'get_implementation_packet': return await toolGetImplementationPacket(toolArgs);
    case 'get_selected_pins':         return await toolGetSelectedPins();
    case 'add_member':                 return await toolAddMember(toolArgs);
    case 'list_members':               return await toolListMembers(toolArgs);
    case 'remove_member':              return await toolRemoveMember(toolArgs);
    case 'create_invite_link':         return await toolCreateInviteLink(toolArgs);
    case 'create_share_report':        return await toolCreateShareReport(toolArgs);
    case 'upload_page_snapshot':       return await toolUploadPageSnapshot(toolArgs);
    case 'configure_collaboration_integration': return await toolConfigureCollaborationIntegration(toolArgs);
    case 'create_slack_install_link':  return await toolCreateSlackInstallLink(toolArgs);
    case 'list_collaboration_integrations':     return await toolListCollaborationIntegrations(toolArgs);
    case 'claim_pending_slack_install':         return await toolClaimPendingSlackInstall(toolArgs);
    case 'remove_collaboration_integration':    return await toolRemoveCollaborationIntegration(toolArgs);
    case 'preview_collaboration_notification':  return await toolPreviewCollaborationNotification(toolArgs);
    case 'set_slack_preferences':               return await toolSetSlackPreferences(toolArgs);
    default:                           return { error: `Unknown tool: ${toolName}` };
  }
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    // Gate pro-only tools behind license key
    if (PRO_TOOLS.has(name)) {
      const gate = requirePro(name);
      if (gate) {
        return { content: [{ type: 'text', text: JSON.stringify(gate, null, 2) }] };
      }
    }

    const result = await dispatchTool(name, args);

    // Prepend any queued Realtime notifications + Pincushion AI banner.
    // The banner surfaces pending bot work (replies + critiques) so the
    // queue-and-poll latency stays "next IDE session" and not "whenever
    // the dev remembers".
    const notifications = drainNotifications(resolveProjectFilter(args.projectId));
    const aiBanner = await pincushionPendingBanner();
    const localOnlyBanner = localOnlyModeBanner();
    const resultText = JSON.stringify(result, null, 2);

    return {
      content: [{ type: 'text', text: localOnlyBanner + aiBanner + notifications + resultText }]
    };
  } catch (err) {
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: err.message, stack: err.stack }) }],
      isError: true
    };
  }
});

// ─── REST API Wrapper (Optional) ──────────────────────────────────────────────

if (REST_MODE) {
  const restServer = http.createServer(async (req, res) => {
    // CORS for Chrome extension
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'ok', mode: 'rest', projectDir: PROJECT_DIR }));
      return;
    }

    if (req.method === 'POST' && req.url === '/call-tool') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { toolName, args: toolArgs } = JSON.parse(body);

          // Gate pro-only tools behind license key (REST path)
          if (PRO_TOOLS.has(toolName)) {
            const gate = requirePro(toolName);
            if (gate) {
              res.writeHead(402);
              res.end(JSON.stringify({ success: false, ...gate }));
              return;
            }
          }

          const result = await dispatchTool(toolName, toolArgs);

          res.writeHead(200);
          res.end(JSON.stringify({ success: true, result }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    // ─── Push annotation from browser extension ────────────────────────────
    // The extension POSTs individual annotations here so they land on disk
    // where the MCP tools (get_actionable_pins, etc.) can read them.
    if (req.method === 'POST' && req.url === '/push-annotation') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const ann = JSON.parse(body);
          if (!ann.pageUrl || !ann.id) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing pageUrl or id' }));
            return;
          }
          // Read existing page data or create new
          const slug = core.urlToSlug(ann.pageUrl);
          const filePath = join(ANNOTATIONS_DIR, `${slug}.json`);
          let pageData = { pageUrl: ann.pageUrl, pageTitle: ann.pageTitle || ann.pageUrl, annotations: [] };
          if (existsSync(filePath)) {
            try { pageData = JSON.parse(await readFile(filePath, 'utf-8')); } catch {}
          }
          // Update pageTitle if the annotation has a better one
          if (ann.pageTitle && (!pageData.pageTitle || pageData.pageTitle === pageData.pageUrl)) {
            pageData.pageTitle = ann.pageTitle;
          }
          // Upsert annotation
          const idx = pageData.annotations.findIndex(a => a.id === ann.id);
          if (idx >= 0) {
            pageData.annotations[idx] = { ...pageData.annotations[idx], ...ann };
          } else {
            pageData.annotations.push(ann);
          }
          await core.writeAnnotationFile(ANNOTATIONS_DIR, pageData);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ─── Bulk push annotations from extension ─────────────────────────────
    if (req.method === 'POST' && req.url === '/push-annotations') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { pageUrl, annotations } = JSON.parse(body);
          if (!pageUrl || !Array.isArray(annotations)) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing pageUrl or annotations array' }));
            return;
          }
          const slug = core.urlToSlug(pageUrl);
          const filePath = join(ANNOTATIONS_DIR, `${slug}.json`);
          let pageData = { pageUrl, annotations: [] };
          if (existsSync(filePath)) {
            try { pageData = JSON.parse(await readFile(filePath, 'utf-8')); } catch {}
          }
          // Merge each annotation
          for (const ann of annotations) {
            const idx = pageData.annotations.findIndex(a => a.id === ann.id);
            if (idx >= 0) {
              pageData.annotations[idx] = { ...pageData.annotations[idx], ...ann };
            } else {
              pageData.annotations.push(ann);
            }
          }
          await core.writeAnnotationFile(ANNOTATIONS_DIR, pageData);
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, count: annotations.length }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found. Use /health for health check or POST /call-tool to invoke tools.' }));
  });

  restServer.listen(REST_PORT, () => {
    console.error(`PinCushion REST API server listening on port ${REST_PORT}`);
  });
} else {
  // ─── Start MCP Server ────────────────────────────────────────────────────────

  const transport = new StdioServerTransport();
  await server.connect(transport);
  mcpConnected = true;
}

// ─── Local Bridge Server ──────────────────────────────────────────────────────
// Always start a lightweight HTTP server on localhost so the browser extension
// can push annotations directly to disk (bypassing Supabase for local dev).
// This runs alongside MCP stdio transport when not in REST_MODE.

if (!REST_MODE) {
  const bridgeServer = http.createServer(async (req, res) => {
    // CORS for Chrome extension
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');

    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200);
      res.end(JSON.stringify({
        status: 'ok',
        version: 'v1-slim',
        projectDir: PROJECT_DIR,
      }));
      return;
    }

    // ── GET /status?pageUrl=... ──────────────────────────────────────────
    // Extension polls this every 5s to detect agent completions.
    // Returns both implemented and resolved annotations.
    if (req.method === 'GET' && (req.url?.startsWith('/resolved') || req.url?.startsWith('/status'))) {
      try {
        const urlParams = new URL(req.url, `http://localhost:${BRIDGE_PORT}`);
        const pageUrl = urlParams.searchParams.get('pageUrl') || '';
        if (!pageUrl) { res.writeHead(400); res.end(JSON.stringify({ resolved: [], implemented: [] })); return; }
        const slug = core.urlToSlug(pageUrl);
        const filePath = join(ANNOTATIONS_DIR, `${slug}.json`);
        let resolved = [];
        let implemented = [];
        if (existsSync(filePath)) {
          try {
            const data = JSON.parse(await readFile(filePath, 'utf-8'));
            const anns = data.annotations || [];
            resolved = anns.filter(a => a.status === 'resolved');
            implemented = anns.filter(a => a.action === 'implemented');
          } catch {}
        }
        res.writeHead(200);
        res.end(JSON.stringify({ resolved, implemented }));
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({ resolved: [], implemented: [], error: err.message }));
      }
      return;
    }

    // ── POST /approve-pin — Dashboard approves a pin ────────────────────
    if (req.method === 'POST' && req.url === '/approve-pin') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const { annotationId, approvedBy } = JSON.parse(body);
          const result = await toolApprovePin({ annotationId, approvedBy: approvedBy || 'Dashboard User' });
          console.error(`[bridge] Pin ${annotationId} approved`);
          refreshPinsFile();
          res.writeHead(200);
          res.end(JSON.stringify(result));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── POST /select-pins — Dashboard sends selected pin IDs ──────────────
    if (req.method === 'POST' && req.url === '/select-pins') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const data = JSON.parse(body);
          await core.writeSelections(coreConfig, data);
          console.error(`[bridge] Saved ${(data.selectedPins || []).length} pin selection(s)`);
          // Refresh PINS.md + dashboard to reflect selections
          refreshPinsFile();
          res.writeHead(200);
          res.end(JSON.stringify({ ok: true, count: (data.selectedPins || []).length }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/push-annotation') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', async () => {
        try {
          const ann = JSON.parse(body);
          if (!ann.pageUrl || !ann.id) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Missing pageUrl or id' }));
            return;
          }
          const slug = core.urlToSlug(ann.pageUrl);
          const filePath = join(ANNOTATIONS_DIR, `${slug}.json`);
          let pageData = { pageUrl: ann.pageUrl, pageTitle: ann.pageTitle || ann.pageUrl, annotations: [] };
          if (existsSync(filePath)) {
            try { pageData = JSON.parse(await readFile(filePath, 'utf-8')); } catch {}
          }
          if (ann.pageTitle && (!pageData.pageTitle || pageData.pageTitle === pageData.pageUrl)) {
            pageData.pageTitle = ann.pageTitle;
          }
          const idx = pageData.annotations.findIndex(a => a.id === ann.id);
          if (idx >= 0) {
            pageData.annotations[idx] = { ...pageData.annotations[idx], ...ann };
          } else {
            pageData.annotations.push(ann);
          }
          await core.writeAnnotationFile(ANNOTATIONS_DIR, pageData);

          res.writeHead(200);
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ error: 'Not found' }));
  });

  bridgeServer.listen(BRIDGE_PORT, '127.0.0.1', () => {
    const address = bridgeServer.address();
    const port = typeof address === 'object' && address ? address.port : BRIDGE_PORT;
    console.error(`PinCushion local bridge listening on 127.0.0.1:${port}`);
  });
  bridgeServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`Bridge port ${BRIDGE_PORT} already in use — local bridge disabled.`);
    }
  });
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
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
  process.on(sig, () => {
    console.error(`[pincushion] received ${sig} — host is stopping the server, exiting`);
    process.exit(0);
  });
}
process.on('exit', (code) => console.error(`[pincushion] process exit (code ${code})`));
// stdin EOF means the host closed the stdio transport — the usual "disconnect".
process.stdin.on('end', () => console.error('[pincushion] stdin EOF — host closed the transport'));
process.stdin.on('close', () => console.error('[pincushion] stdin stream closed'));
