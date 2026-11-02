#!/usr/bin/env node
// Customer-shippable Playwright capture for annotated share-report snapshots.
//
// Legacy usage (kept byte-for-byte compatible at the interface boundary):
//   node capture-snapshot.mjs <pageUrl> <pinsJsonOrFile> <outJpegPath> [flags]
//
// Reconciliation additions:
//   node capture-snapshot.mjs --probe <pageUrl> <outJpegPath> [--discover] [--require-auth]
//   node capture-snapshot.mjs --reconcile <rootUrl> <outputDir> \
//     --inventory=<json-or-file> --previous-receipts=<json-or-file> [--discover] [--require-auth]
//
// Probe/reconcile modes allow zero pins and return local semantic + visual
// fingerprint evidence.  Reconcile captures both canonical viewports in one
// origin-bound browser context and writes JPEGs only for added/changed pages.
// Nothing in this script uploads images, storage state, DOM entries, or pixels.

import { createHash } from 'crypto';
import { existsSync, mkdirSync, readFileSync, readSync, writeFileSync } from 'fs';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import {
  collectAuthenticationChallengeSignals,
  collectSemanticFingerprint,
  collectVisibleSemanticElements,
  deriveVisualFingerprint,
  inspectNonDestructivePageState,
  resolveExactSnapshotTargets,
  resolveSnapshotTargets,
  scaleSnapshotTargets,
} from '../lib/snapshot-capture-core.js';
import {
  CANONICAL_DEPLOYMENT_VIEWPORTS,
  classifyDeploymentPage,
  normalizeInventoryUrl,
} from '../lib/deployment-reconciliation.js';
import {
  AUTH_CAPTURE_FAILURE_EXIT_CODE,
  captureAuthReceipt,
  classifyAuthenticationChallenge,
  resolveCaptureAuthentication,
} from '../lib/capture-auth-state.js';
import {
  captureLoopbackOriginForTarget,
  createCaptureNavigationGuard,
  NETWORK_CAPTURE_FAILURE_EXIT_CODE,
} from '../lib/capture-network-guard.js';
import { createCaptureSocksProxy } from '../lib/capture-socks-proxy.js';

const _require = createRequire(import.meta.url);
const PKG_DIR = new URL('..', import.meta.url).pathname;
const SYSTEM_BROWSERS = [
  process.env.PINCUSHION_CHROMIUM,
  process.env.CHROME_PATH,
  process.env.PUPPETEER_EXECUTABLE_PATH,
  '/opt/pw-browsers/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const DEFAULT_DISCOVERY_MAX_PAGES = 24;
const CRITIQUE_DISCOVERY_MAX_PAGES = 64;
const MAX_EXACT_INVENTORY_PAGES = 64;
const MAX_EXACT_INVENTORY_STDIN_BYTES = 4 * 1024 * 1024;
const MAX_CRITIQUE_PAGES_WITH_PINS = 64;
const MAX_CRITIQUE_PINS_PER_PAGE = 500;
const CAPTURE_STARTED_AT = Date.now();
let browserLaunchCount = 0;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function backendCaptureFingerprint(semanticHash, visualFingerprint) {
  const vector = Array.isArray(visualFingerprint?.vector) ? visualFingerprint.vector : [];
  const bucketCount = Math.min(128, vector.length);
  const buckets = Array.from({ length: bucketCount }, () => []);
  const unstableBuckets = new Set();
  for (let index = 0; index < vector.length; index += 1) {
    const bucket = Math.min(bucketCount - 1, Math.floor((index * bucketCount) / Math.max(1, vector.length)));
    buckets[bucket].push(vector[index]);
  }
  for (const index of visualFingerprint?.unstableTiles || []) {
    if (!Number.isInteger(index) || index < 0 || index >= vector.length) continue;
    unstableBuckets.add(Math.min(bucketCount - 1, Math.floor((index * bucketCount) / Math.max(1, vector.length))));
  }
  return {
    version: 1,
    semantic_hash: semanticHash,
    visual_digest: visualFingerprint.digest,
    tile_digests: buckets.map((bucket) => sha256(JSON.stringify(bucket))),
    instability_mask: [...unstableBuckets].sort((a, b) => a - b).map((bucket) => `bucket:${bucket}`),
  };
}

function resolveExecutablePath() {
  for (const path of SYSTEM_BROWSERS) if (existsSync(path)) return path;
  return undefined;
}

function loadChromiumLib() {
  const tries = [
    'playwright', 'playwright-core',
    `${process.env.HOME || ''}/.claude/skills/gstack/node_modules/playwright`,
    `${process.env.HOME || ''}/.claude/skills/gstack/node_modules/playwright-core`,
  ];
  for (const target of tries) {
    try { return _require(target).chromium; } catch { /* try next */ }
  }
  if (noInstallRequested()) return null;
  try {
    execSync('npm install --no-save --no-audit --no-fund playwright-core', {
      cwd: PKG_DIR, stdio: 'ignore', timeout: 120000,
    });
    return _require('playwright-core').chromium;
  } catch {
    return null;
  }
}

function noInstallRequested() {
  return /^(?:1|true|yes)$/i.test(String(process.env.PINCUSHION_CAPTURE_NO_INSTALL || ''));
}

async function launchBrowser(chromium, socketBoundary) {
  const args = [
    '--enable-unsafe-swiftshader',
    '--disable-dev-shm-usage',
    // QUIC and non-proxied WebRTC UDP can bypass a TCP SOCKS boundary.
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    // Chromium otherwise has an implicit direct loopback bypass. The SOCKS
    // listener itself remains loopback; this removes direct target bypasses.
    '--proxy-bypass-list=<-loopback>',
  ];
  const proxy = { server: socketBoundary.server, bypass: '<-loopback>' };
  const executablePath = resolveExecutablePath();
  const sandboxedLaunchOptions = (path) => ({
    headless: true,
    ...(path ? { executablePath: path } : {}),
    args,
    proxy,
    // Playwright's own Chromium defaults vary by host. Explicitly reject an
    // unsandboxing default rather than trusting a particular Playwright build.
    ignoreDefaultArgs: ['--no-sandbox'],
  });
  const sandboxFailure = (error) => {
    const message = String(error?.message || error || '');
    if (!/no usable sandbox|setuid sandbox|sandbox[^\n]*(?:failed|failure|unavailable|not supported|requires?|cannot|could not)|running as root[^\n]*no-sandbox/i.test(message)) {
      return null;
    }
    const sandboxError = new Error('capture-snapshot: Chromium sandbox unavailable; refusing to launch an unsandboxed browser.');
    sandboxError.exitCode = 4;
    return sandboxError;
  };
  try {
    return await chromium.launch(sandboxedLaunchOptions(executablePath));
  } catch (firstError) {
    const firstSandboxFailure = sandboxFailure(firstError);
    if (firstSandboxFailure) throw firstSandboxFailure;
    if (noInstallRequested()) {
      const error = new Error('capture-snapshot: browser runtime unavailable (provisioning disabled).');
      error.exitCode = 4;
      throw error;
    }
    try {
      execSync('npm install --no-save --no-audit --no-fund playwright', { cwd: PKG_DIR, stdio: 'ignore', timeout: 180000 });
      execSync('npx --yes playwright install chromium', { cwd: PKG_DIR, stdio: 'ignore', timeout: 300000 });
      return await chromium.launch(sandboxedLaunchOptions());
    } catch (secondError) {
      const secondSandboxFailure = sandboxFailure(secondError);
      if (secondSandboxFailure) throw secondSandboxFailure;
      const error = new Error(
        'No headless browser available and one could not be provisioned. Set PINCUSHION_CHROMIUM/CHROME_PATH to a Chrome/Chromium binary, run `npx playwright install chromium`, or capture with your environment\'s own browser tooling (see page-snapshot-capture.md). Original: ' +
        (firstError?.message || firstError),
      );
      error.exitCode = 4;
      throw error;
    }
  }
}

function jpegSize(buffer) {
  try {
    if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
    let index = 2;
    while (index < buffer.length - 9) {
      if (buffer[index] !== 0xff) { index += 1; continue; }
      const marker = buffer[index + 1];
      const isSof = (marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf);
      if (isSof) return { h: (buffer[index + 5] << 8) | buffer[index + 6], w: (buffer[index + 7] << 8) | buffer[index + 8] };
      const length = (buffer[index + 2] << 8) | buffer[index + 3];
      if (length < 2) return null;
      index += 2 + length;
    }
  } catch { /* unreadable */ }
  return null;
}

function readJsonArgument(value, label) {
  if (!value) return null;
  try { return JSON.parse(value); } catch {
    try { return JSON.parse(readFileSync(value, 'utf8')); } catch (error) {
      throw new Error(`could not parse ${label}: ${error.message}`);
    }
  }
}

function critiqueArgumentError(message = 'critique capture input invalid') {
  return Object.assign(new Error(`capture-snapshot: ${message}`), { exitCode: 2 });
}

function normalizeCritiquePins(value, rootUrl) {
  if (value === null || value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw critiqueArgumentError('--pins must be an object or JSON file');
  let root;
  try { root = new URL(String(rootUrl || '').trim()); } catch { throw critiqueArgumentError('critique URL must be an http(s) URL'); }
  const pages = Object.entries(value);
  if (pages.length > MAX_CRITIQUE_PAGES_WITH_PINS) throw critiqueArgumentError('--pins has too many page keys');
  const normalized = {};
  for (const [pageUrl, pins] of pages) {
    let parsedPage;
    try { parsedPage = new URL(pageUrl); } catch { throw critiqueArgumentError('--pins page URL is invalid'); }
    if (!['http:', 'https:'].includes(parsedPage.protocol) || parsedPage.username || parsedPage.password || parsedPage.origin !== root.origin) {
      throw critiqueArgumentError('--pins page URL is outside the critique origin');
    }
    if (!pins || typeof pins !== 'object' || Array.isArray(pins)) throw critiqueArgumentError('--pins page entry must be an annotation object');
    const annotations = Object.entries(pins);
    if (annotations.length > MAX_CRITIQUE_PINS_PER_PAGE) throw critiqueArgumentError('--pins page entry is too large');
    normalized[pageUrl] = {};
    for (const [annotationId, pin] of annotations) {
      if (!annotationId || annotationId.length > 200 || !pin || typeof pin !== 'object' || Array.isArray(pin)) {
        throw critiqueArgumentError('--pins annotation entry is invalid');
      }
      const selector = typeof pin.selector === 'string' ? pin.selector.trim() : '';
      if (!selector || selector.length > 1000) throw critiqueArgumentError('--pins selector is invalid');
      const output = { selector };
      for (const coordinate of ['relX', 'relY']) {
        if (pin[coordinate] === undefined) continue;
        if (!Number.isFinite(pin[coordinate]) || pin[coordinate] < 0 || pin[coordinate] > 1) {
          throw critiqueArgumentError(`--pins ${coordinate} must be between 0 and 1`);
        }
        output[coordinate] = pin[coordinate];
      }
      normalized[pageUrl][annotationId] = output;
    }
  }
  return normalized;
}

function exactInventoryError() {
  // Never include stdin bytes, URLs, hashes, or previous receipts in an error.
  return Object.assign(new Error('exact inventory input invalid'), { exitCode: 2 });
}

function exactInventoryObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function readBoundedExactInventoryStdin() {
  const chunks = [];
  let total = 0;
  try {
    // Read in fixed-size chunks and stop as soon as the bounded contract is
    // exceeded; never materialize an unbounded pipe before validating it.
    while (total <= MAX_EXACT_INVENTORY_STDIN_BYTES) {
      const length = Math.min(64 * 1024, MAX_EXACT_INVENTORY_STDIN_BYTES + 1 - total);
      const chunk = Buffer.allocUnsafe(length);
      const count = readSync(0, chunk, 0, length, null);
      if (!count) break;
      chunks.push(chunk.subarray(0, count));
      total += count;
      if (total > MAX_EXACT_INVENTORY_STDIN_BYTES) throw exactInventoryError();
    }
  } catch (error) {
    if (error?.exitCode === 2) throw error;
    throw exactInventoryError();
  }
  return Buffer.concat(chunks, total).toString('utf8');
}

function parseExactInventoryStdin(rootUrl) {
  // Exact inventory origin validation is strict and never echoes rejected input.
  let raw;
  raw = readBoundedExactInventoryStdin();
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw exactInventoryError();
  }
  const input = exactInventoryObject(parsed);
  if (!input || Object.keys(input).length !== 2
      || !Object.prototype.hasOwnProperty.call(input, 'pageUrls')
      || !Object.prototype.hasOwnProperty.call(input, 'previousReceipts')) {
    throw exactInventoryError();
  }
  if (!Array.isArray(input.pageUrls) || input.pageUrls.length < 1
      || input.pageUrls.length > MAX_EXACT_INVENTORY_PAGES) {
    throw exactInventoryError();
  }
  let anchor;
  try { anchor = new URL(String(rootUrl || '').trim()); } catch { throw exactInventoryError(); }
  if (!['http:', 'https:'].includes(anchor.protocol) || anchor.username || anchor.password) {
    throw exactInventoryError();
  }
  const pageUrls = [];
  const seen = new Set();
  for (const value of input.pageUrls) {
    if (typeof value !== 'string' || !value.trim()) throw exactInventoryError();
    let url;
    try { url = new URL(value); } catch { throw exactInventoryError(); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== anchor.origin) {
      throw exactInventoryError();
    }
    // Preserve the caller's exact string and order. Navigation canonicalization
    // is handled separately by the exact-scope guard; the scope contract keys
    // previous receipts by these exact strings.
    if (seen.has(value)) throw exactInventoryError();
    seen.add(value);
    pageUrls.push(value);
  }
  const previousReceipts = exactInventoryObject(input.previousReceipts);
  if (!previousReceipts) throw exactInventoryError();
  const previousKeys = Object.keys(previousReceipts);
  if (previousKeys.length !== pageUrls.length || previousKeys.some((key) => !seen.has(key))) {
    throw exactInventoryError();
  }
  return { pageUrls, previousReceipts };
}

function flagValue(flags, name) {
  return flags.find((flag) => flag.startsWith(`${name}=`))?.slice(name.length + 1) || null;
}

function parseViewport(value) {
  const match = /^(\d{2,5})x(\d{2,5})$/i.exec(value || '');
  if (!match) return null;
  return { width: Number(match[1]), height: Number(match[2]) };
}

function configuredContextOptions(authentication) {
  const options = {
    viewport: DEFAULT_VIEWPORT,
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36',
  };
  if (authentication?.mode === 'authenticated' && authentication.storageState) {
    // `storageState` is the already securely opened and parsed object. Never
    // give Playwright the state pathname, which would re-open it after the
    // guarded read and reintroduce a state-file TOCTOU boundary.
    options.storageState = authentication.storageState;
  }
  return options;
}

function navigationError(code) {
  const error = new Error('capture navigation rejected');
  error.captureNetworkCode = code;
  error.exitCode = NETWORK_CAPTURE_FAILURE_EXIT_CODE;
  return error;
}

function navigationFailureReason(error, navigationGuard) {
  const blocked = navigationGuard?.consumeBlockedCode?.();
  return error?.captureNetworkCode || blocked || 'navigation_failed';
}

function assertNoLatchedNetworkBlock(navigationGuard) {
  const blocked = navigationGuard?.getBlockedCode?.();
  if (blocked) throw navigationError(blocked);
}

// A page and browser are closed before its capture is returned. Quiescing the
// listener first captures accepts that were already queued by browser teardown,
// then a bounded drain proves no client, resolution, or connect operation can
// surface a late block after a frame receipt or image is written.
async function assertSocketBoundaryClean(socketBoundary, navigationGuard) {
  const routesSettled = await navigationGuard.waitForRouteValidationIdle();
  await socketBoundary.quiesce();
  const settled = await socketBoundary.waitForQuiescence();
  const blocked = navigationGuard?.getBlockedCode?.() || socketBoundary.getBlockedCode();
  if (!routesSettled || !settled || blocked) throw navigationError(blocked || 'network_socks_drain_timeout');
}

async function gotoPage(page, pageUrl, navigationGuard) {
  let target = pageUrl;
  for (let hop = 0; hop <= 8; hop += 1) {
    const initial = await navigationGuard.validate(target, { navigation: true });
    if (!initial.ok) throw navigationError(initial.code);
    let response;
    let redirect = null;
    navigationGuard.setRedirectRetryAllowed?.(true);
    try {
      try {
        response = await page.goto(target, { waitUntil: 'networkidle', timeout: 45000 });
      } catch {
        redirect = navigationGuard.consumeRedirectTarget?.();
        if (!redirect) {
          const blocked = navigationGuard.consumeBlockedCode();
          if (blocked) throw navigationError(blocked);
          try {
            response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45000 });
          } catch (error) {
            redirect = navigationGuard.consumeRedirectTarget?.();
            if (!redirect) throw error;
          }
        }
      }
    } finally {
      navigationGuard.setRedirectRetryAllowed?.(false);
    }
    redirect ||= navigationGuard.consumeRedirectTarget?.();
    if (redirect) { target = redirect; continue; }
    assertNoLatchedNetworkBlock(navigationGuard);
    return response;
  }
  throw navigationError('network_redirect_bound_reached');
}

