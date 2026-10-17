import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { clientIp, isHttps } from "../client.ts";
import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { ApiError } from "../errors.ts";
import { windowLimiter } from "../limiter.ts";
import { now } from "../ids.ts";
import { esc } from "../markdown.ts";
import { sendMagicLink } from "./mailer.ts";
import { baseUrl, getPublication } from "./publication.ts";
import { pollResults, pollRow, submitSurvey, surveyRow, vote } from "./polls.ts";
import type { Question } from "./polls.ts";
import { clearReaderSession, createReaderSession, readerCookie, shell, subscribeForm } from "./site.ts";
import { activate, confirmByToken, createSubscriber, findByEmail, findByToken, unsubscribeByToken } from "./subscribers.ts";
import { GIF, isBot, linkTarget, recordClick, recordOpen } from "./tracking.ts";
import { parseJson } from "./util.ts";

const MAX_FORM = 20_000;

async function readForm(req: IncomingMessage): Promise<Record<string, any>> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const c of req as AsyncIterable<Buffer>) {
    size += c.length;
    if (size > MAX_FORM) throw new ApiError(413, "payload_too_large", "Form is too large");
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  // No prototype: a field named __proto__ or constructor is just a field.
  const out: Record<string, any> = Object.create(null);
  if ((req.headers["content-type"] ?? "").includes("json")) { try { const v = JSON.parse(raw || "{}"); return v && typeof v === "object" ? Object.assign(out, v) : out; } catch { return out; } }
  for (const [k, v] of new URLSearchParams(raw)) out[k] = k in out ? [].concat(out[k], v as never) : v;
  return out;
}

const safeRedirect = (r: unknown): string => (typeof r === "string" && /^\/(?!\/)[^\s\\]*$/.test(r) ? r : "/");

