# Pincushion

Teammates and clients pin feedback on your live app in
[Pincushion](https://www.pincushion.io). Each pin is a work packet for your
coding agent: page URL, CSS selector, screenshot, DOM snippet, viewport and the
comment thread. This repository is the plugin marketplace for Claude Code, Codex
and Cursor and the MCP registry metadata for `pincushion-mcp`
(npm `1.15.0`).

**Requires Node.js 22.22 or newer, or Node.js 24.** On older Node the server
exits at start and the Pincushion tools just don't appear. Check with
`node --version`. Do not put a license key in any MCP config: sign-in writes
`~/.pincushion/license-key` for you.

## Quick start

One repository installs Pincushion in Claude Code, Codex and Cursor. Each host
gets the same skills: `setup` signs you in and links your repo to a project from
inside the agent, `doctor` checks what's missing without changing anything, and
`pins`, `critique`, `implement`, `resolve`, `feedback-summary` and
`send-feedback` do the work.

### Claude Code

```
claude plugin marketplace add jcooley8/pincushion-plugin
claude plugin install pincushion@pincushion
```

Start Claude Code in your app's repository and run `/pincushion:setup`. Then
`/pincushion:pins` lists open feedback and
`/pincushion:critique https://your-site.example` runs a Pincushion crit of that
URL. If anything looks off, run `/pincushion:doctor`.

### Codex

```
codex plugin marketplace add jcooley8/pincushion-plugin
codex plugin add pincushion@pincushion
```

Start a new Codex task in your app's repository and ask: "Set up Pincushion
for this repository." You can also install it from `/plugins` inside Codex.

### Cursor

For a team: in the Cursor dashboard open **Plugins & MCPs → Add Marketplace →
Import from Repo**, enter `https://github.com/jcooley8/pincushion-plugin`, then
install Pincushion from **Customize**.

For one machine, link the plugin folder into Cursor's local plugins and reload
the window (**Developer: Reload Window**):

```
git clone --depth 1 https://github.com/jcooley8/pincushion-plugin ~/.pincushion-plugin
mkdir -p ~/.cursor/plugins/local && ln -s ~/.pincushion-plugin/plugins/pincushion ~/.cursor/plugins/local/pincushion
```

Then ask the agent: "Set up Pincushion for this repository."

To add only the MCP server, without the skills:
[Add Pincushion to Cursor](https://cursor.com/en/install-mcp?name=pincushion&config=eyJjb21tYW5kIjoibnB4IiwiYXJncyI6WyIteSIsInBpbmN1c2hpb24tbWNwIl19).
That deeplink installs `npx -y pincushion-mcp` over stdio and sets no license
key. Restart Cursor in your app's repository, then follow
[First steps](#first-steps).

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

With a plugin installed, run the `setup` skill (above): it signs you in with a browser link and links the repository to a project without leaving the agent.

Without a plugin, run this in your app's repository:

```
npx -y pincushion-mcp setup
```

Setup opens a browser, signs you in, and links the repository to a Pincushion project. Restart the client, then ask: "show my open Pincushion pins."

Before that sign-in the server still starts. `get_actionable_pins`, `get_annotations` and `get_feedback_summary` read pins in this repo's `.feedback/` directory, and an empty workspace includes a sample pin that is not saved to your project. `claim_pin`, `fix_and_resolve`, cloud pins and critiques need the setup sign-in.

The Pincushion browser extension is optional. Pins can come from shared review links, Pincushion AI critiques, other agents and the REST API.

## License

The plugin files in this repository are MIT licensed. The `pincushion-mcp`
package they install carries its own license, published with the package on npm.