async function authenticationChallenge(page, { requestedUrl, status, authentication }) {
  const finalUrl = normalizeInventoryUrl(page.url());
  let signals = {};
  try {
    signals = await page.evaluate(collectAuthenticationChallengeSignals);
  } catch {
    signals = { challengeUninspectable: authentication?.expected === true };
  }
  return classifyAuthenticationChallenge({
    status,
    requestedUrl,
    finalUrl,
    authExpected: authentication?.expected === true,
    signals,
  });
}

function authReceiptFields(authentication) {
  return { auth: captureAuthReceipt(authentication) };
}

function isRequiredAuthenticationFailure(reason, authentication) {
  if (authentication?.mode !== 'authenticated') return false;
  const bounded = String(reason || '');
  return bounded.startsWith('auth_') || bounded === 'http_401' || bounded === 'http_403';
}

function isAuthenticationCoverageGap(reason) {
  const bounded = String(reason || '');
  return bounded.startsWith('auth_') || bounded === 'http_401' || bounded === 'http_403';
}

function isNetworkNavigationFailure(reason) {
  return String(reason || '').startsWith('network_');
}

async function authenticationProof(page, { finalUrl, authentication }) {
  if (authentication?.mode !== 'authenticated') return null;
  let origin;
  try { origin = new URL(finalUrl).origin; } catch { return { reason: 'auth_proof_origin_mismatch' }; }
  if (!authentication.targetOrigin || origin !== authentication.targetOrigin) return { reason: 'auth_proof_origin_mismatch' };
  if (!authentication.proofSelector) return { reason: 'auth_proof_missing' };
  try {
    const visible = await page.evaluate((selector) => {
      let element;
      try { element = document.querySelector(selector); } catch { return false; }
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      if (!rect.width || !rect.height) return false;
      for (let current = element; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (current.hidden || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
            style.visibility === 'hidden' || style.contentVisibility === 'hidden' || Number(style.opacity || '1') === 0 ||
            (style.clipPath && style.clipPath !== 'none')) return false;
      }
      return true;
    }, authentication.proofSelector);
    return visible ? null : { reason: 'auth_proof_not_visible' };
  } catch {
    return { reason: 'auth_proof_check_failed' };
  }
}

async function finalNavigationCheck(finalUrl, navigationGuard) {
  const check = await navigationGuard.validate(finalUrl, { navigation: true });
  return check.ok ? null : { reason: check.code };
}

