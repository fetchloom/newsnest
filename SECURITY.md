# Security

Please report vulnerabilities privately, not in a public issue: use GitHub's "Report a vulnerability" button under the Security tab of this repository.

Include what you found, how to reproduce it, and what it could let someone do. You'll get a reply within a few days, and a fix and credit (if you want it) once it is resolved.

Things worth reporting: ways to read or change another person's data, send mail as someone else, run code, bypass the dashboard login, or make the server fetch internal addresses on your behalf from a public page.

Known and by design: the dashboard is for a single trusted owner. Webhook and automation steps can call any http(s) address, including internal ones, because the owner is trusted.
