/**
 * Provider-neutral deployment setup contracts.
 *
 * This module deliberately contains no provider calls. It is the local boundary
 * between provider adapters and the MCP response: only the small, redacted state
 * described here may cross that boundary.
 */

/** @typedef {'vercel'|'netlify'|'render'|'railway'|'github'|'github-actions'|'fly'|'docker'|'cloudflare'|'aws'|'custom'|'unknown'} ProviderId */
/** @typedef {'configured'|'already_configured'|'manual_setup_required'|'unsupported_provider_api'|'ambiguous_provider'|'conflict'|'degraded'} ProviderSetupStatus */
/** @typedef {'provider_readback'|'manual_handoff'|'candidate_detection'|'none'} ProviderSetupVerification */
/** @typedef {'pending'|'accepted'} FirstProductionReceiptState */
/** @typedef {'native_webhook'|'authenticated_normalized_submission'} IngestionMode */
/** @typedef {'provider_signature'|'receiver_bearer'} AuthenticationMethod */
/** @typedef {'provider_verified'|'authenticated_submitter'} AssuranceLevel */
/**
 * @typedef {Object} ProviderSetupResult
 * @property {boolean} requested - true only after explicit `deploymentAutomation: "auto"` consent.
 * @property {ProviderId} [provider]
 * @property {ProviderSetupStatus} status
 * @property {ProviderSetupVerification} [verification]
 * @property {FirstProductionReceiptState} [firstProductionReceipt]
 * @property {IngestionMode} [ingestionMode]
 * @property {AuthenticationMethod} [authenticationMethod]
 * @property {AssuranceLevel} [assuranceLevel]
 * @property {boolean} [writesPerformed]
 * @property {boolean} [ownerAuthorizationRequired]
 * @property {string} [reason] - machine-readable, non-sensitive reason code only.
 */
/**
 * @typedef {Object} ManualSetupSummary
 * @property {'manual_setup_required'} status
 * @property {ProviderId} provider
 * @property {false} writesPerformed
 * @property {true} ownerAuthorizationRequired
 * @property {'authenticated_normalized_submission'} ingestionMode
 * @property {'receiver_bearer'} authenticationMethod
 * @property {'authenticated_submitter'} assuranceLevel
 */

/**
 * The IDs are an array rather than a free-form string so detection and explicit
 * selection can share one allow-list. Keep this list frozen: adapters may only be
 * added deliberately, with a contract and tests of their own.
 *
 * @type {readonly ProviderId[]}
 */
export const PROVIDER_IDS = Object.freeze([
  'vercel',
  'netlify',
  'render',
  'railway',
  'github',
  'github-actions',
  'fly',
  'docker',
  'cloudflare',
  'aws',
  'custom',
  'unknown',
]);

/** @type {Readonly<Record<string, ProviderId>>} */
export const PROVIDER_ID = Object.freeze({
  VERCEL: 'vercel',
  NETLIFY: 'netlify',
  RENDER: 'render',
  RAILWAY: 'railway',
  GITHUB: 'github',
  GITHUB_ACTIONS: 'github-actions',
  FLY: 'fly',
  DOCKER: 'docker',
  CLOUDFLARE: 'cloudflare',
  AWS: 'aws',
  CUSTOM: 'custom',
  UNKNOWN: 'unknown',
});

/** @type {readonly ProviderSetupStatus[]} */
export const ALLOWED_PROVIDER_SETUP_STATES = Object.freeze([
  'configured',
  'already_configured',
  'manual_setup_required',
  'unsupported_provider_api',
  'ambiguous_provider',
  'conflict',
  'degraded',
]);

// Naming aliases keep the contract easy to consume from adapters without
// allowing each adapter to invent a subtly different state list.
export const ALLOWED_SETUP_STATES = ALLOWED_PROVIDER_SETUP_STATES;
export const PROVIDERS = PROVIDER_IDS;

/** @type {Readonly<Record<string, ProviderSetupStatus>>} */
export const PROVIDER_SETUP_STATES = Object.freeze({
  CONFIGURED: 'configured',
  ALREADY_CONFIGURED: 'already_configured',
  MANUAL_SETUP_REQUIRED: 'manual_setup_required',
  UNSUPPORTED_PROVIDER_API: 'unsupported_provider_api',
  AMBIGUOUS_PROVIDER: 'ambiguous_provider',
  CONFLICT: 'conflict',
  DEGRADED: 'degraded',
});

