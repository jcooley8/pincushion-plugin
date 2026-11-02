#!/usr/bin/env node
// pincushion-mcp/snapshot.mjs
//
// `pincushion-mcp snapshot --login <url> --proof-selector <selector>` — open a
// real (headed) browser, let the user sign in to their app, and save the
// resulting Playwright storageState plus origin-bound signed-in proof to
// ~/.pincushion/auth/<domain>.json (0600). Headless capture
// (scripts/capture-snapshot.mjs) then reuses it via PINCUSHION_STORAGE_STATE, so
// the crit-wall snapshot + /snapshot-latest-deploy work on pages behind login.
// Credentials never leave the machine; only rendered captures upload.

import {
  closeSync,
  constants as fsConstants,
  chmodSync,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { homedir } from 'os';
import { join } from 'path';
import { createRequire } from 'module';
import { randomBytes } from 'crypto';
import {
  authProofPathForStorageState,
  buildCaptureAuthProof,
  normalizeCaptureAuthProofSelector,
  validateCaptureStorageStateObject,
} from './lib/capture-auth-state.js';
import {
  createCaptureNavigationGuard,
  NETWORK_CAPTURE_FAILURE_EXIT_CODE,
} from './lib/capture-network-guard.js';

const _require = createRequire(import.meta.url);

// ── auth-file location (mirrors login.mjs's ~/.pincushion posture) ──
export function authDirPath() {
  return process.env.PINCUSHION_AUTH_DIR || join(homedir(), '.pincushion', 'auth');
}
// Map a URL to a safe per-domain filename. Host only, lowercased, non-alnum→'.',
// so a hostile host can never escape the auth dir.
export function authFileForDomain(url) {
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch { host = String(url || '').toLowerCase(); }
  const safe = host.replace(/[^a-z0-9.-]/g, '.').replace(/\.\.+/g, '.').replace(/^\.+|\.+$/g, '') || 'unknown';
  return join(authDirPath(), `${safe}.json`);
}

export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--login') { out.login = argv[++i]; }
    else if (a === '--proof-selector') { out.proofSelector = argv[++i]; }
    else if (a === '--headless') { out.headless = true; }
    else if (a.startsWith('--')) { out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true; }
    else { out._.push(a); }
  }
  return out;
}

function snapshotError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function assertSecureOwnedRegularFile(path) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw snapshotError('auth_saved_file_not_regular');
  if (!Number.isInteger(currentUid()) || !Number.isInteger(stat.uid) || stat.uid !== currentUid()) {
    throw snapshotError('auth_saved_file_owner_mismatch');
  }
  if ((stat.mode & 0o077) !== 0) throw snapshotError('auth_saved_file_permissions_insecure');
}

// The state/proof directory is an authentication boundary too. Refuse an
// existing symlink/non-directory or foreign-owned directory; otherwise tighten
// a user-owned directory before writing a randomly named staging file inside it.
export function ensureSecureAuthDirectory() {
  const directory = authDirPath();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw snapshotError('auth_directory_unsafe');
  if (!Number.isInteger(currentUid()) || !Number.isInteger(stat.uid) || stat.uid !== currentUid()) {
    throw snapshotError('auth_directory_owner_mismatch');
  }
  // chmod on an owned real directory is a repair, not a follow/replace.
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) throw snapshotError('auth_directory_no_follow_unavailable');
  // Verify the opened descriptor before tightening a historical 0755 directory
  // and creating any state/proof staging file inside it.
  const descriptor = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = fstatSync(descriptor);
    if (!opened.isDirectory() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.uid !== currentUid()) {
      throw snapshotError('auth_directory_changed');
    }
  } finally {
    closeSync(descriptor);
  }
  // `mkdirSync` honors umask, so tighten the lstat-verified owned directory
  // before any state/proof staging file is created.
  chmodSync(directory, 0o700);
  const finalStat = lstatSync(directory);
  if (finalStat.isSymbolicLink() || !finalStat.isDirectory() || finalStat.uid !== currentUid() || (finalStat.mode & 0o077) !== 0) {
    throw snapshotError('auth_directory_unsafe');
  }
  return directory;
}

