// lib/core.js — Core business logic for PinCushion
// Pure functions for annotation management, testable and config-driven

import { readFile, writeFile, readdir } from 'fs/promises';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { branchName as gitBranchName, inferLikelyFiles } from './git.js';
import {
  enrichThreadMessage,
  parseRichComment,
  renderRichCommentHtml,
  summarizeRichComment,
} from './rich-text.js';

// ─── Project Filter Helper ───────────────────────────────────────────────────
// projectId can be: null (no filter), a string (single ID), or a Set (multiple IDs).
// Returns true if the annotation matches the filter.
function matchesProject(annProjectId, filter) {
  if (!filter) return true;                          // no filter — everything passes
  if (filter instanceof Set) return filter.has(annProjectId);
  return annProjectId === filter;                    // simple string match
}

function serializeThreadMessage(message = {}) {
  return enrichThreadMessage({
    author: message.author || 'Unknown',
    timestamp: message.timestamp,
    body: message.body || '',
    type: message.type || 'comment',
  });
}

function firstUserThreadMessage(thread = []) {
  return (thread || []).find(
    (message) => message.type !== 'code-note' && message.type !== 'decline' && message.author !== 'AI Agent'
  ) || null;
}

// `ready` is the modern status name post-`rename_approved_to_ready_status`
// migration; `approved` is the legacy alias still found in older local
// files. Treat both as the same implementation-ready state. Without this,
// every pin coming back from cloud sync (which normalizes to `ready`)
// falls through the implementation queue — including AI critic pins.
export function isReadyStatus(status) {
  return status === 'ready' || status === 'approved';
}

// ─── Supabase Status Push ─────────────────────────────────────────────────────
// Push a single annotation's status back to Supabase so the deploy hook
// (and the extension's next poll) sees the up-to-date state.
// Fires-and-forgets — never throws; local file is the source of truth.
async function pushAnnotationToSupabase(config, ann, pageUrl, pageTitle) {
  const licenseKey = config.licenseKey;
  const supabaseBase = config.supabaseBase || 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1';
  if (!licenseKey) return; // not configured, skip silently
  try {
    const res = await fetch(`${supabaseBase}/sync-annotations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-license-key': licenseKey },
      body: JSON.stringify([{
        id: ann.id,
        pageUrl: pageUrl || ann.pageUrl || '',
        pageTitle: pageTitle || ann.pageTitle || '',
        element: ann.element || null,
        pin: ann.pin || null,
        thread: ann.thread || [],
        status: ann.status || 'open',
        action: ann.action || null,
        tags: ann.tags || [],
        createdAt: ann.createdAt || new Date().toISOString(),
        updatedAt: ann.updatedAt || new Date().toISOString(),
        resolvedAt: ann.resolvedAt || null,
        approvedAt: ann.approvedAt || null,
        approvedBy: ann.approvedBy || null,
        implementedAt: ann.implementedAt || null,
        implementer: ann.implementer || null,
        projectId: ann.projectId || config.projectId || null,
        author: ann.author || null,
        authorEmail: ann.authorEmail || null,
        // is_bot is server-side gated to author_email === 'pincushion-bot@pincushion.io';
        // forwarding the local flag here just lets a legitimate bot pin round-trip
        // without losing its badge.
        isBot: ann.isBot === true,
        // Priority is intentionally not forwarded — it's in the schema but
        // no UI/MCP path surfaces it today, so writing it would just create
        // dead state. Add forwarding here if priority ever becomes real.
        commitSha: ann.commitSha || null,
        branchName: ann.branchName || null,
        prUrl: ann.prUrl || null,
        deployUrl: ann.deployUrl || null,
        deployedAt: ann.deployedAt || null,
        verificationStatus: ann.verificationStatus || null,
        verificationNotes: ann.verificationNotes || null,
        verifiedAt: ann.verifiedAt || null,
        viewport: ann.viewport || null,
        domSnippet: ann.domSnippet || null,
        likelyFiles: Array.isArray(ann.likelyFiles) ? ann.likelyFiles : null,
        acceptanceCriteria: ann.acceptanceCriteria || null,
      }]),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[Pincushion] Cloud sync failed for ${ann.id}: ${res.status} ${body}`);
    }
  } catch (err) {
    console.error(`[Pincushion] Cloud sync error for ${ann.id}:`, err.message || err);
  }
}

// ─── Project Config ───────────────────────────────────────────────────────────
// Project-level settings live in `.feedback/projects.json` keyed by projectId.
// Settings include URL registrations (legacy) plus traceability knobs added
// later: `commitTrailers`, `attributionComments`, `recordCommitSha`.
//
// Returns null when the file or projectId can't be resolved — callers should
// treat that as "use defaults" rather than an error, since the file may not
// exist yet on a fresh install.

const TRAILER_PRESET_VALUES = new Set(['minimal', 'standard', 'full']);
const ATTRIBUTION_COMMENT_VALUES = new Set(['off', 'context-warrants', 'always']);

// Critique context lifetimes. The compile is cheap (the dev agent does it once
// at /setup), but the underlying inputs drift: marketing copy changes, the
// product evolves, pin history accumulates. We surface a coarse staleness
// signal so /critique callers can decide whether to suggest a /refresh-brand.
//
// 30 / 60 days are intentionally generous — recompiling too aggressively
// burns the dev's tokens for marginal gain. Pin-count-based busting is the
// stronger signal (handled at fix_and_resolve time, not here).
const CRITIQUE_FRESH_DAYS = 30;
const CRITIQUE_STALE_DAYS = 60;