/**
 * Public setup reasons are exact contract values, not a free-form diagnostic
 * channel. Keep this list in sync with the provider adapter and setup paths.
 */
export const ALLOWED_PROVIDER_SETUP_REASONS = Object.freeze([
  'provider_readback_complete',
  'safe_status_code',
  'explicit_provider_not_detected',
  'missing_project_metadata',
  'cli_unavailable',
  'cli_auth_unavailable',
  'webhook_list_unavailable',
  'conflicting_existing_webhook',
  'verification_failed',
  'create_failed',
  'receiver_unavailable',
  'project_metadata_unavailable',
  'provider_unavailable',
  'vercel_not_detected',
]);

const ALLOWED_PROVIDER_SETUP_REASON_SET = new Set(ALLOWED_PROVIDER_SETUP_REASONS);
const MANUAL_AGENT_INSTRUCTION = 'After explicit owner approval, add the production receipt only after the real production deploy succeeds.';
const MANUAL_STATUS = 'manual_setup_required';
const MANUAL_VERIFICATION = 'manual_handoff';
const MANUAL_INGESTION_MODE = 'authenticated_normalized_submission';
const MANUAL_AUTHENTICATION_METHOD = 'receiver_bearer';
const MANUAL_ASSURANCE_LEVEL = 'authenticated_submitter';
const MANUAL_REQUIRED_FIELDS = Object.freeze([
  'providerDeploymentId',
  'publicDeploymentOrigin',
  'deployedAt',
  'deployedRevision',
]);
const SAFE_REQUIRED_FIELDS = new Set([
  'providerDeploymentId',
  'publicDeploymentOrigin',
  'deployedAt',
  'deployedRevision',
  'deployUrl',
  'deployHash',
]);

function safeMachineCode(value) {
  return typeof value === 'string' && ALLOWED_PROVIDER_SETUP_REASON_SET.has(value) ? value : undefined;
}

function safeBoolean(value) {
  return typeof value === 'boolean' ? value : undefined;
}

function safeEnum(value, values) {
  return values.includes(value) ? value : undefined;
}

function projectReceiptRequirements(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const output = {};
  const provider = normalizeProvider(value.provider);
  if (provider) output.provider = provider;
  if (value.environment === 'production') output.environment = 'production';
  if (value.status === 'success') output.status = 'success';
  if (Array.isArray(value.requiredFields)) {
    const requiredFields = value.requiredFields
      .filter((field) => typeof field === 'string' && SAFE_REQUIRED_FIELDS.has(field));
    if (requiredFields.length) output.requiredFields = [...new Set(requiredFields)];
  }
  return Object.keys(output).length ? output : undefined;
}

function normalizeRequested(result) {
  if (result.requested === 'auto' || result.deploymentAutomation === 'auto') return true;
  return result.requested;
}

function normalizeProvider(provider) {
  return typeof provider === 'string' && PROVIDER_IDS.includes(provider) ? provider : undefined;
}

