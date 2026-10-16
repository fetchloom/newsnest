import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { ApiError, notFound, validation } from "../errors.ts";
import { iso, newId, now } from "../ids.ts";
import { isEmail } from "../validate.ts";
import { BUILTIN_TEMPLATES, cleanBlocks, dynamicBlocks } from "./blocks.ts";
import type { Block } from "./blocks.ts";
import { dynamicSets, postUrl, subjectOf } from "./delivery.ts";
import type { AbConfig, PostRow } from "./delivery.ts";
import { assertCanSend, ctxFor, sendSystemMail } from "./mailer.ts";
import { baseUrl, getPublication } from "./publication.ts";
import { DESIGN_INFO, isDesignId } from "./designs.ts";
import { MAX_CUSTOM_HTML, merge, renderCustomEmail, renderEmailDocument } from "./render.ts";
import { compileRules } from "./segments.ts";
import { findByEmail } from "./subscribers.ts";
import { flag, oneOf, parseJson, slugify, text } from "./util.ts";

function row(db: DB, id: string): PostRow {
  const r = db.prepare("SELECT * FROM posts WHERE id = ? OR slug = ?").get(id, id) as unknown as PostRow | undefined;
  if (!r) throw notFound("Post");
  return r;
}

export function postView(db: DB, cfg: Config, r: PostRow, full = true) {
  const base = baseUrl(db, cfg);
  return {
    id: r.id, object: "post", title: r.title, subject: r.subject, slug: r.slug, preview_text: r.preview_text,
    design: r.design,
    ...(full ? { custom_html: r.custom_html, blocks: parseJson(r.blocks, []), ab: parseJson(r.ab, {}), seo_title: r.seo_title, seo_description: r.seo_description, cover_url: r.cover_url } : {}),
    ab_state: parseJson(r.ab_state, {}),
    status: r.status, email_enabled: !!r.email_enabled, web_enabled: !!r.web_enabled, access: r.access, audience: r.audience,
    from_name: r.from_name, from_email: r.from_email, author: r.author,
    send_at: iso(r.send_at), sent_at: iso(r.sent_at), published_at: iso(r.published_at), recipients: r.recipients,
    url: r.web_enabled && r.published_at ? postUrl(base, r) : null,
    created_at: iso(r.created_at), updated_at: iso(r.updated_at),
  };
}

export const getPost = (db: DB, cfg: Config, id: string) => postView(db, cfg, row(db, id));
export const getPostRow = row;

export function listPosts(db: DB, cfg: Config, q: URLSearchParams) {
  const status = q.get("status");
  const rows = db.prepare(`SELECT * FROM posts ${status ? "WHERE status = ?" : ""} ORDER BY coalesce(sent_at, send_at, created_at) DESC LIMIT 200`).all(...(status ? [status] : [])) as unknown as PostRow[];
  return { object: "list", data: rows.map((r) => postView(db, cfg, r, false)) };
}

function validateAudience(db: DB, audience: string): void {
  if (audience === "all") return;
  const [kind, ...rest] = audience.split(":");
  const v = rest.join(":");
  if (kind === "tag" && v) return;
  if (kind === "segment" && db.prepare("SELECT 1 FROM segments WHERE id = ?").get(v)) return;
  throw validation(`"audience" must be "all", "tag:<name>" or "segment:<id>" for an existing segment`);
}

function cleanAb(db: DB, raw: unknown): AbConfig {
  const off: AbConfig = { enabled: false, variants: [], test_percent: 20, metric: "opens", wait_minutes: 240 };
  if (!raw || typeof raw !== "object" || (raw as AbConfig).enabled !== true) return off;
  const r = raw as Record<string, any>;
  if (!Array.isArray(r.variants) || r.variants.length < 2 || r.variants.length > 4) throw validation("An A/B test needs 2 to 4 variants");
  const variants = r.variants.map((v: any, i: number) => ({
    label: "ABCD"[i],
    subject: text(v?.subject, "variant subject", 200) || undefined,
    blocks: v?.blocks ? cleanBlocks(v.blocks) : undefined,
  }));
  const pct = Math.round(Number(r.test_percent ?? 20));
  const wait = Math.round(Number(r.wait_minutes ?? 240));
  if (!(pct >= 5 && pct <= 50)) throw validation(`"test_percent" must be between 5 and 50`);
  if (!(wait >= 15 && wait <= 4320)) throw validation(`"wait_minutes" must be between 15 minutes and 3 days`);
  for (const v of variants) for (const b of v.blocks ?? []) if (b.type === "dynamic") compileRules(db, b.props.rules);
  return { enabled: true, variants, test_percent: pct, metric: r.metric === "clicks" ? "clicks" : "opens", wait_minutes: wait };
}