async function probePage(context, pageUrl, rootOrigin, authentication, navigationGuard) {
  const page = await context.newPage();
  try {
    let response;
    try {
      response = await gotoPage(page, pageUrl, navigationGuard);
    } catch (error) {
      const reason = navigationFailureReason(error, navigationGuard);
      return {
        pageUrl,
        finalUrl: null,
        outcome: 'inaccessible',
        reason,
        ...(reason === 'navigation_failed' ? { error: String(error?.message || error).slice(0, 300) } : {}),
        ...authReceiptFields(authentication),
      };
    }
    const status = response?.status?.() || null;
    const finalUrl = normalizeInventoryUrl(page.url());
    if (!finalUrl) return { pageUrl, finalUrl: null, outcome: 'unknown', reason: 'invalid_final_url', status, ...authReceiptFields(authentication) };
    const network = await finalNavigationCheck(finalUrl, navigationGuard);
    if (network) return { pageUrl, finalUrl, outcome: 'inaccessible', reason: network.reason, status, ...authReceiptFields(authentication) };
    const challenge = await authenticationChallenge(page, { requestedUrl: pageUrl, status, authentication });
    if (challenge) return { pageUrl, finalUrl, outcome: 'inaccessible', reason: challenge.reason, status, ...authReceiptFields(authentication) };
    const proof = await authenticationProof(page, { finalUrl, authentication });
    if (proof) return { pageUrl, finalUrl, outcome: 'inaccessible', reason: proof.reason, status, ...authReceiptFields(authentication) };
    if (status === 404 || status === 410) return { pageUrl, finalUrl, outcome: 'removed', reason: `http_${status}`, status, ...authReceiptFields(authentication) };
    if (status && status >= 400) return { pageUrl, finalUrl, outcome: 'unknown', reason: `http_${status}`, status, ...authReceiptFields(authentication) };
    return { pageUrl, finalUrl, outcome: 'accessible', reason: 'reachable', status, ...authReceiptFields(authentication) };
  } finally {
    await page.close().catch(() => {});
  }
}

async function settlePage(page, { preserveAppearance = false } = {}) {
  // Deployment fingerprints retain the established stabilization behavior.
  // Critique evidence must preserve authored opacity, transforms, widgets, and
  // timestamps so visibility, selectors, and screenshots describe the page.
  if (!preserveAppearance) {
    await page.addStyleTag({
      content: [
        '*{animation:none!important;transition:none!important;opacity:1!important;transform:none!important}',
        '#pincushion-root,[data-pincushion],[data-pincushion-widget],[class*="pincushion-" i],[id*="pincushion" i]{display:none!important;}',
        // Preserve layout while suppressing the most obvious display-only clocks
        // and timestamps. Semantic collection independently normalizes their
        // text, so a stable timestamp does not create a false visual deploy diff.
        'time,[data-timestamp],[data-time],[data-relative-time],[data-updated-at],[class*="timestamp" i],[class*="relative-time" i],[class*="last-updated" i],[id*="timestamp" i],[id*="relative-time" i],[id*="last-updated" i]{color:transparent!important;text-shadow:none!important;caret-color:transparent!important;}',
      ].join('\n'),
    }).catch(() => {});
  }
  await page.evaluate(async () => {
    const step = Math.max(1, Math.floor(window.innerHeight * 0.8));
    for (let y = 0; y < document.documentElement.scrollHeight; y += step) {
      window.scrollTo(0, y);
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    window.scrollTo(0, 0);
    await new Promise((resolve) => setTimeout(resolve, 450));
  });
}

async function renderedLinks(page, { actionEvidence = false } = {}) {
  return page.evaluate((includeActionEvidence) => {
    const isPincushion = (element) => /pincushion|__fp_/i.test(`${element.id || ''} ${element.className || ''} ${element.getAttribute('data-pincushion') || ''}`);
    const links = [];
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (isPincushion(anchor)) continue;
      const rect = anchor.getBoundingClientRect();
      if (!rect.width || !rect.height) continue;
      let visible = true;
      for (let current = anchor; current; current = current.parentElement) {
        const style = getComputedStyle(current);
        if (current.hidden || current.getAttribute('aria-hidden') === 'true' || style.display === 'none' ||
            style.visibility === 'hidden' || style.contentVisibility === 'hidden' || Number(style.opacity || '1') === 0 ||
            (style.clipPath && style.clipPath !== 'none')) { visible = false; break; }
        if (current !== anchor && /(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)) {
          const parentRect = current.getBoundingClientRect();
          if (!parentRect.width || !parentRect.height || rect.left < parentRect.left || rect.right > parentRect.right ||
              rect.top < parentRect.top || rect.bottom > parentRect.bottom) { visible = false; break; }
        }
      }
      if (!visible) continue;
      const href = anchor.href;
      if (href) links.push(includeActionEvidence
        ? { url: href, label: String(anchor.getAttribute('aria-label') || anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120), rel: anchor.rel || '' }
        : href);
    }
    return links;
  }, actionEvidence);
}

// GET navigation can mutate sessions or accounts on real apps. Only Crit uses
// this conservative action filter; reconciliation retains its existing scope.
function critiqueActionReason(url, { label = '', rel = '' } = {}) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const segments = parsed.pathname.split('/').map((part) => {
    try { return decodeURIComponent(part).toLowerCase(); } catch { return part.toLowerCase(); }
  });
  const action = /^(?:log[-_]?out|sign[-_]?out|signoff|disconnect|revoke|delete|destroy|remove|unsubscribe|checkout|purchase|buy|pay|submit|send|save|publish|approve|reject|confirm|reset[-_]?password)$/i;
  if (segments.some((part) => action.test(part))) return 'action_route_path';
  if ([...parsed.searchParams].some(([key, value]) => action.test(key) || (/(?:action|command|do|op|operation)/i.test(key) && action.test(value)))) return 'action_route_query';
  if (/\b(?:sign\s*out|log\s*out|disconnect|revoke|delete|destroy|remove|unsubscribe|checkout|purchase|pay|submit|send|save|publish|approve|reject|confirm)\b/i.test(label)) return 'action_link_label';
  if (/\b(?:logout|nofollow|external)\b/i.test(rel)) return 'action_link_rel';
  return null;
}

async function renderedLinkEvidence(page, pageOrigin) {
  const values = await renderedLinks(page);
  const links = [];
  const seen = new Set();
  for (const value of values) {
    if (links.length >= 256) break;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.origin !== pageOrigin) continue;
      url.hash = '';
      const normalized = normalizeInventoryUrl(url.toString());
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      links.push(normalized);
    } catch { /* malformed or unsafe link evidence */ }
  }
  return links;
}

async function fetchSameOriginText(page, url) {
  return page.evaluate(async (target) => {
    try {
      const response = await fetch(target, { credentials: 'include', redirect: 'follow', cache: 'no-store' });
      const text = (await response.text()).slice(0, 800000);
      return { ok: response.ok, status: response.status, finalUrl: response.url, text };
    } catch (error) {
      return { ok: false, status: 0, finalUrl: null, error: String(error?.message || error) };
    }
  }, url);
}

function sitemapLocations(xml, sourceUrl, origin) {
  const locations = [];
  const decode = (value) => value.replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').trim();
  for (const match of String(xml || '').matchAll(/<loc\b[^>]*>([\s\S]*?)<\/loc>/gi)) {
    try {
      const url = normalizeInventoryUrl(new URL(decode(match[1]), sourceUrl).toString());
      if (url && new URL(url).origin === origin) locations.push(url);
    } catch { /* malformed or out of scope */ }
  }
  return [...new Set(locations)];
}

async function sitemapUrls(page, rootUrl, origin) {
  const robotsUrl = new URL('/robots.txt', rootUrl).toString();
  const robots = await fetchSameOriginText(page, robotsUrl);
  const candidates = new Set();
  for (const line of String(robots.text || '').split(/\r?\n/)) {
    const match = /^\s*sitemap\s*:\s*(\S+)/i.exec(line);
    if (!match) continue;
    try {
      const url = normalizeInventoryUrl(new URL(match[1], robots.finalUrl || robotsUrl).toString());
      if (url && new URL(url).origin === origin) candidates.add(url);
    } catch { /* ignore malformed directives */ }
  }
  if (!candidates.size) candidates.add(new URL('/sitemap.xml', rootUrl).toString());

  const pageUrls = new Set();
  const visited = new Set();
  const pending = [...candidates];
  while (pending.length && visited.size < 16) {
    const sitemapUrl = pending.shift();
    if (visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);
    const response = await fetchSameOriginText(page, sitemapUrl);
    if (!response.ok || !response.text) continue;
    // A sitemap index's <loc> entries are nested sitemaps, while a urlset's
    // entries are site routes. Detect the root tag once per fetched document;
    // normal urlsets do not contain a <sitemap...> tag at all.
    const rootTag = /<\s*(sitemapindex|urlset)\b/i.exec(response.text)?.[1]?.toLowerCase();
    for (const location of sitemapLocations(response.text, response.finalUrl || sitemapUrl, origin)) {
      if (rootTag === 'sitemapindex') pending.push(location);
      else if (rootTag === 'urlset') pageUrls.add(location);
    }
  }
  return [...pageUrls];
}

function inventoryUrls(value, rootOrigin) {
  const source = value?.projectPages || value?.project_pages || value?.pages || value || [];
  const items = Array.isArray(source) ? source : Object.values(source);
  const urls = [];
  for (const item of items) {
    const raw = typeof item === 'string' ? item : item?.pageUrl || item?.page_url || item?.url;
    const url = normalizeInventoryUrl(raw);
    try {
      if (url && new URL(url).origin === rootOrigin) urls.push(url);
    } catch { /* invalid URL */ }
  }
  return [...new Set(urls)];
}

