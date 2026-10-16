import { generateKeyPairSync } from "node:crypto";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { ApiError, notFound, validation } from "./errors.ts";
import { iso, newId, now } from "./ids.ts";

export interface DomainRow {
  id: string; name: string; status: "pending" | "verified" | "failed"; selector: string;
  dkim_private: string; dkim_public: string; checks: string;
  created_at: number; verified_at: number | null; checked_at: number | null;
}

type CheckState = "pending" | "verified" | "failed";
const DOMAIN = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function createDomain(db: DB, nameRaw: unknown) {
  const name = typeof nameRaw === "string" ? nameRaw.trim().toLowerCase() : "";
  if (!DOMAIN.test(name)) throw validation(`"name" must be a domain such as example.com`);
  if (db.prepare("SELECT 1 FROM domains WHERE name = ?").get(name)) throw new ApiError(409, "domain_exists", `${name} is already added`);

  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const id = newId("dom");
  db.prepare("INSERT INTO domains (id, name, selector, dkim_private, dkim_public, created_at) VALUES (?, ?, 'newsnest', ?, ?, ?)").run(
    id,
    name,
    privateKey.export({ type: "pkcs8", format: "pem" }) as string,
    (publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"),
    now(),
  );
  return domainView(getDomainRow(db, id), null);
}

export function getDomainRow(db: DB, id: string): DomainRow {
  const row = db.prepare("SELECT * FROM domains WHERE id = ? OR name = ?").get(id, id.toLowerCase()) as unknown as DomainRow | undefined;
  if (!row) throw notFound("Domain");
  return row;
}

export const getDomain = (db: DB, id: string, cfg: Config) => domainView(getDomainRow(db, id), cfg);

export const listDomains = (db: DB, cfg: Config) =>
  (db.prepare("SELECT * FROM domains ORDER BY created_at DESC").all() as unknown as DomainRow[]).map((r) => domainView(r, cfg));

export function deleteDomain(db: DB, id: string) {
  const row = getDomainRow(db, id);
  db.prepare("DELETE FROM domains WHERE id = ?").run(row.id);
  return { id: row.id, object: "domain", deleted: true };
}

/** The DNS records the owner must publish, with the result of the last check. */
export function dnsRecords(row: DomainRow, cfg: Config | null) {
  const checks = JSON.parse(row.checks) as Record<string, CheckState>;
  const spf = cfg?.serverIp ? `v=spf1 ip4:${cfg.serverIp} ~all` : "v=spf1 ip4:YOUR_SERVER_IP ~all";
  return [
    { record: "DKIM", type: "TXT", name: `${row.selector}._domainkey`, value: `v=DKIM1; k=rsa; p=${row.dkim_public}`, status: checks.DKIM ?? "pending", required: true },
    { record: "SPF", type: "TXT", name: "@", value: spf, status: checks.SPF ?? "pending", required: false },
    { record: "DMARC", type: "TXT", name: "_dmarc", value: `v=DMARC1; p=none; rua=mailto:dmarc@${row.name}`, status: checks.DMARC ?? "pending", required: false },
  ];
}

function domainView(row: DomainRow, cfg: Config | null) {
  return {
    id: row.id,
    object: "domain",
    name: row.name,
    status: row.status,
    created_at: iso(row.created_at),
    verified_at: iso(row.verified_at),
    checked_at: iso(row.checked_at),
    records: dnsRecords(row, cfg),
  };
}

async function txt(cfg: Config, name: string): Promise<string[]> {
  try {
    return (await cfg.resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENODATA" || code === "ENOTFOUND") return [];
    throw e;
  }
}

/** Looks the records up in DNS. DKIM must match to verify the domain; SPF and DMARC are reported. */
export async function verifyDomain(db: DB, id: string, cfg: Config) {
  const row = getDomainRow(db, id);
  const state: Record<string, CheckState> = {};

  const dkim = await txt(cfg, `${row.selector}._domainkey.${row.name}`);
  state.DKIM = dkim.some((v) => v.replace(/\s+/g, "").includes(`p=${row.dkim_public}`)) ? "verified" : "failed";
  state.SPF = (await txt(cfg, row.name)).some((v) => v.toLowerCase().startsWith("v=spf1")) ? "verified" : "failed";
  state.DMARC = (await txt(cfg, `_dmarc.${row.name}`)).some((v) => v.toUpperCase().startsWith("V=DMARC1")) ? "verified" : "failed";

  const status = state.DKIM === "verified" ? "verified" : "failed";
  const at = now();
  db.prepare("UPDATE domains SET status = ?, checks = ?, checked_at = ?, verified_at = ? WHERE id = ?").run(
    status, JSON.stringify(state), at, status === "verified" ? (row.verified_at ?? at) : null, row.id,
  );
  return domainView(getDomainRow(db, row.id), cfg);
}
