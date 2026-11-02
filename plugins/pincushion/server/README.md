<!-- 2026-10-26: removed the Glama badge (registry page 404s and the server is not listed). Development and support no longer link the private monorepo, which 404s for public readers. Changelog notes that npm is the current version. Merge with main keeps the www canonical docs and product links and the public support page. -->
<!-- 2026-10-26: Quick start names where to invite (create_invite_link or People) and puts the no-account sample path before "Prefer the app?". -->

# Pincushion MCP Server

Pincushion turns visual feedback into work your coding agent can ship. Teammates and clients pin feedback on your pages in the Pincushion app. Your agent (Claude Code, Cursor, VS Code, Codex, Windsurf or any MCP client) reads each pin through this server, fixes it in your code, and records the commit and PR.

**[Connect your agent, then invite your client or designer to pin feedback, with nothing for them to install →](https://www.pincushion.io/mcp?ref=readme)**

## What's in a pin

Each pin carries what an agent needs to make the change without a back-and-forth:

- **URL and element selector:** exactly what, exactly where
- **Screenshot, viewport and DOM snippet:** the visual and structural context
- **Thread and project context:** the conversation and the codebase it lives in
- **Likely files and acceptance criteria:** where to look, and how to know it's done

Resolving a pin records the commit, branch and PR. An optional post-deploy check confirms the fix landed.

## Quick start

1. **Connect your agent with one command.** In your project folder, run:

   ```bash
   npx -y pincushion-mcp setup --ref readme
   ```

   It signs you in, lists your projects (or creates one), and configures your coding agent to use Pincushion.
2. **Ask your agent.** Open your agent in the project folder (restart it if it was already open) and ask: *"Show my Pincushion pins."* The loop is `get_actionable_pins` → `claim_pin` → change the code → `fix_and_resolve`.
3. **Invite a client or designer.** Ask your agent to call `create_invite_link`, or create the link on the project's **People** tab, and share it. Invitees sign in, open a review, and pin feedback. Commenters are free and need nothing installed.

No site feedback yet? Get a free AI crit of your site: https://www.pincushion.io/crit?ref=readme

Try it with no account: add `npx -y pincushion-mcp` to your agent's MCP config and ask *"Show my Pincushion pins."* With no pins yet, it shows a sample pin you can fix with `start_quickstart_demo` on a throwaway demo page. Reading pins works without an account, but `claim_pin` and `fix_and_resolve` change a pin on the server, so they need `npx -y pincushion-mcp login` first.

Requires Node.js 22.22+ or Node.js 24.

Running from an agent or CI shell with no terminal? `setup` prints copy-paste steps instead: sign in with `login`, then add the server with `claude mcp add --scope project pincushion -- npx -y pincushion-mcp --project-dir .` (Claude Code) or a `.cursor/mcp.json` entry (Cursor).

### Prefer the app?

[Download the Pincushion app](https://www.pincushion.io/download) for Mac, or open [pincushion.io/app](https://www.pincushion.io/app) and install it from your browser. Sign in with Google and create a project with your site's URL. Then open the project's **Connect code** tab and pick one:

- **GitHub (recommended).** Enter your repository and choose your coding agent, then click **Add to GitHub**. GitHub opens with the Pincushion config file ready to commit. Everyone who opens the repo in that agent is connected to the project.
- **Command.** In your project folder, run the command the tab shows:

  ```bash
  npx -y pincushion-mcp setup --project-id <your-project-id>
  ```

Each developer signs in once with `npx -y pincushion-mcp login`; setup does this for you. Create invite links on the project's **People** tab.

### Optional: a first AI critique

After connecting, setup offers to run a first AI critique of your site through the agent you chose. It captures desktop and mobile screenshots, saves findings as pins in your project, and opens a private report. It uses your agent's own model access and your Pincushion plan's AI actions. To run it later, run `npx -y pincushion-mcp setup` again and accept the critique. Once installed, it's also available in your agent as `/pincushion-critique <url>` (Claude Code, Cursor, VS Code) or `$pincushion-critique <url>` (Codex).

Capture screenshots only, with no findings or uploads:

```bash
npx -y pincushion-mcp capture https://your-site.example ./captures
```

Capture uses an installed Chrome or Chromium on macOS or Linux; Windows capture isn't supported yet. To capture pages behind a sign-in, save the session once with `npx -y pincushion-mcp snapshot --login <url> --proof-selector <selector-only-shown-when-signed-in>`, then add `--require-auth`.

## Installation

`npx -y pincushion-mcp` always runs the latest version, which is what the setup command and the committed config use. To install it globally instead:

```bash
npm install -g pincushion-mcp     # or: pnpm add -g pincushion-mcp / yarn global add pincushion-mcp
```

Run `npx -y pincushion-mcp --help` for every command.

### More ways to collect feedback

Reviews in the Pincushion app need nothing installed. Two optional extras:

- The [Chrome extension](https://www.pincushion.io/install/chrome) lets signed-in reviewers pin directly on your live site.
- Your agent can file pins itself with `create_agent_pin`, for example from a browser QA run.

### Optional automatic deployment-frame refresh

Production deployment receipts have a frame-refresh gate that is separate from
pin and Crit status: every accepted non-removed page needs newly rendered
1280×900 desktop and 390×844 mobile JPEG bytes before its canonical frame can
advance. Unchanged pages still require a fresh byte pair.

The local MCP executor for that gate is off by default because it launches a
browser and uploads production page images. To authorize it for one
unambiguously configured project, set `PINCUSHION_AUTO_FRAME_REFRESH=1` in the
MCP server environment. Cloud credentials are required. Signed-in targets also
require the origin-bound `PINCUSHION_STORAGE_STATE` file documented in
[`docs/page-snapshot-capture.md`](docs/page-snapshot-capture.md). The executor
fails closed when project scope, credentials, auth state, exact page scope,
browser availability, or any upload receipt is uncertain.

---

## Agent Configuration Guides

### OpenAI Codex (native MCP)

Run `npx -y pincushion-mcp setup` in the project and select **Codex**. It writes
`.codex/config.toml` with the acknowledged project ID. A clean manual entry is:

```toml
[mcp_servers.pincushion]
command = "npx"
args = ["-y", "pincushion-mcp", "--project-dir", ".", "--ref", "readme"]
```

Sign-in uses the shared `~/.pincushion/license-key`; never put a key in this
file. After restarting Codex, ask it for `get_project_context` to verify the
authenticated project binding. Other MCP clients can use the same package and
login without a separate account or embedded key.

### Cursor

**File:** `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "pincushion": {
      "command": "npx",
      "args": ["pincushion-mcp", "--project-dir", ".", "--ref", "readme"]
    }
  }
}
```

> **pnpm / yarn users:** replace `"command": "npx"` with `"command": "pnpm"` and add `"dlx"` as the first arg, or use `"command": "yarn"` with `"dlx"` likewise.

**With Supabase sync:**

```json
{
  "mcpServers": {
    "pincushion": {
      "command": "npx",
      "args": [
        "pincushion-mcp",
        "--project-dir", ".",
        "--sync-url", "https://your-supabase.com/api",
        "--api-key", "YOUR_API_KEY"
      ]
    }
  }
}
```

### Claude Desktop

**File:** `~/.config/Claude/claude_desktop_config.json` (Linux/Windows)
or `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)

```json
{
  "mcpServers": {
    "pincushion": {
      "command": "npx",
      "args": ["pincushion-mcp", "--project-dir", "/path/to/your/project", "--ref", "readme"]
    }
  }
}
```

**pnpm users:**
```json
{
  "mcpServers": {
    "pincushion": {
      "command": "pnpm",
      "args": ["dlx", "pincushion-mcp", "--project-dir", "/path/to/your/project", "--ref", "readme"]
    }
  }
}
```

**yarn users:**
```json
{
  "mcpServers": {
    "pincushion": {
      "command": "yarn",
      "args": ["dlx", "pincushion-mcp", "--project-dir", "/path/to/your/project", "--ref", "readme"]
    }
  }
}
```

**With Supabase sync:**

```json
{
  "mcpServers": {
    "pincushion": {
      "command": "npx",
      "args": [
        "pincushion-mcp",
        "--project-dir", "/path/to/your/project",
        "--sync-url", "https://your-supabase.com/api",
        "--api-key", "YOUR_API_KEY"
      ]
    }
  }
}
```

### Claude Code (CLI)

Run this command to add Pincushion to Claude Code:

```bash
claude mcp add pincushion -- npx pincushion-mcp --project-dir . --ref readme
```

Or with Supabase sync:

```bash
claude mcp add pincushion -- npx pincushion-mcp --project-dir . --sync-url https://your-supabase.com/api --api-key YOUR_API_KEY
```

### VS Code (Copilot / Continue)

**File:** `.vscode/mcp.json`

```json
{
  "servers": {
    "pincushion": {
      "command": "npx",
      "args": ["pincushion-mcp", "--project-dir", ".", "--ref", "readme"]
    }
  }
}
```

### Windsurf / Codeium Windsurf

**File:** `~/.windsurf/mcp.json` or `~/.config/windsurf/mcp.json`

```json
{
  "mcpServers": {
    "pincushion": {
      "command": "npx",
      "args": ["pincushion-mcp", "--project-dir", ".", "--ref", "readme"]
    }
  }
}
```

### Antigravity

**File:** `~/.antigravity/mcp.json`

```json
{
  "mcpServers": {
    "pincushion": {
      "command": "npx",
      "args": ["pincushion-mcp", "--project-dir", ".", "--ref", "readme"]
    }
  }
}
```

### OpenAI Codex / REST API Clients

For tools that don't support MCP directly, use the REST API wrapper:

```bash
npx pincushion-mcp --rest --port 3456
```

This starts an HTTP server on `127.0.0.1:3456`. It prints the path to a
process-specific capability file under `~/.pincushion/local-transports/`.
That directory is owner-only and the capability file is mode `0600`. Read the
`restCapability` from the current file and send it as
`X-Pincushion-Local-Capability`; it rotates whenever the MCP process restarts.

The REST listener accepts the exact `Host: 127.0.0.1:<port>` only. It rejects
browser `Origin` requests and intentionally sends no generic CORS headers.
Use a native REST client or an MCP-capable client rather than putting the
capability in a browser page, URL, source file, or repository.

Local HTTP has a 15-second header deadline, a derived request-receive deadline
of at least 90 seconds, and a separate five-minute `call-tool` response
deadline. A `202` response with `tool_execution_pending` means the operation's
outcome is unknown and `retrySafe` is false; inspect the resulting local or
cloud state before deciding whether to send another mutation. See the local
transport guide for the bounded environment overrides.

Endpoints:

- `GET /health` — Check server status
- `POST /call-tool` — Invoke a tool
  - Body: `{ "toolName": "get_feedback_summary", "args": {} }`

Example using curl:

```bash
curl -X POST http://127.0.0.1:3456/call-tool \
  -H "Content-Type: application/json" \
  -H "X-Pincushion-Local-Capability: <restCapability from the 0600 capability file>" \
  -d '{"toolName": "get_feedback_summary", "args": {}}'
```

See [local transport security](docs/local-transports.md) for dashboard and
Chrome bridge boundaries, request limits, and the cloud-grant integration seam.

---

## CLI Flags

```bash
npx pincushion-mcp [flags]
```

| Flag | Description | Default |
|------|-------------|---------|
| `--project-dir PATH` | Root directory containing `.feedback/` | Current working directory |
| `--sync-url URL` | Supabase API endpoint for remote sync | None (local only) |
| `--api-key KEY` | API key for Supabase authentication | None |
| `--license-key KEY` | Pro license key (optional) | None |
| `--rest` | Enable REST API mode | Disabled (uses MCP/stdio) |
| `--port PORT` | Port for REST API server | 3456 |
| `--ref SLUG` | Which listing or install link this install came from (also `PINCUSHION_REF`). The first one seen is kept in `~/.pincushion/install-ref` and recorded once on your account with your editor's MCP client name. Analytics only; off with `PINCUSHION_NO_TELEMETRY=1` or `DO_NOT_TRACK=1` | None |

### Examples

**Local project:**
```bash
npx pincushion-mcp --project-dir /path/to/project
```

**With Supabase sync:**
```bash
npx pincushion-mcp \
  --project-dir /path/to/project \
  --sync-url https://abcd1234.supabase.co/api \
  --api-key sb_project_key_abc123...
```

**REST API server:**
```bash
npx pincushion-mcp --rest --port 8080
```

---

## Mobile Crit Walls (iOS)

Pincushion pins live on web pages — `mobile-wall` brings native iOS apps into the
loop by turning a booted simulator into a static, pinnable **crit wall**: one page,
every screen, with semantic hotspot overlays generated from the app's accessibility
hierarchy so pins anchor to real element labels (`data-ax="Send message"`) instead
of raw pixels.

**Headless (one command, CI-able):**

```bash
npx pincushion-mcp mobile-wall run     # first run scaffolds crit-wall/wall.plan.json
```

`wall.plan.json` declares the whole session: the app (`bundleId`, optional
`appPath` to install, optional `boot` device to cold-boot a simulator with no
Simulator.app window) and the screens, each with the maestro navigation that
reaches it — steps written as JSON (`{"tapOn": "Get started"}`; YAML is a JSON
superset, so they pass into the generated flow verbatim), or `flow` pointing at
a hand-authored maestro flow file. Re-running `run` boots/installs/launches,
drives every screen, captures, and builds the wall — no human at the simulator.
Generated flows persist under `crit-wall/flows/` so a failing step can be
replayed with `maestro test` directly. maestro's JVM is resolved automatically
(`/usr/libexec/java_home`, then keg-only Homebrew JDKs) — headless shells and
CI don't need `JAVA_HOME` exported.

**Manual (navigate the simulator yourself):**

```bash
# 1. Boot your app in the iOS simulator, navigate to a screen, then:
npx pincushion-mcp mobile-wall capture 01-first-launch
npx pincushion-mcp mobile-wall capture 02-connect        # …repeat per screen

# 2. Generate the wall:
npx pincushion-mcp mobile-wall build --name "My App"
```

**Publish after the app PR merges:**

```bash
PINCUSHION_LICENSE_KEY=... npx pincushion-mcp mobile-wall publish \
  --snapshot crit-wall-snapshot.jpg \
  --deploy-command "vercel deploy --prod" \
  --resolve-implemented \
  --verify verified
```

`publish` is the no-plugin maintenance path for public/native critiques. It
reruns the headless capture plan by default, rebuilds `wall/`, optionally deploys
the static wall, fetches cloud pins for `projectId` + `pageUrl`, recomputes public
report marker positions from `snapshot.rects` + current AX hotspots, uploads the
latest JPEG/WebP page snapshot, and can mark implemented pins resolved with a
deploy URL and verification status. Use `--no-run` when CI already has fresh
captures and only needs to rebuild/upload. It writes
`crit-wall/wall/publish-manifest.json` and `crit-wall/wall/publish-report.md` for
the release artifact. Existing deployed walls are static HTML, so run
`mobile-wall publish` once after this version lands to republish their
`index.html`; after that, the wall canvas behavior is loaded from the centrally
hosted `https://www.pincushion.io/widget/mobile-wall-canvas.js` script and can be
updated by deploying Pincushion rather than regenerating every wall.

Both modes capture a screenshot (`xcrun simctl io booted screenshot`) plus the
accessibility hierarchy (**maestro** or **idb**, auto-detected on your PATH) into
`crit-wall/screens/` + `crit-wall/ax/`. `build` emits `crit-wall/wall/index.html` —
a brandable gallery page (edit `crit-wall/wall.config.json` for the title, copy,
accent color, and per-screen captions, then rebuild) — and prints the next steps:
deploy the wall to any static host, register it with `configure_project`, and mint
a public crit link with `create_share_report`. Once the config carries the
`projectId` + deployed `pageUrl`, a rebuild turns on zero-install click-to-pin:
visitors drop pins straight on the screens with just a name + email. Pins dropped
on a hotspot prefix the comment with `[Flow: ...] [Route: ...] [Build: ...]
[Screen: ...] [Element: ...]` when that metadata exists, and every
build also writes `crit-wall/wall/agent-context.json` with screen selectors,
image dimensions, and accessibility hotspot selectors. Builds also emit
`crit-wall/wall/agent-work-packet.json` and
`crit-wall/wall/agent-work-packet.md`: a reusable app-agent handoff with
headless capture provenance, `wall.plan.json` reproduction commands, native
source hints, screenshot-only warnings, and per-hotspot source search commands.
That packet is the handoff for a coding agent: use it to map critique back to
native UI labels instead of treating the report as screenshots.

For stronger native-source context, edit `wall.config.json` before rebuilding:
set `agent.targetRepo`, `agent.sourceRoots`, optional `agent.implementationNotes`,
and `sourceHints.screens` / `sourceHints.labels` entries for known SwiftUI/UIKit
files, routes, and screen identifiers. `mobile-wall` still derives useful `rg`
searches from accessibility labels by default, but explicit source hints make
pin-to-PR routing much less ambiguous for a future agent.

For social sharing, set `ogImage` in `wall.config.json` (a file inside `wall/`,
e.g. `og.png`). To make click-to-pin markers land exactly on the annotated share
report, run `upload_page_snapshot` and record the mapping in the config
(`snapshot: { w, h, rects: { "<screen>": { x, y, w, h } } }` — each exhibit
image's rect within the snapshot); screens without a rect fall back to
document-relative pin coordinates.

The OpenClaw iOS pilot exposed the important boundary: `mobile-wall` can make a
native-app critique actionable, but it should not pretend to fix the native app
by editing the wall. Use the wall PR to improve capture, pin context, snapshot
mapping, and reviewer ergonomics; use the app repo PR to change copy, buttons,
navigation, empty states, and other product behavior.

Options: `--out <dir>` (default `crit-wall`), `--plan <file>` (run),
`--backend maestro|idb`, `--udid <udid>` (default `booted`). Requires Xcode
command line tools; maestro is required for `run` navigation (idb works for
capture-only AX). Android (adb/uiautomator) is not supported yet.

---

## Tools

<!-- BEGIN GENERATED:tool-index -->
<!-- Generated index of every MCP tool — edit descriptions in pincushion-mcp/server.js, then run `npm run sync`. Pro\* = degrades to a partial result on Free. -->
| Tool | Plan | Summary |
|---|---|---|
| `add_agency_internal_message` |  | Pilot: append an owner/editor-only internal thread note to one pin. It never enters the public… |
| `add_agent_reply` |  | Add a reply to an annotation thread (e.g. to ask a clarifying question or note a finding). |
| `add_bot_reply` |  | Post a Pincushion AI reply to a pin's thread. Hardcodes author="Pincushion AI" and… |
| `add_member` | Pro | Add a collaborator to a Pincushion project. Developers consume a paid seat and can implement… |
| `approve_pin` |  | Mark a pin as approved for implementation. Only approved pins should be implemented by agents.… |
| `archive_agency_label` |  | Pilot: archive one owner/editor-only agency label. Archived labels cannot be applied or used in… |
| `assign_pin_to_agent` |  | Assign a pin directly to your local coding agent. Promotes the pin to "ready" (if not already),… |
| `attach_verification_run` |  | Pilot: ask Pincushion to retrieve and validate a configured GitHub Actions run for an existing… |
| `capture_private_report` |  | Explicitly capture one exact registered URL in the configured existing project, without a model… |
| `claim_pending_slack_install` |  | LEGACY FALLBACK. Since May 2026, Slack installs auto-link to a Pincushion license when the… |
| `claim_pin` |  | Claim an actionable pin before starting work on it. Transitions the pin from… |
| `complete_critique_request` |  | Mark a critique_queue request as completed after the critic subagent has run on its page URLs.… |
| `complete_deployment_capture_run` |  | Requests server-side frame-refresh completion after all exact page/device receipts have been… |
| `configure_collaboration_integration` |  | Connect a Pincushion project to Slack, Microsoft Teams, or Discord using an incoming webhook.… |
| `configure_project` |  | Register a Pincushion project and associate it with your app's URLs. Registration does not call… |
| `create_agency_label` |  | Pilot: create an owner/editor-only custom label. Labels are private agency metadata and never… |
| `create_agent_pin` |  | File a pin as a THIRD-PARTY agent — the write half of the browser-agent → coding-agent handoff.… |
| `create_critique_pin` |  | Create a pin authored by Pincushion AI. ONLY call this from the pincushion-critic subagent,… |
| `create_invite_link` |  | Generate a Figma-style shareable invite URL for a project. The recipient opens it, enters their… |
| `create_share_report` |  | Mint a public read-only crit report link (pincushion.io/r/<token>) for a project: numbered pins… |
| `create_slack_install_link` |  | Generate an Add-to-Slack OAuth URL pre-bound to a project. Most users should prefer the public… |
| `export_agency_evidence` |  | Pilot: produce a bounded owner/editor-only structured export for one project, filtered exactly… |
| `fix_and_resolve` |  | Resolve a pin after applying a code fix. Transitions the pin directly to "resolved" status so it… |
| `generate_critique_report` |  | Turns supplied real captures into a report receipt; it does not inspect a page or generate… |
| `get_actionable_pins` |  | Get all pins waiting for developer attention. Returns three categories: (1) "auto-agent" — pins… |
| `get_agency_coordination_state` |  | Pilot: read the exact owner/editor-only agency coordination state for one project. This does not… |
| `get_agency_internal_thread` |  | Pilot: read the append-only internal agency thread for one exact pin. This is restricted… |
| `get_annotations` |  | Retrieve annotation pins from the .feedback/ directory. Filter by page URL, LWC component name,… |
| `get_component_feedback` |  | Get all feedback pins targeting a specific LWC component, with a plain-language summary ready… |
| `get_deployment_reconciliation_status` |  | Read a compact, provider-neutral deployment readiness diagnostic. It never creates a binding,… |
| `get_feedback_summary` |  | Get a high-level rollup of all open feedback: counts by status, page, and component. Use this to… |
| `get_implementation_packet` |  | Get a single implementation packet for one page URL. Useful when you want to batch-fix one page… |
| `get_pending_critiques` |  | Used by /critique-latest-deploy. Lists pending critique requests queued by the deploy-hook for… |
| `get_pending_deployment_frame_refreshes` |  | Lists production deployment frame-refresh work independently of the Critique queue. Use this… |
| `get_pin_verification` |  | Read authoritative verification evidence for one explicit project and pin. Separates caller… |
| `get_project_context` |  | Read-only cloud-project lookup of context (name, URLs, brand context, autoCritique flag,… |
| `get_project_identity_diagnostic` |  | Read-only diagnostic for project identity repair. Returns only authentication state, safe key… |
| `get_project_write_authorization` |  | Read current developer write authorization for this server's exact acknowledged project. Uses… |
| `get_reply_candidates` |  | Used by /pincushion-replies. Returns pins where Pincushion AI should respond, with each… |
| `get_review_activity` |  | Pilot: read authenticated client-review decisions and completion for exact frozen review… |
| `get_selected_pins` |  | Get pins that the developer has selected for implementation from the dashboard or PINS.md… |
| `get_setup_instructions` |  | Continue an existing critique with claim, or start a project with setup and explicit editor… |
| `get_time_to_fix_metrics` | Pro\* | Compute median + p25/p75 time-to-fix from resolved pins. Returns sample size + threshold flag so… |
| `implement_approved_pins` |  | CALL THIS FIRST when approved pins exist. Returns all stakeholder-approved pins grouped into… |
| `import_qa_results` |  | Pilot: import already-parsed axe JSON or Playwright JSON from an authenticated… |
| `link_pin_deploy` |  | Link a deploy URL to a resolved pin. Typically called by the deploy-hook edge function once a… |
| `list_agency_pins` |  | Pilot: read owner/editor-only pins with private labels and evidence summaries. `status`,… |
| `list_collaboration_integrations` |  | List Slack and Microsoft Teams webhook subscriptions for a Pincushion project. Webhook URLs are… |
| `list_members` | Pro | List all members of a Pincushion project with their roles, plus seat usage info. |
| `manage_deployment_automation` |  | Owner-keyed deployment automation management. inspect is read-only. repair is available only for… |
| `preview_collaboration_notification` |  | Preview the Slack, Teams, or Discord notification shape and recommended event routing before… |
| `record_deployment_page_result` |  | Record one terminal page result for a deployment frame refresh. Every non-removed page in an… |
| `record_pin_verification` |  | Record a caller-reported verification verdict using the compatible legacy workflow. This does… |
| `register_deployment_discovered_pages` |  | Register the exact bounded URL inventory discovered in one local browser context before staging… |
| `remove_collaboration_integration` |  | Remove a Slack, Microsoft Teams, or Discord webhook subscription from a Pincushion project. |
| `remove_member` | Pro | Remove a collaborator from a Pincushion project. Frees up the seat if they were an editor. |
| `resolve_annotation` |  | Mark an annotation as resolved after addressing the feedback. Optionally add a resolution… |
| `resolve_quickstart_demo` |  | Finish the quickstart demo loop after editing the demo copy. Confirms the change, returns the… |
| `search_annotations` |  | Full-text search across all annotation comments, selectors, component names, and tags. |
| `set_agency_coordination_pilot` |  | Pilot: owner-only switch for the private agency coordination increment. It is off by default.… |
| `set_agency_pin_labels` |  | Pilot: replace the private agency-label set on one pin. Every label must belong to the same… |
| `set_slack_preferences` |  | Read or update the caller's Slack DM preferences. Resolves the user via license_key → email,… |
| `start_deployment_capture_run` |  | Starts one short-lived local frame-refresh run for an exact deployment and returns its opaque… |
| `start_quickstart_demo` |  | Start the 60-second Pincushion quickstart: returns one sample stakeholder feedback pin (element… |
| `submit_verification_report` |  | Pilot: append a project-scoped caller-reported verification observation. An idempotency key… |
| `update_critique_context` |  | Lightweight write-only path for the layered critique-context system. Use this from /setup and… |
| `upload_page_snapshot` |  | Upload a full-page screenshot that turns the public share report into an annotated page: viewers… |
<!-- END GENERATED:tool-index -->

### `get_annotations`

Retrieve annotations from `.feedback/`. Filter by page, component, or status.

**Parameters:**
- `pageUrl` (string, optional) — Filter by page URL (partial match)
- `componentName` (string, optional) — Filter by LWC component name
- `status` (string, optional) — Filter by `open`, `in-progress`, or `resolved`

**Example:**
```javascript
await mcp.callTool('get_annotations', {
  componentName: 'wmlHomePage',
  status: 'open'
});
```

### `search_annotations`

Full-text search across all annotations, comments, selectors, and tags.

**Parameters:**
- `query` (string, required) — Search term

**Example:**
```javascript
await mcp.callTool('search_annotations', {
  query: 'button label'
});
```

### `get_feedback_summary`

High-level rollup of all feedback: counts by status, priority, page, and component.

**Example:**
```javascript
await mcp.callTool('get_feedback_summary', {});
```

### `get_component_feedback`

Get all feedback for a specific LWC component with a plain-language summary.

**Parameters:**
- `componentName` (string, required) — LWC component name

**Example:**
```javascript
await mcp.callTool('get_component_feedback', {
  componentName: 'wmlHomePage'
});
```

### `resolve_annotation`

Mark an annotation as resolved after fixing the issue.

**Parameters:**
- `annotationId` (string, required) — Annotation ID
- `comment` (string, optional) — Resolution message
- `resolvedBy` (string, optional) — Name to attribute resolution (default: "AI Agent")

**Example:**
```javascript
await mcp.callTool('resolve_annotation', {
  annotationId: 'ann_abc123',
  comment: 'Updated button label in line 42 of wmlHomePage.js'
});
```

### `add_agent_reply`

Add a reply to an annotation thread (e.g., ask clarifying questions).

**Parameters:**
- `annotationId` (string, required) — Annotation ID
- `body` (string, required) — Reply message
- `author` (string, optional) — Author name (default: "AI Agent")

**Example:**
```javascript
await mcp.callTool('add_agent_reply', {
  annotationId: 'ann_abc123',
  body: 'Is this button in the main navigation or sidebar?'
});
```

### `fix_and_resolve`

Combine fixing code and marking an annotation as resolved in one call. Optionally records commit / branch / PR metadata so the dashboard can backlink to what shipped.

**Parameters:**
- `annotationId` (string, required) — Annotation ID
- `fixDescription` (string, required) — Description of the fix
- `filePath` (string, optional) — File where fix was applied
- `lineNumber` (number, optional) — Line number of the fix
- `commitSha` (string, optional) — Commit SHA that landed the change
- `branchName` (string, optional) — Branch the commit was made on
- `prUrl` (string, optional) — Pull request URL (GitHub/GitLab/Bitbucket; shape-validated)

**Example:**
```javascript
await mcp.callTool('fix_and_resolve', {
  annotationId: 'ann_abc123',
  fixDescription: 'Updated button label to match design spec',
  filePath: 'src/components/wmlHomePage.js',
  lineNumber: 42,
  commitSha: 'abc123def456',
  branchName: 'pincushion/checkout-fix',
  prUrl: 'https://github.com/acme/app/pull/142'
});
```

### `get_implementation_packet`

Fetch a single implementation packet for one page URL — selector list, full pin payloads, suggested branch name, and traceability config. Use when an agent wants to batch-fix one page in a single branch.

```javascript
await mcp.callTool('get_implementation_packet', { pageUrl: '/checkout' });
```

### `assign_pin_to_agent`

Dispatch a pin straight to your local coding agent. Promotes the pin to `ready` if not already, marks `pending_implementation`, and writes a `.feedback/.agent-queue/<id>.json` trigger file that `agent-loop.mjs` picks up and shells out to Cursor / Claude Code / Codex.

```javascript
await mcp.callTool('assign_pin_to_agent', { annotationId: 'ann_abc123' });
```

### `link_pin_deploy`

Attach a deploy URL to a resolved pin. Typically called by the deploy-hook edge function once production includes the fix, but available manually too.

```javascript
await mcp.callTool('link_pin_deploy', {
  annotationId: 'ann_abc123',
  deployUrl: 'https://acme-app.vercel.app'
});
```

### `record_pin_verification`

Write Pincushion AI's post-deploy verdict back to the pin. Called by the critic agent after `/critique-latest-deploy` runs against a fresh deploy.

```javascript
await mcp.callTool('record_pin_verification', {
  annotationId: 'ann_abc123',
  status: 'verified',  // or 'regressed' or 'inconclusive'
  notes: 'Button matches the primary token. No regression on adjacent CTAs.'
});
```

### `get_time_to_fix_metrics`

**Pro/Team feature** — Free callers get sample size + upgrade hint. Median + p25/p75 of pin-to-resolve duration, with a 5-pin minimum so the metric is never noise.

```javascript
await mcp.callTool('get_time_to_fix_metrics', { scope: 'project', projectId: 'pc_proj_abc' });
// → { sampleSize, thresholdMet, median, p25, p75, medianHuman, ... }
```

### `get_setup_instructions` (NEW)

Get setup and configuration instructions for all supported agents.

**Example:**
```javascript
await mcp.callTool('get_setup_instructions', {});
```

### Slack and Microsoft Teams integrations

Pincushion can notify Slack or Microsoft Teams through project-scoped incoming webhooks. The defaults are intentionally quiet and Figma-inspired: notify when a pin is ready for implementation, when someone is @mentioned, and when a collaborator adds follow-up on work already being handled. Every newly dropped pin and every resolution are opt-in events.

**Recommended use cases:**
- Developer channel: `pin_ready` and `follow_up`
- Design or PM channel: `mention` and optionally `resolved`
- Launch or QA channel: `pageUrlPatterns` plus `pin_ready`, `follow_up`, and `resolved`
- Temporary incident channel: enable a focused subscription, then pause it after the ship window

**Example:**
```javascript
await mcp.callTool('configure_collaboration_integration', {
  projectId: 'my-project',
  provider: 'slack',
  webhookUrl: 'https://hooks.slack.com/services/...',
  targetLabel: '#product-feedback',
  events: ['pin_ready', 'mention', 'follow_up'],
  pageUrlPatterns: ['staging.example.com/checkout'],
  sendTest: true
});
```

For Slack, use `create_slack_install_link` when the hosted Slack app secrets are configured. It returns an Add-to-Slack URL; after approval, Slack returns the incoming webhook and Pincushion stores it automatically.

Use `list_collaboration_integrations` to audit configured destinations, `remove_collaboration_integration` to disconnect one, and `preview_collaboration_notification` to see the payload shape before adding a real webhook. Webhook URLs are stored server-side and returned only as masked values.

---

### `capture_private_report`

Capture one exact registered URL into a private, capture-only review without calling a model or creating AI pins. The MCP must already be configured for that project; your current account must have owner/editor access. A sandboxed browser must be installed. This command does not create a project or perform either Pincushion or target-app login.

Pass `projectId`, `url`, and a stable lowercase UUIDv4 `operationId` before starting. Optional `title` names the report; `requireAuth: true` requires existing authenticated browser capture evidence. The result returns the canonical `/app/project/<id>/review/<hash>` only after both real desktop/mobile uploads and the exact private manifest pass current-access readback. Viewing that path requires a signed-in Pincushion account on the project.

Reuse the same operation ID after a lost response. Repeated calls only read the recorded outcome. A `pending` result with incomplete recorded facts does not automatically repeat capture, upload, or report minting. A new ID means a separately requested capture. This URL flow does not promise image-only admission, project creation/quota recovery, progressive completion, or an AI critique.

## Auto-Agent Loop (Optional)

For agents that don't watch the file system (Claude Code, Cursor, generic),
`agent-loop.mjs` polls `.feedback/.agent-queue/` and dispatches new pins
to the configured agent automatically.

```bash
# from inside the pincushion-mcp directory
npm run agent-loop -- --project-dir /path/to/your/project

# or directly
node agent-loop.mjs --project-dir /path/to/your/project [--agent claude-code|cursor|generic] [--interval 3000]
```

The bridge (server.js) writes one trigger file per approved pin into
`.feedback/.agent-queue/`. The loop reads them, builds a prompt with
the pin's thread + element selector, and shells out to the chosen agent.
The agent uses MCP tools (`claim_pin` → fix → `fix_and_resolve`) and
the queue file is removed when the pin closes.

`detectAgent()` auto-detects `claude` or `cursor` on the `PATH`; falls
back to `generic` (writes the prompt to `.feedback/.agent-prompt` and
stdout). Run with `--interval 3000` to control poll cadence.

---

## Local File Structure

The server reads annotations from `.feedback/` in your project:

```
.feedback/
├── annotations/
│   ├── example-com-login.json
│   ├── example-com-dashboard.json
│   └── ...
└── index.json
```

Each annotation file contains:

```json
{
  "pageUrl": "https://example.com/login",
  "pageTitle": "Login",
  "annotations": [
    {
      "id": "ann_abc123",
      "status": "open",
      "priority": "high",
      "tags": ["design", "accessibility"],
      "createdAt": "2026-03-19T10:30:00Z",
      "element": {
        "lwcComponent": "wmlLoginForm",
        "selector": ".login-button",
        "textContent": "Sign In"
      },
      "thread": [
        {
          "author": "Design Team",
          "timestamp": "2026-03-19T10:30:00Z",
          "body": "Button label should say 'Sign In' not 'Login'",
          "type": "comment"
        }
      ]
    }
  ]
}
```

---

## Supabase Sync

To sync annotations with a remote Supabase database:

1. Set up a Supabase project at [supabase.com](https://supabase.com)
2. Create an `annotations` table with columns matching the annotation schema
3. Generate an API key from your project settings
4. Configure the server with `--sync-url` and `--api-key`

**Example:**
```bash
npx pincushion-mcp \
  --project-dir . \
  --sync-url https://your-project.supabase.co/rest/v1 \
  --api-key sb_project_key_abc123...
```

The server merges local `.feedback/` files with remote data, with remote taking precedence on newer updates.

---

## Pro License

Pincushion Pro includes additional features. Activate with `--license-key`:

```bash
npx pincushion-mcp --project-dir . --license-key YOUR_PRO_KEY
```

---

## Troubleshooting

### "Pincushion needs Node.js 22.22+ or Node.js 24"

Your `node` is older (or newer) than the supported releases. Upgrade, then rerun the command:

```bash
nvm install 22 && nvm use 22
```

Or download Node.js from https://nodejs.org. If your editor launches the MCP server, restart it so it picks up the new Node.js.

### "Module not found" error

Use Node.js 22.22+ or Node.js 24. Node.js 18 and Node.js 20 are unsupported:

```bash
node --version
```

Install dependencies:

```bash
npm install @modelcontextprotocol/sdk
```

### Annotations not appearing

Check that `.feedback/` exists in your project directory:

```bash
ls -la .feedback/
```

If it doesn't exist, create it and add some test annotations, or the extension will create it when you pin your first feedback.

### Supabase sync not working

Verify your credentials:

```bash
curl -H "x-api-key: YOUR_API_KEY" \
  https://your-project.supabase.co/rest/v1/annotations
```

### Agent can't find the server

In your agent config, use the full path to `pincushion-mcp`:

```bash
which pincushion-mcp
# Use the output path in your config
```

Or use `npx` to let it find the package:

```json
{
  "command": "npx",
  "args": ["pincushion-mcp", "--project-dir", ".", "--ref", "readme"]
}
```

---

## Development

Install the published server with npm (`npx -y pincushion-mcp`). The canonical source repository is private, so a public clone of it returns 404.

The public distribution mirror is [jcooley8/pincushion-plugin](https://github.com/jcooley8/pincushion-plugin). It is not guaranteed to match the latest version on npm. Check with `npm view pincushion-mcp version`.

---

## License

MIT License. See LICENSE file for details.

---

## Support

- **Help:** [Pincushion support](https://www.pincushion.io/support)
- **Docs:** [Pincushion Documentation](https://www.pincushion.io/docs)
- **Public mirror issues:** [jcooley8/pincushion-plugin](https://github.com/jcooley8/pincushion-plugin/issues)

---

## Changelog

The version published on npm is current (`npm view pincushion-mcp version`). This section is not a full release history.

### v1.0.0 (March 2026)

- Initial release
- Support for Cursor, Claude Desktop, Claude Code, VS Code, Windsurf, Antigravity
- Local `.feedback/` file support
- Supabase remote sync
- REST API wrapper for non-MCP clients
- New tools: `fix_and_resolve`, `get_setup_instructions`

VS Code uses `code chat --mode agent` for the acknowledged local workspace. GUI launch is not completion: setup waits up to ten minutes for exact-run server readback, then verifies and opens the report. Ambiguous profiles, inherited MCP/skill precedence, custom or unrestricted permission settings stop rather than being rewritten. Existing agent/model access and Manual tool approvals are required. Node/npm must exist before `npx` can start; npm dependencies are installed by the package, while Chrome/Chromium and the selected client remain checked prerequisites rather than silently provisioned binaries.
