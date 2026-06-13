# Page-snapshot capture recipe (annotated share reports)

The public share report (`pincushion.io/r/<token>`) renders an **annotated page**
— a full-page screenshot with pin markers at true positions — when a snapshot
exists for a page. This is how you capture one. Any headless browser works; the
steps below use gstack browse (Claude Code skill).

**Who runs this:** the dev/agent doing a crit, right after pins are dropped.
Owner/editor on the project (upload is rejected otherwise).
**When to re-run:** any time the page or its pins change — latest capture wins.

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

7. **Upload:**
   ```
   upload_page_snapshot({ projectId, pageUrl, imagePath, width, height, pinPositions })
   ```

8. **Verify:** reload `pincushion.io/r/<token>` (allow ~60s edge cache) and
   eyeball that each marker sits on its element; click a few to check the
   popovers.
