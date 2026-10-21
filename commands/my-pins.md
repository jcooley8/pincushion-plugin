---
description: Show Pincushion pins where you were @mentioned
argument-hint: "<username>"
---

Use the pincushion MCP tool `get_actionable_pins` with `mentionedUser` set to $ARGUMENTS (the username or @handle passed to this command) to fetch only the feedback pins where I've been @mentioned.

If no argument is provided, ask me for my username before proceeding.

Display results as a prioritized list:
- Show the pin ID, page URL, who left the feedback, and their comment
- Note how long ago the pin was created
- Flag any pins that are in "review" status (stakeholder is waiting on a response)

After listing, offer to claim the top item and start working on it.
