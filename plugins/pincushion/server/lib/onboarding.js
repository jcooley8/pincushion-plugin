// onboarding.js — first-run on-ramp for the Pincushion MCP server.
// 2026-10-26: the signed-out startup line names `npx -y pincushion-mcp setup`,
// the same command as the local-only stderr hint, instead of `login`.
//
// Goal: give a new developer an honest connection check at the first MCP boot.
// When the active project has ZERO active findings (AI or human), we print a concise
// walkthrough block to stderr. It never requires a new browser pin or treats
// a written configuration file as proof that an agent is connected.
//
// This module is intentionally side-effect-free except for `maybePrintOnboarding`,
// which only writes to stderr (console.error) to match the server's existing
// `[startup]` / `[cloud-sync]` logging style. It NEVER writes a sample pin to
// Supabase or .feedback/ — an auto-written pin would pollute activation counts
// and risk prod-data/schema. This cycle is a printed walkthrough only.

import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

// Mirror of the bot identity declared in lib/core.js. Bot-authored pins
// (Pincushion AI critiques/replies) must NOT count as human activation — a
// project whose only pins are AI critiques has still never had a second human
// in the loop, so the on-ramp should still fire.
const BOT_EMAIL = 'pincushion-bot@pincushion.io';
const BOT_AUTHOR = 'Pincushion AI';

// Env flag that silences the walkthrough. CI runs and the agent-loop set this
// so automated/headless invocations never get a human-facing onboarding block.
export const ONBOARDING_ENV_FLAG = 'PINCUSHION_NO_ONBOARDING';

// Canonical Chrome Web Store install URL — single source of truth so the wizard,
// onboarding banner, and quickstart all point at the same place.
export const CHROME_INSTALL_URL = 'https://www.pincushion.io/install/chrome';
export const APP_URL = 'https://www.pincushion.io/app';

// Gate for auto-opening the one-time interactive sign-in on a fresh, signed-out
// boot (the 726-installs/mo -> 2-signups leak). Returns true ONLY when a HUMAN is
// running the server interactively in a terminal, with no license key yet.
//
// The load-bearing guard is `stdinIsTTY`: when an IDE/agent host spawns the MCP
// server it connects over a stdio *pipe*, so process.stdin.isTTY is undefined and
// this returns false — we never pop a browser at editor startup. It only fires
// for someone who literally ran `npx pincushion-mcp` in their shell to try it.
// CI/agent-loop (PINCUSHION_NO_ONBOARDING) and headless/test (PINCUSHION_NO_BROWSER)
// opt out, and a marker file makes it fire at most once per machine.
export function shouldAutoOpenSignin({ hasLicenseKey, stdinIsTTY, env = {}, markerExists } = {}) {
  if (hasLicenseKey) return false;                      // already signed in
  if (env[ONBOARDING_ENV_FLAG]) return false;           // CI / agent-loop opt-out
  if (env.PINCUSHION_NO_BROWSER === '1') return false;  // headless/testing opt-out (mirrors login.mjs)
  if (!stdinIsTTY) return false;                        // IDE-spawned over a pipe — never auto-open
  if (markerExists) return false;                       // already prompted once on this machine
  return true;
}

// True when a pin was authored by the Pincushion AI bot (any of the three
// markers the rest of the codebase keys on).
export function isBotPin(pin) {
  if (!pin) return false;
  return (
    pin.isBot === true ||
    pin.authorEmail === BOT_EMAIL ||
    pin.author === BOT_AUTHOR
  );
}

// Count the human (non-bot) pins in a parsed pins.json object, optionally
// scoped to a set/array of project IDs. pins.json has `open` and `resolved`
// arrays; a project is "activated" the moment ONE human has dropped a pin, so
// resolved pins count too.
export function countNonBotPins(pinsData, projectIds = null) {
  if (!pinsData || typeof pinsData !== 'object') return 0;
  const all = [...(pinsData.open || []), ...(pinsData.resolved || [])];
  const filter = normalizeProjectIds(projectIds);
  let count = 0;
  for (const pin of all) {
    if (isBotPin(pin)) continue;
    if (filter && pin && pin.projectId && !filter.has(pin.projectId)) continue;
    count += 1;
  }
  return count;
}

// Count active findings in the current project scope. This deliberately has
// different semantics from countNonBotPins: analytics retain the legacy
// human-first metric, while the onboarding prompt must not offer a generic
// first-pin path when an existing AI or human finding is already available to
// review. `open` is the active set in pins.json; resolved and terminal history
// do not satisfy that connection-check evidence.
//
// When a project scope is supplied, identity must match exactly. An untagged
// legacy row cannot be attributed safely to the active project, so it is not
// allowed to suppress that project's onboarding prompt.
export function countProjectFindings(pinsData, projectIds = null) {
  if (!pinsData || typeof pinsData !== 'object') return 0;
  const open = Array.isArray(pinsData.open) ? pinsData.open : [];
  const filter = normalizeExactProjectIds(projectIds);
  let count = 0;

  for (const pin of open) {
    if (!pin || typeof pin !== 'object') continue;
    if (filter) {
      const projectId = pinProjectId(pin);
      if (!projectId || !filter.has(projectId)) continue;
    }
    count += 1;
  }
  return count;
}

