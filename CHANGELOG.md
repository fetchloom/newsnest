# Changelog

## 0.1.0: first public release

An early release for people who are comfortable following a setup guide. Not yet tried against a wide range of real mail providers, so expect rough edges and please open issues.

**Newsletters**
- Block editor with templates, merge tags, live email and website preview, test sends, autosave
- Four email designs (Plain, Editorial, Modern, Bold) or your own HTML file
- Send now or schedule, to everyone, a tag or a segment; split-test subject lines
- Subscribers with double opt-in, tags, custom fields, CSV import and export
- Dynamic and static segments with nested rules
- Sign-up forms (hosted, inline, pop-up, exit-intent, slide-in)
- Automations, referral rewards, polls and surveys
- Public website with archive, pages, RSS, sitemap, subscribers-only posts
- Open and click tracking with security scanners filtered out; audience and per-post analytics
- A dashboard that updates by itself, a quick-jump palette (Cmd/Ctrl+K), sample data to explore with

**Email API**
- Single and batch sends, scheduling, idempotency keys, tags and headers
- Domains with DKIM signing and DNS checks; signed webhooks with retries; suppression list; scoped API keys

**Running it**
- Node 24, no dependencies, one SQLite file
- Docker and Caddy setup with automatic HTTPS (`docs/self-hosting.md`)
- Sends through any SMTP service, or directly from a server with a clean IP

**Security**
- Reviewed before release; see `SECURITY.md` for how it is designed and how to report a problem
- First-run setup code, per-client login throttling, scoped API keys, security headers and a content security policy

**Not included**
- Paid subscriptions, an ad network, recommendations between newsletters, podcasts, multiple publications
- A hosted version (planned; see `docs/hosted-plan.md`)
