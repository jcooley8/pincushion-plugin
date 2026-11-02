// `pincushion claim` — assert ownership of a public crit-report and attach it
// to the developer's Pincushion license.
//
// Usage: npx pincushion-mcp claim <report-token> [--project-dir <dir>] [--license-key <key>]
//
// Resolution order for the license key (mirrors server.js resolveCloudSyncKey):
//   1. PINCUSHION_LICENSE_KEY env
//   2. --license-key <key> arg
//   3. ~/.pincushion/license-key file
//
// Base URL for functions (mirrors SUPABASE_BASE in server.js):
//   PINCUSHION_SYNC_URL env (strips /sync-annotations) or the hardcoded default.

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { resolve } from 'path';
import readline from 'readline';

import { validateMobileRepoProof, decideClaimPath, injectMetaTag } from './lib/ownership.mjs';
import {
  writeEditorMcpConfig, getEditorChoice, normalizeEditorChoice, editorManualCommand,
} from './lib/setup-core.js';
import { recordDeveloperSetupIntent } from './login.mjs';

const DEFAULT_SYNC_URL = 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1/sync-annotations';

function functionsBase() {
  const syncUrl = process.env.PINCUSHION_SYNC_URL || DEFAULT_SYNC_URL;
  return syncUrl.replace(/\/sync-annotations$/, '');
}

function argValue(argv, flag) {
  const idx = argv.indexOf(flag);
  return idx !== -1 ? argv[idx + 1] : null;
}

function claimToken(argv) {
  const valueFlags = new Set(['--project-dir', '--license-key', '--editor']);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = String(argv[index] || '');
    if (valueFlags.has(arg)) { index += 1; continue; }
    if (arg.startsWith('--project-dir=') || arg.startsWith('--license-key=') || arg.startsWith('--editor=')) continue;
    if (!arg.startsWith('--')) return arg;
  }
  return null;
}

function editorArg(argv) {
  const inline = argv.find((arg) => String(arg || '').startsWith('--editor='));
  return inline ? String(inline).slice('--editor='.length) : argValue(argv, '--editor');
}

const ask = (rl, question) => new Promise((resolve) => rl.question(question, (answer) => resolve((answer || '').trim())));

// A report claim can configure an editor only after the developer makes an
// explicit choice. Non-interactive uses pass --editor; an interactive claim
// can choose at the terminal. Empty/cancelled input stays configuration-free.
export async function selectClaimEditor(argv = [], deps = {}) {
  const explicit = editorArg(argv);
  if (explicit !== null && explicit !== undefined) return normalizeEditorChoice(explicit);
  if (typeof deps.selectEditor === 'function') return normalizeEditorChoice(await deps.selectEditor());
  const isInteractive = deps.isInteractive ?? !!(process.stdout.isTTY && process.stdin.isTTY);
  if (!isInteractive) return null;
  const input = deps.input || process.stdin;
  const output = deps.output || process.stdout;
  const rl = readline.createInterface({ input, output });
  try {
    output.write('Choose an editor for the claimed project: cursor, vscode, claude, codex, manual, or Enter to skip.\n');
    return normalizeEditorChoice(await ask(rl, 'Editor: '));
  } finally {
    rl.close();
  }
}

function readKeyFile(p) {
  try { const v = readFileSync(p, 'utf8').trim(); return v || null; } catch { return null; }
}

function resolveLicenseKey(argv) {
  if (process.env.PINCUSHION_LICENSE_KEY) return process.env.PINCUSHION_LICENSE_KEY.trim();
  const fromArg = argValue(argv, '--license-key');
  if (fromArg) return fromArg.trim();
  return readKeyFile(join(homedir(), '.pincushion', 'license-key'));
}

// The sign-in gate, inlined. Returns a license key or null. Injectable so tests
// drive it without a browser: runLogin defaults to login.mjs's flow (opens the
// browser, writes ~/.pincushion/license-key), resolveKey re-reads after it.
// Non-interactive callers (agents, CI) fail FAST with the old message — the
// inline login opens a browser + blocks up to 5 minutes, which is a hang, not
// help, in a headless environment.
export async function ensureLoggedIn(argv, deps = {}) {
  const resolveKey = deps.resolveKey || (() => resolveLicenseKey(argv));
  const runLogin = deps.runLogin || (async () => {
    const { runLogin } = await import('./login.mjs');
    await runLogin({ developerSetupIntent: true, developerSetupSource: 'claim' });
  });
  const isInteractive = deps.isInteractive ?? !!(process.stdout.isTTY && process.stdin.isTTY);
  const existing = resolveKey();
  if (existing) return existing;
  if (!isInteractive) {
    console.log('Not signed in. Run `npx pincushion-mcp login` first, or pass --license-key <key>.');
    return null;
  }
  console.log('Signing you in first — opening your browser…');
  await runLogin({ developerSetupIntent: true, developerSetupSource: 'claim' });
  return resolveKey();
}

