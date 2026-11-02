# Pincushion

Teammates and clients pin feedback on your live app in
[Pincushion](https://www.pincushion.io). Each pin is a work packet for your
coding agent: page URL, CSS selector, screenshot, DOM snippet, viewport and the
comment thread. The Pincushion MCP server (`pincushion-mcp` on npm) lets your
agent read the pins, implement the approved ones in your repository and record
the commit on each pin.

This repository is the install source for the Claude Code and Codex plugin
marketplaces and the Cursor plugin.

## Install

### Claude Code

```
claude plugin marketplace add jcooley8/pincushion-plugin
claude plugin install pincushion@pincushion
```

### Codex

```
codex plugin marketplace add jcooley8/pincushion-plugin
```

Then enable Pincushion from the Plugins list.

### Cursor

[Add Pincushion MCP to Cursor](https://cursor.com/en/install-mcp?name=pincushion&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInBpbmN1c2hpb24tbWNwIl19)
in one click, or add the server below to `.cursor/mcp.json` in your repository.

### VS Code

Install [Pincushion Feedback](https://marketplace.visualstudio.com/items?itemName=pincushion.pincushion-feedback)
from the Visual Studio Marketplace, or add the server below with
**MCP: Add Server** from the Command Palette.

### Claude Desktop, Cline, Windsurf and any other MCP client

Add this server to the client's MCP settings, with your repository's path:

```json
{
  "mcpServers": {
    "pincushion": {
      "command": "npx",
      "args": ["-y", "pincushion-mcp", "--project-dir", "/path/to/your/repo"]
    }
  }
}
```

## First run

In your app's repository, run:

```
npx -y pincushion-mcp setup
```

It signs you in, links the repository to a Pincushion project and prepares the
editor you choose. Then ask your agent: "show my open Pincushion pins".

The Pincushion browser extension is optional. Pins can come from shared review
links, Pincushion AI critiques, other agents and the REST API.

Requires Node.js 22.22 or newer.

## License

The plugin files in this repository are MIT licensed. The `pincushion-mcp`
package they install carries its own license, published with the package on npm.
