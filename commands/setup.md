---
description: Connect this project to Pincushion and compile its critique brief
---

# Pincushion Setup

Connect this project to Pincushion so teammates and clients can pin feedback on its pages from the Pincushion app and your agent can read those pins, **and** compile a critique-context brief grounded in the actual page sources sitting in this repo. If the owner already created the project in the app (https://www.pincushion.io/app), pass its `projectId` to `configure_project` instead of creating a new one. The Pincushion AI critic reads this brief on every pin.

Run this once per project. You'll need:
- A project name
- The local URL where you develop (e.g. `localhost:3000`)
- The live/staging URL — optional but recommended. Ask for it; never guess it from the package name
- A choice of comment access mode (Pro/Team only — Free is always "open")

## Steps

1. **Ask the user (don't assume)** which comment-access mode they want:
   - **Open** — anyone with the review link can comment. Best for indie projects, public betas, pre-launch demos. Free, Pro, Team.
   - **Domain-restricted** — only emails matching a list of domains. Requires Pro or Team.
   - **Invite-only** — only emails the owner explicitly adds. Requires Pro or Team.

   Separately ask: “May I inspect locally detected deployment candidates and, only after you choose one and explicitly approve, begin optional deployment automation?” Only explicit owner consent authorizes the optional `deploymentAutomation: "auto"` field below; otherwise omit it.

2. Call `configure_project`:

```
configure_project({
  name: "<project name>",
  urls: ["localhost:3000", "myapp.vercel.app"],
  commentAccess: "open" | "domain" | "invited",
  allowedDomains: ["acme.com"]   // only if commentAccess: "domain"
})
```

Save the returned `projectId` for step 4.

If local detection finds multiple candidates, ask the owner to select `deploymentProvider`; do not call a provider while it is ambiguous. If the owner explicitly authorized automation, add `deploymentAutomation: "auto"` (and the selected provider when needed) to that call. A successful response confirms provider read-back only; the first accepted production receipt is still pending. Unsupported provider APIs require the returned redacted manual setup handoff. Use `get_deployment_reconciliation_status` for independent reconciliation, fresh desktop/mobile frames, queue, and external Crit evidence. Do not modify source or CI without owner approval.

3. **Detect the framework + project type.** This determines where the page sources live and what shape the brief should take.

   **Framework detection** — read `package.json` once, then look for the matching config/route directory:

   | Framework signal in package.json | Routes directory |
   |---|---|
   | `next` | `app/` (App Router) or `pages/` (Pages Router) |
   | `@sveltejs/kit` | `src/routes/` |
   | `astro` | `src/pages/` |
   | `@remix-run/*` | `app/routes/` |
   | `nuxt` | `pages/` |
   | `solid-start` | `src/routes/` |
   | `gatsby` | `src/pages/` |
   | `vite` + `react-router` | grep for `<Route` definitions, usually `src/App.tsx` or `src/router*` |
   | `vue` + `vue-router` | usually `src/router/index.*` or `src/routes/` |
   | (none of the above, `.html` files at project root) | static HTML — each top-level `.html` is a route |

   **Project type** — read 2-3 representative route files (the home/index plus one or two others) and classify:
   - **marketing** — pages are mostly hero copy, headlines, CTAs, pricing tables, testimonials. Components like `<Hero>`, `<PricingTable>`, `<TestimonialGrid>`.
   - **app** — pages are mostly forms, tables, dashboards, role-aware layouts, data fetching. Components like `<DataTable>`, `<FormField>`, `<DashboardCard>`, server actions, RSC, auth gates.
   - **mixed** — repo contains both a marketing slice (e.g. `app/(marketing)/`, separate `landing/` folder, `pincushion-landing/`) AND an app slice. Common for SaaS.

   Don't agonize on this — pick one. The brief template flexes based on this hint, but the agent re-reads sources at compile time so a wrong guess auto-corrects.

4. **Walk the route tree.** Read the full set of user-facing page sources. For each route file (capped at ~15 to keep token cost bounded — pick the most representative if there are more), extract:
   - The page's URL path (derived from filename)
   - All headings (`<h1>` … `<h3>` or `<Heading>` components)
   - All CTAs / button text / link text
   - The first ~200 chars of body copy
   - Component names imported at the top (signals which design-system primitives are in use)

   For mixed projects, walk both slices — but tag each extracted snippet with its slice (`marketing` vs `app`) so the brief can call out tone differences between them.

5. **Also read the lighter-weight repo signals:**
   - `README.md` — first 60ish lines (stated mission, audience)
   - `package.json` description
   - Theme tokens — `tailwind.config.{js,ts}`, `theme.{ts,css}`, `styles/tokens.css`, or inline `:root { --color-…: }` blocks. Pull primary brand colors + font families.
   - `BRAND.md`, `VOICE.md`, `STYLE.md`, design-system docs — if present, treat as ground truth and let it override anything the page-source walk inferred.

6. **Ask the user (briefly) only for what code can't reveal:**
   - "Tone in one phrase?" (only if the page-source walk gave conflicting signals)
   - "Top 2-3 competitors or reference products?"
   - "Anything the critic should NOT pin on?" (e.g. "we ship without AAA contrast", "don't critique the pricing copy — that's set by product")

   Skip questions whose answer is obvious from the source. Don't grill.

7. **Synthesize a compiled brief (~600-1500 words of markdown).** The template *flexes* based on `projectType`. Skip sections that don't apply.

   ```markdown
   # <Project name> — Critique Brief

   ## What this product is
   <1-2 sentence summary grounded in README + landing/home route>

   ## Audience
   <who uses it + what they care about; for app projects, name the primary user roles>

   ## Page inventory                              ← always include
   <bulleted list of the routes you walked, with one-line "what's on this page" per route>

   <!-- marketing-heavy sections — include only when projectType is marketing or mixed -->
   ## Mission / positioning
   <one-line UVP>

   ## Voice & tone
   <2-3 adjectives + DO/DON'T bullets with concrete phrases from the actual route sources>
   - DO: <example>
   - DON'T: <example>

   ## Competitors / reference products
   <comma-separated with 1-line differentiator>

   <!-- app-heavy sections — include only when projectType is app or mixed -->
   ## Terminology
   <table or list of the product's core nouns + the verbs it uses for primary actions, drawn from the route sources. e.g. "Invoice" not "Bill"; "Send" not "Submit". This is what the critic uses to flag terminology inconsistency.>

   ## Workflow stage conventions
   <how the product treats empty / loading / error / disabled / success states; what affordances exist for each user role>

   ## Role-aware UI rules
   <which routes are role-gated; what each role can and cannot do — derived from auth guards in the source>

   ## Product-lens priorities
   <3-5 bullets telling the critic what to weight for THIS app — e.g. "first-run onboarding is the wedge — weight empty states and step-1 clarity highest", "billing flows must never dead-end", "terminology drift between the marketing slice and the app slice is a known problem". The critic's product lens (flows, empty/error states, terminology, trust) uses these to rank candidates.>

   <!-- always include -->
   ## Visual identity
   <primary colors, fonts, key tokens — only what's load-bearing>

   ## Critique policy
   <weighting rules from step 6 — copy ones the user gave verbatim, plus any rules implied by what you read>

   ## Out of scope for critique
   <anything the user said not to pin on; anything inferred (e.g. "pricing copy is product-owned, don't critique")>
   ```

   Keep it tight — 8192 chars is the hard cap.

8. **Persist via `update_critique_context`:**

   ```
   update_critique_context({
     projectId: "<from step 2>",
     critiqueContext: "<compiled brief from step 7>",
     critiquePolicy: "<user's hand-written rules from step 6, or null>",
     critiqueSignals: {
       framework: "next-app-router" | "astro" | "static-html" | "...",
       projectType: "marketing" | "app" | "mixed",
       pages: [
         { url: "/", source: "app/page.tsx", slice: "marketing",
           headings: ["..."], ctas: ["..."], components: ["Hero", "..."],
           bodyExcerpt: "..." },
         { url: "/pricing", source: "app/pricing/page.tsx", slice: "marketing", ... },
         { url: "/dashboard", source: "app/(app)/dashboard/page.tsx", slice: "app", ... },
         ...
       ],
       themeTokens: { colors: { primary: "#..." }, fonts: [...] },
       brandDocs: [ { path: "BRAND.md", excerpt: "..." } ],
       readmeExcerpt: "...",
       competitors: ["..."],
       mission: "...",
       audience: "...",
       tone: "...",
       // Reserved for future multi-tenant SaaS support (Salesforce-shape projects
       // where one deployed app serves many client orgs, each with their own
       // branding/terminology). Leave null in v1. When populated, the critic
       // will pick the brief matching the pin's pageUrl prefix.
       tenantContexts: null,
       sources: [
         { type: "framework_config", path: "next.config.mjs" },
         { type: "tailwind_config", path: "tailwind.config.ts" },
         ...
       ]
     }
   })
   ```

9. To invite collaborators, create an invite link and share it (works on every plan). Invitees join, open a review in the Pincushion app, and pin feedback. Nothing to install.

```
create_invite_link({ projectId: "<id>", role: "commenter" })
```

## What happens
- URLs registered in Supabase; reviewers pin on the project's reviews in the Pincushion app
- The compiled brief is stored on the project row; the AI critic reads `ai.critique.effectiveContext` on every pin
- Stakeholders are always free — paid seats are for developers only

When the product evolves (new routes, refreshed copy, lots of resolved pins teaching new patterns) run `/refresh-brand` to recompile. The project context surfaces `staleness: "aging"` at 30 days and `"stale"` at 60.

## Multi-tenant SaaS note (Salesforce-shape projects)

If you're shipping a single app to many client orgs that each customize branding + terminology, leave `critique_signals.tenantContexts` null in v1 — the critic uses the project-wide brief. When tenancy support lands, you'll populate `tenantContexts: { "/acme/*": { ... }, "/globex/*": { ... } }` and the critic will route by pin URL prefix. No schema change required.
