import type { IncomingMessage, ServerResponse } from "node:http";
import { COOKIE, MIN_PASSWORD, attemptGate, checkPassword, createSession, destroySession, hasPassword, loginThrottle, parseCookies, sessionCookie, sessionValid, setPassword, setupCodeMatches } from "./auth.ts";
import { clientIp, isHttps } from "./client.ts";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { createDomain, deleteDomain, getDomain, listDomains, verifyDomain } from "./domains.ts";
import { addSuppression, cancelEmail, getEmail, listEmailEvents, listEmails, listSuppressions, removeSuppression, rescheduleEmail, sendBatch, sendEmail } from "./emails.ts";
import { ApiError, notFound, validation } from "./errors.ts";
import { now, sha256 } from "./ids.ts";
import { authenticate, createKey, listKeys, revokeKey } from "./keys.ts";
import { markdownDocument } from "./markdown.ts";
import { publicSettings, stats } from "./stats.ts";
import type { ApiKeyInfo } from "./keys.ts";
import { newsletterRoutes } from "./newsletter/routes.ts";
import { obj, ok, route } from "./router.ts";
import type { Route } from "./router.ts";
import { createWebhook, deleteWebhook, getWebhook, listWebhooks, updateWebhook } from "./webhooks.ts";

const MAX_BODY = 5 * 1024 * 1024;
const IDEMPOTENCY_TTL_MS = 24 * 3600 * 1000;

const ROUTES: Route[] = [
  ...newsletterRoutes,
  route("POST", "/emails", (c) => { const r = sendEmail(c.db, c.cfg, c.key, c.body); c.kick(); return ok(r, 201); }, { sending: true, idempotent: true }),
  route("POST", "/emails/batch", (c) => { const r = sendBatch(c.db, c.cfg, c.key, c.body); c.kick(); return ok(r, 201); }, { sending: true, idempotent: true }),
  route("GET", "/emails", (c) => ok(listEmails(c.db, c.query, c.key)), { sending: true }),
  route("GET", "/emails/:id", (c) => ok(getEmail(c.db, c.params[0], c.cfg, c.key)), { sending: true }),
  route("GET", "/emails/:id/events", (c) => ok(listEmailEvents(c.db, c.params[0], c.key)), { sending: true }),
  route("PATCH", "/emails/:id", (c) => { const r = rescheduleEmail(c.db, c.params[0], obj(c.body), c.key); c.kick(); return ok(r); }, { sending: true }),
  route("POST", "/emails/:id/cancel", (c) => ok(cancelEmail(c.db, c.params[0], c.key)), { sending: true }),

  route("POST", "/domains", (c) => ok(createDomain(c.db, obj(c.body).name), 201)),
  route("GET", "/domains", (c) => ok({ object: "list", data: listDomains(c.db, c.cfg) })),
  route("GET", "/domains/:id", (c) => ok(getDomain(c.db, c.params[0], c.cfg))),
  route("POST", "/domains/:id/verify", async (c) => ok(await verifyDomain(c.db, c.params[0], c.cfg))),
  route("DELETE", "/domains/:id", (c) => ok(deleteDomain(c.db, c.params[0]))),

  route("POST", "/api-keys", (c) => ok(createKey(c.db, obj(c.body)), 201)),
  route("GET", "/api-keys", (c) => ok({ object: "list", data: listKeys(c.db) })),
  route("DELETE", "/api-keys/:id", (c) => ok(revokeKey(c.db, c.params[0]))),

  route("POST", "/webhooks", (c) => ok(createWebhook(c.db, obj(c.body)), 201)),
  route("GET", "/webhooks", (c) => ok({ object: "list", data: listWebhooks(c.db) })),
  route("GET", "/webhooks/:id", (c) => ok(getWebhook(c.db, c.params[0]))),
  route("PATCH", "/webhooks/:id", (c) => ok(updateWebhook(c.db, c.params[0], obj(c.body)))),
  route("DELETE", "/webhooks/:id", (c) => ok(deleteWebhook(c.db, c.params[0]))),

  route("GET", "/stats", (c) => ok(stats(c.db))),
  route("GET", "/settings", (c) => ok(publicSettings(c.cfg))),
  route("POST", "/preview", (c) => {
    const md = obj(c.body).markdown;
    if (typeof md !== "string" || md.length > 1_000_000) throw validation(`"markdown" must be a string`);
    return ok({ html: markdownDocument("Preview", md) });
  }),

  route("GET", "/suppressions", (c) => ok(listSuppressions(c.db))),
  route("POST", "/suppressions", (c) => {
    const email = obj(c.body).email;
    if (typeof email !== "string" || !email.includes("@")) throw validation(`"email" is required`);
    addSuppression(c.db, email, "manual");
    return ok({ email: email.trim().toLowerCase(), object: "suppression" }, 201);
  }),
  route("DELETE", "/suppressions/:email", (c) => ok(removeSuppression(c.db, decodeURIComponent(c.params[0])))),
];

