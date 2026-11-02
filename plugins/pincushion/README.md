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

Requires Node.js 22.22 or newer for `npx pincushion-mcp`.
