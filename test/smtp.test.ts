import assert from "node:assert/strict";
import net from "node:net";
import { describe, test } from "node:test";
import { SMTPError, isPublicAddress, send } from "../src/server/smtp.ts";
import type { Transport } from "../src/server/queue.ts";
import { harness, verifiedDomain } from "./helpers.ts";

/** A mail server that misbehaves on purpose: `onConnect` decides what it sends. */
async function hostile(onConnect: (sock: net.Socket) => void): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    sock.on("error", () => {});
    onConnect(sock);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as net.AddressInfo).port, close: () => new Promise((r) => { server.close(() => r()); sockets.forEach((s) => s.destroy()); }) };
}

const attempt = (port: number, extra: Record<string, unknown> = {}) =>
  send({ host: "127.0.0.1", port, from: "a@example.com", to: ["b@example.org"], raw: "Subject: x\r\n\r\nhi\r\n", ...extra });

/** Calls `fn` every `ms` until the socket closes. */
const every = (sock: net.Socket, ms: number, fn: () => void): void => {
  const t = setInterval(fn, ms);
  sock.on("close", () => clearInterval(t));
};

describe("a hostile mail server", () => {
  test("a reply that never ends its line is cut off", async () => {
    const srv = await hostile((s) => every(s, 1, () => s.write("x".repeat(4096))));
    try {
      await assert.rejects(attempt(srv.port), (e: SMTPError) => /too long/.test(e.message));
    } finally { await srv.close(); }
  });

  test("a reply with endless continuation lines is cut off", async () => {
    const srv = await hostile((s) => every(s, 1, () => s.write("220-hello\r\n".repeat(50))));
    try {
      await assert.rejects(attempt(srv.port), (e: SMTPError) => /too many/.test(e.message));
    } finally { await srv.close(); }
  });

  test("dripping bytes forever hits the wall-clock deadline even though the socket never goes idle", async () => {
    const srv = await hostile((s) => every(s, 20, () => s.write("2")));
    const started = Date.now();
    try {
      await assert.rejects(attempt(srv.port, { deadline: 400 }), (e: SMTPError) => /took longer/.test(e.message));
      assert.ok(Date.now() - started < 3000);
    } finally { await srv.close(); }
  });
});

describe("direct delivery targets", () => {
  test("loopback, private and link-local addresses are not public", () => {
    for (const ip of ["127.0.0.1", "10.0.0.5", "172.16.9.9", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1"]) assert.equal(isPublicAddress(ip), false, ip);
    for (const ip of ["8.8.8.8", "93.184.216.34", "2606:4700::1111"]) assert.equal(isPublicAddress(ip), true, ip);
  });

  test("publicOnly refuses an IP literal and a name that resolves to loopback, but relay-style connections still work", async () => {
    const srv = await hostile((s) => s.write("554 go away\r\n"));
    try {
      await assert.rejects(attempt(srv.port, { publicOnly: true }), /private or loopback/);
      await assert.rejects(attempt(srv.port, { host: "localhost", publicOnly: true }), /private or loopback/);
      await assert.rejects(attempt(srv.port), (e: SMTPError) => e.code === 554, "without the flag it connects and reads the greeting");
    } finally { await srv.close(); }
  });
});

describe("the queue", () => {
  test("one stuck delivery does not hold up the others", async () => {
    let release = () => {};
    const delivered: string[] = [];
    const transport: Transport = {
      deliver: ({ to }) => {
        if (to === "stuck@dest.test") return new Promise((resolve) => { release = () => resolve({ response: "late", delivered: false }); });
        delivered.push(to);
        return Promise.resolve({ response: "ok", delivered: false });
      },
    };
    const h = await harness({}, { transport });
    try {
      await verifiedDomain(h);
      const mail = (to: string) => h.call("POST", "/emails", { from: "a@example.com", to, subject: "hi", text: "x" });
      await mail("stuck@dest.test");
      await h.waitFor(() => h.app.db.prepare("SELECT 1 FROM deliveries WHERE recipient = 'stuck@dest.test' AND status = 'sending'").get());
      await mail("fine@dest.test");
      await h.waitFor(() => delivered.includes("fine@dest.test"), 8000);
      assert.equal((h.app.db.prepare("SELECT status FROM deliveries WHERE recipient = 'stuck@dest.test'").get() as { status: string }).status, "sending");
      await mail("later@dest.test");
      await h.waitFor(() => delivered.includes("later@dest.test"), 8000);
    } finally {
      release();
      await h.close();
    }
  });
});
