// Builds RFC 5322 / MIME messages and signs them with DKIM (rsa-sha256, relaxed/relaxed).
import { createHash, createPublicKey, sign, verify } from "node:crypto";

export interface Address { name?: string | null; email: string }
export interface DkimKey { domain: string; selector: string; privateKey: string }

export interface BuildInput {
  from: Address;
  to: Address[];
  cc?: Address[];
  replyTo?: string[];
  subject: string;
  html: string;
  text: string;
  headers?: Record<string, string>;
  messageId: string;
  date?: Date;
  dkim?: DkimKey | null;
}

type Header = [name: string, value: string];

const isAscii = (s: string): boolean => /^[\x20-\x7e]*$/.test(s);
const clean = (v: string): string => String(v).replace(/[\r\n]+/g, " ");

// RFC 2047 encoded-words, split on code points so multi-byte characters stay whole.
export function encodeWord(str: string): string {
  if (isAscii(str)) return str;
  const words: string[] = [];
  let chunk = "";
  for (const ch of str) {
    if (Buffer.byteLength(chunk + ch) > 45) { words.push(chunk); chunk = ""; }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString("base64")}?=`).join("\r\n ");
}

function foldAscii(value: string, nameLen: number): string {
  if (value.length + nameLen + 2 <= 78) return value;
  const lines: string[] = [];
  let line = "";
  let limit = 76 - nameLen - 2;
  for (const w of value.split(" ")) {
    if (line && (line + " " + w).length > limit) { lines.push(line); line = w; limit = 76; }
    else line = line ? line + " " + w : w;
  }
  lines.push(line);
  return lines.join("\r\n ");
}

export function address({ name, email }: Address): string {
  if (!name) return email;
  const n = isAscii(name)
    ? (/[()<>\[\]:;@\\,."]/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : name)
    : encodeWord(name);
  return `${n} <${email}>`;
}

const base64Lines = (s: string): string => Buffer.from(s, "utf8").toString("base64").replace(/.{76}/g, "$&\r\n");

export function build(input: BuildInput): string {
  const boundary = "=_fp_" + createHash("sha256").update(input.messageId).digest("hex").slice(0, 24);
  const subject = clean(input.subject);
  const date = (input.date ?? new Date()).toUTCString().replace(/GMT$/, "+0000");

  const list: Header[] = [["From", address(input.from)], ["To", input.to.map(address).join(", ")]];
  if (input.cc?.length) list.push(["Cc", input.cc.map(address).join(", ")]);
  if (input.replyTo?.length) list.push(["Reply-To", input.replyTo.map(clean).join(", ")]);
  list.push(
    ["Subject", isAscii(subject) ? foldAscii(subject, 7) : encodeWord(subject)],
    ["Date", date],
    ["Message-ID", input.messageId],
    ["MIME-Version", "1.0"],
  );
  for (const [k, v] of Object.entries(input.headers ?? {})) if (v !== "") list.push([k, clean(v)]);
  list.push(["Content-Type", `multipart/alternative; boundary="${boundary}"`]);

  const body =
    `--${boundary}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(input.text)}\r\n` +
    `--${boundary}\r\nContent-Type: text/html; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${base64Lines(input.html)}\r\n` +
    `--${boundary}--\r\n`;

  if (input.dkim) list.unshift(dkimSign(list, body, input.dkim));
  return list.map(([k, v]) => `${k}: ${v}`).join("\r\n") + "\r\n\r\n" + body;
}

// ---- DKIM (RFC 6376) --------------------------------------------------------
const SIGNED = ["from", "to", "cc", "reply-to", "subject", "date", "message-id", "mime-version", "content-type",
  "list-unsubscribe", "list-unsubscribe-post", "list-id"];

const relaxedHeader = (name: string, value: string): string =>
  name.toLowerCase().trim() + ":" + value.replace(/\r\n(?=[ \t])/g, "").replace(/[ \t]+/g, " ").trim();

function relaxedBody(body: string): string {
  const lines = body.split("\r\n").map((l) => l.replace(/[ \t]+/g, " ").replace(/ $/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length ? lines.join("\r\n") + "\r\n" : "";
}

function dkimSign(headers: Header[], body: string, { domain, selector, privateKey }: DkimKey): Header {
  const bh = createHash("sha256").update(relaxedBody(body)).digest("base64");
  const signed = headers.filter(([k]) => SIGNED.includes(k.toLowerCase()));
  const value =
    `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=${selector};\r\n\t` +
    `t=${Math.floor(Date.now() / 1000)}; h=${signed.map(([k]) => k.toLowerCase()).join(":")};\r\n\t` +
    `bh=${bh};\r\n\tb=`;
  const data = signed.map(([k, v]) => relaxedHeader(k, v) + "\r\n").join("") + relaxedHeader("DKIM-Signature", value);
  return ["DKIM-Signature", value + sign("sha256", Buffer.from(data), privateKey).toString("base64")];
}

/** Verifies our own signatures (used by tests). */
export function dkimVerify(raw: string, publicKeyB64: string): boolean {
  const [head, ...rest] = raw.split("\r\n\r\n");
  const body = rest.join("\r\n\r\n");
  const fields: string[] = [];
  for (const line of head.split("\r\n")) {
    if (/^[ \t]/.test(line) && fields.length) fields[fields.length - 1] += "\r\n" + line;
    else fields.push(line);
  }
  const parsed = fields.map((f): Header => { const i = f.indexOf(":"); return [f.slice(0, i), f.slice(i + 1).replace(/^ /, "")]; });
  const sigField = parsed.find(([k]) => k.toLowerCase() === "dkim-signature");
  if (!sigField) return false;
  const tags: Record<string, string> = Object.fromEntries(
    sigField[1].replace(/\s+/g, "").split(";").filter(Boolean).map((t) => { const i = t.indexOf("="); return [t.slice(0, i), t.slice(i + 1)]; }),
  );
  if (createHash("sha256").update(relaxedBody(body)).digest("base64") !== tags.bh) return false;
  const data = tags.h.split(":").map((n) => {
    const f = parsed.find(([k]) => k.toLowerCase() === n);
    return f ? relaxedHeader(f[0], f[1]) + "\r\n" : "";
  }).join("") + relaxedHeader(sigField[0], sigField[1].replace(/b=[^;]*$/, "b="));
  const key = createPublicKey({ key: Buffer.from(publicKeyB64, "base64"), format: "der", type: "spki" });
  return verify("sha256", Buffer.from(data), key, Buffer.from(tags.b, "base64"));
}
