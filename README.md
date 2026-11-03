<!-- 2026-11-03: replaced the top of the README with a one-step install and first steps for Claude Code, Cursor, VS Code, Cline, and any other MCP client. -->

# Pincushion

Teammates and clients pin feedback on your live app in
[Pincushion](https://www.pincushion.io). Each pin is a work packet for your
coding agent: page URL, CSS selector, screenshot, DOM snippet, viewport and the
comment thread. This repository is the install source for the Claude Code,
Cursor and Codex plugins and the MCP registry metadata for `pincushion-mcp`
(npm `1.12.5`).

Requires Node.js 22.22 or newer, or Node.js 24. Do not put a license key in
any MCP config. Sign-in writes `~/.pincushion/license-key` for you.

## Quick start

### Claude Code

```
claude plugin marketplace add jcooley8/pincushion-plugin
claude plugin install pincushion@pincushion
```

Codex uses the same marketplace: `codex plugin marketplace add jcooley8/pincushion-plugin`, then enable Pincushion from the Plugins list.

Start Claude Code in your app's repository. Run `/setup`, or run the sign-in command in [First steps](#first-steps). Then `/pins` lists open feedback and `/critique https://your-site.example` runs a Pincushion crit of that URL.

### Cursor

[Add Pincushion to Cursor](https://cursor.com/en/install-mcp?name=pincushion&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInBpbmN1c2hpb24tbWNwIl19).

That deeplink installs `npx -y pincushion-mcp` over stdio and does not set a license key. Restart Cursor in your app's repository, then follow [First steps](#first-steps). `/pins` and `/critique <url>` ship with the Cursor plugin in this repository.

### VS Code

```
code --install-extension pincushion.pincushion-feedback
```

Or install [Pincushion Feedback](https://marketplace.visualstudio.com/items?itemName=pincushion.pincushion-feedback) from the Marketplace. Reload the window in your app's repository, then follow [First steps](#first-steps).

To add the server without the extension, put this in `.vscode/mcp.json`:

```json
{
  "servers": {
    "pincushion": {
      "command": "npx",
      "args": ["-y", "pincushion-mcp@latest"]
    }
  }
}
```

### Cline

Add the `pincushion` entry from [llms-install.md](llms-install.md) to `cline_mcp_settings.json`. It is `npx -y pincushion-mcp@latest` over stdio, with no API key. Pin reads work before sign-in. The same page has the sign-in command.

### Any other MCP client

Add this stdio server. Start the client in your app's repository so the server's working directory is that repo. If the client starts somewhere else, append `"--project-dir"` and the absolute path of the repo to `args`.

```json
{
  "mcpServers": {
    "pincushion": {
      "command": "npx",
      "args": ["-y", "pincushion-mcp@latest"]
    }
  }
}
```

## First steps

In your app's repository, run:

```
npx -y pincushion-mcp setup
```

Setup opens a browser, signs you in, and links the repository to a Pincushion project. Restart the client, then ask: "show my open Pincushion pins."

Before that sign-in the server still starts. `get_actionable_pins`, `get_annotations` and `get_feedback_summary` read pins in this repo's `.feedback/` directory, and an empty workspace includes a sample pin that is not saved to your project. `claim_pin`, `fix_and_resolve`, cloud pins and critiques need the setup sign-in.

The Pincushion browser extension is optional. Pins can come from shared review links, Pincushion AI critiques, other agents and the REST API.

## License

The plugin files in this repository are MIT licensed. The `pincushion-mcp`
package they install carries its own license, published with the package on npm.
