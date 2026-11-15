// one-click-setup.js — stdio helpers for sign-in, one confirm, the first crit,
// pin links, and the public crit worker. Hosted OAuth clients use the same
// proposal id and link shape from the landing API. This module never writes,
// logs or returns a license key. The first-crit session below sends the
// signed-in key only in the body of two Supabase functions the caller names
// (validate-license for the account email, claim-report for the findings),
// the same way `npx pincushion-mcp claim` already does, plus the
// X-License-Key header of one projects-only sync read for the target
// project's URLs (readProjectSiteUrls), as every sync request sends it.
//
// 2026-11-10: the first crit is requested for the signed-in account (its own
// email as requester, fresh: true) like the web app's first project
// (pincushion-landing/api/app-first-crit.js), so another visitor's recent
// crit of the same page is never handed back. On delivery the findings are
// copied into this folder's project (claim-report save_copy), where they
// arrive open and wait for the user's approve_pin.
//
// 2026-11-12 (release review of 1.14.0): the agent flow never makes the
// requester claim. That claim approves a first project's AI findings, and in
// the agent flow no person had seen them; the only guard was process memory.
// start_first_crit now needs the folder's project first (confirmed with
// confirm_project_setup or configured for the folder), so the findings always
// arrive open.
//
// 2026-11-12 (pre-release source review of 1.14.0): each crit is bound at start
// to its project and to a hash of the account email, and that binding is kept
// in the folder (first-crit-store.js), so delivery copies into the project the
// start response named, in this process or after a restart. Hosts an agent
// added with configure_project are kept on disk too, and count only after the
// user agrees they belong to the project.
import { detectSetupProposal, isLoopbackTarget, setupProposalId } from './setup-core.js';
import {
  cleanJob,
  createMemoryAgentHostLedger,
  createMemoryFirstCritJobStore,
  jobExpired,
  persistenceReason,
  retainJobs,
  sha256,
} from './first-crit-store.js';

export { detectSetupProposal, isLoopbackTarget, setupProposalId };

const CRIT_URL = 'https://www.pincushion.io/api/crit';