function stalenessLabel(compiledContext, compiledAt) {
  if (!compiledContext) return 'missing';
  if (!compiledAt) return 'fresh'; // legacy rows that pre-date the column
  const ageMs = Date.now() - new Date(compiledAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  if (ageDays > CRITIQUE_STALE_DAYS) return 'stale';
  if (ageDays > CRITIQUE_FRESH_DAYS) return 'aging';
  return 'fresh';
}

export async function readProjectConfig(config, projectId) {
  if (!projectId) return null;
  try {
    const projectsFile = join(config.feedbackDir, 'projects.json');
    const projects = JSON.parse(await readFile(projectsFile, 'utf8'));
    return projects[projectId] || null;
  } catch {
    return null;
  }
}

// ─── Read-only project context (for critic subagent) ─────────────────────────
// The Pincushion AI critic needs `brandContext` before it generates any pin —
// without it, the critic produces generic UX-blog noise. The original prompt
// told the critic to call `configure_project` to fetch brandContext, but
// configure_project mutates: it upserts the project row, creates a deploy
// hook, idempotently inserts the bot member, and pushes to cloud. A typo'd
// project name in a read step turned into an unintended write.
//
// This tool is the read-only path: never mutates, never touches the network.

export async function toolGetProjectContext(config, { projectId, name } = {}) {
  let projects;
  try {
    const projectsFile = join(config.feedbackDir, 'projects.json');
    projects = JSON.parse(await readFile(projectsFile, 'utf8'));
  } catch {
    return {
      success: false,
      error: 'no_projects_file',
      message: 'No projects.json found in this workspace. Run configure_project once to register the project before calling /critique.',
    };
  }

  // Map a project record to the public-facing read-only shape. Mirrors the
  // `ai:` block returned by configure_project so the critic sees the same
  // schema either way.
  const toContext = (id, p) => {
    // Layered critique system: the compiled `critique_context` is what the AI
    // critic should read at pin time. Fall back to the legacy `brand_context`
    // (single short blob) when no compiled context exists yet, so older
    // projects keep working until they run /refresh-brand.
    const compiledAt = p.critiqueContextCompiledAt || null;
    const pinsAtCompile = Number(p.critiqueContextPinsAtCompile || 0);
    const compiledContext = p.critiqueContext || null;
    const effectiveContext = compiledContext || p.brandContext || null;

    return {
      projectId: id,
      name: p.name,
      urls: p.urls || [],
      domain: p.domain || null,
      commentAccess: p.commentAccess || 'open',
      allowedDomains: p.allowedDomains || [],
      ai: {
        // brandContext: legacy single-blob field. Kept so older /critique
        // prompts that read it directly still work. New callers should use
        // ai.critique.effectiveContext instead.
        brandContext: p.brandContext || null,
        autoCritique: p.autoCritique !== false,
        critique: {
          // What the bot should actually load into its prompt at pin time.
          // Falls back to brandContext when no compiled context exists yet.
          effectiveContext,
          // Raw compiled output of the most recent /setup or /refresh-brand
          // run. Null when the project hasn't run the compile flow.
          compiledContext,
          // User-editable critique policy override (survives recompiles).
          policy: p.critiquePolicy || null,
          // Raw signals the agent gathered (readme, theme tokens, sample copy,
          // competitors, mission, etc). JSONB — shape decided by the agent.
          signals: p.critiqueSignals || null,
          compiledAt,
          pinsAtCompile,
          // Staleness signal for /critique callers. "missing" means there is
          // no compiled context at all — the agent should run /refresh-brand
          // (or treat brandContext as a thin fallback). "fresh" / "aging" /
          // "stale" are best-effort time-based heuristics; the caller decides
          // whether to recompile. Pin-based busting happens in toolFixAndResolve.
          staleness: stalenessLabel(compiledContext, compiledAt),
        },
      },
      traceability: {
        commitTrailers: p.commitTrailers || 'minimal',
        attributionComments: p.attributionComments || 'off',
        recordCommitSha: p.recordCommitSha !== false,
      },
    };
  };

  if (projectId) {
    const p = projects[projectId];
    if (!p) {
      return { success: false, error: 'project_not_found', message: `No project with id "${projectId}" in this workspace.` };
    }
    return { success: true, project: toContext(projectId, p) };
  }

  if (name) {
    const entry = Object.entries(projects).find(([, p]) => p.name === name);
    if (!entry) {
      return {
        success: false,
        error: 'project_not_found',
        message: `No project named "${name}" in this workspace.`,
        availableProjects: Object.entries(projects).map(([id, p]) => ({ projectId: id, name: p.name })),
      };
    }
    return { success: true, project: toContext(entry[0], entry[1]) };
  }

  // No filter — return all projects' contexts so the caller can pick.
  const all = Object.entries(projects).map(([id, p]) => toContext(id, p));
  return { success: true, count: all.length, projects: all };
}

// ─── URL Utilities ────────────────────────────────────────────────────────────

export function urlToSlug(url) {
  try {
    const u = new URL(url);
    return (u.hostname + u.pathname)
      .replace(/[^a-zA-Z0-9]/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'page';
  } catch {
    return 'page';
  }
}

// ─── File Reading ─────────────────────────────────────────────────────────────

export async function readAnnotationFiles(annotationsDir) {
  if (!existsSync(annotationsDir)) return {};

  const files = await readdir(annotationsDir).catch(() => []);
  const result = {};

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    try {
      const content = await readFile(join(annotationsDir, file), 'utf-8');
      const data = JSON.parse(content);
      result[data.pageUrl || file] = data;
    } catch {
      // Skip malformed files silently
    }
  }

  return result;
}

export async function readAllAnnotations(config, fetchRemote = null) {
  const local = await readAnnotationFiles(config.annotationsDir);

  // If no remote fetch function provided, return local only
  if (!fetchRemote) return local;

  // Fetch remote annotations
  const remote = await fetchRemote().catch(() => ({}));

  // Merge: remote wins on per-annotation basis (newer updatedAt)
  const merged = { ...local };

  for (const [url, remoteData] of Object.entries(remote)) {
    if (!merged[url]) {
      merged[url] = remoteData;
      continue;
    }
    // Merge per-annotation: keep whichever copy has the newer updatedAt
    const localMap = Object.fromEntries((merged[url].annotations || []).map(a => [a.id, a]));
    for (const remoteAnn of (remoteData.annotations || [])) {
      const localAnn = localMap[remoteAnn.id];
      if (!localAnn || new Date(remoteAnn.updatedAt) >= new Date(localAnn.updatedAt || 0)) {
        localMap[remoteAnn.id] = remoteAnn;
      }
    }
    merged[url] = { ...merged[url], annotations: Object.values(localMap) };
  }

  return merged;
}

export async function writeAnnotationFile(annotationsDir, pageData) {
  if (!existsSync(annotationsDir)) {
    mkdirSync(annotationsDir, { recursive: true });
  }

  const slug = urlToSlug(pageData.pageUrl);
  const filePath = join(annotationsDir, `${slug}.json`);
  await writeFile(filePath, JSON.stringify(pageData, null, 2), 'utf-8');
  return filePath;
}

// Count resolved pins for a project — used to baseline `critique_context_pins_at_compile`
// at compile time, so a later /critique can detect that N more pins have
// been resolved since the brief was built (a strong "recompile" signal).
//
// Falls back to 0 when annotations aren't readable yet (fresh project, no
// .feedback/annotations/ dir). projectId may be undefined for projects that
// pre-date projectId tagging — caller treats 0 as "we don't know."
export async function countResolvedPinsForProject(config, projectId) {
  if (!projectId) return 0;
  const allData = await readAnnotationFiles(config.annotationsDir);
  let count = 0;
  for (const data of Object.values(allData)) {
    for (const ann of (data.annotations || [])) {
      if (ann.status === 'resolved' && (ann.projectId === projectId || !ann.projectId)) {
        count++;
      }
    }
  }
  return count;
}

// Find a single annotation by ID across all pages (for cloud sync push-back)
export async function findAnnotationById(config, annotationId) {
  const allData = await readAllAnnotations(config);
  for (const [url, data] of Object.entries(allData)) {
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (ann) return { ...ann, pageUrl: url, pageTitle: data.pageTitle };
  }
  return null;
}

export async function rebuildIndex(config) {
  const allData = await readAllAnnotations(config);
  const pages = [];
  let totalOpen = 0;
  let totalResolved = 0;

  for (const [url, data] of Object.entries(allData)) {
    const anns = data.annotations || [];
    const open = anns.filter(a => a.status !== 'resolved').length;
    const resolved = anns.filter(a => a.status === 'resolved').length;
    totalOpen += open;
    totalResolved += resolved;
    pages.push({
      url,
      slug: urlToSlug(url),
      title: data.pageTitle || url,
      totalPins: anns.length,
      open,
      resolved,
      file: `annotations/${urlToSlug(url)}.json`
    });
  }

  const index = {
    generatedAt: new Date().toISOString(),
    summary: { totalPages: pages.length, totalOpen, totalResolved },
    pages
  };

  const feedbackDir = config.feedbackDir;
  if (!existsSync(feedbackDir)) mkdirSync(feedbackDir, { recursive: true });
  await writeFile(join(feedbackDir, 'index.json'), JSON.stringify(index, null, 2), 'utf-8');
  return index;
}

// ─── Format Helpers ───────────────────────────────────────────────────────────

export function formatAnnotationForAgent(ann, number) {
  return {
    id: ann.id,
    number,
    status: ann.status,
    tags: ann.tags,
    createdAt: ann.createdAt,
    resolvedAt: ann.resolvedAt,
    element: {
      lwcComponent: ann.element?.lwcComponent,
      selector: ann.element?.selector,
      tagName: ann.element?.tagName,
      textContent: ann.element?.textContent?.slice(0, 150),
      attributes: ann.element?.attributes
    },
    thread: ann.thread?.map(serializeThreadMessage)
  };
}

// ─── Tool Implementations ─────────────────────────────────────────────────────

export async function toolGetAnnotations(config, { pageUrl, componentName, status, projectId } = {}, fetchRemote = null) {
  const allData = await readAllAnnotations(config, fetchRemote);
  const results = [];

  for (const [url, data] of Object.entries(allData)) {
    let anns = data.annotations || [];

    // Filter to current project (supports string ID or Set of IDs)
    if (projectId) anns = anns.filter(a => matchesProject(a.projectId, projectId));

    // Filter by page URL
    if (pageUrl && !url.includes(pageUrl) && !pageUrl.includes(url)) continue;

    // Filter by component name
    if (componentName) {
      const comp = componentName.toLowerCase().replace(/^c-/, '');
      anns = anns.filter(a => {
        const lwc = (a.element?.lwcComponent || '').toLowerCase().replace(/^c-/, '');
        const selector = (a.element?.selector || '').toLowerCase();
        return lwc.includes(comp) || selector.includes(comp);
      });
    }

    // Filter by status
    if (status) {
      anns = anns.filter(a => a.status === status);
    }

    if (anns.length === 0) continue;

    results.push({
      pageUrl: url,
      pageTitle: data.pageTitle || url,
      annotations: anns.map((a, idx) => formatAnnotationForAgent(a, idx + 1))
    });
  }

  if (results.length === 0) {
    return { message: 'No annotations found matching the given filters.', feedbackDir: config.feedbackDir };
  }

  return { totalPages: results.length, pages: results };
}

export async function toolSearchAnnotations(config, { query }, fetchRemote = null) {
  if (!query) return { error: 'query parameter is required' };

  const allData = await readAllAnnotations(config, fetchRemote);
  const matches = [];
  const q = query.toLowerCase();

  for (const [url, data] of Object.entries(allData)) {
    for (const ann of (data.annotations || [])) {
      const searchText = [
        ann.element?.selector,
        ann.element?.lwcComponent,
        ann.element?.textContent,
        ...(ann.thread || []).map(m => m.body),
        ...(ann.tags || [])
      ].join(' ').toLowerCase();

      if (searchText.includes(q)) {
        matches.push({
          pageUrl: url,
          pageTitle: data.pageTitle || url,
          annotation: formatAnnotationForAgent(ann, null)
        });
      }
    }
  }

  return {
    query,
    totalMatches: matches.length,
    results: matches
  };
}

export async function toolGetFeedbackSummary(config, fetchRemote = null, { projectId } = {}) {
  const allData = await readAllAnnotations(config, fetchRemote);

  let totalOpen = 0;
  let totalApproved = 0;
  let totalInProgress = 0;
  let totalResolved = 0;
  const byPage = [];
  const byComponent = {};
  const openItems = [];

  for (const [url, data] of Object.entries(allData)) {
    // Filter annotations to current project (supports string ID or Set of IDs)
    const anns = (data.annotations || []).filter(a =>
      matchesProject(a.projectId, projectId)
    );
    const open = anns.filter(a => a.status === 'open').length;
    const approved = anns.filter(a => isReadyStatus(a.status)).length;
    const inProgress = anns.filter(a => a.status === 'in-progress').length;
    const resolved = anns.filter(a => a.status === 'resolved').length;

    totalOpen += open;
    totalApproved += approved;
    totalInProgress += inProgress;
    totalResolved += resolved;

    if (anns.length > 0) {
      byPage.push({
        pageUrl: url,
        pageTitle: data.pageTitle || url,
        total: anns.length,
        open,
        approved,
        inProgress,
        resolved,
      });
    }

    // Group by LWC component
    for (const ann of anns) {
      const comp = ann.element?.lwcComponent;
      if (comp) {
        if (!byComponent[comp]) byComponent[comp] = { open: 0, resolved: 0, total: 0 };
        byComponent[comp].total++;
        if (ann.status === 'resolved') byComponent[comp].resolved++;
        else byComponent[comp].open++;
      }
    }

    // Collect open items with context
    for (const ann of anns.filter(a => a.status !== 'resolved')) {
      openItems.push({
        id: ann.id,
        pageTitle: data.pageTitle || url,
        pageUrl: url,
        component: ann.element?.lwcComponent || ann.element?.tagName,
        firstComment: ann.thread[0]?.body || '(no comment)',
        author: ann.thread[0]?.author,
        createdAt: ann.createdAt,
        replyCount: ann.thread.length
      });
    }
  }

  // Sort open items by age (oldest first). Priority-based sort was removed
  // when the priority column became dormant — every pin is 'medium' in
  // practice, so the secondary sort key collapsed to a no-op.
  openItems.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

  return {
    summary: {
      totalOpen,
      totalApproved,
      totalInProgress,
      totalResolved,
      totalAnnotations: totalOpen + totalApproved + totalInProgress + totalResolved
    },
    openItems: openItems.slice(0, 50),
    byPage,
    byComponent,
    feedbackDir: config.feedbackDir
  };
}

export async function toolGetComponentFeedback(config, { componentName }, fetchRemote = null) {
  if (!componentName) return { error: 'componentName parameter is required' };

  const comp = componentName.toLowerCase().replace(/^c-/, '').replace(/-/g, '');
  const allData = await readAllAnnotations(config, fetchRemote);
  const results = [];

  for (const [url, data] of Object.entries(allData)) {
    const matching = (data.annotations || []).filter(ann => {
      const lwc = (ann.element?.lwcComponent || '').toLowerCase().replace(/^c-/, '').replace(/-/g, '');
      const selector = (ann.element?.selector || '').toLowerCase().replace(/-/g, '');
      const tags = (ann.tags || []).join(' ').toLowerCase().replace(/-/g, '');
      return lwc.includes(comp) || selector.includes(comp) || tags.includes(comp);
    });

    if (matching.length > 0) {
      results.push({
        pageUrl: url,
        pageTitle: data.pageTitle || url,
        annotations: matching.map((a, idx) => formatAnnotationForAgent(a, idx + 1))
      });
    }
  }

  // Generate a summary for the agent
  const allAnns = results.flatMap(r => r.annotations);
  const open = allAnns.filter(a => a.status !== 'resolved');
  const resolved = allAnns.filter(a => a.status === 'resolved');

  const summary = open.length === 0
    ? `No open feedback for component "${componentName}".`
    : `${open.length} open item(s) for "${componentName}": ${open.map(a =>
        `"${a.thread[0]?.body?.slice(0, 80) || 'no comment'}" (element: ${a.element.selector})`
      ).join('; ')}`;

  return {
    componentName,
    summary,
    totalOpen: open.length,
    totalResolved: resolved.length,
    pages: results
  };
}

export async function toolResolveAnnotation(config, { annotationId, comment, resolvedBy }, fetchRemote = null) {
  const allData = await readAllAnnotations(config, fetchRemote);

  for (const [url, data] of Object.entries(allData)) {
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;

    if (ann.status === 'resolved') {
      return { success: true, annotationId, alreadyResolved: true, message: `Pin "${annotationId}" was already resolved` };
    }

    ann.status = 'resolved';
    ann.resolvedAt = new Date().toISOString();

    if (comment) {
      ann.thread.push({
        id: `msg_${Date.now().toString(36)}`,
        author: resolvedBy || 'AI Agent',
        authorEmail: '',
        timestamp: new Date().toISOString(),
        body: comment,
        type: 'resolution'
      });
    }

    data.exportedAt = new Date().toISOString();
    await writeAnnotationFile(config.annotationsDir, data);
    await rebuildIndex(config);

    return {
      success: true,
      annotationId,
      message: `Resolved annotation "${annotationId}" on page "${data.pageTitle || url}"`
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

export async function toolApprovePin(config, { annotationId, approvedBy }, fetchRemote = null) {
  if (!annotationId) return { error: 'annotationId is required' };

  const allData = await readAllAnnotations(config, fetchRemote);

  for (const [url, data] of Object.entries(allData)) {
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;

    if (ann.status === 'resolved') {
      return { success: false, error: `Pin "${annotationId}" is already resolved` };
    }
    if (isReadyStatus(ann.status)) {
      return { success: true, annotationId, message: `Pin "${annotationId}" was already approved`, alreadyApproved: true };
    }

    // Write the modern status name. Old `approved`/`approvedAt`/`approvedBy`
    // fields stay for backwards compat with consumers that haven't migrated,
    // but `status: 'ready'` is canonical post-rename-migration.
    ann.status = 'ready';
    ann.approvedAt = new Date().toISOString();
    ann.approvedBy = approvedBy || 'Unknown';

    // Add approval event to thread
    ann.thread.push({
      id: `msg_${Date.now().toString(36)}`,
      author: approvedBy || 'Unknown',
      authorEmail: '',
      timestamp: new Date().toISOString(),
      body: `Approved for implementation`,
      type: 'approval'
    });

    data.exportedAt = new Date().toISOString();
    await writeAnnotationFile(config.annotationsDir, data);
    await rebuildIndex(config);

    return {
      success: true,
      annotationId,
      approvedAt: ann.approvedAt,
      approvedBy: ann.approvedBy,
      pageTitle: data.pageTitle || url,
      message: `Pin "${annotationId}" approved for implementation on "${data.pageTitle || url}"`
    };
  }

  return { success: false, error: `Pin "${annotationId}" not found` };
}

/**
 * Get all approved pins grouped by page, with suggested branch names.
 * This is the primary tool for agents starting an implementation session.
 * Returns pins in the "approved" status that haven't been claimed yet.
 *
 * @param {object} config
 * @param {object} options - { projectId }
 * @param {function|null} fetchRemote
 * @returns {object} Grouped approved pins with branch suggestions
 */
export async function toolGetApprovedPins(config, { projectId } = {}, fetchRemote = null) {
  const allData = await readAllAnnotations(config, fetchRemote);

  // Collect approved AND in-progress pins (in-progress = previously claimed but
  // agent crashed/disconnected before resolving — these still need implementation).
  const byPage = {};
  let totalApproved = 0;
  let totalInProgress = 0;

  for (const [url, data] of Object.entries(allData)) {
    const anns = (data.annotations || []).filter(a => {
      // Both 'ready' (modern) and 'approved' (legacy) qualify, plus
      // in-progress (previously claimed but not yet resolved).
      if (!isReadyStatus(a.status) && a.status !== 'in-progress') return false;
      if (!matchesProject(a.projectId, projectId)) return false;
      return true;
    });

    if (anns.length === 0) continue;

    const pageTitle = data.pageTitle || url;
    const branch = gitBranchName(pageTitle, url);

    // Per-pin work-packet enrichment: surface viewport/DOM/likely-files/
    // acceptance criteria when the pin carries them, so agents pick up
    // implementation context automatically without a second tool call.
    const enrichedPins = await Promise.all(anns.map(async ann => {
      // likelyFiles is computed at read-time against the local repo so it
      // stays accurate as the codebase moves. Stored value takes precedence
      // when present (lets the extension or a future helper precompute).
      let likelyFiles = Array.isArray(ann.likelyFiles) ? ann.likelyFiles : null;
      if (!likelyFiles && ann.domSnippet && config.projectDir) {
        try {
          likelyFiles = await inferLikelyFiles(config.projectDir, ann.domSnippet);
        } catch { likelyFiles = []; }
      }

      return {
        id: ann.id,
        status: ann.status,
        approvedAt: ann.approvedAt,
        approvedBy: ann.approvedBy,
        author: ann.author || ann.createdBy || 'Unknown',
        // Deep link back to the page with the pin auto-focused — used for the
        // optional `Pincushion-Pin-Url:` trailer when `commitTrailers='full'`.
        // Cheap to include unconditionally; agent decides whether to use it.
        pincushionPinUrl: buildDeepLink(url, ann.id),
        element: ann.element ? {
          selector: ann.element.selector || null,
          xpath: ann.element.xpath || null,
          tagName: ann.element.tagName || null,
          textContent: (ann.element.textContent || ann.element.text || '').slice(0, 200),
          lwcComponent: ann.element.lwcComponent || null,
        } : null,
        // A3: agent work-packet fields. Null/empty values dropped at the
        // serializer layer by callers that want a tight payload.
        viewport: ann.viewport || null,
        domSnippet: ann.domSnippet || null,
        likelyFiles: likelyFiles || [],
        acceptanceCriteria: ann.acceptanceCriteria || null,
        thread: (ann.thread || []).map(serializeThreadMessage),
        comment: summarizeRichComment(ann.thread?.[0]?.body || '', 200),
        tags: ann.tags || [],
      };
    }));

    byPage[url] = {
      pageUrl: url,
      pageTitle,
      suggestedBranch: branch,
      pins: enrichedPins,
    };

    for (const ann of anns) {
      if (isReadyStatus(ann.status)) totalApproved++;
      else if (ann.status === 'in-progress') totalInProgress++;
    }
  }

  const totalActionable = totalApproved + totalInProgress;
  const pageCount = Object.keys(byPage).length;

  if (totalActionable === 0) {
    return {
      totalApproved: 0,
      totalInProgress: 0,
      pages: [],
      message: 'No approved pins waiting for implementation. Pins must be approved before they can be implemented.',
    };
  }

  const parts = [];
  if (totalApproved > 0) parts.push(`${totalApproved} approved`);
  if (totalInProgress > 0) parts.push(`${totalInProgress} in-progress (previously claimed, not yet resolved)`);

  // Collect per-project traceability config so the agent can read the
  // commit-trailer preset, attribution-comment policy, and SHA-recording flag
  // without a second round-trip. Keyed by projectId; pins without a projectId
  // fall through to the hardcoded defaults at usage time.
  const projectIds = new Set();
  for (const data of Object.values(allData)) {
    for (const ann of data.annotations || []) {
      if ((isReadyStatus(ann.status) || ann.status === 'in-progress') && ann.projectId) {
        projectIds.add(ann.projectId);
      }
    }
  }
  const traceability = {};
  for (const pid of projectIds) {
    const proj = await readProjectConfig(config, pid);
    traceability[pid] = {
      commitTrailers: proj?.commitTrailers || 'minimal',
      attributionComments: proj?.attributionComments || 'off',
      recordCommitSha: proj?.recordCommitSha !== false,
    };
  }

  // Implementation packets: each page-level group is one work item the agent
  // should fix in a single branch/PR. `packets` is the canonical name —
  // `pages` is kept as an alias for backward compatibility with older agent
  // prompts that read result.pages directly.
  const packets = Object.values(byPage).map(page => ({
    ...page,
    // Aggregate selectors across all pins on this page so the agent can grep
    // the source tree once per packet rather than per pin.
    selectors: Array.from(new Set(
      (page.pins || [])
        .map(p => p.element?.selector)
        .filter(Boolean)
    )),
    pinCount: (page.pins || []).length,
  }));

  return {
    totalApproved,
    totalInProgress,
    totalActionable,
    pageCount,
    packetCount: packets.length,
    packets,
    pages: packets, // backward-compat alias
    traceability,
    workflow: [
      '1. Use the element.selector and element.xpath to find the component in source code (grep for the selector, tag name, or text content)',
      '2. Read the full thread to understand the stakeholder request, then implement the change',
      '3. Call claim_pin(annotationId) to mark it in-progress before starting (skip if already in-progress)',
      '4. After implementing, call fix_and_resolve(annotationId, fixDescription, commitSha?) to close the pin (pass commitSha after committing for the dashboard backlink)',
      '5. Commit body must include Pin-ID: <id>. If traceability[pin.projectId].commitTrailers is "standard", also add Reviewed-By: <pin.approvedBy> on a new line — but ONLY if approvedBy differs from the git committer email (skip self-approval). If "full", also add Pincushion-Pin-Url: <pin.pincushionPinUrl>. If "minimal" (default), Pin-ID alone.',
      '6. Inline comments: only when traceability[pin.projectId].attributionComments is "context-warrants" AND the pin captures a non-obvious WHY (a constraint, intent, or rationale not self-evident from the diff). Format: // Pincushion <pinId>: <one-line WHY>. Skip for cosmetic fixes (typos, color tweaks, copy edits).',
      'NOTE: Implement on the current branch. Do NOT create branches unless the dev asks. If a git command fails with "Unable to create ... .lock", another git process is in flight — wait, retry, or surface the conflict to the user. Do NOT delete files under .git/.',
    ],
    message: `${totalActionable} pin(s) across ${pageCount} page(s) ready for implementation: ${parts.join(', ')}.`,
  };
}

// Return a single implementation packet for one page. Useful when an agent
// wants to batch-fix one page at a time rather than fetching everything.
// Matches pageUrl by exact value or partial substring (case-insensitive).
export async function toolGetImplementationPacket(config, { pageUrl, projectId } = {}, fetchRemote = null) {
  if (!pageUrl) return { error: 'pageUrl is required' };

  const all = await toolGetApprovedPins(config, { projectId }, fetchRemote);
  if (!all.packets || all.packets.length === 0) {
    return {
      pageUrl,
      pinCount: 0,
      pins: [],
      message: 'No approved pins on any page yet.',
    };
  }

  const needle = pageUrl.toLowerCase();
  const match = all.packets.find(p =>
    (p.pageUrl || '').toLowerCase() === needle ||
    (p.pageUrl || '').toLowerCase().includes(needle)
  );

  if (!match) {
    return {
      pageUrl,
      pinCount: 0,
      pins: [],
      availablePages: all.packets.map(p => p.pageUrl),
      message: `No approved pins found for page matching "${pageUrl}". Available pages: ${all.packets.map(p => p.pageUrl).join(', ')}.`,
    };
  }

  return {
    ...match,
    traceability: all.traceability,
    message: `${match.pinCount} pin(s) ready on "${match.pageTitle || match.pageUrl}". Implement them in one branch.`,
  };
}

// Assign a pin directly to the local coding agent. Sets pin to ready and
// drops a trigger file in .feedback/.agent-queue/ that agent-loop.mjs picks
// up and dispatches to Cursor/Claude Code/Codex. This is the first-class
// "assign to agent" action — turns a pin into agent work in one call.
export async function toolAssignPinToAgent(config, { annotationId, assignedBy } = {}, fetchRemote = null) {
  if (!annotationId) return { error: 'annotationId is required' };

  const allData = await readAllAnnotations(config, fetchRemote);

  for (const [url, data] of Object.entries(allData)) {
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;

    if (ann.status === 'resolved') {
      return { success: false, error: `Pin "${annotationId}" is already resolved` };
    }

    const now = new Date().toISOString();

    // Promote to ready if not already approved
    if (!isReadyStatus(ann.status) && ann.status !== 'in-progress') {
      ann.status = 'ready';
      ann.approvedAt = ann.approvedAt || now;
      ann.approvedBy = ann.approvedBy || assignedBy || 'Agent assignment';
    }

    // Mark as queued for the agent. agent-loop will set action='implementing'
    // when it actually claims the pin via claim_pin.
    ann.action = 'pending_implementation';
    ann.assignedAt = now;
    ann.assignedBy = assignedBy || 'Unknown';
    ann.updatedAt = now;

    ann.thread = ann.thread || [];
    ann.thread.push({
      id: `msg_${Date.now().toString(36)}`,
      author: assignedBy || 'Pincushion',
      authorEmail: '',
      timestamp: now,
      body: `Assigned to coding agent`,
      type: 'assignment'
    });

    data.exportedAt = now;
    await writeAnnotationFile(config.annotationsDir, data);
    await rebuildIndex(config);
    pushAnnotationToSupabase(config, ann, url, data.pageTitle); // fire-and-forget

    // Write the queue trigger file for agent-loop.mjs to pick up.
    // Format matches what agent-loop's buildPrompt expects: id, pageUrl,
    // element, thread, and any work-packet fields the pin carries.
    if (config.agentQueueDir) {
      try {
        if (!existsSync(config.agentQueueDir)) {
          mkdirSync(config.agentQueueDir, { recursive: true });
        }
        const queuePath = join(config.agentQueueDir, `${annotationId}.json`);
        const queuePayload = {
          id: ann.id,
          pageUrl: url,
          pageTitle: data.pageTitle || url,
          element: ann.element || null,
          thread: ann.thread || [],
          projectId: ann.projectId || null,
          assignedAt: now,
          assignedBy: ann.assignedBy,
          // Work-packet fields (A3) — agents that understand them get richer
          // context; older agents ignore them.
          viewport: ann.viewport || null,
          domSnippet: ann.domSnippet || null,
          likelyFiles: ann.likelyFiles || null,
          acceptanceCriteria: ann.acceptanceCriteria || null,
        };
        await writeFile(queuePath, JSON.stringify(queuePayload, null, 2), 'utf-8');
      } catch (err) {
        // Queue write is best-effort — pin is still assigned even if the
        // file write fails (e.g. permissions issue on a shared mount).
        return {
          success: true,
          annotationId,
          assignedAt: now,
          warning: `Pin assigned but queue file failed: ${err.message}. agent-loop may not pick it up automatically.`,
          message: `Pin "${annotationId}" assigned to agent (queue file write failed).`
        };
      }
    }

    return {
      success: true,
      annotationId,
      assignedAt: now,
      assignedBy: ann.assignedBy,
      pageUrl: url,
      pageTitle: data.pageTitle || url,
      message: `Pin "${annotationId}" assigned to coding agent on "${data.pageTitle || url}". agent-loop will dispatch it within a few seconds.`,
    };
  }

  return { success: false, error: `Pin "${annotationId}" not found` };
}

export async function toolAddAgentReply(config, { annotationId, body, author }, fetchRemote = null) {
  if (!annotationId || !body) return { error: 'annotationId and body are required' };

  const allData = await readAllAnnotations(config, fetchRemote);

  for (const [url, data] of Object.entries(allData)) {
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;

    ann.thread.push({
      id: `msg_${Date.now().toString(36)}`,
      author: author || 'AI Agent',
      authorEmail: '',
      timestamp: new Date().toISOString(),
      body
    });

    data.exportedAt = new Date().toISOString();
    await writeAnnotationFile(config.annotationsDir, data);

    return {
      success: true,
      annotationId,
      message: `Added reply to annotation "${annotationId}"`
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

// ─── Pincushion AI: pending-work summary ────────────────────────────────────
// Single source of truth for "what bot work is owed?". Surfaced in three
// places (every sync response, /pins output, first-tool-of-session banner)
// so the queue-and-poll model never feels like a fax machine — pending bot
// items become impossible to miss without spamming.
//
// Both flows are queue-and-poll (LLM never runs server-side), so this
// helper just counts the candidates.

export async function getPendingWorkSummary(config, fetchRemote = null) {
  let pendingCritiques = 0;
  let pendingReplies = 0;
  // Network call — silently degrade on error so a queue outage doesn't
  // break unrelated MCP tools.
  try {
    const r = await toolGetPendingCritiques(config, {});
    if (r && r.success) pendingCritiques = r.count || 0;
  } catch { /* ignore */ }
  // Local read — pulls from .feedback files. Cheap.
  try {
    const r = await toolGetReplyCandidates(config, {}, fetchRemote);
    pendingReplies = (r && r.count) || 0;
  } catch { /* ignore */ }
  return {
    pendingCritiques,
    pendingReplies,
    hasWork: pendingCritiques > 0 || pendingReplies > 0,
  };
}

// ─── Pincushion AI: critique queue (deploy-hook integration) ───────────────
// The critique_queue table is written by the deploy-hook edge function on
// every Pro/Team deploy and consumed here by the dev's IDE. These wrappers
// call the dedicated `critique-queue` edge function — license-scoped, no
// LLM compute on Pincushion's side.

async function _critiqueQueueFetch(config, pathSuffix, init = {}) {
  const supabaseBase = config.supabaseBase || 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1';
  const licenseKey = config.licenseKey;
  if (!licenseKey) {
    return { ok: false, status: 401, body: { error: 'license_required', message: 'Set licenseKey in config to use the critique queue.' } };
  }
  try {
    const res = await fetch(`${supabaseBase}/critique-queue${pathSuffix}`, {
      ...init,
      headers: {
        ...(init.headers || {}),
        'Content-Type': 'application/json',
        'x-license-key': licenseKey,
      },
    });
    const body = await res.json().catch(() => ({}));
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { error: (err && err.message) || String(err) } };
  }
}

export async function toolGetPendingCritiques(config, { projectId } = {}) {
  const qs = projectId
    ? `?status=pending&project_id=${encodeURIComponent(projectId)}`
    : '?status=pending';
  const r = await _critiqueQueueFetch(config, qs, { method: 'GET' });
  if (!r.ok) {
    return { success: false, error: r.body?.error || 'queue_fetch_failed', message: r.body?.message, status: r.status };
  }
  const requests = (r.body?.requests || []).map(req => ({
    id: req.id,
    projectId: req.project_id,
    pageUrls: req.page_urls || [],
    deployHash: req.deploy_hash || null,
    resolvedPinIds: req.resolved_pin_ids || [],
    requestedAt: req.requested_at,
    pinCount: req.pin_count,
  }));
  return { success: true, count: requests.length, pending: requests };
}

export async function toolCompleteCritiqueRequest(config, { id, pinCount } = {}) {
  if (!id) return { success: false, error: 'id is required' };
  const r = await _critiqueQueueFetch(config, '/complete', {
    method: 'POST',
    body: JSON.stringify({ id, pin_count: pinCount }),
  });
  if (!r.ok) {
    return { success: false, error: r.body?.error || 'complete_failed', message: r.body?.message, status: r.status };
  }
  return {
    success: true,
    id: r.body?.request?.id,
    completedAt: r.body?.request?.completed_at,
    pinCount: r.body?.request?.pin_count,
  };
}

// ─── Pincushion AI: shared bot identity ─────────────────────────────────────
// Single source of truth for the bot's identity. The Chrome extension's
// `isBotPin` and the edge function's spoof-rejection logic both key on the
// email — never on the display name — so this is the trust anchor.
const BOT_EMAIL = 'pincushion-bot@pincushion.io';
const BOT_AUTHOR = 'Pincushion AI';
const CRITIQUE_SEVERITIES = new Set(['high', 'medium']);

// ─── Pincushion AI: Reply Candidates + Bot Reply ────────────────────────────
// Used by the /pincushion-replies slash command. Returns the set of pins where
// the bot should respond, with the trigger reason attached so the slash
// command can craft an appropriate reply. Two trigger categories:
//
//   A. "mention"     — any pin where the latest thread message contains
//                      `@pincushion` AND was authored by a human.
//   B. "reply-on-bot-pin" — pin authored by the bot (first thread message
//                      from Pincushion AI) where the latest message is from
//                      a human.
//
// Idempotency rule (applied to both): if the LATEST thread message is
// bot-authored, skip the pin. The bot never replies twice in a row.

const MENTION_REGEX = /@pincushion\b/i;

function _isBotThreadMessage(msg) {
  if (!msg) return false;
  return msg.authorEmail === BOT_EMAIL || msg.author === BOT_AUTHOR;
}

export async function toolGetReplyCandidates(config, { projectId } = {}, fetchRemote = null) {
  const allData = await readAllAnnotations(config, fetchRemote);
  const candidates = [];

  for (const [pageUrl, pageData] of Object.entries(allData)) {
    for (const ann of (pageData.annotations || [])) {
      if (projectId && ann.projectId !== projectId) continue;
      // Skip resolved/archived — bot doesn't reply on closed threads.
      if (ann.status === 'resolved' || ann.status === 'archived') continue;
      const thread = ann.thread || [];
      if (!thread.length) continue;

      const lastMsg = thread[thread.length - 1];
      // Idempotency: if latest message is bot-authored, no reply needed.
      if (_isBotThreadMessage(lastMsg)) continue;

      // Trigger A — @pincushion mention in the latest message.
      const mentionedInLast = lastMsg.body && MENTION_REGEX.test(lastMsg.body);

      // Trigger B — pin originally authored by the bot, latest message is human.
      const firstMsg = thread[0];
      const pinIsBotAuthored = ann.isBot === true || _isBotThreadMessage(firstMsg);
      const repliedOnBotPin = pinIsBotAuthored && !_isBotThreadMessage(lastMsg);

      if (!mentionedInLast && !repliedOnBotPin) continue;

      // Build a minimal candidate record for the slash command. Include
      // enough context to draft a reply: the pin's selector, the latest
      // human message, and the trigger reason.
      candidates.push({
        annotationId: ann.id,
        pageUrl,
        pageTitle: pageData.pageTitle || pageUrl,
        projectId: ann.projectId || null,
        selector: ann.element?.selector || null,
        componentName: ann.element?.lwcComponent || null,
        triggers: [
          ...(mentionedInLast ? ['mention'] : []),
          ...(repliedOnBotPin ? ['reply-on-bot-pin'] : []),
        ],
        latestMessage: {
          author: lastMsg.author,
          body: lastMsg.body,
          timestamp: lastMsg.timestamp,
        },
        // Send the recent thread so the bot can keep tone consistent.
        recentThread: thread.slice(-6).map(m => ({
          author: m.author,
          isBot: _isBotThreadMessage(m),
          body: m.body,
          timestamp: m.timestamp,
        })),
        pinIsBotAuthored,
      });
    }
  }

  // Newest first so the slash command can pace replies if there's a backlog.
  candidates.sort((a, b) =>
    new Date(b.latestMessage.timestamp || 0) - new Date(a.latestMessage.timestamp || 0)
  );
  return { candidates, count: candidates.length };
}

export async function toolAddBotReply(config, { annotationId, body } = {}, fetchRemote = null) {
  if (!annotationId) return { success: false, error: 'annotationId is required' };
  if (!body || typeof body !== 'string' || !body.trim()) {
    return { success: false, error: 'body is required (the bot reply text)' };
  }
  // Same length cap as create_critique_pin so the bot stays on-brand.
  const trimmedBody = body.trim().slice(0, 800);

  const allData = await readAllAnnotations(config, fetchRemote);
  // IMPORTANT: capture `url` from the entry key, not `ann.pageUrl`. Annotations
  // are file-keyed by URL slug; the URL itself isn't always embedded on each
  // annotation row, so reading from the key is the only reliable source. The
  // legacy reply/resolve helpers (toolAddAgentReply, toolFixAndResolve) already
  // do this; toolAddBotReply originally dropped the key and synced bot replies
  // with empty pageUrl until this fix.
  for (const [url, data] of Object.entries(allData)) {
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;

    // Defensive idempotency check: if the last thread message is already
    // bot-authored, refuse — prevents a buggy slash command run from
    // doubling up replies if it's invoked twice.
    const lastMsg = (ann.thread || [])[ann.thread.length - 1];
    if (_isBotThreadMessage(lastMsg)) {
      return {
        success: false,
        error: 'idempotency_skip',
        message: `Pin "${annotationId}" already has a Pincushion AI reply as the most recent message — no reply posted.`,
      };
    }

    ann.thread = ann.thread || [];
    ann.thread.push({
      id: `msg_${Date.now().toString(36)}`,
      author: BOT_AUTHOR,
      authorEmail: BOT_EMAIL, // critical — the Chrome extension keys bot styling on this exact email
      timestamp: new Date().toISOString(),
      body: trimmedBody,
    });
    ann.updatedAt = new Date().toISOString();

    data.exportedAt = new Date().toISOString();
    await writeAnnotationFile(config.annotationsDir, data);

    // Push back to cloud so other clients see the reply quickly.
    pushAnnotationToSupabase(config, ann, url, data.pageTitle);

    return {
      success: true,
      annotationId,
      message: `Pincushion AI replied on pin "${annotationId}".`,
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

// ─── Pincushion AI: Bot Critique Pin ─────────────────────────────────────────
// Used by the /critique slash command and /critique-latest-deploy. Writes a
// pin authored by Pincushion AI to .feedback/<page-slug>.json and pushes to
// Supabase. The Chrome extension resolves screen position from element.selector
// since the bot has no live page coords.
//
// Strict invariants:
// - author === 'Pincushion AI', authorEmail === 'pincushion-bot@pincushion.io'.
// - isBot === true. The edge function only honors this when author_email
//   matches the canonical bot, so a spoofed payload from elsewhere is rejected.
// - severity ∈ {'high','medium'} maps to priority. 'low' is intentionally
//   excluded — the bot's job is to flag issues worth acting on, not noise.
//
// Bot identity constants (BOT_EMAIL, BOT_AUTHOR, CRITIQUE_SEVERITIES) are
// declared at the top of the Pincushion AI block above so reply helpers
// share the same trust anchor.

export async function toolCreateCritiquePin(config, {
  pageUrl,
  pageTitle,
  componentName,
  selector,
  body,
  severity = 'medium',
  tags = [],
  projectId,
} = {}, fetchRemote = null) {
  // Validate up-front so the critic subagent gets a clear error instead of a
  // half-written pin file.
  if (!pageUrl) return { success: false, error: 'pageUrl is required' };
  if (!body || typeof body !== 'string' || !body.trim()) {
    return { success: false, error: 'body is required (the critique text shown to the user)' };
  }
  if (!CRITIQUE_SEVERITIES.has(severity)) {
    return { success: false, error: `severity must be one of: ${[...CRITIQUE_SEVERITIES].join(', ')}` };
  }
  if (selector !== undefined && typeof selector !== 'string') {
    return { success: false, error: 'selector must be a string CSS selector' };
  }
  if (!Array.isArray(tags)) {
    return { success: false, error: 'tags must be an array of strings' };
  }
  // Hard cap on body length: prevents an LLM from dumping a 5000-word essay
  // into a thread message. UX is concrete pins, not blog posts.
  const trimmedBody = body.trim().slice(0, 800);

  const now = new Date().toISOString();
  const annotationId = `ann_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const projectIdToUse = projectId || config.projectId || null;

  // Always tag with 'pincushion-ai' for downstream filtering. Caller can add
  // their own tags (e.g. 'auto-critique', 'deploy:<hash>').
  const finalTags = [...new Set(['pincushion-ai', ...tags.map(String)])];

  const newAnn = {
    id: annotationId,
    pageUrl,
    // Bot pins start 'open' like any human pin — the team triages them into
    // 'ready'. (They used to skip straight to 'ready', which read as
    // pre-approved work nobody had reviewed.)
    status: 'open',
    // No priority field — it's in the schema but unused in the UI/MCP today.
    // `severity` stays in the input schema as the subagent's "is this worth
    // pinning at all?" frame, but it doesn't get persisted as priority.
    tags: finalTags,
    element: {
      selector: selector || null,
      lwcComponent: componentName || null,
    },
    pin: null, // no live page coords; Chrome extension resolves via selector.
    thread: [{
      id: `msg_${Date.now().toString(36)}`,
      author: BOT_AUTHOR,
      authorEmail: BOT_EMAIL,
      timestamp: now,
      body: trimmedBody,
    }],
    createdAt: now,
    updatedAt: now,
    author: BOT_AUTHOR,
    authorEmail: BOT_EMAIL,
    isBot: true,
    projectId: projectIdToUse,
  };

  // Append to the page's annotation file (create if missing).
  const allData = await readAllAnnotations(config, fetchRemote);
  const existingPageData = allData[pageUrl] || { pageUrl, pageTitle: pageTitle || pageUrl, annotations: [] };
  existingPageData.pageUrl = pageUrl;
  existingPageData.pageTitle = pageTitle || existingPageData.pageTitle || pageUrl;
  existingPageData.annotations = [...(existingPageData.annotations || []), newAnn];
  existingPageData.exportedAt = now;
  await writeAnnotationFile(config.annotationsDir, existingPageData);
  await rebuildIndex(config);

  // Fire-and-forget cloud sync. Failure here doesn't roll back the local
  // write — the Chrome extension and IDE see local pins immediately, and
  // background sync retries on the next poll.
  pushAnnotationToSupabase(config, newAnn, pageUrl, existingPageData.pageTitle);

  return {
    success: true,
    annotationId,
    pin: {
      id: annotationId,
      pageUrl,
      selector: selector || null,
      severity,
      tags: finalTags,
      author: BOT_AUTHOR,
      isBot: true,
    },
    message: `Created Pincushion AI pin "${annotationId}" on ${pageUrl}.`,
  };
}

export async function toolFixAndResolve(config, { annotationId, fixDescription, filePath, lineNumber, commitSha, branchName, prUrl }, fetchRemote = null) {
  if (!annotationId || !fixDescription) {
    return { error: 'annotationId and fixDescription are required' };
  }

  const allData = await readAllAnnotations(config, fetchRemote);

  for (const [url, data] of Object.entries(allData)) {
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;

    const implementedAt = new Date().toISOString();
    const locationSuffix = filePath
      ? ` (${filePath}${lineNumber ? `:${lineNumber}` : ''})`
      : '';

    // fix_and_resolve is the terminal transition in the Open → Ready → Resolved
    // lifecycle. The pin should disappear from the stakeholder's Ready tab the
    // moment the agent finishes. Previously this set only `action='implemented'`
    // and the pin stayed visible until someone manually called resolve_annotation
    // — the tool name promised resolution but didn't deliver it.
    ann.status = 'resolved';
    ann.resolvedAt = implementedAt;
    ann.action = 'implemented';
    ann.implementedAt = implementedAt;
    ann.updatedAt = implementedAt; // must bump so cloud sync pull doesn't overwrite

    // Bidirectional pin↔commit link. Only persisted when the project's
    // recordCommitSha setting is on (default: true). The check is
    // best-effort — if config can't be loaded, we keep today's behavior
    // by writing the SHA, since it's invisible plumbing with no source-
    // code or commit-log cost.
    if (commitSha) {
      const projectConfig = await readProjectConfig(config, ann.projectId).catch(() => null);
      const recordSha = projectConfig?.recordCommitSha !== false;
      if (recordSha) ann.commitSha = commitSha;
    }

    // A4: Branch / PR linkage. These let the stakeholder see "Resolved in
    // PR #142" without an extra round-trip, and they're how time-to-fix is
    // computed (commit timestamp - pin createdAt). Validation is light —
    // we'd rather store a slightly malformed URL than block the resolve.
    if (typeof branchName === 'string' && branchName.trim()) {
      ann.branchName = branchName.trim().slice(0, 200);
    }
    if (typeof prUrl === 'string' && prUrl.trim()) {
      const trimmed = prUrl.trim().slice(0, 500);
      // Only store URLs that look like a GitHub/GitLab/Bitbucket PR — prevents
      // accidental injection of arbitrary text into the dashboard link.
      if (/^https?:\/\/[a-z0-9.-]+\/.+\/(pull|merge_requests?|pull-requests)\/[0-9a-z-]+/i.test(trimmed)) {
        ann.prUrl = trimmed;
      }
    }

    ann.thread = ann.thread || [];
    ann.thread.push({
      id: `msg_${Date.now().toString(36)}`,
      author: 'AI Agent',
      authorEmail: '',
      timestamp: implementedAt,
      body: `Implemented: ${fixDescription}${locationSuffix}`,
      type: 'code-note'
    });

    data.exportedAt = new Date().toISOString();
    await writeAnnotationFile(config.annotationsDir, data);
    await rebuildIndex(config);
    pushAnnotationToSupabase(config, ann, url, data.pageTitle); // fire-and-forget

    // Clean up agent queue file if it exists. Best-effort: the pin is already
    // resolved, so failure here is non-fatal — but a leftover queue file can
    // cause a stale re-dispatch, so surface it on stderr rather than swallow.
    try {
      const { unlink } = await import('fs/promises');
      const queueFile = join(config.agentQueueDir, `${annotationId}.json`);
      if (existsSync(queueFile)) {
        await unlink(queueFile);
      }
    } catch (err) {
      console.error(`[pincushion] Failed to remove agent queue file for ${annotationId} (non-fatal):`, err?.message || err);
    }

    return {
      success: true,
      annotationId,
      message: `Resolved "${annotationId}" on page "${data.pageTitle || url}".`,
      status: 'resolved',
      fixDescription,
      filePath,
      lineNumber,
      commitSha: ann.commitSha || null,
      branchName: ann.branchName || null,
      prUrl: ann.prUrl || null,
      resolvedAt: ann.resolvedAt || null,
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

// A6: time-to-fix metrics. Computes median + p25/p75 over the duration
// between pin creation and resolution. Returns null when the sample is too
// small to be statistically meaningful (< 5 resolved pins) so the landing
// page doesn't lie about velocity.
//
// Pro/Team gate is enforced at the server.js wrapper layer (it owns license
// state). This pure builder returns the Free-tier degraded payload so it
// stays unit-testable.
export function buildFreeTierMetricsResponse(sampleSize, scope, projectId, currentPlan = 'free') {
  return {
    sampleSize: sampleSize ?? 0,
    thresholdMet: false,
    median: null,
    p25: null,
    p75: null,
    scope,
    projectId: scope === 'project' ? (projectId || null) : null,
    planRequired: 'pro',
    currentPlan,
    upgradeUrl: 'https://pincushion.io/#pricing',
    message: `Time-to-fix metrics require Pro or Team. Sample size visible (${sampleSize ?? 0} resolved pin(s)); upgrade to see median, p25, and p75.`,
  };
}
//
// Stat note: percentile uses linear interpolation (R default). Sample size
// is exposed so callers can decide whether to display the number publicly.
function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

export async function toolGetTimeToFixMetrics(config, { projectId, scope = 'project' } = {}, fetchRemote = null) {
  if (scope !== 'project' && scope !== 'global') {
    return { error: 'scope must be "project" or "global"' };
  }

  const allData = await readAllAnnotations(config, fetchRemote);
  const durations = []; // in seconds

  for (const data of Object.values(allData)) {
    for (const ann of (data.annotations || [])) {
      if (scope === 'project' && !matchesProject(ann.projectId, projectId)) continue;
      if (ann.status !== 'resolved') continue;
      if (!ann.createdAt || !ann.resolvedAt) continue;
      const start = new Date(ann.createdAt).getTime();
      const end = new Date(ann.resolvedAt).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
      durations.push(Math.round((end - start) / 1000));
    }
  }

  const sampleSize = durations.length;
  // Honest threshold: under 5 resolved pins, medians are noise. Return the
  // count but no metric so the caller can hide the widget.
  if (sampleSize < 5) {
    return {
      sampleSize,
      median: null,
      p25: null,
      p75: null,
      scope,
      projectId: scope === 'project' ? (projectId || null) : null,
      message: `Only ${sampleSize} resolved pin(s) — need at least 5 to compute a meaningful median.`,
      thresholdMet: false,
    };
  }

  const sorted = [...durations].sort((a, b) => a - b);
  const median = percentile(sorted, 0.5);
  const p25 = percentile(sorted, 0.25);
  const p75 = percentile(sorted, 0.75);

  return {
    sampleSize,
    median,
    p25,
    p75,
    medianHuman: humanizeSeconds(median),
    p25Human: humanizeSeconds(p25),
    p75Human: humanizeSeconds(p75),
    scope,
    projectId: scope === 'project' ? (projectId || null) : null,
    thresholdMet: true,
    message: `Median time-to-fix: ${humanizeSeconds(median)} across ${sampleSize} resolved pin(s).`,
  };
}

function humanizeSeconds(s) {
  if (!Number.isFinite(s) || s < 0) return 'n/a';
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${(s / 3600).toFixed(1)}h`;
  return `${(s / 86400).toFixed(1)}d`;
}

// A5: record the outcome of Pincushion AI's post-deploy verification on a
// resolved pin. Called by the critic subagent after running the auto-critique
// for a fresh deploy. Status one of:
//   'verified'      — the fix is in place and no regressions detected
//   'regressed'     — the fix appears to have introduced a new issue
//   'inconclusive'  — the critic couldn't determine outcome (e.g. element gone)
//   'pending'       — explicit reset to pending (rare; used when re-running)
const VERIFICATION_STATUSES = new Set(['verified', 'regressed', 'inconclusive', 'pending']);

export async function toolRecordPinVerification(config, { annotationId, status, notes, verifiedAt } = {}, fetchRemote = null) {
  if (!annotationId) return { error: 'annotationId is required' };
  if (!status || !VERIFICATION_STATUSES.has(status)) {
    return { error: `status must be one of: ${[...VERIFICATION_STATUSES].join(', ')}` };
  }

  const cleanNotes = typeof notes === 'string' ? notes.slice(0, 2000) : null;
  const cleanVerifiedAt = (typeof verifiedAt === 'string' && verifiedAt) ? verifiedAt : new Date().toISOString();

  const allData = await readAllAnnotations(config, fetchRemote);
  for (const [url, data] of Object.entries(allData)) {
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;

    ann.verificationStatus = status;
    ann.verificationNotes = cleanNotes;
    ann.verifiedAt = cleanVerifiedAt;
    ann.updatedAt = new Date().toISOString();

    data.exportedAt = new Date().toISOString();
    await writeAnnotationFile(config.annotationsDir, data);
    pushAnnotationToSupabase(config, ann, url, data.pageTitle); // fire-and-forget

    return {
      success: true,
      annotationId,
      verificationStatus: status,
      verificationNotes: cleanNotes,
      verifiedAt: cleanVerifiedAt,
      message: `Recorded verification "${status}" on pin "${annotationId}".`,
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

// A4: link a deploy URL to a resolved pin. Called by deploy-hook when the
// resolved-pins set is auto-finalized on deploy. Idempotent — re-running on
// the same pin overwrites the previous deploy_url with the latest value
// (newer deploy supersedes the older one).
export async function toolLinkPinDeploy(config, { annotationId, deployUrl, deployedAt } = {}, fetchRemote = null) {
  if (!annotationId) return { error: 'annotationId is required' };
  if (!deployUrl || typeof deployUrl !== 'string') return { error: 'deployUrl is required' };

  // Light URL validation. We do NOT restrict to specific hosts — deploys
  // happen on Vercel, Netlify, AWS, Render, custom CDNs. Just ensure it's
  // an http(s) URL of reasonable length.
  let parsed;
  try {
    parsed = new URL(deployUrl);
  } catch {
    return { error: 'deployUrl must be a valid URL' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { error: 'deployUrl must use http or https' };
  }
  const cleanDeployUrl = parsed.toString().slice(0, 500);
  const cleanDeployedAt = (typeof deployedAt === 'string' && deployedAt) ? deployedAt : new Date().toISOString();

  const allData = await readAllAnnotations(config, fetchRemote);
  for (const [url, data] of Object.entries(allData)) {
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;

    ann.deployUrl = cleanDeployUrl;
    ann.deployedAt = cleanDeployedAt;
    ann.updatedAt = new Date().toISOString();

    data.exportedAt = new Date().toISOString();
    await writeAnnotationFile(config.annotationsDir, data);
    pushAnnotationToSupabase(config, ann, url, data.pageTitle); // fire-and-forget

    return {
      success: true,
      annotationId,
      deployUrl: cleanDeployUrl,
      deployedAt: cleanDeployedAt,
      message: `Linked deploy "${cleanDeployUrl}" to pin "${annotationId}".`,
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

export async function toolGetActionablePins(config, { projectId, mode, mentionedUser } = {}, fetchRemote = null) {
  const allData = await readAllAnnotations(config, fetchRemote);
  const actionable = [];
  // Normalise mentionedUser: strip leading @ so "@josh" and "josh" both work
  const mentionFilter = mentionedUser ? mentionedUser.replace(/^@/, '').toLowerCase() : null;

  for (const [url, data] of Object.entries(allData)) {
    for (const ann of (data.annotations || [])) {
      // Skip already-resolved pins
      if (ann.status === 'resolved') continue;

      // Classify this pin into modes:
      //
      //   'auto-agent'      — user clicked "Send to Agent" or YOLO mode; action = pending_implementation
      //   'preview-ready'   — agent generated a preview; commenter can review/approve
      //   'preview-approved'— commenter approved; dev can apply
      //   'preview-revised' — commenter revised after seeing preview; agent should re-generate
      //   'follow-up'       — previously implemented pin with a new user comment
      //   'review'          — open pin with no action set; standard review queue
      //
      // All modes show up for developers. Preview modes also surface for commenters.

      let pinMode = null;

      // v2 status-driven: ready pins (formerly 'approved') are highest priority
      // — implement immediately. Honor both names so legacy local files still work.
      if (isReadyStatus(ann.status)) {
        pinMode = 'approved';
      } else if (ann.action === 'implemented') {
        // Implemented + awaiting human resolve. Only re-surface as a follow-up
        // if the user has replied AFTER the agent's last code-note. Checked
        // before `status === 'in-progress'` so follow-up replies on legacy
        // implemented-but-unresolved pins still re-enter the queue.
        const thread = ann.thread || [];
        const lastCodeNote = [...thread].reverse().find(m => m.type === 'code-note');
        if (lastCodeNote) {
          const lastUserMsg = [...thread].reverse().find(
            m => m.type !== 'code-note' && m.type !== 'decline' && m.author !== 'AI Agent'
          );
          if (lastUserMsg && new Date(lastUserMsg.timestamp) > new Date(lastCodeNote.timestamp)) {
            pinMode = 'follow-up';
          }
        }
      } else if (ann.status === 'in-progress') {
        pinMode = 'in-progress';
      } else if (ann.action === 'pending_implementation') {
        pinMode = 'auto-agent';
      } else if (ann.action === 'preview_ready') {
        pinMode = 'preview-ready';
      } else if (ann.action === 'preview_approved') {
        pinMode = 'preview-approved';
      } else if (ann.action === 'preview_revised') {
        pinMode = 'preview-revised';
      } else if (ann.action === 'preview_generating') {
        pinMode = 'auto-agent'; // Still processing — group with auto-agent
      } else if (!ann.action || ann.action === null || ann.action === 'none') {
        // Review Mode pin: reviewer left a comment, hasn't explicitly sent to agent
        // Only surface if there's at least one user comment in the thread
        const hasComment = (ann.thread || []).some(
          m => m.type !== 'code-note' && m.type !== 'decline' && m.author !== 'AI Agent'
        );
        if (hasComment) {
          pinMode = 'review';
        }
      }

      if (!pinMode) continue;

      // Optional filters (supports string ID or Set of IDs)
      if (!matchesProject(ann.projectId, projectId)) continue;
      if (mode && pinMode !== mode) continue;
      // mentionedUser: only include if @username appears in any thread message body
      if (mentionFilter) {
        const mentioned = (ann.thread || []).some(m =>
          m.body && m.body.toLowerCase().includes(`@${mentionFilter}`)
        );
        if (!mentioned) continue;
      }

      actionable.push({
        id: ann.id,
        pageUrl: url,
        pageTitle: data.pageTitle || url,
        projectId: ann.projectId || null,
        status: ann.status,
        action: ann.action,
        mode: pinMode,           // 'auto-agent' | 'follow-up' | 'review'
        element: {
          lwcComponent: ann.element?.lwcComponent,
          selector: ann.element?.selector,
          tagName: ann.element?.tagName,
          textContent: ann.element?.textContent?.slice(0, 150),
          attributes: ann.element?.attributes
        },
        thread: ann.thread?.map(serializeThreadMessage),
        preview: ann.preview ? {
          status: ann.preview.status,
          diff: ann.preview.diff,
          cssOverride: ann.preview.cssOverride,
          complexity: ann.preview.complexity,
          model: ann.preview.model,
          generatedAt: ann.preview.generatedAt,
          filePath: ann.preview.filePath,
        } : null,
        createdAt: ann.createdAt
      });
    }
  }

  // Sort: approved pins first (stakeholder-approved, implement now), then in-progress, etc.
  const modeOrder = {
    'approved': 0,          // Stakeholder approved — implement immediately
    'in-progress': 1,       // Already claimed, finish implementation
    'preview-approved': 2,  // Commenter approved — dev should apply
    'auto-agent': 3,        // Queued for processing
    'preview-revised': 4,   // Needs re-generation
    'preview-ready': 5,     // Awaiting commenter review
    'follow-up': 6,
    'review': 7,
  };
  // Sort by mode (approved first, etc.) then by age (oldest first within mode).
  // Priority secondary-sort was removed when the priority column went dormant.
  actionable.sort((a, b) => {
    const md = (modeOrder[a.mode] ?? 5) - (modeOrder[b.mode] ?? 5);
    if (md !== 0) return md;
    return new Date(a.createdAt) - new Date(b.createdAt);
  });

  const approvedCount        = actionable.filter(p => p.mode === 'approved').length;
  const inProgressCount      = actionable.filter(p => p.mode === 'in-progress').length;
  const previewApprovedCount = actionable.filter(p => p.mode === 'preview-approved').length;
  const previewReadyCount    = actionable.filter(p => p.mode === 'preview-ready').length;
  const previewRevisedCount  = actionable.filter(p => p.mode === 'preview-revised').length;
  const autoAgentCount       = actionable.filter(p => p.mode === 'auto-agent').length;
  const followUpCount        = actionable.filter(p => p.mode === 'follow-up').length;
  const reviewCount          = actionable.filter(p => p.mode === 'review').length;

  const parts = [];
  if (approvedCount)        parts.push(`${approvedCount} APPROVED — implement now`);
  if (inProgressCount)      parts.push(`${inProgressCount} in-progress — finish implementation`);
  if (previewApprovedCount) parts.push(`${previewApprovedCount} preview approved (ready to apply)`);
  if (autoAgentCount)       parts.push(`${autoAgentCount} auto-agent`);
  if (previewRevisedCount)  parts.push(`${previewRevisedCount} revised (needs re-gen)`);
  if (previewReadyCount)    parts.push(`${previewReadyCount} preview ready`);
  if (followUpCount)        parts.push(`${followUpCount} follow-up`);
  if (reviewCount)          parts.push(`${reviewCount} review`);
  const summary = parts.join(', ');

  // Build priority-ordered instructions
  let instructions;
  if (approvedCount > 0) {
    instructions = `⚡ ${approvedCount} APPROVED PIN(S) — IMPLEMENT NOW.\n` +
      'These pins have been approved by stakeholders and are waiting for you to implement.\n' +
      'Workflow:\n' +
      '  1. Call implement_approved_pins to get full context (element selectors, thread, branch names)\n' +
      '  2. For each pin: claim_pin → find the code using the element selector → make the change → fix_and_resolve\n' +
      '  3. Commit and push the branch\n' +
      (inProgressCount > 0 ? `\nAlso: ${inProgressCount} pin(s) already claimed but not yet resolved — finish those too.\n` : '') +
      (actionable.length > approvedCount + inProgressCount ? `\n${actionable.length - approvedCount - inProgressCount} other pin(s) also need attention.` : '');
  } else if (inProgressCount > 0) {
    instructions = `${inProgressCount} pin(s) are claimed/in-progress but not yet resolved. Finish implementation and call fix_and_resolve for each.`;
  } else if (actionable.length > 0) {
    instructions = `${actionable.length} pins awaiting attention (${summary}). ` +
      'For all pins: read the thread, implement the change, then call fix_and_resolve({ annotationId, fixDescription }).';
  } else {
    instructions = 'No pins are currently awaiting attention.';
  }

  return {
    totalActionable: actionable.length,
    breakdown: {
      approved: approvedCount,
      inProgress: inProgressCount,
      previewApproved: previewApprovedCount,
      previewReady: previewReadyCount,
      previewRevised: previewRevisedCount,
      autoAgent: autoAgentCount,
      followUp: followUpCount,
      review: reviewCount,
    },
    pins: actionable,
    instructions,
  };
}

export async function toolClaimPin(config, { annotationId, implementer } = {}, fetchRemote = null) {
  if (!annotationId) return { error: 'annotationId is required' };

  const allData = await readAllAnnotations(config, fetchRemote);

  for (const [url, data] of Object.entries(allData)) {
    const ann = (data.annotations || []).find(a => a.id === annotationId);
    if (!ann) continue;

    // Claimable states:
    //   ready/approved        — went through approve_pin flow OR was auto-published
    //                           by Pincushion AI (bot pins ship as 'ready'; human
    //                           approval flow now writes 'ready' too post-rename
    //                           migration). Both names are honored.
    //   pending_implementation — user clicked "Send to Agent"
    //   open (review mode)    — reviewer left a comment; dev picks it up directly
    const isReviewPin = (ann.status === 'open' || ann.status === 'in-progress') &&
      (!ann.action || ann.action === null || ann.action === 'none') &&
      (ann.thread || []).some(m => m.type !== 'code-note' && m.type !== 'decline' && m.author !== 'AI Agent');
    const isClaimable = isReadyStatus(ann.status) || ann.action === 'pending_implementation' || isReviewPin;
    if (!isClaimable) {
      const hint = ann.status === 'resolved'
        ? 'Pin is already resolved.'
        : ann.action === 'implemented'
          ? 'Pin is already implemented and not pending implementation — add a follow-up comment to re-queue it.'
          : ann.action === 'implementing'
            ? `Pin is already being implemented by ${ann.implementer || 'someone'}.`
            : 'Pin is not pending implementation, has no reviewable comments yet, and has not been approved or queued.';
      return { error: `Pin "${annotationId}" cannot be claimed. ${hint}` };
    }

    ann.status = 'in-progress';
    ann.action = 'implementing';
    ann.implementer = implementer || 'AI Agent';
    ann.updatedAt = new Date().toISOString();

    data.exportedAt = new Date().toISOString();
    await writeAnnotationFile(config.annotationsDir, data);
    pushAnnotationToSupabase(config, ann, url, data.pageTitle); // fire-and-forget

    return {
      success: true,
      annotationId,
      message: `Claimed pin "${annotationId}" — now marked as implementing by ${ann.implementer}`
    };
  }

  return { success: false, error: `Annotation "${annotationId}" not found` };
}

const COMMENT_ACCESS_VALUES = new Set(['open', 'domain', 'invited']);

export async function toolConfigureProject(config, {
  name: projectName,
  urls = [],
  domain,
  commitTrailers,
  attributionComments,
  recordCommitSha,
  commentAccess,
  allowedDomains,
  brandContext,
  autoCritique,
  critiqueSignals,
  critiquePolicy,
  critiqueContext,
} = {}) {
  if (!projectName) throw new Error('name is required');

  // Validate the traceability knobs up-front so a typo doesn't silently fall
  // back to a different behavior than the developer expected.
  if (commitTrailers !== undefined && !TRAILER_PRESET_VALUES.has(commitTrailers)) {
    throw new Error(`commitTrailers must be one of: ${[...TRAILER_PRESET_VALUES].join(', ')}`);
  }
  if (attributionComments !== undefined && !ATTRIBUTION_COMMENT_VALUES.has(attributionComments)) {
    throw new Error(`attributionComments must be one of: ${[...ATTRIBUTION_COMMENT_VALUES].join(', ')}`);
  }
  if (recordCommitSha !== undefined && typeof recordCommitSha !== 'boolean') {
    throw new Error('recordCommitSha must be a boolean');
  }
  if (commentAccess !== undefined && !COMMENT_ACCESS_VALUES.has(commentAccess)) {
    throw new Error(`commentAccess must be one of: ${[...COMMENT_ACCESS_VALUES].join(', ')}`);
  }
  if (commentAccess === 'domain' && !(Array.isArray(allowedDomains) && allowedDomains.length)) {
    throw new Error('allowedDomains is required when commentAccess is "domain" (e.g. ["acme.com"])');
  }
  if (allowedDomains !== undefined && !Array.isArray(allowedDomains)) {
    throw new Error('allowedDomains must be an array of bare domains');
  }
  if (brandContext !== undefined && typeof brandContext !== 'string') {
    throw new Error('brandContext must be a string (max 2048 chars)');
  }
  if (typeof brandContext === 'string' && brandContext.length > 2048) {
    throw new Error(`brandContext is too long (${brandContext.length} chars, max 2048). Trim it to the most load-bearing brand/business notes — the critic uses this on every prompt.`);
  }
  if (autoCritique !== undefined && typeof autoCritique !== 'boolean') {
    throw new Error('autoCritique must be a boolean');
  }
  if (critiqueSignals !== undefined && critiqueSignals !== null && (typeof critiqueSignals !== 'object' || Array.isArray(critiqueSignals))) {
    throw new Error('critiqueSignals must be a plain object (or null to clear)');
  }
  if (critiquePolicy !== undefined && critiquePolicy !== null && typeof critiquePolicy !== 'string') {
    throw new Error('critiquePolicy must be a string (or null to clear)');
  }
  if (typeof critiquePolicy === 'string' && critiquePolicy.length > 4096) {
    throw new Error(`critiquePolicy is too long (${critiquePolicy.length} chars, max 4096). Trim it to the load-bearing rules — the critic reads it on every pin.`);
  }
  if (critiqueContext !== undefined && critiqueContext !== null && typeof critiqueContext !== 'string') {
    throw new Error('critiqueContext must be a string (or null to clear)');
  }
  if (typeof critiqueContext === 'string' && critiqueContext.length > 8192) {
    throw new Error(`critiqueContext is too long (${critiqueContext.length} chars, max 8192). Compile it down to the essentials — every pin pays this cost.`);
  }

  // Normalise urls: accept strings like "localhost:3000" or full origins.
  // Preserve the path when the user supplied one — the extension does
  // prefix matching, so "http://localhost:3030/acme/" and "/dashboard"
  // are meaningful boundaries. Stripping to the origin would silently
  // make the project match every page on the host. Dedupe by full URL.
  // Local dev hosts (localhost, 127.0.0.1, *.local) almost always run over
  // plain http — defaulting them to https produces silent extension misses
  // because the Chrome extension never matches the registered https://localhost
  // URL against the actually-served http://localhost. Detect those hosts BEFORE
  // the protocol prepend so `localhost:3000` becomes `http://localhost:3000`
  // and `example.com` still becomes `https://example.com`. Hosts that already
  // include a protocol pass through untouched.
  const isLocalHost = (s) => /^(localhost(:\d+)?|127\.0\.0\.1(:\d+)?|::1(:\d+)?|[^\s/]+\.local(:\d+)?)(\/|$)/i.test(s);
  const normaliseUrl = (u) => {
    u = String(u || '').trim().replace(/\/+$/, '');
    if (!u) return null;
    if (!u.startsWith('http')) {
      u = `${isLocalHost(u) ? 'http' : 'https'}://${u}`;
    }
    try {
      const parsed = new URL(u);
      const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
      return `${parsed.origin}${path}`;
    } catch {
      return u;
    }
  };
  const normalisedUrls = [...new Set(urls.map(normaliseUrl).filter(Boolean))];

  // Load or create the local projects registry
  const projectsFile = join(config.feedbackDir, 'projects.json');
  let projects = {};
  try {
    projects = JSON.parse(await readFile(projectsFile, 'utf8'));
  } catch { /* first time — start fresh */ }

  // Check if a project already exists for this name
  const existingKey = Object.keys(projects).find(k => projects[k].name === projectName);

  let projectId;
  const isNew = !existingKey;
  let changeStatus = isNew ? 'created' : 'existing';
  if (existingKey) {
    projectId = existingKey;
    // Merge URLs
    const existingProject = projects[existingKey];
    const previousUrls = existingProject.urls || [];
    const merged = new Set([...previousUrls, ...normalisedUrls]);
    const mergedUrls = [...merged];
    const domainChanged = Boolean(domain && domain !== existingProject.domain);
    const urlsChanged = mergedUrls.length !== previousUrls.length ||
      mergedUrls.some(url => !previousUrls.includes(url));

    existingProject.urls = mergedUrls;
    if (domain) existingProject.domain = domain;

    // Only update each knob when explicitly supplied — `undefined` means
    // "leave it alone" so a partial reconfigure can't accidentally reset
    // a previously-tuned setting.
    let knobsChanged = false;
    if (commitTrailers !== undefined && existingProject.commitTrailers !== commitTrailers) {
      existingProject.commitTrailers = commitTrailers;
      knobsChanged = true;
    }
    if (attributionComments !== undefined && existingProject.attributionComments !== attributionComments) {
      existingProject.attributionComments = attributionComments;
      knobsChanged = true;
    }
    if (recordCommitSha !== undefined && existingProject.recordCommitSha !== recordCommitSha) {
      existingProject.recordCommitSha = recordCommitSha;
      knobsChanged = true;
    }
    if (commentAccess !== undefined && existingProject.commentAccess !== commentAccess) {
      existingProject.commentAccess = commentAccess;
      knobsChanged = true;
    }
    if (allowedDomains !== undefined) {
      const incoming = allowedDomains.map(d => String(d).toLowerCase().trim()).filter(Boolean);
      const prev = existingProject.allowedDomains || [];
      if (incoming.length !== prev.length || incoming.some(d => !prev.includes(d))) {
        existingProject.allowedDomains = incoming;
        knobsChanged = true;
      }
    }
    if (brandContext !== undefined && existingProject.brandContext !== brandContext) {
      existingProject.brandContext = brandContext;
      knobsChanged = true;
    }
    if (autoCritique !== undefined && existingProject.autoCritique !== autoCritique) {
      existingProject.autoCritique = autoCritique;
      knobsChanged = true;
    }
    // Layered critique fields. Each is updated independently so a partial
    // call (e.g. just policy from the dashboard) doesn't clobber signals.
    if (critiqueSignals !== undefined) {
      existingProject.critiqueSignals = critiqueSignals;
      knobsChanged = true;
    }
    if (critiquePolicy !== undefined) {
      existingProject.critiquePolicy = critiquePolicy;
      knobsChanged = true;
    }
    if (critiqueContext !== undefined) {
      existingProject.critiqueContext = critiqueContext;
      // Stamp the compile time + pin baseline whenever the compiled context
      // changes. This is what staleness checks read.
      if (critiqueContext) {
        existingProject.critiqueContextCompiledAt = new Date().toISOString();
        existingProject.critiqueContextPinsAtCompile = await countResolvedPinsForProject(config, projectId).catch(() => 0);
      } else {
        existingProject.critiqueContextCompiledAt = null;
        existingProject.critiqueContextPinsAtCompile = 0;
      }
      knobsChanged = true;
    }

    if (urlsChanged || domainChanged || knobsChanged) {
      changeStatus = 'updated';
    }
  } else {
    projectId = `pc_proj_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    projects[projectId] = {
      name: projectName,
      urls: normalisedUrls,
      domain: domain || (normalisedUrls[0] || null),
      createdAt: new Date().toISOString(),
      // Knobs are only written when explicitly set — absence means "use the
      // hardcoded default" (commitTrailers='minimal', attributionComments='off',
      // recordCommitSha=true, commentAccess='open') so existing projects
      // continue to behave identically.
      ...(commitTrailers !== undefined && { commitTrailers }),
      ...(attributionComments !== undefined && { attributionComments }),
      ...(recordCommitSha !== undefined && { recordCommitSha }),
      ...(commentAccess !== undefined && { commentAccess }),
      ...(allowedDomains !== undefined && {
        allowedDomains: allowedDomains.map(d => String(d).toLowerCase().trim()).filter(Boolean)
      }),
      ...(brandContext !== undefined && { brandContext }),
      ...(autoCritique !== undefined && { autoCritique }),
      ...(critiqueSignals !== undefined && { critiqueSignals }),
      ...(critiquePolicy !== undefined && { critiquePolicy }),
      ...(critiqueContext !== undefined && {
        critiqueContext,
        critiqueContextCompiledAt: critiqueContext ? new Date().toISOString() : null,
        critiqueContextPinsAtCompile: 0,
      }),
    };
  }

  if (!existsSync(config.feedbackDir)) mkdirSync(config.feedbackDir, { recursive: true });
  await writeFile(projectsFile, JSON.stringify(projects, null, 2));

  // Push to Supabase so the extension can pick up the URL registrations
  const supabaseBase = config.supabaseBase || 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1';
  const licenseKey = config.licenseKey || null;
  let cloudStatus = 'skipped (no license key)';
  if (licenseKey) {
    try {
      const resp = await fetch(`${supabaseBase}/sync-annotations/projects`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-license-key': licenseKey },
        body: JSON.stringify({
          projectId,
          name: projectName,
          urls: projects[projectId].urls,
          commentAccess: projects[projectId].commentAccess,
          allowedDomains: projects[projectId].allowedDomains,
          brandContext: projects[projectId].brandContext,
          autoCritique: projects[projectId].autoCritique,
          critiqueSignals: projects[projectId].critiqueSignals,
          critiquePolicy: projects[projectId].critiquePolicy,
          critiqueContext: projects[projectId].critiqueContext,
          critiqueContextCompiledAt: projects[projectId].critiqueContextCompiledAt,
          critiqueContextPinsAtCompile: projects[projectId].critiqueContextPinsAtCompile,
        }),
      });
      if (resp.ok) {
        cloudStatus = 'synced';
      } else {
        // Try to surface the server's own error message rather than a bare
        // "error 403". Common cases: 402 plan_required (Free maxProjects),
        // 403 not_authorized (caller is not owner/editor of an existing
        // project ID), 401 license invalid.
        let serverMessage = '';
        try {
          const body = await resp.json();
          serverMessage = body?.message || body?.error || '';
        } catch { /* non-JSON response */ }
        const hint = resp.status === 403
          ? 'You are not the owner of this project. Use a different name to create your own, or pass projectId of a project you own/edit.'
          : resp.status === 402
            ? `${serverMessage || 'Plan limit reached.'} See https://pincushion.io/#pricing.`
            : resp.status === 401
              ? 'License key is invalid or expired. Run init-session or check PINCUSHION_LICENSE_KEY.'
              : serverMessage;
        cloudStatus = hint
          ? `error ${resp.status} — ${hint}`
          : `error ${resp.status}`;
      }
    } catch (e) {
      cloudStatus = `error: ${e.message}`;
    }
  }

  const finalUrls = projects[projectId].urls;
  const snippet = `<meta name="pincushion-project" content="${projectId}">`;

  // ── Auto-create deploy hook ──────────────────────────────────────────────
  let deployHook = null;
  if (licenseKey) {
    try {
      // Check if hook already exists for this project
      await fetch(`${supabaseBase}/sync-annotations?deploy_hook_check=1&project_id=${encodeURIComponent(projectId)}`, {
        headers: { 'x-license-key': licenseKey },
      }).catch(() => null);

      // Create hook via direct Supabase REST (service role not available here, so use edge function)
      // We'll create it via a POST to deploy-hook/create or inline SQL via the sync endpoint
      // Simplest: generate token locally and upsert via sync-annotations
      const hookToken = `dhk_${projectId.replace('pc_proj_', '')}_${Date.now().toString(36)}`;
      const hookUpsertResp = await fetch(`${supabaseBase}/sync-annotations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-license-key': licenseKey },
        body: JSON.stringify({
          _deploy_hook: true,
          project_id: projectId,
          token: hookToken,
        }),
      }).catch(() => null);

      if (hookUpsertResp?.ok) {
        const hookUrl = `${supabaseBase}/deploy-hook/${hookToken}`;
        deployHook = { token: hookToken, url: hookUrl };
      }
    } catch { /* deploy hook creation is best-effort */ }
  }

  // ── Detect deployment platform ─────────────────────────────────────────
  let deployPlatform = null;
  const platformFiles = {
    'vercel.json': 'vercel',
    '.vercel/project.json': 'vercel',
    'netlify.toml': 'netlify',
    'fly.toml': 'fly',
    'render.yaml': 'render',
    'railway.json': 'railway',
    'Dockerfile': 'docker',
    '.github/workflows': 'github-actions',
  };

  const projectRoot = config.feedbackDir.replace(/\/.feedback$/, '');
  for (const [file, platform] of Object.entries(platformFiles)) {
    if (existsSync(join(projectRoot, file))) {
      deployPlatform = platform;
      break;
    }
  }

  // ── Build deploy hook instructions ─────────────────────────────────────
  let deployInstructions = '';
  if (deployHook) {
    const curlCmd = `curl -X POST "${deployHook.url}"`;

    const platformGuides = {
      vercel: `Vercel detected. Add to your project:\n  Settings → Git → Deploy Hooks → Add Hook\n  Or add to vercel.json build command:\n  "${curlCmd}"`,
      netlify: `Netlify detected. Add outgoing webhook:\n  Site Settings → Build & Deploy → Deploy notifications → Outgoing webhook on "Deploy succeeded"\n  URL: ${deployHook.url}`,
      'github-actions': `GitHub Actions detected. Add as the last step in your deploy job:\n  - name: Resolve Pincushion pins\n    run: ${curlCmd}`,
      fly: `Fly.io detected. Add to your deploy script:\n  fly deploy && ${curlCmd}`,
      docker: `Docker detected. Add to your CI/CD after deploy:\n  ${curlCmd}`,
      render: `Render detected. Add deploy hook notification:\n  ${curlCmd}`,
      railway: `Railway detected. Add to your deploy command:\n  ${curlCmd}`,
    };

    deployInstructions = deployHook
      ? `\n\n📦 Deploy Hook (auto-resolve pins on deploy):\n${platformGuides[deployPlatform] || `Add this to your CI/CD pipeline after deploy:\n  ${curlCmd}`}\n\nWhen this fires after a deploy, all implemented pins are automatically resolved.`
      : '';
  }

  const projectRecord = projects[projectId];
  return {
    projectId,
    projectName,
    urls: finalUrls,
    status: changeStatus,
    snippet,
    cloudSync: cloudStatus,
    deployHook: deployHook || null,
    deployPlatform,
    traceability: {
      commitTrailers: projectRecord.commitTrailers || 'minimal',
      attributionComments: projectRecord.attributionComments || 'off',
      recordCommitSha: projectRecord.recordCommitSha !== false,
    },
    ai: {
      // The Pincushion AI critic reads this block before every run. brandContext
      // is the noise filter — without it, /critique tends toward generic UX
      // advice. autoCritique gates whether deploy-hook triggers enqueue a
      // critique request (queue-and-poll model; LLM still runs in dev's IDE).
      brandContext: projectRecord.brandContext || null,
      autoCritique: projectRecord.autoCritique !== false,
      critique: {
        // Compiled context the bot loads at pin time — supersedes brandContext
        // when present. effectiveContext is what callers should read.
        effectiveContext: projectRecord.critiqueContext || projectRecord.brandContext || null,
        compiledContext: projectRecord.critiqueContext || null,
        policy: projectRecord.critiquePolicy || null,
        signals: projectRecord.critiqueSignals || null,
        compiledAt: projectRecord.critiqueContextCompiledAt || null,
        pinsAtCompile: Number(projectRecord.critiqueContextPinsAtCompile || 0),
        staleness: stalenessLabel(projectRecord.critiqueContext, projectRecord.critiqueContextCompiledAt),
      },
    },
    instructions: [
      `Project "${projectName}" configured (ID: ${projectId}).`,
      `Add this to your app HTML head:\n  ${snippet}`,
      finalUrls.length
        ? `Registered URLs:\n${finalUrls.map(u => `  • ${u}`).join('\n')}\nAnyone visiting these URLs with Pincushion installed will automatically connect to this project.`
        : `No URLs registered yet. Add them with:\n  configure_project({ name: "${projectName}", urls: ["localhost:3000", "yourapp.vercel.app"] })`,
      cloudStatus === 'synced'
        ? `Extension will pick up the URL registrations on next sync (up to 30s).`
        : `Set up cloud sync to share URL registrations with teammates.`,
    ].join('\n\n') + deployInstructions,
  };
}

// ─── Update Critique Context ─────────────────────────────────────────────────
// Lightweight write-only path for /setup and /refresh-brand. Persists the
// compiled critique brief + signals + policy without doing the heavy work
// configure_project does (deploy-hook creation, bot-member upsert, URL
// validation, platform detection). The dev agent calls this after gathering
// signals from the repo (README, theme tokens, sample copy, etc.) and
// synthesizing them into a compiled brief.
//
// The brief itself is computed by the dev's agent — we don't run an LLM
// on the Pincushion side. This tool only stores what the agent produced.

export async function toolUpdateCritiqueContext(config, {
  projectId,
  name: projectName,
  critiqueContext,
  critiquePolicy,
  critiqueSignals,
} = {}) {
  if (!projectId && !projectName) {
    throw new Error('projectId or name is required to identify which project to update');
  }
  if (critiqueContext === undefined && critiquePolicy === undefined && critiqueSignals === undefined) {
    throw new Error('At least one of critiqueContext, critiquePolicy, or critiqueSignals must be supplied');
  }
  if (critiqueSignals !== undefined && critiqueSignals !== null && (typeof critiqueSignals !== 'object' || Array.isArray(critiqueSignals))) {
    throw new Error('critiqueSignals must be a plain object (or null to clear)');
  }
  if (critiquePolicy !== undefined && critiquePolicy !== null && typeof critiquePolicy !== 'string') {
    throw new Error('critiquePolicy must be a string (or null to clear)');
  }
  if (typeof critiquePolicy === 'string' && critiquePolicy.length > 4096) {
    throw new Error(`critiquePolicy is too long (${critiquePolicy.length} chars, max 4096).`);
  }
  if (critiqueContext !== undefined && critiqueContext !== null && typeof critiqueContext !== 'string') {
    throw new Error('critiqueContext must be a string (or null to clear)');
  }
  if (typeof critiqueContext === 'string' && critiqueContext.length > 8192) {
    throw new Error(`critiqueContext is too long (${critiqueContext.length} chars, max 8192).`);
  }

  const projectsFile = join(config.feedbackDir, 'projects.json');
  let projects = {};
  try {
    projects = JSON.parse(await readFile(projectsFile, 'utf8'));
  } catch {
    throw new Error('No projects.json yet — run configure_project once before update_critique_context.');
  }

  let resolvedId = projectId;
  if (!resolvedId) {
    const entry = Object.entries(projects).find(([, p]) => p.name === projectName);
    if (!entry) {
      throw new Error(`No project named "${projectName}" in this workspace. Run configure_project first.`);
    }
    resolvedId = entry[0];
  }
  const record = projects[resolvedId];
  if (!record) {
    throw new Error(`No project with id "${resolvedId}" in this workspace.`);
  }

  if (critiqueSignals !== undefined) record.critiqueSignals = critiqueSignals;
  if (critiquePolicy !== undefined) record.critiquePolicy = critiquePolicy;
  if (critiqueContext !== undefined) {
    record.critiqueContext = critiqueContext;
    // Only re-stamp compile metadata when the compiled context itself
    // changed. Editing just the policy or signals doesn't count as a
    // compile — the bot still reads the old compiled context until the
    // next /refresh-brand run.
    if (critiqueContext) {
      record.critiqueContextCompiledAt = new Date().toISOString();
      record.critiqueContextPinsAtCompile = await countResolvedPinsForProject(config, resolvedId).catch(() => 0);
    } else {
      record.critiqueContextCompiledAt = null;
      record.critiqueContextPinsAtCompile = 0;
    }
  }

  if (!existsSync(config.feedbackDir)) mkdirSync(config.feedbackDir, { recursive: true });
  await writeFile(projectsFile, JSON.stringify(projects, null, 2));

  // Push to cloud. We reuse the existing /projects PUT — the edge function
  // now accepts the layered critique fields. Best-effort; local write is
  // authoritative if the user is offline.
  const supabaseBase = config.supabaseBase || 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1';
  const licenseKey = config.licenseKey || null;
  let cloudStatus = 'skipped (no license key)';
  if (licenseKey) {
    try {
      const resp = await fetch(`${supabaseBase}/sync-annotations/projects`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-license-key': licenseKey },
        body: JSON.stringify({
          projectId: resolvedId,
          name: record.name,
          urls: record.urls,
          critiqueSignals: record.critiqueSignals ?? null,
          critiquePolicy: record.critiquePolicy ?? null,
          critiqueContext: record.critiqueContext ?? null,
          critiqueContextCompiledAt: record.critiqueContextCompiledAt ?? null,
          critiqueContextPinsAtCompile: record.critiqueContextPinsAtCompile ?? 0,
        }),
      });
      cloudStatus = resp.ok ? 'synced' : `error ${resp.status}`;
    } catch (e) {
      cloudStatus = `error: ${e.message}`;
    }
  }

  return {
    success: true,
    projectId: resolvedId,
    projectName: record.name,
    cloudSync: cloudStatus,
    critique: {
      effectiveContext: record.critiqueContext || record.brandContext || null,
      compiledContext: record.critiqueContext || null,
      policy: record.critiquePolicy || null,
      signals: record.critiqueSignals || null,
      compiledAt: record.critiqueContextCompiledAt || null,
      pinsAtCompile: Number(record.critiqueContextPinsAtCompile || 0),
      staleness: stalenessLabel(record.critiqueContext, record.critiqueContextCompiledAt),
    },
    message: critiqueContext !== undefined
      ? `Critique context recompiled for "${record.name}". The AI critic will use this brief on the next /critique run.`
      : `Critique inputs updated for "${record.name}". Run /refresh-brand to recompile the brief.`,
  };
}

// ─── Auto-Discovery ──────────────────────────────────────────────────────────
// Scans the project directory for package.json, .env, vercel config, framework
// configs, etc. to infer the project name, local dev URL, and production URL.
// Returns { name, urls } ready for toolConfigureProject.

export async function discoverProjectConfig(projectDir) {
  let name = null;
  const urls = new Set();

  // 1. package.json — project name + dev script port
  const pkgPath = join(projectDir, 'package.json');
  try {
    const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
    name = pkg.name || null;
    if (pkg.homepage) urls.add(pkg.homepage.replace(/\/+$/, ''));

    // Sniff port from dev script: --port 3001, -p 8080, PORT=4000
    const devScript = pkg.scripts?.dev || pkg.scripts?.start || '';
    const portMatch = devScript.match(/(?:--port|-p)\s+(\d+)/) ||
                      devScript.match(/PORT=(\d+)/);
    if (portMatch) {
      urls.add(`http://localhost:${portMatch[1]}`);
    }
  } catch { /* no package.json */ }

  // 2. .env / .env.local — look for PORT, URL-like vars
  for (const envFile of ['.env', '.env.local', '.env.development', '.env.development.local']) {
    try {
      const content = await readFile(join(projectDir, envFile), 'utf8');
      // PORT=3001
      const portMatch = content.match(/^PORT=(\d+)/m);
      if (portMatch) urls.add(`http://localhost:${portMatch[1]}`);
      // Common URL vars
      for (const pattern of [
        /^(?:NEXT_PUBLIC_|VITE_|REACT_APP_)?(?:APP_URL|SITE_URL|BASE_URL|PUBLIC_URL|VERCEL_URL|DEPLOY_URL)=(.+)$/gm
      ]) {
        let m;
        while ((m = pattern.exec(content)) !== null) {
          let val = m[1].trim().replace(/['"]/g, '');
          if (val && !val.includes('${') && !val.startsWith('#')) {
            if (!val.startsWith('http')) val = `https://${val}`;
            urls.add(val.replace(/\/+$/, ''));
          }
        }
      }
    } catch { /* file doesn't exist — skip */ }
  }

  // 3. .vercel/project.json — Vercel project name → <name>.vercel.app
  try {
    const vercelProj = JSON.parse(await readFile(join(projectDir, '.vercel', 'project.json'), 'utf8'));
    if (vercelProj.projectId) {
      // We can't derive the URL from projectId alone, but the project name is often the subdomain
      // Check vercel.json for alias
    }
  } catch { /* no vercel config */ }

  // 4. vercel.json — alias / custom domains
  try {
    const vercelConf = JSON.parse(await readFile(join(projectDir, 'vercel.json'), 'utf8'));
    for (const alias of (vercelConf.alias || [])) {
      urls.add(alias.startsWith('http') ? alias : `https://${alias}`);
    }
  } catch { /* no vercel.json */ }

  // 5. Framework defaults — if no port was found, add common defaults
  if (![...urls].some(u => u.includes('localhost'))) {
    // Check which framework is in use
    try {
      const pkg = JSON.parse(await readFile(pkgPath, 'utf8'));
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if (deps['next'])    urls.add('http://localhost:3000');
      else if (deps['nuxt'] || deps['nuxt3']) urls.add('http://localhost:3000');
      else if (deps['vite'] || deps['@vitejs/plugin-react']) urls.add('http://localhost:5173');
      else if (deps['@angular/core']) urls.add('http://localhost:4200');
      else if (deps['gatsby']) urls.add('http://localhost:8000');
      else if (deps['svelte'] || deps['@sveltejs/kit']) urls.add('http://localhost:5173');
      else if (deps['react-scripts']) urls.add('http://localhost:3000');
      else urls.add('http://localhost:3000'); // safe default
    } catch {
      urls.add('http://localhost:3000'); // fallback
    }
  }

  // Clean up name: strip @scope/, convert hyphens to title case
  if (name) {
    name = name.replace(/^@[^/]+\//, ''); // strip npm scope
  }

  return {
    name: name || projectDir.split('/').pop() || 'Untitled Project',
    urls: [...urls].filter(Boolean),
  };
}

// ─── Live PINS.md Generator ──────────────────────────────────────────────────
/**
 * Analyze a CSS selector to detect if the pin's target element is inside a
 * dynamic container (modal, sidebar, dropdown, etc.) and return a short
 * human-readable description. Returns null for static elements.
 */
function describeDynamicContext(selector) {
  if (!selector) return null;
  const s = selector.toLowerCase();

  // Common dynamic container patterns in selectors
  const patterns = [
    { test: /\[role=["']?dialog["']?\]|\[aria-modal/, label: 'pin is inside a modal dialog (may be hidden when closed)' },
    { test: /dialog\b/, label: 'pin is inside a <dialog> element (may be hidden when closed)' },
    { test: /\.modal|\.lightbox/, label: 'pin is inside a modal (may be hidden when closed)' },
    { test: /\.sidebar|\.side-bar|\.drawer|\.offcanvas|\.off-canvas/, label: 'pin is inside a sidebar/drawer (may be hidden when collapsed)' },
    { test: /\.dropdown|\.drop-down|\.popover|\.pop-over/, label: 'pin is inside a dropdown/popover (may be hidden when closed)' },
    { test: /\[role=["']?tabpanel["']?\]/, label: 'pin is inside a tab panel (only visible when that tab is active)' },
    { test: /\.accordion/, label: 'pin is inside an accordion section (may be collapsed)' },
    { test: /\.overlay/, label: 'pin is inside an overlay (may be hidden)' },
    { test: /\.tooltip/, label: 'pin is inside a tooltip (only visible on hover)' },
    { test: /\.toast|\.snackbar/, label: 'pin is on a toast/notification (appears briefly)' },
  ];

  for (const { test, label } of patterns) {
    if (test.test(s)) return label;
  }
  return null;
}

/**
 * Build a deep link URL for a pin that opens the page and auto-focuses it.
 */
function buildDeepLink(pageUrl, pinId) {
  try {
    const u = new URL(pageUrl);
    u.searchParams.set('pincushion_pin', pinId);
    return u.toString();
  } catch {
    return pageUrl.includes('?')
      ? `${pageUrl}&pincushion_pin=${pinId}`
      : `${pageUrl}?pincushion_pin=${pinId}`;
  }
}

/**
 * Collect ALL pins (open + resolved) from annotation data, sorted by date.
 */
function collectAllPins(allData) {
  const open = [];
  const resolved = [];

  for (const [url, data] of Object.entries(allData)) {
    for (const ann of (data.annotations || [])) {
      const userComments = (ann.thread || []).filter(
        m => m.type !== 'code-note' && m.type !== 'decline' && m.author !== 'AI Agent'
      );
      if (!userComments.length && !ann.thread?.length) continue;

      const pin = {
        id: ann.id,
        pageUrl: url,
        pageTitle: data.pageTitle || url,
        status: ann.status || 'open',
        action: ann.action || null,
        element: ann.element || {},
        thread: ann.thread || [],
        createdAt: ann.createdAt,
        updatedAt: ann.updatedAt,
        resolvedAt: ann.resolvedAt,
        approvedAt: ann.approvedAt,
        approvedBy: ann.approvedBy,
        implementedAt: ann.implementedAt,
        implementer: ann.implementer,
        projectId: ann.projectId,
      };

      if (ann.status === 'resolved') {
        resolved.push(pin);
      } else {
        open.push(pin);
      }
    }
  }

  open.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
  resolved.sort((a, b) => new Date(b.resolvedAt || b.updatedAt || 0) - new Date(a.resolvedAt || a.updatedAt || 0));

  return { open, resolved };
}

// Generates a structured markdown file that stays in sync with open feedback.
// Designed to be opened in any IDE alongside code — the developer's feedback
// dashboard. Each pin is a section with full context + agent-ready instructions.
// Includes checkboxes for selecting pins and a resolved section at the bottom.

export async function generatePinsMarkdown(config, fetchRemote = null) {
  const allData = await readAllAnnotations(config, fetchRemote);
  const { open: pins, resolved: resolvedPins } = collectAllPins(allData);

  // Group open pins by page
  const byPage = {};
  for (const pin of pins) {
    const key = pin.pageUrl;
    if (!byPage[key]) byPage[key] = { title: pin.pageTitle, pins: [] };
    byPage[key].pins.push(pin);
  }

  // Build markdown
  const lines = [];
  lines.push('# Pincushion — Feedback Dashboard');
  lines.push('');
  const approvedCount = pins.filter(p => isReadyStatus(p.status)).length;
  const openCount = pins.filter(p => !isReadyStatus(p.status)).length;
  lines.push(`> ${openCount} open · ${approvedCount} ready · ${resolvedPins.length} resolved · Updated ${new Date().toLocaleString()}`);
  lines.push('>');
  lines.push('> **How to use:** Check the boxes next to pins you want to implement, then tell your agent:');
  lines.push('> `implement the checked pins` or `resolve <pin-id>`');
  lines.push('>');
  lines.push('> [Open Dashboard](./dashboard.html) for an interactive view with filters and selection.');
  lines.push('');

  if (pins.length === 0 && resolvedPins.length === 0) {
    lines.push('No feedback pins yet. Drop a pin using the Pincushion Chrome extension on any registered URL.');
    return lines.join('\n');
  }

  // ── Open Pins ──────────────────────────────────────────────────────────────

  if (pins.length > 0) {
    lines.push('## Open Pins');
    lines.push('');

    for (const [pageUrl, group] of Object.entries(byPage)) {
      lines.push(`### ${group.title}`);
      lines.push(`<${pageUrl}>`);
      lines.push('');

      for (const pin of group.pins) {
        const userComment = firstUserThreadMessage(pin.thread || []);
        const parsedComment = parseRichComment(userComment?.body || '');
        const commentBody = parsedComment.plainText || '(no comment)';
        const author = userComment?.author || 'Unknown';
        const age = pin.createdAt ? timeAgo(new Date(pin.createdAt)) : '';
        const deepLink = buildDeepLink(pin.pageUrl, pin.id);
        const statusTag = isReadyStatus(pin.status) ? ' ✅ **ready**'
          : pin.action === 'implemented' ? ' *(implemented — awaiting review)*'
          : pin.action === 'implementing' ? ' *(in progress)*'
          : '';

        // Checkbox + pin header
        lines.push(`- [ ] **[\`${pin.id}\`](${deepLink})** — ${commentBody.split('\n')[0].slice(0, 80)}${statusTag}`);
        lines.push(`  *by ${author} · ${age}${pin.approvedBy ? ` · approved by ${pin.approvedBy}` : ''}*`);
        lines.push('');

        // Element context + dynamic visibility hint
        if (pin.element.selector || pin.element.tagName) {
          const selector = pin.element.selector || pin.element.tagName;
          const dynamicHint = describeDynamicContext(selector);
          lines.push('  **Target element:**');
          lines.push('  ```css');
          lines.push(`  ${selector}`);
          lines.push('  ```');
          if (dynamicHint) {
            lines.push(`  ⚡ *Dynamic element — ${dynamicHint}*`);
          }
          if (pin.element.textContent) {
            lines.push(`  Content: "${pin.element.textContent.slice(0, 120)}"`);
          }
          lines.push('');
        }

        // Full thread
        if (pin.thread.length > 0) {
          lines.push('  **Thread:**');
          for (const msg of pin.thread) {
            const enriched = serializeThreadMessage(msg);
            const who = msg.author || 'Unknown';
            const when = msg.timestamp ? new Date(msg.timestamp).toLocaleString() : '';
            const prefix = msg.type === 'code-note' ? '🤖' : msg.type === 'decline' ? '❌' : '💬';
            lines.push(`  - ${prefix} **${who}** ${when ? `(${when})` : ''}: ${(enriched.plainText || '').split('\n')[0] || ''}`);
            if (enriched.links.length > 0) {
              lines.push(`    Links: ${enriched.links.map(link => link.url).join(', ')}`);
            }
            if (enriched.images.length > 0) {
              lines.push(`    Images: ${enriched.images.map(image => image.url).join(', ')}`);
            }
          }
          lines.push('');
        }

        // Agent action block
        lines.push('  <details><summary>Agent instructions</summary>');
        lines.push('');
        lines.push('  ```');
        lines.push(`  claim_pin({ annotationId: "${pin.id}" })`);
        lines.push(`  // ... implement the change ...`);
        lines.push(`  fix_and_resolve({ annotationId: "${pin.id}", fixDescription: "..." })`);
        lines.push('  ```');
        lines.push('  </details>');
        lines.push('');
      }
    }
  }

  // ── Resolved Pins ──────────────────────────────────────────────────────────

  if (resolvedPins.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push(`## Resolved (${resolvedPins.length})`);
    lines.push('');

    for (const pin of resolvedPins.slice(0, 50)) { // cap at 50 most recent
      const userComment = firstUserThreadMessage(pin.thread || []);
      const commentBody = parseRichComment(userComment?.body || '').plainText || '(no comment)';
      const author = userComment?.author || 'Unknown';
      const resolvedDate = pin.resolvedAt ? new Date(pin.resolvedAt).toLocaleDateString() : '';
      const deepLink = buildDeepLink(pin.pageUrl, pin.id);

      // Find the resolution message (last code-note or resolution type)
      const resolution = [...(pin.thread || [])].reverse().find(
        m => m.type === 'code-note' || m.type === 'resolution'
      );
      const resolutionText = resolution?.body
        ? ` → ${parseRichComment(resolution.body).plainText.split('\n')[0].slice(0, 80)}`
        : '';

      lines.push(`- [x] ~~[\`${pin.id}\`](${deepLink})~~ — ${commentBody.split('\n')[0].slice(0, 60)}${resolutionText}`);
      lines.push(`  *by ${author} · resolved ${resolvedDate}*`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Structured JSON Export ──────────────────────────────────────────────────
// Generates a machine-readable JSON file with all pin data for the dashboard.

export async function generatePinsJson(config, fetchRemote = null) {
  const allData = await readAllAnnotations(config, fetchRemote);
  const { open, resolved } = collectAllPins(allData);

  // Read selections file if it exists
  let selections = [];
  try {
    const selectionsPath = join(config.feedbackDir, 'selections.json');
    if (existsSync(selectionsPath)) {
      const raw = JSON.parse(await readFile(selectionsPath, 'utf-8'));
      selections = raw.selectedPins || [];
    }
  } catch { /* no selections */ }

  const mapPin = (pin) => {
    const firstUserMessage = firstUserThreadMessage(pin.thread || []);

    return {
      id: pin.id,
      pageUrl: pin.pageUrl,
      pageTitle: pin.pageTitle,
      status: pin.status,
      action: pin.action,
      selected: selections.includes(pin.id),
      element: {
        selector: pin.element?.selector || null,
        tagName: pin.element?.tagName || null,
        textContent: pin.element?.textContent?.slice(0, 200) || null,
        lwcComponent: pin.element?.lwcComponent || null,
      },
      dynamicContext: describeDynamicContext(pin.element?.selector),
      deepLink: buildDeepLink(pin.pageUrl, pin.id),
      thread: (pin.thread || []).map((message) => {
        const enriched = serializeThreadMessage(message);
        return {
          ...enriched,
          renderedHtml: renderRichCommentHtml(enriched.body),
        };
      }),
      author: firstUserMessage?.author || 'Unknown',
      comment: summarizeRichComment(firstUserMessage?.body || '', 200),
      createdAt: pin.createdAt,
      resolvedAt: pin.resolvedAt,
      approvedAt: pin.approvedAt,
      approvedBy: pin.approvedBy,
      implementedAt: pin.implementedAt,
      implementer: pin.implementer,
    };
  };

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalOpen: open.filter(p => !isReadyStatus(p.status)).length,
      totalApproved: open.filter(p => isReadyStatus(p.status)).length,
      totalResolved: resolved.length,
      totalSelected: selections.length,
    },
    open: open.map(mapPin),
    resolved: resolved.slice(0, 50).map(mapPin),
    selections,
  };
}

// Write pins.json to disk in the feedback directory
export async function writePinsJson(config, fetchRemote = null) {
  const data = await generatePinsJson(config, fetchRemote);
  const jsonPath = join(config.feedbackDir, 'pins.json');
  if (!existsSync(config.feedbackDir)) mkdirSync(config.feedbackDir, { recursive: true });
  await writeFile(jsonPath, JSON.stringify(data, null, 2));
  return jsonPath;
}

// ─── Interactive HTML Dashboard ──────────────────────────────────────────────
// Generates a self-contained HTML file with embedded pin data. Opens in any
// browser, no server needed for viewing. Selection posts back to the local
// bridge server if running.

export async function generateDashboardHtml(config, fetchRemote = null, bridgePort = 3456) {
  const pinsData = await generatePinsJson(config, fetchRemote);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Pincushion — Feedback Dashboard</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3;
    --text-muted: #8b949e; --accent: #58a6ff; --green: #3fb950; --yellow: #d29922;
    --red: #f85149; --purple: #bc8cff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  .container { max-width: 1100px; margin: 0 auto; padding: 24px; }
  header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; flex-wrap: wrap; gap: 12px; }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand-logo { width: 32px; height: 32px; background: var(--accent); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-size: 18px; flex-shrink: 0; }
  .brand-name { font-size: 20px; font-weight: 700; letter-spacing: -0.3px; }
  .brand-name span { color: var(--accent); }
  .brand-tagline { font-size: 12px; color: var(--text-muted); margin-top: 1px; }
  .stats { display: flex; gap: 16px; flex-wrap: wrap; }
  .stat { background: var(--surface); border: 1px solid var(--border); border-radius: 8px; padding: 12px 18px; text-align: center; min-width: 90px; }
  .stat .num { font-size: 24px; font-weight: 700; }
  .stat .label { font-size: 11px; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.5px; }
  .stat.open .num { color: var(--yellow); }
  .stat.approved .num { color: var(--green); }
  .stat.resolved .num { color: var(--text-muted); }
  .stat.selected .num { color: var(--accent); }

  .toolbar { display: flex; gap: 8px; margin-bottom: 20px; flex-wrap: wrap; align-items: center; }
  .toolbar select, .toolbar input { background: var(--surface); border: 1px solid var(--border); color: var(--text); padding: 6px 10px; border-radius: 6px; font-size: 13px; }
  .toolbar input { flex: 1; min-width: 200px; }
  .btn { background: var(--accent); color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 13px; font-weight: 500; transition: opacity 0.15s; }
  .btn:hover { opacity: 0.85; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }
  .btn.secondary { background: var(--surface); border: 1px solid var(--border); color: var(--text); }
  .btn.green { background: var(--green); }

  .tabs { display: flex; gap: 0; margin-bottom: 20px; border-bottom: 1px solid var(--border); }
  .tab { padding: 8px 18px; cursor: pointer; color: var(--text-muted); border-bottom: 2px solid transparent; font-size: 14px; }
  .tab.active { color: var(--text); border-bottom-color: var(--accent); }
  .tab .count { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 1px 7px; font-size: 11px; margin-left: 6px; }

  .pin-card { background: var(--surface); border: 1px solid var(--border); border-radius: 10px; padding: 16px; margin-bottom: 12px; transition: border-color 0.15s; }
  .pin-card:hover { border-color: var(--accent); }
  .pin-card.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
  .pin-card.resolved-card { opacity: 0.7; }

  .pin-header { display: flex; align-items: flex-start; gap: 10px; }
  .pin-check { margin-top: 3px; width: 18px; height: 18px; accent-color: var(--accent); cursor: pointer; flex-shrink: 0; }
  .pin-body { flex: 1; min-width: 0; }
  .pin-id { font-family: 'SF Mono', 'Fira Code', monospace; font-size: 12px; color: var(--accent); cursor: pointer; text-decoration: none; }
  .pin-id:hover { text-decoration: underline; }
  .pin-comment { font-size: 15px; font-weight: 500; margin: 4px 0; }
  .pin-meta { font-size: 12px; color: var(--text-muted); display: flex; gap: 12px; flex-wrap: wrap; align-items: center; }
  .pin-meta .author { font-weight: 500; color: var(--text); }
  .badge { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 500; }
  .badge.approved-badge { background: rgba(63,185,80,0.15); color: var(--green); }
  .badge.implemented { background: rgba(188,140,255,0.15); color: var(--purple); }
  .badge.resolved-badge { background: rgba(63,185,80,0.15); color: var(--green); }

  .approve-btn { background: none; border: 1px solid var(--green); color: var(--green); padding: 2px 10px; border-radius: 10px; font-size: 11px; cursor: pointer; transition: all 0.15s; margin-left: 6px; }
  .approve-btn:hover { background: var(--green); color: #fff; }

  .live-indicator { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--green); }
  .live-dot { width: 6px; height: 6px; background: var(--green); border-radius: 50%; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }

  .pin-element { margin-top: 10px; background: var(--bg); border-radius: 6px; padding: 10px 12px; font-size: 12px; }
  .pin-element code { font-family: 'SF Mono', 'Fira Code', monospace; color: var(--accent); word-break: break-all; }
  .pin-element .content { color: var(--text-muted); margin-top: 4px; }
  .pin-element .dynamic { color: var(--yellow); margin-top: 4px; font-style: italic; }

  .thread { margin-top: 10px; border-top: 1px solid var(--border); padding-top: 8px; }
  .thread-msg { font-size: 13px; margin-bottom: 6px; padding-left: 12px; border-left: 2px solid var(--border); }
  .thread-msg .msg-author { font-weight: 600; }
  .thread-msg .msg-time { color: var(--text-muted); font-size: 11px; margin-left: 6px; }
  .thread-msg .thread-body { margin-top: 4px; color: var(--text); }
  .thread-msg.code-note { border-left-color: var(--purple); }
  .thread-msg.resolution { border-left-color: var(--green); }
  .rich-link { color: var(--accent); text-decoration: underline; }
  .rich-image-wrap { display: block; margin-top: 8px; }
  .rich-image-link { display: inline-block; max-width: 100%; }
  .rich-image { display: block; max-width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--border); }
  .rich-image-alt { display: block; margin-top: 4px; color: var(--text-muted); font-size: 11px; }

  .actions-bar { position: sticky; bottom: 0; background: var(--surface); border-top: 1px solid var(--border); padding: 12px 24px; display: flex; align-items: center; gap: 12px; justify-content: space-between; z-index: 10; }
  .actions-bar .left { display: flex; gap: 8px; align-items: center; }
  .actions-bar .right { display: flex; gap: 8px; }
  .actions-bar .count-label { font-size: 13px; color: var(--text-muted); }

  .toast { position: fixed; bottom: 80px; left: 50%; transform: translateX(-50%); background: var(--green); color: #fff; padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 500; display: none; z-index: 100; animation: fadeIn 0.2s; }
  @keyframes fadeIn { from { opacity: 0; transform: translateX(-50%) translateY(10px); } to { opacity: 1; transform: translateX(-50%) translateY(0); } }

  .empty { text-align: center; padding: 60px 20px; color: var(--text-muted); }
  .empty h3 { font-size: 18px; margin-bottom: 8px; color: var(--text); }
</style>
</head>
<body>
<div class="container">
  <header>
    <div class="brand">
      <div class="brand-logo">📌</div>
      <div>
        <div class="brand-name">Pin<span>cushion</span></div>
        <div class="brand-tagline">Feedback → Code</div>
      </div>
    </div>
    <div class="stats">
      <div class="stat open"><div class="num" id="statOpen">0</div><div class="label">Open</div></div>
      <div class="stat approved"><div class="num" id="statApproved">0</div><div class="label">Approved</div></div>
      <div class="stat selected"><div class="num" id="statSelected">0</div><div class="label">Selected</div></div>
      <div class="stat resolved"><div class="num" id="statResolved">0</div><div class="label">Resolved</div></div>
      <span class="live-indicator" id="liveIndicator" style="display:none;"><span class="live-dot"></span> Live</span>
    </div>
  </header>

  <div class="toolbar">
    <select id="filterPage"><option value="">All Pages</option></select>
    <select id="filterAuthor"><option value="">All Authors</option></select>
    <input type="text" id="searchBox" placeholder="Search pins...">
  </div>

  <div class="tabs">
    <div class="tab active" data-tab="open">Open <span class="count" id="tabOpenCount">0</span></div>
    <div class="tab" data-tab="approved">Approved <span class="count" id="tabApprovedCount">0</span></div>
    <div class="tab" data-tab="resolved">Resolved <span class="count" id="tabResolvedCount">0</span></div>
  </div>

  <div id="pinList"></div>
</div>

<div class="actions-bar" id="actionsBar" style="display:none;">
  <div class="left">
    <input type="checkbox" id="selectAll" style="width:18px;height:18px;accent-color:var(--accent);cursor:pointer;">
    <span class="count-label"><strong id="selectedCount">0</strong> pin(s) selected</span>
  </div>
  <div class="right">
    <button class="btn secondary" onclick="clearSelections()">Clear</button>
    <button class="btn green" onclick="approveSelected()">Approve Selected</button>
    <button class="btn" onclick="copyCommand()">Copy Agent Command</button>
    <button class="btn green" onclick="sendToAgent()">Send to Agent</button>
  </div>
</div>

<div class="toast" id="toast"></div>

<script>
const BRIDGE_PORT = ${bridgePort};
const DATA = ${JSON.stringify(pinsData)};

let activeTab = 'open';
let selected = new Set(DATA.selections || []);

// ── Init ──
function init() {
  // Populate page filter
  const pages = [...new Set(DATA.open.map(p => p.pageTitle))];
  const pageSel = document.getElementById('filterPage');
  pages.forEach(p => { const o = document.createElement('option'); o.value = p; o.textContent = p; pageSel.appendChild(o); });

  // Populate author filter
  const authors = [...new Set(DATA.open.map(p => p.author).filter(Boolean))];
  const authSel = document.getElementById('filterAuthor');
  authors.forEach(a => { const o = document.createElement('option'); o.value = a; o.textContent = a; authSel.appendChild(o); });

  // Stats
  document.getElementById('statOpen').textContent = DATA.summary.totalOpen;
  document.getElementById('statApproved').textContent = DATA.summary.totalApproved;
  document.getElementById('statResolved').textContent = DATA.summary.totalResolved;

  // Event listeners
  document.getElementById('filterPage').addEventListener('change', render);
  document.getElementById('filterAuthor').addEventListener('change', render);
  document.getElementById('searchBox').addEventListener('input', render);
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    activeTab = t.dataset.tab;
    render();
  }));
  document.getElementById('selectAll').addEventListener('change', (e) => {
    const visible = getVisiblePins();
    if (e.target.checked) visible.forEach(p => selected.add(p.id));
    else visible.forEach(p => selected.delete(p.id));
    render();
  });

  render();
}

function isReady(s) { return s === 'ready' || s === 'approved'; }
function getVisiblePins() {
  let pins;
  // 'approved' tab really means "implementation-ready" — accept the modern
  // 'ready' status too. Pre-rename-migration files used 'approved'; post-
  // migration uses 'ready'. Bot pins land as 'ready' by design.
  if (activeTab === 'approved') pins = DATA.open.filter(p => isReady(p.status));
  else if (activeTab === 'resolved') pins = DATA.resolved;
  else pins = DATA.open.filter(p => !isReady(p.status));
  const page = document.getElementById('filterPage').value;
  const author = document.getElementById('filterAuthor').value;
  const search = document.getElementById('searchBox').value.toLowerCase();

  return pins.filter(p => {
    if (page && p.pageTitle !== page) return false;
    if (author && p.author !== author) return false;
    if (search && !(p.comment + p.id + (p.element.selector || '') + (p.element.textContent || '')).toLowerCase().includes(search)) return false;
    return true;
  });
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const s = Math.floor((Date.now() - new Date(dateStr).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago';
  return Math.floor(s / 86400) + 'd ago';
}

function render() {
  const visible = getVisiblePins();
  const list = document.getElementById('pinList');

  document.getElementById('tabOpenCount').textContent = DATA.open.filter(p => !isReady(p.status)).length;
  document.getElementById('tabApprovedCount').textContent = DATA.open.filter(p => isReady(p.status)).length;
  document.getElementById('tabResolvedCount').textContent = DATA.resolved.length;
  document.getElementById('statSelected').textContent = selected.size;

  // Actions bar
  const bar = document.getElementById('actionsBar');
  if (selected.size > 0) {
    bar.style.display = 'flex';
    document.getElementById('selectedCount').textContent = selected.size;
  } else {
    bar.style.display = 'none';
  }

  if (visible.length === 0) {
    list.innerHTML = '<div class="empty"><h3>No pins here</h3><p>' +
      (activeTab === 'open' ? 'Drop a pin using the Pincushion Chrome extension.' : 'No resolved pins yet.') + '</p></div>';
    return;
  }

  list.innerHTML = visible.map(pin => {
    const isSelected = selected.has(pin.id);
    const isResolved = pin.status === 'resolved';
    const isApproved = isReady(pin.status);
    const actionBadge = isApproved ? '<span class="badge approved-badge">Approved</span>'
      : pin.action === 'implemented' ? '<span class="badge implemented">Implemented</span>'
      : isResolved ? '<span class="badge resolved-badge">Resolved</span>' : '';
    const approveBtn = (!isResolved && !isApproved) ? \`<button class="approve-btn" onclick="approvePin('\${pin.id}')">Approve</button>\` : '';

    return \`<div class="pin-card \${isSelected ? 'selected' : ''} \${isResolved ? 'resolved-card' : ''}" id="card-\${pin.id}">
      <div class="pin-header">
        \${!isResolved ? \`<input type="checkbox" class="pin-check" data-id="\${pin.id}" \${isSelected ? 'checked' : ''} onchange="togglePin('\${pin.id}')">\` : ''}
        <div class="pin-body">
          <a class="pin-id" href="\${pin.deepLink}" target="_blank">\${pin.id}</a>
          \${actionBadge}
          \${approveBtn}
          <div class="pin-comment">\${escHtml((pin.comment || '').split('\\n')[0].slice(0, 120) || '(no comment)')}</div>
          <div class="pin-meta">
            <span>by <span class="author">\${escHtml(pin.author)}</span></span>
            <span>\${timeAgo(pin.createdAt)}</span>
            <span>\${pin.pageTitle}</span>
            \${pin.thread.length > 1 ? \`<span>\${pin.thread.length} messages</span>\` : ''}
          </div>
        </div>
      </div>
      \${pin.element.selector ? \`<div class="pin-element">
        <code>\${escHtml(pin.element.selector)}</code>
        \${pin.element.textContent ? \`<div class="content">Content: "\${escHtml(pin.element.textContent.slice(0, 120))}"</div>\` : ''}
        \${pin.dynamicContext ? \`<div class="dynamic">⚡ \${escHtml(pin.dynamicContext)}</div>\` : ''}
      </div>\` : ''}
      \${pin.thread.length > 0 ? \`<div class="thread">
        \${pin.thread.map(m => \`<div class="thread-msg \${m.type || ''}">
          <span class="msg-author">\${escHtml(m.author)}</span><span class="msg-time">\${m.timestamp ? new Date(m.timestamp).toLocaleString() : ''}</span>
          <div class="thread-body">\${m.renderedHtml || escHtml(m.plainText || m.body || '')}</div>
        </div>\`).join('')}
      </div>\` : ''}
    </div>\`;
  }).join('');
}

function escHtml(s) { return (s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

function togglePin(id) {
  if (selected.has(id)) selected.delete(id);
  else selected.add(id);
  render();
}

function clearSelections() { selected.clear(); render(); }

async function approvePin(id) {
  try {
    const res = await fetch(\`http://localhost:\${BRIDGE_PORT}/approve-pin\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ annotationId: id })
    });
    if (res.ok) {
      // Update local data optimistically
      const pin = DATA.open.find(p => p.id === id);
      if (pin) {
        pin.status = 'approved';
        pin.approvedAt = new Date().toISOString();
      }
      render();
      showToast('Pin approved for implementation');
    } else {
      showToast('Failed to approve — bridge returned error');
    }
  } catch {
    showToast('Bridge not running — approve via your agent: approve_pin');
  }
}

async function approveSelected() {
  const ids = [...selected].filter(id => {
    const pin = DATA.open.find(p => p.id === id);
    return pin && pin.status !== 'approved';
  });
  if (ids.length === 0) { showToast('No unapproved pins selected'); return; }

  for (const id of ids) {
    await approvePin(id);
  }
  showToast(\`\${ids.length} pin(s) approved\`);
}

function copyCommand() {
  const ids = [...selected];
  const cmd = ids.length === 1
    ? \`Implement pin \${ids[0]}: read its thread in .feedback/PINS.md, make the change, then call fix_and_resolve.\`
    : \`Implement these \${ids.length} pins in order: \${ids.join(', ')}. For each, read its context in .feedback/PINS.md, make the change, then call fix_and_resolve.\`;
  navigator.clipboard.writeText(cmd).then(() => showToast('Copied to clipboard!'));
}

async function sendToAgent() {
  const ids = [...selected];
  try {
    const res = await fetch(\`http://localhost:\${BRIDGE_PORT}/select-pins\`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ selectedPins: ids, timestamp: new Date().toISOString() })
    });
    if (res.ok) {
      showToast(\`\${ids.length} pin(s) queued for agent — check your IDE\`);
    } else {
      showToast('Saved locally — paste the agent command into your IDE');
      // Fallback: copy to clipboard
      copyCommand();
    }
  } catch {
    showToast('Bridge not running — command copied to clipboard');
    copyCommand();
  }
}

function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.style.display = 'block';
  setTimeout(() => { t.style.display = 'none'; }, 3000);
}

init();

// ── Supabase Realtime live-refresh ──
// For Pro/Team: auto-refresh dashboard when annotations change in real time.
// Falls back to periodic polling (30s) on free tier.
(function() {
  const REFRESH_INTERVAL_FREE = 30000;
  let realtimeActive = false;

  // Attempt Realtime connection via bridge server
  async function tryRealtimeRefresh() {
    try {
      const resp = await fetch('http://127.0.0.1:' + BRIDGE_PORT + '/health');
      if (!resp.ok) return false;
      // Bridge is alive — use it for change detection
      // We poll bridge /status quickly since Realtime handles server-side notifications
      return true;
    } catch { return false; }
  }

  // Smart refresh: reload page data without full page reload
  async function softRefresh() {
    try {
      const resp = await fetch('http://127.0.0.1:' + BRIDGE_PORT + '/call-tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ toolName: 'get_feedback_summary', args: {} })
      });
      if (resp.ok) {
        // Full reload to pick up new data — simple and reliable
        location.reload();
      }
    } catch { /* bridge offline — skip refresh */ }
  }

  // Start polling as baseline (works on all tiers)
  setInterval(softRefresh, REFRESH_INTERVAL_FREE);

  // Show live indicator if bridge is reachable
  tryRealtimeRefresh().then(ok => {
    if (ok) {
      const liveEl = document.querySelector('.live-indicator');
      if (liveEl) liveEl.style.display = 'flex';
    }
  });
})();
</script>
</body>
</html>`;
}

// Write dashboard.html to disk
export async function writeDashboardHtml(config, fetchRemote = null, bridgePort = 3456) {
  const html = await generateDashboardHtml(config, fetchRemote, bridgePort);
  const htmlPath = join(config.feedbackDir, 'dashboard.html');
  if (!existsSync(config.feedbackDir)) mkdirSync(config.feedbackDir, { recursive: true });
  await writeFile(htmlPath, html);
  return htmlPath;
}

// Read the current selections file
export async function readSelections(config) {
  try {
    const selectionsPath = join(config.feedbackDir, 'selections.json');
    if (existsSync(selectionsPath)) {
      return JSON.parse(await readFile(selectionsPath, 'utf-8'));
    }
  } catch { /* no selections */ }
  return { selectedPins: [], timestamp: null };
}

// Write selections file
export async function writeSelections(config, data) {
  const selectionsPath = join(config.feedbackDir, 'selections.json');
  if (!existsSync(config.feedbackDir)) mkdirSync(config.feedbackDir, { recursive: true });
  await writeFile(selectionsPath, JSON.stringify(data, null, 2));
  return selectionsPath;
}

function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Write PINS.md to disk in the feedback directory
export async function writePinsFile(config, fetchRemote = null) {
  const md = await generatePinsMarkdown(config, fetchRemote);
  const pinsPath = join(config.feedbackDir, 'PINS.md');
  if (!existsSync(config.feedbackDir)) mkdirSync(config.feedbackDir, { recursive: true });
  await writeFile(pinsPath, md);
  return pinsPath;
}
