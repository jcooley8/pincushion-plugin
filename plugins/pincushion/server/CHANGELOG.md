# Changelog

All notable changes to `pincushion-mcp` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

## [Unreleased]

## [1.12.5] — 2026-11-01

### Fixed

- The official MCP registry entry's `repository.url` points at the public `jcooley8/pincushion-plugin` repository again. It pointed at the private monorepo (404 publicly), so directories such as MCP Index listed the server as dead. Preflight and a test now fail if it points anywhere else.

### Changed

- `setup` without an interactive terminal prints copy-paste manual steps (`login`, then `claude mcp add` / `.cursor/mcp.json` / `codex mcp add`) instead of telling you to run `setup` again. `claim_pin` and `fix_and_resolve` in local-only mode now say to run `login`.
- Telemetry is off for test runs: a test runner in the environment (`node --test`, jest, vitest, `NODE_ENV=test`, `PINCUSHION_TEST_HARNESS=1`) or a sync URL pointed at a loopback mock. A loopback `POSTHOG_HOST` keeps it on, for telemetry tests. Test suites no longer send events to the production PostHog project.
- `pincushion login` marks internal and test accounts (`$internal_or_test_user`, `is_internal`) on the PostHog person, from the shared internal-account list (`lib/internal-accounts.js`, generated).
- A login started from an editor plugin (`PINCUSHION_ENTRY=plugin`, or Claude Code's `CLAUDE_PLUGIN_ROOT`) adds `entry=plugin` to the sign-in URL, so the new account's signup is recorded as `plugin` rather than `cli`. Sign-in itself is unchanged.

## [1.12.4] — 2026-10-20

### Fixed

- Node.js 25, 26 and later are no longer turned away. `setup`, `login` and the stdio server now refuse only releases older than Node.js 22.22, which still get the existing upgrade message. The declared `engines` window, which CI verifies, stays at Node.js 22.22+ or 24, so npm may print an engines advisory on newer releases. That advisory is a warning, not a block.

## [1.12.3] — 2026-10-15

### Security

- **GHSA-9c4v / Corvus CS12-F01 (OWASP MCP09).** Tool results and the `pincushion://feedback` / `pincushion://approved-queue` resources now wrap their payloads in an explicit `<pincushion-data>` fence with a notice that pin threads, element text, and project critique fields (`brandContext`, `critiqueContext`, `critiquePolicy`) are third-party data, not instructions. Invisible/bidi/tag-control characters and attempts to close the fence are neutralized before serialization. Pending-approval notifications (which embed page titles and comments) are fenced the same way; count-only AI banners stay in the trusted prefix. `agent-loop` reuses the sanitizer and refuses to interpolate an annotation id into trusted Steps unless it matches `^[A-Za-z0-9_-]{1,128}$`. Does not change stored project data.
- CI: MCP-only PRs no longer trip the UX evidence gate
- Tests that consume CallTool JSON use `parseFencedToolJson` / `parseToolResultContent` so fenced payloads remain machine-readable. (`select-validation`), so validate can run `npm test` without a reviewed screenshot/transcript manifest for server/prompt security fixes.

## [1.12.2] — 2026-10-12

### Fixed

- Capture visual fingerprints under sites that restrict `connect-src`, so desktop and mobile Crit evidence and positioned pins can complete without a page-context fetch.
- On an unsupported Node.js, `setup`, `login`, and the stdio MCP server now exit with a short message naming the supported versions (Node.js 22.22+ or Node.js 24), the `nvm install 22 && nvm use 22` upgrade command, and https://nodejs.org, instead of failing partway or with a stack trace. In stdio mode the message goes to stderr only.

## [1.12.1] — 2026-10-07

### Fixed

- Reject non-string MCP tool inputs before string operations, avoiding runtime failures on malformed arguments.


## [1.12.0] — 2026-10-04

### Added

- `setup` lists the projects your account can connect (including ones created in the Pincushion app) and binds the one you pick; `setup --project-id <id>` binds that project without questions and never adds detected local URLs to it. Setup succeeds once your coding agent is connected; the first AI critique is an optional follow-up.
- `--help` and `--version` print usage or the version instead of starting the server.
- `remote-url --embed-key` prints the tokenized hosted URL for clients that accept only a URL.

### Changed

- First-run guidance (startup on-ramp, MCP initialize instructions, `get_setup_instructions`) leads with the Pincushion app and its Connect code tab; the browser extension is no longer a setup step.
- `remote-url` prints the key-free hosted URL by default, with instructions to send the key as an `Authorization` header.
- `create_invite_link` works on every plan; the server still enforces roles and editor seats. A signed-out call explains how to sign in.

### Fixed

- Pin IDs from the cloud can no longer name agent-queue files outside `.feedback/.agent-queue/` (a crafted ID such as `../../package` could delete or overwrite project files).
- `login` receives the account key in a POST body instead of the callback URL, keeping it out of browser history; older sign-in pages still work.
- Setup no longer guesses a `<package>.vercel.app` or `.netlify.app` URL.
- A signed-out start no longer says cloud sync is on.

## [1.11.27] — 2026-10-01

### Added

- Continue guided setup through the explicitly selected installed coding client to a real same-project critique, independently verified report receipt, and browser launch. Sign-in, project trust, tool permissions, cloud uploads and report access remain explicit.
- Install locked project-local runtime dependencies without install scripts, preserve unrelated editor settings and conflicting assets, and retain run IDs and exact payloads for interrupted or uncertain writes.

### Fixed

- Reject annotation acknowledgments whose persisted visibility differs from the requested visibility; preserve accepted IDs and stop before uploads or report generation on a mismatch.
- Report blocked or unknown claim status truthfully instead of treating it as an already-claimed success.
- Preserve the actual MCPB license bytes and include the server's existing claim/login module dependencies; exclude the test-only safe-error contract fixture.

### Validation limits

- Live critique/report/browser acceptance covers a recovered macOS Codex CLI 0.156.0 / Node 24 run with existing authentication and members-only fictional data. Fresh registry acceptance and other client model access are separate checks; no fixed finding count, complete site coverage, or universal reliability is promised.

## [1.11.25] — 2026-09-28

- Authenticate secondary MCP sessions with a bounded projects-only probe before returning cloud project context or authorizing project-scoped writes, without waiting for annotation bootstrap.
- Configure Codex in a project-local `config.toml` during setup, pin acknowledged project identity, and use noninteractive `npx -y` entries across supported editors.

## [1.11.24] — 2026-09-27

### Added

- Add `--no-auto-register-project` for integrations that require explicit
  confirmation before registering a newly discovered project. Authenticated
  cloud pulls, matching existing projects and manual `configure_project` remain
  available.

### Changed

- Recognize an explicitly requested Grok Build Pincushion Crit command as a
  valid Pincushion AI pin workflow.

## [1.11.23] — 2026-09-12

### Fixed

- Use context-bound, single-use extension handoffs for MCP-to-Chrome sign-in, with exact project and browser-origin checks during redemption.


## [1.11.21] — 2026-09-11

### Changed

- Centralize MCP and local REST tool dispatch in one immutable registry while
  preserving nullable and omitted REST argument compatibility.
- Extend surface synchronization checks to validate registry entries so new
  tools cannot drift between advertised and callable transports.

## [1.11.20] — 2026-09-10

### Added

- Commit-ordered cloud annotation journal replay with signed, account-scoped
  cursors, bounded event hydration, and crash-safe local cursor persistence.
- Journal projections retain safe implementation and verification metadata while
  keeping account credentials, tenancy fields, and storage paths private.

### Fixed

- Incremental MCP sync applies boundary hydration after ordered message deltas,
  so creates and message edits/deletes cannot lose or rewind thread state.

## [1.11.19] — 2026-09-10

Version 1.11.18 was not published. Its cache-isolation fix is included in this
cumulative release.

### Added

- **Private agency coordination pilot.** Add owner/editor-only internal notes,
  project labels, authenticated review activity, combined pin filters, and
  bounded provenance-aware exports. These tools stay separate from public pin
  threads, widgets, reports, attachments, search, and notifications, and remain
  off until the project owner enables the pilot.
- **Bounded QA ingestion pilot.** `import_qa_results` accepts already-parsed axe
  or Playwright results, creates deterministic agent pins for failed findings,
  and deduplicates by project, canonical page, device, rule, and target. Passing,
  skipped, and inconclusive observations cannot close work or establish trusted
  verification.

### Changed

- **Version-bound implementation packets.** Approved-pin packets carry the
  applicable frozen client-review decision and structured copy replacement,
  with revision-aware source revalidation when the original text has changed.

### Fixed

- MCP tool failures now return stable, diagnostic-free error objects with an
  opaque request ID; exception messages, stacks, local paths, and provider
  details no longer cross the protocol boundary. Ambiguous write failures are
  marked non-retryable so callers reconcile them instead of resending blindly.
- Deployment frame capture keeps its owned timeout and termination timers
  live until the child settles, so supported Node 22 and Node 24 runtimes
  report bounded child failures consistently.
- **Native Crit capture compatibility.** Resolve browser targets through the
  bounded operating-system DNS path while classifying every returned address,
  and allow only navigation requests with a proven parent frame to use their
  nested-frame origin. This restores legitimate multi-address and iframe
  captures without weakening the top-level origin or private-network guards.
- Scope annotation cache entries by project and exact page URL so a cached
  response from one project cannot satisfy a request for another project.

## [1.11.6] — 2026-08-03

### Added

- **Deployment reconciliation receipts.** `get_pending_critiques` now carries
  additive deployment metadata, project-page inventory, terminal page results,
  and latest per-device immutable capture receipts. Local agents can probe and
  fingerprint pages before Crit, register the exact bounded discovery inventory,
  stage only accepted-pending exact desktop/mobile captures with a deployment
  ID, and record terminal page outcomes through
  `record_deployment_page_result`; the backend atomically promotes the capture
  report only when reconciliation is terminal. Exact result retries surface an
  idempotent receipt instead of creating another promotion.
- **Persistent-change capture mode.** `capture-snapshot.mjs --reconcile` keeps
  auth local and origin-bound, combines rendered-link recursion with
  robots/nested-sitemap discovery, probes inventory directly, and compares two
  settled captures using bounded semantic plus decoded-pixel tile fingerprints.
  It does not turn missing links, login pages, or unstable pixels into a change,
  and zero-change runs create no JPEG files. A prior committed capture that
  predates v1 fingerprints bootstraps a new desktop/mobile baseline as an
  `updated` result when current evidence is valid, rather than remaining
  inconclusive forever.

### Changed

- **One deploy checkpoint across agent surfaces.** `/snapshot-latest-deploy` is
  now a compatibility alias for the reconciliation-first
  `/critique-latest-deploy` sequence. A Crit receipt remains immutable and
  separate; queue completion cannot happen before the committed reconciliation
  receipt and any eligible Crit receipt.

### Fixed

- **Truthful Vercel deployment wiring.** `configure_project` now explains that
  Vercel Deploy Hooks trigger builds rather than send notifications. It returns
  the outbound `deployment.promoted` Team Webhooks/CLI path for Pro/Enterprise
  and a fail-closed CI curl fallback for other plans. Every generic notification
  now requires a stable per-deployment `idempotency_key`; GitHub Actions uses
  its real repository/run/attempt deployment identity, so same-SHA redeploys
  remain distinct while retries remain idempotent. The response states that
  Pincushion did not install a provider webhook or modify CI.
- **Fail-closed authenticated capture.** A supplied or required local browser
  state must now be a secure regular, origin-bound state that proves an auth
  credential; malformed/unsafe state, 401/403, auth redirects, and signed-out
  shells stop before fingerprinting or capture staging. Receipts explicitly
  report authenticated versus anonymous mode, while public capture remains
  available without auth state.
- **Authenticated capture proof and network guard.** Capture now passes the
  already securely opened/parsed state object to Playwright rather than a
  pathname. `snapshot --login` requires an origin-bound, owner-only signed-in
  proof selector sidecar; absent or non-visible proof (including a neutral 200
  signed-out shell) exits 6 before a fingerprint is eligible. Initial targets
  and redirect hops receive bounded DNS checks and reject private/reserved IPv4
  and IPv6 destinations before browser navigation. Receipts never expose state,
  cookies, proof selectors, or resolved addresses.

## [1.11.5] — 2026-07-31

### Fixed

- **Truthful Crit reports.** `generate_critique_report` now treats a Crit as a completed critic run, requiring one shared run ID, the exact Pincushion AI pin IDs, and their read-back immutable capture positions before it can mint or persist a public report. A Crit link is bound to that one verified receipt rather than the project’s latest capture; supplied/foreign report URLs are refused. Capture-only reports remain available when explicitly requested.
- **Crit provenance across MCP clients.** Local and hosted `create_critique_pin` calls require the shared run ID and write its `critique-run:<id>` tag automatically, so a reporter cannot claim unrelated bot pins as part of a Crit.
- **Reliable Live report preview.** The report CSP now permits only the exact HTTPS origins captured in the report data, restoring the Live iframe without widening frame access. Zero-pin capture reports clearly state that a Crit has not been run and retain a truthful mobile preview.

## [1.11.4] — 2026-07-29

### Added

- **`/invite` for critique reviewers.** Agents can prepare a capped, case-insensitively deduplicated batch of up to 25 individualized invitations to a public critique report. The workflow can mint a report when needed, never grants project access implicitly, and requires explicit confirmation before any delivery action.

## [1.11.2] — 2026-07-27

### Fixed

- **Query-variant AI findings.** Prevent repeated Pincushion AI and third-party agent pins when the same finding differs only by URL query values. Human feedback remains unaffected.

## [1.11.1] — 2026-07-10

### Fixed

- **Contextual share-report captures.** Snapshot capture now ignores hidden, zero-size, and off-canvas selector matches; chooses a rendered duplicate when available; records each matched element's rectangle as a selector hotspot; and can require every critique pin to resolve before a public report is minted. This prevents the old `(0,0)` marker failure and lets Grid/Flow reports outline the exact element behind a pin.

## [1.11.0] — 2026-07-09

### Added

- **One-command claim.** `npx pincushion-mcp claim <token>` is now self-sufficient: with no license key present it runs the browser sign-in inline (interactive terminals only — headless callers still fail fast), and after a successful claim it registers the Pincushion MCP entry in your editor's project-local config (best-effort; only inside a real project directory — never in `$HOME` or other non-project dirs, and never a global editor config). The crit-report claim panel now shows this single command instead of three steps.
- **Authed captures: `snapshot --login <url>`.** New subcommand opens a real browser, you sign in to your app, and the session (Playwright storageState) saves to `~/.pincushion/auth/<domain>.json` (0600, never leaves your machine). `scripts/capture-snapshot.mjs` reuses it via `PINCUSHION_STORAGE_STATE`, so crit-wall snapshots and `/snapshot-latest-deploy` render pages behind login; a missing or corrupt session file falls back to anonymous capture with a printed note.
- **`/snapshot-latest-deploy` — auto-snapshot after deploy (Pro/Team).** A customer-scheduled headless routine that captures a fresh full-page "after" image of each deployed page so the share report's History timeline gains a real before/after on every ship. Ships the capture helper `pincushion-mcp/scripts/capture-snapshot.mjs` — surface-agnostic: it finds a headless Chrome/Chromium from env/system/managed/cloud sources and self-provisions Playwright (best-effort a browser) on any Node environment (Claude Code, Cursor, Codex, CLI, CI), falling back to the surface's own browser tooling or the manual recipe if none is reachable. Reuses `get_pending_critiques` → `get_annotations` → `upload_page_snapshot`. Runs under the customer's own license (no new auth surface), idempotently skips a page whose "after" already exists, and never completes the critique queue row so it coexists with `/critique-latest-deploy`. `get_pending_critiques` now also returns `latestSnapshotAt` per page (read-only enrichment) to drive that idempotency. Pro/Team-gated (the queue that drives it is); free-tier captures manually via the `page-snapshot-capture` recipe. Schedule it via `/setup-routines`.

### Fixed

- `claim` no longer prints "Connected Pincushion to your editor" when the config write was skipped or failed — only a real write (created/updated) claims success.

## [1.8.0] — 2026-07-02

### Added

- **`mobile-wall` agent handoff manifest.** Each build now writes `crit-wall/wall/agent-context.json` alongside `hotspots.json`, including screen selectors, image dimensions, hotspot selectors, and accessibility labels. Zero-install wall pins prefix comments with `[Screen: ...] [Element: ...]`, and the generated page exposes copyable handoff commands so a mobile critique report can become an MCP implementation packet instead of a screenshot-only review.
- **`mobile-wall` reusable work packet.** Builds now also emit `agent-work-packet.json` and `agent-work-packet.md`, folding in `wall.plan.json` provenance, native source hints from `wall.config.json`, per-hotspot `rg` searches, screenshot-only warnings, and app-repo implementation rules. This makes the OpenClaw pilot workflow reusable for future mobile design critiques where the implementing agent needs contextual native-source data, not only a visual report. Suggested `rg` commands single-quote every argument and use `-F` (literal) so accessibility labels drawn from the app under critique — including ones containing shell metacharacters — stay inert when pasted, and the packet records project-relative reproduce paths so it travels to the app-repo PR intact.
- **`mobile-wall publish` — post-merge public report refresh.** Adds a CI/agent path for public native critiques after the app PR merges: rerun the headless capture plan, rebuild/deploy the static wall, fetch cloud pins, recompute marker positions from the refreshed snapshot mapping and AX hotspots, upload the latest report snapshot, and optionally resolve implemented pins / link deploy URLs / record verification. This replaces the browser-extension sync loop for mobile-wall review days. Marker recomputation resolves each pin by `[Screen:]`/`[Element:]` thread context first, then falls back to the pin's element selector (`#ax-<screen>-<id>` → hotspot center, `#screen-<slug> img` → screen center) so MCP-seeded pins that carry a selector but no click coordinates keep their report markers; pins that resolve to nothing are dropped rather than mispositioned. `publish` honors `PINCUSHION_SYNC_URL`, rejects PNG page snapshots client-side (the report requires JPEG/WebP), and exits non-zero when a requested pin update fails or when cloud writes were requested but unavailable — so CI never reports a partial refresh as success.

## [1.7.0] — 2026-07-02

### Added

- **`mobile-wall` subcommand — mobile app crit walls.** `npx pincushion-mcp mobile-wall capture <name>` grabs a screenshot + accessibility hierarchy from a booted iOS simulator (maestro or idb backend, auto-detected); `mobile-wall build` generates a static, brandable crit-wall page (`crit-wall/wall/index.html`) with **semantic hotspot overlays** — each labeled accessibility element becomes a positioned `data-ax` region, so pins anchor to real element labels ("Send message") instead of raw pixels, and the implementing agent can grep the app source for the element. Branding, captions, and the optional zero-install click-to-pin flow (once the wall is deployed + registered via `configure_project`) live in an editable, rebuild-safe `wall.config.json`. Productizes the one-off wall built for the OpenClaw iOS crit; Android (adb) not supported yet. This is Pincushion's first native-mobile surface — previously web-only.
- **`mobile-wall run` — fully headless capture (CI-able).** A declarative `wall.plan.json` (scaffolded on first run) names the app (`bundleId`, optional `appPath` to install, optional `boot` device to cold-boot a simulator with no Simulator.app window) and each screen's maestro navigation — steps as JSON (valid YAML verbatim) or a hand-authored `flow` file. One command boots/installs/launches, drives every screen, captures screenshot + AX hierarchy, and builds the wall — no human at the simulator. Generated flows persist under `crit-wall/flows/` so a failing step is replayable with `maestro test`; navigation failures name the screen and the replay command. maestro's JVM is auto-resolved (`/usr/libexec/java_home`, then keg-only Homebrew JDKs) so headless shells and CI work without `JAVA_HOME` exported, with an actionable hint when no JVM exists at all.

## [1.6.1] — 2026-07-02

### Fixed

- **MCP registry listing un-stuck (`b6`).** Every registry publish since 1.3.1 was silently failing with a 422: the official registry caps `server.json` `description` at 100 characters and ours was 142. Shortened the description; the registry now tracks npm again. npm releases were never affected.

## [1.6.0] — 2026-07-02

### Added

- **Second-human / first-pin nudge (activation).** When a project is configured but has zero human (non-bot) pins, `get_actionable_pins` and `get_feedback_summary` responses carry one additive `firstPinNudge` field pointing at the single next step: mint a read-only share link with `create_share_report` and hand it to a teammate/stakeholder so a second human drops pin #1. Fires at most once per server process, never once the project has a real pin, and respects `PINCUSHION_NO_ONBOARDING` (CI/agent-loop stay quiet). Funnel data motivated this precisely: installers boot and configure fine, then stall completely at the first human pin.
- **`npx pincushion-mcp setup` — frictionless first-run wizard (#64).** One command signs you in (browser OAuth), registers the project (name + local/live URLs), writes the editor MCP config (Cursor / Claude Code / VS Code / Windsurf), and opens the Chrome-extension install page. Atomic config writes with cleanup on failure; fully skippable per step. The MCP `initialize` handshake now also carries server `instructions`, so a passive installer's agent learns what Pincushion is (and can offer the zero-setup quickstart demo) without any tool call.

## [1.5.2] — 2026-06-26

### Fixed

- **`pincushion login` no longer fails silently on an OAuth origin error.** The cli-login page now registers a Google Identity Services `error_callback`, so an unregistered-JavaScript-origin rejection (`invalid_client` / "no registered origin") is surfaced on the page and in the console instead of leaving the sign-in popup to close with no explanation. The CLI also opens the canonical `https://www.pincushion.io/cli-login` directly — `pincushion.io` 307-redirects to `www`, and `www` is the origin Google validates against the OAuth client's Authorized JavaScript origins, so opening it up front avoids the redirect hop. (The underlying origin allowlist was fixed in Google Cloud Console on 2026-06-25; this change makes any future recurrence loud rather than silent.)

## [1.4.1] — 2026-06-21

### Fixed

- **`mcp boot` events now actually reach PostHog.** The startup `mcp boot` event (added in 1.3.9) was being silently dropped: it is the *first* analytics event in the process, so it fired before the lazily-imported `posthog-node` client finished loading, and was discarded. As a result no `mcp boot` events were ever recorded, leaving the install→first-pin funnel blind at the top. Events captured before the client loads are now buffered and flushed once it's ready. Privacy and opt-out are unchanged (`PINCUSHION_NO_TELEMETRY` / `DO_NOT_TRACK` still short-circuit before anything is buffered; `distinctId` stays a SHA-256 hash of the license key).

## [1.3.9] — 2026-06-14

### Added

- **`mcp boot` event (funnel top).** The server fires one fire-and-forget PostHog `mcp boot` event per startup, with a `firstRun` flag (zero non-bot pins) and `version` — and nothing else (no PII, URLs, or paths). This makes the *install→first-pin* collapse measurable: until now no event fired at startup, so developers who ran the MCP but never configured a project or dropped a pin were invisible. Same opt-out as all telemetry (`PINCUSHION_NO_TELEMETRY` / `DO_NOT_TRACK`).

## [1.3.8] — 2026-06-14

### Fixed

- **Crash-proof analytics load + clean exit on transport close.** Hardened the PostHog client so a failure loading `posthog-node` can never crash the server, and the server exits cleanly when the host closes the stdio transport (flushing telemetry first).

## [1.3.7] — 2026-06-14

### Added

- **Product analytics (PostHog, opt-out).** The server now captures product *events* across the pin lifecycle (approved / claimed / resolved / assigned), AI feature usage (critique pin/run, bot reply), and activation/team signals (`project configured`, `member added`, `implement session started`) so we can see the install→activation→implementation funnel. **Privacy:** events only — never code, pin bodies, URLs, emails, or file contents; application errors continue to go to Sentry, not PostHog. The `distinctId` is a **SHA-256 hash of the license key** (the raw key is never sent). Opt out entirely with `PINCUSHION_NO_TELEMETRY=1` or the standard `DO_NOT_TRACK=1`. The embedded PostHog key is a public, write-only project key (overridable via `POSTHOG_API_KEY`), exactly like the Sentry DSN already shipped. Telemetry is fully fail-safe — it never blocks or breaks a tool call, and flushes on shutdown.

## [1.3.6] — 2026-06-14

### Added

- **First-run on-ramp.** On startup, when the active project has zero human (non-bot) pins, the server prints a short first-pin walkthrough to stderr — install the Chrome extension, drop a first pin, call `get_setup_instructions`, and mint a `create_share_report` link to get a second human looking at the work. Gated by a no-pins check (never fires once a human pin exists; Pincushion AI's own critique pins don't count) and silenced by `PINCUSHION_NO_ONBOARDING=1` for CI / agent-loop runs. Prints only — it never writes a sample pin, so activation counts stay honest. Targets the install→first-pin drop-off (many installs, few first pins).

## [1.3.4] — 2026-06-10

### Added

- **Local-only mode is now visible.** When the server starts without a license key it runs against local `.feedback/` only — cloud pins, share reports, invites, and team features are off. Previously this degraded silently (the #1 "it doesn't work in Claude Code" complaint). The first tool response of a session now carries a one-time `LOCAL-ONLY MODE` banner naming the three ways to connect (env var, `--license-key`, or `~/.pincushion/license-key`).

### Fixed

- **Sentry release tag** now reads the real `package.json` version instead of a hardcoded `1.0.2`, so error reports attribute to the correct release.

## [1.3.3] — 2026-06-10

### Fixed

- **Cloud team/share tools no longer drop the license key.** `create_share_report`, `create_invite_link`, and `add`/`list`/`remove_member` read the header key from `SYNC_API_KEY` (the `--api-key` arg, which is normally never passed) instead of the resolved license — so when the server ran with `--license-key`/env/file (the normal case) they sent **no** key and every call 401'd "License key required" even with a valid license. Now they use `resolveCloudSyncKey()` like every other cloud call. This makes the 1.3.2 `create_share_report` actually work.

### Added

- **`upload_page_snapshot` MCP tool.** Turns a public share report into an annotated page: upload a full-page screenshot plus per-pin coordinates (resolved from each pin's `element.selector` at capture time) and the report renders the real page with markers at true positions and read-only thread popovers. Owner/editor only; one snapshot per (project, page), latest wins. Capture recipe in `docs/page-snapshot-capture.md`.
- **User-level license key** at `~/.pincushion/license-key` — one login per machine, shared across every project and worktree (resolution order: `PINCUSHION_LICENSE_KEY` env > `--license-key` > `.feedback/.license-key` > `~/.pincushion/license-key`).
- **Shutdown diagnostics** — SIGTERM/SIGINT/stdin-EOF/exit logging to root-cause intermittent host disconnects, plus a clear "not signed in — run `pincushion login`" startup notice instead of silent local-only mode.

## [1.3.2] — 2026-06-09

### Added

- **`create_share_report` MCP tool.** Mints a public, read-only crit report link (`pincushion.io/r/<token>`) for a project — numbered pins with threads, screenshots, status, and the branch/PR/deploy/AI-verification trail. Anyone with the link can view it; no extension and no account required. Free on every plan (it's the share loop — never Pro-gated). Optional `pageUrl` scope, `title`, and `expiresInDays` (links are evergreen by default, revocable server-side). Backed by a new `shared-report` edge function (POST mints, owner/editor only; GET returns report JSON) and a Vercel render function that serves the page as HTML.

## [1.3.0] — 2026-05-18

### Added

- **`set_slack_preferences` MCP tool.** Read or write the caller's Slack DM preferences (mute window, per-event toggles, quiet hours, digest mode) from any agent. Resolves the user via license_key → email and applies the change across every Slack workspace where the email is linked. Same surface as the App Home toggles and `/pincushion mute` — accessible to Claude Code, Cursor, etc. for "mute pin DMs during this refactor" workflows. Backed by a new `manage-integrations` `/preferences` endpoint (GET + POST, license_key-authed).

### Changed

- **`claim_pending_slack_install` is now legacy fallback.** Since May 2026, Slack installs from `https://pincushion.io/install/slack` auto-link to a Pincushion license when the installer's Slack email matches an active account. Channels are subscribed via `/pincushion subscribe <project-id-or-url>` inside Slack — no claim token required. Calling the tool with no `claimToken` returns the new flow instructions (storefront URL + slash command hint) instead of an error. The tool description and error copy point users at the new path.
- **`create_slack_install_link` now returns a `storefrontUrl` recommendation** alongside the agent-flow `installUrl`. Most users should prefer the storefront URL — it auto-claims for matched-email installers. The agent-flow URL stays available for cases where the install must be pre-bound to a specific project.

### Notes

- **No breaking changes.** Existing callers continue to work. The deprecation is descriptive (tool descriptions + return-value hints), not enforced.
- **Backend already live.** The auto-claim path (`manage-integrations@v19`), DM-first dispatcher (`sync-annotations@v48`), and Figma-style App Home + slash command handler (`slack-events@v6`) are all deployed.
- **For new Slack installs to use slash commands**, the Slack app manifest must be updated to add the `commands` OAuth scope and register `/pincushion`. See [SLACK_APP_MANIFEST.yml](SLACK_APP_MANIFEST.yml) and the migration notes in [SLACK_APP_DIRECTORY_PACKAGE.md](SLACK_APP_DIRECTORY_PACKAGE.md). Existing installs continue to work for DMs + channel broadcasts + App Home without re-install; only slash commands require the workspace to re-OAuth.
- **Welcome DM** now fires once on first user link, with explicit instructions to enable Slack notifications on the bot's DM (Slack delivers app DMs silently by default — this addresses the most common "Pincushion is broken" report).

## [1.2.0] — 2026-05-14

### Added

- **Layered critique-context system.** The Pincushion AI critic now reads a compiled per-project brief (`ai.critique.effectiveContext`) at pin time, grounded in the actual page sources walked from the dev's repo during `/setup`. Supersedes the single-blob `brandContext` field (kept for back-compat — falls back when no compiled context exists).
- **New MCP tool: `update_critique_context`.** Lightweight write path for `/setup` and `/refresh-brand` that skips the deploy-hook / member-init work `configure_project` does. Persists `critiqueContext` (compiled brief, ≤8192 chars) + `critiquePolicy` (user-editable rules, ≤4096 chars) + `critiqueSignals` (JSONB: framework, projectType, pages[], themeTokens, brandDocs, competitors, mission, audience, tone — and a reserved `tenantContexts` slot for future multi-tenant SaaS).
- **Staleness signal in `get_project_context`.** `ai.critique.staleness` returns `fresh` (≤30d), `aging` (30–60d), `stale` (>60d), or `missing` (no compiled context). `ai.critique.compiledAt` + `pinsAtCompile` baseline the next refresh.
- **`/setup` command** now detects framework (`next`, `astro`, `sveltekit`, `remix`, `nuxt`, `gatsby`, static-HTML, Vite SPAs) and walks the route tree, extracting headings + CTAs + body excerpts + component names per page. Brief template flexes between marketing-heavy (voice, positioning, competitors) and app-heavy (terminology, workflow stages, role-aware UI) based on detected `projectType`.
- **`/refresh-brand` command** for recompiles. Diffs current repo state against the previous `critique_signals.pages` to surface added / removed / drifted routes. Carries forward `critique_policy` across runs.

### Changed

- `configure_project` accepts three new optional params: `critiqueSignals` (object), `critiquePolicy` (string), `critiqueContext` (string). All additive — existing calls behave identically.
- `get_project_context` response gains an `ai.critique` sub-object with `effectiveContext`, `compiledContext`, `policy`, `signals`, `compiledAt`, `pinsAtCompile`, `staleness`. Existing `ai.brandContext` field unchanged.
- `create_critique_pin` tool description updated to point the critic at `ai.critique.effectiveContext` and to suggest `/refresh-brand` when staleness is `stale` or `missing`.

### Notes

- **Backend already live.** Schema migration `add_layered_critique_context_to_projects` and edge function `sync-annotations@v44` are deployed to production. No coordinated rollout needed — existing 1.1.0 clients keep working.
- **Chrome extension unchanged.** The extension never reads critique fields; no Chrome Web Store release is needed.
- Future hook: `critique_signals.tenantContexts` (currently null/reserved) is the planned extension point for Salesforce-shape multi-tenant projects where one deployed app serves many client orgs with their own branding/terminology. JSONB column accommodates it natively — no migration required when implemented.

## [1.1.0] — prior

Baseline before the layered critique-context system. `brandContext` was a single string field on the project record.
