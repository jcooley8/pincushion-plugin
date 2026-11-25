# Pincushion plugin for Claude Code, Codex and Cursor

Teammates and clients pin feedback on your live app in
[Pincushion](https://www.pincushion.io). Each pin is a work packet: page URL,
CSS selector, screenshot, DOM snippet, viewport and thread. This plugin installs
the Pincushion MCP server and adds skills so your agent can read the pins,
implement the approved ones in your repository and record the commit on each pin.

## Install

Requires Node.js 22.22 or newer, or Node.js 24.

Claude Code:

```
claude plugin marketplace add jcooley8/pincushion-plugin
claude plugin install pincushion@pincushion
```

Codex:

```
codex plugin marketplace add jcooley8/pincushion-plugin
codex plugin add pincushion@pincushion
```

Cursor: import `https://github.com/jcooley8/pincushion-plugin` as a team
marketplace (**Plugins & MCPs → Add Marketplace → Import from Repo**), or link
this folder into `~/.cursor/plugins/local/pincushion`. See the repository
README for the commands.

Start the agent from your app's repository and run the `setup` skill
(`/pincushion:setup` in Claude Code). It signs you in with a browser link and
links the repository to a project without a terminal.

## Skills

| Skill | What it does |
| --- | --- |
| `setup` | Signs in and connects this repository to a Pincushion project |
| `doctor` | Read-only check of Node.js, the MCP server, sign-in, project and pins |
| `pins` | Lists open pins by page |
| `critique` | Runs `/critique <url>`: a Pincushion crit that drops at most three UI, copy, or accessibility pins per screen |
| `implement` | Implements approved pins and records each commit |
| `resolve` | Closes one pin |
| `feedback-summary` | Summarizes open feedback and suggests an order |
| `send-feedback` | Sends feedback about Pincushion itself to the team as a GitHub issue, after you confirm |

Cursor also loads the rules in `rules/` (quickstart demo, brand brief refresh,
Pincushion AI replies, crit of the latest deploy, pins that mention you).

## What the plugin runs

For Claude Code, the plugin launches a vendored copy of the published
`pincushion-mcp` 1.15.0 server from `server/` with
`node ${CLAUDE_PLUGIN_ROOT}/server/cli.js --cloud-sync`. Nothing is fetched at
launch. The server's npm dependencies are pinned in `package-lock.json`, which
Claude Code installs when the plugin is installed. The server talks to
`pincushion.io` (and its Supabase backend) to sync pins for the project you
connect, reads and writes `.feedback/` in your repository, and stores your
sign-in key in `~/.pincushion/`. The vendored source is licensed under
`server/LICENSE.md` (FSL-1.1-Apache-2.0); the rest of the plugin is MIT.

The Codex and Cursor plugins launch the exact pinned package
(`npx -y pincushion-mcp@1.15.0`, see `.codex.mcp.json` and `.cursor.mcp.json`). `npx -y pincushion-mcp setup`
works independently of any plugin.
