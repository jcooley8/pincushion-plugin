<!-- 2026-11-03: rewrote this for Cline. The settings entry is npx -y pincushion-mcp@latest over stdio, with what works before sign-in and how to sign in. -->

# Install the Pincushion MCP server in Cline

You are configuring Cline. Add one local stdio server. Do not ask the user for an API key, password, or license key, and do not put one in the settings file. The npm package is `pincushion-mcp`. Leave its version alone.

Requires Node.js 22.22 or newer, or Node.js 24. `npx` downloads the package. Nothing else is installed.

## 1. Write cline_mcp_settings.json

Cline CLI reads `~/.cline/data/settings/cline_mcp_settings.json`. If `CLINE_MCP_SETTINGS_PATH` is set, that path wins. In the Cline IDE panel, use MCP Servers → Configure → Configure MCP Servers and edit the file that button opens. Create the file and parent directories if they are missing.

If the file already has other servers, add the `pincushion` key inside the existing `mcpServers` object. Do not remove or rewrite the other servers.

Use this entry exactly. Transport is stdio (`command` + `args`). There is no `url`, `type`, or `env`.

```json
{
  "mcpServers": {
    "pincushion": {
      "command": "npx",
      "args": ["-y", "pincushion-mcp@latest"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

`npx -y pincushion-mcp@latest` is the whole command. Do not add `--license-key` or `PINCUSHION_LICENSE_KEY`. Cline's working directory should be the user's app repository. The server uses that directory when `--project-dir` is omitted. Add `"--project-dir", "/absolute/path/to/the/repo"` after the package name only when Cline will not start in that repository.

Cline also accepts the same command nested as `transport.type: "stdio"`. `cline mcp add pincushion --yes --transport stdio -- npx -y pincushion-mcp@latest` writes that nested form. Leave a nested entry in place. Write the flat entry above when you are editing the file yourself.

Restart Cline, or start a new task, so it loads the server.

## 2. What works before sign-in

The server starts with no key and does not show a rejected-key banner. These tools work immediately:

- `get_actionable_pins`, `get_annotations`, and `get_feedback_summary` read pins in the workspace `.feedback/` directory. When that directory has no pins, the response includes one sample pin and a local-only notice. The sample is not written to the project or to Pincushion.
- `get_project_context`, `get_setup_instructions`, and `start_quickstart_demo` are local reads. `start_quickstart_demo` copies a throwaway demo page under `.feedback/.quickstart/` and does not create a cloud pin.

`claim_pin` and `fix_and_resolve` change a pin and need a signed-in account. Cloud pins, share reports, invites, and `/critique` need sign-in too.

Confirm the process is up by calling a read-only tool, `get_feedback_summary` or `get_project_context`, before asking the user to sign in.

## 3. How to sign in

Ask the user to run this in their app repository, in their own terminal:

```
npx -y pincushion-mcp setup
```

Setup opens the user's browser, signs them in, and links the repository to a Pincushion project. It stores the key at `~/.pincushion/license-key`. Do not read that file, and do not copy the key into `cline_mcp_settings.json` or the chat.

When setup finishes, restart Cline. Call `get_project_context`, then `get_actionable_pins`. Sign-in is done when `get_project_context` returns the user's project.

The Pincushion browser extension is optional and is not part of this install.
