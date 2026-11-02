// Pure deployment-reconciliation helpers shared by the local capture client,
// MCP queue wrappers, and their focused tests.  This module deliberately has
// no filesystem, network, browser, or provider dependencies: all external
// effects stay at the narrow upload/queue boundaries.

export const DEPLOYMENT_PAGE_OUTCOMES = Object.freeze([
  'added',
  'changed',
  'unchanged',
  'removed',
  'inaccessible',
  'unknown',
]);

export const DEPLOYMENT_TERMINAL_STATUSES = Object.freeze([
  'updated',
  'added',
  'unchanged',
  'removed',
  'failed',
  'inaccessible',
  'skipped',
]);

// `changed` is a client-side classification; the backend writes the canonical
// `change_kind` and accepts `updated` as the terminal capture status. Unknown
// evidence must fail closed instead of being mislabeled unchanged.
export const DEPLOYMENT_OUTCOME_STATUS_MAP = Object.freeze({
  added: 'added',
  changed: 'updated',
  unchanged: 'unchanged',
  removed: 'removed',
  inaccessible: 'inaccessible',
  unknown: 'failed',
});

export const CANONICAL_DEPLOYMENT_VIEWPORTS = Object.freeze({
  desktop: Object.freeze({ width: 1280, height: 900 }),
  mobile: Object.freeze({ width: 390, height: 844 }),
});

// Discovery remains intentionally bounded. The capture CLI has the same hard
// ceiling, so a client cannot turn a broad crawl into an unreviewed deployment
// inventory write.
export const MAX_DISCOVERED_DEPLOYMENT_PAGES = 64;

// Keep the new backend seam in one place. The edge function atomically
// finalizes a deployment after every page has a terminal result, so there is no
// separate public finalization call for an agent to race.
export const DEPLOYMENT_RECONCILIATION_CONTRACT = Object.freeze({
  version: 'deployment-reconciliation-v2',
  queuePaths: Object.freeze({
    discoverPages: '/discover-pages',
    recordPageResult: '/page-result',
    listFrameRefreshes: '/frame-refreshes',
    startCaptureRun: '/capture-run/start',
    completeCaptureRun: '/capture-run/complete',
  }),
  maxFingerprintTiles: 1536,
  maxDiscoveredPages: MAX_DISCOVERED_DEPLOYMENT_PAGES,
});

const CANONICAL_DEVICE_CLASSES = Object.freeze(Object.keys(CANONICAL_DEPLOYMENT_VIEWPORTS));

function boundedString(value, max = 400) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function numeric(value) {
  return Number.isFinite(value) ? value : null;
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

export function normalizeInventoryUrl(input) {
  try {
    const url = new URL(String(input || '').trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    url.hash = '';
    // URL already lowercases the host. Clear only default ports; a non-default
    // port is a meaningful origin boundary and must remain distinct.
    if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
      url.port = '';
    }
    if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return null;
  }
}

// Preserve query variants while removing only the same harmless differences as
// receipt matching. Ordering is first-seen order so a caller can pair accepted
// rows back to a deterministic discovery run without overloading the backend.
export function normalizeDiscoveredPageUrls(values, max = MAX_DISCOVERED_DEPLOYMENT_PAGES) {
  const limit = Number.isInteger(max) && max > 0 ? Math.min(max, MAX_DISCOVERED_DEPLOYMENT_PAGES) : MAX_DISCOVERED_DEPLOYMENT_PAGES;
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const candidate = typeof value === 'string' ? value : value?.pageUrl || value?.page_url || value?.url;
    const normalized = normalizeInventoryUrl(candidate);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
    if (out.length >= limit) break;
  }
  return out;
}

export function canonicalDeviceClass(value) {
  return CANONICAL_DEVICE_CLASSES.includes(value) ? value : null;
}

export function normalizeVisualFingerprint(input) {
  const source = asObject(input);
  if (!source) return null;
  const columns = numeric(source.columns);
  const rows = numeric(source.rows);
  const rawVector = Array.isArray(source.vector) ? source.vector : null;
  if (!Number.isInteger(columns) || columns < 1 || columns > 24 ||
      !Number.isInteger(rows) || rows < 1 || rows > 64 ||
      !rawVector || rawVector.length !== columns * rows ||
      rawVector.length > DEPLOYMENT_RECONCILIATION_CONTRACT.maxFingerprintTiles) {
    return null;
  }
  const vector = rawVector.map((tile) => {
    const value = Number(tile);
    return Number.isFinite(value) ? (value >>> 0) : 0;
  });
  const unstableTiles = [...new Set((Array.isArray(source.unstableTiles) ? source.unstableTiles : [])
    .map((tile) => Number(tile))
    .filter((tile) => Number.isInteger(tile) && tile >= 0 && tile < vector.length))]
    .sort((a, b) => a - b);
  return {
    algorithm: boundedString(source.algorithm, 80) || 'tile-rgb-v1',
    columns,
    rows,
    vector,
    unstableTiles,
    digest: boundedString(source.digest, 128) || null,
  };
}

