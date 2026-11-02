# Pincushion — Listing in each tool's own directory

Where Pincushion is listed, what the repository already builds, and the one
step each listing still needs. Checked 2026-11-02. Submissions to third-party
stores happen in Josh's accounts, so every step in the last column is done by
Josh or the agent he hands it to.

## Status

| Tool | Listing | Built in this repository | Still needed (Josh) |
|---|---|---|---|
| Claude Code | Live: plugin marketplace in the public `jcooley8/pincushion-plugin` repository (`claude plugin marketplace add jcooley8/pincushion-plugin`, then `claude plugin install pincushion@pincushion`) | `pincushion-agent-plugin/` (manifest, `.mcp.json`, five skills), staged by `scripts/stage-agent-plugin-marketplace.mjs` and published with `/ops omarchy publish-agent-plugin push` | Optional: submit the public repository to the community marketplace at platform.claude.com/plugins/submit |
| Codex | Live: repository marketplace (`codex plugin marketplace add jcooley8/pincushion-plugin`) | Same plugin, `.codex-plugin/plugin.json` and `.agents/plugins/marketplace.json` | Nothing to submit. The official Codex directory lists a local stdio server only after OpenAI allowlists the org, or a hosted HTTPS server |
| Cursor | Cursor Marketplace: not listed yet | `.cursor-plugin/` (rules + MCP), live in the public repository; one-click deeplink on pincushion.io | Submit https://github.com/jcooley8/pincushion-plugin at cursor.com/marketplace/publish |
| VS Code | Visual Studio Marketplace: live, `pincushion.pincushion-feedback` 0.2.4 | `pincushion-vscode/`, `publish-vscode.yml` | — (the homepage links the listing and the one-click MCP install) |
| VS Code (Open VSX, read by Cursor, Windsurf, VSCodium) | Not listed | `publish-vscode.yml` publishes to Open VSX when the `OVSX_PAT` secret exists | Eclipse account, Open VSX publisher agreement, claim the `pincushion` namespace, add `OVSX_PAT`, run Publish VS Code extension |
| Claude Desktop | Anthropic desktop extension directory | `scripts/build-mcpb-release.mjs` builds `pincushion.mcpb`; `mcpb validate` passes (icon 128 px, 512 recommended) | Submit at clau.de/desktop-extension-submission; choose where the public `.mcpb` download lives (the release assets on the private repository are not public) |
| Official MCP Registry | Live: `io.github.jcooley8/pincushion` 1.12.4 | The `mcp-v*` release republishes it | — |
| GitHub MCP Registry and the VS Code MCP gallery | Not listed (`api.mcp.github.com` search returns nothing) | Official registry entry exists | Curation is manual: post an onboarding request in github/github-mcp-server discussions (see below). `server.json` `repository` now points at the public `jcooley8/pincushion-plugin`; the registry shows it from the next `mcp-v*` release |
| Cline | Not listed | Public README, `llms-install.md` and a 400×400 logo live in the public repository | Open the submission issue at github.com/cline/mcp-marketplace (text below) |
| Windsurf (now Devin Desktop) | No third-party submission exists | — | Nothing to submit. Its MCP list is the union of registries the team admin configures, in the official registry schema, so the official registry entry covers it |
| Mac app | Live: signed 0.1.2 DMGs in the public `desktop-releases` bucket; the site's Download for Mac follows the update feed | `/ops mac desktop-release-check` passed on 2026-11-02 for arm64 and x64: feed, receipt hashes, Developer ID signature, stapled notarization ticket and Gatekeeper | Source is 0.1.5; publishing it is a separate signed release |

Figma and Zapier are not pursued (Josh, 2026-11-02); the homepage and the
automate guide no longer mention them.

## Anthropic desktop extension directory (MCPB)

Pincushion is a local tool (reads the repository and git), so the MCPB path
fits; the remote-connector path needs a hosted OAuth server.

**Submit at:** https://clau.de/desktop-extension-submission with
`pincushion.mcpb` built by `node scripts/build-mcpb-release.mjs --output pincushion.mcpb`.

**Already satisfied:** every tool declares `title` and
`readOnlyHint`/`destructiveHint` (`server.js` `TOOL_META`); bundled icon;
privacy policy https://www.pincushion.io/privacy in `manifest.json`; setup is
install → choose the project directory → optional license key → ask for the
feedback summary.

**Description (≤2000 chars):**
> Pincushion turns feedback on your live app into work packets for your AI
> coding agent. Teammates and clients pin feedback on a page through a shared
> review link, the Pincushion app, Pincushion AI critiques or the optional browser
> extension. This MCP server gives your agent each pin's page URL, CSS selector,
> screenshot, DOM snippet, viewport, thread and acceptance criteria, so it can
> read, claim, implement and resolve the feedback in the repository it already
> works in, and record the commit on the pin.
>
> Point it at your project root and ask: "show my Pincushion feedback summary" or
> "implement the approved pins." Cloud sync, post-deploy critique and team
> collaboration use an optional license key; leave it blank for local-only mode.

**Notes for reviewers:** no native code. Optional crash reporting (Sentry) and
product analytics (PostHog), off without a key, opt out with
`PINCUSHION_NO_TELEMETRY=1` or `DO_NOT_TRACK=1`. The license key is stored in
the OS keychain (`sensitive: true`). The builder produces an unsigned bundle;
signing is optional for submission (see the
[MCPB signing workflow](https://github.com/modelcontextprotocol/mcpb/blob/v2.1.2/CLI.md#production-workflow)).

## GitHub MCP Registry onboarding request

Post in github/github-mcp-server Discussions (Q&A), after an `mcp-v*` release
publishes the `server.json` that points at the public repository:

> **Onboarding request: io.github.jcooley8/pincushion**
> Already in the Official MCP Registry (latest 1.12.4, active), npm package
> `pincushion-mcp`, stdio transport. Source and install notes:
> https://github.com/jcooley8/pincushion-plugin. Website:
> https://www.pincushion.io. Privacy: https://www.pincushion.io/privacy.
> Pincushion gives coding agents the feedback pins teammates leave on a live app
> (page, selector, screenshot, thread) and records the implementing commit on
> each pin. Every tool declares a title and `readOnlyHint`/`destructiveHint`.
> No credentials in the MCP config;
> sign-in happens in the browser through `npx pincushion-mcp setup`.
> Requesting the manual initial curation so it appears in the VS Code MCP gallery.

## Cline MCP Marketplace submission

New issue at https://github.com/cline/mcp-marketplace/issues/new (server
submission template):

- **GitHub repo URL:** https://github.com/jcooley8/pincushion-plugin
- **Logo:** `plugins/pincushion/assets/logo-400.png` from that repository (400×400 PNG)
- **Reason for addition:** Cline users fixing UI feedback get each pin as a
  ready work packet (page, selector, screenshot, thread, acceptance criteria) and
  close it with the commit recorded. Install is one `npx` entry with no API key
  in the settings; `llms-install.md` walks Cline through it.

## Smithery and indexes

Smithery needs the GitHub repository connected at smithery.ai
(`pincushion-mcp/smithery.yaml`). mcp.so, PulseMCP and Glama index the official
registry and npm on their own; claiming those listings is optional.
