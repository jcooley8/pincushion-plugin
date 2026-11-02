# Installing the Pincushion MCP server

Pincushion is a local stdio MCP server published on npm as `pincushion-mcp`.
It needs Node.js 22.22 or newer. No API key goes in the MCP settings.

1. Ask the user for the absolute path of the repository they want to connect.
2. Add this entry to the MCP settings file, replacing the path:

```json
{
  "mcpServers": {
    "pincushion": {
      "command": "npx",
      "args": ["-y", "pincushion-mcp", "--project-dir", "/absolute/path/to/repo"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

3. Ask the user to run this in that repository, in their own terminal, to sign
   in and link the repository to a Pincushion project:

```
npx -y pincushion-mcp setup
```

   Sign-in opens the user's browser. Do not ask the user for a password or key.

4. Check the connection by calling the `get_project_context` tool, then
   `get_actionable_pins` to list open pins.

The Pincushion browser extension is optional and is not needed for the MCP
server to work.
