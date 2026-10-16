import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { validation } from "../errors.ts";
import { iso, newId, now } from "../ids.ts";

const MAX_BYTES = 4 * 1024 * 1024;
const TYPES: Record<string, { ext: string; magic: (b: Buffer) => boolean }> = {
  "image/png": { ext: "png", magic: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])) },
  "image/jpeg": { ext: "jpg", magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/gif": { ext: "gif", magic: (b) => b.subarray(0, 4).toString("latin1") === "GIF8" },
  "image/webp": { ext: "webp", magic: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
};
const MIME_BY_EXT = Object.fromEntries(Object.entries(TYPES).map(([m, t]) => [t.ext, m]));

/** Stores an image sent as base64. The file's real type is checked from its bytes, never from the name. SVG is refused (it can carry scripts). */
export function saveUpload(db: DB, cfg: Config, body: Record<string, unknown>) {
  const data = typeof body.data === "string" ? body.data.replace(/^data:[^,]+,/, "") : "";
  if (!data) throw validation(`"data" must be the image as base64`);
  const buf = Buffer.from(data, "base64");
  if (!buf.length || buf.length > MAX_BYTES) throw validation(`Images must be under ${MAX_BYTES / 1024 / 1024} MB`);
  const mime = Object.keys(TYPES).find((m) => TYPES[m].magic(buf));
  if (!mime) throw validation("Only PNG, JPEG, GIF and WebP images are accepted");

  const id = newId("img").replace(/[^A-Za-z0-9_-]/g, "");
  const name = `${id}.${TYPES[mime].ext}`;
  mkdirSync(join(cfg.dataDir, "uploads"), { recursive: true });
  writeFileSync(join(cfg.dataDir, "uploads", name), buf);
  const filename = String(body.filename ?? name).replace(/[^\w. -]/g, "_").slice(0, 120);
  db.prepare("INSERT INTO uploads (id, filename, mime, size, created_at) VALUES (?, ?, ?, ?, ?)").run(id, filename, mime, buf.length, now());
  return { id, object: "upload", url: `/uploads/${name}`, filename, mime, size: buf.length };
}

export function readUpload(cfg: Config, name: string): { body: Buffer; mime: string } | null {
  const m = /^([A-Za-z0-9_-]+)\.(png|jpg|gif|webp)$/.exec(name);
  if (!m) return null;
  try { return { body: readFileSync(join(cfg.dataDir, "uploads", name)), mime: MIME_BY_EXT[m[2]] }; } catch { return null; }
}

export function listUploads(db: DB) {
  const rows = db.prepare("SELECT * FROM uploads ORDER BY created_at DESC LIMIT 100").all() as { id: string; filename: string; mime: string; size: number; created_at: number }[];
  return { object: "list", data: rows.map((r) => ({ id: r.id, object: "upload", url: `/uploads/${r.id}.${TYPES[r.mime]?.ext ?? "png"}`, filename: r.filename, mime: r.mime, size: r.size, created_at: iso(r.created_at) })) };
}