/** Path prefixes owned by the API, so the static site and API can share a port. */
const API_PREFIX = /^\/(emails|domains|api-keys|webhooks|suppressions|stats|settings|preview|auth|health|publication|subscribers|segments|fields|posts|templates|pages|polls|surveys|automations|rewards|referrals|analytics|uploads|events|forms|designs|demo)(\/|$)/;
export const isApiPath = (pathname: string): boolean => API_PREFIX.test(pathname);

// ---- rate limiting (token bucket per API key, in memory) ----------------------
function limiter(perSec: number) {
  const buckets = new Map<string, { tokens: number; at: number }>();
  const burst = Math.max(perSec * 2, 1);
  return (id: string): number => {
    const t = now();
    const b = buckets.get(id) ?? { tokens: burst, at: t };
    b.tokens = Math.min(burst, b.tokens + ((t - b.at) / 1000) * perSec);
    b.at = t;
    buckets.set(id, b);
    if (b.tokens >= 1) { b.tokens -= 1; return 0; }
    return Math.ceil((1 - b.tokens) / perSec);
  };
}

async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > max) throw new ApiError(413, "payload_too_large", `Request body is too large (max ${max === MAX_BODY ? "5 MB" : `${max / 1024} KB`})`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function reply(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}, raw?: string): void {
  if (raw !== undefined) {
    res.writeHead(status, { "cache-control": "no-store", ...headers });
    res.end(raw);
    return;
  }
  const json = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers });
  res.end(json);
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
const PROXY_HEADERS = ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "x-real-ip", "forwarded"];
const MAX_AUTH_BODY = 4 * 1024;
const TOO_MANY = "Too many failed attempts. Try again in 15 minutes.";