async function discoverSiteStructure(context, rootUrl, inventory, maxPages, authentication, navigationGuard, {
  includeOriginRoot = false,
  omitCredentialUrls = false,
  preserveAppearance = false,
  inspectSafeStates = false,
} = {}) {
  const root = normalizeInventoryUrl(rootUrl);
  if (!root) throw new Error('pageUrl must be a valid http(s) URL');
  const origin = new URL(root).origin;
  const candidates = new Map();
  const skippedActions = new Map();
  let skippedActionsTruncated = false;
  const add = (url, source, evidence = {}) => {
    const normalized = normalizeInventoryUrl(url);
    try {
      const parsed = new URL(normalized);
      if (!normalized || parsed.origin !== origin || (omitCredentialUrls && (parsed.username || parsed.password))) return;
    } catch { return; }
    const actionReason = inspectSafeStates ? critiqueActionReason(normalized, evidence) : null;
    if (actionReason) {
      if (!skippedActions.has(normalized)) {
        if (skippedActions.size < 64) skippedActions.set(normalized, { pageUrl: normalized, source, reason: actionReason });
        else skippedActionsTruncated = true;
      }
      return;
    }
    const entry = candidates.get(normalized) || { pageUrl: normalized, sources: new Set() };
    entry.sources.add(source);
    candidates.set(normalized, entry);
  };
  add(root, 'root');
  if (includeOriginRoot) add(new URL('/', origin).toString(), 'origin-root');
  for (const url of inventoryUrls(inventory, origin)) add(url, 'inventory');

  const results = new Map();
  const queue = [...candidates.keys()];
  let cursor = 0;
  let discoveryPage = null;
  let truncated = false;
  while (cursor < queue.length) {
    if (results.size >= maxPages) { truncated = true; break; }
    const pageUrl = queue[cursor++];
    const probe = await probePage(context, pageUrl, origin, authentication, navigationGuard);
    const existing = candidates.get(pageUrl);
    results.set(pageUrl, { ...probe, sources: [...(existing?.sources || [])].sort() });
    if (probe.outcome !== 'accessible') continue;
    if (!discoveryPage) discoveryPage = await context.newPage();
    try {
      const viewportPasses = inspectSafeStates
        ? Object.entries(CANONICAL_DEPLOYMENT_VIEWPORTS)
        : [[null, null]];
      let pageFailure = null;
      let sitemapCollected = false;
      for (const [deviceClass, viewport] of viewportPasses) {
        if (viewport) await discoveryPage.setViewportSize(viewport);
        const response = await gotoPage(discoveryPage, pageUrl, navigationGuard);
        const finalUrl = normalizeInventoryUrl(discoveryPage.url());
        const network = finalUrl ? await finalNavigationCheck(finalUrl, navigationGuard) : { reason: 'network_target_url_invalid' };
        const challenge = await authenticationChallenge(discoveryPage, {
          requestedUrl: pageUrl,
          status: response?.status?.() || null,
          authentication,
        });
        const proof = finalUrl ? await authenticationProof(discoveryPage, { finalUrl, authentication }) : { reason: 'auth_proof_origin_mismatch' };
        if (network || challenge || proof) {
          pageFailure = network?.reason || challenge?.reason || proof?.reason;
          break;
        }
        await settlePage(discoveryPage, { preserveAppearance });
        const baseLinks = await renderedLinks(discoveryPage, { actionEvidence: inspectSafeStates });
        for (const link of baseLinks) {
          const url = typeof link === 'string' ? link : link.url;
          const before = candidates.size;
          add(url, inspectSafeStates ? `rendered-link-${deviceClass}` : 'rendered-link', typeof link === 'string' ? {} : link);
          if (candidates.size > before) queue.push(normalizeInventoryUrl(url));
        }
        if (inspectSafeStates) {
          await discoveryPage.evaluate(inspectNonDestructivePageState);
          assertNoLatchedNetworkBlock(navigationGuard);
          const baseSet = new Set(baseLinks.map((link) => normalizeInventoryUrl(typeof link === 'string' ? link : link.url)).filter(Boolean));
          for (const link of await renderedLinks(discoveryPage, { actionEvidence: true })) {
            const url = link.url;
            const normalized = normalizeInventoryUrl(url);
            const before = candidates.size;
            add(url, baseSet.has(normalized) ? `rendered-link-${deviceClass}` : `safe-state-link-${deviceClass}`, link);
            if (candidates.size > before) queue.push(normalized);
          }
        }
        if (!sitemapCollected && pageUrl === root) {
          for (const url of await sitemapUrls(discoveryPage, root, origin)) {
            const before = candidates.size;
            add(url, 'sitemap');
            if (candidates.size > before) queue.push(normalizeInventoryUrl(url));
          }
          sitemapCollected = true;
        }
      }
      if (pageFailure) {
        const prior = results.get(pageUrl);
        results.set(pageUrl, { ...prior, outcome: 'inaccessible', reason: pageFailure });
      }
    } catch (error) {
      const prior = results.get(pageUrl);
      const reason = navigationFailureReason(error, navigationGuard);
      results.set(pageUrl, {
        ...prior,
        outcome: reason.startsWith('network_') ? 'inaccessible' : 'unknown',
        reason: reason === 'navigation_failed' ? 'discovery_failed' : reason,
        ...(reason === 'navigation_failed' ? { error: String(error?.message || error).slice(0, 300) } : {}),
      });
    }
  }
  await discoveryPage?.close().catch(() => {});
  return {
    rootUrl: root,
    origin,
    maxPages,
    truncated,
    candidates: candidates.size,
    ...(inspectSafeStates ? { skippedActions: [...skippedActions.values()], skippedActionsTruncated } : {}),
    pages: [...results.values()],
  };
}

async function discoverCritiquePageOnly(context, pageUrl, authentication, navigationGuard) {
  const root = normalizeInventoryUrl(pageUrl);
  if (!root) throw critiqueArgumentError('critique URL must be an http(s) URL');
  const probe = await probePage(context, root, new URL(root).origin, authentication, navigationGuard);
  return {
    rootUrl: root,
    origin: new URL(root).origin,
    maxPages: 1,
    truncated: false,
    candidates: 1,
    pages: [{ ...probe, sources: ['root'] }],
  };
}

function buildExactInventoryDiscovery(rootUrl, pageUrls, authentication) {
  // In exact mode, root is an origin anchor only; it is not added unless supplied.
  const root = normalizeInventoryUrl(rootUrl);
  if (!root) throw exactInventoryError();
  const origin = new URL(root).origin;
  return {
    rootUrl: root,
    origin,
    maxPages: pageUrls.length,
    truncated: false,
    candidates: pageUrls.length,
    pages: pageUrls.map((pageUrl) => ({
      pageUrl,
      finalUrl: null,
      outcome: 'accessible',
      reason: 'exact_inventory',
      status: null,
      auth: captureAuthReceipt(authentication),
      sources: ['exact-inventory'],
    })),
  };
}

function createExactScopeNavigationGuard({ navigationOrigin, allowedPageUrls, getBlockedCode }) {
  const allowed = new Set(allowedPageUrls);
  const base = createCaptureNavigationGuard({ navigationOrigin, getBlockedCode });
  let blockedCode = null;
  const routeValidations = new Set();
  const routeValidationWaiters = new Set();
  const latch = (code) => {
    if (!blockedCode && code) blockedCode = code;
    return blockedCode;
  };
  const normalizedAllowed = new Set(allowedPageUrls.map((value) => normalizeInventoryUrl(value) || value));
  const isAllowedNavigation = (value) => {
    const normalized = normalizeInventoryUrl(value);
    return allowed.has(value) || (normalized && normalizedAllowed.has(normalized));
  };
  const validate = async (url, { navigation = false } = {}) => {
    if (navigation && !isAllowedNavigation(url)) return { ok: false, code: latch('network_exact_scope_navigation') };
    const result = await base.validate(url, { navigation });
    if (!result.ok) latch(result.code);
    return result;
  };
  const track = (work) => {
    const task = Promise.resolve().then(work);
    routeValidations.add(task);
    return task.finally(() => {
      routeValidations.delete(task);
      if (!routeValidations.size) {
        for (const resolve of routeValidationWaiters) resolve(true);
        routeValidationWaiters.clear();
      }
    });
  };
  const waitForRouteValidationIdle = async ({ timeoutMs = 3000 } = {}) => {
    if (!routeValidations.size) return true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        routeValidationWaiters.delete(finish);
        resolve(value);
      };
      const timeout = setTimeout(() => {
        latch('network_route_validation_drain_timeout');
        finish(false);
      }, timeoutMs);
      routeValidationWaiters.add(finish);
    });
  };
  const routeNavigationRequest = async (route) => {
    const request = route.request();
    const requestUrl = request?.url?.();
    let protocol = null;
    try { protocol = new URL(requestUrl).protocol; } catch { /* base validation owns malformed URLs */ }
    const isHttp = protocol === 'http:' || protocol === 'https:';
    const isNavigation = typeof request?.isNavigationRequest === 'function' && request.isNavigationRequest();
    if (!isHttp && !isNavigation) {
      await route.continue();
      return;
    }
    const result = await track(() => validate(requestUrl, { navigation: isNavigation }));
    if (!result.ok) {
      try { await route.abort('blockedbyclient'); } catch { /* boundary remains latched */ }
      return;
    }
    await route.continue();
  };
  return {
    validate,
    async install(context) {
      await context.route('**/*', routeNavigationRequest);
    },
    async assertInitial(targetUrl) {
      return validate(targetUrl, { navigation: true });
    },
    async assertOriginAnchor(targetUrl) {
      const result = await base.validate(targetUrl, { navigation: true });
      if (!result.ok) latch(result.code);
      return result;
    },
    consumeBlockedCode() { return blockedCode || base.consumeBlockedCode(); },
    getBlockedCode() { return blockedCode || base.getBlockedCode(); },
    waitForRouteValidationIdle,
  };
}

function previousReceiptsForPage(allReceipts, pageUrl) {
  const root = allReceipts?.latestCaptureReceipts || allReceipts?.latest_capture_receipts || allReceipts || {};
  const normalized = normalizeInventoryUrl(pageUrl);
  const direct = root[pageUrl] || root[normalized] || null;
  if (direct) return direct;
  const item = Array.isArray(root) ? root.find((candidate) => normalizeInventoryUrl(candidate?.pageUrl || candidate?.page_url) === normalized) : null;
  return item?.captureReceipts || item?.capture_receipts || null;
}

function deviceClassForViewport(viewport, supplied) {
  if (supplied && ['desktop', 'tablet', 'mobile'].includes(supplied)) return supplied;
  return viewport.width < 768 ? 'mobile' : viewport.width < 1200 ? 'tablet' : 'desktop';
}