// The crit worker endpoint: CRIT_URL when PINCUSHION_CRIT_URL is unset, or
// that override when it is a loopback URL (a local stand-in for tests).
// Returns { url } or { error } for any other value: a rejected override
// disables the first crit with a clear error instead of silently using the
// production worker.
export function critEndpoint(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return { url: CRIT_URL };
  try {
    const parsed = new URL(raw);
    if (!parsed.username && !parsed.password && !parsed.search && !parsed.hash
      && (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && ['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return { url: parsed.toString() };
  } catch { /* not a URL */ }
  return {
    error: {
      success: false,
      error: 'crit_url_invalid',
      message: 'PINCUSHION_CRIT_URL is set to a value this server does not accept (only a loopback http or https URL is), so first crits are turned off. Remove PINCUSHION_CRIT_URL from the MCP server environment and restart it.',
    },
  };
}
const APP_ORIGIN = 'https://www.pincushion.io';
const CRIT_REF = 'mcp-setup';
const REUSED_MESSAGE = 'We already critiqued this page recently.';
const REPORT_URL = /^https:\/\/(?:www\.)?pincushion\.io\/r\/([A-Za-z0-9_-]{8,128})$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const ACCOUNT_EMAIL_UNKNOWN = 'Your account email could not be read right now, so no crit was started. A crit without it could not be added to your project. Try start_first_crit again in a moment.';

export function confirmationRequired() {
  return {
    success: false,
    error: 'confirmation_required',
    message: 'Show the detected project name and URLs, then call confirm_project_setup once with confirmed: true and the same proposalId.',
  };
}

export function confirmationMatches(proposal, args) {
  if (!proposal || args?.confirmed !== true) return { ok: false, error: confirmationRequired() };
  if (args.proposalId !== proposal.proposalId) {
    return {
      ok: false,
      error: {
        success: false,
        error: 'stale_proposal',
        message: 'The detected project changed since that proposal. Show this one and confirm it once.',
        proposal,
      },
    };
  }
  return { ok: true };
}

// Older local registries may still hold one empty "Untitled project". Confirm
// renames that row instead of creating a second one. Allow does not create a
// project. A project already named after the checkout wins; more than one
// empty Untitled project is ambiguous and falls back to creating the detected name.
export function reusableSetupProjectId(projects, name) {
  const entries = Object.entries(projects && typeof projects === 'object' ? projects : {});
  if (entries.some(([, p]) => p?.name === name)) return null;
  const untitled = entries.filter(([, p]) => typeof p?.name === 'string'
    && p.name.trim().toLowerCase() === 'untitled project'
    && !(Array.isArray(p.urls) && p.urls.length));
  return untitled.length === 1 ? untitled[0][0] : null;
}

function withPinQuery(pageUrl, pinId) {
  try {
    const url = new URL(pageUrl);
    url.searchParams.set('pincushion_pin', pinId);
    return url.toString();
  } catch {
    return pageUrl || null;
  }
}

export function pinLinks(pin, projectId) {
  const id = typeof pin?.id === 'string' ? pin.id : (typeof pin?.annotationId === 'string' ? pin.annotationId : '');
  const page = typeof pin?.pageUrl === 'string' ? pin.pageUrl : (typeof pin?.page_url === 'string' ? pin.page_url : null);
  const project = typeof projectId === 'string' && projectId ? projectId : (typeof pin?.projectId === 'string' ? pin.projectId : '');
  return {
    app: project ? `${APP_ORIGIN}/app/project/${encodeURIComponent(project)}` : null,
    page,
    site: page && id ? withPinQuery(page, id) : page,
    ide: id ? `${APP_ORIGIN}/open/ide?project=${encodeURIComponent(project)}&pin=${encodeURIComponent(id)}` : null,
  };
}

function asPins(value) {
  if (Array.isArray(value?.pins)) return value.pins;
  if (Array.isArray(value?.annotations)) return value.annotations;
  if (Array.isArray(value)) return value;
  return [];
}

export function decorateSetupPins(result) {
  const source = result && typeof result === 'object' ? result : { pins: [] };
  const projectId = typeof source.projectId === 'string' ? source.projectId : '';
  const pins = asPins(source).map((pin) => ({
    ...pin,
    likelyFiles: Array.isArray(pin?.likelyFiles) ? pin.likelyFiles : (Array.isArray(pin?.likely_files) ? pin.likely_files : []),
    links: pinLinks(pin, projectId),
  }));
  const empty = pins.length === 0;
  return {
    ...source,
    pins,
    count: pins.length,
    empty,
    ...(empty ? {
      message: 'No pins yet. If a crit is still running, poll get_first_crit_status. A localhost URL is not sent to the Pincushion crit worker.',
    } : {}),
  };
}

export function publicCritRequest(url) {
  const target = typeof url === 'string' ? url.trim() : '';
  if (!target) return { ok: false, error: 'url_required', message: 'Pass the public https URL to critique.' };
  if (isLoopbackTarget(target)) {
    return {
      ok: false,
      status: 'localhost_not_public',
      error: 'localhost_not_public',
      message: 'A localhost URL stays on the local stdio server. The Pincushion crit worker only reviews a public https URL.',
    };
  }
  let parsed;
  try { parsed = new URL(target); } catch { parsed = null; }
  if (!parsed || parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    return { ok: false, error: 'public_https_required', message: 'The first crit needs a public https URL.' };
  }
  return { ok: true, url: parsed.toString() };
}

async function readJsonResponse(response) {
  try { return await response.json(); } catch { return {}; }
}

function normalEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return email && email.length <= 320 && EMAIL.test(email) ? email : '';
}

// The share token of a canonical report URL: https://www.pincushion.io/r/ followed by the share token.
export function reportShareToken(reportUrl) {
  const match = REPORT_URL.exec(typeof reportUrl === 'string' ? reportUrl : '');
  return match ? match[1] : null;
}

// Queue a crit whose requester is the signed-in account. `email` is that
// account's own address; `fresh: true` (as the web app sends) makes the crit
// worker start a new crit instead of handing back another visitor's recent
// crit of the same page. A crit without the account email could never be
// added to the account's project, so none is sent.
export async function queuePublicCrit(url, fetchImpl = fetch, { email, critUrl = CRIT_URL } = {}) {
  const prepared = publicCritRequest(url);
  if (!prepared.ok) return { success: false, ...prepared };
  const requester = normalEmail(email);
  if (!requester) {
    return {
      success: false,
      error: 'account_email_unknown',
      message: ACCOUNT_EMAIL_UNKNOWN,
    };
  }
  let response;
  try {
    response = await fetchImpl(critUrl, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ url: prepared.url, email: requester, ref: CRIT_REF, fresh: true }),
    });
  } catch {
    return { success: false, error: 'crit_unavailable', message: 'The Pincushion crit worker did not accept the request. Try again in a moment.' };
  }
  const body = await readJsonResponse(response);
  if (!response.ok || body.ok === false || body.error) {
    return {
      success: false,
      error: typeof body.error === 'string' ? body.error : 'crit_unavailable',
      message: typeof body.message === 'string' ? body.message : 'The Pincushion crit worker did not accept the request.',
      ...(Number.isInteger(body.retryAfterSeconds) ? { retryAfterSeconds: body.retryAfterSeconds } : {}),
    };
  }
  // fresh: true should make this impossible. If the worker still answers with
  // an earlier crit of this page, it may be someone else's: never present it
  // as this account's crit.
  if (body.reused === true || body.message === REUSED_MESSAGE) {
    return {
      success: false,
      error: 'not_your_crit',
      message: 'The crit worker answered with an earlier crit of this page instead of starting one for your account, so it was not used and nothing was added to your project. Call start_first_crit again in a minute.',
    };
  }
  const token = typeof body.token === 'string' ? body.token : null;
  if (!token) {
    return { success: false, error: 'crit_unavailable', message: 'The Pincushion crit worker did not return a job token. Try again in a moment.' };
  }
  return {
    success: true,
    status: typeof body.status === 'string' ? body.status : 'queued',
    token,
    reportUrl: typeof body.reportUrl === 'string' ? body.reportUrl : null,
    message: 'Pincushion AI is reviewing this page for your account. It usually takes about 4 minutes. Poll get_first_crit_status with this token.',
    poll: { tool: 'get_first_crit_status', token },
  };
}

// The signed-in account's own email, from validate-license. The key goes
// only in the request body to the configured functions base and is never
// returned or logged.
export async function readAccountEmail({ functionsBase, licenseKey, fetchImpl = fetch } = {}) {
  const key = typeof licenseKey === 'string' ? licenseKey.trim() : '';
  if (!key) return { ok: false, reason: 'signed_out' };
  let response;
  try {
    response = await fetchImpl(`${functionsBase}/validate-license`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ licenseKey: key }),
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  const body = await readJsonResponse(response);
  if (response.status === 401 || response.status === 403) return { ok: false, reason: 'rejected' };
  if (!response.ok || body.valid !== true) return { ok: false, reason: 'unavailable' };
  const email = normalEmail(body.email);
  return email ? { ok: true, email } : { ok: false, reason: 'unavailable' };
}

