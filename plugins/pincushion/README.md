# Pincushion plugin for Claude Code and Codex

Teammates and clients pin feedback on your live app in
[Pincushion](https://www.pincushion.io). Each pin is a work packet: page URL,
CSS selector, screenshot, DOM snippet, viewport and thread. This plugin installs
the Pincushion MCP server and adds skills so your agent can read the pins,
implement the approved ones in your repository and record the commit on each pin.

## Install

Claude Code:

```
claude plugin marketplace add jcooley8/pincushion-plugin
claude plugin install pincushion@pincushion
```

Codex:

```
codex plugin marketplace add jcooley8/pincushion-plugin
```

Then enable Pincushion from the Plugins list.

Start the agent from your app's repository, then run the setup skill, or run
`npx -y pincushion-mcp setup` in that repository to sign in and link a project.

## Skills

| Skill | What it does |
| --- | --- |
| `setup` | Connects this repository to a Pincushion project |
| `pins` | Lists open pins by page |
| `implement` | Implements approved pins and records each commit |
| `resolve` | Closes one pin |
| `feedback-summary` | Summarizes open feedback and suggests an order |

Requires Node.js 22.22 or newer.

## What the plugin runs

For Claude Code, the plugin launches a vendored copy of the published
`pincushion-mcp` 1.12.5 server from `server/` with
`node ${CLAUDE_PLUGIN_ROOT}/server/cli.js --cloud-sync`. Nothing is fetched at
launch. The server's npm dependencies are pinned in `package-lock.json`, which
Claude Code installs when the plugin is installed. The server talks to
`pincushion.io` (and its Supabase backend) to sync pins for the project you
connect, reads and writes `.feedback/` in your repository, and stores your
sign-in key in `~/.pincushion/`. The vendored source is licensed under
`server/LICENSE.md` (FSL-1.1-Apache-2.0); the rest of the plugin is MIT.

The Codex plugin keeps launching the exact pinned package
(`npx -y pincushion-mcp@1.12.5`, see `.codex.mcp.json`). `npx -y pincushion-mcp setup`
works independently of either plugin.
