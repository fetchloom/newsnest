# Hosting Newsnest yourself

Newsnest is a program you run on a computer that stays on. This page gets it onto a small server so it is reachable by your readers.

## What you need

- A server (a "VPS") that runs all the time. Any small Linux server is enough; 1 GB of memory handles a large list.
- A domain name, for example `news.example.com`, pointed at the server (an A record).
- A way to send mail: an SMTP service you already have (easiest), or a server with a clean IP address and port 25 open.

## With Docker

```sh
git clone <your copy of the repo> newsnest && cd newsnest
cp .env.example .env        # fill in the domain, a password and your mail settings
docker compose up -d
```

Open `https://your-domain/app/` and sign in with the password from `.env`. Caddy fetches and renews the HTTPS certificate automatically. Your data lives in the `newsnest-data` volume (one SQLite file).

## Without Docker

Needs Node 24 or newer.

```sh
NEWSNEST_HOST=0.0.0.0 NEWSNEST_PUBLIC_URL=https://news.example.com NEWSNEST_ADMIN_PASSWORD='choose a long one' \
NEWSNEST_MODE=relay NEWSNEST_RELAY_URL='smtps://user:pass@smtp.example.com:465' node server.ts
```

Run it under a service manager (systemd) so it restarts, and put Caddy or nginx in front for HTTPS. Pass `X-Forwarded-Proto` and set `NEWSNEST_TRUST_PROXY=1`.

## First steps in the dashboard

1. Domains: add your sending domain and publish the DNS records (SPF, DKIM, DMARC). Newsnest checks them.
2. Settings: set the From address, postal address and public URL.
3. Send yourself a test post.

## Backups

Everything is in one file, `newsnest.db`, in the data directory, with uploaded images in `uploads/` beside it. Use `sqlite3 newsnest.db ".backup backup.db"` for a safe copy while it is running.

## Sending without landing in spam

- Use an SMTP service for your first sends. Fresh server IP addresses have no reputation and are often blocked.
- Publish SPF, DKIM and DMARC. Start with small sends and grow slowly.
- Only email people who asked for it. Double opt-in is on by default.