export const RESERVED_SLUGS = new Set(["feed-xml", "sitemap-xml", "page", "archive", "login", "subscribe"]);

const LOCKED_WHILE_SENDING = ["title", "subject", "blocks", "audience", "ab", "preview_text", "email_enabled", "design", "custom_html"];
const DESIGN_CHOICES = ["", "plain", "editorial", "modern", "bold", "custom"] as const;

function uniqueSlug(db: DB, wanted: string, exceptId: string | null): string {
  let slug = slugify(wanted);
  const taken = (sl: string): boolean => !!db.prepare("SELECT 1 FROM posts WHERE slug = ? AND id != ?").get(sl, exceptId ?? "") || !!db.prepare("SELECT 1 FROM pages WHERE slug = ?").get(sl) || RESERVED_SLUGS.has(sl);
  for (let n = 2; taken(slug); n++) slug = `${slugify(wanted)}-${n}`;
  return slug;
}

export function createPost(db: DB, cfg: Config, body: Record<string, unknown>) {
  let blocks: Block[] = [];
  if (body.template_id !== undefined) blocks = getTemplate(db, String(body.template_id)).blocks;
  if (body.blocks !== undefined) blocks = cleanBlocks(body.blocks);
  const id = newId("post");
  const title = text(body.title, "title", 300) || "Untitled";
  const at = now();
  db.prepare(`INSERT INTO posts (id, title, slug, blocks, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`).run(id, title, uniqueSlug(db, title, null), JSON.stringify(blocks), at, at);
  return updatePost(db, cfg, id, { ...body, title, blocks, template_id: undefined });
}

export function updatePost(db: DB, cfg: Config, id: string, body: Record<string, unknown>) {
  const cur = row(db, id);
  if (cur.status === "sending") {
    const touched = LOCKED_WHILE_SENDING.filter((k) => body[k] !== undefined);
    if (touched.length) throw new ApiError(409, "post_sending", `This post is being sent. It can't be changed until sending finishes (${touched.join(", ")}).`);
  }
  const n: Record<string, unknown> = {};
  for (const k of ["title", "subject", "preview_text", "author", "seo_title", "seo_description"] as const) {
    const v = text(body[k], k, k === "seo_description" || k === "preview_text" ? 600 : 300);
    if (v !== undefined) n[k] = v;
  }
  if (n.title !== undefined && !n.title) throw validation(`"title" can't be empty`);
  if (body.cover_url !== undefined) {
    const v = text(body.cover_url, "cover_url", 500)!;
    if (v && !/^(https?:\/\/|\/uploads\/)/.test(v)) throw validation(`"cover_url" must be an http(s) URL`);
    n.cover_url = v;
  }
  if (body.slug !== undefined) {
    const v = text(body.slug, "slug", 80)!;
    if (!v) throw validation(`"slug" can't be empty`);
    n.slug = uniqueSlug(db, v, cur.id);
  }
  if (body.blocks !== undefined) {
    const blocks = cleanBlocks(body.blocks);
    for (const b of dynamicBlocks(blocks)) compileRules(db, b.props.rules);
    n.blocks = JSON.stringify(blocks);
  }
  if (body.design !== undefined) n.design = oneOf(body.design, "design", DESIGN_CHOICES);
  if (body.custom_html !== undefined) {
    if (typeof body.custom_html !== "string") throw validation(`"custom_html" must be a string`);
    if (body.custom_html.length > MAX_CUSTOM_HTML) throw validation(`"custom_html" is too long (max ${MAX_CUSTOM_HTML.toLocaleString("en")} characters)`);
    n.custom_html = body.custom_html;
  }
  if (((n.design as string | undefined) ?? cur.design) === "custom") {
    // A hand-written email has no website version: the page around it would not match the site.
    if (body.web_enabled === true) throw validation("A custom HTML post is email-only. Turn off the website version, or pick a design.");
    n.web_enabled = 0;
  }
  if (body.audience !== undefined) { const a = String(body.audience); validateAudience(db, a); n.audience = a; }
  if (body.ab !== undefined) n.ab = JSON.stringify(cleanAb(db, body.ab));
  { const v = oneOf(body.access, "access", ["public", "subscribers"] as const); if (v) n.access = v; }
  for (const k of ["email_enabled", "web_enabled"] as const) { const v = flag(body[k], k); if (v !== undefined) n[k] = +v; }
  for (const k of ["from_name", "from_email"] as const) {
    if (body[k] === undefined) continue;
    const v = text(body[k], k, 254)!;
    if (k === "from_email" && v && !isEmail(v.toLowerCase())) throw validation(`"from_email" must be an email address`);
    n[k] = v || null;
  }
  const cols = Object.keys(n);
  if (cols.length) db.prepare(`UPDATE posts SET ${cols.map((c) => `${c} = ?`).join(", ")}, updated_at = ? WHERE id = ?`).run(...(cols.map((c) => n[c]) as never[]), now(), cur.id);
  return postView(db, cfg, row(db, cur.id));
}