export function createApi(db: DB, cfg: Config, kick: () => void, setupCode: string | null = null) {
  const allow = limiter(cfg.rateLimitPerSec);
  const throttle = loginThrottle();
  const attempt = attemptGate();

  /** /auth/*: password setup, sign-in and sign-out for the dashboard. */
  async function handleAuth(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const method = req.method ?? "GET";
    const token = parseCookies(req.headers.cookie)[COOKIE];
    const secure = isHttps(req, db, cfg);
    const ip = clientIp(req, cfg);

    if (pathname === "/auth/status" && method === "GET") {
      return reply(res, 200, { setup_required: !hasPassword(db), authenticated: sessionValid(db, token) });
    }
    if (method !== "POST") throw new ApiError(405, "method_not_allowed", `${method} is not allowed here`);
    if (req.headers["x-newsnest"] !== "1") throw new ApiError(403, "csrf", "Missing X-Newsnest header");

    if (pathname === "/auth/logout") {
      destroySession(db, token);
      return reply(res, 200, { ok: true }, { "set-cookie": sessionCookie("", secure, true) });
    }

    // Who is guessing is decided before the body is read or anything is hashed. A signed-in owner changing the password is
    // counted per session, so strangers' failures can never lock them out.
    let who = `ip:${ip}`;
    if (pathname === "/auth/setup") {
      if (hasPassword(db)) throw new ApiError(409, "already_setup", "A password is already set");
      // First-run setup is only open to someone on the machine itself, never through a proxy.
      const local = LOOPBACK.has(req.socket.remoteAddress ?? "") && LOOPBACK_HOST.test(String(req.headers.host ?? ""))
        && !PROXY_HEADERS.some((h) => req.headers[h] !== undefined) && !cfg.trustProxy && !cfg.publicUrl;
      if (!local) throw new ApiError(403, "setup_local_only", "Create the password from the machine running Newsnest, or set NEWSNEST_ADMIN_PASSWORD");
    } else if (pathname === "/auth/password") {
      if (!sessionValid(db, token)) throw new ApiError(401, "unauthorized", "Sign in first");
      who = `session:${sha256(token!)}`;
    } else if (pathname !== "/auth/login") throw notFound("Route");
    if (throttle.blocked(who)) throw new ApiError(429, "too_many_attempts", TOO_MANY);

    let parsed: unknown = null;
    try { parsed = JSON.parse((await readBody(req, MAX_AUTH_BODY)) || "null"); } catch (e) { if (e instanceof ApiError) throw e; throw validation("Request body is not valid JSON"); }
    const body = obj(parsed);
    const password = typeof body.password === "string" ? body.password : "";

    if (pathname === "/auth/setup") {
      const code = typeof body.setup_code === "string" ? body.setup_code : "";
      if (!setupCode || !(await attempt(() => setupCodeMatches(setupCode, code)))) {
        throttle.fail(who);
        throw new ApiError(403, "invalid_setup_code", "That setup code is wrong. It is printed in the terminal where you started Newsnest.");
      }
      if (password.length < MIN_PASSWORD) throw validation(`Use at least ${MIN_PASSWORD} characters`);
      setPassword(db, password);
      return reply(res, 201, { ok: true }, { "set-cookie": sessionCookie(createSession(db), secure) });
    }
    if (pathname === "/auth/password") {
      if (!(await attempt(() => checkPassword(db, password)))) { throttle.fail(who); throw new ApiError(401, "invalid_credentials", "Your current password is wrong"); }
      const next = typeof body.new_password === "string" ? body.new_password : "";
      if (next.length < MIN_PASSWORD) throw validation(`Use at least ${MIN_PASSWORD} characters`);
      throttle.clear(who);
      setPassword(db, next); // signs every session out, including this one, so start a fresh one
      return reply(res, 200, { ok: true }, { "set-cookie": sessionCookie(createSession(db), secure) });
    }
    // /auth/login
    if (!hasPassword(db) || !(await attempt(() => checkPassword(db, password)))) {
      throttle.fail(who);
      throw new ApiError(401, "invalid_credentials", "Wrong password");
    }
    throttle.clear(who);
    return reply(res, 200, { ok: true }, { "set-cookie": sessionCookie(createSession(db), secure) });
  }

  return async function handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const method = req.method ?? "GET";
    try {
      if (url.pathname === "/health" && method === "GET") return reply(res, 200, { ok: true, mode: cfg.mode });

      if (url.pathname.startsWith("/auth/")) return await handleAuth(req, res, url.pathname);

      let key: ApiKeyInfo | null = authenticate(db, req.headers.authorization);
      if (!key && !req.headers.authorization && sessionValid(db, parseCookies(req.headers.cookie)[COOKIE])) {
        // Dashboard session. The custom header can't be sent by a cross-site form, which blocks CSRF.
        if (req.headers["x-newsnest"] !== "1") throw new ApiError(403, "csrf", "Missing X-Newsnest header");
        key = { id: "session", permission: "full", domain_id: null, session: true };
      }
      if (!key) throw new ApiError(401, "missing_api_key", "Missing or invalid API key. Send it as: Authorization: Bearer nn_...", { "www-authenticate": "Bearer" });

      const wait = allow(key.id);
      if (wait) throw new ApiError(429, "rate_limit_exceeded", "Too many requests", { "retry-after": String(wait) });

      let matched: Route | undefined;
      let params: string[] = [];
      let pathMatched = false;
      for (const r of ROUTES) {
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        pathMatched = true;
        if (r.method === method) { matched = r; params = m.slice(1); break; }
      }
      // /emails/batch must win over /emails/:id for POST; the ordered route list handles that.
      if (!matched) throw pathMatched ? new ApiError(405, "method_not_allowed", `${method} is not allowed here`) : notFound("Route");
      if (key.permission === "sending" && !matched.sending) throw new ApiError(403, "restricted_api_key", "This API key can only send and read emails");

      const raw = method === "GET" || method === "DELETE" ? "" : await readBody(req);
      let body: unknown = undefined;
      if (raw) {
        try { body = JSON.parse(raw); } catch { throw validation("Request body is not valid JSON"); }
      }

      const idemKey = matched.idempotent ? req.headers["idempotency-key"] : undefined;
      if (typeof idemKey === "string" && idemKey) {
        if (idemKey.length > 256) throw validation("Idempotency-Key is too long (max 256)");
        db.prepare("DELETE FROM idempotency WHERE created_at < ?").run(now() - IDEMPOTENCY_TTL_MS);
        const hash = sha256(method + url.pathname + raw);
        const seen = db.prepare("SELECT request_hash, status, body FROM idempotency WHERE api_key_id = ? AND key = ?").get(key.id, idemKey) as
          { request_hash: string; status: number; body: string } | undefined;
        if (seen) {
          if (seen.request_hash !== hash) throw new ApiError(409, "invalid_idempotent_request", "This Idempotency-Key was already used with a different request");
          return reply(res, seen.status, JSON.parse(seen.body), { "idempotent-replayed": "true" });
        }
        const out = await matched.handler({ db, cfg, key, params, query: url.searchParams, body, kick });
        db.prepare("INSERT INTO idempotency (key, api_key_id, request_hash, status, body, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(idemKey, key.id, hash, out.status, JSON.stringify(out.body), now());
        return reply(res, out.status, out.body, out.headers, out.raw);
      }

      const out = await matched.handler({ db, cfg, key, params, query: url.searchParams, body, kick });
      reply(res, out.status, out.body, out.headers, out.raw);
    } catch (e) {
      if (e instanceof ApiError) return reply(res, e.status, { statusCode: e.status, name: e.code, message: e.message }, e.headers);
      if (e instanceof URIError) return reply(res, 400, { statusCode: 400, name: "bad_request", message: "The address contains invalid % encoding" }); // decodeURIComponent on a path segment
      console.error("api error:", e);
      reply(res, 500, { statusCode: 500, name: "internal_server_error", message: "Something went wrong on our side" });
    }
  };
}
