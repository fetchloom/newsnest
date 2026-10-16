import { randomBytes } from "node:crypto";
import type { DB } from "./db.ts";
import { notFound, validation } from "./errors.ts";
import { iso, newId, now, sha256 } from "./ids.ts";

export type Permission = "full" | "sending";

export interface ApiKeyInfo {
  id: string;
  permission: Permission;
  domain_id: string | null;
  /** True when the caller is the signed-in dashboard rather than an API key. */
  session?: boolean;
}

interface KeyRow {
  id: string; name: string; prefix: string; permission: Permission; domain_id: string | null;
  created_at: number; last_used_at: number | null; revoked_at: number | null;
}

const view = (r: KeyRow) => ({
  id: r.id,
  object: "api_key",
  name: r.name,
  prefix: r.prefix,
  permission: r.permission,
  domain_id: r.domain_id,
  created_at: iso(r.created_at),
  last_used_at: iso(r.last_used_at),
  revoked: r.revoked_at != null,
});

/** The plaintext key is returned once. Only its SHA-256 is stored. */
export function createKey(db: DB, input: { name?: unknown; permission?: unknown; domain_id?: unknown }) {
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 100) throw validation(`"name" is required (max 100 characters)`);
  const permission = (input.permission ?? "full") as Permission;
  if (permission !== "full" && permission !== "sending") throw validation(`"permission" must be "full" or "sending"`);
  const domainId = input.domain_id == null ? null : String(input.domain_id);
  if (domainId) {
    if (permission !== "sending") throw validation(`"domain_id" only applies to sending keys`);
    if (!db.prepare("SELECT 1 FROM domains WHERE id = ?").get(domainId)) throw validation(`Unknown domain_id`);
  }

  const key = "nn_" + randomBytes(32).toString("base64url");
  const id = newId("key");
  db.prepare("INSERT INTO api_keys (id, name, prefix, hash, permission, domain_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, input.name.trim(), key.slice(0, 9), sha256(key), permission, domainId, now());
  const row = db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as unknown as KeyRow;
  return { ...view(row), key };
}

export function authenticate(db: DB, header: string | undefined): ApiKeyInfo | null {
  const m = /^Bearer\s+(nn_[A-Za-z0-9_-]+)$/.exec(header ?? "");
  if (!m) return null;
  const row = db.prepare("SELECT * FROM api_keys WHERE hash = ? AND revoked_at IS NULL").get(sha256(m[1])) as unknown as KeyRow | undefined;
  if (!row) return null;
  const at = now();
  if (!row.last_used_at || at - row.last_used_at > 60_000) db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(at, row.id);
  return { id: row.id, permission: row.permission, domain_id: row.domain_id };
}

export const listKeys = (db: DB) =>
  (db.prepare("SELECT * FROM api_keys WHERE revoked_at IS NULL ORDER BY created_at DESC").all() as unknown as KeyRow[]).map(view);

export function revokeKey(db: DB, id: string) {
  const res = db.prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now(), id);
  if (!res.changes) throw notFound("API key");
  return { id, object: "api_key", deleted: true };
}
