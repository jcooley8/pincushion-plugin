# Page-snapshot capture recipe (annotated share reports)

The public share report (`pincushion.io/r/<token>`) renders an **annotated page**
— a full-page screenshot with pin markers at true positions — when a snapshot
exists for a page. This is how you capture one. Any headless browser works; the
steps below use gstack browse (Claude Code skill).

**Who runs this:** the dev/agent doing a crit, right after pins are dropped.
Owner/editor on the project (upload is rejected otherwise).
**When to re-run:** any time the page or its pins change — latest capture wins.

**Reconciling after each deploy (Pro/Team):** every accepted production receipt
creates a frame-refresh obligation independently of pin, Crit, queue, or
`autoCritique` state. The executor reads the deployment event plus its frozen page
scope and per-device baseline receipts, probes rather than assuming every page
changed, and stages newly rendered desktop/mobile JPEG bytes for every accepted
non-removed page — including pages classified unchanged. Only an exact fresh
run-bound pair for each page lets the backend atomically advance the canonical
capture-purpose report. A zero-pin or zero-change deployment cannot satisfy that
gate with metadata alone.
`/snapshot-latest-deploy` is a compatibility alias to that same checkpoint — do
not schedule it separately or it can race Crit completion. The shipped script
finds or self-provisions a headless browser on Node-capable surfaces and keeps
auth state local/origin-bound. Free-tier projects still capture manually below.

> **⚠️ Use the canonical tool — do not hand-roll.** Run the capture script
> (`node capture-snapshot.mjs <pageUrl> <pinsJsonOrFile> <outJpeg.jpg>`, pins =
> `{ "<annId>": { "selector": "...", "relX": null, "relY": null } }`). It implements
> every step below correctly and self-reconciles the coords to the real captured image.
> It ships to customers at **`pincushion-mcp/scripts/capture-snapshot.mjs`** (resolve
> via `require.resolve('pincushion-mcp/package.json')`); the internal crit-engine copy
> lives at `marketing/growth/crit-engine/capture-snapshot.mjs`. The manual steps are a
> fallback for when you can't run Node.

> **Deploy reconciliation mode:** `node capture-snapshot.mjs --reconcile <rootUrl>
> <outputDir> --inventory=<json-or-file> --previous-receipts=<json-or-file>` probes
> the known/discovered inventory in one browser context and captures fixed 1280×900
> desktop plus 390×844 mobile evidence. It derives a bounded semantic hash and
> decoded-pixel tile fingerprint from two settled captures. Deployment-frame
> mode emits a new JPEG pair for unchanged pages as fresh-render evidence; it
> never reuses the baseline version bytes. Before a caller stages or reports any output, it must send
> the exact bounded `discoveredPageUrls` to
> `register_deployment_discovered_pages({ deploymentId, pageUrls })`; only the
> returned accepted pending page rows may be uploaded or reported. A caller then
> stages only returned changed/added files with the deployment ID, exact image
> SHA-256, and bounded fingerprint. Login redirects, denied access, timeouts,
> and ambiguity are never uploaded as page captures. If a page-result request is
> uncertain, retry the exact same body only: `idempotent: true` is success and
> must not trigger a replacement upload.
> Existing committed captures that predate v1 fingerprints are
> `bootstrap_required` when valid current desktop and mobile evidence exists:
> stage both as an `updated` result rather than marking unchanged or failing
> forever. Only invalid/missing **current** evidence remains a failed result.
>
> **Authenticated reconciliation gate:** public pages may run without auth state,
> yielding receipt `auth.mode: "anonymous"`. For an authenticated target, set
> `PINCUSHION_STORAGE_STATE` to the local state saved for that exact origin and
> add `--require-auth`. Create that state with `snapshot --login` plus an
> explicit `--proof-selector` that is visible only to signed-in users on every
> authenticated route. A supplied or required state is never optional: missing,
> unreadable, symlinked, non-regular, insecure, malformed, origin-mismatched,
> credential-free, missing its matching proof, or non-visible proof is a hard
> failure (exit 6). This makes a neutral signed-out 200 shell ineligible before
> it fingerprints or writes any upload-eligible file. The initial target and
> every redirect are pre-checked; a private/reserved DNS/IP answer is rejected
> before navigation. Require `auth.mode: "authenticated"` in the output; never
> stage/upload/record a non-success as current.

### Opt-in local deployment-frame runner

The MCP package contains the bounded local executor, but it is intentionally
inactive by default because enabling it launches a browser and uploads production
page images whenever eligible deployment work appears. Set
`PINCUSHION_AUTO_FRAME_REFRESH=1` in the MCP server environment only after the
project owner authorizes that ongoing transfer. The runner also requires one
unambiguous project, authoritative cloud credentials, and a public or explicitly
configured authenticated capture state. For signed-in pages, provide only the
origin-bound `PINCUSHION_STORAGE_STATE` file described below.

