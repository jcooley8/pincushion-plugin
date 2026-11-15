---
name: setup
description: Sign in to Pincushion and connect the current repository to a Pincushion project from inside the agent, with no terminal. Use when the user asks to set up, connect or sign in to Pincushion, or when a Pincushion tool reports that no project or credential is connected.
---

# Set up Pincushion

Pincushion projects live in the web app at https://www.pincushion.io/app.
Teammates and clients pin feedback on the project's pages. This skill signs the
user in and links this repository to one project using the Pincushion MCP
server's setup tools. The browser extension is optional and never required.

## Rules

1. Never ask for a license key, password or token in chat. Never read
   `~/.pincushion/` or copy a credential into source, config or logs.
2. Never create or pick a project the user has not confirmed. Never pick the
   first match when several projects fit.
3. Run `doctor` instead if the `pincushion` MCP tools are not available in this
   session. Setup needs the server running.

## Steps

### 1. Check the folder and current state

Confirm the working directory is the user's app repository, not the plugin's
install directory. The server reads and writes `.feedback/` in the folder the
agent was started in.

Call `get_project_identity_diagnostic` with no arguments. It is read-only and
makes no network request. It reports whether a credential is present and which
project, if any, this folder already uses.

If the folder already has a confirmed project and the user did not ask to
change it, skip to step 5.

### 2. Sign in

If no credential is present, call `sign_in`. It returns a verification URL and
an expiry. Show the URL and ask the user to open it and finish sign-in (GitHub,
Google or an emailed link). When they say they are done, call `sign_in` again.
Continue only when it reports `signed_in`. The link stays valid for 15 minutes.

If the host signed in through hosted OAuth, skip this step: the server is
already signed in.

### 3. Propose the project

Call `propose_project_setup`. It detects a project name and URLs from the git
remote, `package.json`, the dev URL and an https homepage, and returns a
`proposalId`. Show the user the detected name and URLs and ask whether to
create that project, or to update an existing one. To list their existing
projects, call `get_project_context` with no arguments.

### 4. Confirm the project

Only after the user agrees, call `confirm_project_setup` with
`{ confirmed: true, proposalId }`. Add `projectId` to update an existing project
instead of creating one.

The project counts as set up only when the call succeeds. If it returns
`registration_not_acknowledged`, tell the user the reason it gives (for example
the Free plan's active-project limit) and stop. If it returns
`sign_in_required`, go back to step 2.

### 5. Verify with a real read

Call `list_setup_pins`. An empty list is a finished result, not an error. Show
the pins, or say the project has none yet, and include `links.app` so the user
can open the project.

### 6. Offer a first crit (optional)

If the project has no pins yet, offer a Pincushion crit of one of the project's
public https pages. Show the exact URL and ask first. Only after the user agrees,
call `start_first_crit` with `{ url, confirmed: true }`, then poll
`get_first_crit_status` with the returned token until it reports the findings.
Findings arrive as open pins: show them and call `approve_pin` only on the ones
the user wants fixed.

## Terminal fallback

If the setup tools are unavailable or fail, ask the user to run this in a
terminal in the repository, then restart the agent session:

```
npx -y pincushion-mcp setup
```

## Completion report

Report:

- signed in: yes or blocked (and why)
- project: name and id, created, updated or already set
- pin read: number of open pins, or none yet
- first crit: started, skipped or declined
