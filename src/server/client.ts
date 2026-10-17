import { isIP, isIPv6 } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { baseUrl } from "./newsletter/publication.ts";

/** IPv6 clients are told apart by their /64: one subscriber line hands out a whole /64, so single addresses are free to rotate. */
function normalise(ip: string): string {
  const addr = ip.replace(/%.*$/, "").toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return mapped[1];
  if (!isIPv6(addr)) return addr;
  const [head, tail] = addr.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = addr.includes("::") ? [...front, ...new Array(8 - front.length - back.length).fill("0"), ...back] : front;
  return groups.slice(0, 4).map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

/**
 * The address a request came from, as a key for rate limits. Behind a proxy you control (NEWSNEST_TRUST_PROXY=1) that is the
 * LAST X-Forwarded-For entry, the one the proxy itself appended; earlier entries are whatever the client claimed.
 * Otherwise it is the socket peer, which is the proxy's own address if there is one, so never trust the header without a proxy.
 */
export function clientIp(req: IncomingMessage, cfg: Pick<Config, "trustProxy">): string {
  if (cfg.trustProxy) {
    const last = String(req.headers["x-forwarded-for"] ?? "").split(",").pop()?.trim() ?? "";
    if (isIP(last.replace(/%.*$/, ""))) return normalise(last).slice(0, 64);
  }
  return normalise(req.socket.remoteAddress ?? "unknown").slice(0, 64);
}

/** Whether the public face of this server is HTTPS, which decides the Secure cookie flag and HSTS. */
export function isHttps(req: IncomingMessage, db: DB, cfg: Config): boolean {
  if (/^https:/i.test(baseUrl(db, cfg))) return true;
  // A client can send X-Forwarded-Proto itself, so it only counts when a trusted proxy is in front.
  return cfg.trustProxy && String(req.headers["x-forwarded-proto"] ?? "").split(",").pop()?.trim().toLowerCase() === "https";
}