export function deletePost(db: DB, id: string) {
  const r = row(db, id);
  if (r.status === "sending") throw new ApiError(409, "post_sending", "Wait until this post has finished sending.");
  db.prepare("DELETE FROM posts WHERE id = ?").run(r.id);
  return { id: r.id, object: "post", deleted: true };
}

export function duplicatePost(db: DB, cfg: Config, id: string) {
  const r = row(db, id);
  return createPost(db, cfg, { title: `${r.title} (copy)`, design: r.design, custom_html: r.custom_html, blocks: parseJson(r.blocks, []), subject: r.subject, preview_text: r.preview_text, audience: r.audience, access: r.access, author: r.author, email_enabled: !!r.email_enabled, web_enabled: !!r.web_enabled });
}

// ---- sending lifecycle --------------------------------------------------------
export function schedulePost(db: DB, cfg: Config, id: string, body: Record<string, unknown>) {
  const r = row(db, id);
  if (r.status !== "draft") throw new ApiError(409, "not_draft", `Only drafts can be scheduled (this post is ${r.status}).`);
  if (!r.email_enabled) throw new ApiError(409, "email_disabled", "Turn on email delivery for this post, or just publish it to the website.");
  if (r.design === "custom" ? !r.custom_html.trim() : parseJson<Block[]>(r.blocks, []).length === 0) throw new ApiError(409, "empty_post", "Add some content before sending.");
  assertCanSend(db, cfg, getPublication(db), r); // fail now, not at send time
  const at = now();
  let sendAt = at;
  if (body.send_at != null) {
    const ms = Date.parse(String(body.send_at));
    if (Number.isNaN(ms)) throw validation(`"send_at" must be an ISO 8601 date`);
    sendAt = Math.max(ms, at);
  }
  db.prepare("UPDATE posts SET status = 'scheduled', send_at = ?, updated_at = ? WHERE id = ?").run(sendAt, at, r.id);
  return postView(db, cfg, row(db, r.id));
}

export function unschedulePost(db: DB, cfg: Config, id: string) {
  const r = row(db, id);
  if (r.status !== "scheduled") throw new ApiError(409, "not_scheduled", "This post isn't scheduled.");
  db.prepare("UPDATE posts SET status = 'draft', send_at = NULL, updated_at = ? WHERE id = ?").run(now(), r.id);
  return postView(db, cfg, row(db, r.id));
}

export function setPublished(db: DB, cfg: Config, id: string, published: boolean) {
  const r = row(db, id);
  if (!r.web_enabled && published) throw new ApiError(409, "web_disabled", "Turn on web publishing for this post first.");
  db.prepare("UPDATE posts SET published_at = ?, updated_at = ? WHERE id = ?").run(published ? (r.published_at ?? now()) : null, now(), r.id);
  return postView(db, cfg, row(db, r.id));
}

// ---- preview and test ---------------------------------------------------------
export function previewPost(db: DB, cfg: Config, id: string, body: Record<string, unknown>) {
  const r = row(db, id);
  const pub = getPublication(db);
  const blocks = body.blocks !== undefined ? cleanBlocks(body.blocks) : cleanBlocks(parseJson(r.blocks, []));
  const asEmail = typeof body.subscriber === "string" && body.subscriber ? findByEmail(db, body.subscriber) ?? null : null;
  const c = ctxFor(db, cfg, pub, asEmail, { post_title: String(body.title ?? r.title) });
  c.dynamic = dynamicSets(db, blocks);
  c.showAllDynamic = !asEmail;
  const base = baseUrl(db, cfg, pub);
  const subject = String(body.subject ?? "") || (typeof body.title === "string" && !r.subject ? body.title : subjectOf(r));
  const design = typeof body.design === "string" && (DESIGN_CHOICES as readonly string[]).includes(body.design) ? body.design : r.design;
  const previewText = String(body.preview_text ?? r.preview_text);
  const doc = design === "custom"
    ? renderCustomEmail(typeof body.custom_html === "string" ? body.custom_html : r.custom_html, { subject, previewText }, c)
    : renderEmailDocument({ subject, previewText, title: String(body.title ?? r.title), blocks, viewUrl: `${base}/p/${r.slug}`, design }, c);
  return { subject: merge(subject, c.vars), ...doc };
}