// Claiming proves report ownership with Pincushion; it cannot (and must not)
// authenticate a person into the app being captured. Keep the handoff explicit
// so owners know how authenticated screens reach the report's private workspace.
export function claimCaptureGuidance(projectUrl) {
  const targetApp = projectUrl ? `\`${projectUrl}\`` : 'your app';
  return [
    '  Optional: save a signed-in product experience to this report when you want to capture it:',
    '  1. When you open the report, sign in to Pincushion with this account if prompted. That unlocks private Grid and Flow captures.',
    `  2. In a normal, top-level browser tab, sign in to ${targetApp} with the account you use there.`,
    '  3. Open Pincushion on each screen and use its capture action. Saved frames appear in this report’s private Grid and Flow.',
    '  Claiming does not sign you in to your app. Your app credentials never leave your browser.',
  ].join('\n');
}

const CLAIM_BINDING_STATES = new Set(['active', 'missing', 'pending', 'provisioning', 'replacement_pending', 'revoked', 'failed', 'unknown']);
const CLAIM_RECEIPT_STATES = new Set(['pending', 'accepted', 'missing', 'unknown']);
const CLAIM_RECONCILIATION_STATES = new Set(['pending', 'reconciled', 'current', 'failed', 'unknown']);
const CLAIM_FRAME_STATES = new Set(['pending', 'queued', 'running', 'current', 'failed', 'unknown']);
const CLAIM_QUEUE_STATES = new Set(['pending', 'queued', 'empty', 'current', 'failed', 'unknown']);
const CLAIM_CRIT_STATES = new Set(['not_requested', 'pending', 'queued', 'running', 'completed', 'failed', 'unknown']);

function claimObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function claimStatus(value, allowed, fallback = 'unknown') {
  const source = typeof value === 'string' ? { state: value } : claimObject(value);
  const state = typeof (source.state ?? source.status) === 'string'
    ? String(source.state ?? source.status).trim().toLowerCase()
    : '';
  return { state: allowed.has(state) ? state : fallback };
}

function claimPart(source, keys) {
  for (const key of keys) {
    const candidate = source?.[key];
    if (typeof candidate === 'string' || (candidate && typeof candidate === 'object' && !Array.isArray(candidate))) {
      return candidate;
    }
  }
  return {};
}

/**
 * Compact, secret-free read model used after a successful ownership claim.
 * A claim is never treated as evidence that a provider binding, production
 * receipt, fresh frame, or external Crit has completed.
 */
export function redactClaimDeploymentDiagnostic(value = {}) {
  const source = claimObject(claimObject(value).data || value);
  const frame = claimObject(claimPart(source, ['frameRefresh', 'frame_refresh', 'freshFrames', 'fresh_frames']));
  const critique = source.autoCritique === false || source.auto_critique === false
    ? { state: 'not_requested' }
    : claimStatus(claimPart(source, ['critique']), CLAIM_CRIT_STATES);
  const externalEvidenceValue = claimPart(source, ['externalCritEvidence', 'external_crit_evidence']);
  const hasExternalEvidence = typeof externalEvidenceValue === 'string' || Object.keys(claimObject(externalEvidenceValue)).length > 0;
  const externalCritEvidence = !hasExternalEvidence &&
    (source.autoCritique === false || source.auto_critique === false)
    ? { state: 'not_requested' }
    : claimStatus(externalEvidenceValue, CLAIM_CRIT_STATES);
  return {
    binding: claimStatus(claimPart(source, ['binding', 'providerBinding', 'provider_binding']), CLAIM_BINDING_STATES),
    firstAcceptedReceipt: claimStatus(claimPart(source, ['firstAcceptedReceipt', 'first_accepted_receipt', 'firstProductionReceipt']), CLAIM_RECEIPT_STATES),
    reconciliation: claimStatus(claimPart(source, ['reconciliation', 'deploymentReconciliation', 'deployment_reconciliation']), CLAIM_RECONCILIATION_STATES),
    frameRefresh: {
      desktop: claimStatus(frame.desktop ?? frame.desktopFrame ?? source.desktopFrame, CLAIM_FRAME_STATES),
      mobile: claimStatus(frame.mobile ?? frame.mobileFrame ?? source.mobileFrame, CLAIM_FRAME_STATES),
      run: claimStatus(frame.run ?? frame.captureRun ?? source.captureRun, CLAIM_FRAME_STATES),
    },
    queue: claimStatus(claimPart(source, ['queue', 'critiqueQueue', 'critique_queue']), CLAIM_QUEUE_STATES),
    critique,
    externalCritEvidence,
  };
}