const HASH_64 = /^[0-9a-f]{64}$/;
const MASK_TOKEN = /^[a-z0-9:_-]{1,80}$/;

// The server persists this compact form beside immutable capture receipts. It
// deliberately contains hashes of decoded pixel-tile aggregates, never image
// data or readable page text. Accept either the direct object or a receipt that
// wraps it in the snake/camel field used by the transport.
export function normalizeCaptureFingerprint(input) {
  const wrapper = asObject(input) || {};
  const source = asObject(wrapper.captureFingerprint || wrapper.capture_fingerprint) ||
    (wrapper.semantic_hash || wrapper.visual_digest ? wrapper : null);
  if (!source || Number(source.version) !== 1) return null;
  const semanticHash = boundedString(source.semantic_hash || source.semanticHash, 64).toLowerCase();
  const visualDigest = boundedString(source.visual_digest || source.visualDigest, 64).toLowerCase();
  if (!HASH_64.test(semanticHash) || !HASH_64.test(visualDigest)) return null;
  const tileDigests = Array.isArray(source.tile_digests || source.tileDigests)
    ? (source.tile_digests || source.tileDigests).map((value) => boundedString(value, 64).toLowerCase())
    : [];
  const instabilityMask = Array.isArray(source.instability_mask || source.instabilityMask)
    ? (source.instability_mask || source.instabilityMask).map((value) => boundedString(value, 80).toLowerCase())
    : [];
  if (tileDigests.length > 128 || instabilityMask.length > 128 ||
      tileDigests.some((value) => !HASH_64.test(value)) ||
      instabilityMask.some((value) => !MASK_TOKEN.test(value))) return null;
  return { version: 1, semanticHash, visualDigest, tileDigests, instabilityMask };
}

export function compareCaptureFingerprints(previousInput, currentInput) {
  const previous = normalizeCaptureFingerprint(previousInput);
  const current = normalizeCaptureFingerprint(currentInput);
  if (!previous || !current) return { comparable: false, changed: false, reason: 'capture_fingerprint_missing_or_invalid' };
  if (!previous.tileDigests.length || !current.tileDigests.length) {
    if (previous.visualDigest === current.visualDigest) return { comparable: true, changed: false, reason: 'visual_digest_match', comparedTiles: 0 };
    return { comparable: false, changed: false, reason: 'tile_vector_missing_for_changed_visual_digest' };
  }
  if (previous.tileDigests.length !== current.tileDigests.length) {
    return { comparable: true, changed: true, reason: 'tile_vector_shape_changed', comparedTiles: 0, changedTiles: 0 };
  }
  const masked = new Set([...previous.instabilityMask, ...current.instabilityMask]);
  let comparedTiles = 0;
  const changedTileIndexes = [];
  for (let index = 0; index < current.tileDigests.length; index += 1) {
    if (masked.has(`bucket:${index}`) || masked.has(`tile:${index}`)) continue;
    comparedTiles += 1;
    if (previous.tileDigests[index] !== current.tileDigests[index]) changedTileIndexes.push(index);
  }
  if (!comparedTiles) return { comparable: false, changed: false, reason: 'all_capture_tiles_unstable', maskedTiles: masked.size };
  return {
    comparable: true,
    changed: changedTileIndexes.length > 0,
    reason: changedTileIndexes.length ? 'persistent_visual_change' : 'visual_match',
    comparedTiles,
    changedTiles: changedTileIndexes.length,
    changedTileIndexes,
    maskedTiles: masked.size,
  };
}

function unpackTile(tile) {
  const value = Number(tile) >>> 0;
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

export function visualTileDistance(left, right) {
  const a = unpackTile(left);
  const b = unpackTile(right);
  return (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3])) / 4;
}