async function captureOne(context, {
  pageUrl,
  pins,
  viewport,
  deviceClass,
  rootOrigin = null,
  authentication,
  navigationGuard,
  forceFreshRender = false,
  critiqueEvidence = false,
}) {
  const page = await context.newPage();
  try {
    await page.setViewportSize(viewport);
    let response;
    try {
      response = await gotoPage(page, pageUrl, navigationGuard);
    } catch (error) {
      const reason = navigationFailureReason(error, navigationGuard);
      return { probe: {
        pageUrl,
        outcome: 'inaccessible',
        reason,
        ...(reason === 'navigation_failed' ? { error: String(error?.message || error).slice(0, 300) } : {}),
        ...authReceiptFields(authentication),
      } };
    }
    const finalUrl = normalizeInventoryUrl(page.url());
    const status = response?.status?.() || null;
    if (!finalUrl) return { probe: { pageUrl, finalUrl: null, outcome: 'unknown', reason: 'invalid_final_url', status, ...authReceiptFields(authentication) } };
    const network = await finalNavigationCheck(finalUrl, navigationGuard);
    if (network) return { probe: { pageUrl, finalUrl, outcome: 'inaccessible', reason: network.reason, status, ...authReceiptFields(authentication) } };
    const challenge = await authenticationChallenge(page, { requestedUrl: pageUrl, status, authentication });
    if (challenge) return { probe: { pageUrl, finalUrl, outcome: 'inaccessible', reason: challenge.reason, status, ...authReceiptFields(authentication) } };
    const proof = await authenticationProof(page, { finalUrl, authentication });
    if (proof) return { probe: { pageUrl, finalUrl, outcome: 'inaccessible', reason: proof.reason, status, ...authReceiptFields(authentication) } };
    if (status === 404 || status === 410) return { probe: { pageUrl, finalUrl, outcome: 'removed', reason: `http_${status}`, status, ...authReceiptFields(authentication) } };
    if (status && status >= 400) return { probe: { pageUrl, finalUrl, outcome: 'unknown', reason: `http_${status}`, status, ...authReceiptFields(authentication) } };

    await settlePage(page, { preserveAppearance: critiqueEvidence });
    assertNoLatchedNetworkBlock(navigationGuard);
    const stateInspection = critiqueEvidence
      ? await page.evaluate(inspectNonDestructivePageState)
      : { evidence: [], coverage: null };
    assertNoLatchedNetworkBlock(navigationGuard);
    const result = await page.evaluate(critiqueEvidence ? resolveExactSnapshotTargets : resolveSnapshotTargets, pins || {});
    const semantic = await page.evaluate(collectSemanticFingerprint);
    const title = critiqueEvidence ? String(await page.title()).replace(/\s+/g, ' ').trim().slice(0, 200) : null;
    const observedLinks = critiqueEvidence ? await renderedLinkEvidence(page, rootOrigin || new URL(finalUrl).origin) : [];
    const visibleElements = critiqueEvidence ? await page.evaluate(collectVisibleSemanticElements) : [];
    // A full-page screenshot expands to document.scrollWidth when a page has
    // horizontal overflow. Crit provenance instead requires the actual device
    // viewport width, while still retaining the full vertical page.
    const screenshotOptions = critiqueEvidence
      ? { fullPage: true, clip: { x: 0, y: 0, width: result.width, height: result.height }, type: 'jpeg', quality: 80 }
      : { fullPage: true, type: 'jpeg', quality: 80 };
    const firstImage = await page.screenshot(screenshotOptions);
    assertNoLatchedNetworkBlock(navigationGuard);
    await page.waitForTimeout(650);
    const secondImage = await page.screenshot(screenshotOptions);
    assertNoLatchedNetworkBlock(navigationGuard);
    const visualFingerprint = await page.evaluate(deriveVisualFingerprint, {
      firstDataUrl: `data:image/jpeg;base64,${firstImage.toString('base64')}`,
      secondDataUrl: `data:image/jpeg;base64,${secondImage.toString('base64')}`,
    });
    visualFingerprint.digest = sha256(JSON.stringify({
      algorithm: visualFingerprint.algorithm,
      columns: visualFingerprint.columns,
      rows: visualFingerprint.rows,
      vector: visualFingerprint.vector,
      unstableTiles: visualFingerprint.unstableTiles,
    }));
    delete visualFingerprint.source;

    const image = jpegSize(firstImage);
    if (image && image.w > 0 && image.h > 0) {
      const scaleX = image.w / result.width;
      const scaleY = image.h / result.height;
      if (Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01) {
        const scaled = scaleSnapshotTargets(result, scaleX, scaleY);
        result.positions = scaled.positions;
        result.hotspots = scaled.hotspots;
        if (scaleX > 1.3 || scaleY > 1.3) console.error(`[capture] WARNING: image ${image.w}x${image.h} >> document ${result.width}x${result.height} — viewport balloon? coords scaled to the real image.`);
      }
      result.width = image.w;
      result.height = image.h;
    }
    result.captured = result.positions.length;
    result.resolved = `${result.captured}/${result.requested}`;
    result.unresolved = Math.max(0, result.requested - result.captured);
    result.captureContext = {
      deviceClass,
      cssWidth: viewport.width,
      cssHeight: viewport.height,
      dpr: 1,
      orientation: viewport.width > viewport.height ? 'landscape' : 'portrait',
      platform: 'web',
      browser: 'Chromium',
      ...(forceFreshRender ? { freshRender: true } : {}),
    };
    result.auth = captureAuthReceipt(authentication);
    result.semanticHash = sha256(JSON.stringify(semantic));
    result.semanticFingerprint = { algorithm: semantic.version, entryCount: semantic.entryCount };
    result.visualFingerprint = visualFingerprint;
    result.captureFingerprint = backendCaptureFingerprint(result.semanticHash, visualFingerprint);
    result.imageContentHash = sha256(firstImage);
    result.pageUrl = pageUrl;
    result.finalUrl = finalUrl;
    result.probe = { pageUrl, finalUrl, outcome: 'accessible', reason: 'reachable', status, ...authReceiptFields(authentication) };
    if (critiqueEvidence) {
      result.title = title;
      result.observedLinks = observedLinks;
      result.visibleElements = visibleElements;
      result.stateEvidence = stateInspection.evidence || [];
      result.stateCoverage = stateInspection.coverage || null;
    }
    assertNoLatchedNetworkBlock(navigationGuard);
    return { receipt: result, image: firstImage };
  } finally {
    await page.close().catch(() => {});
  }
}

function safeOutputStem(pageUrl) {
  try {
    const url = new URL(pageUrl);
    const readable = `${url.hostname}${url.pathname}`.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 64) || 'page';
    return `${readable}-${sha256(pageUrl).slice(0, 10)}`;
  } catch {
    return `page-${sha256(pageUrl).slice(0, 10)}`;
  }
}

function parseArguments() {
  const raw = process.argv.slice(2);
  const flags = raw.filter((arg) => arg.startsWith('--'));
  const positional = raw.filter((arg) => !arg.startsWith('--'));
  const reconcile = flags.includes('--reconcile');
  const critique = flags.includes('--critique');
  const exactInventoryStdin = flags.includes('--exact-inventory-stdin');
  const probe = reconcile || flags.includes('--probe');
  const discover = reconcile || flags.includes('--discover');
  const requireAll = flags.includes('--require-all');
  const requireAuthenticated = flags.includes('--require-auth') || /^(?:1|true|yes)$/i.test(String(process.env.PINCUSHION_CAPTURE_AUTH_REQUIRED || ''));
  const allowEmpty = probe || flags.includes('--allow-empty');
  const viewportFlag = flagValue(flags, '--viewport') || '1280x900';
  const viewport = parseViewport(viewportFlag);
  if (!viewport) throw Object.assign(new Error('capture-snapshot: --viewport must look like 1280x900'), { exitCode: 2 });
  const suppliedDevice = flagValue(flags, '--device-class');
  const captureRunId = flagValue(flags, '--capture-run-id');
  // This browser process is deliberately correlation-only. The opaque
  // capability never belongs in argv (where process inspection/history can
  // expose it), output JSON, image metadata, or a file. Only the safe run ID
  // accompanies the local fresh-render observation; authenticated MCP calls
  // later bind the proof to upload/page-result/completion.
  const unsupportedRunContext = flags.find((flag) => flag.startsWith('--capture-run-') && !flag.startsWith('--capture-run-id='));
  if (unsupportedRunContext) {
    throw Object.assign(new Error('capture-snapshot: only --capture-run-id=<id> is allowed as browser run context'), { exitCode: 2 });
  }
  const maxPagesValue = Number(flagValue(flags, '--discovery-max-pages') || DEFAULT_DISCOVERY_MAX_PAGES);
  const maxPages = Number.isInteger(maxPagesValue) && maxPagesValue >= 1 && maxPagesValue <= 64 ? maxPagesValue : DEFAULT_DISCOVERY_MAX_PAGES;

  if (critique) {
    if (reconcile || flags.includes('--probe') || exactInventoryStdin) {
      throw critiqueArgumentError('--critique cannot be combined with probe or reconciliation mode');
    }
    const [pageUrl, outputDir] = positional;
    if (!pageUrl || !outputDir || positional.length !== 2) {
      throw critiqueArgumentError('usage: capture-snapshot.mjs --critique <url> <outputDir> [--page-only] [--require-auth] [--pins=<json-or-file>]');
    }
    const pins = normalizeCritiquePins(readJsonArgument(flagValue(flags, '--pins'), 'critique pins'), pageUrl);
    return {
      critique: true,
      reconcile: false,
      probe: true,
      discover: !flags.includes('--page-only'),
      pageOnly: flags.includes('--page-only'),
      exactInventoryStdin: false,
      requireAll: true,
      requireAuthenticated,
      allowEmpty: true,
      viewport,
      suppliedDevice: null,
      maxPages: CRITIQUE_DISCOVERY_MAX_PAGES,
      captureRunId: null,
      forceFreshRender: true,
      pageUrl,
      outputDir,
      pins,
      inventory: readJsonArgument(flagValue(flags, '--inventory'), 'inventory'),
    };
  }
  if (flags.includes('--page-only') || flagValue(flags, '--pins')) {
    throw critiqueArgumentError('--page-only and --pins are available only with --critique');
  }

  if (reconcile) {
    const [pageUrl, outputDir] = positional;
    if (!pageUrl || !outputDir || positional.length !== 2) {
      throw Object.assign(new Error('usage: capture-snapshot.mjs --reconcile <rootUrl> <outputDir> [--inventory=<json-or-file>] [--previous-receipts=<json-or-file>] [--require-auth]'), { exitCode: 2 });
    }
    if (exactInventoryStdin) {
      if (flags.includes('--discover') || flagValue(flags, '--inventory') || flagValue(flags, '--previous-receipts')) {
        throw exactInventoryError();
      }
      const exactInput = parseExactInventoryStdin(pageUrl);
      return {
        critique: false, reconcile, probe: true, discover: false, exactInventoryStdin: true,
        requireAll, requireAuthenticated, allowEmpty, viewport, suppliedDevice, maxPages,
        captureRunId: captureRunId || null,
        forceFreshRender: true,
        pageUrl, outputDir,
        exactPageUrls: exactInput.pageUrls,
        inventory: null,
        previousReceipts: exactInput.previousReceipts,
      };
    }
    return {
      critique: false, reconcile, probe, discover, exactInventoryStdin: false, requireAll, requireAuthenticated, allowEmpty, viewport, suppliedDevice, maxPages,
      captureRunId: captureRunId || null,
      forceFreshRender: true,
      pageUrl, outputDir,
      inventory: readJsonArgument(flagValue(flags, '--inventory'), 'inventory'),
      previousReceipts: readJsonArgument(flagValue(flags, '--previous-receipts'), 'previous receipts'),
    };
  }

  let [pageUrl, pinsArg, outPath] = positional;
  // Probe mode's ergonomic form omits a pin payload: --probe <url> <out.jpg>.
  if (probe && !outPath && pinsArg) {
    outPath = pinsArg;
    pinsArg = '{}';
  }
  if (!pageUrl || !pinsArg || !outPath || positional.length > 3) {
    throw Object.assign(new Error('usage: capture-snapshot.mjs <pageUrl> <pinsJsonOrFile> <outJpegPath> [--require-auth]'), { exitCode: 2 });
  }
  let pins;
  try { pins = JSON.parse(pinsArg); } catch { pins = JSON.parse(readFileSync(pinsArg, 'utf8')); }
  return {
    critique: false, reconcile, probe, discover, exactInventoryStdin: false, requireAll, requireAuthenticated, allowEmpty, viewport, suppliedDevice, maxPages,
    captureRunId: captureRunId || null,
    forceFreshRender: flags.includes('--force-fresh-render'),
    pageUrl, pins, outPath,
    inventory: readJsonArgument(flagValue(flags, '--inventory'), 'inventory'),
  };
}

