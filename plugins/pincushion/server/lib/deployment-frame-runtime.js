// Concrete, fail-closed local runtime for deployment frame refreshes.
//
// The orchestration state machine lives in deployment-frame-executor.js. This
// module owns only the narrow MCP/core adapters, task-owned temporary state, and
// one bounded capture-snapshot child at a time. Opaque capture proof never
// crosses the executor's authenticated write closures into this process seam.

import { spawn as nodeSpawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDeploymentFrameExecutor } from './deployment-frame-executor.js';

const DEFAULT_INTERVAL_MS = 30_000;
const DEFAULT_CHILD_TIMEOUT_MS = 8 * 60_000;
const MAX_CHILD_TIMEOUT_MS = 14 * 60_000;
const MAX_CAPTURE_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_PAGE_URLS = 64;
const CAPTURE_SCRIPT = fileURLToPath(new URL('../scripts/capture-snapshot.mjs', import.meta.url));
const CHILD_ENV_ALLOWLIST = Object.freeze([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'TZ',
  'SystemRoot', 'WINDIR', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'PINCUSHION_CHROMIUM', 'CHROME_PATH', 'PUPPETEER_EXECUTABLE_PATH',
]);

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function fixedError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function boundedInterval(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1_000 && number <= 5 * 60_000
    ? Math.floor(number)
    : DEFAULT_INTERVAL_MS;
}

function boundedChildTimeout(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 1 && number <= MAX_CHILD_TIMEOUT_MS
    ? Math.floor(number)
    : DEFAULT_CHILD_TIMEOUT_MS;
}

function normalizeAuth(auth) {
  if (!auth || auth.mode === 'anonymous') return { mode: 'anonymous' };
  if (!isObject(auth) || auth.mode !== 'authenticated' || !isObject(auth.descriptor)) {
    throw new TypeError('deployment_frame_runtime_auth_invalid');
  }
  const descriptorKeys = Object.keys(auth.descriptor);
  const storageStatePath = text(auth.descriptor.storageStatePath);
  if (!storageStatePath || descriptorKeys.length !== 1 || descriptorKeys[0] !== 'storageStatePath') {
    throw new TypeError('deployment_frame_runtime_auth_invalid');
  }
  return { mode: 'authenticated', descriptor: { storageStatePath } };
}

function captureChildEnv(runtimeEnv, auth) {
  const source = isObject(runtimeEnv) ? runtimeEnv : {};
  const env = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (typeof source[key] === 'string' && source[key]) env[key] = source[key];
  }
  env.PINCUSHION_CAPTURE_NO_INSTALL = '1';
  if (auth.mode === 'authenticated') {
    env.PINCUSHION_STORAGE_STATE = auth.descriptor.storageStatePath;
    env.PINCUSHION_CAPTURE_AUTH_REQUIRED = '1';
  }
  return env;
}

function exactPageUrls(values) {
  if (!Array.isArray(values) || values.length < 1 || values.length > MAX_PAGE_URLS) {
    throw fixedError('deployment_frame_capture_scope_invalid');
  }
  const normalized = values.map((value) => text(value));
  let origin = null;
  const seen = new Set();
  for (const value of normalized) {
    let parsed;
    try { parsed = new URL(value); } catch { throw fixedError('deployment_frame_capture_scope_invalid'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password
        || seen.has(value) || (origin && parsed.origin !== origin)) {
      throw fixedError('deployment_frame_capture_scope_invalid');
    }
    origin ||= parsed.origin;
    seen.add(value);
  }
  return normalized;
}

function containsProofKey(value, state = { nodes: 0 }, depth = 0) {
  if (depth > 8 || state.nodes > 2_048) return true;
  if (!value || typeof value !== 'object') return false;
  state.nodes += 1;
  const entries = Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry])
    : Object.entries(value);
  for (const [key, entry] of entries) {
    if (/proof/i.test(key)) return true;
    if (entry && typeof entry === 'object' && containsProofKey(entry, state, depth + 1)) return true;
  }
  return false;
}

function pendingState(row) {
  return text(row?.frameRefresh?.state || row?.frame_refresh?.state).toLowerCase();
}

function pendingProjectId(row) {
  return text(row?.projectId || row?.project_id);
}

function resultProjectScoped(result, projectId) {
  if (!isObject(result) || !Array.isArray(result.pending)) return result;
  return {
    ...result,
    pending: result.pending.filter((row) => (
      pendingProjectId(row) === projectId && pendingState(row) === 'pending'
    )),
  };
}

