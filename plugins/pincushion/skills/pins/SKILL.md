---
name: pins
description: List the open Pincushion feedback pins for this project, grouped by page. Use when the user asks what feedback is open, what pins are pending, or what reviewers said.
---

# Show open Pincushion pins

1. Call `get_actionable_pins`. If the response starts with a Pincushion AI banner
   (lines starting with 🔔), show it first, unchanged.
2. If there are no pins, say so and stop.
3. Group the pins by page URL. For each pin show its ID, status, author and the
   first line of the comment. Flag pins with new thread replies. Pincushion AI
   pins are ordinary pins; just note the author.
4. If the user gave a status (for example "approved" or "open"), show only those.
5. Offer to implement the approved pins or resolve a specific one.
