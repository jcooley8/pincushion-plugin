// lib/git.js — Git helpers for branch-per-page agentic workflow
// Provides utilities for creating and managing pincushion/* branches.
// The MCP server doesn't run these directly — it provides the data
// and instructions, and the IDE agent executes the git commands.
// These helpers are available for agents that have shell access.

import { execFile } from 'child_process';
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

// Given a DOM snippet, find source files in the repo whose path matches any
// extracted component hint. Returns at most `limit` paths, ranked by hint
// specificity (longer / more-unique hints first).
export async function inferLikelyFiles(projectDir, domSnippet, { limit = 8 } = {}) {
  const hints = extractComponentHints(domSnippet);
  if (hints.length === 0) return [];

  let lsFiles;
  try {
    const { stdout } = await git(projectDir, 'ls-files');
    lsFiles = stdout.split('\n').filter(Boolean);
  } catch {
    return [];
  }

  // Restrict to plausible source-code extensions so we don't surface assets.
  const sourceFiles = lsFiles.filter(f =>
    /\.(?:tsx?|jsx?|vue|svelte|astro|html|mjs|cjs)$/.test(f)
  );

  // Sort hints longest-first so more-specific matches win the ranking.
  const sorted = [...hints].sort((a, b) => b.length - a.length);

  const matched = new Map(); // path -> best hint length
  for (const hint of sorted) {
    const needle = hint.toLowerCase();
    for (const file of sourceFiles) {
      const base = file.toLowerCase();
      if (base.includes(needle)) {
        const current = matched.get(file) || 0;
        if (hint.length > current) matched.set(file, hint.length);
      }
    }
  }

  return [...matched.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([file]) => file);
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
