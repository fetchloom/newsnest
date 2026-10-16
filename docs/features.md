# Feature analysis: Resend and Beehiiv vs Newsnest

Sources: resend.com (llms.txt, docs index, pricing.md) and beehiiv.com (llms.txt, feature pages, pricing), read 2026-10-16.
Where a page did not say whether something exists, it is marked "unconfirmed" rather than guessed.

Legend for Newsnest: **yes** built · **part** partly built · **no** not built.
Plan: **P1–P5** = build phase (see the end) · **infra** = works, but needs a server you run · **external** = needs a third-party service · **network** = only works with other people's publishers.

## What they charge (the thing we replace)

| | Free | First paid step | Notes |
| --- | --- | --- | --- |
| Resend transactional | 3,000 emails/mo, 100/day cap, 3 domains, 1 webhook, 30-day retention | Pro $20/mo for 50,000 | overage $0.90 per 1,000 |
| Resend marketing | 1,000 contacts, 3 segments, no marketing analytics | Pro $40/mo for 5,000 contacts | scales to $650/mo at 150,000 |
| Beehiiv | up to 2,500 subscribers; no automations, referrals, A/B tests, polls, surveys, paid subs, ad network or Send API | Lite $59/mo (up to 1,000) · Pro $109/mo | Pro is $999/mo at 250,000+ subscribers |

## Resend

| Area | Feature | Newsnest | Plan |
| --- | --- | --- | --- |
| Sending | Send API, batch (100), schedule, cancel, reschedule | yes | |
| | Idempotency keys, tags, custom headers | yes | |
| | Rate limiting | yes | |
| | Attachments, inline (CID) images | no | P4 |
| | Send test emails / simulated events (`delivered@`, `bounced@`) | no | P4 |
| | Unsubscribe link and List-Unsubscribe header | no | P1 |
| | Deliverability insights | no | P4 |
| | Templates: create, variables, versions, publish, duplicate | no | P2 |
| | React Email authoring | no | P2 (we use Markdown/HTML blocks) |
| Domains | Add, DKIM/SPF/DMARC records, verify | yes | |
| | Open and click tracking per domain | no | P1 |
| | BIMI, custom return path, TLS settings | no | P4 |
| Marketing | Contacts, properties, import | no | P1 |
| | Segments (with metrics), topics, unsubscribed handling | no | P1 |
| | Broadcasts: create, send, schedule, cancel, duplicate, recipients, clicked links, live performance | no | P1 |
| | Custom unsubscribe page | no | P1 |
| | Automations: trigger, delay, condition, wait for event, send email, add to segment, contact update/delete, runs | no | P3 |
| | Custom events API | no | P3 |
| Inbound | Receive on your own domain, webhooks, forward, reply, attachments | no | P4, infra (port 25 in, MX record) |
| | SMTP submission interface (so WordPress, Rails etc. can send through it) | no | P4, infra |
| Webhooks | Create, list, update, delete, signature, retries | yes | |
| | Replay, list attempts, rotate secret | no | P4 |
| | Events: sent, delivered, delayed, bounced, failed, suppressed, scheduled | yes | |
| | Events: opened, clicked, complained, received; domain/contact/topic/suppression events | no | P1 / P4 |
| Keys | API keys, full vs sending, domain-restricted | yes | |
| | OAuth clients | no | skip |
| Observability | Request logs API, account metrics API | part (dashboard stats only) | P4 |
| Suppressions | List, add, remove, auto-add on bounce | yes | |
| | Batch add/remove, suppression events | no | P4 |
| Developer | REST API | yes | Web app only; the dashboard covers everything a CLI would |
| | OpenAPI spec, Node/Python/Go SDKs | no | P4 (Node first) |
| | MCP server, agent skills, llms.txt | no | P4 |
| Account | Teams, SSO, MFA, multiple users | no | P5 |
| | Agent inboxes (threads, labels, drafts) | no | skip for now |

## Beehiiv

