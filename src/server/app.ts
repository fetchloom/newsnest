import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { Server } from "node:http";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApi, isApiPath } from "./api.ts";
import { isHttps } from "./client.ts";
import { securityHeaders } from "./headers.ts";
import { createLive } from "./live.ts";
import { checkPassword, hasPassword, newSetupCode, setPassword } from "./auth.ts";
import type { Config } from "./config.ts";
import { openDb } from "./db.ts";
import type { DB } from "./db.ts";
import { startQueue } from "./queue.ts";
import type { Queue, Transport } from "./queue.ts";
import { bus, runtime } from "./newsletter/bus.ts";
import { registerAutomations } from "./newsletter/automations.ts";
import { registerMailers } from "./newsletter/mailer.ts";
import { createPublic } from "./newsletter/public.ts";
import { getPublication } from "./newsletter/publication.ts";
import { registerReferrals } from "./newsletter/referrals.ts";
import { handleSite } from "./newsletter/site.ts";
import { readUpload } from "./newsletter/uploads.ts";
import { serveStatic } from "./static.ts";
import type { Fetch } from "./webhooks.ts";

const EMBED_JS = fileURLToPath(new URL("../../public/embed.js", import.meta.url));

export interface App {
  server: Server;
  db: DB;
  queue: Queue;
  /** First run with no password yet: the code that must be typed into the setup screen. Printed by server.ts, never logged here. */
  setupCode: string | null;
  close(): Promise<void>;
}

export function createApp(cfg: Config, deps: { transport?: Transport; fetch?: Fetch; serveSite?: boolean } = {}): App {
  mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
  const db = openDb(join(cfg.dataDir, "newsnest.db"));
  // NEWSNEST_ADMIN_PASSWORD sets the first password, and is also the way back in if it is forgotten.
  if (cfg.adminPassword && !checkPassword(db, cfg.adminPassword)) {
    if (hasPassword(db)) console.warn("NEWSNEST_ADMIN_PASSWORD reset the dashboard password. Remove it from the environment once you are signed in, or it resets again on every start.");
    setPassword(db, cfg.adminPassword);
  }
  const queue = startQueue(db, cfg, deps.transport, deps.fetch);
  const setupCode = hasPassword(db) ? null : newSetupCode();
  const api = createApi(db, cfg, queue.kick, setupCode);
  const publicSite = createPublic(db, cfg);
  const live = createLive(db);
  runtime.kick = queue.kick;
  registerMailers();
  registerAutomations();
  registerReferrals();
  void bus;

  const server = createServer((req, res) => {
    void (async () => {
      try {
        // Only origin-form targets ("/path"). "//host/x", "/\\host" and "http://host/x" are refused: a front proxy and this
        // app could otherwise disagree about the path, and "//a:b/x" is not a URL the parser accepts.
        let url: URL;
        try {
          if (!/^\/(?![/\\])/.test(req.url ?? "")) throw new Error("bad target");
          url = new URL(req.url!, "http://localhost");
        } catch {
          res.writeHead(400, { "content-type": "text/plain" });
          res.end("Bad request");
          return;
        }
        const { pathname } = url;
        // Requests on the publication's own domain get the website at /.
        const host = String(req.headers.host ?? "").split(":")[0].toLowerCase();
        const siteDomain = getPublication(db).site_domain;
        const hostMode = Boolean(siteDomain) && host === siteDomain;
        const siteRequest = hostMode && (req.method === "GET" || req.method === "HEAD") && !/^\/(subscribe|confirm|u|o|l|poll|s|r|login|magic|logout|uploads|live|embed\.js)(\/|\.|$)/.test(pathname);
        securityHeaders(res, { pathname, siteDomain: siteRequest, https: isHttps(req, db, cfg), embed: pathname === "/subscribe" && (req.method === "POST" || url.searchParams.get("embed") === "1") });

        if (siteRequest && handleSite(db, cfg, req, res, pathname, url.searchParams, true)) return;
        if (pathname === "/embed.js" && (req.method === "GET" || req.method === "HEAD")) {
          res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff" });
          res.end(readFileSync(EMBED_JS));
          return;
        }
        if (pathname === "/live" && req.method === "GET") return live(req, res);
        if (await publicSite(req, res, url)) return;
        if (pathname === "/p" || pathname.startsWith("/p/")) { if (handleSite(db, cfg, req, res, pathname, url.searchParams, false)) return; }
        const up = /^\/uploads\/([^/]+)$/.exec(pathname);
        if (up) {
          const f = readUpload(cfg, up[1]);
          if (!f) { res.writeHead(404); res.end(); return; }
          res.writeHead(200, { "content-type": f.mime, "cache-control": "public, max-age=31536000, immutable", "x-content-type-options": "nosniff" });
          res.end(f.body);
          return;
        }
        if (isApiPath(pathname)) await api(req, res, url);
        else if (deps.serveSite === false) { res.writeHead(404); res.end(); }
        else await serveStatic(req, res, url);
      } catch (e) {
        console.error("request error:", e);
        if (!res.headersSent) { res.writeHead((e as { status?: number }).status ?? 500, { "content-type": "text/plain" }); }
        res.end("Something went wrong");
      }
    })();
  });

  return {
    server,
    db,
    queue,
    setupCode,
    close: () =>
      new Promise((resolve) => {
        server.close(() => { void queue.stop().then(() => { db.close(); resolve(); }); });
        server.closeAllConnections();
      }),
  };
}
