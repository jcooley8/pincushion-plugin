// Pure QA-result normalization for the Release 4 import path.
//
// This module intentionally does not read files, fetch URLs, call providers,
// or make authorization decisions. It accepts already-parsed JSON supplied by
// an authenticated caller, turns the two supported result shapes into a small
// bounded record set, and computes the identity used by the server-side
// deduplication constraint:
//
//   project + canonical page + device + rule + target
//
// A passed observation is data, not a verification receipt. The Edge function
// stores it separately and never uses it to resolve or verify a pin.

import { createHash } from 'node:crypto';

export const QA_IMPORT_LIMITS = Object.freeze({
  payloadBytes: 512 * 1024,
  maxFindings: 200,
  maxSourceChars: 128,
  maxRunIdChars: 128,
  maxFormatVersionChars: 64,
  maxProjectIdChars: 160,
  maxPageUrlChars: 2048,
  maxDeviceChars: 32,
  maxRuleChars: 256,
  maxTargetChars: 2048,
  maxMessageChars: 4096,
  maxSeverityChars: 16,
  maxMetadataBytes: 8 * 1024,
});

const FORMATS = new Set(['axe', 'playwright']);
const DEVICES = new Set(['desktop', 'mobile', 'tablet', 'unknown']);
const OUTCOMES = new Set(['failed', 'passed', 'inconclusive', 'skipped']);
const SEVERITIES = new Set(['critical', 'high', 'medium', 'low', 'info', 'unknown']);
export const QA_IDENTITY_SEPARATOR = '\u001f';
const HEX_SHA = /^[a-f0-9]{40,64}$/i;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function fail(error, details = {}) {
  return { ok: false, error, ...details };
}

function success(value) {
  return { ok: true, value };
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function text(value, max, field, { required = false } = {}) {
  if (typeof value !== 'string') return required ? fail(`${field}_required`) : null;
  const valueTrimmed = value.trim();
  if (!valueTrimmed && required) return fail(`${field}_required`);
  if (valueTrimmed.length > max) return fail(`${field}_too_long`, { max });
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(valueTrimmed)) {
    return fail(`${field}_contains_control_character`);
  }
  return valueTrimmed;
}