async function runSingle(context, options, authentication, navigationGuard) {
  const root = normalizeInventoryUrl(options.pageUrl);
  if (!root) throw Object.assign(new Error('capture-snapshot: pageUrl must be an http(s) URL'), { exitCode: 2 });
  const rootOrigin = new URL(root).origin;
  const discovery = options.discover ? await discoverSiteStructure(context, root, options.inventory, options.maxPages, authentication, navigationGuard) : null;
  const discoveryNetworkFailure = discovery?.pages.find((page) => isNetworkNavigationFailure(page.reason));
  if (discoveryNetworkFailure) {
    throw Object.assign(new Error(`capture-snapshot: ${discoveryNetworkFailure.reason}`), { exitCode: NETWORK_CAPTURE_FAILURE_EXIT_CODE });
  }
  const discoveryAuthFailure = discovery?.pages.find((page) => isRequiredAuthenticationFailure(page.reason, authentication));
  if (discoveryAuthFailure) {
    throw Object.assign(new Error(`capture-snapshot: ${discoveryAuthFailure.reason}`), { exitCode: AUTH_CAPTURE_FAILURE_EXIT_CODE });
  }
  const captured = await captureOne(context, {
    pageUrl: root,
    pins: options.pins,
    viewport: options.viewport,
    deviceClass: deviceClassForViewport(options.viewport, options.suppliedDevice),
    rootOrigin,
    authentication,
    navigationGuard,
    forceFreshRender: options.forceFreshRender,
  });
  if (!captured.receipt) {
    // Probe mode turns a terminal access result into truthful JSON rather than
    // pretending a login/404 page is an after-capture. Preserve legacy error
    // behavior for ordinary capture mode.
    if (!options.probe) {
      const error = new Error(`capture-snapshot: ${captured.probe?.reason || 'could not capture page'}`);
      if (isRequiredAuthenticationFailure(captured.probe?.reason, authentication)) error.exitCode = AUTH_CAPTURE_FAILURE_EXIT_CODE;
      if (isNetworkNavigationFailure(captured.probe?.reason)) error.exitCode = NETWORK_CAPTURE_FAILURE_EXIT_CODE;
      throw error;
    }
    return {
      kind: 'single',
      captured: null,
      output: { ...captured.probe, discovery, auth: captureAuthReceipt(authentication) },
      exitCode: isNetworkNavigationFailure(captured.probe?.reason)
        ? NETWORK_CAPTURE_FAILURE_EXIT_CODE
        : isRequiredAuthenticationFailure(captured.probe?.reason, authentication)
          ? AUTH_CAPTURE_FAILURE_EXIT_CODE
          : null,
    };
  }
  const result = { ...captured.receipt, auth: captureAuthReceipt(authentication), ...(discovery ? { discovery } : {}) };
  return {
    kind: 'single',
    captured,
    output: result,
    exitCode: discovery?.truncated
      ? 5
      : !options.allowEmpty && (result.captured === 0 || (options.requireAll && result.captured !== result.requested))
        ? 3
        : null,
  };
}

function critiquePageShell(discovered) {
  return {
    pageUrl: discovered.pageUrl,
    finalUrl: discovered.finalUrl || null,
    outcome: discovered.outcome,
    reason: discovered.reason,
    status: discovered.status || null,
    sources: Array.isArray(discovered.sources) ? discovered.sources.slice(0, 8) : [],
    title: null,
    observedLinks: [],
    captures: {},
  };
}

function critiqueDiscoveryReceipt(discovery, pageOnly) {
  const sourceCounts = {};
  for (const page of discovery.pages || []) {
    for (const source of page.sources || []) sourceCounts[source] = (sourceCounts[source] || 0) + 1;
  }
  return {
    strategy: pageOnly ? 'page-only' : 'same-origin',
    candidates: discovery.candidates,
    visited: discovery.pages.length,
    maxPages: discovery.maxPages,
    truncated: discovery.truncated === true,
    sourceCounts,
    skippedActions: discovery.skippedActions || [],
    skippedActionsTruncated: discovery.skippedActionsTruncated === true,
  };
}

function critiqueCaptureReceipt(receipt, imagePath) {
  return {
    imagePath,
    dimensions: { width: receipt.width, height: receipt.height },
    captureContext: receipt.captureContext,
    pinPositions: receipt.positions,
    hotspots: receipt.hotspots,
    requestedPins: receipt.requested,
    resolvedPins: receipt.captured,
    unresolvedPins: receipt.unresolved,
    visibleElements: receipt.visibleElements || [],
    stateEvidence: receipt.stateEvidence || [],
    stateCoverage: receipt.stateCoverage || {
      candidateStates: 0,
      capturedStates: 0,
      gapCount: 0,
      gaps: [],
      gapsTruncated: false,
    },
  };
}

function critiqueAccessMode(authentication) {
  return authentication?.mode === 'authenticated' ? 'project_members' : 'public';
}

function critiqueFailureOutput(options, reason, authentication = null, {
  status = 'failed',
  pages = [],
  discovery = null,
} = {}) {
  const rootUrl = normalizeInventoryUrl(options?.pageUrl) || null;
  return {
    mode: 'critique-v1',
    status,
    reason,
    rootUrl,
    auth: authentication?.ok
      ? captureAuthReceipt(authentication)
      : { mode: 'unavailable', expected: options?.requireAuthenticated === true },
    ...(authentication?.ok ? { accessMode: critiqueAccessMode(authentication) } : {}),
    discovery: discovery || {
      strategy: options?.pageOnly ? 'page-only' : 'same-origin',
      candidates: 0,
      visited: 0,
      maxPages: options?.pageOnly ? 1 : CRITIQUE_DISCOVERY_MAX_PAGES,
      truncated: false,
      sourceCounts: {},
    },
    coverage: {
      candidatePages: discovery?.candidates || 0,
      capturedPages: 0,
      completeCapturePairs: 0,
      missingCapturePairs: pages.length,
      requestedPins: 0,
      resolvedPins: 0,
      truncated: discovery?.truncated === true,
    },
    pages,
  };
}

function stripCritiqueCaptureReferences(output) {
  output.pages = output.pages.map((page) => ({ ...page, captures: {} }));
  output.coverage.capturedPages = 0;
  output.coverage.completeCapturePairs = 0;
  output.coverage.missingCapturePairs = output.pages.length;
  output.coverage.resolvedPins = 0;
}