const MANUAL_RECIPES = Object.freeze({
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

const ALLOWED_PROVIDER_RECIPE_SET = new Set(Object.values(MANUAL_RECIPES));

/**
 * Project a nested manual handoff from fixed, truthful constants. This is
 * intentionally not recursive: an adapter cannot override the manual status,
 * assurance, write, authorization, or instruction fields with nested values.
 *
 * @param {unknown} value
 * @param {ProviderId|undefined} fallbackProvider
 * @param {ProviderSetupStatus|undefined} fallbackStatus
 * @returns {Record<string, unknown>|undefined}
 */
function projectManualSetupSummary(value, fallbackProvider, fallbackStatus) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  if (fallbackStatus !== MANUAL_STATUS && fallbackStatus !== 'unsupported_provider_api') return undefined;

  // The outer result is authoritative. A nested provider is only a fallback
  // for legacy/manual results that did not carry one at the top level; it must
  // never relabel a valid outer provider's recipe or receipt contract.
  const provider = normalizeProvider(fallbackProvider) || normalizeProvider(value.provider);
  if (!provider) return undefined;

  return {
    status: MANUAL_STATUS,
    provider,
    verification: MANUAL_VERIFICATION,
    writesPerformed: false,
    ownerAuthorizationRequired: true,
    agentInstruction: MANUAL_AGENT_INSTRUCTION,
    providerRecipe: MANUAL_RECIPES[provider] || MANUAL_RECIPES.custom,
    ingestionMode: MANUAL_INGESTION_MODE,
    authenticationMethod: MANUAL_AUTHENTICATION_METHOD,
    assuranceLevel: MANUAL_ASSURANCE_LEVEL,
    receiptRequirements: {
      provider,
      environment: 'production',
      status: 'success',
      requiredFields: [...MANUAL_REQUIRED_FIELDS],
    },
  };
}

/**
 * Return the public, JSON-safe projection of an adapter result. `auto` is an
 * input consent value, not a response state, so it is emitted as `requested: true`.
 *
 * @param {Record<string, unknown>} result
 * @returns {Record<string, unknown>}
 */
export function redactProviderResult(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return {};

  const source = result;
  const output = {};
  const requested = normalizeRequested(source);
  if (requested === true || requested === false) output.requested = requested;

  const provider = normalizeProvider(source.provider);
  if (provider) output.provider = provider;

  const status = safeEnum(source.status, ALLOWED_PROVIDER_SETUP_STATES);
  if (status) output.status = status;

  const verification = safeEnum(source.verification, ['provider_readback', 'manual_handoff', 'candidate_detection', 'none']);
  if (verification) output.verification = verification;

  const firstProductionReceipt = safeEnum(
    source.firstProductionReceipt ?? source.firstEventVerification,
    ['pending', 'accepted'],
  );
  if (firstProductionReceipt) output.firstProductionReceipt = firstProductionReceipt;

  const ingestionMode = safeEnum(source.ingestionMode, ['native_webhook', 'authenticated_normalized_submission']);
  if (ingestionMode) output.ingestionMode = ingestionMode;

  const authenticationMethod = safeEnum(source.authenticationMethod, ['provider_signature', 'receiver_bearer']);
  if (authenticationMethod) output.authenticationMethod = authenticationMethod;

  const assuranceLevel = safeEnum(source.assuranceLevel, ['provider_verified', 'authenticated_submitter']);
  if (assuranceLevel) output.assuranceLevel = assuranceLevel;

  const writesPerformed = safeBoolean(source.writesPerformed);
  if (writesPerformed !== undefined) output.writesPerformed = writesPerformed;
  const ownerAuthorizationRequired = safeBoolean(source.ownerAuthorizationRequired);
  if (ownerAuthorizationRequired !== undefined) output.ownerAuthorizationRequired = ownerAuthorizationRequired;

  for (const key of ['reason', 'safeReason', 'errorCode', 'safeErrorCode']) {
    const value = safeMachineCode(source[key]);
    if (value !== undefined) output[key] = value;
  }

  if (source.agentInstruction === MANUAL_AGENT_INSTRUCTION) {
    output.agentInstruction = MANUAL_AGENT_INSTRUCTION;
  }
  if (typeof source.providerRecipe === 'string' && ALLOWED_PROVIDER_RECIPE_SET.has(source.providerRecipe)) {
    output.providerRecipe = source.providerRecipe;
  }

  const receiptRequirements = projectReceiptRequirements(source.receiptRequirements);
  if (receiptRequirements) output.receiptRequirements = receiptRequirements;

  const manualSetupSummary = projectManualSetupSummary(source.manualSetupSummary, provider, status);
  if (manualSetupSummary) output.manualSetupSummary = manualSetupSummary;

  return output;
}

/**
 * JSON serialization boundary for callers that need a string. The value is
 * redacted before JSON.stringify so no raw adapter result is ever serialized.
 *
 * @param {Record<string, unknown>} result
 * @returns {string}
 */
export function serializeProviderResult(result) {
  return JSON.stringify(redactProviderResult(result));
}

const VERIFIED_DEFAULTS = Object.freeze({
  verification: 'provider_readback',
  firstProductionReceipt: 'pending',
  ingestionMode: 'native_webhook',
  authenticationMethod: 'provider_signature',
  assuranceLevel: 'provider_verified',
});

const MANUAL_DEFAULTS = Object.freeze({
  writesPerformed: false,
  ownerAuthorizationRequired: true,
  ingestionMode: 'authenticated_normalized_submission',
  authenticationMethod: 'receiver_bearer',
  assuranceLevel: 'authenticated_submitter',
});

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

/**
 * Validate and normalize a provider setup result. The return value is already
 * redacted and is suitable for an MCP response. This is intentionally a small
 * runtime validator rather than a provider adapter: it performs no I/O.
 *
 * @param {Record<string, unknown>} input
 * @returns {Record<string, unknown>}
 */
export function assertProviderSetupResult(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('provider setup result must be an object');
  }
  const redacted = redactProviderResult(input);
  const requested = normalizeRequested(input);
  if (requested !== true) {
    throw new TypeError('provider setup result requested must be true or deploymentAutomation must be "auto"');
  }
  const status = redacted.status;
  if (!ALLOWED_PROVIDER_SETUP_STATES.includes(status)) {
    throw new TypeError(`provider setup result status must be one of: ${ALLOWED_PROVIDER_SETUP_STATES.join(', ')}`);
  }

  const provider = normalizeProvider(redacted.provider);
  if (!['ambiguous_provider', 'unsupported_provider_api'].includes(status) && !provider) {
    throw new TypeError('provider setup result provider must be a known provider ID');
  }

  let output = { ...redacted, requested: true };
  if (provider) output.provider = provider;

  if (status === 'configured' || status === 'already_configured') {
    for (const [key, expected] of Object.entries(VERIFIED_DEFAULTS)) {
      if (output[key] !== expected) {
        throw new TypeError(`provider setup result ${key} must be ${expected} for ${status}`);
      }
    }
  }

  if (status === 'manual_setup_required' || status === 'unsupported_provider_api') {
    for (const [key, expected] of Object.entries(MANUAL_DEFAULTS)) {
      if (output[key] !== expected) {
        throw new TypeError(`provider setup result ${key} must be ${expected} for ${status}`);
      }
    }
  }

  if (status === 'ambiguous_provider' || status === 'conflict' || status === 'degraded') {
    if (hasOwn(output, 'assuranceLevel') && output.assuranceLevel === 'provider_verified') {
      throw new TypeError(`provider setup result ${status} cannot claim provider verification`);
    }
  }

  return output;
}