function writeSecureJsonStage(path, value) {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) throw snapshotError('auth_saved_file_no_follow_unavailable');
  let raw;
  try {
    raw = typeof value === 'string' ? value : JSON.stringify(value);
  } catch {
    throw snapshotError('auth_saved_file_serialization_failed');
  }
  if (!raw) throw snapshotError('auth_saved_file_serialization_failed');
  const descriptor = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.uid !== currentUid() || (stat.mode & 0o077) !== 0) throw snapshotError('auth_saved_file_unsafe');
    // Keep the O_EXCL/O_NOFOLLOW descriptor open through write and fsync: no
    // second pathname open exists between reservation and persisted contents.
    writeFileSync(descriptor, raw, 'utf8');
    fsyncSync(descriptor);
    const after = fstatSync(descriptor);
    if (!after.isFile() || after.dev !== stat.dev || after.ino !== stat.ino || after.uid !== currentUid() || (after.mode & 0o077) !== 0) {
      throw snapshotError('auth_saved_file_changed');
    }
  } finally {
    closeSync(descriptor);
  }
  assertSecureOwnedRegularFile(path);
  return raw;
}

function atomicReplaceSecureFile(stagedPath, destinationPath) {
  assertSecureOwnedRegularFile(stagedPath);
  renameSync(stagedPath, destinationPath);
  assertSecureOwnedRegularFile(destinationPath);
}

async function visibleProof(page, selector, targetUrl) {
  try {
    if (new URL(page.url()).origin !== new URL(targetUrl).origin) return false;
    return await page.evaluate((proofSelector) => {
      let element;
      try { element = document.querySelector(proofSelector); } catch { return false; }
      if (!element || element.hidden || element.getAttribute('aria-hidden') === 'true') return false;
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return Boolean(rect.width && rect.height && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity || '1') !== 0);
    }, selector);
  } catch {
    return false;
  }
}

// Minimal headed launch — self-contained so we don't import the self-executing
// capture-snapshot.mjs. Reuses the same env/system browser resolution idea.
async function launchHeaded() {
  let chromium;
  try { chromium = (_require('playwright') || {}).chromium; } catch { /* try core */ }
  if (!chromium) { try { chromium = (_require('playwright-core') || {}).chromium; } catch { /* none */ } }
  if (!chromium) throw new Error('Playwright not installed. Run `npm i -g playwright` or `npx playwright install chromium`.');
  const execPath =
    process.env.PINCUSHION_CHROMIUM || process.env.CHROME_PATH ||
    ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium']
      .find((p) => existsSync(p));
  return chromium.launch({ headless: false, executablePath: execPath || undefined });
}

async function waitForEnter(promptText) {
  process.stdout.write(promptText);
  return new Promise((resolve) => {
    const onData = () => { process.stdin.pause(); process.stdin.off('data', onData); resolve(); };
    process.stdin.resume();
    process.stdin.once('data', onData);
  });
}