export function claimDeploymentWarning(diagnostic = {}) {
  const status = redactClaimDeploymentDiagnostic(diagnostic);
  const receipt = status.firstAcceptedReceipt.state === 'accepted'
    ? 'A first accepted production receipt is recorded, but reconciliation and fresh-frame evidence remain separate checks.'
    : 'The first accepted production receipt is still pending.';
  return [
    'Ownership claim succeeded. It does not prove deployment automation, a production receipt, fresh frames, queue completion, or an external Crit.',
    receipt,
    'Use get_deployment_reconciliation_status to inspect those independent states before representing the deployment as ready.',
  ].join(' ');
}

/**
 * Call only the read-only, provider-neutral status action after a claim. The
 * projection deliberately omits provider IDs, endpoint material, credentials,
 * raw evidence, and error bodies before it reaches CLI output.
 */
export async function readClaimDeploymentDiagnostic({
  projectId,
  licenseKey,
  functionsBase: baseOverride,
  fetchImpl = fetch,
} = {}) {
  if (!projectId || !licenseKey) return redactClaimDeploymentDiagnostic({});
  const base = typeof baseOverride === 'string' && baseOverride.trim() ? baseOverride.replace(/\/$/, '') : functionsBase();
  try {
    const response = await fetchImpl(
      `${base}/sync-annotations?deployment_reconciliation_status=1&project_id=${encodeURIComponent(projectId)}`,
      { headers: { 'x-license-key': licenseKey } },
    );
    if (!response?.ok) return redactClaimDeploymentDiagnostic({});
    return redactClaimDeploymentDiagnostic(await response.json().catch(() => ({})));
  } catch {
    return redactClaimDeploymentDiagnostic({});
  }
}

// A report token is only a capability to inspect or initially claim a public
// report. Once a report has been claimed, it must never become a substitute
// for the signed-in developer's project authorization. This read checks the
// exact project identity returned by the preview before allowing the `claim`
// command to resume its local editor-connection step.
export async function readClaimResumeAuthorization({
  projectId,
  licenseKey,
  functionsBase: baseOverride,
  fetchImpl = fetch,
} = {}) {
  const exactProjectId = typeof projectId === 'string' ? projectId.trim() : '';
  const activeLicenseKey = typeof licenseKey === 'string' ? licenseKey.trim() : '';
  if (!exactProjectId || !activeLicenseKey) return { authorized: false, reason: 'missing_identity' };

  const base = typeof baseOverride === 'string' && baseOverride.trim()
    ? baseOverride.replace(/\/$/, '')
    : functionsBase();
  try {
    const response = await fetchImpl(
      `${base}/onboarding-status?project_id=${encodeURIComponent(exactProjectId)}`,
      { method: 'GET', headers: { 'x-license-key': activeLicenseKey } },
    );
    if (!response?.ok) return { authorized: false, reason: 'unavailable' };
    const status = await response.json().catch(() => null);
    const authorized = status?.success === true &&
      status?.project_id === exactProjectId &&
      status?.roles?.developer === true &&
      status?.milestones?.project_access === true;
    return { authorized, reason: authorized ? 'authorized' : 'denied' };
  } catch {
    return { authorized: false, reason: 'unavailable' };
  }
}

// A dir counts as a project only when it carries a project marker. Without this
// gate, claim run from ~ or ~/Downloads would write editor MCP config into
// non-project dirs — and $HOME is the worst case: ~/.cursor exists on any
// machine with Cursor installed, so detectEditor says "cursor" and the write
// would land in ~/.cursor/mcp.json, Cursor's GLOBAL config (with a cwd-relative
// --project-dir, no less). Markers, not detectEditor, decide whether to write.
export function looksLikeProjectDir(dir, deps = {}) {
  const exists = deps.exists || existsSync;
  return ['.git', 'package.json', '.feedback', 'pyproject.toml', 'go.mod', 'Cargo.toml']
    .some((m) => exists(join(dir, m)));
}

