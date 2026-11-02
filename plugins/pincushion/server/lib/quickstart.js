// lib/quickstart.js — the 60-second first-run demo loop.
//
// CRITICAL: this is 100% EPHEMERAL. It must NEVER write to .feedback/annotations/,
// push to the cloud, or fire the activation funnel events (`pin resolved`, first-pin).
// A persisted/synced demo pin would corrupt countNonBotPins()/firstRun and leak into the
// user's real metrics, summary, dashboard, and share reports. The ONLY disk footprint is a
// throwaway editable COPY of the demo page under .feedback/.quickstart/ (already gitignored),
// which is wiped on teardown. Pins below exist only in-memory in the tool response.

import { join, resolve, sep } from 'path';

export const DEMO_FILE_REL = 'demo/landing.html';          // pristine template, never edited
export const QUICKSTART_DIR_REL = join('.feedback', '.quickstart');
export const DEMO_COPY_NAME = 'landing.html';              // the editable copy the agent fixes

// The three deliberate flaws in demo/landing.html, as stakeholder feedback pins.
// Default to 1 pin (the CTA) for the ~60s target; the other two are an optional teaser.
const DEMO_PINS = [
  {
    id: 'ann_demo_cta',
    selector: '#cta-primary',
    tagName: 'button',
    textContent: 'Sumbit',
    author: 'Maya (Design)',
    comment: "This primary button says \"Sumbit\" — and the grey-on-white text is basically invisible. Fix the typo and make it readable.",
    acceptanceCriteria: 'Button label reads "Submit" and its text has clear contrast against the background.',
  },
  {
    id: 'ann_demo_hero',
    selector: '.hero-title',
    tagName: 'h1',
    textContent: 'Welcom to Acme',
    author: 'Sam (PM)',
    comment: "\"Welcom\" is misspelled in the hero headline — it's the first thing every visitor reads.",
    acceptanceCriteria: 'Hero headline reads "Welcome to Acme".',
  },
  {
    id: 'ann_demo_nav',
    selector: '.nav-link',
    tagName: 'a',
    textContent: 'Pricing',
    author: 'Maya (Design)',
    comment: 'The nav links are 9px — illegible, especially on mobile. Bump them up.',
    acceptanceCriteria: 'Nav links are at least 14px.',
  },
];

// Build the implement-packet-shaped payload the agent acts on. `demoCopyRel` is the
// project-relative path to the editable copy (e.g. .feedback/.quickstart/landing.html).
export function buildDemoPackets({ demoCopyRel = join(QUICKSTART_DIR_REL, DEMO_COPY_NAME), full = false } = {}) {
  const pins = (full ? DEMO_PINS : DEMO_PINS.slice(0, 1)).map((p) => ({
    annotationId: p.id,
    status: 'approved',
    element: { selector: p.selector, tagName: p.tagName, textContent: p.textContent },
    thread: [{ author: p.author, body: p.comment }],
    acceptanceCriteria: p.acceptanceCriteria,
    likelyFiles: [demoCopyRel],
  }));
  return {
    demo: true,
    totalActionable: pins.length,
    moreAvailable: full ? 0 : DEMO_PINS.length - 1,
    page: {
      pageTitle: 'Acme — demo',
      file: demoCopyRel,
      suggestedBranch: 'pincushion/quickstart-demo',
      selectors: pins.map((p) => p.element.selector),
      pins,
    },
    instructions: [
      `This is the Pincushion quickstart demo. Treat the pin(s) below as stakeholder feedback on a sample page that has been copied to ${demoCopyRel} (a throwaway file — editing it touches NOTHING in the real project).`,
      `1. Read the pin's thread + acceptance criteria.`,
      `2. grep ${demoCopyRel} for the element selector, then edit ONLY that file to satisfy the acceptance criteria.`,
      `3. Show the user the diff.`,
      `4. Call resolve_quickstart_demo with the annotationId + a one-line fixDescription.`,
      `Do NOT create real pins, call fix_and_resolve, or touch any other file — this is a sandboxed demo.`,
    ],
  };
}