When enabled, the runner polls the redacted frame queue, discovers and registers a
bounded page scope, starts one short-lived proof-bound run, receives the previous
desktop/mobile receipts atomically with that run, and captures only the exact
accepted URLs. It uploads both new JPEGs even when their fingerprints match,
records the terminal page result, and requests completion. It never sends the run
proof, cloud key, storage-state contents, or baseline receipts to the browser
child's command line or logs. The child cannot self-install software; the package
ships a pinned browser-control library and uses an existing supported Chrome or
Chromium binary, otherwise the obligation remains pending.
>
> **⚠️ NEVER size the viewport to the page height to "get the whole page."** A headless
> full-page screenshot already captures beyond the fold at a **fixed 1280×900** viewport.
> Forcing the viewport to `scrollHeight` balloons `100vh` / `min-height:100vh` sections
> into huge whitespace **and** shifts content so pins land in blank space — this is the
> exact bug that produced a whitespace-ridden report. Capture full-page at 1280×900; if
> the captured image is much taller than the measured `scrollHeight`, you ballooned it
> (the script scales coords to the real image and warns; a hand-roll won't).

## Steps

1. **List the pins for the page** — `get_annotations({ pageUrl })`. Note each
   open pin's `id` and `element.selector`, and the **exact `page_url` string**
   they carry. The snapshot is keyed by that string verbatim (trailing slash,
   `www.`, everything). Roast-motion note: the project must be registered with
   `commentAccess: 'open'` (the default) so a recipient's fresh account can see
   these pins live after signing up.

2. **Open the page** at viewport 1280×900.

3. **Kill scroll-reveal animations** so below-the-fold content isn't captured
   blank:
   ```js
   const s = document.createElement('style');
   s.textContent = '*{animation:none!important;transition:none!important;opacity:1!important;transform:none!important}';
   document.head.appendChild(s);
   ```

4. **Force lazy loads:** scroll to the bottom in ~80%-viewport steps with short
   waits, then back to the top.

5. **Resolve pin coordinates** (one JS eval) in document pixels, plus the page
   dimensions. **Use the pin's stored `relX`/`relY` (its click point WITHIN the
   element), not the element center** — exactly how the extension re-renders a
   pin (`rect.left + relX*rect.width`, content.js ~2805). Element center is
   wrong for large containers: a pin dropped at the top of a tall `#waitlist-form`
   lands hundreds of px off if you use the center. Pull `relX/relY` from
   `get_annotations`/DB (`pin.relX`, `pin.relY`); selector-only pins (AI critic,
   no `relX/relY`) fall back to center.
   ```js
   // pins: { annotationId: { selector, relX, relY } }  (relX/relY may be null)
   const pins = {/* … */};
   const out = { width: window.innerWidth, height: document.documentElement.scrollHeight, positions: [] };
   for (const [id, p] of Object.entries(pins)) {
     const el = document.querySelector(p.selector);
     if (!el) continue; // unresolvable → pin stays card-only, that's fine
     const r = el.getBoundingClientRect();
     const fx = Number.isFinite(p.relX) ? p.relX : 0.5;  // click point, else center
     const fy = Number.isFinite(p.relY) ? p.relY : 0.5;
     out.positions.push({ annotationId: id, x: r.left + fx*r.width + scrollX, y: r.top + fy*r.height + scrollY });
   }
   JSON.stringify(out)
   ```
   (Strip extension-injected classes like `.__fp_html--panel-open` from stored
   selectors before `querySelector` — they won't match a clean page load.)

6. **Full-page screenshot**, then convert/downscale to **1280px-wide JPEG q80**
   (`sips -Z`, `cwebp`, etc.). Must be ≤5 MB (drop to q70 if not). **If the
   capture's pixel width ≠ the width from step 5, scale all x/y and
   width/height by the same factor** — coordinates and image must share one
   space.

7. **Upload:** include the exact capture context. For responsive reviews,
   repeat the capture at each real viewport (for example desktop and 390px
   mobile), resolving every pin against that capture again. Never scale a
   desktop image into a phone frame or reuse its coordinates.
   ```
   upload_page_snapshot({ projectId, pageUrl, imagePath, width, height, pinPositions,
     captureContext: { deviceClass: 'mobile', cssWidth: 390, cssHeight: 844,
       dpr: 3, orientation: 'portrait', platform: 'iPhone', browser: 'Mobile Safari' } })
   ```
   Each successful upload returns a `versionId`. `generate_critique_report`
   carries the version returned for each of its uploads into its manifest, so a
   report binds the image that was actually captured instead of silently
   substituting a later “latest” screenshot.
   Reports show a device selector only after at least two real device classes
   exist. This supports responsive/mobile web captures; it is not a native
   iOS or Android capture path.

8. **Verify:** reload `pincushion.io/r/<token>` (allow ~60s edge cache) and
   eyeball that each marker sits on its element; click a few to check the
   popovers.

## Capturing pages behind login (authed apps)

The free crit lands on your public page; the real critique is your *actual app* —
onboarding, empty states, the flows behind the login wall. To snapshot an authed
page headlessly:

```
npx pincushion-mcp snapshot --login https://app.example.com/dashboard --proof-selector '[data-testid="signed-in-account-menu"]'
```

This opens a real browser window at that URL. **Sign in**, then press Enter in the
terminal. The session is saved to `~/.pincushion/auth/<domain>.json` (`chmod 600`)
with an owner-only `.proof.json` sidecar that binds the exact state bytes and
origin to that explicit selector — neither file leaves your machine. Pick a
selector for a real signed-in-only app element (not `body` or a generic shell)
that remains visible on every route the reconcile command will capture. Headless
capture (`scripts/capture-snapshot.mjs`, and the `/snapshot-latest-deploy` routine
that drives it) reuses the already securely parsed state via the
`PINCUSHION_STORAGE_STATE` env var, so the page renders logged in. **Only the
rendered image uploads — cookies, tokens, state, and proof stay local.** Use the
saved state only for its matching origin and pass `--require-auth` for an
authenticated capture. If the state/proof is absent, unreadable, unsafe,
malformed, no longer origin-bound, mismatched, rejected, redirected to sign-in,
or the selected signed-in proof is not visible, capture exits 6 and writes no
current/upload-eligible receipt. A public capture without supplied/required
state remains anonymous. Initial targets and every redirect also undergo bounded
DNS validation; private/reserved addresses are rejected before the browser
navigates. Re-run `snapshot --login` to refresh the pair.

For the *interactive* path (the Pincushion AI critic browsing your live app), you
don't need this at all — just be signed in to the app in the browser
Claude-in-Chrome controls, and run `/critique`.
