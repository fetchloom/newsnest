import { randomBytes } from "node:crypto";
import { validation } from "../errors.ts";

export const token = (bytes = 18): string => randomBytes(bytes).toString("base64url");

export function parseJson<T>(raw: string | null | undefined, fallback: T): T {
  try { return raw ? (JSON.parse(raw) as T) : fallback; } catch { return fallback; }
}

/** Optional string with a length cap. `undefined` means "not provided". */
export function text(v: unknown, field: string, max = 500): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string") throw validation(`"${field}" must be a string`);
  if (v.length > max) throw validation(`"${field}" is too long (max ${max} characters)`);
  return v.trim();
}

export function flag(v: unknown, field: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") throw validation(`"${field}" must be true or false`);
  return v;
}

export function oneOf<T extends string>(v: unknown, field: string, allowed: readonly T[]): T | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw validation(`"${field}" must be one of: ${allowed.join(", ")}`);
  return v as T;
}

export const slugify = (s: string): string =>
  s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "untitled";

export const isUrl = (s: string): boolean => {
  try { const u = new URL(s); return u.protocol === "http:" || u.protocol === "https:"; } catch { return false; }
};

export const csvCell = (v: unknown): string => {
  const s = v == null ? "" : String(v);
  // Cells starting with = + - @ are executed as formulas by spreadsheets; prefix them.
  const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** Small RFC 4180 CSV parser (quoted fields, escaped quotes, CRLF). */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const src = input.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(cell); cell = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(cell); cell = "";
      if (row.some((v) => v.trim() !== "")) rows.push(row);
      row = [];
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v.trim() !== "")) rows.push(row);
  return rows;
}
