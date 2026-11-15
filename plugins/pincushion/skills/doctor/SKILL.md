---
name: doctor
description: Check whether Pincushion is ready in this agent without changing anything. Use when setup fails, the Pincushion tools are missing, sign-in or the linked project is unclear, pins don't show up, or the user asks whether Pincushion is working.
---

# Pincushion doctor

Run a read-only health check. Do not sign in, create or confirm a project,
claim, approve or resolve pins, or edit files. Never print credentials or read
`~/.pincushion/`.

## Checks

### 1. Plugin

Use only the command for the current host:

```bash
claude plugin list --json
codex plugin list --json
```

In Cursor, check **Cursor Settings → Plugins**; there is no plugin-list command.
Run the host command with `--help` first if a flag is rejected.

Record whether `pincushion` is installed and enabled, and its version. If the
version is current but the skills look old, recommend `/reload-plugins` in
Claude Code or a new session in the other hosts.

### 2. Node.js

```bash
node --version
```

The server needs Node.js 22.22 or newer in the 22.x line, or Node.js 24. On an
older Node the server exits at start and the error often goes only to the
host's MCP log, so the Pincushion tools simply don't appear. Report the version
and, if it is too old, tell the user to install Node.js 24 LTS.

### 3. MCP server

Check that the `pincushion` MCP tools are available in this session, for
example `get_project_identity_diagnostic`. If they are missing, check that the
server can start at all:

- Claude Code: `node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" --version`
- Codex and Cursor: `npx -y pincushion-mcp@1.14.0 --version`

A version number means the package runs; the host has not loaded the server.
Recommend restarting the session, then the host's MCP log if it still fails.

### 4. Sign-in and project

Call `get_project_identity_diagnostic` with no arguments. It is read-only, makes
no network request and never returns credentials. Report:

- authentication: signed in, or signed out
- project for this folder: the confirmed or configured project, several
  candidates (ambiguous), or none

Then call `get_project_context` with no arguments to confirm the account can
read its projects. It is read-only and never creates or changes a project.

### 5. Pin read

If a project is linked, call `list_setup_pins`. It is read-only. Report the
number of open pins. An empty list is a pass.

## Report

Return a compact table:

| Check | Status | Evidence or next step |
| --- | --- | --- |
| Plugin | Ready, warning or blocked | Installed version, reload advice |
| Node.js | Ready or blocked | Version |
| MCP server | Ready or blocked | Tools loaded, or the start check result |
| Sign-in | Ready or blocked | Signed in or signed out |
| Project | Ready, ambiguous or blocked | Project name and id |
| Pins | Ready or blocked | Open pin count |

Do not call Pincushion ready while any check is blocked or unverified. If
sign-in or the project is the blocker, suggest the `setup` skill.
