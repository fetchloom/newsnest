# Security

Please report vulnerabilities privately, not in a public issue: use GitHub's "Report a vulnerability" button under the Security tab of this repository.

Include what you found, how to reproduce it, and what it could let someone do. You'll get a reply within a few days, and a fix and credit (if you want it) once it is resolved.

Things worth reporting: ways to read or change another person's data, send mail as someone else, run code, bypass the dashboard login, or make the server fetch internal addresses on your behalf from a public page.

Known and by design: the dashboard is for a single trusted owner. Webhook and automation steps can call any http(s) address, including internal ones, because the owner is trusted.

Also by design: HTML blocks, custom HTML emails and `full` API keys are fully trusted, because they belong to the owner. `sending` API keys are limited to sending mail and to reading and managing the API mail they sent themselves. Keep double opt-in on: with single opt-in anyone can sign up another person's address, and referral rewards make that worth abusing.

When Newsnest runs behind a reverse proxy, set `NEWSNEST_TRUST_PROXY=1` only if the proxy overwrites `X-Forwarded-For` (see `docs/self-hosting.md`) and nothing can reach Newsnest except through it.
