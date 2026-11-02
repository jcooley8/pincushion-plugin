// Cloud evidence is never inferred from a successful HTTP response or local pin
// fields. This client has no authority to upgrade a caller-reported verdict.
const ACTIONS = new Set(['submit_verification_report', 'attach_verification_run', 'get_pin_verification']);
const IDENTIFIER = /^[A-Za-z0-9_.:-]{1,200}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PROJECTION = {
  availability: { states: ['available', 'unavailable'], fields: [] },
  reported: { states: ['none', 'reported'], fields: ['report_id', 'verdict', 'reported_at', 'policy_revision_id', 'policy_digest'] },
  deployment: { states: ['not_linked', 'eligible', 'confirmed', 'rejected'], fields: ['deployment_event_id', 'deploy_hash', 'provenance', 'completed_at', 'reason'] },
  github: { states: ['not_requested', 'policy_unavailable', 'github_run_attested', 'checks_passed', 'not_attested'], fields: ['run_id', 'run_attempt', 'workflow_id', 'workflow_path', 'checked_at', 'artifact_digest', 'reason', 'check_spec_id', 'check_ids'] },
  summary: { states: ['unverified', 'reported', 'deployment_confirmed', 'github_run_attested', 'checks_passed', 'regressed', 'inconclusive'], fields: ['verification_level', 'report_id', 'evaluated_at'] },
};

function validatedClientAcceptance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const state = value.state;
  if (state === 'unavailable') {
    if (Object.keys(value).some(key => !['state', 'reason'].includes(key)) || Object.keys(value).length > 2) return null;
    if (value.reason !== undefined && (typeof value.reason !== 'string' || !/^[a-z0-9_]{1,120}$/.test(value.reason))) return null;
    return value.reason === undefined ? { state } : { state, reason: value.reason };
  }
  if (state === 'not_requested') {
    if (Object.keys(value).length !== 5 || value.lifecycle !== 'none' ||
      value.decision_state !== 'not_requested' || value.lifecycle_state !== 'none' ||
      value.artifact_availability !== 'not_requested') return null;
    return {
      state, lifecycle: 'none', decision_state: 'not_requested', lifecycle_state: 'none',
      artifact_availability: 'not_requested',
    };
  }
  if (!['awaiting_review', 'changes_requested', 'accepted'].includes(state) ||
    Object.keys(value).length !== 12 || !['active', 'superseded', 'closed'].includes(value.lifecycle) ||
    value.decision_state !== state || value.lifecycle_state !== value.lifecycle ||
    !['available', 'expired'].includes(value.artifact_availability) ||
    !UUID.test(value.review_id || '') || typeof value.issued_at !== 'string' || !Number.isFinite(Date.parse(value.issued_at)) ||
    !/^[a-f0-9]{64}$/.test(value.package_digest || '') ||
    value.package_algorithm !== 'application_canonical_json_v1_sha256_utf8' ||
    !(value.evidence_expires_at === null || (typeof value.evidence_expires_at === 'string' && Number.isFinite(Date.parse(value.evidence_expires_at)))) ||
    !(value.decision_recorded_at === null || (typeof value.decision_recorded_at === 'string' && Number.isFinite(Date.parse(value.decision_recorded_at)))) ||
    !(value.superseded_by_review_id === null || UUID.test(value.superseded_by_review_id))) return null;
  return {
    state, lifecycle: value.lifecycle, decision_state: value.decision_state,
    lifecycle_state: value.lifecycle_state, artifact_availability: value.artifact_availability,
    review_id: value.review_id, issued_at: value.issued_at,
    package_digest: value.package_digest.toLowerCase(), package_algorithm: value.package_algorithm,
    evidence_expires_at: value.evidence_expires_at, decision_recorded_at: value.decision_recorded_at,
    superseded_by_review_id: value.superseded_by_review_id,
  };
}

function validatedProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const clean = {};
  for (const [key, schema] of Object.entries(PROJECTION)) {
    const section = value[key];
    if (!section || typeof section !== 'object' || Array.isArray(section) || !schema.states.includes(section.state)) return null;
    clean[key] = { state: section.state };
    for (const field of schema.fields) {
      const entry = section[field];
      if (entry === undefined) continue;
      if (field === 'check_ids') {
        if (!Array.isArray(entry) || entry.length > 100 || entry.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_.:-]{1,120}$/.test(id))) return null;
      } else if (['run_id', 'run_attempt', 'workflow_id'].includes(field)) {
        if (!Number.isSafeInteger(entry) || entry < 1) return null;
      } else if (typeof entry !== 'string' || entry.length > 1024) return null;
      clean[key][field] = entry;
    }
  }
  const clientAcceptance = validatedClientAcceptance(value.client_acceptance);
  if (!clientAcceptance) return null;
  clean.client_acceptance = clientAcceptance;
  const timestamp = value => typeof value === 'string' && Number.isFinite(Date.parse(value));
  const sha = value => typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value);
  const digest = value => typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
  const reason = value => typeof value === 'string' && /^[a-z0-9_]{1,120}$/.test(value);
  const { reported, deployment, github, summary } = clean;
  if (clean.availability.state === 'unavailable' && (reported.state !== 'none' || deployment.state !== 'not_linked' || github.state !== 'not_attested' || summary.state !== 'unverified' || summary.verification_level !== 'none')) return null;
  if (!timestamp(summary.evaluated_at)) return null;
  if (reported.state === 'reported') {
    if (!UUID.test(reported.report_id || '') || !['verified', 'regressed', 'inconclusive', 'pending'].includes(reported.verdict) ||
      !timestamp(reported.reported_at) || !UUID.test(reported.policy_revision_id || '') || !/^[a-f0-9]{64}$/.test(reported.policy_digest || '') ||
      summary.report_id !== reported.report_id) return null;
  } else if (Object.keys(reported).length !== 1 || summary.report_id !== undefined) return null;
  if (deployment.state === 'not_linked') {
    if (Object.keys(deployment).length !== 1) return null;
  } else {
    if (!UUID.test(deployment.deployment_event_id || '')) return null;
    if (['eligible', 'confirmed'].includes(deployment.state) && (!sha(deployment.deploy_hash) || deployment.provenance !== 'native_webhook' || !timestamp(deployment.completed_at))) return null;
    if (deployment.state === 'rejected' && !reason(deployment.reason)) return null;
    if (deployment.deploy_hash !== undefined && !sha(deployment.deploy_hash)) return null;
    if (deployment.completed_at !== undefined && !timestamp(deployment.completed_at)) return null;
    if (deployment.provenance !== undefined && deployment.provenance !== 'native_webhook') return null;
  }
  if (['github_run_attested', 'checks_passed'].includes(github.state)) {
    if (reported.state !== 'reported' || deployment.state !== 'confirmed' ||
      ![github.run_id, github.run_attempt, github.workflow_id].every(value => Number.isSafeInteger(value) && value > 0) ||
      !/^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/.test(github.workflow_path || '') ||
      !timestamp(github.checked_at) || !digest(github.artifact_digest)) return null;
    if (github.state === 'checks_passed' && (!/^[A-Za-z0-9_.:-]{1,120}$/.test(github.check_spec_id || '') ||
      !github.check_ids?.length || new Set(github.check_ids).size !== github.check_ids.length)) return null;
  } else if (github.state === 'not_requested') {
    if (Object.keys(github).length !== 1) return null;
  } else if (!reason(github.reason) || Object.keys(github).some(key => !['state', 'reason'].includes(key))) return null;
  let expectedState = reported.state === 'reported' ? 'reported' : 'unverified';
  let expectedLevel = reported.state === 'reported' ? 'reported' : 'none';
  if (deployment.state === 'confirmed') expectedState = expectedLevel = 'deployment_confirmed';
  if (['github_run_attested', 'checks_passed'].includes(github.state)) expectedState = expectedLevel = github.state;
  if (['regressed', 'inconclusive'].includes(reported.verdict)) { expectedState = reported.verdict; expectedLevel = 'reported'; }
  if (summary.state !== expectedState || summary.verification_level !== expectedLevel) return null;
  return clean;
}

export async function requestPinVerification({ syncServerUrl, licenseKey, action, payload, fetchImpl = fetch }) {
  if (!ACTIONS.has(action)) return { success: false, error: 'invalid_verification_action' };
  if (!licenseKey || !syncServerUrl) return { success: false, error: 'authenticated_cloud_required' };
  if (!IDENTIFIER.test(payload?.project_id || '') || !IDENTIFIER.test(payload?.annotation_id || '')) {
    return { success: false, error: 'explicit_project_and_pin_required' };
  }
  try {
    const url = new URL(syncServerUrl);
    if (url.protocol !== 'https:' || url.username || url.password) {
      return { success: false, error: 'secure_cloud_endpoint_required' };
    }
    url.pathname = url.pathname.replace(/\/[^/]*$/, '/pin-verification');
    url.search = '';
    url.hash = '';
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-license-key': licenseKey },
      body: JSON.stringify({ ...payload, action }),
      redirect: 'error',
      signal: AbortSignal.timeout(30000),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || body?.success !== true) {
      return { success: false, error: typeof body?.error === 'string' && /^[a-z0-9_]{1,80}$/.test(body.error)
        ? body.error : 'verification_evidence_unavailable', status: response.status };
    }
    if (body.project_id !== payload.project_id || body.annotation_id !== payload.annotation_id) {
      return { success: false, error: 'verification_evidence_scope_mismatch' };
    }
    const verification = validatedProjection(body.verification);
    const invalid = { success: false, error: 'verification_evidence_invalid_acknowledgement' };
    if (!verification) return invalid;
    const receipt = { success: true, project_id: body.project_id, annotation_id: body.annotation_id, verification };
    if (action !== 'get_pin_verification') {
      if (!UUID.test(body.report_id || '') || typeof body.idempotent !== 'boolean' || verification.reported.report_id !== body.report_id ||
        (action === 'submit_verification_report' && (verification.reported.verdict !== payload.verdict ||
          (payload.deployment_event_id == null
            ? verification.deployment.state !== 'not_linked'
            : verification.deployment.deployment_event_id !== payload.deployment_event_id)))) return invalid;
      receipt.report_id = body.report_id;
      receipt.idempotent = body.idempotent;
    }
    if (action === 'attach_verification_run') {
      if (body.report_id !== payload.report_id || body.run_id !== payload.run_id || body.run_attempt !== payload.run_attempt ||
        !Number.isSafeInteger(body.run_id) || body.run_id < 1 || !Number.isSafeInteger(body.run_attempt) || body.run_attempt < 1 ||
        (['github_run_attested', 'checks_passed'].includes(verification.github.state) &&
          (verification.github.run_id !== payload.run_id || verification.github.run_attempt !== payload.run_attempt))) return invalid;
      receipt.run_id = body.run_id;
      receipt.run_attempt = body.run_attempt;
    }
    return receipt;
  } catch {
    return { success: false, error: 'verification_evidence_unavailable' };
  }
}