async function postClaimReport({ functionsBase, fetchImpl, payload }) {
  try {
    const response = await fetchImpl(`${functionsBase}/claim-report`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    });
    return { status: response.status, ok: response.ok, body: await readJsonResponse(response) };
  } catch {
    return { status: 0, ok: false, body: {} };
  }
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return 'this page'; }
}

const ATTACH_RETRY = 'Call get_first_crit_status again in a minute to retry.';

// Copy the delivered crit's AI findings into the folder's existing project
// (claim-report save_copy with target_project_id). This never creates a
// project, so it works on a Free plan that already has its one project.
async function copyIntoProject({ functionsBase, fetchImpl, licenseKey, shareToken, projectId }) {
  const answer = await postClaimReport({
    functionsBase,
    fetchImpl,
    payload: { token: shareToken, action: 'save_copy', license_key: licenseKey, target_project_id: projectId },
  });
  const body = answer.body || {};
  if (answer.ok && body.success === true && typeof body.project_id === 'string') {
    // save_copy answers with the destination of an earlier or interrupted
    // save of this crit, even when another target was asked for. Only the
    // project that was asked for counts as added here.
    if (body.project_id !== projectId) {
      const elsewhere = typeof body.project_name === 'string' && body.project_name
        ? `"${body.project_name}" (${body.project_id})`
        : body.project_id;
      return {
        ok: false,
        error: 'copied_elsewhere',
        message: `This crit's findings were already saved to your project ${elsewhere}, not to project ${projectId} that it was started for, so nothing was added there. Call list_setup_pins with projectId ${body.project_id} to read them, or call start_first_crit again to review the page for project ${projectId}.`,
      };
    }
    const count = Number.isSafeInteger(body.pin_count) ? body.pin_count : null;
    return {
      ok: true,
      mode: 'copied',
      projectId: body.project_id,
      projectName: typeof body.project_name === 'string' ? body.project_name : null,
      pinCount: count,
    };
  }
  const reasons = {
    project_access_required: `Your account cannot edit project ${projectId}, the project this crit was started for, so the findings were not added. Ask the project's owner to make you an editor, then call get_first_crit_status again, or call start_first_crit again for a project you can edit.`,
    report_not_copyable: 'This crit has already been claimed as a project, so its findings were not added to this one. Call start_first_crit again to request a new one.',
    rate_limited: `Too many attempts just now. ${ATTACH_RETRY}`,
    session_invalid: 'Your sign-in was not accepted. Call sign_in, then get_first_crit_status again.',
    invalid_target_project: `Project ${projectId}, the project this crit was started for, is not a valid target, so the findings were not added. Call get_project_context with projectId "${projectId}" to check it, then call start_first_crit again for this folder's project.`,
  };
  const error = typeof body.error === 'string' && reasons[body.error] ? body.error : 'copy_failed';
  return {
    ok: false,
    error,
    message: reasons[error] || `The crit finished, but its findings could not be added to project ${projectId}. ${ATTACH_RETRY}`,
  };
}

// The next step when the folder has no project. The agent flow never turns a
// crit into a project (see the 2026-11-12 note at the top).
const PROJECT_FIRST = 'Call propose_project_setup, show the user the detected name and URLs, and call confirm_project_setup with confirmed: true and that proposalId only after the user agrees. Then call start_first_crit again.';
const NO_PROJECT_START = `This folder has no Pincushion project yet, so no crit was started. The first crit's findings are added to the folder's project as open findings for the user to approve. ${PROJECT_FIRST}`;

const OPEN_FINDINGS = 'They are open findings: show them to the user and call approve_pin on the ones the user wants fixed before implementing them.';

function attachedMessage(attached, url) {
  const name = attached.projectName ? `"${attached.projectName}" (${attached.projectId})` : attached.projectId;
  const count = attached.pinCount === null ? 'The' : `${attached.pinCount}`;
  return `${count} Pincushion AI findings on ${hostOf(url)} are now in project ${name}. Call list_setup_pins with projectId ${attached.projectId} to read them. ${OPEN_FINDINGS}`;
}

// A result recorded earlier (in this or an earlier process): a receipt, not a
// fresh check of the account or the folder's project.
function attachedReceipt(attached, url) {
  const when = attached.attachedAt ? ` on ${attached.attachedAt}` : '';
  return `Recorded on this machine: this crit's findings on ${hostOf(url)} were added to project ${attached.projectId}${when}. Call list_setup_pins with projectId ${attached.projectId} to read them. ${OPEN_FINDINGS}`;
}

// The account a crit was started for, as a hash of its email. The email and
// the license key are never stored.
export function accountIdentity(email) {
  const normal = normalEmail(email);
  return normal ? sha256(`pincushion-account:${normal}`) : null;
}

// Hostnames of the public https URLs in a list (localhost and other loopback
// targets left out). The host rule itself uses siteHosts and sameSite below.
export function publicHosts(urls) {
  const hosts = new Set();
  for (const value of Array.isArray(urls) ? urls : []) {
    if (typeof value !== 'string' || isLoopbackTarget(value)) continue;
    try {
      const parsed = new URL(value);
      if (parsed.protocol === 'https:' && parsed.hostname) hosts.add(parsed.hostname.toLowerCase());
    } catch { /* not a URL */ }
  }
  return [...hosts].sort();
}

