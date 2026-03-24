# Pincushion — Cursor Plugin

View, claim, and resolve stakeholder feedback pins directly in Cursor.

This plugin installs the [Pincushion](https://pincushion.io) MCP server and adds four slash commands to your agent session — no config files, no manual setup.

## What it does

Pincushion lets stakeholders drop visual feedback pins on any web page via a Chrome extension. Developers (and their AI agents) read those pins via MCP and implement the fixes.

This plugin connects Cursor to your Pincushion project.

## Slash commands

| Command | What it does |
|---|---|
| `/pins` | Show all open feedback pins, grouped by page |
| `/my-pins` | Show pins where you've been @mentioned |
| `/resolve` | Claim and resolve a pin (pass an ID, or pick from a list) |
| `/feedback-summary` | Project-wide overview with priority order |

## MCP tools exposed

Once installed, your agent has access to:

- `get_actionable_pins` — fetch open pins with status/mention filters
- `get_feedback_summary` — project-wide counts and stale pin report
- `search_annotations` — search by keyword, URL, or author
- `get_component_feedback` — feedback for a specific CSS selector
- `claim_pin` — mark a pin as in-progress
- `add_agent_reply` — post a reply to a pin's thread
- `resolve_annotation` — mark a pin resolved with a note
- `fix_and_resolve` — apply a code fix and resolve in one step

## Requirements

- [Cursor](https://cursor.com) with MCP support
- Node.js (for `npx`)
- A [Pincushion](https://pincushion.io) account (free tier available)

## Manual MCP config

If you prefer to configure without the plugin, add this to `~/.cursor/mcp.json`:

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

Or use the one-click deeplink:
`cursor://anysphere.cursor-mcp/install?name=pincushion&command=npx&args=pincushion-mcp%20--project-dir%20.`

## Links

- [pincushion.io](https://pincushion.io)
- [Chrome Extension](https://chrome.google.com/webstore)
- [npm package](https://www.npmjs.com/package/pincushion-mcp)

## License

MIT