| Area | Feature | Newsnest | Plan |
| --- | --- | --- | --- |
| Editor | Drag-and-drop block editor | part (Markdown + live preview) | P2 |
| | Templates, brand colors/fonts/layout | no | P2 |
| | Dynamic content (per-segment personalization) | no | P3 |
| | AI writing assistant | no | external (optional, bring your own model) |
| | Audio newsletters (text-to-speech) | no | external |
| Audience | Subscribe forms: embed, pop-up, slide-in, landing page | no | P1 |
| | Double opt-in, welcome email | no | P1 (Beehiiv's page doesn't confirm double opt-in; we'll build it anyway) |
| | Custom fields, tags, import/export | no | P1 |
| | Magic links (passwordless reader login) | no | P2 |
| | Gating / pop-ups | no | P2 |
| | Community, link-in-bio | no | P5 |
| Segments | Dynamic, static, manual | no | P1 |
| | Conditions: engagement, opens, clicks, tags, tier, location, custom fields, source, UTM, referral count, dates; AND/OR; publish to a segment | no | P1 |
| Automations | Triggers (signup, click, purchase, custom event), delays, branches, send email, webhooks | no | P3 |
| Growth | Referral program: unique links, milestones, rewards, dashboard, referral block | no | P3 |
| | A/B tests: subject, content, send time | no | P3 |
| | Polls and surveys | no | P3 |
| | Recommendations network, Boosts | no | network |
| Money | Ad network | no | network |
| | Direct sponsorships (placements you sell yourself) | no | P5 |
| | Paid subscriptions and tiers | no | external (your own Paydesk could do this), P5 |
| | Digital products | no | external, P5 |
| Website | Hosted publication site, archive of issues, custom pages, SEO, custom domain | no | P2 |
| | Multiple publications, multiple sender addresses | no | P2 |
| Analytics | Opens, clicks, CTR, unsubscribes, growth, sources | no | P1 |
| | Verified clicks (bot filtering), UTM, geography, devices, read time, reports/exports | no | P1 / P3 |
| Content | Podcast hosting | no | P5 |
| Developer | REST API (subscribers, posts, segments), webhooks | part (email API only) | P1 |
| | MCP server | no | P4 |
| Team | Seats and roles, enterprise SSO | no | P5 |

## Not possible to match, and why

- **Ad network, recommendations network, Boosts.** These work because Beehiiv has thousands of publishers and advertisers on one platform. A self-hosted instance has neither. They could only exist as a federation between Newsnest instances, which is a separate project.
- **Paid subscriptions, digital products.** Money has to move through a payment processor. Processors charge fees, so this can't be "no fees" end to end. Your own Paydesk gateway is the way to keep it self-run.
- **AI writing assistant, text-to-speech.** They need a model. It can be optional with your own key or a local model, but it isn't free in the way the rest is.
- **Inbox placement.** No software can promise it. It depends on your IP, DNS and sending behavior.

## Build order

1. **P1 Newsletter core.** Contacts (properties, tags, CSV import/export), topics, segments (dynamic and static, AND/OR), hosted subscribe page and embeddable form with double opt-in and welcome email, unsubscribe (page plus one-click header), broadcasts (draft, schedule, send, cancel, duplicate), open and click tracking with per-broadcast analytics.
2. **P2 Editor and site.** Block editor with templates and variables, brand settings, public site with an archive and pages, multiple publications and sender addresses, magic links and gating.
3. **P3 Growth.** Automations and custom events, referral program, A/B tests, polls and surveys, dynamic content, verified clicks.
4. **P4 Resend extras.** Attachments and inline images, test emails, SMTP submission server, inbound email, logs and metrics APIs, webhook replay, OpenAPI spec, Node SDK, MCP server.
5. **P5 Optional.** Teams and roles, paid subscriptions through Paydesk, podcasts, sponsorship placements.


## Status, 2026-10-16

Built since the analysis above (Beehiiv side, minus money and network features): block editor with templates, email designs (Plain, Editorial, Modern, Bold) and custom HTML emails, subscribe forms (hosted, inline, pop-up, exit-intent, slide-in), double opt-in and welcome email, tags, custom fields, CSV import and export, dynamic and static segments with nested AND/OR, broadcasts with scheduling and A/B subject tests, open and click tracking with verified clicks and UTM links, analytics per post and for the audience, website with archive, pages, menu, RSS, sitemap and SEO tags, subscribers-only posts with magic links, referral program with rewards, automations (triggers, delays, branches, tags, webhooks), polls and surveys, dynamic content blocks, custom domain for the site.

Still open: multiple publications and extra sender addresses, podcasts, community and link-in-bio, team seats, AI writing and audio, paid subscriptions, ad network, recommendations. From the Resend list: attachments, inline images, inbound email, SMTP submission, request logs and metrics APIs, webhook replay, OpenAPI spec, SDKs, MCP server.
