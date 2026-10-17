// Minimal SMTP client: direct-to-MX delivery or relay through your own SMTP server.
// EHLO/HELO, STARTTLS, implicit TLS, AUTH PLAIN/LOGIN, dot-stuffing.
import net from "node:net";
import tls from "node:tls";
import { lookup, promises as dns } from "node:dns";

export class SMTPError extends Error {
  code: number;
  stage: string;
  permanent: boolean;
  host: string;
  constructor(message: string, opts: { code?: number; stage?: string; permanent?: boolean; host?: string } = {}) {
    super(message);
    this.code = opts.code ?? 0;
    this.stage = opts.stage ?? "CONNECT";
    this.permanent = opts.permanent ?? false;
    this.host = opts.host ?? "";
  }
}

/** A mail server can drip bytes forever or never end a line, so what we are willing to buffer from one is capped. */
const MAX_REPLY_LINE = 1024;
const MAX_REPLY_LINES = 100;
/** Wall-clock limit for one message, however slowly the server answers. The socket's idle timeout alone resets on every byte. */
const DELIVERY_DEADLINE_MS = 3 * 60_000;

const NON_PUBLIC = new net.BlockList();
for (const [addr, bits] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4]] as const) NON_PUBLIC.addSubnet(addr, bits, "ipv4");
for (const [addr, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) NON_PUBLIC.addSubnet(addr, bits, "ipv6");

/** False for loopback, private, link-local, multicast and other addresses a public mail server should never have. */
export const isPublicAddress = (ip: string): boolean => !NON_PUBLIC.check(ip, net.isIPv6(ip) ? "ipv6" : "ipv4");

/** dns.lookup that drops non-public answers, so the address we connect to is the one that was checked (no rebinding gap). */
const publicLookup: net.LookupFunction = (hostname, options, callback) => {
  lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address as never, family as never);
    const list = Array.isArray(address) ? address : [{ address, family }];
    const allowed = list.filter((a) => isPublicAddress(a.address));
    if (!allowed.length) return callback(new Error("it resolves to a private or loopback address") as NodeJS.ErrnoException, "", 4);
    if (Array.isArray(address)) callback(null, allowed as never, undefined as never);
    else callback(null, allowed[0].address, allowed[0].family as never);
  });
};

interface Reply { code: number; lines: string[]; text: string }
interface Waiter { resolve: (r: Reply) => void; reject: (e: Error) => void }

// SNI must be a hostname, never an IP address (RFC 6066).
const sni = (host: string): string | undefined => (net.isIP(host) ? undefined : host);

function openSocket(o: { host: string; port: number; secure: boolean; rejectUnauthorized: boolean; connectTimeout: number; publicOnly: boolean }): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    // An IP address in the MX record never goes through lookup, so check it here.
    if (o.publicOnly && net.isIP(o.host) && !isPublicAddress(o.host)) {
      return reject(new SMTPError(`${o.host}:${o.port} — refusing to connect to a private or loopback address`, { host: o.host }));
    }
    const sock = o.secure
      ? tls.connect({ host: o.host, port: o.port, servername: sni(o.host), rejectUnauthorized: o.rejectUnauthorized })
      : net.connect({ host: o.host, port: o.port, ...(o.publicOnly ? { lookup: publicLookup } : {}) });
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new SMTPError(`Timed out connecting to ${o.host}:${o.port}`, { host: o.host }));
    }, o.connectTimeout);
    sock.once(o.secure ? "secureConnect" : "connect", () => { clearTimeout(timer); resolve(sock); });
    sock.once("error", (e) => { clearTimeout(timer); reject(new SMTPError(`${o.host}:${o.port} — ${e.message}`, { host: o.host })); });
  });
}

class Connection {
  sock!: net.Socket;
  host: string;
  timeout: number;
  buf = "";
  cur: string[] = [];
  ready: Reply[] = [];
  waiters: Waiter[] = [];
  error: Error | null = null;

  constructor(sock: net.Socket, timeout: number, host: string) {
    this.timeout = timeout;
    this.host = host;
    this.attach(sock);
  }

  attach(sock: net.Socket): void {
    this.sock = sock;
    this.buf = "";
    this.cur = [];
    this.ready = [];
    this.waiters = [];
    this.error = null;
    sock.setEncoding("utf8");
    sock.on("data", (d: string) => this.onData(d));
    sock.on("error", (e) => this.fail(new SMTPError(e.message, { host: this.host })));
    sock.on("close", () => this.fail(new SMTPError("Connection closed by server", { host: this.host })));
    sock.setTimeout(this.timeout, () => {
      this.fail(new SMTPError("Server timed out", { host: this.host }));
      sock.destroy();
    });
  }

