// ownership.mjs
// Ownership validation for crit-claim: confirm the founder controls the site that
// serves a crit URL. See docs/superpowers/specs/2026-06-23-crit-connect-ownership-design.md

export function hostOf(url) {
  let u = String(url || '').trim();
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); }
  catch { return ''; }
}

export function urlMatchesDomains(url, domains) {
  const h = hostOf(url);
  if (!h) return false;
  return (domains || []).some((d) => hostOf(d) === h);
}

import { readFileSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

// — No provider tokens (owner decision 2026-10-25: tag-only) —
// The claim never reads, requests or forwards a Vercel (or any provider) token.
// Ownership is proven by the live <meta name="pincushion-project"> tag, which
// claim-report verifies itself.

// — Claim path decision —

// 'mobile_repo' only changes the message: both paths claim with the live tag.
export function decideClaimPath({ mobileRepoResult = null } = {}) {
  return mobileRepoResult && mobileRepoResult.validated ? 'mobile_repo' : 'tag';
}

// — Mobile repo / crit-wall validation —

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function sanitizeGitRemote(remote) {
  return String(remote || '')
    .trim()
    .replace(/\/\/[^/@]+@/, '//')
    .slice(0, 500);
}

function gitRemote(projectDir) {
  try {
    return sanitizeGitRemote(execFileSync('git', ['-C', projectDir, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {
    return '';
  }
}

const MOBILE_WALL_CANDIDATES = [
  {
    config: 'crit-wall/wall.config.json',
    context: 'crit-wall/wall/agent-context.json',
    packet: 'crit-wall/wall/agent-work-packet.json',
    plan: 'crit-wall/wall.plan.json',
  },
  {
    config: 'wall.config.json',
    context: 'wall/agent-context.json',
    packet: 'wall/agent-work-packet.json',
    plan: 'wall.plan.json',
  },
];

// Returns { validated:true, ... } when projectDir contains mobile-wall artifacts
// for the report's project. This is only a local signal: the server cannot
// verify it, so a mobile crit is claimed with the live ownership tag.
export function validateMobileRepoProof(projectDir, preview = {}) {
  const expectedProjectId = String(preview.projectId || '').trim();
  if (!expectedProjectId) return null;

  for (const rel of MOBILE_WALL_CANDIDATES) {
    const configPath = join(projectDir, rel.config);
    const contextPath = join(projectDir, rel.context);
    const packetPath = join(projectDir, rel.packet);
    const planPath = join(projectDir, rel.plan);
    const config = existsSync(configPath) ? readJson(configPath) : null;
    const context = existsSync(contextPath) ? readJson(contextPath) : null;
    const packet = existsSync(packetPath) ? readJson(packetPath) : null;
    const plan = existsSync(planPath) ? readJson(planPath) : null;

    if (!config && !context && !packet) continue;

    const artifactProjectIds = [
      config?.projectId,
      context?.projectId,
      context?.pincushion?.projectId,
      packet?.pincushion?.projectId,
    ].map((v) => String(v || '').trim()).filter(Boolean);
    if (!artifactProjectIds.includes(expectedProjectId)) continue;

    const remote = gitRemote(projectDir);
    const bundleId = String(plan?.app?.bundleId || packet?.app?.bundleId || '').trim().slice(0, 255);
    const platform = String(plan?.app?.platform || packet?.app?.platform || 'ios').trim().toLowerCase().slice(0, 40);
    const pageUrl = String(config?.pageUrl || context?.pageUrl || packet?.pincushion?.pageUrl || preview.projectUrl || '').trim().slice(0, 500);
    const reportUrl = String(config?.reportUrl || context?.reportUrl || packet?.pincushion?.reportUrl || '').trim().slice(0, 500);
    const targetRepo = String(config?.agent?.targetRepo || packet?.app?.targetRepo || '').trim().slice(0, 255);

    return {
      validated: true,
      projectId: expectedProjectId,
      bundleId,
      platform: platform || 'ios',
      gitRemote: remote,
      pageUrl,
      reportUrl,
      targetRepo,
      wallConfigPath: existsSync(configPath) ? rel.config : '',
      wallContextPath: existsSync(contextPath) ? rel.context : '',
      wallPlanPath: existsSync(planPath) ? rel.plan : '',
    };
  }

  return null;
}

// — Meta-tag fallback —

const HEAD_CANDIDATES = [
  'index.html', 'public/index.html', 'app/layout.tsx', 'app/layout.jsx',
  'pages/_document.tsx', 'pages/_document.jsx', 'src/app/layout.tsx', 'src/index.html',
];

export function metaTag(projectId) {
  return `<meta name="pincushion-project" content="${projectId}">`;
}

export function injectMetaTag(projectDir, projectId) {
  const tag = metaTag(projectId);
  for (const rel of HEAD_CANDIDATES) {
    const f = join(projectDir, rel);
    if (!existsSync(f)) continue;
    const src = readFileSync(f, 'utf8');
    if (src.includes(`content="${projectId}"`)) return { injected: false, file: f, reason: 'already-present' };
    const m = src.match(/<head[^>]*>/i);
    if (!m) continue; // framework file without a literal <head> — fall through to snippet
    const out = src.replace(m[0], `${m[0]}\n    ${tag}`);
    writeFileSync(f, out);
    return { injected: true, file: f };
  }
  return { injected: false, snippet: tag, reason: 'no-head-file' };
}