function normalizeExactProjectIds(projectIds) {
  if (!projectIds) return null;
  const values = projectIds instanceof Set
    ? [...projectIds]
    : Array.isArray(projectIds)
      ? projectIds
      : [projectIds];
  const ids = values.filter((value) => typeof value === 'string' && value.length > 0);
  return ids.length ? new Set(ids) : null;
}

function pinProjectId(pin) {
  if (typeof pin?.projectId === 'string' && pin.projectId.length > 0) return pin.projectId;
  if (typeof pin?.project_id === 'string' && pin.project_id.length > 0) return pin.project_id;
  return null;
}

function normalizeProjectIds(projectIds) {
  if (!projectIds) return null;
  const set = projectIds instanceof Set ? projectIds : new Set(projectIds);
  return set.size ? set : null;
}

// Read and parse .feedback/pins.json, returning a normalized shape. Missing or
// unreadable file → empty project (so a truly fresh project triggers the
// on-ramp). Never throws.
export function readLocalPins(feedbackDir) {
  try {
    const path = join(feedbackDir, 'pins.json');
    if (!existsSync(path)) return { open: [], resolved: [] };
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return {
      open: Array.isArray(data.open) ? data.open : [],
      resolved: Array.isArray(data.resolved) ? data.resolved : [],
    };
  } catch {
    return { open: [], resolved: [] };
  }
}

// Build the walkthrough block. Pure string builder so the unit test can assert
// on its four required parts without booting the server. Matches the server's
// `[startup] ...` stderr style — each line is its own console.error in the
// caller, but we return them joined for the single-block contract.
export function buildOnboardingBlock({ cloudSignedIn = true } = {}) {
  return [
    '[startup] ───────────────────────────────────────────────',
    '[startup] No active findings yet. Here is the connection check:',
    '[startup]',
    '[startup] Fastest path: run `npx pincushion-mcp setup` in a terminal (sign in + register project + explicitly choose an editor).',
    '[startup]',
    // (0) "watch it work" — the fastest aha, no setup required
    '[startup] 0. Want to SEE it first? Run /pincushion-quickstart (or call start_quickstart_demo)',
    '[startup]    — watch the agent read a pin, fix the code, and resolve it in ~60s. No account or real pins needed.',
    '[startup]',
    // (1) cloud-sync state + where pins land. A signed-out process already
    // printed "Running local-only", so never claim sync is on there.
    cloudSignedIn
      ? '[startup] 1. cloud-sync is on. Pins land in .feedback/ (pins.json + annotations/) and sync to your account.'
      : '[startup] 1. Not signed in, so pins stay local in .feedback/ (pins.json + annotations/). Run `npx -y pincushion-mcp setup` in your project folder to sign in, pick a project and connect your agent.',
    // (2) the only real connection evidence is a successful MCP read after restart.
    '[startup] 2. Restart your editor, then ask the agent to call get_actionable_pins. Config written is not an agent-connection check.',
    '[startup]      Review an existing AI or human finding, approve that exact pin, then have the agent implement it.',
    '[startup]      Need an IDE-specific manual option? Call get_setup_instructions.',
    // (3) reviewers pin from the app; nothing else needs installing.
    `[startup] 3. Teammates and clients leave pins from the Pincushion app: ${APP_URL}`,
    // (4) share-report is an optional collaboration action, never a setup gate.
    '[startup] 4. If you want another person’s review later, create_share_report can mint a link. Nobody needs to add a pin to finish setup.',
    '[startup] ───────────────────────────────────────────────',
    `[startup] (Silence this with ${ONBOARDING_ENV_FLAG}=1)`,
  ].join('\n');
}