  /** Gives up on the connection: the error reaches whoever is waiting, and the socket is closed. */
  abort(message: string): void {
    this.fail(new SMTPError(message, { host: this.host }));
    this.sock.destroy();
  }

  onData(chunk: string): void {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (line.length > MAX_REPLY_LINE) return this.abort(`${this.host} sent a reply line that is too long`);
      this.cur.push(line);
      if (this.cur.length > MAX_REPLY_LINES) return this.abort(`${this.host} sent too many reply lines`);
      if (/^\d{3}(?: |$)/.test(line)) {
        this.ready.push({ code: Number(line.slice(0, 3)), lines: this.cur.map((l) => l.slice(4)), text: this.cur.join(" ").slice(0, 500) });
        this.cur = [];
        if (this.ready.length > MAX_REPLY_LINES) return this.abort(`${this.host} sent too many replies`);
      }
    }
    if (this.buf.length > MAX_REPLY_LINE) return this.abort(`${this.host} sent a reply line that is too long`);
    while (this.ready.length && this.waiters.length) this.waiters.shift()!.resolve(this.ready.shift()!);
  }

  fail(err: Error): void {
    if (this.error) return;
    this.error = err;
    for (const w of this.waiters.splice(0)) w.reject(err);
  }

  read(): Promise<Reply> {
    return new Promise((resolve, reject) => {
      if (this.ready.length) return resolve(this.ready.shift()!);
      if (this.error) return reject(this.error);
      this.waiters.push({ resolve, reject });
    });
  }

  async cmd(line: string, stage: string, ok: number[] = [250]): Promise<Reply> {
    this.sock.write(line + "\r\n");
    const r = await this.read();
    if (!ok.includes(r.code)) {
      throw new SMTPError(`${stage} rejected by ${this.host}: ${r.text}`, { code: r.code, stage, permanent: r.code >= 500, host: this.host });
    }
    return r;
  }

  upgrade(o: { servername: string; rejectUnauthorized: boolean }): Promise<void> {
    const raw = this.sock;
    raw.removeAllListeners("data");
    raw.removeAllListeners("error");
    raw.removeAllListeners("close");
    raw.setTimeout(0);
    return new Promise((resolve, reject) => {
      const secure = tls.connect({ socket: raw, servername: sni(o.servername), rejectUnauthorized: o.rejectUnauthorized });
      secure.once("secureConnect", () => { this.attach(secure); resolve(); });
      secure.once("error", (e) => reject(new SMTPError(`TLS handshake with ${this.host} failed: ${e.message}`, { stage: "STARTTLS", host: this.host })));
      secure.once("close", () => reject(new SMTPError(`TLS handshake with ${this.host} was cut off`, { stage: "STARTTLS", host: this.host })));
    });
  }
}

async function hello(c: Connection, name: string): Promise<Map<string, string>> {
  c.sock.write(`EHLO ${name}\r\n`);
  const r = await c.read();
  if (r.code !== 250) {
    await c.cmd(`HELO ${name}`, "HELO");
    return new Map();
  }
  const ext = new Map<string, string>();
  for (const l of r.lines.slice(1)) {
    const [k, ...rest] = l.trim().split(/\s+/);
    ext.set(k.toUpperCase(), rest.join(" ").toUpperCase());
  }
  return ext;
}

const b64 = (s: string): string => Buffer.from(s, "utf8").toString("base64");

export interface SendOptions {
  host: string;
  port: number;
  secure?: boolean;
  requireTLS?: boolean;
  rejectUnauthorized?: boolean;
  auth?: { user: string; pass?: string } | null;
  ehloName?: string;
  from: string;
  to: string[];
  raw: string;
  timeout?: number;
  connectTimeout?: number;
  /** Most time the whole session may take once connected. */
  deadline?: number;
  /** Refuse to connect to loopback, private and link-local addresses (direct delivery to someone else's MX). */
  publicOnly?: boolean;
}