// 2026-11-11: a host and its www. variant are the same site for the host
// rule (www.example.com and example.com match both ways). Only that one
// label is dropped; there is no registrable-domain matching, so an unrelated
// subdomain (shop.example.com) is still a different host.
export function siteKey(host) {
  const value = typeof host === 'string' ? host.trim().toLowerCase().replace(/\.$/, '') : '';
  return value.startsWith('www.') && value.indexOf('.', 4) !== -1 ? value.slice(4) : value;
}

export function sameSite(a, b) {
  const left = siteKey(a);
  return Boolean(left) && left === siteKey(b);
}

function hostOfProjectUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return null;
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:') && parsed.hostname
      ? parsed.hostname.toLowerCase()
      : null;
  } catch {
    return null;
  }
}

// The site hosts of a project's URL list: every non-loopback http or https
// host (a project registered as http://example.com is still the site
// example.com), and whether the list holds a localhost URL.
export function siteHosts(urls) {
  const hosts = new Set();
  let loopback = false;
  for (const value of Array.isArray(urls) ? urls : []) {
    if (typeof value !== 'string' || !value.trim()) continue;
    if (isLoopbackTarget(value)) { loopback = true; continue; }
    const host = hostOfProjectUrl(value);
    if (host) hosts.add(host);
  }
  return { hosts: [...hosts].sort(), loopback };
}

// Site keys of the hosts in `added` that were not already in `before`.
export function addedSiteKeys(before, added) {
  const known = new Set(siteHosts(before).hosts.map(siteKey));
  return siteHosts(added).hosts.map(siteKey).filter((key) => !known.has(key));
}

// The site keys (host, www. dropped) of a URL list.
export function siteKeysOf(urls) {
  return siteHosts(urls).hosts.map(siteKey);
}

// What a configure_project tool call adds, against the account's URL list for
// the destination project read before the call (`baseline`, a
// readProjectSiteUrls answer, or null for a project the call creates):
// { added } hosts the project did not have, or { unverified } when that list
// could not be read from the account, so nothing can be told apart.
export function classifyConfiguredHosts(urls, baseline) {
  const keys = siteKeysOf(urls);
  if (baseline === null || (baseline?.known === false && baseline.reason === 'not_in_account')) return { added: keys, unverified: [] };
  if (baseline?.known === true && baseline.source === 'cloud') {
    const before = new Set(siteKeysOf(baseline.urls));
    return { added: keys.filter((key) => !before.has(key)), unverified: [] };
  }
  return { added: [], unverified: keys };
}

function stringUrls(value) {
  return Array.isArray(value) ? value.filter((url) => typeof url === 'string' && url.trim()) : [];
}