function bytes(value) {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// Stable JSON is deliberately tiny and local. It is used only for digests and
// identities; it is not intended to be a general canonical-JSON standard.
export function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (!isPlainObject(value)) throw new Error('non_plain_json_value');
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

export function sha256Hex(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

export function canonicalPageUrl(value) {
  const checked = text(value, QA_IMPORT_LIMITS.maxPageUrlChars, 'page_url', { required: true });
  if (typeof checked !== 'string') return checked;
  let parsed;
  try {
    parsed = new URL(checked);
  } catch {
    return fail('page_url_invalid');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return fail('page_url_protocol_invalid');
  if (!parsed.hostname || parsed.username || parsed.password) return fail('page_url_authority_invalid');
  parsed.hostname = parsed.hostname.toLowerCase();
  if ((parsed.protocol === 'http:' && parsed.port === '80') || (parsed.protocol === 'https:' && parsed.port === '443')) parsed.port = '';
  parsed.hash = '';
  // Query order is not semantically meaningful for the identity. Preserve
  // values, but sort the pairs so replays from different serializers collide.
  parsed.searchParams.sort();
  parsed.pathname = parsed.pathname.replace(/\/+/g, '/');
  if (parsed.pathname.length > 1) parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  const output = parsed.toString();
  return output.endsWith('/') && parsed.pathname === '/' && !parsed.search ? output.slice(0, -1) : output;
}

function normalizeDevice(value) {
  const checked = text(value, QA_IMPORT_LIMITS.maxDeviceChars, 'device', { required: true });
  if (typeof checked !== 'string') return checked;
  const aliases = { phone: 'mobile', handset: 'mobile', pc: 'desktop', laptop: 'desktop' };
  const device = aliases[checked.toLowerCase()] || checked.toLowerCase();
  return DEVICES.has(device) ? device : fail('device_invalid', { allowed: [...DEVICES] });
}

function normalizeFormat(value) {
  const checked = text(value, 32, 'format', { required: true });
  if (typeof checked !== 'string') return checked;
  const aliases = { 'axe-core': 'axe', 'axe-json': 'axe', 'playwright-json': 'playwright', 'playwright-test': 'playwright' };
  const format = aliases[checked.toLowerCase()] || checked.toLowerCase();
  return FORMATS.has(format) ? format : fail('format_unsupported', { allowed: [...FORMATS] });
}

function normalizeOutcome(value, fallback = 'inconclusive') {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const aliases = {
    violation: 'failed', violations: 'failed', fail: 'failed', error: 'failed',
    unexpected: 'failed', timedout: 'failed', 'timed-out': 'failed',
    pass: 'passed', success: 'passed', expected: 'passed',
    incomplete: 'inconclusive', unknown: 'inconclusive',
    skip: 'skipped', skipped: 'skipped', disabled: 'skipped',
  };
  return aliases[raw] || (OUTCOMES.has(raw) ? raw : fallback);
}

function normalizeSeverity(value) {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : '';
  const aliases = { serious: 'high', moderate: 'medium', minor: 'low', none: 'info' };
  const severity = aliases[raw] || raw || 'unknown';
  return SEVERITIES.has(severity) ? severity : 'unknown';
}

function normalizeTarget(value, field = 'target') {
  const values = [];
  const flatten = (candidate, depth = 0) => {
    if (depth > 8 || values.length > 128) throw new Error('target_nesting_too_deep');
    if (Array.isArray(candidate)) {
      for (const nested of candidate) flatten(nested, depth + 1);
      return;
    }
    values.push(candidate);
  };
  try {
    flatten(value);
  } catch {
    return fail(`${field}_invalid`);
  }
  const parts = [];
  for (const candidate of values) {
    if (typeof candidate !== 'string') return fail(`${field}_invalid`);
    const checked = candidate.trim();
    if (!checked || checked.length > QA_IMPORT_LIMITS.maxTargetChars) return fail(`${field}_invalid`);
    if (/[\u0000-\u001f]/.test(checked)) return fail(`${field}_contains_control_character`);
    parts.push(checked);
  }
  const unique = [...new Set(parts)].sort();
  if (!unique.length) return fail(`${field}_required`);
  const joined = unique.join(' || ');
  return joined.length <= QA_IMPORT_LIMITS.maxTargetChars
    ? joined
    : fail(`${field}_too_long`, { max: QA_IMPORT_LIMITS.maxTargetChars });
}

function firstText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function validateObservedUrl(value, expectedPageUrl) {
  if (value === undefined || value === null || value === '') return null;
  const observed = canonicalPageUrl(value);
  if (typeof observed !== 'string') return observed;
  return observed === expectedPageUrl ? null : fail('result_page_mismatch', { observedPageUrl: observed });
}

function boundedMessage(value, fallback) {
  // A missing diagnostic is filled with a bounded deterministic fallback, but
  // a supplied value must remain strict. Silently replacing an oversized or
  // non-string message would make the stored receipt differ from the result
  // the caller actually reported.
  if (value !== undefined && value !== null && typeof value !== 'string') return fail('message_invalid');
  const candidate = value === undefined || value === null ? fallback : value;
  const checked = text(candidate, QA_IMPORT_LIMITS.maxMessageChars, 'message', { required: true });
  return checked;
}

function finding({ rule, target, outcome, severity, message, sourceIndex, observedUrl = null, metadata = null }) {
  const normalizedRule = text(rule, QA_IMPORT_LIMITS.maxRuleChars, 'rule', { required: true });
  if (typeof normalizedRule !== 'string') return normalizedRule;
  const normalizedTarget = normalizeTarget(target);
  if (typeof normalizedTarget !== 'string') return normalizedTarget;
  const normalizedMessage = boundedMessage(message, `${normalizedRule} reported ${outcome}.`);
  if (typeof normalizedMessage !== 'string') return normalizedMessage;
  return {
    rule: normalizedRule,
    target: normalizedTarget,
    outcome: normalizeOutcome(outcome),
    severity: normalizeSeverity(severity),
    message: normalizedMessage,
    sourceIndex,
    ...(observedUrl ? { observedUrl } : {}),
    ...(metadata && isPlainObject(metadata) ? { metadata } : {}),
  };
}

function axeNodes(item, sourceIndex, outcome, pageUrl) {
  if (!isPlainObject(item)) return fail('axe_record_invalid', { sourceIndex });
  const nodes = Array.isArray(item.nodes) ? item.nodes : [];
  const effectiveNodes = nodes.length ? nodes : [item];
  const out = [];
  for (let nodeIndex = 0; nodeIndex < effectiveNodes.length; nodeIndex += 1) {
    const node = effectiveNodes[nodeIndex];
    if (!isPlainObject(node)) return fail('axe_node_invalid', { sourceIndex, nodeIndex });
    const urlFailure = validateObservedUrl(item.url || node.url, pageUrl);
    if (urlFailure) return urlFailure;
    const candidateTarget = node.target ?? item.target;
    // axe commonly emits inapplicable rules with an empty nodes array. Keep
    // that skipped observation attributable to the rule/document scope rather
    // than rejecting an otherwise valid run. A failed or inconclusive record
    // still requires an explicit element target so malformed failures cannot
    // create misleading pins.
    const hasTarget = Array.isArray(candidateTarget)
      ? candidateTarget.length > 0
      : typeof candidateTarget === 'string' && candidateTarget.trim().length > 0;
    const target = hasTarget || (outcome !== 'passed' && outcome !== 'skipped')
      ? candidateTarget
      : 'document';
    const record = finding({
      rule: item.id,
      target,
      outcome,
      severity: item.impact,
      // Preserve the first supplied diagnostic value so boundedMessage can
      // reject malformed/oversized strings instead of silently falling back.
      // Missing values still receive the deterministic rule/outcome fallback.
      message: node.failureSummary ?? item.help ?? item.description,
      sourceIndex: `${sourceIndex}.${nodeIndex}`,
      metadata: { help: firstText(item.help), description: firstText(item.description) },
    });
    if (!record || record.ok === false) return record || fail('axe_record_invalid', { sourceIndex, nodeIndex });
    out.push(record);
  }
  return out;
}

function parseAxe(results, pageUrl) {
  if (!isPlainObject(results)) return fail('axe_results_object_required');
  const fields = ['violations', 'passes', 'incomplete', 'inapplicable'];
  if (!fields.some((key) => Array.isArray(results[key]))) return fail('axe_results_array_required');
  const out = [];
  for (const [key, outcome] of [['violations', 'failed'], ['passes', 'passed'], ['incomplete', 'inconclusive'], ['inapplicable', 'skipped']]) {
    // Once one recognized axe array establishes the format, omitted recognized
    // result groups mean no observations for that group. This preserves a
    // valid `violations: []` all-clear payload without treating an arbitrary
    // object as axe output.
    const entries = Array.isArray(results[key]) ? results[key] : [];
    for (let index = 0; index < entries.length; index += 1) {
      const rows = axeNodes(entries[index], `${key}[${index}]`, outcome, pageUrl);
      if (!Array.isArray(rows)) return rows;
      out.push(...rows);
      if (out.length > QA_IMPORT_LIMITS.maxFindings) return fail('finding_count_exceeded', { max: QA_IMPORT_LIMITS.maxFindings });
    }
  }
  return out;
}

function playwrightError(test) {
  if (isPlainObject(test.error)) return firstText(test.error.message, test.error.name);
  if (Array.isArray(test.errors)) {
    for (const error of test.errors) if (isPlainObject(error) && firstText(error.message)) return firstText(error.message);
  }
  if (Array.isArray(test.results)) {
    for (const result of test.results) {
      if (isPlainObject(result?.error) && firstText(result.error.message)) return firstText(result.error.message);
      if (Array.isArray(result?.errors)) for (const error of result.errors) if (isPlainObject(error) && firstText(error.message)) return firstText(error.message);
    }
  }
  return '';
}

function playwrightStatus(test) {
  const raw = firstText(test.outcome, test.status, test.expected ? 'expected' : '', test.results?.at?.(-1)?.status);
  return normalizeOutcome(raw, 'inconclusive');
}

function playwrightRecord(test, context, sourceIndex, expectedPageUrl) {
  if (!isPlainObject(test)) return fail('playwright_record_invalid', { sourceIndex });
  const title = firstText(test.title, test.name, context.title);
  const file = firstText(test.file, context.file);
  const location = isPlainObject(test.location) ? [test.location.file || file, test.location.line, test.location.column].filter((value) => value !== undefined && value !== null && value !== '').join(':') : '';
  const rule = firstText(test.ruleId, test.testId, test.id, title, file);
  const target = (test.target ?? test.selector ?? test.locator ?? location) || `${file}:${title}`;
  const observedUrl = test.url || context.url;
  const urlFailure = validateObservedUrl(observedUrl, expectedPageUrl);
  if (urlFailure) return urlFailure;
  const outcome = playwrightStatus(test);
  const record = finding({
    rule,
    target,
    outcome,
    severity: outcome === 'failed' ? 'high' : 'unknown',
    message: playwrightError(test) || title || 'Playwright test result',
    sourceIndex,
    observedUrl: observedUrl ? canonicalPageUrl(observedUrl) : null,
    metadata: { title, file, location },
  });
  return record && record.ok === false ? record : record;
}

function collectPlaywrightTests(value, context = {}, expectedPageUrl, path = 'root', depth = 0, out = []) {
  if (depth > 20) return fail('playwright_nesting_too_deep');
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const result = collectPlaywrightTests(value[index], context, expectedPageUrl, `${path}[${index}]`, depth + 1, out);
      if (result && result.ok === false) return result;
    }
    return out;
  }
  if (!isPlainObject(value)) return out;
  const nextContext = {
    title: firstText(value.title, context.title),
    file: firstText(value.file, context.file),
    url: firstText(value.url, context.url),
  };
  if (Array.isArray(value.tests)) {
    for (let index = 0; index < value.tests.length; index += 1) {
      const record = playwrightRecord(value.tests[index], nextContext, `${path}.tests[${index}]`, expectedPageUrl);
      if (record && record.ok === false) return record;
      out.push(record);
    }
  }
  if (Array.isArray(value.specs)) {
    for (const spec of value.specs) {
      const result = collectPlaywrightTests({ ...spec, title: firstText(spec?.title, nextContext.title), file: nextContext.file, url: nextContext.url }, nextContext, expectedPageUrl, path, depth + 1, out);
      if (result && result.ok === false) return result;
    }
  }
  if (Array.isArray(value.suites)) {
    const result = collectPlaywrightTests(value.suites, nextContext, expectedPageUrl, `${path}.suites`, depth + 1, out);
    if (result && result.ok === false) return result;
  }
  // A flat Playwright export may use `results` as test records. Do not inspect
  // arbitrary object keys: only this documented array is accepted.
  if (Array.isArray(value.results) && !Array.isArray(value.tests)) {
    for (let index = 0; index < value.results.length; index += 1) {
      const record = playwrightRecord(value.results[index], nextContext, `${path}.results[${index}]`, expectedPageUrl);
      if (record && record.ok === false) return record;
      out.push(record);
    }
  }
  if (out.length > QA_IMPORT_LIMITS.maxFindings) return fail('finding_count_exceeded', { max: QA_IMPORT_LIMITS.maxFindings });
  return out;
}

function parsePlaywright(results, pageUrl) {
  if (!isPlainObject(results)) return fail('playwright_results_object_required');
  const out = collectPlaywrightTests(results, { url: firstText(results.url) }, pageUrl);
  if (!Array.isArray(out)) return out;
  if (!out.length) return fail('playwright_tests_required');
  // Revalidate records against the request page after recursive collection.
  for (const record of out) {
    if (record.observedUrl && record.observedUrl !== pageUrl) return fail('result_page_mismatch', { observedPageUrl: record.observedUrl });
  }
  return out;
}

const OUTCOME_PRIORITY = { passed: 0, skipped: 1, inconclusive: 2, failed: 3 };

export function qaFindingIdentity({ projectId, pageUrl, device, rule, target }) {
  const tuple = [String(projectId), String(pageUrl), String(device), String(rule), String(target)];
  // U+001F is rejected from every identity component above, so this delimiter
  // is unambiguous and can be reproduced by the server-side SQL function.
  const digest = sha256Hex(tuple.join(QA_IDENTITY_SEPARATOR));
  return { tuple, digest, key: `qa_${digest}` };
}

export function deterministicQaPinId(identityOrInput) {
  const digest = identityOrInput?.digest || identityOrInput?.identity || qaFindingIdentity(identityOrInput).digest;
  return `ann_qa_${digest.slice(0, 48)}`;
}

function collapseFindings(findings, context) {
  const byKey = new Map();
  const duplicates = [];
  for (const record of findings) {
    const identity = qaFindingIdentity({ ...context, rule: record.rule, target: record.target });
    const enriched = {
      ...record,
      identity: identity.digest,
      findingKey: identity.key,
      annotationId: record.outcome === 'failed' ? deterministicQaPinId(identity) : null,
    };
    const existing = byKey.get(identity.key);
    if (!existing) {
      byKey.set(identity.key, enriched);
      continue;
    }
    duplicates.push({ findingKey: identity.key, sourceIndex: record.sourceIndex });
    const preferred = OUTCOME_PRIORITY[enriched.outcome] > OUTCOME_PRIORITY[existing.outcome] ? enriched : existing;
    byKey.set(identity.key, {
      ...preferred,
      sourceIndex: `${existing.sourceIndex},${enriched.sourceIndex}`.slice(0, 512),
      duplicateCount: (existing.duplicateCount || 1) + 1,
    });
  }
  return { findings: [...byKey.values()], duplicates };
}

function formatVersionFromInput(input, results, format) {
  const explicit = input.formatVersion;
  if (explicit !== undefined && explicit !== null && typeof explicit !== 'string') return fail('format_version_invalid');
  if (explicit === null) return fail('format_version_invalid');
  const inferred = format === 'axe'
    ? results?.tool?.version || results?.version
    : results?.metadata?.version || results?.version;
  const checked = text(explicit ?? inferred, QA_IMPORT_LIMITS.maxFormatVersionChars, 'format_version', { required: true });
  return typeof checked === 'string' ? checked : checked;
}

function sourceMetadata(input, format, formatVersion) {
  const source = text(input.source, QA_IMPORT_LIMITS.maxSourceChars, 'source', { required: true });
  if (typeof source !== 'string') return source;
  const metadata = { source, adapter: `${format}-json-v1`, format, formatVersion };
  if (input.commitSha !== undefined) metadata.commitSha = input.commitSha;
  if (input.branch !== undefined) metadata.branch = input.branch;
  if (input.environment !== undefined) metadata.environment = input.environment;
  if (bytes(metadata) > QA_IMPORT_LIMITS.maxMetadataBytes) return fail('source_metadata_too_large');
  return metadata;
}

export function normalizeQaImport(input) {
  if (!isPlainObject(input)) return fail('qa_import_input_object_required');
  const allowed = new Set(['projectId', 'pageUrl', 'device', 'format', 'formatVersion', 'runId', 'source', 'commitSha', 'branch', 'environment', 'results', 'dryRun']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) return fail('qa_import_field_unsupported', { field: key });
  if (input.dryRun !== undefined && typeof input.dryRun !== 'boolean') return fail('dry_run_invalid');
  const projectId = text(input.projectId, QA_IMPORT_LIMITS.maxProjectIdChars, 'project_id', { required: true });
  if (typeof projectId !== 'string') return projectId;
  if (!PROJECT_ID.test(projectId)) return fail('project_id_invalid');
  const pageUrlResult = canonicalPageUrl(input.pageUrl);
  if (typeof pageUrlResult !== 'string') return pageUrlResult;
  const format = normalizeFormat(input.format);
  if (typeof format !== 'string') return format;
  const device = normalizeDevice(input.device);
  if (typeof device !== 'string') return device;
  const runId = text(input.runId, QA_IMPORT_LIMITS.maxRunIdChars, 'run_id', { required: true });
  if (typeof runId !== 'string' || !SAFE_ID.test(runId)) return fail('run_id_invalid');
  if (!isPlainObject(input.results)) return fail('results_object_required');
  if (bytes(input.results) > QA_IMPORT_LIMITS.payloadBytes) return fail('payload_too_large', { maxBytes: QA_IMPORT_LIMITS.payloadBytes });
  const formatVersion = formatVersionFromInput(input, input.results, format);
  if (typeof formatVersion !== 'string') return formatVersion;
  const optionalText = (value, max, field) => {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'string') return fail(`${field}_invalid`);
    const checked = text(value, max, field);
    if (typeof checked !== 'string') return checked;
    return checked || null;
  };
  const commitSha = optionalText(input.commitSha, 64, 'commit_sha');
  if (commitSha && commitSha.ok === false) return commitSha;
  if (commitSha && !HEX_SHA.test(commitSha)) return fail('commit_sha_invalid');
  const normalizedCommitSha = commitSha ? commitSha.toLowerCase() : null;
  const branch = optionalText(input.branch, 256, 'branch');
  if (branch && branch.ok === false) return branch;
  const environment = optionalText(input.environment, 64, 'environment');
  if (environment && environment.ok === false) return environment;
  const metadata = sourceMetadata({ ...input, commitSha: normalizedCommitSha, branch, environment }, format, formatVersion);
  if (!isPlainObject(metadata) || metadata.ok === false) return metadata;
  const findings = format === 'axe' ? parseAxe(input.results, pageUrlResult) : parsePlaywright(input.results, pageUrlResult);
  if (!Array.isArray(findings)) return findings;
  const collapsed = collapseFindings(findings, { projectId, pageUrl: pageUrlResult, device });
  if (collapsed.findings.length > QA_IMPORT_LIMITS.maxFindings) return fail('finding_count_exceeded', { max: QA_IMPORT_LIMITS.maxFindings });
  const digestInput = {
    projectId,
    pageUrl: pageUrlResult,
    device,
    format,
    formatVersion,
    runId,
    source: metadata.source,
    commitSha: normalizedCommitSha,
    branch,
    environment,
    findings: collapsed.findings.map(({ rule, target, outcome, severity, message, identity }) => ({ rule, target, outcome, severity, message, identity })),
  };
  return success({
    projectId,
    pageUrl: pageUrlResult,
    device,
    format,
    formatVersion,
    runId,
    source: metadata.source,
    sourceMetadata: metadata,
    commitSha: normalizedCommitSha,
    branch,
    environment,
    payloadDigest: sha256Hex(stableJson(digestInput)),
    findings: collapsed.findings,
    duplicateRecords: collapsed.duplicates,
    dryRun: input.dryRun === true,
  });
}

export function qaImportPreview(normalized) {
  return {
    projectId: normalized.projectId,
    pageUrl: normalized.pageUrl,
    device: normalized.device,
    format: normalized.format,
    formatVersion: normalized.formatVersion,
    runId: normalized.runId,
    payloadDigest: normalized.payloadDigest,
    findingCount: normalized.findings.length,
    failedCount: normalized.findings.filter((finding) => finding.outcome === 'failed').length,
    passedCount: normalized.findings.filter((finding) => finding.outcome === 'passed').length,
    inconclusiveCount: normalized.findings.filter((finding) => finding.outcome === 'inconclusive').length,
    skippedCount: normalized.findings.filter((finding) => finding.outcome === 'skipped').length,
    duplicateCount: normalized.duplicateRecords.length,
    findings: normalized.findings.map((finding) => ({
      rule: finding.rule,
      target: finding.target,
      outcome: finding.outcome,
      severity: finding.severity,
      findingKey: finding.findingKey,
      annotationId: finding.annotationId,
      sourceIndex: finding.sourceIndex,
    })),
  };
}