/** Send one message over one SMTP session. */
export async function send(o: SendOptions): Promise<{ host: string; response: string; tls: boolean }> {
  const { host, port, secure = false, requireTLS = false, rejectUnauthorized = true, auth, ehloName = "localhost",
    from, to, raw, timeout = 60000, connectTimeout = 15000, deadline = DELIVERY_DEADLINE_MS, publicOnly = false } = o;
  const sock = await openSocket({ host, port, secure, rejectUnauthorized, connectTimeout, publicOnly });
  const c = new Connection(sock, timeout, host);
  const timer = setTimeout(() => c.abort(`Delivery to ${host} took longer than ${Math.round(deadline / 1000)} seconds`), deadline);
  try {
    const greet = await c.read();
    if (greet.code !== 220) throw new SMTPError(`${host} greeting: ${greet.text}`, { code: greet.code, stage: "CONNECT", host });
    let ext = await hello(c, ehloName);
    let tlsUsed = secure;
    if (!secure && ext.has("STARTTLS")) {
      await c.cmd("STARTTLS", "STARTTLS", [220]);
      await c.upgrade({ servername: host, rejectUnauthorized });
      ext = await hello(c, ehloName);
      tlsUsed = true;
    } else if (!secure && requireTLS) {
      throw new SMTPError(`${host} does not offer STARTTLS`, { stage: "STARTTLS", host });
    }
    if (auth?.user) {
      const mechs = ext.get("AUTH") ?? "";
      if (mechs.includes("PLAIN") || !mechs.includes("LOGIN")) {
        await c.cmd(`AUTH PLAIN ${b64(`\0${auth.user}\0${auth.pass ?? ""}`)}`, "AUTH", [235]);
      } else {
        await c.cmd("AUTH LOGIN", "AUTH", [334]);
        await c.cmd(b64(auth.user), "AUTH", [334]);
        await c.cmd(b64(auth.pass ?? ""), "AUTH", [235]);
      }
    }
    await c.cmd(`MAIL FROM:<${from}>`, "MAIL FROM");
    for (const rcpt of to) await c.cmd(`RCPT TO:<${rcpt}>`, "RCPT TO", [250, 251]);
    await c.cmd("DATA", "DATA", [354]);
    const data = raw.replace(/(^|\r\n)\./g, "$1..");
    const done = await c.cmd(data + (data.endsWith("\r\n") ? "" : "\r\n") + ".", "DATA");
    c.sock.end("QUIT\r\n");
    return { host, response: done.text, tls: tlsUsed };
  } catch (e) {
    c.sock.destroy();
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function mxHosts(domain: string): Promise<string[]> {
  try {
    const mx = await dns.resolveMx(domain);
    if (!mx.length) return [domain];
    if (mx.length === 1 && (mx[0].exchange === "" || mx[0].exchange === ".")) {
      throw new SMTPError(`${domain} does not accept email (null MX)`, { stage: "RCPT TO", permanent: true });
    }
    return mx.sort((a, b) => a.priority - b.priority).map((m) => m.exchange);
  } catch (e) {
    if (e instanceof SMTPError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENODATA") return [domain];
    if (code === "ENOTFOUND") throw new SMTPError(`Domain ${domain} does not exist`, { stage: "RCPT TO", permanent: true });
    throw new SMTPError(`DNS lookup for ${domain} failed: ${code ?? (e as Error).message}`);
  }
}

/** Deliver straight to the recipient's mail server (no relay, no third party). */
export async function sendDirect(o: { from: string; to: string; raw: string; ehloName: string }): Promise<{ host: string; response: string; tls: boolean }> {
  const domain = o.to.split("@")[1];
  const hosts = await mxHosts(domain);
  let last: SMTPError | undefined;
  const end = Date.now() + DELIVERY_DEADLINE_MS; // one budget for all the MX hosts, not one each
  for (const host of hosts.slice(0, 4)) {
    const left = end - Date.now();
    if (left < 1000) break;
    try {
      // rejectUnauthorized stays off: most MX servers have self-signed certificates and STARTTLS is opportunistic.
      return await send({ host, port: 25, rejectUnauthorized: false, publicOnly: true, deadline: left, ehloName: o.ehloName, from: o.from, to: [o.to], raw: o.raw });
    } catch (e) {
      if ((e as SMTPError).permanent) throw e;
      last = e as SMTPError;
    }
  }
  if (last && !last.code) {
    last.message += " — if every attempt times out, your network probably blocks outbound port 25; switch to relay mode.";
  }
  throw last ?? new SMTPError(`No mail servers for ${domain}`);
}

/**
 * smtp://user:pass@host:587 (STARTTLS when offered, required if credentials are given)
 * or smtps://user:pass@host:465 (implicit TLS).
 */
export function parseRelayUrl(url: string): Pick<SendOptions, "host" | "port" | "secure" | "requireTLS" | "auth"> {
  const u = new URL(url);
  if (u.protocol !== "smtp:" && u.protocol !== "smtps:") throw new Error("Relay URL must start with smtp:// or smtps://");
  const secure = u.protocol === "smtps:";
  return {
    host: u.hostname,
    port: Number(u.port || (secure ? 465 : 587)),
    secure,
    requireTLS: !secure && Boolean(u.username),
    auth: u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password) } : null,
  };
}