// The authoritative URL list of one project for the signed-in account: the
// same projects-only read of the sync endpoint that the server's cloud
// project check makes (license key in the X-License-Key header, as every
// sync request sends it), with a short timeout. It is read fresh on every
// check and never written anywhere. Only when the cloud cannot be reached
// does the folder's local projects.json entry stand in; a project the cloud
// answers without, or a rejected key, is "unknown" and the host rule
// refuses. Returns { known: true, source, urls } or { known: false, reason }.
export async function readProjectSiteUrls({
  projectId,
  syncEndpoint,
  licenseKey,
  fetchImpl = fetch,
  clientHeader = null,
  localProjects = {},
  timeoutMs = 5000,
} = {}) {
  const id = typeof projectId === 'string' ? projectId.trim() : '';
  if (!id) return { known: false, reason: 'no_project' };
  const key = typeof licenseKey === 'string' ? licenseKey.trim() : '';
  if (key && syncEndpoint) {
    let response = null;
    try {
      const endpoint = new URL(syncEndpoint);
      endpoint.searchParams.set('projects_only', '1');
      response = await fetchImpl(endpoint.toString(), {
        method: 'GET',
        redirect: 'error',
        headers: {
          Accept: 'application/json',
          'X-License-Key': key,
          ...(clientHeader ? { 'X-Pincushion-Client': clientHeader } : {}),
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      response = null;
    }
    if (response) {
      if (response.status === 401 || response.status === 403) return { known: false, reason: 'rejected' };
      if (response.ok) {
        const body = await readJsonResponse(response);
        if (Array.isArray(body?.projects)) {
          const row = body.projects.find((entry) => entry && typeof entry === 'object'
            && (entry.projectId === id || entry.id === id));
          if (!row) return { known: false, reason: 'not_in_account' };
          return { known: true, source: 'cloud', urls: stringUrls(row.urls) };
        }
      }
    }
  }
  const saved = localProjects && typeof localProjects === 'object' ? localProjects[id] : null;
  const urls = stringUrls(saved?.urls);
  return urls.length ? { known: true, source: 'local', urls } : { known: false, reason: 'unavailable' };
}

const APP_URL = `${APP_ORIGIN}/app`;

function hostNotAllowed(host, allowed, where) {
  return {
    success: false,
    error: 'url_not_in_project',
    allowedHosts: allowed,
    message: `start_first_crit only reviews a page of ${where}. ${host} is not one of its hosts (${allowed.join(', ')}). Pass a page on one of those hosts. Nothing was started.`,
  };
}

function targetLabel(target) {
  return target.name ? `"${target.name}" (${target.projectId})` : target.projectId;
}

// The refusals of the host rule. `outcome` ends the first sentence for the
// phase (start: nothing started; delivery: nothing added) and `retry` names
// the call to make after the user has acted.
function siteRuleRefusal(kind, { target, host, outcome, retry, ledgerFile }) {
  const label = targetLabel(target);
  if (kind === 'project_urls_unknown') {
    const which = target.source === 'configured'
      ? 'ask the user which project this folder should use and to run npx pincushion-mcp setup in this folder to change it'
      : 'ask the user which project this folder should use and call confirm_project_setup for it';
    return {
      error: 'project_urls_unknown',
      message: `The site URLs of project ${label} could not be read from your account, so ${host} could not be checked against them and ${outcome}. Call get_project_context with projectId "${target.projectId}" to read the project and its URLs, then ${retry}. If the project has no site URL, ask the user to add it in the Pincushion app (${APP_URL}). If the project is not in your account, ${which}.`,
    };
  }
  if (kind === 'host_added_by_agent' || kind === 'host_added_unverified') {
    const why = kind === 'host_added_by_agent'
      ? `${host} was added to project ${label} by an agent's configure_project call, not by the user`
      : `${host} was passed to project ${label} by an agent's configure_project call while the project's URLs could not be read from your account, so it is not known whether the project already had it`;
    return {
      error: 'host_added_by_agent',
      message: `${why}. A host added that way does not count for the first crit until the user agrees it belongs to the project, so ${outcome}. Tell the user that ${host} was added to this project by the agent and ask whether it belongs to the project. Only if the user agrees, ${retry} with hostAddedByAgentConfirmed: true; that agreement is saved. Otherwise use a page on another of the project's hosts.`,
    };
  }
  if (kind === 'host_ledger_unreadable') {
    return {
      error: 'host_ledger_unreadable',
      message: `The record of hosts that agents added to projects (${ledgerFile || 'agent-added-hosts.json'}) cannot be read, so ${host} could not be checked and ${outcome}. Ask the user to repair or remove that file (removing it forgets which hosts an agent added), then ${retry}.`,
    };
  }
  if (kind === 'acknowledgment_not_saved') {
    return {
      error: 'acknowledgment_not_saved',
      message: `The user's agreement that ${host} belongs to project ${label} could not be saved (${ledgerFile || 'agent-added-hosts.json'}), so ${outcome}. Fix the file's permissions, then ${retry} with hostAddedByAgentConfirmed: true.`,
    };
  }
  return {
    error: 'project_has_no_urls',
    message: `Project ${label} has no site URL yet, so there is no site to check ${host} against and ${outcome}. Ask the user for the site's public URL and to add it to the project in the Pincushion app (${APP_URL}), then ${retry}.`,
  };
}

// The claim-report preview names the delivered report's page. Its host must be
// the one that was started, so a redirect or a swapped report never attaches
// another site's findings. Returns { host }, { rateLimited: true } or null.
async function deliveredPageHost({ functionsBase, fetchImpl, shareToken }) {
  try {
    const response = await fetchImpl(`${functionsBase}/claim-report?token=${encodeURIComponent(shareToken)}`, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
    if (response.status === 429) return { rateLimited: true };
    if (!response.ok) return null;
    const body = await readJsonResponse(response);
    const page = typeof body.project_url === 'string' ? body.project_url : '';
    return page ? { host: new URL(page).hostname.toLowerCase() } : null;
  } catch {
    return null;
  }
}

// The only project first-crit findings may land in, chosen the same way as
// the default of the pin reads (the server's resolveProjectFilter): the
// project explicitly configured for this folder (--project-id or
// PINCUSHION_PROJECT_ID, which setup writes into the folder's MCP config),
// else the project confirm_project_setup confirmed for this folder (the
// folder selection file, read on every call; `selection` is
// readSetupSelection's answer after the account check). A project merely
// auto-discovered by URL is deliberately not an input. An unreadable selection
// file is an error, never "no project".
export function resolveSetupTarget({ selection = null, configuredProjectId = null, projects = {} } = {}) {
  const saved = (id) => (projects && typeof projects === 'object' ? projects[id] : null);
  const configured = typeof configuredProjectId === 'string' ? configuredProjectId.trim() : '';
  if (configured) {
    return { projectId: configured, name: typeof saved(configured)?.name === 'string' ? saved(configured).name : null, source: 'configured' };
  }
  if (selection?.state === 'unreadable') {
    return {
      error: 'setup_selection_unreadable',
      message: `This folder's project selection (${selection.file}) exists but cannot be read (${selection.reason}), so nothing was done. Call confirm_project_setup again to rewrite it, or ask the user to remove that file.`,
    };
  }
  if (selection?.state === 'ok' && typeof selection.projectId === 'string' && selection.projectId) {
    const id = selection.projectId;
    return { projectId: id, name: typeof saved(id)?.name === 'string' ? saved(id).name : null, source: 'confirmed' };
  }
  return null;
}

const ACCOUNT_UNKNOWN_DELIVERY = `The crit finished, but your account could not be checked right now, so nothing was added yet. ${ATTACH_RETRY}`;

function recordNotSaved(reason) {
  return `This crit's record could not be saved in this folder (${reason}), so its token can only be polled while this MCP server keeps running; after a restart, call start_first_crit again.`;
}

// One per server process. Only a crit started by start_first_crit in this
// folder, for the signed-in account, after the user confirmed its exact URL,
// is ever attached to a project; a token from anywhere else gets its status
// only. Findings only ever arrive as open copies (claim-report save_copy),
// never the requester claim, so approval is recorded on the pins themselves.
//
// Binding (2026-11-12, pre-release source review of 1.14.0). start records,
// in jobStore, the project its answer names and a hash of the account email.
// Delivery copies into that project only: another account signed in refuses
// (account_changed); a folder whose project is now another one refuses
// (project_changed); a folder with no project now still delivers to the bound
// one. A record that could not be saved is reported at start (recordSaved:
// false). jobStore keeps at most MAX_JOBS records for JOB_TTL_MS; the copy
// held here follows the same rule.
//
// The host rule. The page must be on one of the project's site hosts (a host
// and its www. variant count as one site), read for the signed-in account
// (projectUrls, readProjectSiteUrls) at every check, so a URL the user adds in
// the Pincushion app counts on the next try. Hosts an agent's configure_project
// call added (hostLedger, on disk) do not count until the user agrees they
// belong to the project: confirm_project_setup's shown proposal, or
// start_first_crit / get_first_crit_status with hostAddedByAgentConfirmed:
// true, which saves that agreement before going on. An unreadable ledger
// refuses. URLs that cannot be read refuse (project_urls_unknown); a project
// with no site URL refuses (project_has_no_urls) until the user adds one; a
// project whose only URLs are localhost may review a user-confirmed public
// page, and the answer says so (outsideProjectUrls). The same rule runs again
// at delivery, against the bound project.
export function createFirstCritSession({
  fetchImpl = fetch,
  functionsBase,
  licenseKey,
  setupTarget,
  projectUrls,
  hostLedger = createMemoryAgentHostLedger(),
  accountKey = async () => null,
  jobStore = createMemoryFirstCritJobStore(),
  now = () => Date.now(),
  critUrl = CRIT_URL,
  critUrlError = null,
} = {}) {
  // token -> { job, attaching }: the in-process copy, kept no longer than the
  // store keeps the record, and the in-flight attach shared by polls.
  const jobs = new Map();
  const loads = new Map();
  const key = () => (typeof licenseKey === 'function' ? licenseKey() : null) || null;
  const readTarget = async () => {
    const target = await setupTarget?.();
    if (target?.error) return target;
    return target && typeof target.projectId === 'string' && target.projectId ? target : null;
  };
  const ledgerFile = hostLedger?.file || null;

  // `persisted`: the store holds this record (written at start, or read
  // from it). Only a record that was never written lives in memory alone.
  function remember(job, persisted) {
    jobs.set(job.token, { job, attaching: null, persisted });
    const kept = new Set(retainJobs([...jobs.values()].map((entry) => entry.job), now()).map((entry) => entry.token));
    for (const token of [...jobs.keys()]) if (!kept.has(token)) jobs.delete(token);
    return jobs.get(job.token) || null;
  }

  // { allowed, localOnly } when the host may be checked against a list,
  // { refusal } when the rule refuses outright.
  async function siteRule(target, host, { acknowledged = false } = {}) {
    const read = projectUrls ? await projectUrls(target.projectId) : null;
    if (read?.known !== true) return { refusal: 'project_urls_unknown' };
    let excluded;
    try { excluded = await hostLedger.excluded(target.projectId); } catch { excluded = { ok: false }; }
    if (!excluded?.ok) return { refusal: 'host_ledger_unreadable' };
    const added = new Set(excluded.added);
    const unverified = new Set(excluded.unverified);
    const hostKey = siteKey(host);
    if ((added.has(hostKey) || unverified.has(hostKey)) && acknowledged) {
      try {
        await hostLedger.acknowledge(target.projectId, [hostKey], { accountHash: await accountKey(), via: 'hostAddedByAgentConfirmed' });
      } catch {
        return { refusal: 'acknowledgment_not_saved' };
      }
      added.delete(hostKey);
      unverified.delete(hostKey);
    }
    const isExcluded = (entry) => added.has(siteKey(entry)) || unverified.has(siteKey(entry));
    const { hosts, loopback } = siteHosts(read.urls);
    const allowed = hosts.filter((entry) => !isExcluded(entry));
    const listed = allowed.some((entry) => sameSite(entry, host));
    if (!listed && isExcluded(host)) return { refusal: added.has(hostKey) ? 'host_added_by_agent' : 'host_added_unverified' };
    if (!allowed.length) return loopback ? { allowed, localOnly: true } : { refusal: 'project_has_no_urls' };
    return { allowed, localOnly: false };
  }

  async function start(url, { confirmed, hostAddedByAgentConfirmed = false } = {}) {
    if (critUrlError) return critUrlError;
    const prepared = publicCritRequest(url);
    if (!prepared.ok) return { success: false, ...prepared };
    const host = hostOf(prepared.url).toLowerCase();
    if (confirmed !== true) {
      return {
        success: false,
        error: 'confirmation_required',
        message: `Show the user this exact URL (${prepared.url}) and ask whether Pincushion AI should review it for their account. Call start_first_crit again with confirmed: true only after the user agrees. Nothing was started.`,
      };
    }
    const credential = key();
    if (!credential) {
      return {
        success: false,
        error: 'sign_in_required',
        message: 'Call sign_in first. The first crit is requested for your account so its findings can be added to your project.',
      };
    }
    const target = await readTarget();
    if (target?.error) return { success: false, error: target.error, message: target.message };
    if (!target) return { success: false, error: 'project_required', message: NO_PROJECT_START };
    const rule = await siteRule(target, host, { acknowledged: hostAddedByAgentConfirmed === true });
    if (rule.refusal) {
      return {
        success: false,
        ...siteRuleRefusal(rule.refusal, { target, host, outcome: 'nothing was started', retry: 'call start_first_crit again', ledgerFile }),
      };
    }
    const allowed = rule.allowed;
    if (allowed.length && !allowed.some((entry) => sameSite(entry, host))) {
      return hostNotAllowed(host, allowed, `project ${targetLabel(target)}`);
    }
    const account = await readAccountEmail({ functionsBase, licenseKey: credential, fetchImpl });
    if (!account.ok) {
      return account.reason === 'rejected'
        ? { success: false, error: 'sign_in_required', message: 'Your sign-in was not accepted, so no crit was started. Call sign_in, then start_first_crit again.' }
        : { success: false, error: 'account_email_unknown', message: ACCOUNT_EMAIL_UNKNOWN };
    }
    const queued = await queuePublicCrit(prepared.url, fetchImpl, { email: account.email, critUrl });
    if (!queued.success) return queued;
    const record = {
      token: queued.token,
      url: prepared.url,
      host,
      projectId: target.projectId,
      projectName: target.name || null,
      source: target.source,
      accountHash: accountIdentity(account.email),
      startedAt: new Date(now()).toISOString(),
      attached: null,
    };
    const job = cleanJob(record);
    let saveFailure = null;
    try { await jobStore.putJob(job); } catch (error) { saveFailure = persistenceReason(error); }
    remember(job, saveFailure === null);
    const then = `When it is delivered, get_first_crit_status adds its findings to project ${targetLabel(target)}${target.source === 'configured' ? ', the project configured for this folder' : ''}, and only to that project.`;
    const outside = rule.localOnly ? ` This page is not one of the project's URLs (they are localhost only), so its findings are about ${host}, not your local app.` : '';
    return {
      ...queued,
      projectId: target.projectId,
      recordSaved: saveFailure === null,
      message: `${queued.message} ${then}${outside}${saveFailure === null ? '' : ` ${recordNotSaved(saveFailure)}`}`,
      ...(rule.localOnly ? { outsideProjectUrls: true } : {}),
    };
  }

  function boundTarget(job) {
    return { projectId: job.projectId, name: job.projectName, source: job.source };
  }

  function projectChanged(job, current) {
    return {
      ok: false,
      error: 'project_changed',
      message: `This crit was started in this folder for project ${targetLabel(boundTarget(job))}, but this folder's project is now ${targetLabel(current)}, so its findings were not added to either. Call start_first_crit again to review the page for ${targetLabel(current)}.`,
    };
  }

  async function attach(job, read, { acknowledged }) {
    const bound = boundTarget(job);
    const current = await readTarget();
    if (current?.error) return { ok: false, error: current.error, message: current.message };
    if (current && current.projectId !== job.projectId) return projectChanged(job, current);
    const shareToken = reportShareToken(read.reportUrl);
    const credential = key();
    if (!shareToken) {
      return { ok: false, error: 'report_unavailable', message: `The crit finished but its report link is not ready yet. ${ATTACH_RETRY}` };
    }
    if (!credential) {
      return { ok: false, error: 'sign_in_required', message: `Call sign_in, then get_first_crit_status again to add the findings to project ${targetLabel(bound)}.` };
    }
    const account = await readAccountEmail({ functionsBase, licenseKey: credential, fetchImpl });
    if (!account.ok) {
      return account.reason === 'rejected'
        ? { ok: false, error: 'sign_in_required', message: 'Your sign-in was not accepted, so nothing was added. Call sign_in, then get_first_crit_status again.' }
        : { ok: false, error: 'account_unknown', message: ACCOUNT_UNKNOWN_DELIVERY };
    }
    if (accountIdentity(account.email) !== job.accountHash) {
      return {
        ok: false,
        error: 'account_changed',
        message: `This crit was started while another Pincushion account was signed in, so its findings were not added to project ${targetLabel(bound)} with the account signed in now. Call start_first_crit again to review the page for this account.`,
      };
    }
    const delivered = await deliveredPageHost({ functionsBase, fetchImpl, shareToken });
    if (delivered?.rateLimited) {
      return {
        ok: false,
        error: 'rate_limited',
        message: 'The crit finished, but Pincushion is limiting requests right now, so its page could not be checked yet and nothing was added to your project. Try get_first_crit_status again in a minute.',
      };
    }
    if (!delivered) {
      return { ok: false, error: 'report_unavailable', message: `The crit finished but its page could not be checked yet. ${ATTACH_RETRY}` };
    }
    if (!sameSite(delivered.host, job.host)) {
      return {
        ok: false,
        error: 'delivered_page_mismatch',
        message: `The delivered crit is of ${delivered.host}, not ${job.host}, the page that was started, so it was not added to your project. Call start_first_crit again.`,
      };
    }
    // Checked again: the delivery checks above may have taken a while.
    const later = await readTarget();
    if (later?.error) return { ok: false, error: later.error, message: later.message };
    if (later && later.projectId !== job.projectId) return projectChanged(job, later);
    const rule = await siteRule(bound, job.host, { acknowledged });
    if (rule.refusal) {
      return {
        ok: false,
        ...siteRuleRefusal(rule.refusal, { target: bound, host: job.host, outcome: 'its findings were not added', retry: 'call get_first_crit_status again', ledgerFile }),
      };
    }
    const allowed = rule.allowed;
    if (allowed.length && !allowed.some((entry) => sameSite(entry, job.host))) {
      return {
        ok: false,
        error: 'url_not_in_project',
        allowedHosts: allowed,
        message: `This crit is of ${job.host}, which is not one of the hosts of project ${targetLabel(bound)} (${allowed.join(', ')}), so its findings were not added. Call start_first_crit with a page on one of those hosts.`,
      };
    }
    return copyIntoProject({ functionsBase, fetchImpl, licenseKey: credential, shareToken, projectId: job.projectId });
  }

  // The job of a token, as a reconstructed session would see it: the store's
  // record (the in-process copy is reused while the store still has it, so
  // an attach in flight is shared), or the in-process copy of a record that
  // was never written. A record the store dropped (expired, or evicted by
  // newer crits from another process) is gone here too. An unreadable store
  // answers { unreadable }. Concurrent cold polls share one load, so they
  // share one entry and one attach.
  async function loadEntry(id) {
    const held = jobs.get(id);
    if (held && jobExpired(held.job, now())) jobs.delete(id);
    if (!loads.has(id)) {
      loads.set(id, (async () => {
        let saved;
        try {
          saved = await jobStore.getJob(id);
        } catch (error) {
          return { unreadable: error };
        }
        const entry = jobs.get(id);
        if (entry && entry.persisted && !saved) {
          jobs.delete(id);
          return null;
        }
        if (entry) {
          // Another process may have attached it since.
          if (!entry.job.attached && saved?.attached) entry.job = { ...entry.job, attached: saved.attached };
          return entry;
        }
        return saved ? remember(saved, true) : null;
      })().finally(() => loads.delete(id)));
    }
    return loads.get(id);
  }

  async function status(token, { hostAddedByAgentConfirmed = false } = {}) {
    if (critUrlError) return critUrlError;
    const read = await readPublicCrit(token, fetchImpl, { critUrl });
    if (!read.success) return read;
    const id = String(token).trim();
    const entry = await loadEntry(id);
    if (entry?.unreadable) {
      const file = entry.unreadable.file || 'the first-crit record file';
      return {
        ...read,
        attached: false,
        error: 'job_records_unreadable',
        message: `This folder's first-crit record file (${file}) cannot be read (${entry.unreadable.reason || entry.unreadable.code}), so this token could not be checked and nothing was added by this call. Ask the user to repair or remove that file, then poll again. An earlier session may already have added the findings to this folder's project: list_setup_pins reads it.`,
      };
    }
    if (!entry) {
      return {
        ...read,
        attached: false,
        message: 'This machine has no record of this token in this folder (it was not started by start_first_crit here in the last 7 days, or its record was not saved), so nothing was added by this call. An earlier session may already have added its findings to this folder\'s project: list_setup_pins reads it. To review the page now, call start_first_crit with the page URL.',
      };
    }
    const { job } = entry;
    if (job.attached) {
      return { ...read, attached: true, projectId: job.attached.projectId, mode: job.attached.mode, receipt: true, message: attachedReceipt(job.attached, job.url) };
    }
    if (read.status === 'failed' || read.status === 'failed_no_findings') {
      return { ...read, attached: false, message: 'The crit did not finish, so nothing was added to your project. Call start_first_crit again, or try another public page.' };
    }
    if (read.status !== 'delivered') {
      return { ...read, attached: false, message: `Still running. Poll get_first_crit_status again in about 30 seconds. Its findings go to project ${targetLabel(boundTarget(job))}.` };
    }
    // Concurrent polls share one attach and its record, so a second poll
    // never copies twice and sees the same saved result.
    entry.attaching ??= (async () => {
      const result = await attach(job, read, { acknowledged: hostAddedByAgentConfirmed === true });
      if (result.ok && !job.attached) {
        job.attached = {
          projectId: result.projectId,
          projectName: result.projectName,
          pinCount: result.pinCount,
          mode: result.mode,
          attachedAt: new Date(now()).toISOString(),
        };
        // The whole record with its result, so a restart answers with a
        // receipt even when the record written at start is missing.
        try {
          await jobStore.putJob({ ...job, attached: job.attached });
          job.attachedSaved = true;
          entry.persisted = true;
        } catch (error) {
          job.attachedSaved = persistenceReason(error);
        }
      }
      return result;
    })().finally(() => { entry.attaching = null; });
    const outcome = await entry.attaching;
    if (!outcome.ok) {
      return { ...read, attached: false, error: outcome.error, message: outcome.message, ...(outcome.allowedHosts ? { allowedHosts: outcome.allowedHosts } : {}) };
    }
    const unsaved = job.attachedSaved !== true;
    return {
      ...read,
      attached: true,
      projectId: job.attached.projectId,
      mode: job.attached.mode,
      recordSaved: !unsaved,
      message: `${attachedMessage(job.attached, job.url)}${unsaved ? ` This machine could not record that (${job.attachedSaved}): after a restart this token will be unknown here, but the findings stay in project ${job.attached.projectId}, and list_setup_pins with projectId ${job.attached.projectId} reads them.` : ''}`,
    };
  }

  return { start, status };
}

export async function readPublicCrit(token, fetchImpl = fetch, { critUrl = CRIT_URL } = {}) {
  const id = typeof token === 'string' ? token.trim() : '';
  if (!id || id.length > 200 || /[\s#]/.test(id)) {
    return { success: false, error: 'token_required', message: 'Pass the token returned by start_first_crit.' };
  }
  let response;
  try {
    response = await fetchImpl(`${critUrl}?token=${encodeURIComponent(id)}`, {
      method: 'GET',
      redirect: 'error',
      headers: { Accept: 'application/json' },
    });
  } catch {
    return { success: false, error: 'status_unavailable', message: 'Critique status is temporarily unavailable. Poll again.' };
  }
  const body = await readJsonResponse(response);
  if (!response.ok || body.error) {
    return {
      success: false,
      error: typeof body.error === 'string' ? body.error : 'status_unavailable',
      message: typeof body.message === 'string' ? body.message : 'Critique status is temporarily unavailable. Poll again.',
    };
  }
  return {
    success: true,
    status: typeof body.status === 'string' ? body.status : 'unknown',
    reportUrl: typeof body.reportUrl === 'string' ? body.reportUrl : null,
    ...(body.live && typeof body.live === 'object' ? { live: body.live } : {}),
  };
}