// Build the MCP `instructions` string delivered in the initialize handshake.
//
// This is the ONE first-run surface that reaches the agent WITHOUT a tool call:
// the stderr on-ramp (buildOnboardingBlock) is swallowed by IDE/agent hosts, and
// the quickstartOfferBanner only fires once the agent already invoked a tool. A
// passive installer — who adds the server to their config and never prompts the
// agent about Pincushion — sees neither. MCP `instructions` close that gap: most
// clients (Claude Code included) surface a server's instructions to the model as
// context the moment the connection opens, so the agent learns what Pincushion is
// and how to offer the zero-setup demo before the user does anything.
//
// Kept short and high-signal because it is injected into model context for every
// session. Self-gating: the "new user / no pins" branch is phrased as guidance the
// model only acts on when it fits, and the runtime banner + tool gating still hard-
// gate activation, so an already-activated user is never nagged.
export function buildServerInstructions() {
  return [
    'Pincushion turns visual feedback into agent work packets with the selector, screenshot, DOM, thread, and acceptance criteria needed to implement and resolve a fix.',
    '',
    'Typical loop: get_actionable_pins (or implement_approved_pins) → claim_pin → make the code change → fix_and_resolve.',
    '',
    'For a new user or pinless project, offer start_quickstart_demo: a ~60-second read-pin → fix-code → resolve walkthrough with no account and no project/cloud writes.',
    '',
    'Setup: create a project in the Pincushion app (https://www.pincushion.io/app) and connect it from its Connect code tab, or run `npx pincushion-mcp setup` in the project folder to sign in, pick the project, and select an editor.',
    'After restart, call get_actionable_pins. Config alone is not connection proof: review an existing AI or human finding, approve that exact pin, then implement it.',
    'For a report-originated setup, use `npx pincushion-mcp claim <report-token>`; it resumes only after authenticated project access is confirmed.',
    '',
    'For IDE-specific setup (Cursor / Claude Code / VS Code / Windsurf), call get_setup_instructions.',
  ].join('\n');
}

// Move C — the second-human / first-pin nudge (spec: exec-loop decisions
// 2026-06-23). Fires from configured-but-zero-human-pins tool responses
// (get_actionable_pins / get_feedback_summary): the funnel data shows installers
// configure fine and then stall exactly here, so the response itself carries the
// one next step. Pure string builder; the agent relays it to the developer.
export function buildSecondHumanNudge({ projectName } = {}) {
  const name = projectName ? `"${projectName}"` : 'this project';
  return [
    `${name} is set up but nobody's dropped a pin yet.`,
    `If you want a second human's review, create_share_report can mint a read-only link for a teammate or stakeholder. They can add feedback later; it is not required to finish setup.`,
    `Do not ask someone to add a new pin only to verify setup.`,
  ].join(' ');
}

// Build the privacy-safe property bag for the once-per-startup `mcp boot`
// PostHog event. Pure (no I/O, no network): the caller passes in data it has
// already computed at startup so we never run a second Supabase query or a
// second pins.json read. Properties are deliberately PII-free — no URLs, no
// file paths, no project names, no pin contents:
//   - version:  the MCP server version (from package.json)
//   - firstRun: true when the active project(s) have ZERO human (non-bot)
//               pins — i.e. an installer who has not yet activated. This is
//               the whole point: count boots vs. configures vs. first-pins.
//   - cloudActive: true when a license key is present (cloud sync on). Derived
//               cheaply from the already-resolved distinct id / key — no call.
//   - ci / ciProvider: CI-runner classification so mirror and pipeline boots
//               can be filtered out of the funnel (measurement only).
//   - client:   the MCP host's normalized clientInfo.name, or 'unknown'.
export function buildBootEventProps({ version, nonBotPinCount, cloudActive, ci, ciProvider, client } = {}) {
  // Coerce a missing/NaN count to 0 so an unknown pin count safely reads as
  // firstRun:true (an installer we can't prove has activated yet) rather than
  // silently flipping to false.
  const count = Number(nonBotPinCount);
  return {
    version: version || '0.0.0',
    firstRun: !Number.isFinite(count) || count <= 0,
    cloudActive: Boolean(cloudActive),
    ci: Boolean(ci),
    ciProvider: ci ? (ciProvider || 'generic') : null,
    client: client || 'unknown',
  };
}

// Decide whether to print, and print if so. Returns the block string that was
// printed (or null when suppressed) so tests can assert behavior without
// capturing stderr. Suppressed when:
//   - the env flag is set (CI / agent-loop), OR
//   - the active project(s) already have >= 1 active finding (AI or human).
//
// `opts.env` defaults to process.env; `opts.log` defaults to console.error so
// the block prints to stderr exactly like the rest of startup logging.
export function maybePrintOnboarding(feedbackDir, projectIds = null, opts = {}) {
  const env = opts.env || process.env;
  const log = opts.log || console.error;

  if (env[ONBOARDING_ENV_FLAG]) return null; // CI / agent-loop opt-out

  const pinsData = opts.pinsData || readLocalPins(feedbackDir);
  const findings = countProjectFindings(pinsData, projectIds);
  if (findings > 0) return null; // an existing finding gives the developer a real next step

  const block = buildOnboardingBlock({ cloudSignedIn: opts.cloudSignedIn !== false });
  log(block);
  return block;
}
