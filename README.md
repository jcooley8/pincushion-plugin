# Pincushion MCP Server

The implementation-context layer for AI-native development. Stakeholders drop visual pins on any page of your live app; your AI coding agent reads each pin through MCP and ships the fix — in Claude Code, Cursor, VS Code, Windsurf, or any MCP client.

## What makes a Pincushion pin different

A pin isn't a feedback item — it's an **agent work packet**. Each one carries everything an agent needs to implement the change without a back-and-forth:

- **URL + element selector** — exactly what, exactly where
- **Screenshot + viewport + DOM snippet** — the visual and structural context
- **Thread + project context** — the conversation and the codebase it lives in
- **Likely files + acceptance criteria** — where to look, and how to know it's done

The loop closes itself: a stakeholder pins it → your agent reads it via MCP and fixes it in your IDE → the resolve records the commit, branch, and PR → an optional post-deploy critique verifies the fix actually landed.

This server is also how Pincushion AI runs design/copy/a11y critiques on a live page and writes the pins straight back onto it.

## Installation

```bash
# npm
npm install -g pincushion-mcp

# pnpm
pnpm add -g pincushion-mcp

# yarn
yarn global add pincushion-mcp
```

Or run directly without installing:

```bash
# npm
npx pincushion-mcp --project-dir .

# pnpm
pnpm dlx pincushion-mcp --project-dir .

# yarn
yarn dlx pincushion-mcp --project-dir .
```

## Quick Start

### 1. Install the Browser Extension

Download the Pincushion Chrome extension from [pincushion.io/install/chrome](https://pincushion.io/install/chrome).

### 2. Configure Your Agent

Pick your AI agent below and follow the configuration for your setup.

### 3. Start Using

Once configured, your agent can:
- See all feedback: `get_feedback_summary`
- Find specific pins: `search_annotations`
- Fix and mark as done: `fix_and_resolve`

---

## Agent Configuration Guides

### Cursor

**File:** `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "pincushion": {
      "command": "npx",
      "args": ["pincushion-mcp", "--project-dir", "."]
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
      "args": ["pincushion-mcp", "--project-dir", "/path/to/your/project"]
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
      "args": ["dlx", "pincushion-mcp", "--project-dir", "/path/to/your/project"]
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
      "args": ["dlx", "pincushion-mcp", "--project-dir", "/path/to/your/project"]
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
claude mcp add pincushion -- npx pincushion-mcp --project-dir .
```

Or with Supabase sync:

```bash
claude mcp add pincushion -- npx pincushion-mcp --project-dir . --sync-url https://your-supabase.com/api --api-key YOUR_API_KEY
```

### VS Code (Copilot / Continue)

**File:** `.vscode/settings.json`

```json
{
  "mcp.servers": {
    "pincushion": {
      "command": "npx",
      "args": ["pincushion-mcp", "--project-dir", "${workspaceFolder}"]
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
      "args": ["pincushion-mcp", "--project-dir", "."]
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
      "args": ["pincushion-mcp", "--project-dir", "."]
    }
  }
}
```

### OpenAI Codex / REST API Clients

For tools that don't support MCP directly, use the REST API wrapper:

```bash
npx pincushion-mcp --rest --port 3456
```

This starts an HTTP server on `localhost:3456`. Endpoints:

- `GET /health` — Check server status
- `POST /call-tool` — Invoke a tool
  - Body: `{ "toolName": "get_feedback_summary", "args": {} }`

Example using curl:

```bash
curl -X POST http://localhost:3456/call-tool \
  -H "Content-Type: application/json" \
  -d '{"toolName": "get_feedback_summary", "args": {}}'
```

---

## CLI Flags

```bash
npx pincushion-mcp [flags]
```

| Flag | Description | Default |
|------|-------------|---------|
| `--project-dir PATH` | Root directory containing `.feedback/` | Current working directory |
| `--cloud-sync` | Enable sync with Pincushion cloud (requires `pincushion login`) | Disabled |
| `--sync-url URL` | Supabase API endpoint for self-hosted remote sync | None (local only) |
| `--api-key KEY` | API key for self-hosted Supabase authentication | None |
| `--license-key KEY` | Pro license key (optional) | None |
| `--rest` | Enable REST API mode | Disabled (uses MCP/stdio) |
| `--port PORT` | Port for REST API server | 3456 |

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

## Tools

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

## Cloud Sync (Zero-Config)

The simplest way to sync resolved pins with the Pincushion cloud so the browser extension reflects changes automatically.

**Step 1 — authenticate once per machine:**

```bash
npx pincushion-mcp login
```

This opens a browser sign-in page, performs Google OAuth, and saves a license key to `~/.pincushion/license-key`. You only need to do this once.

**Step 2 — add `--cloud-sync` to your MCP config:**

```json
{
  "mcpServers": {
    "pincushion": {
      "command": "npx",
      "args": ["pincushion-mcp", "--project-dir", ".", "--cloud-sync"]
    }
  }
}
```

Once enabled, `fix_and_resolve` pushes the resolved status to Pincushion's cloud and the browser extension reflects it within the next poll cycle. No Supabase account or API key required.

> **Stale session:** If pins stop syncing after resolving them (browser extension still shows READY), re-run `npx pincushion-mcp login` to refresh the license key.

---

## Supabase Sync (Self-Hosted)

To sync annotations with your own Supabase database:

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

### "Module not found" error

Make sure you have Node.js 18+ installed:

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
  "args": ["pincushion-mcp", "--project-dir", "."]
}
```

---

## Development

Clone the repository and install dependencies:

```bash
git clone https://github.com/jcooley8/pincushion-plugin.git
cd pincushion-plugin
npm install
```

Run the server:

```bash
npm start
```

Or with test data:

```bash
npm start -- --project-dir ./test-feedback
```

---

## License

MIT License. See LICENSE file for details.

---

## Support

- **Issues:** [GitHub Issues](https://github.com/jcooley8/pincushion-plugin/issues)
- **Docs:** [Pincushion Documentation](https://pincushion.io/docs)

---

## Changelog

### v1.0.0 (March 2026)

- Initial release
- Support for Cursor, Claude Desktop, Claude Code, VS Code, Windsurf, Antigravity
- Local `.feedback/` file support
- Supabase remote sync
- REST API wrapper for non-MCP clients
- New tools: `fix_and_resolve`, `get_setup_instructions`
