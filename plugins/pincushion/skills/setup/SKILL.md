---
name: setup
description: Connect the current repository to a Pincushion project so the agent can read its feedback pins. Use when the user asks to set up, connect or sign in to Pincushion, or when a Pincushion tool reports that no project or credential is connected.
---

# Connect this repository to Pincushion

Pincushion projects live in the web app at https://www.pincushion.io/app.
Teammates and clients pin feedback on the project's pages there or from a share
link. The browser extension is optional and never required for this setup.

1. Confirm the working directory is the user's app repository, not the plugin's
   install directory. The `pincushion` MCP server reads pins for the directory the
   agent was started in.
2. Call `get_project_context` with no arguments. It is read-only and lists the
   projects this credential can reach. If identity is unclear, call
   `get_project_identity_diagnostic`. Never call `configure_project` just to look
   a project up.
3. If no credential is connected, ask the user to run this in a terminal in the
   repository and finish the browser sign-in:

   ```
   npx -y pincushion-mcp setup
   ```

   Setup signs in, links the site to a project and prepares the editor the user
   picks. Never ask for a license key in chat, read credential files, or copy a
   credential into source, config or logs. After setup, restart the session so
   the MCP server reloads.
4. If several projects could match, ask the user which one. Never pick the first
   result. Register a new project with `configure_project` only after the user
   names it and confirms its URLs.
5. Finish by calling `get_actionable_pins` and showing the result. Setup is done
   only when a real pin read works for the intended project.
