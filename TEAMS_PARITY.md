# Microsoft Teams parity with Slack

This doc maps the Slack bot-mode features Pincushion ships today to what each one requires on the Teams side. **Short version: outbound notifications are at full parity today; two-way features (thread reply, DM, Home tab) need a Microsoft Bot Framework app, which is a separate setup ceremony.**

## What ships today (May 2026)

Outbound webhook delivery is at content parity with Slack. Every event the Slack bot posts, the Teams webhook posts the equivalent:

| Feature | Slack | Teams |
|---|---|---|
| `pin_ready`, `mention`, `follow_up` notifications | `chat.postMessage` Block Kit | `POST` Adaptive Card via Workflows webhook |
| Title with status hint | Section + bold | TextBlock with color (Attention for mentions) |
| Page title | Section bold | TextBlock bold |
| Comment text | mrkdwn quote | TextBlock isSubtle |
| Inline pin screenshot | `image` block | `Image` Stretch |
| Author + pin ID | Context | FactSet |
| "Open pin" action | Actions button | `Action.OpenUrl` |
| Public-URL detection (suppress button on localhost) | Yes | Yes |
| `@-mention` event firing | Yes | Yes |
| Multiple subscriptions per project with `events` + `pageUrlPatterns` filters | Yes | Yes |
| Idempotency (one event = one post, replay-safe) | Yes (`integration_notifications` unique on `(integration_id, event_key)`) | Yes (same table) |
| Auto-pause on 404 / 410 / 5xx | Yes | Yes |

`teamsPayload` in `supabase/functions/sync-annotations/index.ts` builds the Adaptive Card from the same `notificationCopy()` source as `slackPayload`, so any future copy or layout change applies to both.

## What doesn't ship today

Three Slack features have no equivalent in the current Teams outbound-webhook model:

| Slack feature | Why it works in Slack | Why it doesn't in Teams (yet) |
|---|---|---|
| **Reply in Slack thread → comment on pin** | Slack delivers `message.channels` Events API to our `slack-events` endpoint; we look up the parent message in `slack_message_pins` and append the reply to the annotation thread. Requires the bot to be in the channel + Events API subscription. | Teams Workflows webhook is **one-way**. There is no "thread reply triggers webhook out" path. A bot via Microsoft Bot Framework is required to receive `messageReactionAdded`, `message`, and other channel events. |
| **DM on @mention** | Slack `chat.postMessage` to a DM channel resolved via `conversations.open(users=...)`. Requires the bot to know the user's Slack ID (resolved via `users.lookupByEmail` with `users:read.email`). | Teams Bot Framework supports proactive DMs (`createConversation` against a 1:1 personal scope) but only via a registered bot. Email-to-AAD-user mapping requires Microsoft Graph API and `User.Read.All` permission. |
| **App Home tab (personal landing view)** | `app_home_opened` Events API → `views.publish` with a Block Kit home view. | Teams calls this a **personal tab** + **personal scope** in the Teams app manifest. Tabs are React apps hosted at a URL we run; the home content renders in an iframe inside Teams. Requires our own publicly-hosted tab UI plus Teams SSO via AAD. |

## What's required to close the gap

To get full Slack-parity in Teams, you need a Microsoft Bot Framework app + Teams app submission. This is ~2-3 days of focused work plus Microsoft's review (median 2-4 weeks).

### Phase 1 — Microsoft 365 work tenant + Bot Framework registration (you do this)

**Status: blocked on tenant access as of 2026-05-10.** Microsoft tightened Dev Program sandbox eligibility in late 2024; joining with a personal Microsoft account now returns *"You don't currently qualify for a Microsoft 365 Developer Program sandbox subscription"*. To proceed, you need one of:

- **Visual Studio Enterprise** ($1199/yr first year) or **Professional** ($499/yr) — Dev Program sandbox is a member benefit
- **Microsoft 365 Business Basic** ($6/user/mo) — real work tenant on your own domain (e.g. `josh@pincushion.io`), ~30 min of DNS TXT verification + MFA setup
- **Microsoft Partner Network** membership
- Existing M365 work account at another company

Once a qualifying tenant exists:
1. **Register an Azure AD app.** https://portal.azure.com → App registrations → New registration. Capture: Application (client) ID, Directory (tenant) ID. Generate a client secret under Certificates & secrets.
2. **Register a bot in Azure Bot Service.** Create resource → Azure Bot. Use the Azure AD app as the bot's Microsoft App ID. Set the **messaging endpoint** to `https://dpsqzszdviltqvethxbr.functions.supabase.co/functions/v1/teams-events`.
3. **Enable the Microsoft Teams channel** on the bot resource.

### Phase 2 — `teams-events` Edge Function (already built + deployed v1, commit `51d8e96`)

Live URL: `https://dpsqzszdviltqvethxbr.functions.supabase.co/functions/v1/teams-events`. Will reject all requests with `bot_app_id_not_configured` (500) until Phase 1 produces a `MICROSOFT_BOT_APP_ID` + `MICROSOFT_BOT_APP_SECRET` to set as Supabase secrets. Already implemented:

- Bot Framework JWT verification against Microsoft's OpenID Connect JWKS (cached 1h), accepts both `api.botframework.com` and `api.botframework.us` issuers, validates `aud` against `MICROSOFT_BOT_APP_ID`
- Idempotency via `teams_event_dedup(tenant_id, event_id)` unique key
- `handleMessageActivity` — thread replies routed to `slack_message_pins`-equivalent `teams_message_pins` table, comment appended to annotation
- `handleConversationUpdate` — bot added to channel/team triggers greeting + `teams_conversations` row capture (for outbound serviceUrl)
- `getBotAccessToken` / `teamsReply` — outbound replies via Bot Framework REST, client_credentials grant at `login.microsoftonline.com/botframework.com`, token cached per TTL

Migration applied: `teams_conversations`, `teams_message_pins`, `teams_event_dedup` (all service-role-RLS deny). Mirrors `slack_*` tables 1:1.

### Phase 3 — Teams app manifest

The bot needs to be packaged as a Teams app for users to install. The manifest template is in `TEAMS_APP_MANIFEST.json` — fill in the four GUIDs/IDs from your Azure registration, zip the manifest with the two icons, and submit to either:
- **Teams Developer Portal** for personal/org distribution (https://dev.teams.microsoft.com)
- **Microsoft Teams Store** for public listing (review queue 2-4 weeks)

### Phase 4 — Personal tab / App Home equivalent

Teams' "App Home tab" equivalent is a **personal tab** in the manifest, pointing at a publicly-hosted URL we run (e.g. `https://pincushion.io/teams/home`). The page renders inside Teams' iframe, can use the [Teams JS SDK](https://learn.microsoft.com/microsoftteams/platform/tabs/how-to/using-teams-client-library) to fetch user context.

For the same data Slack's Home tab shows (connected projects + pins mentioning the user), the tab page reads from Pincushion's API the same way the Chrome extension does — license-key auth, `sync-annotations` GET.

## Quick storefront install today (what users see now)

Users who want Teams notifications today follow this path:
1. In a Teams channel: `⋯` menu → **Workflows** → search "Post to a channel when a webhook request is received" → **Next** → confirm team + channel → **Add workflow** → copy the URL
2. In their Pincushion agent: `configure_collaboration_integration({ projectId, provider: "teams", webhookUrl, name: "..." })`
3. Pin events fire; Adaptive Cards land in the channel

This works today, fully content-parity with the Slack outbound experience, including inline screenshots. Only the two-way and Home-tab features are deferred to Phase 1-4 above.
