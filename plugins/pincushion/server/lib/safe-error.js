import { randomUUID } from 'node:crypto';

// Tool responses cross process and protocol boundaries. Error objects from
// fetch, fs, providers, and database clients can contain URLs, local paths,
// SQL, request bodies, or credentials, so never serialize their message or
// stack into an MCP result.
const SAFE_CODE = /^[a-z][a-z0-9._:-]{2,96}$/;
const SAFE_STATUS = Number.isInteger;

// Error codes are part of the public MCP contract. Keep this an explicit
// vocabulary instead of trusting a syntactically valid value supplied by an
// exception or upstream provider: a provider can put credentials, SQL, or
// request metadata in an `error` field just as easily as in `message`.
const SAFE_ERROR_CODES = new Set([
  'tool_execution_failed',
  'network_error',
  'authoritative_sync_unavailable',
  'local_file_unavailable',
  'provider_unavailable',
  'provider_request_failed',
  'member_add_failed',
  'member_list_failed',
  'member_remove_failed',
  'invite_create_failed',
  'share_report_failed',
  'snapshot_upload_failed',
  'report_generation_failed',
  'collaboration_configure_failed',
  'slack_preferences_failed',
  'slack_install_failed',
  'collaboration_list_failed',
  'slack_claim_failed',
  'collaboration_remove_failed',
  // Provider codes retained because callers use them for deterministic
  // recovery. Their messages are always fixed below.
  'license_required',
  'license_key_required',
  'invalid_license',
  'license_identity_unavailable',
  'project_id_required',
  'project_not_found',
  'not_authorized',
  'seat_limit_reached',
  'editor_seat_limit',
  'system_bot_role_locked',
  'system_bot_remove_blocked',
  'member_operation_failed',
  'not_found',
  'return_to_invalid',
  'invite_creation_failed',
  'shared_report_failed',
  'critique_generation_key_required',
  'critique_capture_provenance_required',
  'critique_receipt_required',
  'page_url_not_registered',
  'unsupported_content_type',
  'invalid_image_content',
  'image_dimensions_mismatch',
  'capture_run_id_and_proof_required',
  'deployment_id_requires_page_capture',
  'deployment_capture_requires_shared_visibility',
  'invalid_content_hash',
  'capture_fingerprint_requires_page_capture',
  'invalid_base64',
  'too_large',
  'content_hash_mismatch',
  'deployment_capture_canonical_context_required',
  'storage_upload_failed',
  'snapshot_version_insert_failed',
  'owner_workspace_receipt_failed',
  'deployment_capture_receipt_failed',
  'snapshot_upsert_failed',
  'snapshot_variant_upsert_failed',
  'screenshot_upload_failed',
  'bound_critique_receipt_immutable',
  'fence_unavailable',
  'server_error',
  'project_id_and_manifest_required',
  'method_not_allowed',
  'generation_key_mismatch',
  'critique_receipt_must_be_minted',
  'slack_app_not_configured',
  'oauth_state_unavailable',
  'no_slack_link',
  'invalid_mute',
  'claim_token_invalid_or_expired',
  'integration_operation_failed',
  'quota_exceeded',
  'duplicate_variant',
  'annotation_dismissed',
  'annotation_invalid',
  'annotation_not_authorized',
  'project_read_only',
  'annotation_deleted',
  'capture_run_start_failed',
  'capture_run_start_invalid_response',
  'capture_run_complete_failed',
  'deployment_discovery_registration_failed',
  'deployment_page_result_failed',
  'complete_failed',
  'frame_refresh_fetch_failed',
  'queue_fetch_failed',
  'capture_run_id_and_proof_required',
  'qa_import_rejected',
  'qa_import_unavailable',
  'qa_import_network_error',
  'qa_import_malformed_response',
]);

