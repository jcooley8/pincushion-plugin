---
name: critique
description: Run a Pincushion crit on a URL. Captures the page, drops at most three Pincushion AI UI, copy, or accessibility pins per screen, and returns the review. Use only when the user explicitly runs /critique or asks for a Pincushion crit of a URL.
disable-model-invocation: true
argument-hint: <url>
---

<!-- Added the Claude Code /critique skill. It runs a one-off Pincushion crit on a URL with the MCP tools get_project_context, get_project_write_authorization, get_annotations, create_critique_pin, and generate_critique_report. -->

# /critique

Ask for the page URL if the user did not supply one. This is a one-off Crit, not an implementation. Do not edit the repository.

`create_critique_pin` is the crit-running tool. Call it only from this command. Its description allows an explicitly requested Pincushion Crit and caps the run at three pins per page.

## Before capture

1. Call `get_project_context` with `{ url, view: "critic" }`. Stop unless it succeeds and the URL is registered on the connected project. Use `project.ai.critique.effectiveContext`, falling back to `project.ai.brandContext`. If that brief is missing or stale, say so and ask before inventing brand rules.
2. Call `get_project_write_authorization` with `{ projectId: project.projectId }`. Stop unless the same project id comes back with `authorized: true`.
3. Write that context's same-origin registered `urls` array to a local JSON file. Pass the file as `--inventory`.

## Capture

Use the plugin's vendored pincushion-mcp 1.12.5. Its `capture` command runs `scripts/capture-snapshot.mjs --critique`:

```
node "${CLAUDE_PLUGIN_ROOT}/server/cli.js" capture <url> <outputDir> --inventory=<registered-urls-json-file>
```

Add `--page-only` only when the user explicitly asks for one page. Add `--require-auth` for a signed-in app. Do not create login state. If auth is missing, stop and tell the user to run `npx -y pincushion-mcp snapshot --login <url> --proof-selector <selector-only-visible-when-signed-in>` first. Capture is unavailable on Windows; say so and stop instead of claiming a review.

Require `mode: "critique-v1"`, a status, discovery (default max 64), every discovered page, desktop and mobile `imagePath`, `pinPositions`, `hotspots`, and visible semantic evidence. Inspect the images. Report every missing route or device as a coverage gap. Do not label incomplete coverage complete.

## Pins

1. Call `get_annotations` with `{ projectId, pageUrls, view: "critique" }` and skip findings that duplicate an existing pin.
2. Review every discovered screen. Rank the top 8 findings across the run and keep at most 3 per screen. Each one needs a unique visible selector and a concrete UI, copy, or accessibility fix. Zero findings is valid.
3. Make one `critiqueRunId`. For each finding call `create_critique_pin` with that id, `pageUrl`, `selector`, `body` (under 40 words: element, problem, fix), `severity` (`high` or `medium`), and `visibility` (`"public"` on a public route, `"project_members"` on a signed-in app).
4. Re-read with `get_annotations` `{ projectId, pageUrls, view: "critique", critiqueRunId }` and keep the exact pin ids.

## Report

After the pins exist, capture again with `--pins=<json-or-file>` so each pin has a real position. Then call `generate_critique_report` with `projectId`, `purpose: "critique"`, the matching `accessMode`, `coverage`, `critiqueRunId`, the exact `critiquePinIds`, and `screens` (desktop and mobile for every screen). For zero good findings, use `purpose: "capture"` and the label "no AI findings", and still return the review surface.

Public pages stay headless. A headed browser is only for the initial `snapshot --login`. Do not publish private pixels or signed-in findings on a public report. Return the review link, access mode, coverage gaps, and how many pins were saved.
