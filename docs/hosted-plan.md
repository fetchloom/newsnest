# Hosted Newsnest: plan

Goal: anyone can sign up and run a newsletter and send email, without hosting anything. This is the second step after the open-source release.

## What has to change

Newsnest today is single-owner: one password, one publication, one database. A hosted version needs accounts and isolation between them.

**Tenancy: one SQLite file per workspace.** A small control database holds accounts, workspaces, limits and abuse flags. Each workspace gets its own database file with the schema Newsnest already has. A request resolves session, then workspace, then database handle (a small cache of open files). This avoids adding a `workspace_id` to about 50 tables and every query, and makes export and delete one file.

What follows from that:
- Public routes (subscribe, confirm, unsubscribe, tracking, the website at `/p`) need to know the workspace: a `/w/<slug>/` prefix or the workspace's own domain, and tracking links carry the workspace id.
- The send queue, automation runner and live stream loop over active workspaces instead of one database.
- Accounts: email and password, email verification, password reset by email, optional sign-in links.
- API keys, domains, webhooks, suppression lists stay per workspace, as they are.

## Abuse and deliverability (the hard part)

Open signup attracts spammers, and one bad sender damages everyone's inbox placement.

- New workspaces start with small daily and total send limits, raised after email verification and good behaviour.
- A workspace can only send from a domain it has verified. No shared From address.
- Automatic pause when bounces or spam complaints pass a threshold; a manual review queue.
- Double opt-in and a postal address in the footer are already required.
- Block disposable email domains at signup; rate limit signups per address.
- An abuse@ mailbox and a documented takedown process.

## Sending infrastructure

Delivery comes from a reputable SMTP provider (Amazon SES, for example) or a pool of clean IPs with warm-up. A shared IP means shared reputation, which is why the limits above matter.

## Cost, and what "free" means

Servers, the sending provider and support all cost money, and a public free service attracts abuse. Options, not decisions:
- A free tier with caps (subscribers or emails per month), with the full software always free to self-host.
- Funding by donations or sponsors.
- A paid tier priced at cost for bigger senders.

## Legal

Terms of service, privacy policy, a data processing agreement, GDPR export and delete (per-workspace files make this simple), and CAN-SPAM compliance (already in every email).

## Build order

1. Control database, accounts, workspace resolution, per-workspace database handles.
2. Public routes and tracking links with workspace routing.
3. Queue, automations and live stream across workspaces.
4. Limits, domain ownership, abuse flags and suspension.
5. Signup, verification and reset emails; admin view for you.
6. Terms, privacy, and a closed beta before opening signup.
