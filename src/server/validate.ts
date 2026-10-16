import type { Address } from "./mime.ts";
import { validation } from "./errors.ts";

const EMAIL = /^[^\s@<>()[\]\\,;:"]+@[^\s@<>()[\]\\,;:"]+\.[^\s@<>()[\]\\,;:"]{2,}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/;

// Headers the API sets itself. Letting callers override them would allow spoofing.
const RESERVED_HEADERS = new Set([
  "from", "to", "cc", "bcc", "reply-to", "subject", "date", "message-id", "mime-version",
  "content-type", "content-transfer-encoding", "dkim-signature", "return-path", "received",
]);

export const isEmail = (s: string): boolean => s.length <= 254 && EMAIL.test(s);

export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** Parses `a@b.com` or `Name <a@b.com>`. */
export function parseAddress(raw: unknown, field: string): Address {
  if (typeof raw !== "string" || !raw.trim()) throw validation(`"${field}" must be an email address`);
  if (/[\r\n]/.test(raw)) throw validation(`"${field}" must not contain line breaks`);
  const m = /^\s*(?:(.*?)\s*<([^<>]+)>|([^<>\s]+))\s*$/.exec(raw);
  const email = m ? (m[2] ?? m[3]) : "";
  if (!email || !EMAIL.test(email.trim()) || email.length > 254) throw validation(`"${field}" has an invalid email address: ${raw.slice(0, 80)}`);
  const name = m?.[1]?.replace(/^"(.*)"$/, "$1").trim();
  return { name: name || null, email: email.trim() };
}

export function parseAddressList(raw: unknown, field: string, { required = false } = {}): Address[] {
  if (raw == null) {
    if (required) throw validation(`"${field}" is required`);
    return [];
  }
  const items = Array.isArray(raw) ? raw : [raw];
  if (required && items.length === 0) throw validation(`"${field}" is required`);
  return items.map((item) => parseAddress(item, field));
}

export function parseHeaders(raw: unknown): Record<string, string> {
  if (raw == null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) throw validation(`"headers" must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!HEADER_NAME.test(name)) throw validation(`Invalid header name "${name.slice(0, 40)}"`);
    if (RESERVED_HEADERS.has(name.toLowerCase())) throw validation(`Header "${name}" is set by Freepost and cannot be overridden`);
    if (typeof value !== "string" || value.length > 998) throw validation(`Header "${name}" must be a string under 998 characters`);
    out[name] = value;
  }
  return out;
}

export interface Tag { name: string; value: string }

export function parseTags(raw: unknown): Tag[] {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw validation(`"tags" must be an array of up to 20 {name, value} objects`);
  return raw.map((t) => {
    const ok = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9_-]{1,256}$/.test(s);
    if (!t || !ok(t.name) || !ok(t.value)) throw validation(`Tag names and values may only contain letters, numbers, "_" and "-"`);
    return { name: t.name, value: t.value };
  });
}

const MAX_SCHEDULE_MS = 30 * 24 * 3600 * 1000;

export function parseScheduledAt(raw: unknown, at: number): number | null {
  if (raw == null) return null;
  const ms = typeof raw === "string" ? Date.parse(raw) : NaN;
  if (Number.isNaN(ms)) throw validation(`"scheduled_at" must be an ISO 8601 date, e.g. 2026-11-01T09:00:00Z`);
  if (ms <= at) return null; // in the past: send now
  if (ms - at > MAX_SCHEDULE_MS) throw validation(`"scheduled_at" can be at most 30 days ahead`);
  return ms;
}

export function str(v: unknown, field: string, { max = 1_000_000, required = false } = {}): string | null {
  if (v == null || v === "") {
    if (required) throw validation(`"${field}" is required`);
    return null;
  }
  if (typeof v !== "string") throw validation(`"${field}" must be a string`);
  if (v.length > max) throw validation(`"${field}" is too long`);
  return v;
}
