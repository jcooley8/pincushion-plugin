---
name: resolve
description: Close one Pincushion pin after its feedback has been addressed. Use when the user asks to resolve, close or mark a specific pin done.
---

# Resolve a Pincushion pin

1. If the user gave a pin ID, look it up with `search_annotations` or
   `get_actionable_pins` and show the comment, thread and status. Without an ID,
   list the pins with `get_actionable_pins` and let the user choose.
2. Call `claim_pin` if the pin is not already claimed.
3. Confirm with the user what was done.
4. If code changed, call `fix_and_resolve` with the description, `commitSha`,
   `branchName` and `prUrl` when available. If no code change was needed, call
   `resolve_annotation` with a short note.
5. Confirm the pin is closed.
