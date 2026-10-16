# Newsnest

**Start a newsletter you own.** Newsnest is a free, open-source newsletter platform and email API in one. Write in a block editor, grow your list with forms, referrals and polls, automate welcome emails, publish a website, and see opens and clicks live. No monthly fee, no cut of your earnings, no subscriber limits, and your list stays in a single file you control.

It is the pieces of [Beehiiv](https://www.beehiiv.com) (writing, growing, analytics) and [Resend](https://resend.com) (a developer email API) in one program with no dependencies.

- Needs [Node 24](https://nodejs.org) or newer. Nothing to install.
- Setting it up on a server: [docs/self-hosting.md](docs/self-hosting.md), with Docker and HTTPS.
- What is and isn't included: [docs/features.md](docs/features.md).
- Releasing your own copy or announcing the project: [docs/launch.md](docs/launch.md).
- Contributing: [CONTRIBUTING.md](CONTRIBUTING.md). Security reports: [SECURITY.md](SECURITY.md).

## Try it in a minute

```sh
git clone https://github.com/fetchloom/newsnest && cd newsnest
node server.ts          # then open http://127.0.0.1:8700/app/ and choose a password
```

Out of the box it saves emails as files instead of sending them, so you can explore safely. In **Settings**, **Load sample data** fills it with example subscribers, issues and statistics (and removes them again with one click). To send real email, connect an SMTP service or send directly from a server (see below).

```sh
node --test test/*.test.ts   # the tests: a fake mail server and a fake browser, no real mail sent
node build.ts                # static landing page and dashboard files into dist/
```

## Dashboard

Open http://127.0.0.1:8700/app/. The first visit asks you to choose a password (only from the machine running Newsnest;
on a server, set `NEWSNEST_ADMIN_PASSWORD` instead). From there you can send email, read the event history of every
message, add and verify domains, create API keys and webhooks, and manage suppressions. Change the password under
Settings. Forgot it: start the server once with `NEWSNEST_ADMIN_PASSWORD` set to a new one, sign in, and unset it
(while it is set, every start resets the password to it).

Sessions use an HttpOnly, SameSite=Strict cookie, and every dashboard request must carry an `X-Newsnest` header, which
cross-site pages can't send. Put it behind HTTPS if you expose it beyond localhost.

### Live updates

The dashboard keeps itself current. A small event stream (`GET /live`, dashboard session only) tells open tabs when a send finishes, an email is opened or clicked, or someone subscribes, and read-only pages refresh in place. New subscribers also raise a toast. Pages with forms, editors or one-time secrets never refresh under you, and nothing refreshes while you are typing or a dialog is open. The server only polls while a tab is connected.

## Sending modes

Set with `NEWSNEST_MODE`:

| mode | what happens | needs |
| --- | --- | --- |
| `outbox` (default) | messages are written to `data/outbox/*.eml` | nothing |
| `relay` | handed to your SMTP server (`NEWSNEST_RELAY_URL=smtp://user:pass@host:587`, or `smtps://…:465`) | an SMTP account you already have |
| `direct` | delivered to the recipient's mail server on port 25 | a server with a clean static IP, reverse DNS and port 25 open |

A home connection will not reach inboxes in `direct` mode. In `relay` mode Newsnest can see that the relay accepted the
message (`email.sent`) but not what happened after; `email.delivered` is only emitted in `direct` mode.

Other settings: `PORT`, `NEWSNEST_DATA`, `NEWSNEST_EHLO_NAME`, `NEWSNEST_SERVER_IP` (used in the suggested SPF record),
`NEWSNEST_RATE_LIMIT` (requests per second per key, default 10).

## API

All requests need `Authorization: Bearer nn_…`. Bodies and responses are JSON. Errors look like
`{ "statusCode": 422, "name": "validation_error", "message": "…" }`.

```sh
curl -X POST http://127.0.0.1:8700/emails \
  -H "Authorization: Bearer $NEWSNEST_KEY" -H "Content-Type: application/json" \
  -d '{"from":"Ada <ada@yourdomain.com>","to":["hello@example.com"],"subject":"Hi","markdown":"No tiers. **No meters.**"}'
```

| | |
| --- | --- |
| `POST /emails` | send. Fields: `from`, `to`, `cc`, `bcc`, `reply_to`, `subject`, one of `html` / `text` / `markdown`, `headers`, `tags`, `scheduled_at` (ISO 8601, up to 30 days) |
| `POST /emails/batch` | up to 100 emails, all or nothing |
| `GET /emails`, `GET /emails/:id`, `GET /emails/:id/events` | read (`?limit=&after=` for paging) |
| `PATCH /emails/:id`, `POST /emails/:id/cancel` | reschedule or cancel, only before the first send attempt |
| `POST /domains`, `GET /domains[/:id]`, `POST /domains/:id/verify`, `DELETE /domains/:id` | sender domains, DKIM keys and DNS records |
| `POST /api-keys`, `GET /api-keys`, `DELETE /api-keys/:id` | `permission` is `full` or `sending`; a sending key can be limited to one `domain_id` |
| `POST/GET/PATCH/DELETE /webhooks` | signed event delivery, retried with backoff |
| `GET/POST /suppressions`, `DELETE /suppressions/:email` | addresses that will not be mailed |

Send `Idempotency-Key: <string>` on `POST /emails` and `/emails/batch` to make retries safe (kept for 24 hours).

**Domains.** `POST /domains` generates a 2048-bit DKIM key and returns the DNS records to publish. `verify` looks them up;
the domain is `verified` when the DKIM record matches. SPF and DMARC are reported but not required. Outside `outbox` mode,
sending from an unverified domain is refused (403).

**Events.** `email.scheduled`, `queued`, `sent`, `delivered`, `delivery_delayed`, `bounced`, `failed`, `suppressed`, `canceled`.
A permanent SMTP error (5xx) bounces the recipient and adds them to the suppression list. Temporary errors retry after
30 s, 2 min, 10 min, 1 h and 4 h, then fail.

**Webhooks.** Each POST carries `newsnest-id`, `newsnest-timestamp` and `newsnest-signature: v1,<base64 HMAC-SHA256 of "id.timestamp.body">`
keyed with the webhook's `whsec_…` secret. `verifySignature` in `src/server/webhooks.ts` shows the check.


## Newsletter platform

Everything in the dashboard sidebar under Publish, Audience and Grow.

| | |
| --- | --- |
| **Designs** | Four email designs: Plain, and three free ones (Editorial, Modern, Bold), applied in your brand colour. Set a default in Settings, or choose per post. Or write the whole email yourself: paste or upload a complete `.html` file, with merge tags, click and open tracking, and an unsubscribe link and postal address added if your file lacks one. Custom HTML posts are email-only. |
| **Posts** | Block editor with drag-and-drop: text (Markdown), heading, image (upload or link), button, divider, spacer, quote, list, code, HTML, social links, poll, survey, referral box, subscribe box, and dynamic blocks that only some subscribers see. Templates, merge tags (`{{first_name \| friend}}`), live email and website preview, test emails, autosave. |
| **Sending** | Send now or schedule. Audience is everyone, a tag, or a segment. A/B tests on subject lines (test group, wait, winner goes to the rest). Paced with `NEWSNEST_SEND_RATE`. Every email has one-click unsubscribe headers and a postal-address footer. |
| **Subscribers** | Double opt-in, welcome email, tags, custom fields, CSV import and export, activity history, engagement levels (new, active, at risk, inactive). |
| **Segments** | Dynamic rules with nested all/any groups (tags, fields, opens, clicks, engagement, referrals, polls, other segments), or static lists. Live match count. |
| **Forms** | Hosted sign-up page, inline embed, pop-up, exit-intent, slide-in, plain iframe. Honeypot and rate limit against bots. |
| **Website** | Public archive and post pages at `/p/` (or at `/` on your own domain), custom pages, menu, RSS, sitemap, SEO and sharing tags, subscribers-only posts with passwordless email sign-in. |
| **Automations** | Triggers: sign-up, tag added, link clicked, custom event (API), poll vote, referral reward. Steps: email, wait, if/else, add or remove tag, webhook. |
| **Referrals** | Personal links, milestones with digital or physical rewards, leaderboard. Counts only confirmed subscribers. |
| **Polls and surveys** | One-click polls inside emails, surveys with choice, rating and free-text questions, results and CSV export. |
| **Analytics** | Per post: opens, verified clicks, click-to-open, unsubscribes, bounces, top links, devices, hourly chart, A/B comparison. Audience: growth, sources, referring sites, engagement. |

Not included, on purpose: paid subscriptions, the ad network, recommendations and Boosts, digital products. They need a payment processor or a network of other publishers. See `docs/features.md`.

### Going live

Step-by-step guide, with Docker and HTTPS: `docs/self-hosting.md`. The short version:

1. Set the public address people can reach: `NEWSNEST_PUBLIC_URL=https://news.example.com` (or Settings in the dashboard). Confirm, unsubscribe and tracking links use it. On localhost they only work on your computer.
2. Choose how mail leaves: `NEWSNEST_MODE=relay` with `NEWSNEST_RELAY_URL`, or `direct` from a server with a clean IP and port 25.
3. Add and verify your sending domain (Domains), then set the From and postal address (Settings).
4. Put HTTPS in front (Caddy or nginx), pass `X-Forwarded-Proto`, and set `NEWSNEST_TRUST_PROXY=1` so rate limits see real client addresses.
5. For your own site domain, point its DNS at the server and enter it under Website.

More settings: `NEWSNEST_PUBLIC_URL`, `NEWSNEST_SEND_RATE` (newsletter messages per second, default 10; API mail is not paced), `NEWSNEST_TRUST_PROXY`.

### Things to know

- **Open tracking is approximate.** Apple Mail Privacy Protection and some image proxies load the tracking pixel for people who never opened the email. Clicks from security scanners are filtered (shown as "verified clicks"), but not perfectly.
- **No geography or read time.** Newsnest stores no IP addresses and has no location database.
- **One publication per install.** Run a second instance for a second newsletter.
- **Automation webhook steps and API webhooks can call any http(s) address**, including your internal network. That is fine for a single-owner install; don't give untrusted people dashboard access.
- **Subscribers are active, pending, unsubscribed or bounced.** Hard bounces move a subscriber to bounced and add them to the suppression list.

### Newsletter API

All of these need a full-access API key (create one under API keys in the dashboard). Routes: `/publication`, `/subscribers` (+ `/import`, `/export.csv`, `/:id/activity`), `/segments` (+ `/preview`, `/:id/snapshot`, `/:id/members`), `/posts` (+ `/:id/schedule`, `/unschedule`, `/publish`, `/preview`, `/test`, `/stats`), `/templates`, `/pages`, `/polls`, `/surveys`, `/rewards`, `/referrals`, `/automations` (+ `/activate`, `/pause`, `/runs`), `/events` (custom events), `/analytics/audience`, `/uploads`, `/forms`. Adding a subscriber:

```sh
curl -X POST http://127.0.0.1:8700/subscribers -H "Authorization: Bearer $NEWSNEST_KEY" -H "Content-Type: application/json" \
  -d '{"email":"ada@example.com","fields":{"first_name":"Ada"},"tags":["vip"],"send_welcome_email":true}'
```

Embed a form anywhere: `<div data-newsnest-form></div><script async src="https://news.example.com/embed.js"></script>`.

## Layout

- `src/server/` email API, SQLite schema (`db.ts`), queue, SMTP client, MIME + DKIM, Markdown renderer
- `src/server/newsletter/` subscribers, segments, block renderer, posts, broadcasts, tracking, automations, referrals, polls, public site and forms
- `src/client/` landing page scripts, `src/client/app/` dashboard (no framework; DOM built with text nodes, so API data can't inject HTML)
- `public/` landing page, `public/app/` dashboard shell, `tokens.css` shared by both
- `server.ts` and `build.ts` entry points; `test/` end-to-end tests with a fake SMTP server, plus `dom-shim.ts`, a small fake DOM that renders every dashboard page and clicks through the main flows

TypeScript is run directly by Node, which erases types without checking them. `tsconfig.json` is ready for
`tsc --noEmit` whenever you want a real type check. Use erasable syntax only: no enums, namespaces or parameter properties,
and `import type` for type-only imports.

## Fonts

Self-hosted variable fonts in `public/fonts/` (SIL OFL, ~95 KB): Bricolage Grotesque, Instrument Sans, Martian Mono.

## License

Newsnest is free software under the [GNU AGPL v3](LICENSE). Run it, change it and share it. If you run a modified version as a service for other people, you must share your changes under the same license.

Made by Alex ([@unvibeapp](https://x.com/unvibeapp) on X).

Fonts (self-hosted in `public/fonts`): Bricolage Grotesque, Instrument Sans and Martian Mono, all under the SIL Open Font License 1.1.
