# Changelog

All notable changes to `pincushion-mcp` are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow SemVer.

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
