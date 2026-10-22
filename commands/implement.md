---
description: Implement all stakeholder-approved Pincushion pins
---

Implement all stakeholder-approved Pincushion pins.

## Workflow

1. Call `implement_approved_pins` to get all approved pins grouped by page with element selectors and thread context.
2. If no approved or in-progress pins exist, say so and exit.
3. If a git command fails with "Unable to create ... .lock: File exists", tell me which lock file it is and ask before removing it.
4. For each pin:
   - Call `claim_pin` with the pin's annotationId to mark it in-progress (skip if already in-progress)
   - Read the full thread and element context (selector, tagName, textContent)
   - Use the element selector and comment to find the relevant source code (grep for the selector string, tag name, class names, or text content in the project files)
   - Look up the project's traceability config from the `traceability[pin.projectId]` block of the `implement_approved_pins` response. Defaults if absent: `{ commitTrailers: 'minimal', attributionComments: 'off', recordCommitSha: true }`.
   - Implement the requested change on your current branch (do NOT create or switch branches).
   - Inline comment policy: leave a one-line `// Pincushion <pinId>: <WHY>` only when `attributionComments` is `'context-warrants'` AND the pin captures a non-obvious WHY (a constraint, intent, or rationale not self-evident from the diff). Skip for cosmetic fixes (typos, color tweaks, copy edits). When `'always'`, leave the comment regardless. When `'off'` (default), never.
   - Commit using the trailer block matching the project's `commitTrailers`:
     - `'minimal'` (default): `git commit -m "pincushion: <description>" -m "Pin-ID: <pinId>"`
     - `'standard'`: also include `Reviewed-By: <pin.approvedBy>` on a new line — but ONLY if `approvedBy` differs from your `git config user.email` (skip self-approval; double-attributing the same person is noise).
     - `'full'`: standard plus `Pincushion-Pin-Url: <pin.pincushionPinUrl>`.
     - Use a multi-line `-m` body or a single `-m "$(cat <<'EOF'\n...\nEOF\n)"` HEREDOC to fit all trailers cleanly.
     - Per-shell kill switch: if env `PINCUSHION_TRAILERS=off` is set, fall back to `'minimal'` regardless of project preset.
   - Capture the commit SHA: `SHA=$(git rev-parse HEAD)`. Pass it to `fix_and_resolve({ annotationId, fixDescription, commitSha: SHA })`. The MCP records it on the annotation only if `recordCommitSha` is true (default).
5. Summarize what was implemented.
