// lib/license.js — pure helpers for license-key handling: key-source labels,
// safe key display (last-4 only), the rejected-license banner, and the
// requirePro gating decision. Kept free of I/O so they're unit-testable
// (tests/license-hardening.test.js) and reusable from server.js.

// Where the active license key came from, in resolution order. Knowing the
// source turns "your key was REJECTED" from a dead end into an actionable
// message — a stale env var or CLI arg silently overrides a fresh
// ~/.pincushion/license-key, and without naming the source users can't tell
// which of the four locations to fix.
export const KEY_SOURCE_LABELS = Object.freeze({
  'env': 'PINCUSHION_LICENSE_KEY env var',
  'cli-arg': '--license-key arg',
  'rotated': 'server-rotated key (this session, not persisted)',
  'project-file': '.feedback/.license-key',
  'home-file': '~/.pincushion/license-key',
  'none': 'no key configured',
});

export function keySourceLabel(source) {
  return KEY_SOURCE_LABELS[source] || 'unknown source';
}

// Safe display form of a key: last 4 chars only. NEVER print a full key.
export function keyLast4(key) {
  if (typeof key !== 'string' || key.trim().length < 4) return '????';
  return key.trim().slice(-4);
}

/**
 * Build the loud rejected-license banner. Names WHICH source supplied the
 * rejected key and its last 4 chars so the user can find and fix the exact
 * stale config, plus the one-command recovery path (`npx pincushion-mcp login`).
 * @param {{ source?: string, last4?: string }} info captured at rejection time
 */
export function buildRejectedLicenseBanner(info = {}) {
  const source = keySourceLabel(info.source);
  const last4 = info.last4 || '????';
  return [
    `⚠ PINCUSHION CLOUD SYNC IS OFF — your license key (…${last4}, from ${source}) was REJECTED (invalid or expired).`,
    'Pins are saving LOCALLY ONLY. Cloud pins, share reports, invites, and team features will NOT work.',
    'Fix: run `npx pincushion-mcp login` to fetch a fresh key (writes ~/.pincushion/license-key),',
    `or get your current key at https://www.pincushion.io/dashboard and update the ${source} source,`,
    'then restart the MCP server.',
    '', ''
  ].join('\n');
}

/**
 * Pro-gating decision (bug F-02 fix). Gate on the SERVER-VALIDATED plan
 * cached from sync responses, not on whether a key flag happened to be passed:
 *   - plan known and free            → deny (plan_required)
 *   - plan known pro/team            → allow
 *   - plan unknown (no sync yet):
 *       - a key is configured (ANY source) → allow optimistically; the server
 *         rejects downstream if the license is actually Free. Keeps offline
 *         use working.
 *       - no key at all              → deny fast (license_required)
 * @returns {null | { error: string, message: string, upgrade_url: string, current_plan?: string }}
 */
export function requireProDecision({ toolName, plan, hasLicenseKey }) {
  if (plan === 'pro' || plan === 'team') return null;
  if (plan) {
    return {
      error: 'plan_required',
      message: `The "${toolName}" tool requires Pro or Team. Your current plan is "${plan}". Upgrade at https://www.pincushion.io/pricing?ref=mcp-tool-gate`,
      current_plan: plan,
      upgrade_url: 'https://www.pincushion.io/pricing?ref=mcp-tool-gate'
    };
  }
  if (!hasLicenseKey) {
    return {
      error: 'license_required',
      message: `The "${toolName}" tool requires a PinCushion Pro or Team license. ` +
        `Run \`npx pincushion-mcp login\` or pass --license-key YOUR_KEY when starting the MCP server, or upgrade at https://www.pincushion.io/pricing?ref=mcp-tool-gate`,
      upgrade_url: 'https://www.pincushion.io/pricing?ref=mcp-tool-gate'
    };
  }
  return null; // key configured, plan not yet validated — stay lenient offline
}

/**
 * AI-action quota decision (growth plan, Lever 4). Same null-or-error-object
 * contract and the same offline-lenient posture as requireProDecision: this is
 * a UX pre-flight only — the authoritative gate is server-side in
 * sync-annotations, which 402s metered writes once the free monthly pool is
 * exhausted. Decide off the SERVER-REPORTED usage cached from sync responses:
 *   - effective plan pro/team (incl. trial) → allow (unlimited)
 *   - usage unknown (no sync yet / offline)  → allow; the server rejects later
 *   - usage known, remaining > 0             → allow
 *   - usage known, remaining <= 0            → deny with the upgrade path
 * @returns {null | { error: string, message: string, upgrade_url: string, used?: number, cap?: number, resets_at?: string }}
 */
export function requireQuotaDecision({ toolName, plan, usage }) {
  if (plan === 'pro' || plan === 'team') return null;
  if (!usage || typeof usage.cap !== 'number' || usage.cap < 0) return null;
  if (typeof usage.remaining === 'number' && usage.remaining > 0) return null;
  const resetsDate = typeof usage.resetsAt === 'string' ? usage.resetsAt.slice(0, 10) : 'next month';
  return {
    error: 'quota_exceeded',
    message: `The "${toolName}" tool is an AI action, and you've used ${usage.used} of ${usage.cap} free AI actions this month (resets ${resetsDate}). ` +
      `Manual pins and replies are unaffected. Upgrade for unlimited automation: https://www.pincushion.io/pricing?ref=mcp-ai-cap`,
    used: usage.used,
    cap: usage.cap,
    resets_at: usage.resetsAt,
    upgrade_url: 'https://www.pincushion.io/pricing?ref=mcp-ai-cap'
  };
}

/**
 * One-line usage meter for the banner stack. Returns '' unless the caller is
 * on the free pool AND running low (remaining <= threshold) — the banner must
 * never nag users who have plenty of headroom.
 */
export function usageMeterBanner({ plan, usage, threshold = 5 }) {
  if (plan === 'pro' || plan === 'team') return '';
  if (!usage || typeof usage.cap !== 'number' || usage.cap < 0) return '';
  if (typeof usage.remaining !== 'number' || usage.remaining > threshold) return '';
  const resetsDate = typeof usage.resetsAt === 'string' ? usage.resetsAt.slice(0, 10) : 'next month';
  const state = usage.remaining <= 0
    ? `all ${usage.cap} free AI actions used this month`
    : `${usage.used} of ${usage.cap} free AI actions used this month`;
  return `⚡ ${state} (resets ${resetsDate}). Manual pins/replies are unlimited; upgrade for unlimited automation: https://www.pincushion.io/pricing?ref=mcp-ai-cap\n\n`;
}