async function runCritique(context, options, authentication, navigationGuard) {
  const discovery = options.pageOnly
    ? await discoverCritiquePageOnly(context, options.pageUrl, authentication, navigationGuard)
    : await discoverSiteStructure(
      context,
      options.pageUrl,
      options.inventory,
      CRITIQUE_DISCOVERY_MAX_PAGES,
      authentication,
      navigationGuard,
      {
        includeOriginRoot: true,
        omitCredentialUrls: true,
        preserveAppearance: true,
        inspectSafeStates: true,
      },
    );
  const discoveryReceipt = critiqueDiscoveryReceipt(discovery, options.pageOnly);
  const pages = discovery.pages.map(critiquePageShell);
  const requestedPins = Object.values(options.pins || {}).reduce((sum, pagePins) => sum + Object.keys(pagePins || {}).length, 0);
  const output = {
    mode: 'critique-v1',
    status: 'complete',
    rootUrl: discovery.rootUrl,
    auth: captureAuthReceipt(authentication),
    accessMode: critiqueAccessMode(authentication),
    discovery: discoveryReceipt,
    coverage: {
      candidatePages: discovery.candidates,
      skippedActionRoutes: discovery.skippedActions?.length || 0,
      capturedPages: 0,
      completeCapturePairs: 0,
      missingCapturePairs: 0,
      requestedPins,
      resolvedPins: 0,
      truncated: discovery.truncated === true,
    },
    pages,
  };
  const pendingImageWrites = [];

  const networkFailure = discovery.pages.find((page) => isNetworkNavigationFailure(page.reason));
  if (networkFailure) {
    output.status = 'failed';
    output.reason = networkFailure.reason;
    stripCritiqueCaptureReferences(output);
    return { kind: 'critique', output, pendingImageWrites: [], exitCode: NETWORK_CAPTURE_FAILURE_EXIT_CODE };
  }
  const authFailure = discovery.pages.find((page) => isAuthenticationCoverageGap(page.reason));
  if (authFailure) {
    output.status = 'incomplete';
    output.reason = authFailure.reason;
    output.coverage.authGap = true;
    stripCritiqueCaptureReferences(output);
    return { kind: 'critique', output, pendingImageWrites: [], exitCode: AUTH_CAPTURE_FAILURE_EXIT_CODE };
  }
  const capturedPinPages = new Set();
  const incompleteReasons = new Set();
  if (discovery.truncated) incompleteReasons.add('discovery_bound_reached');
  for (let index = 0; index < discovery.pages.length; index += 1) {
    const discovered = discovery.pages[index];
    const pageResult = output.pages[index];
    if (discovered.outcome !== 'accessible') {
      incompleteReasons.add(discovered.reason || 'page_inaccessible');
      output.coverage.missingCapturePairs += 1;
      continue;
    }
    const pagePins = options.pins?.[discovered.pageUrl] || {};
    if (Object.prototype.hasOwnProperty.call(options.pins || {}, discovered.pageUrl)) capturedPinPages.add(discovered.pageUrl);
    const receipts = {};
    let captureFailure = null;
    for (const [deviceClass, viewport] of Object.entries(CANONICAL_DEPLOYMENT_VIEWPORTS)) {
      const captured = await captureOne(context, {
        pageUrl: discovered.pageUrl,
        pins: pagePins,
        viewport,
        deviceClass,
        rootOrigin: discovery.origin,
        authentication,
        navigationGuard,
        forceFreshRender: true,
        critiqueEvidence: true,
      });
      if (!captured.receipt) {
        captureFailure = captured.probe || { reason: 'capture_missing' };
        break;
      }
      const stem = safeOutputStem(discovered.pageUrl);
      const imagePath = `${options.outputDir}/${stem}-${deviceClass}.jpg`;
      pendingImageWrites.push({ imagePath, image: captured.image });
      receipts[deviceClass] = captured.receipt;
      pageResult.captures[deviceClass] = critiqueCaptureReceipt(captured.receipt, imagePath);
      pageResult.title ||= captured.receipt.title || null;
      pageResult.finalUrl ||= captured.receipt.finalUrl || null;
      pageResult.observedLinks = [...new Set([
        ...pageResult.observedLinks,
        ...(captured.receipt.observedLinks || []),
      ])].slice(0, 256);
      output.coverage.resolvedPins += captured.receipt.captured;
      if (captured.receipt.unresolved > 0) incompleteReasons.add('unresolved_supplied_pin');
    }
    if (captureFailure) {
      pageResult.outcome = captureFailure.outcome || 'incomplete';
      pageResult.reason = captureFailure.reason || 'capture_missing';
      output.coverage.missingCapturePairs += 1;
      if (isNetworkNavigationFailure(pageResult.reason)) {
        output.status = 'failed';
        output.reason = pageResult.reason;
        stripCritiqueCaptureReferences(output);
        return { kind: 'critique', output, pendingImageWrites: [], exitCode: NETWORK_CAPTURE_FAILURE_EXIT_CODE };
      }
      if (isAuthenticationCoverageGap(pageResult.reason)) {
        output.status = 'incomplete';
        output.reason = pageResult.reason;
        output.coverage.authGap = true;
        stripCritiqueCaptureReferences(output);
        return { kind: 'critique', output, pendingImageWrites: [], exitCode: AUTH_CAPTURE_FAILURE_EXIT_CODE };
      }
      incompleteReasons.add(pageResult.reason);
      continue;
    }
    const pairComplete = receipts.desktop && receipts.mobile;
    const sameFinalUrl = pairComplete && receipts.desktop.finalUrl === receipts.mobile.finalUrl;
    if (!pairComplete || !sameFinalUrl) {
      output.coverage.missingCapturePairs += 1;
      incompleteReasons.add(pairComplete ? 'capture_final_url_mismatch' : 'missing_capture_pair');
      pageResult.outcome = 'incomplete';
      pageResult.reason = pairComplete ? 'capture_final_url_mismatch' : 'missing_capture_pair';
      continue;
    }
    pageResult.outcome = 'accessible';
    pageResult.reason = 'captured';
    output.coverage.capturedPages += 1;
    output.coverage.completeCapturePairs += 1;
  }

  const undiscoveredPinPages = Object.keys(options.pins || {}).filter((pageUrl) => !capturedPinPages.has(pageUrl));
  if (undiscoveredPinPages.length) {
    incompleteReasons.add('unresolved_supplied_pin_page');
    output.coverage.unresolvedPinPages = undiscoveredPinPages.length;
  }
  // Each requested pin must resolve independently in both canonical captures.
  if (output.coverage.resolvedPins !== requestedPins * 2) incompleteReasons.add('unresolved_supplied_pin');
  if (output.coverage.completeCapturePairs !== discovery.pages.length) incompleteReasons.add('missing_capture_pair');
  if (incompleteReasons.size) {
    output.status = 'incomplete';
    output.reasons = [...incompleteReasons].sort().slice(0, 16);
    output.reason = output.reasons[0];
  }
  return {
    kind: 'critique',
    output,
    pendingImageWrites,
    exitCode: output.status === 'complete' ? null : 5,
  };
}

async function runReconciliation(context, options, authentication, navigationGuard) {
  // The internal exact-inventory mode is deliberately not a discovery mode:
  // the caller's bounded, ordered URL set is the complete scope and the root
  // URL is only an origin anchor. Regular reconciliation keeps its existing
  // rendered-link/sitemap discovery behavior unchanged.
  const discovery = !options.exactInventoryStdin
    ? await discoverSiteStructure(context, options.pageUrl, options.inventory, options.maxPages, authentication, navigationGuard)
    : buildExactInventoryDiscovery(options.pageUrl, options.exactPageUrls, authentication);
  const pendingImageWrites = [];
  const output = {
    mode: 'deployment-reconciliation-v2',
    rootUrl: discovery.rootUrl,
    auth: captureAuthReceipt(authentication),
    // The proof is intentionally omitted. A capture-run ID is safe local
    // correlation metadata and lets the caller bind staging/page-result calls.
    ...(options.captureRunId ? { captureRunId: options.captureRunId } : {}),
    forceFreshRender: options.forceFreshRender === true,
    // Feed this exact bounded set to register_deployment_discovered_pages
    // before an agent stages or reports any page result. Keeping it explicit
    // prevents a consumer from deriving a broader/changed URL set from files.
    discoveredPageUrls: discovery.pages.map((page) => page.pageUrl),
    discovery: {
      candidates: discovery.candidates,
      maxPages: discovery.maxPages,
      truncated: discovery.truncated,
    },
    pages: [],
  };
  const requiredNetworkFailure = discovery.pages.find((page) => isNetworkNavigationFailure(page.reason));
  if (requiredNetworkFailure) {
    output.status = 'failed';
    output.reason = requiredNetworkFailure.reason;
    output.pages = discovery.pages;
    return { kind: 'reconciliation', output, pendingImageWrites, exitCode: NETWORK_CAPTURE_FAILURE_EXIT_CODE };
  }
  const requiredAuthFailure = discovery.pages.find((page) => isRequiredAuthenticationFailure(page.reason, authentication));
  if (requiredAuthFailure) {
    output.status = 'failed';
    output.reason = requiredAuthFailure.reason;
    output.pages = discovery.pages;
    return { kind: 'reconciliation', output, pendingImageWrites, exitCode: AUTH_CAPTURE_FAILURE_EXIT_CODE };
  }
  if (discovery.truncated) {
    output.status = 'unknown';
    output.reason = 'discovery_bound_reached';
    output.pages = discovery.pages;
    return { kind: 'reconciliation', output, pendingImageWrites, exitCode: 5 };
  }
  for (const discovered of discovery.pages) {
    const pageResult = {
      pageUrl: discovered.pageUrl,
      finalUrl: discovered.finalUrl || null,
      probe: {
        outcome: discovered.outcome,
        reason: discovered.reason,
        status: discovered.status || null,
        auth: discovered.auth || captureAuthReceipt(authentication),
      },
      sources: discovered.sources,
    };
    if (discovered.outcome !== 'accessible') {
      pageResult.reconciliation = classifyDeploymentPage({ probe: pageResult.probe });
      output.pages.push(pageResult);
      continue;
    }
    const currentReceipts = {};
    const images = {};
    for (const [deviceClass, viewport] of Object.entries(CANONICAL_DEPLOYMENT_VIEWPORTS)) {
      const captured = await captureOne(context, {
        pageUrl: discovered.pageUrl,
        pins: {},
        viewport,
        deviceClass,
        rootOrigin: discovery.origin,
        authentication,
        navigationGuard,
        forceFreshRender: options.forceFreshRender,
      });
      if (captured.receipt) {
        currentReceipts[deviceClass] = captured.receipt;
        images[deviceClass] = captured.image;
      } else {
        pageResult.probe = captured.probe;
      }
    }
    const pageSecurityFailure = pageResult.probe?.reason;
    if (isNetworkNavigationFailure(pageSecurityFailure) || isRequiredAuthenticationFailure(pageSecurityFailure, authentication)) {
      pageResult.reconciliation = classifyDeploymentPage({
        probe: pageResult.probe,
        previousReceipts: previousReceiptsForPage(options.previousReceipts, discovered.pageUrl) || {},
        currentReceipts,
      });
      output.pages.push(pageResult);
      output.status = 'failed';
      output.reason = pageSecurityFailure;
      return {
        kind: 'reconciliation',
        output,
        pendingImageWrites,
        exitCode: isNetworkNavigationFailure(pageSecurityFailure)
          ? NETWORK_CAPTURE_FAILURE_EXIT_CODE
          : AUTH_CAPTURE_FAILURE_EXIT_CODE,
      };
    }
    const reconciliation = classifyDeploymentPage({
      probe: pageResult.probe,
      previousReceipts: previousReceiptsForPage(options.previousReceipts, discovered.pageUrl) || {},
      currentReceipts,
    });
    pageResult.reconciliation = reconciliation;
    pageResult.requiresFreshRender = reconciliation.requiresFreshRender === true;
    pageResult.requiresStagedVersions = reconciliation.requiresStagedVersions === true;
    if (reconciliation.shouldStage) {
      const stem = safeOutputStem(discovered.pageUrl);
      pageResult.captures = {};
      for (const deviceClass of Object.keys(CANONICAL_DEPLOYMENT_VIEWPORTS)) {
        const receipt = currentReceipts[deviceClass];
        const image = images[deviceClass];
        if (!receipt || !image) continue;
        const imagePath = `${options.outputDir}/${stem}-${deviceClass}.jpg`;
        pendingImageWrites.push({ imagePath, image });
        pageResult.captures[deviceClass] = { ...receipt, imagePath };
      }
    } else {
      // Do not leave zero-change images on disk. The fingerprints above were
      // calculated from in-memory settled screenshots and contain no pixels.
      pageResult.fingerprints = Object.fromEntries(Object.entries(currentReceipts).map(([deviceClass, receipt]) => [deviceClass, {
        semanticHash: receipt.semanticHash,
        visualFingerprint: receipt.visualFingerprint,
        imageContentHash: receipt.imageContentHash,
      }]));
    }
    output.pages.push(pageResult);
  }
  output.status = output.pages.some((page) => page.reconciliation?.outcome === 'unknown') ? 'partial' : 'complete';
  return { kind: 'reconciliation', output, pendingImageWrites, exitCode: null };
}