// Only these provider values may become an error code in a response. The
// remaining provider vocabulary intentionally collapses to the operation
// fallback so a newly deployed provider cannot expand the MCP contract by
// returning arbitrary text.
const SAFE_PROVIDER_CODES = new Set([
  'license_required',
  'license_key_required',
  'invalid_license',
  'license_identity_unavailable',
  'project_id_required',
  'project_not_found',
  'not_authorized',
  'editor_seat_limit',
  'seat_limit_reached',
  'system_bot_role_locked',
  'system_bot_remove_blocked',
  'member_operation_failed',
  'not_found',
  'return_to_invalid',
  'invite_creation_failed',
  'shared_report_failed',
  'critique_generation_key_required',
  'critique_capture_provenance_required',
  'critique_receipt_required',
  'page_url_not_registered',
  'unsupported_content_type',
  'invalid_image_content',
  'image_dimensions_mismatch',
  'capture_run_id_and_proof_required',
  'deployment_id_requires_page_capture',
  'deployment_capture_requires_shared_visibility',
  'invalid_content_hash',
  'capture_fingerprint_requires_page_capture',
  'invalid_base64',
  'too_large',
  'content_hash_mismatch',
  'deployment_capture_canonical_context_required',
  'storage_upload_failed',
  'snapshot_version_insert_failed',
  'owner_workspace_receipt_failed',
  'deployment_capture_receipt_failed',
  'snapshot_upsert_failed',
  'snapshot_variant_upsert_failed',
  'screenshot_upload_failed',
  'bound_critique_receipt_immutable',
  'fence_unavailable',
  'server_error',
  'project_id_and_manifest_required',
  'method_not_allowed',
  'generation_key_mismatch',
  'critique_receipt_must_be_minted',
  'slack_app_not_configured',
  'oauth_state_unavailable',
  'no_slack_link',
  'invalid_mute',
  'claim_token_invalid_or_expired',
  'integration_operation_failed',
  'quota_exceeded',
  'duplicate_variant',
  'annotation_dismissed',
  'annotation_invalid',
  'annotation_not_authorized',
  'project_read_only',
  'annotation_deleted',
  'capture_run_id_and_proof_required',
]);

const DEFAULT_MESSAGES = Object.freeze({
  tool_execution_failed: 'The requested operation could not be completed.',
  network_error: 'The remote service could not be reached.',
  authoritative_sync_unavailable: 'Authoritative Pincushion sync is unavailable.',
  local_file_unavailable: 'The requested local file is unavailable.',
  provider_unavailable: 'The external provider is unavailable.',
  provider_request_failed: 'The Pincushion service rejected the request.',
  no_slack_link: 'No Slack account is linked to this Pincushion account.',
  claim_token_invalid_or_expired: 'The Slack claim token is invalid or expired.',
  editor_seat_limit: 'The project has reached its editor seat limit.',
  seat_limit_reached: 'The project has reached its editor seat limit.',
  project_read_only: 'This project is read-only because your plan includes fewer projects than you have. Upgrade at https://www.pincushion.io/pricing?ref=mcp-read-only, or choose which project stays active at https://www.pincushion.io/app. Nothing was deleted.',
});
const SAFE_MESSAGES = new Set([
  ...Object.values(DEFAULT_MESSAGES),
  'The requested image file could not be read.',
  'The critique queue could not be reached.',
]);

function normalizedCode(value, fallback) {
  const candidate = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return SAFE_CODE.test(candidate) && SAFE_ERROR_CODES.has(candidate) ? candidate : fallback;
}

/**
 * Return a bounded, protocol-safe error object without copying exception data.
 * The request id is intentionally opaque and is the only diagnostic handle
 * exposed to callers; full exception details remain in the configured monitor.
 */
export function safeErrorResponse(error, {
  code = null,
  status = null,
  retryable = false,
  message = null,
  requestId = null,
} = {}) {
  const fallback = 'tool_execution_failed';
  const safeCode = normalizedCode(code || error?.code, fallback);
  const response = {
    error: safeCode,
    message: typeof message === 'string' && SAFE_MESSAGES.has(message.trim())
      ? message.trim()
      : (DEFAULT_MESSAGES[safeCode] || DEFAULT_MESSAGES[fallback]),
    requestId: typeof requestId === 'string' && requestId.trim()
      ? requestId.trim().slice(0, 96)
      : randomUUID(),
    retryable: retryable === true,
  };
  if (SAFE_STATUS(status) && status >= 400 && status <= 599) response.status = status;
  return response;
}

export function safeErrorText(error, options = {}) {
  return JSON.stringify(safeErrorResponse(error, options));
}

/**
 * Convert a provider response into the bounded MCP error contract. Provider
 * payloads are untrusted, including their `error`, `message`, and auxiliary
 * fields; only a small allowlist of stable codes is retained.
 */
export function safeProviderError(data, status, {
  fallback = 'provider_request_failed',
  retryable = false,
  requestId = null,
} = {}) {
  const rawCode = typeof data?.error === 'string' ? data.error.trim().toLowerCase() : '';
  const safeFallback = SAFE_ERROR_CODES.has(fallback) ? fallback : 'provider_request_failed';
  const code = SAFE_PROVIDER_CODES.has(rawCode) ? rawCode : safeFallback;
  return safeErrorResponse({ code }, {
    code,
    status,
    retryable,
    requestId,
  });
}

export const SAFE_ERROR_CODE_PATTERN = SAFE_CODE.source;
export const SAFE_ERROR_CODE_ALLOWLIST = Object.freeze([...SAFE_ERROR_CODES]);
export const SAFE_PROVIDER_ERROR_CODE_ALLOWLIST = Object.freeze([...SAFE_PROVIDER_CODES]);
