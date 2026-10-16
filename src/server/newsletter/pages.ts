import type { DB } from "../db.ts";
import { notFound, validation } from "../errors.ts";
import { iso, newId, now } from "../ids.ts";
import { cleanBlocks } from "./blocks.ts";
import { RESERVED_SLUGS } from "./posts.ts";
import { flag, parseJson, slugify, text } from "./util.ts";

interface PageRow { id: string; slug: string; title: string; blocks: string; published: number; in_nav: number; created_at: number; updated_at: number }

const view = (r: PageRow) => ({ id: r.id, object: "page", slug: r.slug, title: r.title, blocks: parseJson(r.blocks, []), published: !!r.published, in_nav: !!r.in_nav, created_at: iso(r.created_at), updated_at: iso(r.updated_at) });

const row = (db: DB, id: string): PageRow => {
  const r = db.prepare("SELECT * FROM pages WHERE id = ? OR slug = ?").get(id, id) as unknown as PageRow | undefined;
  if (!r) throw notFound("Page");
  return r;
};

function freeSlug(db: DB, wanted: string, exceptId: string | null): string {
  const base = slugify(wanted);
  let slug = base;
  const taken = (s: string): boolean => RESERVED_SLUGS.has(s) || !!db.prepare("SELECT 1 FROM posts WHERE slug = ?").get(s) || !!db.prepare("SELECT 1 FROM pages WHERE slug = ? AND id != ?").get(s, exceptId ?? "");
  for (let n = 2; taken(slug); n++) slug = `${base}-${n}`;
  return slug;
}

export const listPages = (db: DB) => ({ object: "list", data: (db.prepare("SELECT * FROM pages ORDER BY created_at").all() as unknown as PageRow[]).map(view) });
export const getPage = (db: DB, id: string) => view(row(db, id));

export function createPage(db: DB, body: Record<string, unknown>) {
  const title = text(body.title, "title", 200);
  if (!title) throw validation(`"title" is required`);
  const id = newId("pg");
  const at = now();
  db.prepare("INSERT INTO pages (id, slug, title, blocks, published, in_nav, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, freeSlug(db, String(body.slug ?? title), null), title, JSON.stringify(cleanBlocks(body.blocks)), +(body.published !== false), +(body.in_nav === true), at, at);
  return view(row(db, id));
}

export function updatePage(db: DB, id: string, body: Record<string, unknown>) {
  const cur = row(db, id);
  const title = body.title !== undefined ? text(body.title, "title", 200) : cur.title;
  if (!title) throw validation(`"title" can't be empty`);
  db.prepare("UPDATE pages SET slug = ?, title = ?, blocks = ?, published = ?, in_nav = ?, updated_at = ? WHERE id = ?").run(
    body.slug !== undefined ? freeSlug(db, String(body.slug), cur.id) : cur.slug, title,
    body.blocks !== undefined ? JSON.stringify(cleanBlocks(body.blocks)) : cur.blocks,
    body.published !== undefined ? +(flag(body.published, "published") as boolean) : cur.published,
    body.in_nav !== undefined ? +(flag(body.in_nav, "in_nav") as boolean) : cur.in_nav, now(), cur.id);
  return view(row(db, cur.id));
}

export function deletePage(db: DB, id: string) { const r = row(db, id); db.prepare("DELETE FROM pages WHERE id = ?").run(r.id); return { id: r.id, object: "page", deleted: true }; }
