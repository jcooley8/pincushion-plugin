// Bounded, receipt-first executor for deployment frame refreshes.
//
// This module intentionally owns orchestration only.  Every filesystem,
// browser, and provider operation is injected so the executor can be tested
// without a network, database, or Critique implementation.  Capture proof is
// kept in a function-local closure and is never passed to capture or logging.

import { normalizeCaptureFingerprint } from './deployment-reconciliation.js';

const MAX_PENDING_JOBS = 4;
const MAX_DISCOVERED_PAGES = 64;
const DEFAULT_INTERVAL_MS = 30_000;
const DEVICES = Object.freeze({
  desktop: Object.freeze({ width: 1280, height: 900 }),
  mobile: Object.freeze({ width: 390, height: 844 }),
});
const FRESH_OUTCOMES = new Set(['added', 'changed', 'unchanged']);
const BAD_STATES = new Set([
  'error', 'failed', 'expired', 'inaccessible', 'unknown', 'partial',
  'ambiguous', 'uncertain', 'timeout',
]);
const HASH_PATTERN = /^[0-9a-f]{64}$/i;

const CODE = Object.freeze({
  INVALID_DEPENDENCIES: 'invalid_dependencies',
  INVALID_AUTH: 'invalid_auth',
  LIST_FAILED: 'list_pending_failed',
  JOB_INVALID: 'pending_job_invalid',
  ORIGIN_MISMATCH: 'origin_mismatch',
  DISCOVERY_FAILED: 'discovery_failed',
  DISCOVERY_INVALID: 'discovery_invalid',
  REGISTRATION_FAILED: 'registration_failed',
  RUN_FAILED: 'capture_run_failed',
  FRESH_CAPTURE_FAILED: 'fresh_capture_failed',
  PAGE_INVALID: 'page_capture_invalid',
  UPLOAD_FAILED: 'upload_failed',
  RECORD_FAILED: 'record_failed',
  COMPLETE_FAILED: 'complete_failed',
  TEMP_FAILED: 'temp_directory_failed',
  CLEANUP_FAILED: 'temp_cleanup_failed',
  SCHEDULER_FAILED: 'scheduler_run_failed',
});

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function resultFailed(value) {
  if (!value || typeof value !== 'object') return true;
  if (value.success === false || value.ok === false || value.error || value.errors
      || value.ambiguous === true || value.uncertain === true || value.retryable === true) return true;
  const state = text(value.state || value.status || value.phase).toLowerCase();
  return BAD_STATES.has(state);
}

function resultConfirmed(value) {
  if (!value || typeof value !== 'object' || resultFailed(value)) return false;
  const state = text(value.state || value.status).toLowerCase();
  return value.success === true
    || value.ok === true
    || value.recorded === true
    || value.accepted === true
    || value.completed === true
    || value.idempotent === true
    || value.alreadyRecorded === true
    || value.already_recorded === true
    || state === 'completed'
    || state === 'recorded'
    || state === 'accepted';
}