export function sendTest(db: DB, cfg: Config, id: string, body: Record<string, unknown>) {
  const to = Array.isArray(body.to) ? body.to.map((e) => String(e).trim().toLowerCase()) : [];
  if (!to.length || to.length > 5 || to.some((e) => !isEmail(e))) throw validation(`"to" must be 1 to 5 email addresses`);
  const pub = getPublication(db);
  const r = row(db, id);
  assertCanSend(db, cfg, pub, r);
  const preview = previewPost(db, cfg, id, {});
  const ids = to.map((email) => sendSystemMail(db, cfg, { to: email, subject: `[Test] ${preview.subject}`, html: preview.html, text: preview.text }));
  return { sent: ids.filter(Boolean).length, to };
}

// ---- templates ----------------------------------------------------------------
interface TemplateRow { id: string; name: string; blocks: string; created_at: number }

export function listTemplates(db: DB) {
  const saved = db.prepare("SELECT * FROM templates ORDER BY created_at DESC").all() as unknown as TemplateRow[];
  return {
    object: "list",
    data: [
      ...BUILTIN_TEMPLATES.map((t) => ({ id: t.id, object: "template", name: t.name, builtin: true, blocks: t.blocks })),
      ...saved.map((t) => ({ id: t.id, object: "template", name: t.name, builtin: false, blocks: parseJson<Block[]>(t.blocks, []) })),
    ],
  };
}

export function getTemplate(db: DB, id: string): { id: string; name: string; blocks: Block[] } {
  const b = BUILTIN_TEMPLATES.find((t) => t.id === id);
  if (b) return b;
  const r = db.prepare("SELECT * FROM templates WHERE id = ?").get(id) as unknown as TemplateRow | undefined;
  if (!r) throw notFound("Template");
  return { id: r.id, name: r.name, blocks: parseJson<Block[]>(r.blocks, []) };
}

export function saveTemplate(db: DB, body: Record<string, unknown>) {
  const name = text(body.name, "name", 100);
  if (!name) throw validation(`"name" is required`);
  const blocks = body.from_post ? cleanBlocks(parseJson(row(db, String(body.from_post)).blocks, [])) : cleanBlocks(body.blocks);
  const id = newId("tpl");
  db.prepare("INSERT INTO templates (id, name, blocks, created_at) VALUES (?, ?, ?, ?)").run(id, name, JSON.stringify(blocks), now());
  return { id, object: "template", name, builtin: false, blocks };
}

export function deleteTemplate(db: DB, id: string) {
  if (id.startsWith("tpl_") && BUILTIN_TEMPLATES.some((t) => t.id === id)) throw new ApiError(409, "builtin_template", "Built-in templates can't be deleted.");
  if (!db.prepare("DELETE FROM templates WHERE id = ?").run(id).changes) throw notFound("Template");
  return { id, object: "template", deleted: true };
}

// ---- designs ------------------------------------------------------------------
export const listDesigns = () => ({ object: "list", data: DESIGN_INFO });

/** A short sample email in one design, in the publication's own colours, for the design picker. */
export function designSample(db: DB, cfg: Config, design: unknown) {
  if (!isDesignId(design)) throw validation(`"design" must be one of: ${DESIGN_INFO.map((d) => d.id).join(", ")}`);
  const pub = getPublication(db);
  const c = ctxFor(db, cfg, pub, null, {});
  const blocks = cleanBlocks([
    { id: "a", type: "text", props: { markdown: "A short note to show how a post looks in this design. **Bold words**, a [link](https://example.com) and a list:" } },
    { id: "b", type: "list", props: { style: "bullet", items: ["Clear headings", "Comfortable reading width", "Buttons that match your colour"] } },
    { id: "c", type: "quote", props: { text: "Good design is mostly good spacing.", cite: "Someone wise" } },
    { id: "d", type: "button", props: { label: "Read the full issue", url: "https://example.com", align: "left" } },
  ]);
  return renderEmailDocument({ subject: "Sample issue", previewText: "", title: "Why small newsletters win", blocks, design }, c);
}