export function createPublic(db: DB, cfg: Config) {
  const allow = windowLimiter();

  const ipOf = (req: IncomingMessage): string => clientIp(req, cfg);

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const method = req.method ?? "GET";
    const pub = getPublication(db);
    const base = baseUrl(db, cfg, pub);
    const embed = url.searchParams.get("embed") === "1";
    const ua = String(req.headers["user-agent"] ?? "");

    const html = (status: number, body: string, extra: Record<string, string> = {}): true => {
      // Several of these pages depend on a ?s= token or the reader's cookie, so no shared cache may keep them.
      res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store", vary: "Cookie", "x-content-type-options": "nosniff", ...extra });
      res.end(body);
      return true;
    };
    const page = (status: number, title: string, bodyHtml: string, extra: Record<string, string> = {}): true =>
      html(status, shell(db, cfg, pub, "/p", { title: `${title} — ${pub.name}`, body: bodyHtml, noindex: true, embed }), extra);
    const redirect = (to: string, headers: Record<string, string> = {}): true => { res.writeHead(302, { location: to, "cache-control": "no-store", ...headers }); res.end(); return true; };
    const json = (status: number, body: unknown, extra: Record<string, string> = {}): true => { res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...extra }); res.end(JSON.stringify(body)); return true; };
    const wantsJson = (req.headers.accept ?? "").includes("application/json") || (req.headers["content-type"] ?? "").includes("json");
    const secure = isHttps(req, db, cfg);
    let m: RegExpExecArray | null;

    // ---- tracking ----
    if ((m = /^\/o\/([A-Za-z0-9_-]+)\.gif$/.exec(path))) {
      // Over the limit the pixel is still served, it just isn't recorded: every hit would otherwise write a row and fire webhooks.
      if (allow(`open:ip:${ipOf(req)}`, 1200, 60_000) && allow(`open:${m[1]}`, 20, 60_000)) {
        try { recordOpen(db, cfg, m[1], ua); } catch (e) { console.error("open:", (e as Error).message); }
      }
      res.writeHead(200, { "content-type": "image/gif", "cache-control": "no-store, max-age=0", "content-length": GIF.length });
      res.end(GIF);
      return true;
    }
    if ((m = /^\/l\/([A-Za-z0-9_-]+)\/([A-Za-z0-9_-]+)$/.exec(path))) {
      let target: string | null = null;
      try {
        target = allow(`click:ip:${ipOf(req)}`, 1200, 60_000) && allow(`click:${m[2]}`, 60, 60_000) ? recordClick(db, cfg, m[1], m[2], ua) : linkTarget(db, m[1]);
      } catch (e) { console.error("click:", (e as Error).message); }
      return redirect(target ?? base);
    }

    // ---- subscribe ----
    if (path === "/subscribe") {
      const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type", "access-control-allow-methods": "POST, OPTIONS" };
      if (method === "OPTIONS") { res.writeHead(204, cors); res.end(); return true; }
      if (method === "GET") {
        const q = url.searchParams;
        const utm: Record<string, string> = {};
        for (const k of ["utm_source", "utm_medium", "utm_campaign"]) if (q.get(k)) utm[k] = q.get(k)!.slice(0, 100);
        let referrer = "";
        try { referrer = new URL(String(req.headers.referer ?? "")).hostname; } catch { /* no referrer */ }
        const refCode = (q.get("ref") ?? "").slice(0, 20);
        const inviter = refCode ? (db.prepare("SELECT id FROM subscribers WHERE referral_code = ? AND status = 'active'").get(refCode) as { id: string } | undefined) : undefined;
        return page(200, `Subscribe to ${pub.name}`, `<h1 class="title">Subscribe to ${esc(pub.name)}</h1><p class="meta">${esc(pub.description || "New posts, straight to your inbox.")}</p>${inviter ? '<div class="notice">A friend invited you.</div>' : ""}${subscribeForm(base, pub, { ref: inviter ? refCode : undefined, utm, referrer: referrer || undefined, name: q.get("name") === "1" })}<p class="meta" style="margin-top:14px">${pub.double_opt_in ? "We'll email you a link to confirm. " : ""}You can unsubscribe at any time.</p>`, cors);
      }
      if (method === "POST") {
        const f = await readForm(req);
        const done = (status: "pending" | "active"): true => wantsJson
          ? json(200, { ok: true, status }, cors)
          : page(200, "Thanks", `<h1 class="title">${status === "pending" ? "Check your inbox" : "You're subscribed"}</h1><p>${status === "pending" ? "We sent you an email with a link to confirm your subscription." : `Welcome to ${esc(pub.name)}.`}</p>`, cors);
        const tooMany = (): true => wantsJson ? json(429, { ok: false, error: "Too many attempts. Try again later." }, cors) : page(429, "Slow down", "<h1 class=\"title\">Too many attempts</h1><p>Please try again in a little while.</p>", cors);
        if (f.website) return done(pub.double_opt_in ? "pending" : "active"); // honeypot: pretend it worked
        if (!allow(`sub:${ipOf(req)}`, 10, 3600_000)) return tooMany();
        const email = String(f.email ?? "");
        const existing = findByEmail(db, email);
        const recentConfirm = existing?.status === "pending" && db.prepare("SELECT 1 FROM emails WHERE subscriber_id = ? AND kind = 'system' AND subject LIKE 'Confirm your subscription%' AND created_at > ?").get(existing.id, now() - 10 * 60_000);
        const first = typeof f.first_name === "string" ? f.first_name.trim().slice(0, 100) : "";
        if (!recentConfirm && !allow("mail:public", cfg.publicMailPerHour, 3600_000)) return tooMany(); // caps the mail strangers can trigger
        try {
          if (!recentConfirm) createSubscriber(db, cfg, {
            email, fields: first ? { first_name: first } : undefined, source: "form", status: pub.double_opt_in ? "pending" : "active", // an unsubscribed address stays unsubscribed; only its own /u/ link brings it back
            utm_source: f.utm_source, utm_medium: f.utm_medium, utm_campaign: f.utm_campaign, referrer: f.referrer, ref: typeof f.ref === "string" ? f.ref : null,
          });
        } catch (e) {
          if (e instanceof ApiError) return wantsJson ? json(422, { ok: false, error: e.message }, cors) : page(422, "Check your email address", `<h1 class="title">That doesn't look right</h1><p>${esc(e.message)}</p><p><a href="${base}/subscribe">Try again</a></p>`, cors);
          throw e;
        }
        return done(pub.double_opt_in ? "pending" : "active");
      }
    }

    // A GET only shows the button: mail scanners and link previewers open every link, and must not subscribe anyone.
    if ((m = /^\/confirm\/([A-Za-z0-9_-]+)$/.exec(path)) && (method === "GET" || method === "POST")) {
      const tok = m[1];
      const confirmed = method === "POST" && !isBot(ua) ? confirmByToken(db, cfg, tok) : null;
      const sub = confirmed ?? findByToken(db, tok);
      if (!sub || (sub.status !== "pending" && sub.status !== "active")) return page(404, "Link not valid", `<h1 class="title">That link isn't valid</h1><p>It may have expired. <a href="${base}/subscribe">Subscribe again</a> to get a new one.</p>`);
      if (sub.status === "active") return page(200, "Confirmed", `<h1 class="title">You're in.</h1><p>Thanks for confirming. Welcome to ${esc(pub.name)}.</p><p><a href="${base}/p">Read the latest posts →</a></p>`);
      return page(200, "Confirm your subscription", `<h1 class="title">Confirm your subscription</h1><p>One more click and you'll get ${esc(pub.name)} in your inbox.</p><form method="post" action="${base}/confirm/${tok}" novalidate><button class="btn" type="submit">Confirm my subscription</button></form>`);
    }

    // ---- unsubscribe ----
    if ((m = /^\/u\/([A-Za-z0-9_-]+)$/.exec(path))) {
      const tok = m[1];
      // ?p= says which post the link was in. Only a real post id is kept, never arbitrary text from the URL.
      const rawPost = (url.searchParams.get("p") ?? "").slice(0, 64);
      const postId = rawPost && db.prepare("SELECT 1 FROM posts WHERE id = ?").get(rawPost) ? rawPost : null;
      const sub = findByToken(db, tok);
      if (method === "POST") {
        const f = await readForm(req);
        if (!sub) return page(404, "Not found", `<h1 class="title">We couldn't find that subscription</h1>`);
        if (f.action === "resubscribe") { activate(db, cfg, sub.id, false); return page(200, "Welcome back", `<h1 class="title">Welcome back</h1><p>You're subscribed again.</p>`); }
        // One-click unsubscribe from the mail client (RFC 8058) or the confirm button below.
        unsubscribeByToken(db, cfg, tok, postId);
        if (f["List-Unsubscribe"] === "One-Click") { res.writeHead(200); res.end(); return true; }
        return page(200, "Unsubscribed", `<h1 class="title">You've been unsubscribed</h1><p>You won't get any more emails from ${esc(pub.name)}.</p><form method="post" action="${base}/u/${tok}" novalidate><input type="hidden" name="action" value="resubscribe"><p class="meta">Changed your mind? <button class="btn" type="submit">Resubscribe</button></p></form>`);
      }
      if (!sub) return page(404, "Not found", `<h1 class="title">We couldn't find that subscription</h1>`);
      if (sub.status === "unsubscribed") return page(200, "Unsubscribed", `<h1 class="title">You're already unsubscribed</h1><form method="post" action="${base}/u/${tok}" novalidate><input type="hidden" name="action" value="resubscribe"><button class="btn" type="submit">Resubscribe</button></form>`);
      return page(200, "Unsubscribe", `<h1 class="title">Unsubscribe from ${esc(pub.name)}?</h1><p>${esc(sub.email.replace(/^(.).*(@.*)$/, "$1•••$2"))} will stop receiving emails.</p><form method="post" action="${base}/u/${tok}${postId ? `?p=${esc(postId)}` : ""}" novalidate><button class="btn" type="submit">Yes, unsubscribe</button></form>`);
    }

    // ---- polls ----
    if ((m = /^\/poll\/([A-Za-z0-9_-]+)(?:\/(\d+))?$/.exec(path)) && method === "GET") {
      let poll;
      try { poll = pollRow(db, m[1]); } catch { return page(404, "Poll not found", `<h1 class="title">Poll not found</h1>`); }
      let note = "";
      if (m[2] !== undefined) {
        const tok = url.searchParams.get("s") ?? "";
        if (isBot(ua)) note = "";
        else {
          const r = vote(db, cfg, poll.id, Number(m[2]), tok);
          note = r === "voted" ? "Thanks, your vote is in." : r === "already" ? "You've already voted. Your first answer stands." : r === "closed" ? "This poll is closed." : "That voting link isn't valid. Open the poll from your email to vote.";
        }
      }
      const r = pollResults(db, poll);
      const bars = r.options.map((o) => `<div style="margin:0 0 14px"><div style="display:flex;justify-content:space-between;font-size:15px"><span>${esc(o.label)}</span><span>${o.percent}% · ${o.votes}</span></div><div style="height:8px;border-radius:99px;background:var(--surface);border:1px solid var(--line);overflow:hidden"><div style="height:100%;width:${o.percent}%;background:var(--brand)"></div></div></div>`).join("");
      return page(200, "Poll", `<h1 class="title">${esc(r.question)}</h1>${note ? `<div class="notice">${esc(note)}</div>` : ""}${bars}<p class="meta">${r.total_votes} ${r.total_votes === 1 ? "vote" : "votes"}</p>`);
    }

    // ---- surveys ----
    if ((m = /^\/s\/([A-Za-z0-9_-]+)$/.exec(path))) {
      let survey;
      try { survey = surveyRow(db, m[1]); } catch { return page(404, "Survey not found", `<h1 class="title">Survey not found</h1>`); }
      const qs = parseJson<Question[]>(survey.questions, []);
      const tok = url.searchParams.get("s") ?? "";
      if (method === "POST") {
        if (!allow(`survey:ip:${ipOf(req)}`, 10, 3600_000) || !allow(`survey:${survey.id}`, 300, 3600_000)) return page(429, "Slow down", `<h1 class="title">Too many attempts</h1><p>Please try again in a little while.</p>`);
        const f = await readForm(req);
        const answers: Record<string, unknown> = {};
        for (const q of qs) answers[q.id] = f[`q_${q.id}`];
        try {
          const r = submitSurvey(db, survey.id, typeof f.s === "string" && f.s ? f.s : null, answers);
          return page(200, "Thanks", `<h1 class="title">${r === "ok" ? "Thanks for your answers" : r === "already" ? "You've already responded" : "This survey is closed"}</h1>`);
        } catch (e) {
          if (e instanceof ApiError) return page(422, survey.title, `<div class="notice">${esc(e.message)}</div><p><a href="${base}/s/${survey.id}${tok ? `?s=${encodeURIComponent(tok)}` : ""}">Go back</a></p>`);
          throw e;
        }
      }
      if (survey.closed) return page(200, survey.title, `<h1 class="title">${esc(survey.title)}</h1><p>This survey is closed.</p>`);
      const fields = qs.map((q) => {
        const name = `q_${q.id}`;
        const label = `<label style="display:block;font-weight:600;margin:22px 0 8px">${esc(q.label)}${q.required ? " *" : ""}</label>`;
        if (q.type === "text") return `${label}<textarea name="${name}" rows="3" style="width:100%;padding:10px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font:16px inherit"></textarea>`;
        if (q.type === "rating") return `${label}<div>${[1, 2, 3, 4, 5].map((n) => `<label style="margin-right:14px"><input type="radio" name="${name}" value="${n}"> ${n}</label>`).join("")}</div>`;
        const kind = q.type === "multi" ? "checkbox" : "radio";
        return `${label}${(q.options ?? []).map((o) => `<label style="display:block;margin:6px 0"><input type="${kind}" name="${name}" value="${esc(o)}"> ${esc(o)}</label>`).join("")}`;
      }).join("");
      return page(200, survey.title, `<h1 class="title">${esc(survey.title)}</h1>${survey.description ? `<p class="meta">${esc(survey.description)}</p>` : ""}<form method="post" action="${base}/s/${survey.id}" novalidate>${fields}<input type="hidden" name="s" value="${esc(tok)}"><p style="margin-top:26px"><button class="btn" type="submit">Submit</button></p></form>`);
    }

    // ---- referral shortcut ----
    if ((m = /^\/r\/([a-z0-9]{4,20})$/.exec(path))) return redirect(`${base}/subscribe?ref=${m[1]}`);

    // ---- reader sign-in for gated posts ----
    if (path === "/login" && method === "POST") {
      const f = await readForm(req);
      // Per visitor, per target address (so one inbox can't be flooded from many addresses) and overall. The page is the same either way.
      const target = String(f.email ?? "").trim().toLowerCase().slice(0, 254);
      if (!f.website && allow(`login:${ipOf(req)}`, 10, 3600_000) && allow(`login-to:${target}`, 3, 30 * 60_000)) {
        const s = findByEmail(db, target);
        if (s?.status === "active" && allow("mail:public", cfg.publicMailPerHour, 3600_000)) sendMagicLink(db, cfg, s, safeRedirect(f.redirect));
      }
      return page(200, "Check your inbox", `<h1 class="title">Check your inbox</h1><p>If that address is subscribed, we've sent a sign-in link. It works once and expires in 20 minutes.</p>`);
    }
    if (path === "/login" && method === "GET") {
      return page(200, "Sign in", `<h1 class="title">Sign in to read</h1><p class="meta">We'll email you a link. No password needed.</p><form class="form" method="post" action="${base}/login" novalidate><input type="email" name="email" placeholder="you@example.com" aria-label="Email address"><input type="hidden" name="redirect" value="${esc(safeRedirect(url.searchParams.get("redirect")))}"><input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button class="btn" type="submit">Email me a link</button></form>`);
    }
    // A GET only shows the button, for the same reason as /confirm: scanners open every link in a mail and would use up the token.
    if ((m = /^\/magic\/([A-Za-z0-9_-]+)$/.exec(path)) && (method === "GET" || method === "POST")) {
      const h = createHash("sha256").update(m[1]).digest("hex");
      const row = db.prepare("SELECT subscriber_id, redirect FROM magic_tokens WHERE id = ? AND expires_at > ?").get(h, now()) as { subscriber_id: string; redirect: string } | undefined;
      if (!row) return page(404, "Link expired", `<h1 class="title">That sign-in link has expired</h1><p><a href="${base}/login">Get a new one</a></p>`);
      if (method === "GET") return page(200, "Sign in", `<h1 class="title">Sign in to ${esc(pub.name)}</h1><form method="post" action="${base}/magic/${m[1]}" novalidate><button class="btn" type="submit">Sign in</button></form>`);
      db.prepare("DELETE FROM magic_tokens WHERE id = ?").run(h); // single use
      return redirect(safeRedirect(row.redirect), { "set-cookie": readerCookie(createReaderSession(db, row.subscriber_id), secure) });
    }
    if (path === "/logout" && method === "POST") {
      clearReaderSession(db, req.headers.cookie);
      return redirect("/", { "set-cookie": readerCookie("", secure, true) });
    }

    return false;
  };
}