export function compareVisualFingerprints(previousInput, currentInput, {
  tileDistanceThreshold = 12,
} = {}) {
  const previous = normalizeVisualFingerprint(previousInput);
  const current = normalizeVisualFingerprint(currentInput);
  if (!previous || !current) {
    return { comparable: false, changed: false, reason: 'visual_fingerprint_missing_or_invalid' };
  }
  if (previous.algorithm !== current.algorithm || previous.columns !== current.columns || previous.rows !== current.rows) {
    return { comparable: true, changed: true, reason: 'visual_fingerprint_shape_changed', comparedTiles: 0, changedTiles: 0 };
  }

  const masked = new Set([...previous.unstableTiles, ...current.unstableTiles]);
  let comparedTiles = 0;
  let changedTiles = 0;
  let totalDistance = 0;
  const changedTileIndexes = [];
  for (let index = 0; index < current.vector.length; index += 1) {
    if (masked.has(index)) continue;
    comparedTiles += 1;
    const distance = visualTileDistance(previous.vector[index], current.vector[index]);
    totalDistance += distance;
    if (distance > tileDistanceThreshold) {
      changedTiles += 1;
      changedTileIndexes.push(index);
    }
  }
  if (!comparedTiles) {
    return { comparable: false, changed: false, reason: 'all_visual_tiles_unstable', maskedTiles: masked.size };
  }
  return {
    comparable: true,
    changed: changedTiles > 0,
    reason: changedTiles ? 'persistent_visual_change' : 'visual_match',
    comparedTiles,
    changedTiles,
    changedTileIndexes,
    maskedTiles: masked.size,
    meanDistance: Number((totalDistance / comparedTiles).toFixed(4)),
  };
}

function semanticHash(receipt) {
  const source = asObject(receipt) || {};
  return normalizeCaptureFingerprint(source)?.semanticHash || boundedString(source.semanticHash || source.semantic_hash, 128) || null;
}

function visualFingerprint(receipt) {
  const source = asObject(receipt) || {};
  return source.visualFingerprint || source.visual_fingerprint || null;
}

function hasCommittedCaptureReceipt(receipt) {
  const source = asObject(receipt) || {};
  return Boolean(
    boundedString(source.versionId || source.version_id, 200) ||
    boundedString(source.capturedAt || source.captured_at, 200) ||
    boundedString(source.contentHash || source.content_hash, 128),
  );
}

export function classifyCaptureChange({ previous = null, current = null } = {}) {
  if (!previous) return { outcome: 'added', reason: 'no_prior_capture_receipt', shouldStage: true };
  if (!current) return { outcome: 'unknown', reason: 'current_capture_missing', shouldStage: false };

  const priorSemantic = semanticHash(previous);
  const currentSemantic = semanticHash(current);
  const priorCaptureFingerprint = normalizeCaptureFingerprint(previous);
  const currentCaptureFingerprint = normalizeCaptureFingerprint(current);
  // Old committed captures predate v1 fingerprints. A valid current v1
  // desktop/mobile capture is enough to bootstrap the baseline: stage it as a
  // change instead of calling it unchanged or leaving every future deploy
  // inconclusive. An empty object is not a committed baseline and remains
  // unknown, preserving fail-closed behavior for malformed receipts.
  if (hasCommittedCaptureReceipt(previous) && !priorCaptureFingerprint && currentCaptureFingerprint) {
    return { outcome: 'changed', reason: 'bootstrap_required', shouldStage: true, bootstrapRequired: true };
  }
  if (!priorSemantic || !currentSemantic) {
    return { outcome: 'unknown', reason: 'semantic_fingerprint_missing', shouldStage: false };
  }
  if (priorSemantic !== currentSemantic) {
    return { outcome: 'changed', reason: 'semantic_change', shouldStage: true };
  }

  const persistedVisual = compareCaptureFingerprints(previous, current);
  if (persistedVisual.comparable) {
    if (persistedVisual.changed) return { outcome: 'changed', reason: persistedVisual.reason, shouldStage: true, visual: persistedVisual };
    return { outcome: 'unchanged', reason: 'semantic_and_visual_match', shouldStage: false, visual: persistedVisual };
  }
  if (priorCaptureFingerprint || currentCaptureFingerprint) {
    return { outcome: 'unknown', reason: persistedVisual.reason, shouldStage: false, visual: persistedVisual };
  }

  const visual = compareVisualFingerprints(visualFingerprint(previous), visualFingerprint(current));
  if (!visual.comparable) {
    return { outcome: 'unknown', reason: visual.reason, shouldStage: false, visual };
  }
  if (visual.changed) {
    return { outcome: 'changed', reason: visual.reason, shouldStage: true, visual };
  }
  return { outcome: 'unchanged', reason: 'semantic_and_visual_match', shouldStage: false, visual };
}