// Guard: an edit is a valid demo edit only if it resolves INSIDE the project's
// .feedback/.quickstart/ working dir. Prevents the demo from "celebrating" a real-file edit.
export function isDemoEdit(filePath, quickstartAbsDir) {
  if (!filePath) return false;
  const abs = resolve(filePath);
  const dir = resolve(quickstartAbsDir);
  return abs === dir || abs.startsWith(dir + sep);
}

// The prod widget-feedback endpoint — the origin-bound public path that accepts
// { projectId, pageUrl, pageTitle, name, email, comment } and opens a real pin.
// Mirrors the supabaseBase default in lib/core.js; override via opts.endpoint.
export const WIDGET_ENDPOINT = 'https://dpsqzszdviltqvethxbr.supabase.co/functions/v1/widget-feedback';

// Build a self-contained, paste-able feedback widget the user can drop into their
// own app to capture a REAL pin with no browser extension and no account. This is
// the "realize value without the extension" path: lower fidelity than the
// extension (no selector/screenshot), but it writes a genuine pin to the project,
// so it sidesteps the extension-activation cliff entirely for a first real pin.
//
// The server only accepts posts whose origin matches the project's registered
// URLs (configure_project registers them), so the snippet is inert until the
// project is configured — which is exactly when we hand it over.
export function buildWidgetSnippet({ projectId, endpoint = WIDGET_ENDPOINT } = {}) {
  const pid = projectId || 'YOUR_PROJECT_ID';
  return [
    '<!-- Pincushion feedback widget — drop a real pin from your own page, no extension. -->',
    '<script>',
    '(function () {',
    `  var PROJECT_ID = ${JSON.stringify(pid)};`,
    `  var ENDPOINT = ${JSON.stringify(endpoint)};`,
    "  var btn = document.createElement('button');",
    "  btn.textContent = '💬 Feedback';",
    "  btn.setAttribute('style', 'position:fixed;right:16px;bottom:16px;z-index:2147483647;padding:10px 14px;border:0;border-radius:999px;background:#171717;color:#fff;font:14px -apple-system,system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.2)');",
    '  btn.onclick = function () {',
    "    var comment = window.prompt('What needs fixing on this page?');",
    '    if (!comment) return;',
    "    var name = window.prompt('Your name (optional)') || '';",
    "    var email = window.prompt('Your email (optional)') || '';",
    "    fetch(ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/json' },",
    '      body: JSON.stringify({ projectId: PROJECT_ID, pageUrl: location.href, pageTitle: document.title, name: name, email: email, comment: comment }) })',
    "      .then(function (r) { return r.json(); })",
    "      .then(function () { btn.textContent = '✓ Sent'; setTimeout(function () { btn.textContent = '💬 Feedback'; }, 1600); })",
    "      .catch(function () { window.alert('Could not send feedback — is this URL registered in Pincushion?'); });",
    '  };',
    "  document.addEventListener('DOMContentLoaded', function () { document.body.appendChild(btn); });",
    '})();',
    '</script>',
  ].join('\n');
}

// One-line nudge surfaced on first run (stderr + first-tool banner + get_setup_instructions).
export function buildQuickstartInvitation() {
  return 'New to Pincushion? Run start_quickstart_demo (or /pincushion-quickstart) to watch the full read-pin -> fix-code -> resolve loop on a bundled sample page in ~60s. No extension or real pins needed; nothing is written to your project or the cloud.';
}

// Local-only (no account) first run. Someone who added the server from a
// directory listing has no project yet, so every response points at ONE
// command that signs in, creates or picks a project and connects this agent.
// `--ref mcp-local` is the setup attribution slug; nothing new leaves the
// machine until the user runs it.
export const MCP_LOCAL_SETUP_COMMAND = 'npx -y pincushion-mcp setup --ref mcp-local';
export const MCP_LOCAL_CRIT_URL = 'https://www.pincushion.io/crit?ref=mcp-local';

// Short enough for an agent to paste to the user verbatim.
export function buildLocalOnlyBanner() {
  return [
    '⚠ Pincushion is running local-only (not signed in): only pins in this repo\'s .feedback/ are visible.',
    `Connect a real project with one command: ${MCP_LOCAL_SETUP_COMMAND}`,
    `Or get a free AI crit of any page: ${MCP_LOCAL_CRIT_URL}`,
  ].join('\n');
}

