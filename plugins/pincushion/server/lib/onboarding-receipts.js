// Explicit operations only. Background synchronization must never call this.
export function returnedPinIds(result) {
  if (!result || result.error) return [];
  const pins = [
    ...(result.pins || []),
    ...(result.packets || []).flatMap(page => page.pins || []),
    ...(result.pages || []).flatMap(page => page.annotations || page.pins || []),
    ...(result.results || []).map(row => row.annotation),
  ];
  return [...new Set(pins.map(pin => pin?.id).filter(id => typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(id)))];
}

export async function recordOnboardingReceipt({ action, annotationId, projectId, syncServerUrl, licenseKey, fetchImpl = fetch }) {
  if (!['approve', 'record_implementation'].includes(action) ||
      ![annotationId, projectId].every(id => typeof id === 'string' && /^[a-zA-Z0-9_.:-]{1,200}$/.test(id)) ||
      !syncServerUrl || !licenseKey) return { ok: false, reason: 'authenticated_project_required' };
  try {
    const url = new URL(syncServerUrl);
    url.pathname = url.pathname.replace(/\/[^/]*$/, '/onboarding-status');
    url.search = '';
    const response = await fetchImpl(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'x-license-key': licenseKey },
      body: JSON.stringify({ action, project_id: projectId, annotation_id: annotationId }),
      redirect: 'error', signal: AbortSignal.timeout(8000),
    });
    const body = response.ok ? await response.json() : null;
    return body?.success === true ? { ok: true } : { ok: false, reason: 'receipt_not_recorded' };
  } catch { return { ok: false, reason: 'receipt_unavailable' }; }
}

export function withOnboardingMeasurement(result, receipts) {
  if (receipts.every(receipt => receipt.ok)) return result;
  return { ...result, measurement: { ...result?.measurement, onboarding: { status: 'DEGRADED', reason: 'authenticated_milestone_not_recorded' } } };
}