export function classifyDeploymentPage({
  probe = null,
  previousReceipts = {},
  currentReceipts = {},
  deviceClasses = CANONICAL_DEVICE_CLASSES,
} = {}) {
  const probeOutcome = boundedString(asObject(probe)?.outcome, 40);
  if (['removed', 'inaccessible', 'unknown'].includes(probeOutcome)) {
    return {
      outcome: probeOutcome,
      reason: boundedString(asObject(probe)?.reason, 160) || `probe_${probeOutcome}`,
      shouldStage: false,
      requiresFreshRender: false,
      requiresStagedVersions: false,
      deviceComparisons: {},
    };
  }

  const deviceComparisons = {};
  for (const deviceClass of deviceClasses) {
    if (!canonicalDeviceClass(deviceClass)) continue;
    deviceComparisons[deviceClass] = classifyCaptureChange({
      previous: asObject(previousReceipts)?.[deviceClass] || null,
      current: asObject(currentReceipts)?.[deviceClass] || null,
    });
  }
  const results = Object.values(deviceComparisons);
  if (!results.length) return {
    outcome: 'unknown', reason: 'no_canonical_device_receipts', shouldStage: false,
    requiresFreshRender: false, requiresStagedVersions: false, deviceComparisons,
  };
  if (results.some((result) => result.outcome === 'changed' || result.outcome === 'added')) {
    const changed = results.some((result) => result.outcome === 'changed');
    return {
      outcome: changed ? 'changed' : 'added',
      reason: changed ? 'persistent_device_change' : 'new_device_capture',
      shouldStage: true,
      requiresFreshRender: true,
      requiresStagedVersions: true,
      deviceComparisons,
    };
  }
  if (results.some((result) => result.outcome === 'unknown')) {
    return {
      outcome: 'unknown', reason: 'device_fingerprint_inconclusive', shouldStage: false,
      requiresFreshRender: false, requiresStagedVersions: false, deviceComparisons,
    };
  }
  return {
    // A fresh deployment frame must retain actual current-run bytes even when
    // the comparison is unchanged. The server later deduplicates an exact
    // byte match against the frozen canonical pair; a metadata-only receipt
    // cannot complete the run.
    outcome: 'unchanged', reason: 'all_canonical_devices_unchanged', shouldStage: true,
    requiresFreshRender: true, requiresStagedVersions: true, deviceComparisons,
  };
}

export function buildDeploymentCaptureManifest({ deploymentId, projectId, pages = [] } = {}) {
  const normalizedDeploymentId = boundedString(deploymentId, 200);
  const normalizedProjectId = boundedString(projectId, 200);
  if (!normalizedDeploymentId || !normalizedProjectId) return { error: 'deploymentId and projectId are required' };
  const screens = [];
  for (const page of Array.isArray(pages) ? pages : []) {
    const pageUrl = normalizeInventoryUrl(page?.pageUrl || page?.url);
    const outcome = boundedString(page?.outcome, 40);
    if (!pageUrl || !DEPLOYMENT_PAGE_OUTCOMES.includes(outcome)) {
      return { error: 'each page requires a valid pageUrl and terminal outcome' };
    }
    const captures = [];
    for (const deviceClass of CANONICAL_DEVICE_CLASSES) {
      const receipt = asObject(page?.captures)?.[deviceClass] || null;
      if (!receipt) continue;
      const versionId = boundedString(receipt.versionId || receipt.version_id, 200);
      if (!versionId) return { error: `capture ${deviceClass} for ${pageUrl} is missing immutable versionId` };
      captures.push({
        deviceClass,
        versionId,
        width: numeric(receipt.width),
        height: numeric(receipt.height),
        semanticHash: semanticHash(receipt),
        visualFingerprint: normalizeVisualFingerprint(visualFingerprint(receipt)),
        captureFingerprint: normalizeCaptureFingerprint(receipt),
        captureContext: asObject(receipt.captureContext || receipt.capture_context) || null,
      });
    }
    // A deployment-frame `unchanged` outcome still names a newly staged pair:
    // the server compares those current-run byte hashes to the frozen canonical
    // pair, then keeps observed evidence while discarding duplicate private
    // versions. A manifest must not reintroduce a metadata-only bypass.
    if (['added', 'changed', 'unchanged'].includes(outcome)) {
      const capturedDevices = new Set(captures.map((capture) => capture.deviceClass));
      if (!CANONICAL_DEVICE_CLASSES.every((deviceClass) => capturedDevices.has(deviceClass))) {
        return { error: `${outcome} page ${pageUrl} requires exact staged desktop and mobile versionIds` };
      }
    }
    screens.push({
      logicalScreenId: boundedString(page.logicalScreenId, 200) || pageUrl,
      pageUrl,
      outcome,
      captures,
    });
  }
  return {
    schemaVersion: DEPLOYMENT_RECONCILIATION_CONTRACT.version,
    purpose: 'capture',
    generationKey: 'canonical',
    deploymentId: normalizedDeploymentId,
    projectId: normalizedProjectId,
    screens,
  };
}