// Attached to an empty local-only read (get_actionable_pins, get_annotations,
// get_feedback_summary) so the first exchange still shows what a pin looks
// like. In-memory only — the sample is never written to .feedback/annotations/
// or counted anywhere; the real result fields are left untouched.
export function buildLocalOnlySample() {
  const p = DEMO_PINS[0];
  return {
    sample: true,
    notice: 'No pins in this workspace yet. Below is a SAMPLE pin from the bundled demo page — it is not from your project.',
    pin: {
      annotationId: p.id,
      pageTitle: 'Acme — demo',
      element: { selector: p.selector, tagName: p.tagName, textContent: p.textContent },
      thread: [{ author: p.author, body: p.comment }],
      acceptanceCriteria: p.acceptanceCriteria,
    },
    tryIt: 'Call start_quickstart_demo to fix this sample pin on a throwaway copy of the demo page (~60s, nothing written to your project or the cloud).',
    nextStep: `To see real pins from your own app, run: ${MCP_LOCAL_SETUP_COMMAND}`,
    freeCrit: MCP_LOCAL_CRIT_URL,
  };
}

// True when a read tool's result has nothing for the user to act on.
export function isEmptyPinRead(result) {
  if (!result || typeof result !== 'object' || Array.isArray(result) || result.error) return false;
  if (typeof result.totalActionable === 'number') return result.totalActionable === 0;
  if (result.summary && typeof result.summary.totalAnnotations === 'number') return result.summary.totalAnnotations === 0;
  if (Array.isArray(result.pages)) return result.pages.length === 0;
  // get_annotations answers a no-match read with a message, not an empty list.
  if (typeof result.message === 'string') return result.message.startsWith('No annotations found');
  return false;
}

// The celebratory close + the single best bridge to real usage.
export function buildDemoResolvedPayload({ fixDescription = '', diff = '', storeUrl, projectId, localOnly = false } = {}) {
  if (localOnly) {
    // No account yet: one command, not the signed-in checklist below.
    return {
      success: true,
      demoComplete: true,
      message: 'The demo is complete: you read a sample pin and fixed its demo page. Nothing was written to your project or the cloud.',
      fixDescription,
      diff: diff || undefined,
      nextStep: {
        headline: 'Now do it on YOUR app — run this one command:',
        command: MCP_LOCAL_SETUP_COMMAND,
        what: 'Signs you in (free), creates or picks a project, and connects this agent. Then pins from your app show up here.',
        freeCrit: `Or get a free AI crit of any page first: ${MCP_LOCAL_CRIT_URL}`,
      },
    };
  }
  return {
    success: true,
    demoComplete: true,
    message: "The demo is complete: you read a sample finding and changed its demo page. Your project's approval, exact-pin read, implementation, and deployment remain separate milestones.",
    fixDescription,
    diff: diff || undefined,
    nextStep: {
      headline: 'Now do it on YOUR app:',
      step1: 'Have a critique report? Run `npx pincushion-mcp claim <report-token>` in its repository. Starting without a report? Run `npx pincushion-mcp setup` and explicitly choose your editor.',
      step2: `Confirm authenticated access to the intended project after restarting your editor if needed. The browser extension is optional for new feedback: ${storeUrl || 'https://www.pincushion.io/install/chrome'}`,
      step3: 'Explicitly approve one existing AI or human finding, ask your agent to read that exact pin, then implement it. Record deployment and verification separately.',
      activationTip: 'If you choose the optional extension, sign in with the same Google account used for Pincushion. Extension installation is not an activation milestone.',
      oneCommandSetup: 'Without a report, run `npx pincushion-mcp setup` in the intended repository. Select your editor; supported configuration preserves unrelated settings. Others receive a manual path. Configuration written does not prove project access or an exact-pin read.',
      // Extension-free path: a paste-able widget that writes a REAL pin straight
      // from the page. Skips the activation cliff for a first real pin.
      noExtensionTip: projectId
        ? `Reviewers can leave feedback on the canonical report for project ${projectId} without installing anything. The optional widget snippet below is for an owner-approved embedding, not a required onboarding step:`
        : 'Reviewers can use the canonical report without an extension. The optional widget snippet requires an owner-approved embedding and a verified project from configure_project; replace YOUR_PROJECT_ID before use:',
      widgetSnippet: buildWidgetSnippet({ projectId: projectId || null }),
    },
  };
}