export async function runSnapshot(argv = []) {
  const args = parseArgs(argv);
  const proofSelector = normalizeCaptureAuthProofSelector(args.proofSelector);
  if (!args.login || !proofSelector) {
    console.error('usage: pincushion-mcp snapshot --login <url> --proof-selector <visible-signed-in-css-selector>');
    console.error('  Opens a browser to <url>, you sign in, verify the explicit signed-in proof, then save the session for authed captures.');
    return 2;
  }
  const url = args.login;
  // Interactivity gate BEFORE any browser work: the flow needs a human to sign
  // in and press Enter. In a headless env, launching first would open a window
  // (or die with a misleading Playwright exit-4 on display-less servers) before
  // telling the user the real problem.
  if (!process.stdin.isTTY) { console.error('snapshot --login needs an interactive terminal.'); return 2; }
  const navigationGuard = createCaptureNavigationGuard();
  const initialNavigation = await navigationGuard.assertInitial(url);
  if (!initialNavigation.ok) {
    console.error(`snapshot --login: navigation target rejected (${initialNavigation.code}).`);
    return NETWORK_CAPTURE_FAILURE_EXIT_CODE;
  }
  const outFile = authFileForDomain(url);
  const proofFile = authProofPathForStorageState(outFile);
  try {
    ensureSecureAuthDirectory();
  } catch (error) {
    console.error(`snapshot --login: secure auth directory unavailable (${error?.code || 'auth_directory_unsafe'}).`);
    return 1;
  }

  let browser;
  let stagedFile = null;
  let stagedProofFile = null;
  try {
    browser = await launchHeaded();
  } catch (e) {
    console.error('snapshot --login: ' + (e && e.message ? e.message : e));
    return 4;
  }
  try {
    const ctx = await browser.newContext();
    await navigationGuard.install(ctx);
    const page = await ctx.newPage();
    const beforeNavigation = await navigationGuard.validate(url);
    if (!beforeNavigation.ok) {
      console.error(`snapshot --login: navigation target rejected (${beforeNavigation.code}).`);
      return NETWORK_CAPTURE_FAILURE_EXIT_CODE;
    }
    await page.goto(url, { waitUntil: 'domcontentloaded' }).catch(() => {});
    const initialBlocked = navigationGuard.consumeBlockedCode();
    if (initialBlocked) {
      console.error(`snapshot --login: navigation target rejected (${initialBlocked}).`);
      return NETWORK_CAPTURE_FAILURE_EXIT_CODE;
    }
    console.log(`\nA browser window opened at ${url}.`);
    console.log('Sign in to your app in that window.');
    await waitForEnter('When you are logged in and see your app, press Enter here to save the session… ');
    // Validate the just-read object and the exact bytes we will write before
    // creating a staged file. This keeps the proof digest tied to the stored
    // state while avoiding a second pathname read during snapshot creation.
    const storageState = await ctx.storageState();
    let serializedState;
    try { serializedState = JSON.stringify(storageState); } catch { serializedState = null; }
    const validation = validateCaptureStorageStateObject({
      storageState,
      rawState: serializedState,
      targetUrl: url,
    });
    if (!validation.ok) {
      console.error(`snapshot --login: saved state did not prove an authenticated session for this origin (${validation.code}); the prior state was left unchanged.`);
      return 1;
    }
    if (!await visibleProof(page, proofSelector, url)) {
      console.error('snapshot --login: the explicit signed-in proof was not visible on the target origin; the prior state was left unchanged.');
      return 1;
    }
    const builtProof = buildCaptureAuthProof({
      targetUrl: url,
      selector: proofSelector,
      storageStateDigest: validation.storageStateDigest,
    });
    if (!builtProof.ok) {
      console.error(`snapshot --login: proof configuration failed (${builtProof.code}); the prior state was left unchanged.`);
      return 1;
    }
    // Stage the new state beside the existing file. O_EXCL/O_NOFOLLOW plus a
    // single descriptor write make each file owner-only and atomically
    // publishable; a failed precondition never clobbers the prior pair.
    stagedFile = `${outFile}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    writeSecureJsonStage(stagedFile, serializedState);
    stagedProofFile = `${proofFile}.${process.pid}.${randomBytes(12).toString('hex')}.tmp`;
    writeSecureJsonStage(stagedProofFile, builtProof.proof);
    // Publish proof first. A concurrent capture observes either the old matched
    // pair or a digest mismatch (hard failure), never a new state with stale
    // proof or a permissive anonymous fallback.
    atomicReplaceSecureFile(stagedProofFile, proofFile);
    stagedProofFile = null;
    atomicReplaceSecureFile(stagedFile, outFile);
    stagedFile = null;
    console.log(`\nSaved authenticated session → ${outFile}`);
    console.log('Saved an origin-bound signed-in proof alongside the state. Nothing but rendered images ever leaves your machine.');
    console.log(`To use it: set PINCUSHION_STORAGE_STATE=${outFile} and pass --require-auth to capture/reconciliation for this origin.`);
    return 0;
  } catch (e) {
    if (stagedFile) {
      try { unlinkSync(stagedFile); } catch { /* staged state is best-effort cleanup */ }
    }
    if (stagedProofFile) {
      try { unlinkSync(stagedProofFile); } catch { /* staged proof is best-effort cleanup */ }
    }
    console.error('snapshot --login: ' + (e && e.message ? e.message : e));
    return 1;
  } finally {
    try { await browser.close(); } catch { /* ignore */ }
  }
}
