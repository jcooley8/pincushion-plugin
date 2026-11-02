// lib/git.js — Git helpers for branch-per-page agentic workflow
// Provides utilities for creating and managing pincushion/* branches.
// The MCP server doesn't run these directly — it provides the data
// and instructions, and the IDE agent executes the git commands.
// These helpers are available for agents that have shell access.

import { execFile } from 'child_process';
import { createHash } from 'crypto';
import { constants } from 'fs';
import { lstat, open, realpath } from 'fs/promises';
import { isAbsolute, relative, resolve, sep } from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Run a git command in the project directory.
 * Returns { stdout, stderr } or throws on non-zero exit.
 */
async function git(projectDir, ...args) {
  try {
    const { stdout, stderr } = await execFileAsync('git', args, {
      cwd: projectDir,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: stdout.trim(), stderr: stderr.trim() };
  } catch (err) {
    throw new Error(`git ${args.join(' ')} failed: ${err.stderr || err.message}`);
  }
}

/**
 * Convert a page title + URL to a branch-safe slug.
 * Prefers the URL path so each page gets its own branch.
 * Falls back to title for the root/home page.
 *
 * "Superbill Pro", "/settings"         → "superbill-pro-settings"
 * "Superbill Pro", "/app/dashboard"    → "superbill-pro-app-dashboard"
 * "Superbill Pro", "/"                 → "superbill-pro"
 * "http://localhost:3000/app/billing"  → "app-billing"
 */
export function pageSlug(pageTitle, pageUrl) {
  // Extract a site-level prefix from the title (part before —, |, :, etc.)
  let sitePrefix = '';
  if (pageTitle && !/^https?:\/\//.test(pageTitle)) {
    sitePrefix = pageTitle
      .split(/[—|:]/)[0]
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '');
  }

  // Extract the URL path segment
  let pathSlug = '';
  try {
    const path = new URL(pageUrl).pathname.replace(/^\/|\/$/g, '');
    if (path) {
      pathSlug = path
        .replace(/\//g, '-')
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '')
        .replace(/^-|-$/g, '');
    }
  } catch { /* no valid URL */ }

  // Combine: "superbill-pro-settings" or just "superbill-pro" for root
  if (sitePrefix && pathSlug) {
    return `${sitePrefix}-${pathSlug}`.slice(0, 50);
  }
  if (pathSlug) return pathSlug.slice(0, 50);
  if (sitePrefix) return sitePrefix.slice(0, 50);
  return 'feedback';
}

/**
 * Get the full branch name for a page.
 * @param {string} pageTitle - Page title from annotation
 * @param {string} pageUrl - Page URL fallback
 * @returns {string} Branch name like "pincushion/settings"
 */
export function branchName(pageTitle, pageUrl) {
  return `pincushion/${pageSlug(pageTitle, pageUrl)}`;
}

/**
 * Check if a branch exists locally or on the remote.
 * @param {string} projectDir - Repo root
 * @param {string} branch - Branch name
 * @returns {Promise<'local'|'remote'|null>}
 */
export async function branchExists(projectDir, branch) {
  try {
    await git(projectDir, 'rev-parse', '--verify', branch);
    return 'local';
  } catch {
    try {
      await git(projectDir, 'rev-parse', '--verify', `origin/${branch}`);
      return 'remote';
    } catch {
      return null;
    }
  }
}

/**
 * Ensure a pincushion branch exists and is checked out.
 * Creates from the default branch if it doesn't exist.
 * Checks out and rebases if it already exists.
 *
 * @param {string} projectDir - Repo root
 * @param {string} pageTitle - Page title for slug
 * @param {string} pageUrl - Page URL fallback
 * @returns {Promise<{ branch: string, created: boolean }>}
 */