function urlOrigin(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function validUrlList(values) {
  if (!Array.isArray(values) || values.length === 0 || values.length > MAX_DISCOVERED_PAGES) return null;
  const origins = values.map((value) => urlOrigin(value));
  if (origins.some((origin) => !origin) || new Set(origins).size !== 1) return null;
  return values.map((value) => String(value));
}

function pick(value, ...keys) {
  for (const key of keys) {
    if (value && value[key] !== undefined && value[key] !== null) return value[key];
  }
  return undefined;
}

function cloneAuth(auth) {
  // Anonymous is deliberately reduced to the one public mode bit.  This
  // prevents an accidental `requireAuth`, token, or storage path from being
  // smuggled into a public capture request.
  if (auth === undefined || auth === null) return { mode: 'anonymous' };
  if (!isObject(auth)) return null;
  if (auth.mode === 'anonymous') return { mode: 'anonymous' };
  if (auth.mode !== 'authenticated') return null;
  if (auth.descriptor === undefined || auth.descriptor === null) return null;
  // Keep the descriptor private to this executor.  A structured clone is not
  // required here (descriptors may contain provider objects); no value from
  // this object is returned or sent to the logger.
  return { mode: 'authenticated', descriptor: auth.descriptor };
}

function extractPendingRows(value) {
  if (Array.isArray(value)) return value;
  if (!isObject(value)) return [];
  for (const key of ['pending', 'jobs', 'frameRefreshes', 'frame_refreshes', 'requests']) {
    if (Array.isArray(value[key])) return value[key];
  }
  return [];
}

function deploymentIdFor(job) {
  return text(pick(job, 'deploymentId', 'deployment_id'))
    || text(job?.deployment?.id)
    || text(job?.deployment?.deploymentId)
    || '';
}

function projectIdFor(job) {
  return text(pick(job, 'projectId', 'project_id')) || text(job?.project?.id) || '';
}

function pageUrlsFor(job) {
  const values = pick(job, 'pageUrls', 'page_urls');
  if (Array.isArray(values)) return values;
  const pageUrl = pick(job, 'pageUrl', 'page_url', 'url');
  return pageUrl ? [pageUrl] : [];
}

function extractDiscoveredUrls(value) {
  if (!isObject(value)) return [];
  const direct = pick(value, 'discoveredUrls', 'discovered_urls', 'discoveredPageUrls', 'discovered_page_urls', 'pageUrls', 'page_urls', 'urls');
  if (Array.isArray(direct)) return direct.map((entry) => (
    typeof entry === 'string' ? entry : pick(entry, 'pageUrl', 'page_url', 'url')
  ));
  if (Array.isArray(value.pages)) return value.pages.map((entry) => (
    typeof entry === 'string' ? entry : pick(entry, 'pageUrl', 'page_url', 'url')
  ));
  const nestedDiscovery = value.discovery;
  if (isObject(nestedDiscovery) && Array.isArray(nestedDiscovery.pages)) {
    return nestedDiscovery.pages.map((entry) => (
      typeof entry === 'string' ? entry : pick(entry, 'pageUrl', 'page_url', 'url')
    ));
  }
  return [];
}

function acceptedPageRows(value) {
  if (!isObject(value)) return [];
  const rows = pick(value, 'acceptedPendingPages', 'accepted_pending_pages', 'acceptedPages', 'accepted_pages', 'pageResults', 'page_results');
  if (Array.isArray(rows)) {
    return rows.map((row) => (typeof row === 'string' ? { pageUrl: row, status: 'pending' } : row));
  }
  const urls = pick(value, 'acceptedPageUrls', 'accepted_page_urls');
  if (Array.isArray(urls)) return urls.map((pageUrl) => ({ pageUrl, status: 'pending' }));
  return [];
}

function rowUrl(row) {
  return text(pick(row, 'pageUrl', 'page_url', 'url'));
}

function rowState(row) {
  return text(pick(row, 'status', 'state', 'outcome', 'changeKind', 'change_kind')).toLowerCase();
}

function registrationState(row) {
  // Discovery registration establishes page scope only. Its change metadata
  // is provisional/unknown until the fresh capture returns reconciliation.
  return text(pick(row, 'status', 'state')).toLowerCase();
}

function rowOutcome(row) {
  return text(pick(row, 'outcome', 'changeKind', 'change_kind', 'result'))
    || text(row?.reconciliation?.outcome)
    || text(row?.probe?.outcome)
    || text(row?.capture?.outcome)
    || '';
}

function freshPageOutcome(page) {
  return text(page?.reconciliation?.outcome).toLowerCase();
}

function hasOwn(value, key) {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, key);
}

function readAlias(value, camelKey, snakeKey) {
  if (hasOwn(value, camelKey)) return { present: true, value: value[camelKey] };
  if (hasOwn(value, snakeKey)) return { present: true, value: value[snakeKey] };
  return { present: false, value: undefined };
}

function exactUrlSet(actual, expected) {
  if (!Array.isArray(actual) || actual.length !== expected.length) return false;
  const normalized = actual.map((value) => text(value));
  if (normalized.some((value) => !value) || new Set(normalized).size !== normalized.length) return false;
  const expectedSet = new Set(expected);
  return normalized.every((value) => expectedSet.has(value));
}

