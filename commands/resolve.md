---
description: Claim and resolve one Pincushion pin
argument-hint: "[pin-id]"
---

Resolve a Pincushion feedback pin. The pin ID should be passed as $ARGUMENTS.

Steps:
1. Use `get_actionable_pins` or `search_annotations` to look up the pin with the given ID and show me its full details — the original comment, any thread replies, and the current status.
2. Use `claim_pin` to claim it if it isn't already claimed.
3. Ask me to confirm what was done to address the feedback (or I can say "done" to auto-generate a resolution note based on recent git changes).
4. Use `fix_and_resolve` or `resolve_annotation` to mark it resolved, including the resolution note.
5. Confirm the pin is closed and summarize what was addressed.

If no pin ID is given, run `get_actionable_pins` first and let me pick one from the list.