function emitCaptureRun(run, options) {
  if (run.kind === 'single' && run.captured) {
    writeFileSync(options.outPath, run.captured.image);
  }
  if ((run.kind === 'reconciliation' || run.kind === 'critique') && run.pendingImageWrites.length) {
    mkdirSync(options.outputDir, { recursive: true });
    for (const { imagePath, image } of run.pendingImageWrites) writeFileSync(imagePath, image);
  }
  if (run.kind === 'critique') {
    run.output.eligible = run.output.status === 'complete' &&
      run.output.pages.length > 0 &&
      run.output.coverage.completeCapturePairs === run.output.pages.length &&
      run.output.coverage.truncated !== true &&
      run.output.coverage.authGap !== true;
    const evidenceByteLength = Buffer.byteLength(JSON.stringify({
      discovery: run.output.discovery,
      coverage: run.output.coverage,
      pages: run.output.pages,
    }));
    run.output.runtimeStats = {
      browserLaunches: browserLaunchCount,
      routeCount: run.output.discovery?.visited || 0,
      elapsedMs: Math.max(0, Date.now() - CAPTURE_STARTED_AT),
      evidenceByteLength,
      evidenceTokenEstimate: Math.ceil(evidenceByteLength / 4),
      tokenEstimator: 'utf8-bytes-divided-by-4-ceiling',
    };
  }
  console.log(JSON.stringify(run.output));
  if (run.exitCode) process.exitCode = run.exitCode;
}

let options;
try {
  options = parseArguments();
} catch (error) {
  console.error(error?.message || String(error));
  process.exit(error?.exitCode || 2);
}

let navigationOrigin = null;
try { navigationOrigin = new URL(options.pageUrl).origin; } catch { /* initial guard rejects malformed targets */ }
const allowedLoopbackOrigin = options.critique ? captureLoopbackOriginForTarget(options.pageUrl) : null;
const socketBoundary = createCaptureSocksProxy({
  allowedLoopbackOrigin,
  // Crit probes up to 64 routes and checks redirects in a separate guarded
  // request before each render. Retain a finite per-run budget sized for that
  // work; the same address and exact-loopback restrictions still apply.
  ...(options.critique ? { maxDnsLookups: 512, maxConnectAttempts: 512 } : {}),
});
const navigationGuard = options.exactInventoryStdin
  ? createExactScopeNavigationGuard({
    navigationOrigin,
    allowedPageUrls: options.exactPageUrls,
    getBlockedCode: () => socketBoundary.getBlockedCode(),
  })
  : createCaptureNavigationGuard({
    navigationOrigin,
    allowedLoopbackOrigin,
    getBlockedCode: () => socketBoundary.getBlockedCode(),
    ...(options.critique ? {
      inspectRedirects: true,
      blockActionUrl: (url) => critiqueActionReason(url) ? 'action_route_blocked' : null,
    } : {}),
  });
// Exact mode permits the root only as an origin anchor; it is not itself an
// in-scope navigation unless it appears in the stdin inventory.
const initialNavigation = options.exactInventoryStdin
  ? await navigationGuard.assertOriginAnchor(options.pageUrl)
  : await navigationGuard.assertInitial(options.pageUrl);
if (!initialNavigation.ok) {
  console.error(`capture-snapshot: navigation target rejected (${initialNavigation.code}).`);
  if (options.critique) {
    emitCaptureRun({
      kind: 'critique',
      output: critiqueFailureOutput(options, initialNavigation.code),
      pendingImageWrites: [],
      exitCode: NETWORK_CAPTURE_FAILURE_EXIT_CODE,
    }, options);
  }
  process.exit(NETWORK_CAPTURE_FAILURE_EXIT_CODE);
}
if (options.critique) {
  const rootAction = critiqueActionReason(options.pageUrl);
  if (rootAction) {
    emitCaptureRun({
      kind: 'critique',
      output: critiqueFailureOutput(options, rootAction, null, { status: 'incomplete' }),
      pendingImageWrites: [],
      exitCode: 5,
    }, options);
    process.exit(5);
  }
}

const authentication = resolveCaptureAuthentication({
  targetUrl: options.pageUrl,
  storageStatePath: process.env.PINCUSHION_STORAGE_STATE,
  storageStateSupplied: Object.prototype.hasOwnProperty.call(process.env, 'PINCUSHION_STORAGE_STATE'),
  requireAuthenticated: options.requireAuthenticated,
});
if (!authentication.ok) {
  // Do not reveal a credential path, file metadata, cookie, or storage value.
  // A supplied/required state never downgrades to anonymous capture.
  console.error(`capture-snapshot: authenticated capture unavailable (${authentication.code}). Re-run \`npx pincushion-mcp snapshot --login <target-url> --proof-selector '<signed-in-only-css-selector>'\` for this exact origin, then use its secure state file.`);
  if (options.critique) {
    emitCaptureRun({
      kind: 'critique',
      output: critiqueFailureOutput(options, authentication.code, authentication),
      pendingImageWrites: [],
      exitCode: AUTH_CAPTURE_FAILURE_EXIT_CODE,
    }, options);
  }
  process.exit(AUTH_CAPTURE_FAILURE_EXIT_CODE);
}

const chromium = loadChromiumLib();
if (!chromium) {
  if (noInstallRequested()) {
    console.error('capture-snapshot: browser runtime unavailable (provisioning disabled).');
  } else {
    console.error('capture-snapshot: Playwright is not installed and could not be self-installed (offline?). Install it (`npm i --no-save playwright`) or capture with your environment\'s own browser tooling — see page-snapshot-capture.md.');
  }
  if (options.critique) {
    emitCaptureRun({
      kind: 'critique',
      output: critiqueFailureOutput(options, 'browser_runtime_unavailable', authentication),
      pendingImageWrites: [],
      exitCode: 4,
    }, options);
  }
  process.exit(4);
}

let browser;
let deferredCritiqueFailure = null;
try {
  await socketBoundary.start();
  browser = await launchBrowser(chromium, socketBoundary);
  browserLaunchCount += 1;
  const context = await browser.newContext(configuredContextOptions(authentication));
  let run;
  try {
    await navigationGuard.install(context);
    run = options.critique
      ? await runCritique(context, options, authentication, navigationGuard)
      : options.reconcile
        ? await runReconciliation(context, options, authentication, navigationGuard)
        : await runSingle(context, options, authentication, navigationGuard);
  } finally {
    await context.close();
  }
  // No frame receipt is emitted while Chromium can still open a late socket.
  // Closing this task-owned browser first also closes all of its proxy tunnels.
  await browser.close();
  browser = null;
  await assertSocketBoundaryClean(socketBoundary, navigationGuard);
  emitCaptureRun(run, options);
} catch (error) {
  // A close failure must never downgrade an already-latched proxy/navigation
  // rejection. No receipt has been emitted, and callers need the stable
  // network-boundary exit code to distinguish it from an ordinary capture
  // teardown failure.
  const blocked = navigationGuard.getBlockedCode() || socketBoundary.getBlockedCode();
  if (options.exactInventoryStdin) {
    // Never echo Playwright/receipt errors that could contain stdin material.
    // Keep the no-install branch a fixed code without installer wording.
    console.error(noInstallRequested()
      ? 'capture-snapshot: browser runtime unavailable (provisioning disabled).'
      : 'capture-snapshot: exact inventory capture failed');
  } else if (options.critique) {
    console.error('capture-snapshot: critique capture failed');
    deferredCritiqueFailure = {
      kind: 'critique',
      output: critiqueFailureOutput(options, blocked || 'capture_failed', authentication),
      pendingImageWrites: [],
      exitCode: blocked ? NETWORK_CAPTURE_FAILURE_EXIT_CODE : (error?.exitCode || 1),
    };
  } else {
    console.error('capture-snapshot: ' + (error?.message || error));
  }
  if (blocked) process.exitCode = NETWORK_CAPTURE_FAILURE_EXIT_CODE;
  else if (!process.exitCode) process.exitCode = error?.exitCode || 1;
} finally {
  if (browser) {
    const activeBrowser = browser;
    browser = null;
    await activeBrowser.close().catch(() => {});
  }
  // A context/browser close failure can leave an in-flight SOCKS resolver or
  // numeric connect running after the outer catch sampled its latch. Drain
  // this task-owned boundary after browser teardown, then sample the latch
  // again before stop so a late private answer still has the code-7 contract.
  await assertSocketBoundaryClean(socketBoundary, navigationGuard).catch(() => {});
  const finalBlocked = navigationGuard.getBlockedCode() || socketBoundary.getBlockedCode();
  if (finalBlocked) process.exitCode = NETWORK_CAPTURE_FAILURE_EXIT_CODE;
  await socketBoundary.stop().catch(() => {});
}
if (deferredCritiqueFailure) {
  if (process.exitCode === NETWORK_CAPTURE_FAILURE_EXIT_CODE) {
    deferredCritiqueFailure.output.reason = navigationGuard.getBlockedCode() || socketBoundary.getBlockedCode() || 'network_capture_failed';
    deferredCritiqueFailure.exitCode = NETWORK_CAPTURE_FAILURE_EXIT_CODE;
  }
  emitCaptureRun(deferredCritiqueFailure, options);
}