export function deploymentFrameRuntimeStartDecision({
  optIn,
  syncServerUrl,
  licenseKey,
  projectId,
  auth,
} = {}) {
  if (String(optIn || '').trim() !== '1') return { start: false, reason: 'disabled' };
  if (!syncServerUrl || !licenseKey) return { start: false, reason: 'authoritative_sync_unavailable' };
  if (!projectId) return { start: false, reason: 'project_scope_not_exact' };
  if (!auth) return { start: false, reason: 'capture_auth_invalid' };
  return { start: true };
}

export function createDeploymentFrameRuntime({
  projectId,
  coreConfig,
  coreApi,
  uploadPageSnapshot,
  auth = { mode: 'anonymous' },
  runtimeEnv = process.env,
  spawnProcess = nodeSpawn,
  processExecPath = process.execPath,
  captureScriptPath = CAPTURE_SCRIPT,
  childTimeoutMs = DEFAULT_CHILD_TIMEOUT_MS,
  terminationGraceMs = 1_000,
  intervalMs = DEFAULT_INTERVAL_MS,
  makeTempDirectory = () => mkdtemp(join(tmpdir(), 'pincushion-deployment-frame-')),
  removeTempDirectory = (path) => rm(path, { recursive: true, force: false }),
  logger = console,
} = {}) {
  const exactProjectId = text(projectId);
  if (!exactProjectId || !isObject(coreApi) || typeof uploadPageSnapshot !== 'function'
      || typeof spawnProcess !== 'function') {
    throw new TypeError('deployment_frame_runtime_dependencies_invalid');
  }
  const captureAuth = normalizeAuth(auth);
  const timeoutMs = boundedChildTimeout(childTimeoutMs);
  const killGraceMs = Number.isFinite(Number(terminationGraceMs))
    && Number(terminationGraceMs) >= 1 && Number(terminationGraceMs) <= 5_000
    ? Math.floor(Number(terminationGraceMs)) : 1_000;
  const scheduleIntervalMs = boundedInterval(intervalMs);
  const activeChildren = new Set();
  const childTerminationTimers = new Map();
  const ownedTempDirectories = new Set();
  let stopped = false;
  let started = false;
  let scheduler = null;

  function terminateOwnedChild(child) {
    if (!activeChildren.has(child) || childTerminationTimers.has(child)) return;
    try { child.kill('SIGTERM'); } catch { /* exact task-owned child only */ }
    const timer = setTimeout(() => {
      childTerminationTimers.delete(child);
      if (!activeChildren.has(child)) return;
      try { child.kill('SIGKILL'); } catch { /* exact task-owned child only */ }
    }, killGraceMs);
    childTerminationTimers.set(child, timer);
  }

  function runCaptureChild(args, stdinPayload = '') {
    if (stopped) return Promise.reject(fixedError('deployment_frame_runtime_stopped'));
    return new Promise((resolve, reject) => {
      let child;
      try {
        child = spawnProcess(processExecPath, args, {
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: captureChildEnv(runtimeEnv, captureAuth),
        });
      } catch {
        reject(fixedError('deployment_frame_capture_spawn_failed'));
        return;
      }
      if (!child || !child.stdout || !child.stderr || !child.stdin || typeof child.kill !== 'function') {
        reject(fixedError('deployment_frame_capture_spawn_failed'));
        return;
      }

      activeChildren.add(child);
      let stdout = '';
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let terminalCode = null;
      let settled = false;

      const requestTermination = (code) => {
        terminalCode ||= code;
        terminateOwnedChild(child);
      };
      const timeout = setTimeout(() => requestTermination('deployment_frame_capture_timeout'), timeoutMs);

      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        const killTimer = childTerminationTimers.get(child);
        if (killTimer) clearTimeout(killTimer);
        childTerminationTimers.delete(child);
        activeChildren.delete(child);
        if (error) reject(error);
        else resolve(value);
      };

      child.stdout.on('data', (chunk) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        stdoutBytes += buffer.length;
        if (stdoutBytes > MAX_CAPTURE_OUTPUT_BYTES) {
          requestTermination('deployment_frame_capture_output_too_large');
          return;
        }
        stdout += buffer.toString('utf8');
      });
      child.stderr.on('data', (chunk) => {
        stderrBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
        if (stderrBytes > MAX_CAPTURE_OUTPUT_BYTES) {
          requestTermination('deployment_frame_capture_output_too_large');
        }
      });
      child.once('error', () => finish(fixedError('deployment_frame_capture_spawn_failed')));
      child.once('close', (code, signal) => {
        if (terminalCode) {
          finish(fixedError(terminalCode));
          return;
        }
        if (code !== 0 || signal) {
          finish(fixedError('deployment_frame_capture_failed'));
          return;
        }
        let parsed;
        try { parsed = JSON.parse(stdout); } catch {
          finish(fixedError('deployment_frame_capture_output_invalid'));
          return;
        }
        if (!isObject(parsed)) {
          finish(fixedError('deployment_frame_capture_output_invalid'));
          return;
        }
        finish(null, parsed);
      });
      child.stdin.once('error', () => requestTermination('deployment_frame_capture_input_failed'));
      try { child.stdin.end(stdinPayload); } catch {
        requestTermination('deployment_frame_capture_input_failed');
      }
    });
  }

  async function capture(request = {}) {
    if (!isObject(request) || containsProofKey(request)) {
      throw fixedError('deployment_frame_capture_request_invalid');
    }
    const pageUrls = exactPageUrls(request.pageUrls);
    const tempDirectory = text(request.tempDir);
    if (!tempDirectory) throw fixedError('deployment_frame_capture_request_invalid');
    const requireAuthArg = captureAuth.mode === 'authenticated' ? ['--require-auth'] : [];

    if (request.phase === 'discover') {
      return runCaptureChild([
        captureScriptPath,
        '--probe', '--discover',
        pageUrls[0], join(tempDirectory, 'discovery-probe.jpg'),
        `--inventory=${JSON.stringify(pageUrls)}`,
        `--discovery-max-pages=${MAX_PAGE_URLS}`,
        ...requireAuthArg,
      ]);
    }
    if (request.phase !== 'fresh' || !text(request.captureRunId)
        || !isObject(request.previousReceipts)) {
      throw fixedError('deployment_frame_capture_request_invalid');
    }
    const previousKeys = Object.keys(request.previousReceipts);
    if (previousKeys.length !== pageUrls.length
        || previousKeys.some((key) => !pageUrls.includes(key))) {
      throw fixedError('deployment_frame_capture_request_invalid');
    }
    return runCaptureChild([
      captureScriptPath,
      '--reconcile', pageUrls[0], tempDirectory,
      '--exact-inventory-stdin',
      `--capture-run-id=${text(request.captureRunId)}`,
      ...requireAuthArg,
    ], JSON.stringify({ pageUrls, previousReceipts: request.previousReceipts }));
  }

  async function makeOwnedTempDirectory() {
    const path = text(await makeTempDirectory());
    if (!path || ownedTempDirectories.has(path)) throw fixedError('deployment_frame_temp_invalid');
    ownedTempDirectories.add(path);
    return path;
  }

  async function removeOwnedTempDirectory(path) {
    if (!ownedTempDirectories.delete(path)) throw fixedError('deployment_frame_temp_not_owned');
    await removeTempDirectory(path);
  }

  const executor = createDeploymentFrameExecutor({
    auth: captureAuth,
    logger,
    listPending: async () => {
      const result = await coreApi.toolGetPendingDeploymentFrameRefreshes(
        coreConfig,
        { projectId: exactProjectId },
      );
      return resultProjectScoped(result, exactProjectId);
    },
    registerPages: (request) => coreApi.toolRegisterDeploymentDiscoveredPages(coreConfig, request),
    // The executor owns the private baseline opt-in; this adapter passes its
    // exact request through so the runtime cannot silently broaden core output.
    startRun: (request) => coreApi.toolStartDeploymentCaptureRun(coreConfig, request),
    capture,
    upload: (request) => uploadPageSnapshot(request),
    recordPage: (request) => coreApi.toolRecordDeploymentPageResult(coreConfig, request),
    completeRun: (request) => coreApi.toolCompleteDeploymentCaptureRun(coreConfig, request),
    makeTempDir: makeOwnedTempDirectory,
    removeTempDir: removeOwnedTempDirectory,
  });

  async function start() {
    if (started || stopped) return { started: false, stop };
    started = true;
    const initial = await executor.runOnce();
    if (!stopped) scheduler = executor.startScheduler({ intervalMs: scheduleIntervalMs });
    return { started: !stopped, initial, stop };
  }

  function stop() {
    if (stopped) return;
    stopped = true;
    scheduler?.stop?.();
    executor.stop();
    for (const child of [...activeChildren]) {
      terminateOwnedChild(child);
    }
  }

  return Object.freeze({ capture, runOnce: executor.runOnce, start, stop });
}

export const DEPLOYMENT_FRAME_RUNTIME_LIMITS = Object.freeze({
  childTimeoutMs: DEFAULT_CHILD_TIMEOUT_MS,
  maxChildTimeoutMs: MAX_CHILD_TIMEOUT_MS,
  maxOutputBytes: MAX_CAPTURE_OUTPUT_BYTES,
  maxPageUrls: MAX_PAGE_URLS,
  intervalMs: DEFAULT_INTERVAL_MS,
});
