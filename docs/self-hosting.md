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

Open `https://your-domain/app/` and sign in with the password from `.env`. Caddy (configured by the `Caddyfile` next to the compose file) fetches and renews the HTTPS certificate automatically and adds an HSTS header. Your data lives in the `newsnest-data` volume (one SQLite file). The Newsnest container runs with a read-only filesystem (it only writes to `/data`) and without extra privileges.

Keep `NEWSNEST_ADMIN_PASSWORD` in `.env` (which is not committed), not in a command you type. A password must be at least 10 characters or Newsnest refuses to start.

`docker run -p 8700:8700 newsnest` on its own publishes plain HTTP on every network interface of the machine, with no HTTPS and no proxy to tell visitors apart. Use the compose file, or bind the port to the loopback address (`-p 127.0.0.1:8700:8700`) and put your own proxy in front.

## Without Docker

Needs Node 24 or newer. Newsnest listens on `127.0.0.1` by default; keep it that way when a proxy on the same machine sits in front. `NEWSNEST_HOST=0.0.0.0` is for inside a container, where the container's network is the boundary.

Put the settings in a file only you can read (`chmod 600 /etc/newsnest.env`) rather than on the command line, where other users of the machine can see them with `ps`:

```sh
# /etc/newsnest.env
NEWSNEST_HOST=127.0.0.1
NEWSNEST_PUBLIC_URL=https://news.example.com
NEWSNEST_TRUST_PROXY=1
NEWSNEST_ADMIN_PASSWORD=choose-a-long-one
NEWSNEST_MODE=relay
NEWSNEST_RELAY_URL=smtps://user:pass@smtp.example.com:465
```

Run it under systemd with `EnvironmentFile=/etc/newsnest.env` and `ExecStart=/usr/bin/node server.ts` so it restarts on its own.

### First run without a password in the environment

If `NEWSNEST_ADMIN_PASSWORD` is not set and no password exists yet, Newsnest prints a one-time setup code when it starts:

```
First run: open http://127.0.0.1:8700/app/ on this machine and enter setup code K7QM-2XPD
```

Open the dashboard on that machine, enter the code and choose a password. The code lives in memory only, is checked in constant time, and stops working the moment a password exists. Wrong guesses are rate limited. Setup is refused if the request came through a proxy (any `X-Forwarded-*` header), with a Host other than `localhost`, `127.0.0.1` or `[::1]`, or when `NEWSNEST_PUBLIC_URL` or `NEWSNEST_TRUST_PROXY` is set. On a server, set `NEWSNEST_ADMIN_PASSWORD` instead.

### nginx in front

Put HTTPS in front with nginx (or Caddy) and let the proxy tell Newsnest who is calling. The important line is `X-Forwarded-For $remote_addr`: it **replaces** whatever the visitor sent. Do not use `$proxy_add_x_forwarded_for`, which keeps the visitor's own header.

```nginx
server {
    listen 443 ssl;
    server_name news.example.com;
    # ssl_certificate / ssl_certificate_key: from certbot or your provider

    location / {
        proxy_pass http://127.0.0.1:8700;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Then set `NEWSNEST_TRUST_PROXY=1`. Newsnest uses the last address in `X-Forwarded-For` (the one your proxy wrote) for rate limits and the login throttle, and trusts `X-Forwarded-Proto` for the Secure cookie flag. With a single proxy in front that is the visitor. Never turn it on when Newsnest is reachable without the proxy, because then anyone can claim any address.

## First steps in the dashboard

1. Domains: add your sending domain and publish the DNS records (SPF, DKIM, DMARC). Newsnest checks them.
2. Settings: set the From address, postal address and public URL.
3. Send yourself a test post.

## Backups

Everything is in one file, `newsnest.db`, in the data directory, with uploaded images in `uploads/` beside it. Use `sqlite3 newsnest.db ".backup backup.db"` for a safe copy while it is running.

## Sending without landing in spam

- Use an SMTP service for your first sends. Fresh server IP addresses have no reputation and are often blocked.
- Publish SPF, DKIM and DMARC. Start with small sends and grow slowly.
- Only email people who asked for it. Double opt-in is on by default; keep it on. With single opt-in anyone can sign up any address, and with referral rewards that invites fake sign-ups.
