// Canonical, runtime-neutral description of a generated critique report.
// Producers (the MCP, roast worker and future capture clients) use this before
// persisting a run. The contract deliberately records failed work instead of
// turning requested scope into a UI affordance.

const DEVICE_CLASSES = new Set(['desktop', 'tablet', 'mobile']);
const REPORT_PURPOSES = new Set(['capture', 'critique']);

function text(value, max = 300) {
  return String(value || '').trim().slice(0, max);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

// A web Crit promises a responsive review. Fail before uploading any snapshots
// when a logical page lacks real evidence for either required viewport.
export function validateResponsiveCritiqueCaptures(screens, purpose = 'critique') {
  if (purpose !== 'critique') return null;
  for (const [index, screen] of (Array.isArray(screens) ? screens : []).entries()) {
    const pageUrl = String(screen?.pageUrl || screen?.url || '');
    if (!/^https?:\/\//i.test(pageUrl)) continue;
    const captures = Array.isArray(screen?.captures) ? screen.captures : [];
    const present = new Set(captures.filter((capture) =>
      (capture?.imagePath || capture?.imageB64)
      && Number(capture?.width) > 0
      && Number(capture?.height) > 0
    ).map((capture) => capture.deviceClass || capture.captureContext?.deviceClass));
    const missing = ['desktop', 'mobile'].filter((device) => !present.has(device));
    if (missing.length) {
      return {
        error: 'responsive_capture_incomplete',
        logicalScreenId: String(screen?.logicalScreenId || screen?.id || `screen-${index + 1}`),
        missingDeviceClasses: missing,
      };
    }
  }
  return null;
}

// Keep the immutable version created by upload-screenshot at the boundary where
// an MCP capture becomes a report-manifest capture. A successful image upload
// without this receipt must not be represented as a completed generated frame:
// the renderer would otherwise have to fall back to mutable "latest" rows.
export function captureFromUploadReceipt({ capture = {}, upload = {}, captureContext = null } = {}) {
  const context = captureContext && typeof captureContext === 'object'
    ? captureContext
    : (capture.captureContext && typeof capture.captureContext === 'object' ? capture.captureContext : {});
  const versionId = text(upload.versionId || upload.version_id, 120) || null;
  const uploadError = text(upload.error, 500);
  const completed = !uploadError && (!!upload.url || upload.private === true) && !!versionId;

  return {
    versionId,
    deviceClass: context.deviceClass,
    width: capture.width,
    height: capture.height,
    pinCount: upload.pinsPlaced || 0,
    // Persist the exact IDs that were offered to this upload. The edge
    // functions independently read the immutable version before accepting a
    // Crit, but retaining the producer receipt makes the intended
    // version-to-pin relationship auditable in the generation manifest.
    pinIds: unique((Array.isArray(capture.pinIds) ? capture.pinIds : (capture.pinPositions || []).map((position) => position?.annotationId || position?.annotation_id))
      .map((id) => text(id, 160))),
    hotspots: Array.isArray(capture.hotspots) ? capture.hotspots.length : 0,
    captureContext: context,
    completed,
    limitation: uploadError || (versionId ? '' : 'snapshot upload did not return an immutable version id'),
  };
}

export function normalizeGenerationManifest(input = {}) {
  input = input && typeof input === 'object' ? input : {};
  const requested = input.requested && typeof input.requested === 'object' ? input.requested : {};
  const rawCritique = input.critique && typeof input.critique === 'object' ? input.critique : {};
  const purpose = REPORT_PURPOSES.has(text(requested.purpose || input.purpose, 20))
    ? text(requested.purpose || input.purpose, 20)
    : 'capture';
  const critiquePinIds = unique((Array.isArray(rawCritique.pinIds) ? rawCritique.pinIds : input.critiquePinIds || [])
    .map((id) => text(id, 160)));
  const rawScreens = Array.isArray(input.screens) ? input.screens : [];
  const screens = rawScreens.map((screen, index) => {
    const logicalScreenId = text(screen.logicalScreenId || screen.id || `screen-${index + 1}`, 120);
    const url = text(screen.url || screen.pageUrl, 2000);
    const captures = (Array.isArray(screen.captures) ? screen.captures : []).map((capture) => {
      const context = capture.captureContext && typeof capture.captureContext === 'object' ? capture.captureContext : {};
      const versionId = text(capture.versionId || capture.version_id, 120) || undefined;
      const deviceClass = DEVICE_CLASSES.has(text(capture.deviceClass || context.deviceClass, 20))
        ? text(capture.deviceClass || context.deviceClass, 20)
        : '';
      const width = Number(capture.width);
      const height = Number(capture.height);
      const pinCount = Math.max(0, Number(capture.pinCount || capture.pinsPlaced || 0) || 0);
      const pinIds = unique((Array.isArray(capture.pinIds) ? capture.pinIds : (capture.pinPositions || []).map((position) => position?.annotationId || position?.annotation_id))
        .map((id) => text(id, 160)));
      const completed = capture.status === 'complete' || capture.completed === true;
      const status = capture.status === 'failed' || !completed || !deviceClass || !Number.isFinite(width) || !Number.isFinite(height)
        ? 'failed'
        : 'complete';
      return {
        versionId,
        deviceClass: deviceClass || 'unknown',
        status,
        width: Number.isFinite(width) ? Math.round(width) : 0,
        height: Number.isFinite(height) ? Math.round(height) : 0,
        pinCount,
        pinIds,
        hotspots: Math.max(0, Number(capture.hotspots || 0) || 0),
        captureContext: {
          deviceClass: deviceClass || undefined,
          cssWidth: Number(context.cssWidth || context.viewportWidth || 0) || undefined,
          cssHeight: Number(context.cssHeight || context.viewportHeight || 0) || undefined,
          dpr: Number(context.dpr || context.devicePixelRatio || 0) || undefined,
          orientation: ['portrait', 'landscape'].includes(context.orientation) ? context.orientation : undefined,
          platform: text(context.platform, 64) || undefined,
          browser: text(context.browser, 64) || undefined,
        },
        limitation: status === 'failed' ? text(capture.limitation || capture.error || 'capture did not complete', 240) : '',
      };
    });
    const flowColumn = Number(screen.flowColumn);
    const flowRow = Number(screen.flowRow);
    const navigationRole = ['root', 'destination'].includes(text(screen.navigationRole, 20))
      ? text(screen.navigationRole, 20)
      : '';
    return {
      logicalScreenId,
      url,
      title: text(screen.title, 160),
      order: Number.isFinite(Number(screen.order)) ? Number(screen.order) : index,
      flowColumn: Number.isFinite(flowColumn) ? Math.max(0, Math.round(flowColumn)) : undefined,
      flowRow: Number.isFinite(flowRow) ? Math.max(0, Math.round(flowRow)) : undefined,
      navigationRole: navigationRole || undefined,
      navigationLabel: text(screen.navigationLabel, 120) || undefined,
      links: unique((Array.isArray(screen.links) ? screen.links : []).map((id) => text(id, 120))),
      captures,
    };
  }).filter((screen) => screen.logicalScreenId && screen.url);

  const orderedIds = unique((Array.isArray(input.journey?.screenIds) ? input.journey.screenIds : []).map((id) => text(id, 120)));
  const completedScreenIds = new Set(screens.filter((screen) => screen.captures.some((capture) => capture.status === 'complete')).map((screen) => screen.logicalScreenId));
  const journeyScreenIds = orderedIds.filter((id) => completedScreenIds.has(id));
  const journeyRequested = orderedIds.length >= 2;
  const journey = {
    requested: journeyRequested,
    screenIds: journeyScreenIds,
    complete: journeyRequested && journeyScreenIds.length === orderedIds.length && journeyScreenIds.length >= 2,
    limitation: journeyRequested && journeyScreenIds.length !== orderedIds.length ? 'One or more ordered Journey screens did not complete.' : '',
  };

  const completeCaptures = screens.flatMap((screen) => screen.captures.filter((capture) => capture.status === 'complete'));
  const failedCaptures = screens.flatMap((screen) => screen.captures.filter((capture) => capture.status === 'failed'));
  const deviceClasses = unique(completeCaptures.map((capture) => capture.deviceClass));
  const limitations = unique([
    ...failedCaptures.map((capture) => capture.limitation),
    journey.limitation,
    ...(Array.isArray(input.limitations) ? input.limitations.map((value) => text(value, 240)) : []),
  ]);
  const pinCount = completeCaptures.reduce((sum, capture) => sum + capture.pinCount, 0);

  return {
    version: 1,
    generationKey: text(input.generationKey || 'canonical', 120),
    requested: {
      preset: ['single', 'full', 'multi-screen', 'journey', 'refresh'].includes(requested.preset) ? requested.preset : 'single',
      // A zero-pin capture can be useful evidence, but it must never be
      // presented as fulfillment of an AI critique. Producers mark the intent
      // explicitly so the mint/persist boundaries can require real bot pins.
      purpose,
      accessMode: requested.accessMode === 'project_members' ? 'project_members' : 'public',
      coverage: requested.coverage && typeof requested.coverage === 'object' && !Array.isArray(requested.coverage)
        ? {
          complete: requested.coverage.complete === true,
          discoveredRoutes: Math.max(0, Math.min(10000, Number(requested.coverage.discoveredRoutes) || 0)),
          capturedRoutes: Math.max(0, Math.min(64, Number(requested.coverage.capturedRoutes) || 0)),
          gaps: (Array.isArray(requested.coverage.gaps) ? requested.coverage.gaps : []).slice(0, 64)
            .map((gap) => String(gap || '').slice(0, 200)),
        }
        : null,
      deviceClasses: unique((Array.isArray(requested.deviceClasses) ? requested.deviceClasses : []).map((value) => text(value, 20)).filter((value) => DEVICE_CLASSES.has(value))),
      logicalScreenIds: screens.map((screen) => screen.logicalScreenId),
    },
    critique: purpose === 'critique' ? {
      runId: text(rawCritique.runId || input.critiqueRunId, 120) || null,
      pinIds: critiquePinIds,
    } : null,
    screens,
    journey,
    attribution: {
      ref: text(input.attribution?.ref || input.ref, 120) || null,
      source: text(input.attribution?.source, 120) || null,
    },
    live: { eligible: !!input.live?.eligible, connected: !!input.live?.connected },
    population: {
      realScreenCount: screens.filter((screen) => screen.captures.some((capture) => capture.status === 'complete')).length,
      deviceClasses,
      deviceVariantCount: completeCaptures.length,
      pinCount,
      journey: journey.complete ? 'ready' : 'not_available',
      live: input.live?.connected ? 'ready' : 'not_connected',
      complete: completeCaptures.length > 0,
    },
    limitations,
  };
}

export function generationReceipt(manifest, { reportUrl = null, token = null } = {}) {
  const m = normalizeGenerationManifest(manifest);
  return {
    success: m.population.complete,
    reportUrl: reportUrl || null,
    token: token || null,
    realScreenCount: m.population.realScreenCount,
    deviceVariants: m.population.deviceClasses,
    journey: m.population.journey,
    pinCount: m.population.pinCount,
    live: m.population.live,
    limitations: m.limitations,
  };
}

export function isVerifiedDirectReport(manifest, reportUrl) {
  const m = normalizeGenerationManifest(manifest);
  // A capture-only report is useful evidence, but cannot authorize outbound
  // delivery as a Crit. The durable manifest is accepted only after the edge
  // boundary verified these exact bot pin IDs, so require that Crit receipt
  // rather than treating a populated screenshot as AI feedback.
  return !!(
    m.requested.purpose === 'critique'
    && m.population.complete
    && m.population.pinCount > 0
    && typeof m.critique?.runId === 'string'
    && m.critique.runId.length > 0
    && Array.isArray(m.critique?.pinIds)
    && m.critique.pinIds.length > 0
    && /^https:\/\/(?:www\.)?pincushion\.io\/r\/[A-Za-z0-9_-]+(?:\?|$)/.test(String(reportUrl || ''))
  );
}