// After a successful claim, write a project-local MCP config only when the
// developer explicitly selected a supported editor. A claim proves report
// ownership; it does not prove an agent is connected, and it must never guess
// Claude Code for an unsupported editor.
export function registerEditorForOngoingUse(projectDir, deps = {}) {
  const writeConfig = deps.writeConfig || writeEditorMcpConfig;
  const isProject = deps.isProject || looksLikeProjectDir;
  const editor = normalizeEditorChoice(deps.editor);
  try {
    if (!isProject(projectDir)) return null; // never write config outside a real project
    if (!editor) return null;
    return writeConfig({ editor, cwd: projectDir, projectId: deps.projectId });
  } catch { return null; }
}

const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the tag-claim endpoint until the tag is detected live or attempts are exhausted.
 *
 * @param {object} opts
 * @param {() => Promise<object>} opts.post   — calls POST claim-report{proof:'tag'}, returns parsed JSON
 * @param {number} [opts.attempts=18]          — max iterations (~3 min at 10 s each)
 * @param {number} [opts.delayMs=10000]        — ms to wait between attempts
 * @param {(ms:number)=>Promise<void>} [opts.sleep] — injectable sleep (tests pass a no-op)
 * @returns {Promise<{claimed:boolean, result?:object}>} Includes quota denial in result.
 */
export async function pollTagClaim({ post, attempts = 18, delayMs = 10000, sleep = defaultSleep }) {
  for (let i = 0; i < attempts; i++) {
    let res;
    try {
      res = await post();
    } catch {
      // treat a network error as "not yet"
      await sleep(delayMs);
      continue;
    }
    if (res && res.success === true) {
      return { claimed: true, result: res };
    }
    if (res?.error === 'free_project_limit') {
      return { claimed: false, result: res };
    }
    // res.ok === false (tag_not_found / unreachable) → wait and retry
    await sleep(delayMs);
  }
  return { claimed: false };
}