function normalizeBaselineReceipt(value) {
  if (!isObject(value)) return null;
  const allowed = new Set([
    'versionId', 'version_id', 'capturedAt', 'captured_at',
    'contentHash', 'content_hash', 'captureFingerprint', 'capture_fingerprint',
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) return null;

  const version = readAlias(value, 'versionId', 'version_id');
  const captured = readAlias(value, 'capturedAt', 'captured_at');
  const content = readAlias(value, 'contentHash', 'content_hash');
  const fingerprint = readAlias(value, 'captureFingerprint', 'capture_fingerprint');
  if (version.present && version.value !== null && typeof version.value !== 'string') return null;
  if (captured.present && captured.value !== null && typeof captured.value !== 'string') return null;
  if (content.present && content.value !== null
      && (typeof content.value !== 'string' || !HASH_PATTERN.test(content.value.trim()))) return null;
  if (fingerprint.present && fingerprint.value !== null && !isObject(fingerprint.value)) return null;

  const versionId = text(version.value);
  const capturedAt = text(captured.value);
  const contentHash = text(content.value).toLowerCase();
  let captureFingerprint = null;
  if (fingerprint.present && fingerprint.value && Object.keys(fingerprint.value).length) {
    captureFingerprint = normalizeCaptureFingerprint({ captureFingerprint: fingerprint.value });
    if (!captureFingerprint) return null;
  }
  // A baseline is comparable only when it is a complete immutable receipt.
  // Partial metadata would make an existing page look like a first capture or
  // produce an unverifiable unchanged result.
  if (!versionId || !contentHash || !captureFingerprint || !capturedAt
      || !Number.isFinite(Date.parse(capturedAt))) return null;

  const normalized = {};
  if (versionId) normalized.versionId = versionId;
  if (capturedAt) normalized.capturedAt = capturedAt;
  if (contentHash) normalized.contentHash = contentHash;
  if (captureFingerprint) normalized.captureFingerprint = captureFingerprint;
  return normalized;
}

function normalizeBaselinePage(value) {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  if (!keys.length) return {};
  if (keys.length === 1 && keys[0] === 'missing' && value.missing === true) return {};
  if (keys.length !== 2 || !keys.includes('desktop') || !keys.includes('mobile')) return null;

  const normalized = {};
  for (const device of ['desktop', 'mobile']) {
    if (!hasOwn(value, device)) continue;
    const receipt = normalizeBaselineReceipt(value[device]);
    if (!receipt) return null;
    normalized[device] = receipt;
  }
  return Object.keys(normalized).length ? normalized : null;
}

function normalizePreviousCaptureReceipts(value, expectedPageUrls) {
  if (!isObject(value)) return null;
  const keys = Object.keys(value);
  const expected = new Set(expectedPageUrls);
  if (keys.length !== expected.size || keys.some((key) => !expected.has(key))) return null;
  const normalized = {};
  for (const pageUrl of expectedPageUrls) {
    if (!hasOwn(value, pageUrl)) return null;
    const page = normalizeBaselinePage(value[pageUrl]);
    if (!page) return null;
    normalized[pageUrl] = page;
  }
  return normalized;
}

function extractRun(value, expectedPageUrls) {
  if (!isObject(value) || resultFailed(value)) return null;
  const run = pick(value, 'captureRun', 'capture_run', 'run');
  const runId = text(pick(value, 'captureRunId', 'capture_run_id', 'runId', 'run_id'))
    || text(pick(run, 'id', 'captureRunId', 'capture_run_id'));
  const proof = text(pick(value, 'captureProof', 'capture_proof', 'proof'));
  if (!runId || !proof) return null;
  const runPageUrls = pick(run, 'pageUrls', 'page_urls');
  if (!exactUrlSet(runPageUrls, expectedPageUrls)) return null;
  const baselineField = readAlias(value, 'previousCaptureReceipts', 'previous_capture_receipts');
  const runBaselineField = readAlias(run, 'previousCaptureReceipts', 'previous_capture_receipts');
  const rawBaseline = baselineField.present ? baselineField.value
    : runBaselineField.present ? runBaselineField.value : undefined;
  if (rawBaseline === undefined) return null;
  const previousCaptureReceipts = normalizePreviousCaptureReceipts(rawBaseline, expectedPageUrls);
  if (!previousCaptureReceipts) return null;
  const runState = text(pick(run, 'state', 'status')).toLowerCase();
  if (BAD_STATES.has(runState)) return null;
  const expiresAt = pick(run, 'expiresAt', 'expires_at');
  if (expiresAt) {
    const expires = Date.parse(expiresAt);
    if (!Number.isFinite(expires) || expires <= Date.now()) return null;
  }
  return { runId, proof, previousCaptureReceipts };
}

function pageMap(value) {
  if (!isObject(value) || !Array.isArray(value.pages)) return null;
  const map = new Map();
  for (const page of value.pages) {
    const pageUrl = rowUrl(page);
    if (!pageUrl || map.has(pageUrl)) return null;
    map.set(pageUrl, page);
  }
  return map;
}

function deviceCapture(page, device) {
  const direct = pick(page, device);
  const captures = pick(page, 'captures', 'screenshots', 'devices');
  const candidate = direct !== undefined ? direct : pick(captures, device);
  return isObject(candidate) ? candidate : null;
}

function normalizeCapture(page, device) {
  const candidate = deviceCapture(page, device);
  if (!candidate) return null;
  const candidateState = rowState(candidate);
  const candidateOutcome = rowOutcome(candidate);
  if (BAD_STATES.has(candidateState) || BAD_STATES.has(candidateOutcome)) return null;
  const viewport = DEVICES[device];
  const filePath = text(pick(candidate, 'filePath', 'file_path', 'imagePath', 'image_path', 'path', 'file'));
  const width = Number(pick(candidate, 'width', 'viewportWidth', 'viewport_width'));
  const height = Number(pick(candidate, 'height', 'viewportHeight', 'viewport_height'));
  const captureContext = pick(candidate, 'captureContext', 'capture_context')
    || pick(receiptFor(candidate), 'captureContext', 'capture_context');
  const viewportWidth = Number(pick(candidate, 'cssWidth', 'css_width', 'viewportWidth', 'viewport_width'))
    || Number(pick(captureContext, 'cssWidth', 'css_width', 'width'))
    || width;
  const viewportHeight = Number(pick(candidate, 'cssHeight', 'css_height', 'viewportHeight', 'viewport_height'))
    || Number(pick(captureContext, 'cssHeight', 'css_height', 'height'))
    || height;
  // capture-snapshot emits the receipt fields inline beside imagePath; test
  // adapters may wrap them under `receipt`. Preserve either representation.
  const receipt = receiptFor(candidate);
  const inlineHash = text(pick(candidate, 'contentHash', 'content_hash', 'imageContentHash', 'image_content_hash', 'hash'));
  const receiptHash = text(pick(receipt, 'contentHash', 'content_hash', 'imageContentHash', 'image_content_hash', 'hash'));
  if (inlineHash && receiptHash && inlineHash.toLowerCase() !== receiptHash.toLowerCase()) return null;
  const captureHash = inlineHash || receiptHash;
  if (!filePath || !Number.isInteger(width) || width < 1
      || !Number.isInteger(height) || height < 1
      || viewportWidth !== viewport.width || viewportHeight !== viewport.height
      || !isObject(receipt) || !captureHash || !HASH_PATTERN.test(captureHash)) return null;
  return {
    filePath,
    width,
    height,
    receipt,
    contentHash: captureHash.toLowerCase(),
    captureContext,
    captureFingerprint: pick(candidate, 'captureFingerprint', 'capture_fingerprint')
      || pick(receipt, 'captureFingerprint', 'capture_fingerprint'),
  };
}

function receiptFor(candidate) {
  return pick(candidate, 'receipt', 'captureReceipt', 'capture_receipt', 'renderReceipt', 'render_receipt') || candidate;
}

function uploadedReceipt(value) {
  if (!isObject(value) || resultFailed(value)) return null;
  const version = pick(value, 'version', 'capture', 'receipt', 'snapshot');
  const versionId = text(pick(value, 'versionId', 'version_id', 'captureVersionId', 'capture_version_id', 'id'))
    || text(pick(version, 'versionId', 'version_id', 'id'));
  const contentHash = text(pick(value, 'contentHash', 'content_hash', 'hash'))
    || text(pick(version, 'contentHash', 'content_hash', 'hash'));
  if (!versionId || !contentHash || !HASH_PATTERN.test(contentHash)) return null;
  return { versionId, contentHash: contentHash.toLowerCase() };
}

function safeLog(logger, level, code) {
  const method = logger && typeof logger[level] === 'function' ? logger[level] : null;
  if (!method) return;
  try {
    // Fixed code only: never pass an exception, response, URL, ID, path,
    // proof, or hash to an injected logger.
    method.call(logger, code);
  } catch {
    // Logging must not turn a bounded executor result into an unbounded error.
  }
}

function emptyResult(state = 'idle') {
  return { state, jobs: 0, pages: 0, uploads: 0 };
}

export function createDeploymentFrameExecutor(deps = {}) {
  const required = [
    'listPending', 'registerPages', 'startRun', 'capture', 'upload',
    'recordPage', 'completeRun', 'makeTempDir', 'removeTempDir',
  ];
  if (!isObject(deps) || required.some((name) => typeof deps[name] !== 'function')) {
    throw new TypeError(CODE.INVALID_DEPENDENCIES);
  }
  const auth = cloneAuth(deps.auth);
  if (!auth) throw new TypeError(CODE.INVALID_AUTH);
  const logger = deps.logger;
  let schedulerTimer = null;
  let schedulerRunning = false;

  async function runJob(job) {
    const deploymentId = deploymentIdFor(job);
    const projectId = projectIdFor(job);
    const initialUrls = validUrlList(pageUrlsFor(job));
    if (!deploymentId || !projectId || !initialUrls) return { ok: false, code: CODE.JOB_INVALID };

    let tempDir;
    let cleanupFailed = false;
    try {
      try {
        tempDir = await deps.makeTempDir();
      } catch {
        return { ok: false, code: CODE.TEMP_FAILED };
      }
      if (!text(tempDir)) return { ok: false, code: CODE.TEMP_FAILED };

      let discovery;
      try {
        // No run identifier or proof exists yet.  Keep this request public-safe
        // and explicit about its phase.
        discovery = await deps.capture({ phase: 'discover', pageUrls: initialUrls, tempDir, auth });
      } catch {
        return { ok: false, code: CODE.DISCOVERY_FAILED };
      }
      if (resultFailed(discovery)) return { ok: false, code: CODE.DISCOVERY_FAILED };
      if (Array.isArray(discovery.pages)
        && discovery.pages.some((page) => BAD_STATES.has(rowOutcome(page)))) {
        return { ok: false, code: CODE.DISCOVERY_FAILED };
      }
      const discoveredUrls = extractDiscoveredUrls(discovery);
      const validDiscovered = validUrlList(discoveredUrls);
      if (!validDiscovered || urlOrigin(validDiscovered[0]) !== urlOrigin(initialUrls[0])) {
        return { ok: false, code: CODE.ORIGIN_MISMATCH };
      }

      let registration;
      try {
        // The page list is the exact list returned by the discovery capture;
        // do not sort, synthesize, or rewrite URL strings here.
        registration = await deps.registerPages({ deploymentId, pageUrls: validDiscovered });
      } catch {
        return { ok: false, code: CODE.REGISTRATION_FAILED };
      }
      if (resultFailed(registration)) return { ok: false, code: CODE.REGISTRATION_FAILED };
      const accepted = acceptedPageRows(registration);
      if (!accepted.length || accepted.length > MAX_DISCOVERED_PAGES) {
        return { ok: false, code: CODE.REGISTRATION_FAILED };
      }
      const discoveredSet = new Set(validDiscovered);
      const acceptedByUrl = new Map();
      for (const row of accepted) {
        const pageUrl = rowUrl(row);
        const state = registrationState(row);
        if (!pageUrl || !discoveredSet.has(pageUrl) || acceptedByUrl.has(pageUrl)
            || (state && state !== 'pending')) {
          return { ok: false, code: CODE.REGISTRATION_FAILED };
        }
        if (urlOrigin(pageUrl) !== urlOrigin(initialUrls[0])) {
          return { ok: false, code: CODE.ORIGIN_MISMATCH };
        }
        acceptedByUrl.set(pageUrl, row);
      }

      let runResult;
      try {
        // The proof is intentionally held in this lexical scope and is never
        // included in a capture request or a log/result value.
        runResult = await deps.startRun({
          deploymentId,
          includePreviousCaptureReceipts: true,
        });
      } catch {
        return { ok: false, code: CODE.RUN_FAILED };
      }
      const run = extractRun(runResult, [...acceptedByUrl.keys()]);
      if (!run) return { ok: false, code: CODE.RUN_FAILED };

      let fresh;
      try {
        fresh = await deps.capture({
          phase: 'fresh',
          pageUrls: [...acceptedByUrl.keys()],
          tempDir,
          captureRunId: run.runId,
          auth,
          previousReceipts: run.previousCaptureReceipts,
        });
      } catch {
        return { ok: false, code: CODE.FRESH_CAPTURE_FAILED };
      }
      if (resultFailed(fresh)) return { ok: false, code: CODE.FRESH_CAPTURE_FAILED };
      const pages = pageMap(fresh);
      if (!pages || pages.size !== acceptedByUrl.size) return { ok: false, code: CODE.PAGE_INVALID };
      for (const pageUrl of acceptedByUrl.keys()) {
        if (!pages.has(pageUrl)) return { ok: false, code: CODE.PAGE_INVALID };
      }

      let uploads = 0;
      let pagesRecorded = 0;
      for (const [pageUrl] of acceptedByUrl) {
        const page = pages.get(pageUrl);
        const pageState = rowState(page);
        const pageOutcome = freshPageOutcome(page);
        if (BAD_STATES.has(pageState) || !FRESH_OUTCOMES.has(pageOutcome)) {
          return { ok: false, code: CODE.PAGE_INVALID };
        }
        const desktop = normalizeCapture(page, 'desktop');
        const mobile = normalizeCapture(page, 'mobile');
        if (!desktop || !mobile) return { ok: false, code: CODE.PAGE_INVALID };

        const staged = [];
        for (const [device, capture] of [['desktop', desktop], ['mobile', mobile]]) {
          let uploadResult;
          try {
            uploadResult = await deps.upload({
              deploymentId,
              projectId,
              pageUrl,
              device,
              contentType: 'image/jpeg',
              imagePath: capture.filePath,
              filePath: capture.filePath,
              width: capture.width,
              height: capture.height,
              contentHash: capture.contentHash,
              captureContext: capture.captureContext,
              captureFingerprint: capture.captureFingerprint,
              receipt: capture.receipt,
              captureRunId: run.runId,
              captureProof: run.proof,
            });
          } catch {
            return { ok: false, code: CODE.UPLOAD_FAILED, uploads };
          }
          const receipt = uploadedReceipt(uploadResult);
          if (!receipt || receipt.contentHash !== capture.contentHash) {
            return { ok: false, code: CODE.UPLOAD_FAILED, uploads };
          }
          staged.push(receipt);
          uploads += 1;
        }

        const outcome = pageOutcome;
        const status = outcome === 'changed' ? 'updated' : outcome;
        if (!['added', 'updated', 'unchanged'].includes(status)) {
          return { ok: false, code: CODE.PAGE_INVALID, uploads };
        }
        if (staged.length !== 2 || staged[0].versionId === staged[1].versionId) {
          return { ok: false, code: CODE.UPLOAD_FAILED, uploads };
        }
        let recordResult;
        try {
          recordResult = await deps.recordPage({
            deploymentId,
            pageUrl,
            status,
            outcome,
            captureRunId: run.runId,
            captureProof: run.proof,
            versionIds: staged.map((receipt) => receipt.versionId),
            contentHashes: staged.map((receipt) => receipt.contentHash),
          });
        } catch {
          return { ok: false, code: CODE.RECORD_FAILED, uploads };
        }
        if (!resultConfirmed(recordResult)) return { ok: false, code: CODE.RECORD_FAILED, uploads };
        pagesRecorded += 1;
      }

      let completeResult;
      try {
        completeResult = await deps.completeRun({
          deploymentId,
          captureRunId: run.runId,
          captureProof: run.proof,
        });
      } catch {
        return { ok: false, code: CODE.COMPLETE_FAILED, uploads, pages: pagesRecorded };
      }
      if (!resultConfirmed(completeResult)) {
        return { ok: false, code: CODE.COMPLETE_FAILED, uploads, pages: pagesRecorded };
      }
      return { ok: true, uploads, pages: pagesRecorded };
    } finally {
      if (tempDir) {
        try {
          await deps.removeTempDir(tempDir);
        } catch {
          cleanupFailed = true;
          safeLog(logger, 'error', CODE.CLEANUP_FAILED);
        }
      }
      // A cleanup failure is intentionally not converted into a detailed
      // return value.  The caller gets only bounded state/counters.
      if (cleanupFailed) safeLog(logger, 'error', CODE.CLEANUP_FAILED);
    }
  }

  async function runOnce() {
    let listed;
    try {
      listed = await deps.listPending({ limit: MAX_PENDING_JOBS });
    } catch {
      safeLog(logger, 'error', CODE.LIST_FAILED);
      return { ...emptyResult('failed'), code: CODE.LIST_FAILED };
    }
    if (isObject(listed) && resultFailed(listed)) {
      safeLog(logger, 'error', CODE.LIST_FAILED);
      return { ...emptyResult('failed'), code: CODE.LIST_FAILED };
    }
    const jobs = extractPendingRows(listed).slice(0, MAX_PENDING_JOBS);
    if (!jobs.length) return emptyResult('idle');

    let failures = 0;
    let pages = 0;
    let uploads = 0;
    for (const job of jobs) {
      let outcome;
      try {
        outcome = await runJob(job);
      } catch {
        outcome = { ok: false, code: CODE.JOB_INVALID };
      }
      if (!outcome?.ok) {
        failures += 1;
        safeLog(logger, 'error', outcome?.code || CODE.JOB_INVALID);
      } else {
        pages += Number.isInteger(outcome.pages) ? outcome.pages : 0;
        uploads += Number.isInteger(outcome.uploads) ? outcome.uploads : 0;
      }
    }
    return {
      state: failures ? 'failed' : 'completed',
      jobs: jobs.length,
      pages,
      uploads,
      ...(failures ? { failed: failures } : {}),
    };
  }

  function stop() {
    if (schedulerTimer) clearInterval(schedulerTimer);
    schedulerTimer = null;
  }

  function startScheduler({ intervalMs = DEFAULT_INTERVAL_MS } = {}) {
    stop();
    const interval = Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
    const tick = () => {
      if (schedulerRunning) return;
      schedulerRunning = true;
      Promise.resolve()
        .then(() => runOnce())
        .catch(() => safeLog(logger, 'error', CODE.SCHEDULER_FAILED))
        .finally(() => { schedulerRunning = false; });
    };
    schedulerTimer = setInterval(tick, interval);
    if (typeof schedulerTimer?.unref === 'function') schedulerTimer.unref();
    return { stop };
  }

  return Object.freeze({ runOnce, startScheduler, stop });
}

export const DEPLOYMENT_FRAME_EXECUTOR_LIMITS = Object.freeze({
  maxPendingJobs: MAX_PENDING_JOBS,
  maxDiscoveredPages: MAX_DISCOVERED_PAGES,
  devices: DEVICES,
});
