# Slack App Directory Submission Package — Pincushion

Updated for the Figma-style DM-first model (May 2026 rewrite). The technical install path is shipped: manifest at [SLACK_APP_MANIFEST.yml](SLACK_APP_MANIFEST.yml), public install URL at `https://pincushion.io/install/slack`. This doc covers what Slack reviewers want to see.

Slack's review process typically takes **2–6 weeks**. They reject submissions for missing screenshots, weak privacy policies, unclear value props, and listing pages that don't match the app's actual behavior.

---

## Prerequisites (must be true at submission time)

- [x] Public Distribution toggled on (Slack app settings → Manage Distribution)
- [x] Redirect URL on `*.functions.supabase.co` is reachable and returns proper HTML/JSON
- [x] Privacy policy at https://pincushion.io/privacy is publicly available and explicitly mentions Slack data
- [x] Terms at https://pincushion.io/terms is publicly available
- [x] Support page at https://pincushion.io/support exists with a real human contact
- [x] Events API endpoint signed with `SLACK_SIGNING_SECRET` (rejects unsigned + replay-protected via 5-min timestamp window)
- [x] Slash command `/pincushion` registered at `slack-events` URL
- [ ] App icon: 512×512 PNG (no transparency, square, brand-aligned)
- [ ] App banner: 1920×1080 PNG (no text in safe zones)
- [ ] At least 4 screenshots of the integration in action (1280×800 PNG)
- [ ] 30–60 second demo video (mp4, ≤ 50MB)
- [ ] Long description in the listing matches what the app does (don't oversell)

## Listing copy (paste into Slack's listing form)

### Short description (140 chars max)
```
Visual pin feedback for shipping web apps — the bot DMs you when there's pin activity on your projects. Channels are opt-in.
```

### Long description
```
Pincushion lets your stakeholders drop visual pins on any web page; the bot DMs you whenever there's activity on a project you're involved in. Inspired by Figma's notification model: personal DMs first, channel broadcasts only when you ask.

What lands in your DMs (configurable per-event in the App Home):
  • New pins on your projects
  • Pins ready for implementation
  • @-mentions of you in any pin thread
  • Replies in threads you've commented on
  • Resolved pins (so you know it shipped)

Tune per-event toggles, mute for 1h/today/forever, or set quiet hours from the Pincushion App Home tab. Reply in any pin thread — your reply syncs back to Pincushion.

Channel broadcasts are opt-in. In any channel, type:
  /pincushion subscribe <project-id-or-url>
  /pincushion list
  /pincushion unsubscribe <project-id>

Install Pincushion in your workspace once and it automatically links to your Pincushion account if your Slack profile email matches. No webhook URLs to copy, no JSON to paste.

Free tier: 1 project, unlimited pins, full Slack integration.
Pro ($19/mo): unlimited projects + Realtime sync.
Team ($49/mo): 3 seats + collaboration.
```

### Categories (pick 1–3 from Slack's list)
- Productivity
- Developer Tools
- Design

### Bot interaction model
The bot DMs users by default and posts to channels they explicitly subscribe via `/pincushion subscribe`. Bot user is `@pincushion`; users can `@pincushion` in a channel to learn more.

---

## Security & data handling responses

Slack reviewers ask explicit questions in this section. Pre-write your answers — they save you a back-and-forth.

### What user data does the app receive?

The bot scopes are listed in the manifest. Each scope corresponds to one specific use:

| Scope | Use |
|---|---|
| `incoming-webhook` | Legacy fallback for installs that pre-date the bot-token flow |
| `chat:write` | Post DMs to users and messages to channels they subscribed |
| `chat:write.public` | Post to a channel after `/pincushion subscribe` even if the bot isn't yet a member (bot auto-joins for thread-reply sync) |
| `im:write` | Open a DM channel with a user (one-time per user, channel ID cached) |
| `im:history` | Read thread replies in our DM with the user (so the user can reply to a pin from Slack and it syncs back) |
| `users:read` + `users:read.email` | Identity linking: fetch the installer's email so we can match it to a Pincushion license and auto-route their pin activity |
| `app_mentions:read` | When a user `@pincushion`s in a channel, we reply with a help message |
| `channels:history`, `groups:history` | Receive `message.channels` / `message.groups` events when users reply in a pin's thread, so we can sync that reply back into the Pincushion annotation |
| `commands` | Receive `/pincushion ...` slash command invocations |

### Where is user data stored?

- Workspace metadata + bot tokens in Postgres on Supabase (US region), encrypted at rest
- Slack user ID → Pincushion email mappings in `slack_user_mappings`
- Per-user preferences (mute, event toggles) in `slack_user_preferences`
- Channel subscriptions in `slack_channel_subscriptions`
- All tables RLS-locked to service role only; never accessible from anon or authenticated clients
- Webhook URLs are masked in every API response

### Who can access this data?

- Service-role policy on every table denies `authenticated` and `anon` roles
- Only the `manage-integrations`, `sync-annotations`, and `slack-events` Edge Functions (running with service role key) read sensitive data
- No client-side code ever sees bot tokens or webhook URLs

### How does a user delete their data?

- **Uninstall the app** from Slack: triggers `app_uninstalled` event → `slack_workspaces` marked `revoked`, all `project_integrations` for that workspace paused, all subsequent DMs and channel posts blocked
- **Per-user mute / disable**: `/pincushion mute forever` in any channel, or toggle off all events in App Home
- **Per-channel unsubscribe**: `/pincushion unsubscribe <project>` in that channel, or click the Unsubscribe button in App Home
- **Account deletion**: emailing support@pincushion.io requesting account closure removes the license and cascades to all data including Slack mappings

### Events API signature verification

Every inbound request to the Events API endpoint is HMAC-SHA256 verified against `SLACK_SIGNING_SECRET`. Requests older than 5 minutes (timestamp drift check) are rejected. Event IDs are dedup'd via `slack_event_dedup` to handle Slack's at-least-once delivery semantics.

### Token rotation

Bot tokens are long-lived (Slack default). When a workspace reinstalls or rotates, our upsert (keyed by `team_id`) replaces the old token + sets `status=active`. On `tokens_revoked`, we mark `status=revoked` and stop using the token.

### app_uninstalled handling

Live: subscribed to `app_uninstalled` and `tokens_revoked` events. Handler marks the workspace `revoked`, pauses all `project_integrations` tied to it, and blocks all future posts. No retry logic — the user must reinstall to reactivate.

### Rate limits & abuse prevention

- Channel-side dispatch dedup via unique index on `(integration_id, event_key)` — re-posting the same pin update produces zero duplicate webhooks
- DM-side dispatch dedup via `slack_dm_dispatch_log` keyed by `(team_id, slack_user_id, event_key)` — same event never DMs twice
- `/pincushion subscribe` requires the caller to be an owner or editor of the target project (validated against `project_members`)
- Magic-link tokens for account linking expire after 24h, single-use, validated against the licenses table at consumption time
- OAuth state is 15-minute expiry, single-use, sha256-hashed in storage

---

## Required screenshots (suggested shot list)

1. **Pin being dropped in browser** — Chrome extension overlay on a real-looking web app. Highlight the pin marker + comment thread.
2. **DM from the bot** — actual `pincushion` DM in Slack showing a Block Kit pin notification with title, page name, screenshot thumbnail, "Reply" + "Open pin" buttons.
3. **App Home with preferences** — the new Home view showing the 5 event-toggle checkboxes, mute status, "Your channel subscriptions" section, and "Pins involving you" section.
4. **Slash command in action** — `/pincushion subscribe pc_proj_...` ephemeral confirmation in a channel.
5. **Welcome DM** — the onboarding DM with the "Turn on notifications" callout (visible proof of good UX).
6. **Add to Slack** — pincushion.io landing page with the official "Add to Slack" button visible.

Avoid: real customer data, expired beta UI, watermarks from screen-recording tools.

---

## Demo video (30–60s) script

```
[0:00] Title card: "Pincushion — visual feedback in your Slack DMs"
[0:03] Browser on a sample web app. Stakeholder drops a pin: "the empty state could be friendlier"
[0:08] Pin appears, status: "ready" (auto-flipped because user is project owner)
[0:11] Cut to Slack — DM from `pincushion` lands in the user's sidebar. Title: "Pincushion: marked a pin ready for implementation". Pin screenshot visible. "Reply" + "Open pin" buttons.
[0:18] User clicks "Reply" inline in Slack, types "On it", sends. Reply syncs back to the pin thread.
[0:24] Cut to a channel — engineer types `/pincushion subscribe pc_proj_acme`, ephemeral OK. New pin event lands in the channel too.
[0:32] Cut to Pincushion App Home — show toggles + mute overflow. User clicks "Mute for 1 hour" — confirmation updates inline.
[0:40] Cut back to browser — engineer fixes the empty state. Pin auto-resolves.
[0:45] Slack: optional "Pincushion: resolved a pin" DM lands.
[0:50] Title card: "Try it free at pincushion.io. One install, then DMs forever."
```

Render at 1920×1080, encode as H.264 mp4. Slack's player crops aggressively — keep titles centered.

---

## Common reasons Slack rejects submissions (avoid these)

1. **App description doesn't match behavior.** Our description matches what the integration actually does: DMs by default, channel broadcasts via `/pincushion subscribe`, App Home for preferences.
2. **Privacy policy is a stub.** Slack reviewers click through. https://pincushion.io/privacy must explicitly mention Slack data + the specific scopes we use.
3. **Demo video shows a different app.** Make sure the screenshots and video both feature the actual production UI as it exists at submission time.
4. **OAuth flow has dead ends.** The post-install page renders a clear next step. Auto-claim path shows "Pincushion is installed + enable notifications" instructions; fallback path shows the `/connect-slack` token. Reviewers test both manually.
5. **Bot scopes you don't justify.** Each scope above maps to a specific behavior; the security section explains each one. If Slack asks "why `channels:history`?", point them at the thread-reply sync explanation.
6. **No support contact.** https://pincushion.io/support has a real email + response SLA.

---

## After submission

- Slack emails the listed `Help URL` contact when review starts
- Most rejections come back as a list of items in 7–14 days
- After approval, the listing goes live within 24h
- Update the listing whenever the OAuth scopes or post-install UX change — they re-review on material changes

## Migration notes (May 2026 manifest update)

The Pincushion Slack app was previously a webhook-only integration (`incoming-webhook` scope only, no bot user, no events). The May 2026 rewrite added the full bot-token flow + App Home + slash commands + events sync.

**For existing installs:** the workspace bot token from previous installs is preserved. DMs and channel posts continue to work. New features (slash commands, App Home v2, magic-link account linking) require users to re-install the Slack app once to grant the new scopes — particularly `commands`. There's no forced migration; everything degrades gracefully:

- A workspace that hasn't re-installed: `/pincushion` returns "Unknown command" from Slack itself (we never see it). DMs + channels + Home v2 still work.
- A user without a `slack_user_mappings` row: App Home shows "Link your Pincushion account" CTA.
- A user with a stale `slack_user_mappings` row from before this update: the dispatcher uses it as-is; the welcome DM only fires on FIRST insert (not on re-link), so they won't be re-onboarded.

**To prompt existing customers to re-install:** consider sending a one-time DM via the workspace bot announcing the new features and linking to the install URL. Implementation deferred — not strictly required for parity.
