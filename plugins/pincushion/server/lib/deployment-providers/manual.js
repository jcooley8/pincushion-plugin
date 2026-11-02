import {
  PROVIDER_IDS,
  buildManualSetupSummary,
} from './contracts.js';

/**
 * Manual provider/CI recipes are deliberately descriptive only. They do not
 * contain a receiver URL, bearer token, provider credential, or a source/CI
 * mutation. A future admitted adapter can add an owner-only setup handoff.
 */
export const MANUAL_PROVIDER_RECIPES = Object.freeze({
  vercel: 'vercel_post_deploy',
  netlify: 'netlify_post_deploy',
  render: 'render_post_deploy',
  railway: 'railway_post_deploy',
  github: 'github_actions_post_deploy',
  'github-actions': 'github_actions_post_deploy',
  fly: 'fly_post_deploy',
  docker: 'docker_post_deploy',
  cloudflare: 'cloudflare_post_deploy',
  aws: 'aws_post_deploy',
  custom: 'manual_production_post_deploy',
  unknown: 'manual_production_post_deploy',
});

const MANUAL_REQUIRED_FIELDS = Object.freeze([
  'providerDeploymentId',
  'publicDeploymentOrigin',
  'deployedAt',
  'deployedRevision',
]);

const PLACEHOLDER_PATTERN = /(?:<[^>]*>|(?:todo|tbd|unknown|placeholder|replace[-_ ]?me|example|sample|dummy|fake|if[-_ ]?available))/i;
const SECRET_PATTERN = /(?:deploy[-_]?hook|receiver|secret|token|credential|bearer|password|private[-_]?key|^dhk_)/i;
const SAFE_REASONS = new Set([
  'explicit_provider_not_detected',
  'provider_unavailable',
  'project_metadata_unavailable',
  'receiver_unavailable',
  'provider_readback_complete',
  'safe_status_code',
]);

function asText(value, max = 512) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (!normalized || normalized.length > max || PLACEHOLDER_PATTERN.test(normalized)) return '';
  return normalized;
}

function asSafeIdentity(value) {
  const normalized = asText(value, 512);
  if (!normalized || SECRET_PATTERN.test(normalized)) return '';
  return normalized;
}

function asPublicUrl(value) {
  const normalized = asText(value, 2_000);
  if (!normalized || SECRET_PATTERN.test(normalized)) return '';
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    return '';
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  if (!parsed.hostname || parsed.hostname.endsWith('.invalid')) return '';
  // Public deployment origins must never be confused with the receiver.
  if (/deploy[-_]?hook/i.test(parsed.pathname)) return '';
  return parsed.toString();
}

function asTimestamp(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString();
  }
  const normalized = asText(value, 128);
  if (!normalized) return '';
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function normalizeProvider(value) {
  const raw = typeof value === 'object' && value !== null
    ? value.provider ?? value.id
    : value;
  if (typeof raw !== 'string') return 'unknown';
  const normalized = raw.trim().toLowerCase();
  if (PROVIDER_IDS.includes(normalized)) return normalized;
  return normalized === 'unknown' ? 'unknown' : 'custom';
}

function firstValue(context, keys) {
  for (const key of keys) {
    if (context && Object.prototype.hasOwnProperty.call(context, key)) {
      const value = context[key];
      if (value !== undefined && value !== null) return value;
    }
  }
  return undefined;
}

function receiptRequirements(context, provider) {
  const requirements = {
    provider,
    environment: 'production',
    status: 'success',
    requiredFields: [...MANUAL_REQUIRED_FIELDS],
  };

  const providerDeploymentId = asSafeIdentity(firstValue(context, [
    'providerDeploymentId', 'deploymentId', 'stableDeploymentId', 'idempotencyKey',
  ]));
  if (providerDeploymentId) requirements.providerDeploymentId = providerDeploymentId;

  const publicDeploymentOrigin = asPublicUrl(firstValue(context, [
    'publicDeploymentOrigin', 'deployUrl', 'publicUrl', 'deploymentUrl',
  ]));
  if (publicDeploymentOrigin) {
    requirements.publicDeploymentOrigin = publicDeploymentOrigin;
    requirements.deployUrl = publicDeploymentOrigin;
  }

  const deployedAt = asTimestamp(firstValue(context, ['deployedAt', 'deploymentTimestamp', 'timestamp']));
  if (deployedAt) requirements.deployedAt = deployedAt;

  const deployedRevision = asSafeIdentity(firstValue(context, [
    'deployedRevision', 'deployHash', 'revision', 'commitSha', 'sha',
  ]));
  if (deployedRevision) {
    requirements.deployedRevision = deployedRevision;
    requirements.deployHash = deployedRevision;
  }

  return requirements;
}

/**
 * Build the redacted, production-only handoff used when no admitted native
 * adapter is available. Only real values supplied by the caller are copied;
 * placeholders and receiver-like values are omitted rather than echoed.
 *
 * @param {Record<string, unknown>} context
 * @returns {Record<string, unknown>}
 */
export function buildManualDeploymentHandoff(context = {}) {
  if (!context || typeof context !== 'object' || Array.isArray(context)) context = {};
  const provider = normalizeProvider(context.provider ?? context.deploymentProvider);
  const summary = buildManualSetupSummary(provider);
  const requirements = receiptRequirements(context, provider);

  return {
    mode: 'manual_setup_required',
    ...summary,
    providerRecipe: MANUAL_PROVIDER_RECIPES[provider] || MANUAL_PROVIDER_RECIPES.custom,
    receiptRequirements: requirements,
  };
}

/**
 * Construct a provider-neutral result without granting an adapter any
 * credentials. `requested` is intentionally explicit so inspect paths can
 * report a read-only result while owner-consented ensure paths report true.
 */
export function buildManualProviderResult({
  provider,
  requested = false,
  status = 'manual_setup_required',
  verification = 'manual_handoff',
  reason,
  ...context
} = {}) {
  const handoff = buildManualDeploymentHandoff({ provider, ...context });
  const manualSetupSummary = buildManualSetupSummary(normalizeProvider(provider));
  return {
    requested: requested === true,
    ...handoff,
    status,
    verification,
    manualSetupSummary,
    ...(typeof reason === 'string' && SAFE_REASONS.has(reason) ? { reason } : {}),
  };
}

export function normalizeManualProvider(value) {
  return normalizeProvider(value);
}

export { MANUAL_REQUIRED_FIELDS };
