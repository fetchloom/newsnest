import { mkdtempSync, rmSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/server/app.ts";
import type { App } from "../src/server/app.ts";
import { loadConfig } from "../src/server/config.ts";
import type { Config } from "../src/server/config.ts";
import { createKey } from "../src/server/keys.ts";
import type { Fetch } from "../src/server/webhooks.ts";

export interface FakeSmtp {
  port: number;
  messages: { from: string; to: string[]; data: string }[];
  /** Respond to RCPT TO with this code/text for recipients matching `match`. */
  rejectRcpt: { match: RegExp; code: number; text: string } | null;
  close(): Promise<void>;
}

export async function fakeSmtp(): Promise<FakeSmtp> {
  const state: FakeSmtp = { port: 0, messages: [], rejectRcpt: null, close: async () => {} };
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.setEncoding("utf8");
    let from = "";
    let to: string[] = [];
    let data = "";
    let inData = false;
    let buf = "";
    sock.write("220 fake ESMTP\r\n");
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let i: number;
      while ((i = buf.indexOf("\r\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === ".") {
            inData = false;
            state.messages.push({ from, to, data });
            data = "";
            sock.write("250 2.0.0 queued as FAKE1\r\n");
          } else data += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
          continue;
        }
        const cmd = line.toUpperCase();
        if (cmd.startsWith("EHLO")) sock.write("250-fake\r\n250 8BITMIME\r\n");
        else if (cmd.startsWith("MAIL FROM:")) { from = line.slice(10).replace(/[<>]/g, ""); to = []; sock.write("250 ok\r\n"); }
        else if (cmd.startsWith("RCPT TO:")) {
          const rcpt = line.slice(8).replace(/[<>]/g, "");
          if (state.rejectRcpt?.match.test(rcpt)) sock.write(`${state.rejectRcpt.code} ${state.rejectRcpt.text}\r\n`);
          else { to.push(rcpt); sock.write("250 ok\r\n"); }
        } else if (cmd === "DATA") { inData = true; sock.write("354 go\r\n"); }
        else if (cmd === "QUIT") { sock.end("221 bye\r\n"); }
        else sock.write("250 ok\r\n");
      }
    });
    sock.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  state.port = (server.address() as net.AddressInfo).port;
  state.close = () => new Promise((r) => { server.close(() => r()); sockets.forEach((s) => s.destroy()); });
  return state;
}

export interface Harness {
  app: App;
  base: string;
  cfg: Config;
  smtp: FakeSmtp;
  key: string;
  webhookCalls: { url: string; headers: Record<string, string>; body: string }[];
  webhookStatus: { code: number };
  dnsTxt: Map<string, string[][]>;
  call(method: string, path: string, body?: unknown, headers?: Record<string, string>, key?: string | null): Promise<{ status: number; json: any; headers: Headers }>;
  waitFor<T>(fn: () => T | undefined | false, ms?: number): Promise<T>;
  close(): Promise<void>;
}

export async function harness(overrides: Partial<Config> = {}): Promise<Harness> {
  const smtp = await fakeSmtp();
  const dir = mkdtempSync(join(tmpdir(), "freepost-test-"));
  const dnsTxt = new Map<string, string[][]>();
  const cfg = loadConfig({}, {
    dataDir: dir,
    mode: "relay",
    relayUrl: `smtp://127.0.0.1:${smtp.port}`,
    workerIntervalMs: 50,
    rateLimitPerSec: 1000,
    resolveTxt: async (name) => {
      const v = dnsTxt.get(name);
      if (!v) throw Object.assign(new Error("nodata"), { code: "ENODATA" });
      return v;
    },
    ...overrides,
  });

  const webhookCalls: Harness["webhookCalls"] = [];
  const webhookStatus = { code: 200 };
  const fakeFetch: Fetch = async (url, init) => {
    webhookCalls.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
    return new Response("ok", { status: webhookStatus.code });
  };

  const app = createApp(cfg, { fetch: fakeFetch, serveSite: false });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${(app.server.address() as net.AddressInfo).port}`;
  const key = createKey(app.db, { name: "test" }).key;

  const h: Harness = {
    app, base, cfg, smtp, key, webhookCalls, webhookStatus, dnsTxt,
    async call(method, path, body, headers = {}, k = key) {
      const res = await fetch(base + path, {
        method,
        headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(k ? { authorization: `Bearer ${k}` } : {}), ...headers },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      return { status: res.status, json: text ? JSON.parse(text) : null, headers: res.headers };
    },
    async waitFor(fn, ms = 4000) {
      const end = Date.now() + ms;
      for (;;) {
        const v = fn();
        if (v) return v;
        if (Date.now() > end) throw new Error("waitFor timed out");
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    async close() {
      await app.close();
      await smtp.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
  return h;
}

/** Adds a domain through the API and publishes its DKIM record in the fake DNS. */
export async function verifiedDomain(h: Harness, name = "example.com") {
  const created = await h.call("POST", "/domains", { name });
  const dkim = created.json.records.find((r: any) => r.record === "DKIM");
  h.dnsTxt.set(`${dkim.name}.${name}`, [[dkim.value]]);
  const verified = await h.call("POST", `/domains/${created.json.id}/verify`);
  return { id: created.json.id as string, publicKey: dkim.value.split("p=")[1] as string, verified };
}