// Exported so tests can drive it without touching process.argv. Dependency
// seams keep successful-claim diagnostics read-only in tests as well.
export async function runClaim(argv = [], deps = {}) {
  // Parse: first non-flag, non-value arg is the token.
  const wait = argv.includes('--wait');
  const token = claimToken(argv);
  const projectDirRaw = argValue(argv, '--project-dir');
  const projectDir = resolve(projectDirRaw || process.cwd());

  if (!token) {
    console.log('Usage: npx pincushion-mcp claim <report-token> [--project-dir <dir>] [--editor cursor|vscode|claude|codex|manual]');
    return 1;
  }

  const licenseKey = await (deps.ensureLoggedIn || ensureLoggedIn)(argv);
  if (!licenseKey) {
    console.log("Sign-in didn't complete. Run `npx pincushion-mcp login` and retry.");
    return 1;
  }

  const BASE = typeof deps.functionsBase === 'string' ? deps.functionsBase : functionsBase();
  const fetchImpl = deps.fetchImpl || fetch;
  try {
    await (deps.recordDeveloperSetupIntent || recordDeveloperSetupIntent)({
      licenseKey,
      developerSetupIntent: true,
      developerSetupSource: 'claim',
      functionsBase: BASE,
      fetchImpl,
    });
  } catch { /* ownership claim remains available if this acknowledgement is unavailable */ }

  const connectEditor = (selectedEditor) => {
    const choice = getEditorChoice(selectedEditor);
    if (!choice) {
      console.log('  No editor was selected, so no config was written. Claim ownership and agent connection are separate.');
      console.log('  Configure your chosen MCP client with `npx pincushion-mcp --project-dir .`, then restart it.');
      console.log('  Agent connection is not yet verified; an exact real pin read is pending.');
      return;
    }

    const reg = registerEditorForOngoingUse(projectDir, {
      editor: selectedEditor,
      projectId,
      ...(typeof deps.writeEditorMcpConfig === 'function' ? { writeConfig: deps.writeEditorMcpConfig } : {}),
    });
    if (reg && (reg.action === 'created' || reg.action === 'updated')) {
      console.log(`  Config written: ${reg.path}. Restart ${choice.label} before it can load Pincushion.`);
    } else if (reg && reg.action === 'already') {
      console.log(`  Config already present: ${reg.path}. Restart ${choice.label} if it has not loaded Pincushion yet.`);
    } else if (reg && reg.action === 'manual') {
      console.log(`  No config was written for ${choice.label}. Run this from your project directory:`);
      console.log(`  ${editorManualCommand(selectedEditor)}`);
    } else {
      console.log(`  ${choice.label} config was left unchanged. Configure it manually with:`);
      console.log(`  ${editorManualCommand(selectedEditor)}`);
    }
    console.log('  Agent connection is not yet verified; an exact real pin read is pending.');
    console.log('  After restart, ask the agent to call get_actionable_pins. Review an existing AI or human finding, approve that exact pin, then ask it to implement it.');
  };

  // 1. Preview the report — confirm it exists and identify the exact project.
  let projectId, projectUrl, claimable, claimed, overridable;
  const reportDeploymentWarning = async () => {
    const diagnostic = await readClaimDeploymentDiagnostic({
      projectId,
      licenseKey,
      functionsBase: BASE,
      fetchImpl,
    });
    const write = typeof deps.write === 'function' ? deps.write : console.log;
    write(claimDeploymentWarning(diagnostic));
  };
  try {
    const res = await fetchImpl(`${BASE}/claim-report?token=${encodeURIComponent(token)}`);
    if (!res.ok) {
      console.log("Couldn't reach Pincushion, try again.");
      return 1;
    }
    ({ project_id: projectId, project_url: projectUrl, claimable, claimed, overridable } = await res.json());
  } catch {
    console.log("Couldn't reach Pincushion, try again.");
    return 1;
  }

  // Only the explicit public claimed state permits an authenticated resume.
  // Unavailable or malformed admission is neither ownership nor a completed claim.
  if (claimable !== true && claimed !== true) {
    console.log('This crit cannot be claimed right now. No ownership or editor configuration was changed.');
    console.log('Keep the report link and retry this command later. If it persists, contact support@pincushion.io.');
    return 1;
  }

  if (claimable !== true) {
    const resumeAuthorization = await (deps.readClaimResumeAuthorization || readClaimResumeAuthorization)({
      projectId,
      licenseKey,
      functionsBase: BASE,
      fetchImpl,
    });
    if (!resumeAuthorization.authorized && overridable === true) {
      // The person who requested the crit holds it. Proving the site with the
      // live tag moves it to the site's owner (claim-report re-checks all of it).
      console.log('This crit was saved by the person who requested it. Proving you own the site with the live tag moves it to your account.');
    } else if (!resumeAuthorization.authorized) {
      console.log('This crit is already claimed. Your signed-in account was not confirmed for this exact project, so no editor configuration was changed.');
      console.log('Open the report and its status with the account that owns or edits it, then retry `npx pincushion-mcp claim <report-token>`.');
      return 0;
    } else {
      const selectedEditor = await selectClaimEditor(argv, deps);
      console.log('This crit is already claimed. Your developer access to its exact project is confirmed; resuming editor connection only.');
      connectEditor(selectedEditor);
      return 0;
    }
  }

  const selectedEditor = await selectClaimEditor(argv, deps);

  // 2. Ownership is proven only by the live tag (owner decision 2026-10-25:
  // tag-only). The claim never reads, requests or sends a Vercel or other
  // provider token; a mobile-wall repo only changes the message.
  const mobileRepoResult = validateMobileRepoProof(projectDir, { projectId, projectUrl });
  const path = decideClaimPath({ mobileRepoResult });

  if (path === 'mobile_repo') {
    // A repo on disk can't be verified by the server; ownership is confirmed
    // with the live tag below.
    console.log('Found this crit wall in your repo. Pincushion confirms ownership with a tag on your live page.');
  }

  // path === 'tag': inject or show the meta-tag snippet.
  const r = injectMetaTag(projectDir, projectId);
  if (r.injected) {
    console.log(`Added the ownership tag to ${r.file}. Deploy, then re-run: npx pincushion-mcp claim ${token}`);
  } else {
    const snippet = r.snippet || `<meta name="pincushion-project" content="${projectId}">`;
    console.log(`Add this to your <head>, deploy, then re-run claim:\n  ${snippet}`);
  }

  if (wait) {
    console.log('Waiting for your deploy… (the tag is added — deploy now)');
    const post = async () => {
      const res = await fetchImpl(`${BASE}/claim-report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, proof: 'tag', license_key: licenseKey }),
      });
      return res.json();
    };
    const { claimed, result } = await pollTagClaim({ post });
    if (result?.error === 'free_project_limit') {
      // Fixed copy and pricing link, as in core.js: never echo a provider URL.
      console.log('Claim failed: the Free plan includes 1 project. Existing projects keep working; the report stays viewable.');
      console.log('Upgrade to Pro for unlimited projects: https://www.pincushion.io/pricing?ref=mcp-claim-limit');
      return 1;
    }
    if (claimed) {
      console.log('✓ Claimed — pins are yours.');
      connectEditor(selectedEditor);
      await reportDeploymentWarning();
      console.log(claimCaptureGuidance(projectUrl));
    } else {
      console.log(`Didn't detect the tag live yet — deploy, then re-run: npx pincushion-mcp claim ${token}`);
    }
    return 0;
  }

  return 0;
}
