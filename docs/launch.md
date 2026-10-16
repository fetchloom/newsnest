# Launching Newsnest

A checklist for putting the project in front of people. Everything here is a step for you; the code side is done.

## 1. Put the landing page on your domain

The landing page is plain static files. Build just that with `node build.ts --landing` (output in `dist/`), or let GitHub do it:

1. Buy the domain (for example `newsnest.app`).
2. In the repo: **Settings → Pages → Source: GitHub Actions**.
3. **Settings → Secrets and variables → Actions → Variables**, add:
   - `LANDING_DOMAIN` = `newsnest.app`
   - `WAITLIST_URL` = the sign-up address of a running Newsnest (step 2 below), for example `https://news.newsnest.app/subscribe`. Leave it out and the form is replaced by a "Watch the repo" button.
4. At your registrar, point the domain at GitHub Pages. For the bare domain add four `A` records: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`. For `www`, add a `CNAME` to `fetchloom.github.io`.
5. Run the workflow (**Actions → Landing page → Run workflow**). When it finishes, tick **Enforce HTTPS** in Pages settings.

Any static host works the same way (Cloudflare Pages, Netlify): build command `node build.ts --landing`, publish directory `dist`.

## 2. Run a Newsnest for the waitlist

The form on the landing page is a normal Newsnest sign-up form, so use Newsnest itself: follow [self-hosting.md](self-hosting.md) on `news.<your domain>`, then in the dashboard set the newsletter name, From address and postal address, verify the sending domain, and write a first issue. People who join get a confirmation email, and you can mail them when the hosted version opens.

## 3. Take screenshots

Open **Settings → Sample data → Load sample data** for a populated dashboard. Take these, about 1600 px wide, in the light theme (add a dark one of the Overview if you like):

1. **Overview**: stats, the 14-day chart and recent emails.
2. **Post editor** with the **Design** tab open, showing the four designs.
3. **Analytics** for one sent issue (open and click numbers, top links).
4. **Subscribers** or a **Segment** with its rules.
5. **An email**: use **Send test** in outbox mode, open the `.eml` from `data/outbox/` in Mail, and capture one in each of two designs.

Save them in `docs/screenshots/`, add the best two or three to the top of the README, and use one as the social preview image (**Settings → Social preview** in the repo, 1280 × 640 px). When you finish, **Remove sample data**.

## 4. Before you announce

- [ ] The landing page loads on your domain over HTTPS and the waitlist form works.
- [ ] You sent a real email through your own setup to Gmail and Outlook and it landed in the inbox.
- [ ] `docker compose up -d` works on a fresh server (CI checks the image; this checks your DNS and HTTPS).
- [ ] README shows screenshots and the repo has a description and topics.
- [ ] A release exists (see the Releases page) and the version in `package.json` matches.

## 5. Announce

Be specific about what it is and honest about what it isn't: **a free, open-source newsletter platform and email API you host yourself, early release, no paid subscriptions, ads or recommendations network.**

Good places, in rough order of effort to reward:
- **X**: a short thread with a screenshot or a 20-second screen recording of writing and sending an issue.
- **Show HN**: title like `Show HN: Newsnest, a self-hosted Beehiiv and Resend alternative (Node, no dependencies)`. Post it early on a weekday morning (US time) and stay around to answer comments.
- **r/selfhosted** (use their release flair), **r/newsletters**, **r/SideProject**.
- **Product Hunt**, once you have the screenshots and a hosted waitlist to point at.
- **Indie Hackers** and relevant Discords or Slack groups, as a post, not a drive-by link.

Answer every comment and issue in the first few days. Early replies decide whether people stay.

## 6. After launch

- Watch the issues for install problems and fix them first.
- Tag fixes as `v0.1.1`, `v0.1.2`... and keep release notes short and honest.
- Count waitlist sign-ups. That number tells you when the hosted version is worth building (see [hosted-plan.md](hosted-plan.md)).
