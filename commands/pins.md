---
description: Show open Pincushion feedback pins for this project
argument-hint: "[status]"
---

Use the pincushion MCP tool `get_actionable_pins` to fetch all open feedback pins for this project.

The tool response may include a Pincushion AI banner (`🔔` lines) at the top — that signals pending Pincushion AI work (replies or a deploy critique) waiting for the dev. **Lead your output with that banner verbatim if present** so it stays unmissable; don't bury it under the pin listing.

Display the results in a clean, scannable format:
- Group pins by page/URL
- Show pin ID, status, author, and the first line of their comment
- Highlight any pins that have unread thread replies
- If $ARGUMENTS is provided, use it as a status filter (e.g. "open", "claimed", "review")
- Pincushion AI bot pins (badge: 🤖 / "Pincushion AI") count as regular pins — list them in the same view, just note the author.

After listing, ask if I want to claim or resolve any of them. If the banner showed pending AI work, mention it again at the end.