export async function ensureBranch(projectDir, pageTitle, pageUrl) {
  const branch = branchName(pageTitle, pageUrl);
  const exists = await branchExists(projectDir, branch);

  if (exists === 'local') {
    await git(projectDir, 'checkout', branch);
    // Try to rebase on main to stay current
    try {
      const { stdout: defaultBranch } = await git(projectDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
      const baseBranch = defaultBranch.replace('origin/', '');
      await git(projectDir, 'rebase', baseBranch);
    } catch {
      // Rebase failed — leave as-is, developer will handle conflicts
    }
    return { branch, created: false };
  }

  if (exists === 'remote') {
    await git(projectDir, 'checkout', '-b', branch, `origin/${branch}`);
    return { branch, created: false };
  }

  // Create new branch from default branch
  let baseBranch = 'main';
  try {
    const { stdout } = await git(projectDir, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD');
    baseBranch = stdout.replace('origin/', '');
  } catch {
    // Fallback to 'main'
  }

  await git(projectDir, 'checkout', '-b', branch, baseBranch);
  return { branch, created: true };
}

// Trailer presets, in order of verbosity. Ordering matters: preset selection
// flows through `buildTrailers()` below, which emits exactly the keys this
// preset asks for, suppressing any whose value is empty or redundant.
const TRAILER_PRESETS = ['minimal', 'standard', 'full'];

/**
 * Build the trailer block for a pin commit, applying preset rules and
 * redundancy suppression. Pure function — exported for testability.
 *
 * Preset semantics:
 *   minimal  → just `Pin-ID:` (today's behavior, the safe default)
 *   standard → adds `Reviewed-By:` *only when* it differs from the committer
 *              (self-approval is silently elided so the commit doesn't
 *              redundantly attribute the same person twice)
 *   full     → standard + `Pincushion-Pin-Url:` for terminal-first workflows
 *
 * The kill switch (env var `PINCUSHION_TRAILERS=off`) collapses any preset
 * to `minimal`. This is intentionally global and stateless — a developer
 * who finds even the standard preset noisy on a given branch can opt out
 * for one shell without touching project config.
 *
 * @param {string} pinId
 * @param {object} [meta]
 * @param {'minimal'|'standard'|'full'} [meta.preset]
 * @param {string|null} [meta.reviewedBy]   The pin's approvedBy
 * @param {string|null} [meta.committerEmail] Used to suppress self-approval
 * @param {string|null} [meta.pinUrl]
 * @returns {string} Trailer block (no leading newline)
 */
export function buildTrailers(pinId, meta = {}) {
  const killed = (process.env.PINCUSHION_TRAILERS || '').toLowerCase() === 'off';
  const preset = killed ? 'minimal' : (TRAILER_PRESETS.includes(meta.preset) ? meta.preset : 'minimal');

  const trailers = [`Pin-ID: ${pinId}`];

  if (preset === 'standard' || preset === 'full') {
    const approver = (meta.reviewedBy || '').trim();
    const committer = (meta.committerEmail || '').trim().toLowerCase();
    // Suppress when approver IS the committer — git's Author already
    // captures that person; double-attribution is noise, not signal.
    const isSelfApproval = approver && committer &&
      (approver.toLowerCase() === committer || approver.toLowerCase() === committer.split('@')[0]);
    if (approver && !isSelfApproval) {
      trailers.push(`Reviewed-By: ${approver}`);
    }
  }

  if (preset === 'full') {
    const url = (meta.pinUrl || '').trim();
    if (url) trailers.push(`Pincushion-Pin-Url: ${url}`);
  }

  return trailers.join('\n');
}

/**
 * Commit a pin implementation with a structured trailer block.
 *
 * @param {string} projectDir - Repo root
 * @param {string} pinId - Pin ID (e.g. "ann_abc123")
 * @param {string} message - Human-readable description of the change
 * @param {object} [meta] - See `buildTrailers()`. Backwards-compatible:
 *                          omitting `meta` produces the legacy `Pin-ID:`-only
 *                          commit so existing callers behave identically.
 * @returns {Promise<{ commitHash: string }>}
 */
export async function commitPinFix(projectDir, pinId, message, meta = {}) {
  await git(projectDir, 'add', '-A');

  // Look up the committer email if not explicitly provided. Cheap (`git config`
  // is local and synchronous) and lets the preset rules suppress self-approval.
  let committerEmail = meta.committerEmail;
  if (committerEmail === undefined && (meta.preset === 'standard' || meta.preset === 'full')) {
    try {
      const { stdout } = await git(projectDir, 'config', '--get', 'user.email');
      committerEmail = stdout;
    } catch { committerEmail = null; }
  }

  const trailers = buildTrailers(pinId, { ...meta, committerEmail });
  const commitMsg = `pincushion: ${message}\n\n${trailers}`;
  const { stdout } = await git(projectDir, 'commit', '-m', commitMsg);

  const hashMatch = stdout.match(/\[.+ ([a-f0-9]+)\]/);
  return { commitHash: hashMatch?.[1] || 'unknown' };
}

/**
 * Get the current branch name.
 */
export async function currentBranch(projectDir) {
  const { stdout } = await git(projectDir, 'branch', '--show-current');
  return stdout;
}

// ─── A3: likely-files inference ─────────────────────────────────────────────

// Pull candidate component identifiers out of a DOM snippet so we can grep
// the source tree for matching files. Looks for: PascalCase tags
// (`<LoginForm>`), `data-component="..."` attributes, and class names that
// look like component identifiers (camelCase or kebab-case multi-word).
export function extractComponentHints(domSnippet) {
  if (!domSnippet || typeof domSnippet !== 'string') return [];
  const hints = new Set();

  // <PascalCase> custom components (React/Vue/SFC-style)
  for (const m of domSnippet.matchAll(/<([A-Z][A-Za-z0-9]+)(?:\s|>|\/)/g)) {
    hints.add(m[1]);
  }
  // data-component="Foo" / data-testid="something-form"
  for (const m of domSnippet.matchAll(/data-(?:component|testid|cy)=["']([^"']+)["']/g)) {
    hints.add(m[1]);
  }
  // className/class — but only multi-word kebab-case or camelCase tokens
  // (single-word utility classes like "btn" or "flex" are too generic).
  for (const m of domSnippet.matchAll(/(?:className|class)=["']([^"']+)["']/g)) {
    for (const cls of m[1].split(/\s+/)) {
      if (/^[a-z][a-z0-9]*-[a-z0-9-]{2,}$/i.test(cls)) hints.add(cls);   // kebab multi-word
      if (/^[a-z][a-z0-9]*[A-Z][A-Za-z0-9]+$/.test(cls)) hints.add(cls); // camelCase
    }
  }

  // De-duplicate case-insensitively but keep the first-seen casing
  const out = [];
  const seen = new Set();
  for (const h of hints) {
    const k = h.toLowerCase();
    if (!seen.has(k)) { seen.add(k); out.push(h); }
  }
  return out;
}

// The source search is deliberately local, tracked-only, and bounded. It is
// a hint for an implementing agent, never a source upload or a code-indexing
// mechanism. Keep the bounds exported so callers and tests can tell when a
// result is necessarily incomplete.
export const SOURCE_SUGGESTION_LIMITS = Object.freeze({
  defaultLimit: 8,
  maxLimit: 16,
  maxCandidateFiles: 240,
  maxFileBytes: 128 * 1024,
  maxHints: 24,
});

// Structured copy proposals are observations about a frozen review, not a
// request to run a replacement.  This smaller search budget lets an agent
// revalidate the exact original text against tracked source bytes without
// indexing or returning those bytes.  CSS/SCSS are in SOURCE_FILE_PATTERN,
// so text owned by a stylesheet is considered alongside component sources.
export const SOURCE_TEXT_REVALIDATION_LIMITS = Object.freeze({
  maxChecks: 8,
  maxCandidateFiles: 240,
  maxFileBytes: 128 * 1024,
  maxMatchedPathsPerCheck: 8,
});

const SOURCE_FILE_PATTERN = /\.(?:tsx?|jsx?|vue|svelte|astro|html|mjs|cjs|css|scss)$/i;
const STYLE_FILE_PATTERN = /\.(?:css|scss)$/i;
const EXCLUDED_SOURCE_DIRECTORIES = new Set([
  '.git', '.next', '.nuxt', '.svelte-kit', 'bower_components', 'build',
  'coverage', 'deps', 'dist', 'node_modules', 'third-party', 'third_party', 'vendor',
]);

function normalizeSourcePath(filePath) {
  if (typeof filePath !== 'string' || !filePath || filePath.length > 1024 || /[\x00-\x1f\x7f]/.test(filePath)) return null;
  const normalized = filePath.replaceAll('\\', '/');
  if (/^[A-Za-z]:/.test(normalized) || normalized.startsWith('/') || normalized === '.' || normalized === '..'
    || normalized.startsWith('../') || normalized.includes('/../')) return null;
  const segments = normalized.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) return null;
  return normalized;
}

function sourcePathExclusion(filePath, { requireSourceExtension = true } = {}) {
  const normalized = normalizeSourcePath(filePath);
  if (!normalized) return { reason: 'unsafe_path', path: null };

  const segments = normalized.toLowerCase().split('/');
  if (segments.some(segment => EXCLUDED_SOURCE_DIRECTORIES.has(segment))) {
    return { reason: 'dependency_or_generated_path', path: normalized };
  }
  if (segments.some(segment => ['.aws', '.ssh', 'credentials', 'keys', 'private', 'secret', 'secrets'].includes(segment))) {
    return { reason: 'sensitive_path', path: normalized };
  }

  const base = segments.at(-1);
  const stem = base.replace(/\.[^.]+$/, '');
  if (/^(?:\.env(?:\.|$)|credentials?\.json$|id_(?:rsa|dsa|ecdsa|ed25519)$)/i.test(base)
    || /\.(?:key|pem|p12|pfx)$/i.test(base)
    || /(?:^|[._-])(?:secret|secrets|credential|credentials)(?:$|[._-])/.test(stem)) {
    return { reason: 'sensitive_path', path: normalized };
  }
  if (requireSourceExtension && !SOURCE_FILE_PATTERN.test(normalized)) {
    return { reason: 'unsupported_extension', path: normalized };
  }
  return { reason: null, path: normalized };
}

/**
 * Filter legacy likely-file values without changing their string[] interface.
 * This is intentionally less restrictive than the new inference path: an
 * existing integration may legitimately point at a native source extension
 * that this JavaScript-focused search does not scan. Unsafe, dependency, and
 * secret-looking paths are always removed.
 */
export function filterLikelyFilePaths(paths) {
  if (!Array.isArray(paths)) return [];
  const seen = new Set();
  const safe = [];
  for (const candidate of paths) {
    if (safe.length >= SOURCE_SUGGESTION_LIMITS.maxLimit) break;
    const { reason, path } = sourcePathExclusion(candidate, { requireSourceExtension: false });
    if (reason || !path || seen.has(path)) continue;
    seen.add(path);
    safe.push(path);
  }
  return safe;
}

function boundedLimit(value) {
  if (!Number.isFinite(value)) return SOURCE_SUGGESTION_LIMITS.defaultLimit;
  return Math.max(0, Math.min(Math.floor(value), SOURCE_SUGGESTION_LIMITS.maxLimit));
}

function fingerprint(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function inspectWorkingTree(projectDir) {
  try {
    const { stdout } = await git(projectDir, 'status', '--porcelain=v1', '-z');
    const changes = stdout.split('\0').filter(Boolean);
    return {
      state: changes.length > 0 ? 'dirty' : 'clean',
      statusFingerprint: fingerprint(stdout),
      changedPathCount: changes.length,
    };
  } catch {
    return { state: 'unknown', statusFingerprint: null, changedPathCount: null };
  }
}

function insideProject(projectRoot, candidatePath) {
  const relativePath = relative(projectRoot, candidatePath);
  return relativePath !== ''
    && relativePath !== '..'
    && !relativePath.startsWith(`..${sep}`)
    && !isAbsolute(relativePath);
}

function emptySkipCounts() {
  return {
    dependencyOrGeneratedPaths: 0,
    sensitivePaths: 0,
    unsafePaths: 0,
    unsupportedExtensions: 0,
    oversizedFiles: 0,
    symlinkOrEscapePaths: 0,
    unreadableFiles: 0,
  };
}

function countPathExclusion(skipCounts, reason) {
  if (reason === 'dependency_or_generated_path') skipCounts.dependencyOrGeneratedPaths++;
  else if (reason === 'sensitive_path') skipCounts.sensitivePaths++;
  else if (reason === 'unsafe_path') skipCounts.unsafePaths++;
  else if (reason === 'unsupported_extension') skipCounts.unsupportedExtensions++;
}

function pathHintScore(filePath, hints) {
  const lower = filePath.toLowerCase();
  return hints.reduce((score, hint) => (
    lower.includes(hint.toLowerCase()) ? score + hint.length : score
  ), 0);
}

function safeHints(domSnippet) {
  return extractComponentHints(domSnippet)
    .filter(hint => hint.length >= 3)
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .slice(0, SOURCE_SUGGESTION_LIMITS.maxHints);
}

function rankCandidatePaths(paths, hints) {
  return [...paths].sort((a, b) => {
    const pathScore = pathHintScore(b, hints) - pathHintScore(a, hints);
    if (pathScore) return pathScore;
    // CSS/SCSS are path-independent style matches, so scan them before the
    // remaining general source files when the content-search cap is reached.
    const styleScore = Number(STYLE_FILE_PATTERN.test(b)) - Number(STYLE_FILE_PATTERN.test(a));
    if (styleScore) return styleScore;
    return a.localeCompare(b);
  });
}

function suggestionConfidence(match) {
  const matchedContent = match.matchedBy.has('content');
  const matchedPath = match.matchedBy.has('path');
  if (matchedContent && matchedPath) return 'high';
  if (matchedContent && [...match.hints].some(hint => hint.length >= 8)) return 'high';
  if (matchedContent || matchedPath) return 'medium';
  return 'low';
}

function buildUncertainty({ revision, workingTree, hints, suggestions, candidateCapReached, skipCounts }) {
  const reasons = [];
  let level = 'low';
  if (!revision) {
    return {
      level: 'high',
      reasons: ['No Git revision was available, so source suggestions could not be verified.'],
    };
  }
  if (workingTree?.state === 'unknown') {
    return {
      level: 'high',
      reasons: ['The local working-tree state could not be inspected, so the source-byte context is uncertain.'],
    };
  }
  if (hints.length === 0) {
    return {
      level: 'high',
      reasons: ['The DOM snippet did not contain a specific component, test-id, or multi-word class hint.'],
    };
  }
  if (suggestions.length === 0) {
    level = 'medium';
    reasons.push('No safe tracked source file matched the available DOM hints.');
  } else if (suggestions.some(suggestion => !suggestion.matchedBy.includes('content'))) {
    level = 'medium';
    reasons.push('Some suggestions matched a file path but not its bounded source content.');
  }
  if (candidateCapReached) {
    level = level === 'low' ? 'medium' : 'high';
    reasons.push(`Only the first ${SOURCE_SUGGESTION_LIMITS.maxCandidateFiles} safe source candidates were inspected.`);
  }
  if (skipCounts.unreadableFiles > 0) {
    level = level === 'low' ? 'medium' : level;
    reasons.push(`${skipCounts.unreadableFiles} safe candidate file(s) could not be read.`);
  }
  if (workingTree?.state === 'dirty') {
    level = level === 'low' ? 'medium' : level;
    reasons.push('Suggestions were read from a dirty working tree; the Git revision names HEAD, not immutable file bytes.');
  }
  return { level, reasons };
}

function baseProvenance(revision, state, workingTree) {
  return {
    schemaVersion: 1,
    repository: {
      state,
      // `revision` remains for callers that already consume it. The explicit
      // fields below prevent a HEAD OID from being mistaken for the bytes read.
      revision,
      headRevision: revision,
      contentSource: 'working_tree',
      workingTree,
    },
    search: {
      mode: 'bounded_local_content',
      maxCandidateFiles: SOURCE_SUGGESTION_LIMITS.maxCandidateFiles,
      maxFileBytes: SOURCE_SUGGESTION_LIMITS.maxFileBytes,
      maxSuggestions: SOURCE_SUGGESTION_LIMITS.maxLimit,
      scannedFiles: 0,
      candidateFiles: 0,
      skipped: emptySkipCounts(),
    },
    implementation: {
      verified: false,
      reason: 'Source suggestions are navigation hints, not evidence that an implementation exists or is correct.',
    },
    uncertainty: { level: 'high', reasons: [] },
  };
}

async function readBoundedSourceFile(projectRoot, candidatePath) {
  const intendedPath = resolve(projectRoot, candidatePath);
  if (!insideProject(projectRoot, intendedPath)) return { reason: 'symlink_or_escape' };
  let handle;
  try {
    // O_NOFOLLOW closes the final-component swap between lstat and open on
    // platforms that support it. The post-open inode check below also rejects
    // a parent-directory swap or a platform without that flag.
    const resolvedBeforeOpen = await realpath(intendedPath);
    if (resolvedBeforeOpen !== intendedPath) return { reason: 'symlink_or_escape' };
    const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
    handle = await open(intendedPath, constants.O_RDONLY | noFollow);
    const openedStat = await handle.stat();
    if (!openedStat.isFile()) return { reason: 'symlink_or_escape' };
    if (openedStat.size > SOURCE_SUGGESTION_LIMITS.maxFileBytes) return { reason: 'oversized' };

    const resolvedAfterOpen = await realpath(intendedPath);
    if (resolvedAfterOpen !== intendedPath || !insideProject(projectRoot, resolvedAfterOpen)) return { reason: 'symlink_or_escape' };
    const resolvedStat = await lstat(resolvedAfterOpen);
    if (!resolvedStat.isFile() || resolvedStat.isSymbolicLink()
      || resolvedStat.dev !== openedStat.dev || resolvedStat.ino !== openedStat.ino) {
      return { reason: 'symlink_or_escape' };
    }

    // A bounded descriptor read protects against a file that grows after the
    // pre-open lstat. Rechecking fstat afterwards rejects a late growth too.
    const buffer = Buffer.alloc(SOURCE_SUGGESTION_LIMITS.maxFileBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > SOURCE_SUGGESTION_LIMITS.maxFileBytes) return { reason: 'oversized' };
    const afterReadStat = await handle.stat();
    if (!afterReadStat.isFile() || afterReadStat.dev !== openedStat.dev || afterReadStat.ino !== openedStat.ino) {
      return { reason: 'symlink_or_escape' };
    }
    if (afterReadStat.size > SOURCE_SUGGESTION_LIMITS.maxFileBytes) return { reason: 'oversized' };

    const content = buffer.subarray(0, bytesRead);
    return { content, contentFingerprint: fingerprint(content) };
  } catch (err) {
    return { reason: err?.code === 'ELOOP' ? 'symlink_or_escape' : 'unreadable' };
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

/**
 * Find local, tracked source-file suggestions for a DOM snippet.
 *
 * Results contain legacy-compatible `likelyFiles` plus per-file match reasons
 * and a Git-bound provenance object. The function never returns file content,
 * never searches untracked/dependency files, and rejects symlinks or resolved
 * paths outside the project root.
 *
 * @returns {Promise<{
 *   likelyFiles: string[],
 *   suggestions: Array<{path: string, confidence: 'high'|'medium'|'low', matchedBy: string[], hints: string[]}>,
 *   provenance: object
 * }>}
 */
export async function inferLikelyFileSuggestions(projectDir, domSnippet, options = {}) {
  const limit = boundedLimit(options?.limit);
  let revision = null;
  try {
    const { stdout } = await git(projectDir, 'rev-parse', '--verify', 'HEAD');
    if (/^[0-9a-f]{40,64}$/i.test(stdout)) revision = stdout;
  } catch {
    // A non-Git directory is a normal offline/degraded condition, not an error.
  }

  const workingTree = revision
    ? await inspectWorkingTree(projectDir)
    : { state: 'unavailable', statusFingerprint: null, changedPathCount: null };
  const provenance = baseProvenance(revision, revision ? 'git' : 'gitless', workingTree);
  const hints = safeHints(domSnippet);
  if (!revision || hints.length === 0 || limit === 0) {
    provenance.search.status = !revision ? 'unavailable' : hints.length === 0 ? 'not_run' : 'limit_zero';
    provenance.search.hintsAnalyzed = hints.length;
    provenance.uncertainty = limit === 0 && revision && hints.length > 0
      ? { level: 'medium', reasons: ['The caller requested zero source suggestions.'] }
      : buildUncertainty({
        revision,
        workingTree,
        hints,
        suggestions: [],
        candidateCapReached: false,
        skipCounts: provenance.search.skipped,
      });
    return { likelyFiles: [], suggestions: [], provenance };
  }

  let projectRoot;
  try {
    projectRoot = await realpath(projectDir);
  } catch {
    provenance.repository.state = 'unavailable';
    provenance.search.status = 'unavailable';
    provenance.uncertainty = {
      level: 'high',
      reasons: ['The project directory could not be resolved for a safe local source search.'],
    };
    return { likelyFiles: [], suggestions: [], provenance };
  }

  let trackedPaths;
  try {
    const { stdout } = await git(projectDir, 'ls-files', '-z');
    trackedPaths = stdout.split('\0').filter(Boolean);
  } catch {
    provenance.search.status = 'unavailable';
    provenance.uncertainty = {
      level: 'high',
      reasons: ['Tracked files could not be listed for the current Git revision.'],
    };
    return { likelyFiles: [], suggestions: [], provenance };
  }

  const safeSourcePaths = [];
  for (const trackedPath of trackedPaths) {
    const excluded = sourcePathExclusion(trackedPath);
    if (excluded.reason) {
      countPathExclusion(provenance.search.skipped, excluded.reason);
      continue;
    }
    safeSourcePaths.push(excluded.path);
  }

  const rankedPaths = rankCandidatePaths(safeSourcePaths, hints);
  const candidatePaths = rankedPaths.slice(0, SOURCE_SUGGESTION_LIMITS.maxCandidateFiles);
  const candidateCapReached = rankedPaths.length > candidatePaths.length;
  provenance.search.status = 'completed';
  provenance.search.hintsAnalyzed = hints.length;
  provenance.search.candidateFiles = candidatePaths.length;

  const matches = new Map();
  for (const filePath of candidatePaths) {
    const candidatePath = resolve(projectRoot, filePath);
    if (!insideProject(projectRoot, candidatePath)) {
      provenance.search.skipped.symlinkOrEscapePaths++;
      continue;
    }

    let stat;
    try {
      stat = await lstat(candidatePath);
    } catch {
      provenance.search.skipped.unreadableFiles++;
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      provenance.search.skipped.symlinkOrEscapePaths++;
      continue;
    }
    if (stat.size > SOURCE_SUGGESTION_LIMITS.maxFileBytes) {
      provenance.search.skipped.oversizedFiles++;
      continue;
    }

    try {
      const resolvedPath = await realpath(candidatePath);
      if (resolvedPath !== candidatePath || !insideProject(projectRoot, resolvedPath)) {
        provenance.search.skipped.symlinkOrEscapePaths++;
        continue;
      }
    } catch {
      provenance.search.skipped.unreadableFiles++;
      continue;
    }

    const boundedRead = await readBoundedSourceFile(projectRoot, candidatePath);
    if (boundedRead.reason === 'oversized') {
      provenance.search.skipped.oversizedFiles++;
      continue;
    }
    if (boundedRead.reason === 'symlink_or_escape') {
      provenance.search.skipped.symlinkOrEscapePaths++;
      continue;
    }
    if (boundedRead.reason || !boundedRead.content) {
      provenance.search.skipped.unreadableFiles++;
      continue;
    }
    provenance.search.scannedFiles++;

    const lowerPath = filePath.toLowerCase();
    const lowerContent = boundedRead.content.toString('utf8').toLowerCase();
    for (const hint of hints) {
      const needle = hint.toLowerCase();
      const pathMatch = lowerPath.includes(needle);
      const contentMatch = lowerContent.includes(needle);
      if (!pathMatch && !contentMatch) continue;

      const match = matches.get(filePath) || {
        path: filePath,
        score: 0,
        matchedBy: new Set(),
        hints: new Set(),
        contentFingerprint: boundedRead.contentFingerprint,
      };
      if (pathMatch) {
        match.matchedBy.add('path');
        match.score += 8 + Math.min(hint.length, 24);
      }
      if (contentMatch) {
        match.matchedBy.add('content');
        match.score += 16 + Math.min(hint.length, 24);
      }
      match.hints.add(hint);
      matches.set(filePath, match);
    }
  }

  const suggestions = [...matches.values()]
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map(match => ({
      path: match.path,
      // This describes only the strength of the local source-hint match; it
      // is intentionally not an implementation, review, or delivery verdict.
      confidence: suggestionConfidence(match),
      confidenceScope: 'source_hint_match',
      matchedBy: [...match.matchedBy].sort(),
      hints: [...match.hints].sort((a, b) => b.length - a.length || a.localeCompare(b)),
      contentFingerprint: match.contentFingerprint,
    }));

  provenance.search.suggestionSetFingerprint = suggestions.length > 0
    ? fingerprint(suggestions.map(({ path, contentFingerprint }) => `${path}\0${contentFingerprint}`).join('\0'))
    : null;
  provenance.uncertainty = buildUncertainty({
    revision,
    workingTree,
    hints,
    suggestions,
    candidateCapReached,
    skipCounts: provenance.search.skipped,
  });
  return {
    likelyFiles: suggestions.map(suggestion => suggestion.path),
    suggestions,
    provenance,
  };
}

// Legacy callers receive the exact string[] shape they used before the
// structured provenance API was added.
export async function inferLikelyFiles(projectDir, domSnippet, options = {}) {
  const result = await inferLikelyFileSuggestions(projectDir, domSnippet, options);
  return result.likelyFiles;
}

function literalOccurrenceCount(content, needle) {
  let count = 0;
  let offset = 0;
  while (offset <= content.length - needle.length) {
    const index = content.indexOf(needle, offset);
    if (index < 0) break;
    count++;
    offset = index + Math.max(needle.length, 1);
  }
  return count;
}

/**
 * Revalidate a bounded set of exact original-text observations against the
 * current local working tree.  Only tracked, safe source files are read and
 * no source text is returned.  A clean HEAD OID identifies the repository;
 * when the tree is dirty, that fact is explicit because the bytes inspected
 * are not immutable Git-object bytes.
 *
 * This is deliberately not an edit planner: duplicate/missing text is an
 * ambiguity signal and callers must select a target themselves.  In
 * particular, it never treats a screenshot as an editable live page and
 * never proposes a global replacement.
 */
export async function revalidateTrackedSourceText(projectDir, originalTexts) {
  const seen = new Set();
  const normalized = [];
  let invalidCount = 0;
  for (const value of Array.isArray(originalTexts) ? originalTexts : []) {
    if (typeof value !== 'string' || value.length < 1 || value.length > 16_384) {
      invalidCount++;
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  const selected = normalized.slice(0, SOURCE_TEXT_REVALIDATION_LIMITS.maxChecks);
  const truncated = normalized.length > selected.length;
  const checks = selected.map((originalText, index) => ({
    index,
    originalTextFingerprint: fingerprint(originalText),
    originalTextLength: originalText.length,
    status: 'unavailable',
    occurrenceCount: 0,
    matchedPaths: [],
  }));
  const result = {
    schemaVersion: 1,
    availability: { state: 'unavailable', reason: 'source_revalidation_unavailable' },
    truncated,
    omittedUniqueOriginalCount: Math.max(0, normalized.length - selected.length),
    invalidOriginalCount: invalidCount,
    checks,
    provenance: {
      repository: {
        state: 'unavailable', revision: null, headRevision: null,
        contentSource: 'working_tree', workingTree: null,
      },
      search: {
        mode: 'bounded_tracked_exact_text', status: 'unavailable',
        maxCandidateFiles: SOURCE_TEXT_REVALIDATION_LIMITS.maxCandidateFiles,
        maxFileBytes: SOURCE_TEXT_REVALIDATION_LIMITS.maxFileBytes,
        candidateFiles: 0, scannedFiles: 0, candidateCapReached: false,
        skipped: emptySkipCounts(),
      },
      uncertainty: {
        level: 'high',
        reasons: ['No safe tracked-source revalidation was available.'],
      },
    },
  };
  if (selected.length === 0) {
    result.availability = { state: 'available' };
    result.provenance.search.status = 'not_run';
    result.provenance.uncertainty = {
      level: invalidCount > 0 ? 'high' : 'low',
      reasons: invalidCount > 0 ? ['One or more original-text observations were outside the bounded contract.'] : [],
    };
    return result;
  }

  let revision = null;
  try {
    const response = await git(projectDir, 'rev-parse', '--verify', 'HEAD');
    if (/^[0-9a-f]{40,64}$/i.test(response.stdout)) revision = response.stdout;
  } catch {
    // A project without Git remains an explicit unavailable condition.
  }
  if (!revision) return result;
  result.provenance.repository = {
    state: 'git', revision, headRevision: revision,
    contentSource: 'working_tree', workingTree: await inspectWorkingTree(projectDir),
  };
  let projectRoot;
  try {
    projectRoot = await realpath(projectDir);
  } catch {
    return result;
  }
  let trackedPaths;
  try {
    const response = await git(projectDir, 'ls-files', '-z');
    trackedPaths = response.stdout.split('\0').filter(Boolean);
  } catch {
    return result;
  }
  const safePaths = [];
  for (const trackedPath of trackedPaths) {
    const excluded = sourcePathExclusion(trackedPath);
    if (excluded.reason) {
      countPathExclusion(result.provenance.search.skipped, excluded.reason);
      continue;
    }
    safePaths.push(excluded.path);
  }
  // Deterministic order makes the bounded result auditable. Styles lead so a
  // CSS/SCSS copy value is not starved behind a large component tree.
  const candidatePaths = safePaths.sort((a, b) => {
    const style = Number(STYLE_FILE_PATTERN.test(b)) - Number(STYLE_FILE_PATTERN.test(a));
    return style || a.localeCompare(b);
  }).slice(0, SOURCE_TEXT_REVALIDATION_LIMITS.maxCandidateFiles);
  const candidateCapReached = safePaths.length > candidatePaths.length;
  result.provenance.search.candidateFiles = candidatePaths.length;
  result.provenance.search.candidateCapReached = candidateCapReached;
  for (const filePath of candidatePaths) {
    const candidatePath = resolve(projectRoot, filePath);
    if (!insideProject(projectRoot, candidatePath)) {
      result.provenance.search.skipped.symlinkOrEscapePaths++;
      continue;
    }
    const boundedRead = await readBoundedSourceFile(projectRoot, candidatePath);
    if (boundedRead.reason === 'oversized') {
      result.provenance.search.skipped.oversizedFiles++;
      continue;
    }
    if (boundedRead.reason === 'symlink_or_escape') {
      result.provenance.search.skipped.symlinkOrEscapePaths++;
      continue;
    }
    if (boundedRead.reason || !boundedRead.content) {
      result.provenance.search.skipped.unreadableFiles++;
      continue;
    }
    result.provenance.search.scannedFiles++;
    const content = boundedRead.content.toString('utf8');
    for (let index = 0; index < selected.length; index++) {
      const occurrences = literalOccurrenceCount(content, selected[index]);
      if (!occurrences) continue;
      const check = checks[index];
      check.occurrenceCount += occurrences;
      if (check.matchedPaths.length < SOURCE_TEXT_REVALIDATION_LIMITS.maxMatchedPathsPerCheck) {
        check.matchedPaths.push({ path: filePath, occurrences, contentFingerprint: boundedRead.contentFingerprint });
      }
    }
  }
  const incomplete = candidateCapReached || result.provenance.search.skipped.unreadableFiles > 0
    || result.provenance.search.skipped.oversizedFiles > 0
    || result.provenance.search.skipped.symlinkOrEscapePaths > 0;
  for (const check of checks) {
    if (check.occurrenceCount > 1) check.status = 'multiple_matches';
    else if (check.occurrenceCount === 1) check.status = 'exact_match';
    else check.status = incomplete ? 'inconclusive' : 'not_found';
  }
  result.availability = { state: 'available' };
  result.provenance.search.status = 'completed';
  const reasons = [];
  let level = 'low';
  if (candidateCapReached) {
    level = 'high';
    reasons.push(`Only the first ${SOURCE_TEXT_REVALIDATION_LIMITS.maxCandidateFiles} safe tracked source files were searched.`);
  }
  if (result.provenance.search.skipped.unreadableFiles > 0 || result.provenance.search.skipped.oversizedFiles > 0 || result.provenance.search.skipped.symlinkOrEscapePaths > 0) {
    level = level === 'low' ? 'medium' : level;
    reasons.push('One or more safe source candidates could not be fully inspected.');
  }
  if (result.provenance.repository.workingTree?.state === 'dirty') {
    level = level === 'low' ? 'medium' : level;
    reasons.push('Text was checked in a dirty working tree; HEAD identifies the repository revision but not immutable working-tree bytes.');
  }
  if (truncated) {
    level = level === 'low' ? 'medium' : level;
    reasons.push(`Only ${SOURCE_TEXT_REVALIDATION_LIMITS.maxChecks} unique original-text observations were checked.`);
  }
  result.provenance.uncertainty = { level, reasons };
  return result;
}

/**
 * List all pincushion/* branches.
 */
export async function listPincushionBranches(projectDir) {
  try {
    const { stdout } = await git(projectDir, 'branch', '--list', 'pincushion/*');
    return stdout
      .split('\n')
      .map(b => b.trim().replace(/^\* /, ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}
