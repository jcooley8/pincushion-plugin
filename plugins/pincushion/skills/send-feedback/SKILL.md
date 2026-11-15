---
name: send-feedback
description: Send feedback about the Pincushion plugin or MCP server to the Pincushion team as a GitHub issue. Use only when the user asks to report a bug, request a feature or send feedback about Pincushion itself, not when they mean the feedback pins in their project.
---

# Send feedback to the Pincushion team

Feedback goes to the public issue tracker of the plugin repository,
https://github.com/jcooley8/pincushion-plugin/issues. This is about Pincushion
itself. Pins in the user's project are a different thing: use the `pins` skill
for those.

## Steps

1. Draft a short title and body from the user's words. Keep their wording. Add
   the environment only if they agree: host (Claude Code, Codex or Cursor),
   plugin version, Node.js version and operating system.
2. Remove secrets, license keys, tokens, email addresses, private URLs and
   customer data. If the user's wording contains any, ask them to rephrase
   instead of editing it silently.
3. Show the exact title and body, say the issue will be public, and ask before
   sending anything.
4. After the user agrees:
   - If `gh auth status` succeeds, run
     `gh issue create --repo jcooley8/pincushion-plugin --title "<title>" --body "<body>"`
     and give the user the issue URL it prints.
   - Otherwise give the user this link to open and submit themselves:
     https://github.com/jcooley8/pincushion-plugin/issues/new
     with the title and body ready to paste.

Never submit without the user's explicit yes.