/**
 * Build the editor-readable manual setup summary. It intentionally contains no
 * receiver URL, deploy-hook token, signing secret, or provider payload. A future
 * owner-only setup response may carry those ephemeral values separately.
 *
 * @param {ProviderId|string} provider
 * @returns {Record<string, unknown>}
 */
export function buildManualSetupSummary(provider) {
  const normalizedProvider = normalizeProvider(provider) || 'custom';
  return {
    status: MANUAL_STATUS,
    provider: normalizedProvider,
    verification: MANUAL_VERIFICATION,
    writesPerformed: false,
    ownerAuthorizationRequired: true,
    agentInstruction: MANUAL_AGENT_INSTRUCTION,
    providerRecipe: MANUAL_RECIPES[normalizedProvider] || MANUAL_RECIPES.custom,
    ingestionMode: MANUAL_INGESTION_MODE,
    authenticationMethod: MANUAL_AUTHENTICATION_METHOD,
    assuranceLevel: MANUAL_ASSURANCE_LEVEL,
    receiptRequirements: {
      provider: normalizedProvider,
      environment: 'production',
      status: 'success',
      requiredFields: [...MANUAL_REQUIRED_FIELDS],
    },
  };
}

function candidateProvider(candidate) {
  if (typeof candidate === 'string') return candidate;
  if (candidate && typeof candidate === 'object') {
    if (typeof candidate.provider === 'string') return candidate.provider;
    if (typeof candidate.id === 'string') return candidate.id;
  }
  return undefined;
}

/**
 * Select exactly one detected provider. No provider is guessed when detection is
 * empty or ambiguous; an explicit selection must exactly match a detected,
 * allow-listed candidate.
 *
 * @param {unknown[]|undefined} candidates
 * @param {string|undefined} explicitProvider
 * @returns {{provider: ProviderId}|{status: ProviderSetupStatus, candidates?: ProviderId[], reason?: string}}
 */
export function selectProviderCandidate(candidates, explicitProvider) {
  const detected = Array.isArray(candidates)
    ? [...new Set(candidates.map(candidateProvider).filter((provider) => PROVIDER_IDS.includes(provider)))]
    : [];

  if (explicitProvider !== undefined) {
    if (typeof explicitProvider !== 'string' || !PROVIDER_IDS.includes(explicitProvider)) {
      return { status: 'unsupported_provider_api', reason: 'explicit_provider_not_detected' };
    }
    if (!detected.includes(explicitProvider)) {
      return { status: 'unsupported_provider_api', reason: 'explicit_provider_not_detected' };
    }
    return { provider: explicitProvider };
  }

  if (detected.length === 1) return { provider: detected[0] };
  if (detected.length > 1) return { status: 'ambiguous_provider' };
  return { status: 'unsupported_provider_api' };
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
export function isProviderSetupResult(value) {
  try {
    assertProviderSetupResult(value);
    return true;
  } catch {
    return false;
  }
}
