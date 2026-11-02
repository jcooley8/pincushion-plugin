---
name: implement
description: Implement the stakeholder-approved Pincushion pins in this repository, one page at a time, and record the commit on each pin. Use when the user asks to implement, fix or ship approved Pincushion feedback.
---

# Implement approved Pincushion pins

Only approved pins are implemented. Open pins wait for someone to approve them.

1. Call `implement_approved_pins`. It returns implementation packets grouped by
   page URL, each with the pins, their selectors, threads, acceptance criteria and
   a suggested branch name. If there are no approved pins, say so and stop.
2. Work one packet at a time. Stay on the current branch unless the user asks for
   the packet's suggested branch.
3. For each pin in the packet:
   - Call `claim_pin` with its annotation ID, unless it is already implementing.
   - Read the whole thread and the element context. Find the source by searching
     the repository for the selector, class names, tag and visible text.
   - Make the smallest change that satisfies the comment and any acceptance
     criteria. If the request is unclear, ask in the thread with
     `add_agent_reply` instead of guessing.
   - Commit with the pin ID as a trailer:
     `git commit -m "pincushion: <what changed>" -m "Pin-ID: <pinId>"`.
     Follow the packet's `traceability` settings when they ask for more trailers.
   - Call `fix_and_resolve` with the annotation ID, a one-line fix description,
     `commitSha` from `git rev-parse HEAD`, `branchName` from
     `git branch --show-current`, and `prUrl` when a pull request exists.
4. Summarize what changed per page, with the commit for each pin.
