import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { notFound } from "../errors.ts";
import { now } from "../ids.ts";
import { esc } from "../markdown.ts";
import { cleanBlocks } from "./blocks.ts";
import type { Block } from "./blocks.ts";
import { dynamicSets, postUrl } from "./delivery.ts";
import type { PostRow } from "./delivery.ts";
import { baseUrl, getPublication } from "./publication.ts";
import type { Publication } from "./publication.ts";
import { buildVars, contrastText, fontStack, merge, renderBlocks } from "./render.ts";
import type { RenderCtx } from "./render.ts";
import type { SubscriberRow } from "./subscribers.ts";
import { parseJson } from "./util.ts";

const READER_COOKIE = "fp_reader";
const READER_MS = 30 * 24 * 3600 * 1000;
const PAGE_SIZE = 12;

const sha = (v: string): string => createHash("sha256").update(v).digest("hex");

export function createReaderSession(db: DB, subscriberId: string): string {
  const tok = randomBytes(32).toString("base64url");
  db.prepare("DELETE FROM reader_sessions WHERE expires_at < ?").run(now());
  db.prepare("INSERT INTO reader_sessions (id, subscriber_id, expires_at) VALUES (?, ?, ?)").run(sha(tok), subscriberId, now() + READER_MS);
  return tok;
}

export const readerCookie = (tok: string, secure: boolean, clear = false): string =>
  `${READER_COOKIE}=${clear ? "" : tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${clear ? 0 : READER_MS / 1000}${secure ? "; Secure" : ""}`;

export function readerFrom(db: DB, cookieHeader: string | undefined): SubscriberRow | null {
  const m = new RegExp(`(?:^|;\\s*)${READER_COOKIE}=([^;]+)`).exec(cookieHeader ?? "");
  if (!m) return null;
  const row = db.prepare("SELECT s.* FROM reader_sessions r JOIN subscribers s ON s.id = r.subscriber_id WHERE r.id = ? AND r.expires_at > ? AND s.status = 'active'").get(sha(m[1]), now()) as unknown as SubscriberRow | undefined;
  return row ?? null;
}

export function clearReaderSession(db: DB, cookieHeader: string | undefined): void {
  const m = new RegExp(`(?:^|;\\s*)${READER_COOKIE}=([^;]+)`).exec(cookieHeader ?? "");
  if (m) db.prepare("DELETE FROM reader_sessions WHERE id = ?").run(sha(m[1]));
}

// ---- layout -------------------------------------------------------------------
interface Shell { title: string; description?: string; body: string; canonical?: string; image?: string; type?: "website" | "article"; jsonLd?: unknown; noindex?: boolean; embed?: boolean; extraHead?: string }

export function shell(db: DB, cfg: Config, pub: Publication, prefix: string, o: Shell): string {
  const base = baseUrl(db, cfg, pub);
  const brand = pub.brand_color;
  const pages = db.prepare("SELECT slug, title FROM pages WHERE published = 1 AND in_nav = 1 ORDER BY created_at").all() as { slug: string; title: string }[];
  const nav = [...pub.nav, ...pages.map((p) => ({ label: p.title, url: `${prefix}/${p.slug}` }))];
  const desc = o.description || pub.seo_description || pub.description;
  const img = o.image || pub.og_image_url || pub.logo_url;
  const abs = (u: string): string => (u.startsWith("/") ? base + u : u);
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(o.title)}</title>
${desc ? `<meta name="description" content="${esc(desc)}">` : ""}${o.noindex ? '<meta name="robots" content="noindex">' : ""}
${o.canonical ? `<link rel="canonical" href="${esc(o.canonical)}">` : ""}
<link rel="alternate" type="application/rss+xml" title="${esc(pub.name)}" href="${base}${prefix}/feed.xml">
<meta property="og:site_name" content="${esc(pub.name)}"><meta property="og:title" content="${esc(o.title)}"><meta property="og:type" content="${o.type ?? "website"}">
${desc ? `<meta property="og:description" content="${esc(desc)}">` : ""}${o.canonical ? `<meta property="og:url" content="${esc(o.canonical)}">` : ""}${img ? `<meta property="og:image" content="${esc(abs(img))}">` : ""}
<meta name="twitter:card" content="${img ? "summary_large_image" : "summary"}">
${o.jsonLd ? `<script type="application/ld+json">${JSON.stringify(o.jsonLd).replace(/</g, "\\u003c")}</script>` : ""}${o.extraHead ?? ""}`;

  const css = `:root{--bg:#fdfdfd;--fg:#191919;--muted:#6b6f72;--line:rgba(0,0,0,.1);--surface:#f6f6f6;--brand:${brand};--brand-fg:${contrastText(brand)}}
@media (prefers-color-scheme:dark){:root{--bg:#09090a;--fg:#f0f0f0;--muted:#a1a4a5;--line:rgba(255,255,255,.12);--surface:#131315}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:17px/1.7 ${fontStack(pub.font)};-webkit-font-smoothing:antialiased}
a{color:var(--brand)}img{max-width:100%;height:auto}
.wrap{width:min(720px,100% - 32px);margin-inline:auto}.top{border-bottom:1px solid var(--line)}
.top .wrap{display:flex;align-items:center;gap:20px;height:64px;flex-wrap:wrap}.brand{font-weight:700;font-size:18px;letter-spacing:-.02em;color:var(--fg);text-decoration:none;margin-right:auto}
.brand img{display:block;max-height:34px;width:auto}.top nav{display:flex;gap:18px;font-size:15px}.top nav a{color:var(--muted);text-decoration:none}.top nav a:hover{color:var(--fg)}
.btn{display:inline-block;background:var(--brand);color:var(--brand-fg);padding:9px 16px;border-radius:8px;font:600 15px ${fontStack(pub.font)};text-decoration:none;border:0;cursor:pointer}
main{padding:40px 0 64px}h1.title{font-size:clamp(30px,5vw,44px);line-height:1.12;letter-spacing:-.03em;margin:0 0 14px}
.meta{color:var(--muted);font-size:14px;margin:0 0 28px}.cover{border-radius:12px;margin:0 0 28px;display:block}
.card{display:block;padding:22px 0;border-bottom:1px solid var(--line);text-decoration:none;color:inherit}.card h2{margin:0 0 6px;font-size:22px;letter-spacing:-.02em;line-height:1.25}
.card p{margin:0;color:var(--muted);font-size:15px}.card .meta{margin:0 0 8px}.card:hover h2{color:var(--brand)}
.box{margin:32px 0;padding:22px;border:1px solid var(--line);border-radius:12px;background:var(--surface)}.box h3{margin:0 0 6px;font-size:19px}.box p{margin:0 0 14px;color:var(--muted);font-size:15px}
.form{display:flex;gap:8px;flex-wrap:wrap}.form input[type=email],.form input[type=text]{flex:1;min-width:200px;padding:11px 14px;border:1px solid var(--line);border-radius:8px;font:16px ${fontStack(pub.font)};background:var(--bg);color:var(--fg)}
.hp{position:absolute;left:-9999px}.pager{display:flex;justify-content:space-between;margin-top:28px;font-size:15px}
.foot{border-top:1px solid var(--line);padding:28px 0;color:var(--muted);font-size:14px}.badge{display:inline-block;font-size:12px;border:1px solid var(--line);border-radius:999px;padding:1px 9px;color:var(--muted);margin-left:6px}
.share a{margin-right:14px;font-size:14px}.notice{padding:12px 16px;border-radius:8px;background:var(--surface);border:1px solid var(--line);font-size:15px;margin-bottom:20px}`;

  const logo = pub.logo_url ? `<img src="${esc(abs(pub.logo_url))}" alt="${esc(pub.name)}">` : esc(pub.name);
  const chrome = o.embed ? "" : `<header class="top"><div class="wrap"><a class="brand" href="${prefix || "/"}">${logo}</a><nav>${nav.map((n) => `<a href="${esc(n.url)}">${esc(n.label)}</a>`).join("")}</nav><a class="btn" href="${base}/subscribe">Subscribe</a></div></header>`;
  const foot = o.embed ? "" : `<footer class="foot"><div class="wrap">${pub.footer ? `<p>${esc(pub.footer)}</p>` : ""}<p>© ${new Date().getFullYear()} ${esc(pub.name)} · <a href="${prefix}/feed.xml">RSS</a></p></div></footer>`;
  return `<!doctype html><html lang="en"><head>${head}<style>${css}</style></head><body>${chrome}<main><div class="wrap">${o.body}</div></main>${foot}</body></html>`;
}

export const subscribeForm = (base: string, pub: Publication, o: { ref?: string; utm?: Record<string, string>; referrer?: string; text?: string; button?: string; name?: boolean } = {}): string => `<form class="form" method="post" action="${base}/subscribe" novalidate>
${o.name ? '<input type="text" name="first_name" placeholder="First name" aria-label="First name" autocomplete="given-name">' : ""}
<input type="email" name="email" placeholder="you@example.com" aria-label="Email address" autocomplete="email">
<input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">
${o.ref ? `<input type="hidden" name="ref" value="${esc(o.ref)}">` : ""}${Object.entries(o.utm ?? {}).map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join("")}${o.referrer ? `<input type="hidden" name="referrer" value="${esc(o.referrer)}">` : ""}
<button class="btn" type="submit">${esc(o.button ?? "Subscribe")}</button></form>`;

// ---- content helpers ----------------------------------------------------------
const readable = (db: DB, p: PostRow): boolean => !!p.web_enabled && p.published_at != null && p.published_at <= now();
const fmtDate = (ms: number): string => new Date(ms).toLocaleDateString("en", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" });
const stripTags = (h: string): string => h.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

function excerpt(p: PostRow, blocks: Block[]): string {
  if (p.preview_text) return p.preview_text;
  const t = blocks.find((b) => b.type === "text");
  return t ? stripTags(String(t.props.markdown).replace(/[*_`#>\[\]()]/g, "")).slice(0, 180) : "";
}

const readingMinutes = (blocks: Block[]): number => {
  const words = blocks.filter((b) => b.type === "text" || b.type === "heading").map((b) => String(b.props.markdown ?? b.props.text ?? "")).join(" ").split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 220));
};

function webCtx(db: DB, cfg: Config, pub: Publication, reader: SubscriberRow | null, blocks: Block[], extra: Record<string, string> = {}): RenderCtx {
  const base = baseUrl(db, cfg, pub);
  return { db, pub, base, mode: "web", subscriber: reader, dynamic: dynamicSets(db, blocks), vars: buildVars(db, pub, base, reader, extra) };
}

function postPage(db: DB, cfg: Config, pub: Publication, prefix: string, p: PostRow, reader: SubscriberRow | null, opts: { preview?: boolean; blocks?: Block[]; title?: string } = {}): string {
  const base = baseUrl(db, cfg, pub);
  const all = opts.blocks ?? cleanBlocks(parseJson(p.blocks, []));
  const gated = p.access === "subscribers" && !reader && !opts.preview;
  const shown = gated ? all.slice(0, 2) : all;
  const c = webCtx(db, cfg, pub, reader, all, { post_title: p.title });
  const content = merge(renderBlocks(shown, c), c.vars, true);
  const url = `${base}${prefix}/${p.slug}`;
  const title = opts.title ?? p.title;
  const when = p.published_at ?? p.created_at;

  const gate = gated ? `<div class="box"><h3>This post is for subscribers</h3><p>Enter your email and we'll send you a link to read it. Not subscribed yet? <a href="${base}/subscribe">Subscribe for free</a>.</p>
<form class="form" method="post" action="${base}/login" novalidate><input type="email" name="email" placeholder="you@example.com" aria-label="Email address"><input type="hidden" name="redirect" value="${esc(`${prefix}/${p.slug}`)}"><input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><button class="btn" type="submit">Email me a link</button></form></div>` : "";
  const subscribeBox = !gated && !reader ? `<div class="box"><h3>Get ${esc(pub.name)} in your inbox</h3><p>${esc(pub.description || "New posts, straight to your email.")}</p>${subscribeForm(base, pub, { button: "Subscribe" })}</div>` : "";
  const share = `<p class="share"><a href="https://x.com/intent/post?url=${encodeURIComponent(url)}&text=${encodeURIComponent(title)}" rel="noopener">Share on X</a><a href="mailto:?subject=${encodeURIComponent(title)}&body=${encodeURIComponent(url)}">Email</a></p>`;

  const body = `${opts.preview ? '<div class="notice">Preview. This is how the post looks on your website.</div>' : ""}<article>
<p class="meta">${fmtDate(when)}${p.author ? ` · ${esc(p.author)}` : ""} · ${readingMinutes(all)} min read${p.access === "subscribers" ? '<span class="badge">Subscribers</span>' : ""}</p>
<h1 class="title">${esc(title)}</h1>${p.cover_url ? `<img class="cover" src="${esc(p.cover_url.startsWith("/") ? base + p.cover_url : p.cover_url)}" alt="">` : ""}
${content}${gate}</article>${subscribeBox}${gated ? "" : share}`;

  return shell(db, cfg, pub, prefix, {
    title: `${p.seo_title || title} — ${pub.name}`, description: p.seo_description || excerpt(p, all), canonical: url, type: "article", image: p.cover_url || undefined, body, noindex: opts.preview,
    jsonLd: { "@context": "https://schema.org", "@type": "Article", headline: title, datePublished: new Date(when).toISOString(), author: p.author ? { "@type": "Person", name: p.author } : undefined, image: p.cover_url || undefined, mainEntityOfPage: url },
  });
}

/** Dashboard preview of how a post looks on the website, with unsaved editor content if given. */
export function renderPostWeb(db: DB, cfg: Config, id: string, body: Record<string, unknown>) {
  const p = db.prepare("SELECT * FROM posts WHERE id = ? OR slug = ?").get(id, id) as unknown as PostRow | undefined;
  if (!p) throw notFound("Post");
  const pub = getPublication(db);
  const blocks = body.blocks !== undefined ? cleanBlocks(body.blocks) : undefined;
  return { subject: p.title, html: postPage(db, cfg, pub, "/p", p, null, { preview: true, blocks, title: typeof body.title === "string" ? body.title : undefined }), text: "" };
}

function archivePage(db: DB, cfg: Config, pub: Publication, prefix: string, page: number): string {
  const base = baseUrl(db, cfg, pub);
  const total = (db.prepare("SELECT COUNT(*) AS n FROM posts WHERE web_enabled = 1 AND published_at IS NOT NULL AND published_at <= ?").get(now()) as { n: number }).n;
  const rows = db.prepare("SELECT * FROM posts WHERE web_enabled = 1 AND published_at IS NOT NULL AND published_at <= ? ORDER BY published_at DESC LIMIT ? OFFSET ?").all(now(), PAGE_SIZE, (page - 1) * PAGE_SIZE) as unknown as PostRow[];
  const cards = rows.map((p) => `<a class="card" href="${prefix}/${p.slug}"><p class="meta">${fmtDate(p.published_at!)}${p.access === "subscribers" ? '<span class="badge">Subscribers</span>' : ""}</p><h2>${esc(p.title)}</h2><p>${esc(excerpt(p, cleanBlocks(parseJson(p.blocks, []))))}</p></a>`).join("");
  const pager = total > PAGE_SIZE ? `<div class="pager"><span>${page > 1 ? `<a href="${prefix || "/"}?page=${page - 1}">← Newer</a>` : ""}</span><span>${page * PAGE_SIZE < total ? `<a href="${prefix || "/"}?page=${page + 1}">Older →</a>` : ""}</span></div>` : "";
  const hero = page === 1 ? `<div class="box" style="margin-top:0"><h3>${esc(pub.name)}</h3><p>${esc(pub.description || "Subscribe to get new posts by email.")}</p>${subscribeForm(base, pub)}</div>` : "";
  return shell(db, cfg, pub, prefix, { title: pub.seo_title || pub.name, description: pub.seo_description || pub.description, canonical: `${base}${prefix || "/"}`, body: `${hero}${cards || '<p style="color:var(--muted)">No posts yet.</p>'}${pager}` });
}

function customPage(db: DB, cfg: Config, pub: Publication, prefix: string, slug: string, reader: SubscriberRow | null): string | null {
  const pg = db.prepare("SELECT * FROM pages WHERE slug = ? AND published = 1").get(slug) as { title: string; blocks: string } | undefined;
  if (!pg) return null;
  const blocks = cleanBlocks(parseJson(pg.blocks, []));
  const c = webCtx(db, cfg, pub, reader, blocks);
  return shell(db, cfg, pub, prefix, { title: `${pg.title} — ${pub.name}`, canonical: `${baseUrl(db, cfg, pub)}${prefix}/${slug}`, body: `<h1 class="title">${esc(pg.title)}</h1>${merge(renderBlocks(blocks, c), c.vars, true)}` });
}

function feed(db: DB, cfg: Config, pub: Publication, prefix: string): string {
  const base = baseUrl(db, cfg, pub);
  const rows = db.prepare("SELECT * FROM posts WHERE web_enabled = 1 AND published_at IS NOT NULL AND published_at <= ? ORDER BY published_at DESC LIMIT 30").all(now()) as unknown as PostRow[];
  const items = rows.map((p) => {
    const blocks = cleanBlocks(parseJson(p.blocks, []));
    const gated = p.access === "subscribers";
    const c = webCtx(db, cfg, pub, null, blocks);
    const html = gated ? esc(excerpt(p, blocks)) : merge(renderBlocks(blocks, c), c.vars, true);
    return `<item><title>${esc(p.title)}</title><link>${base}${prefix}/${p.slug}</link><guid isPermaLink="true">${base}${prefix}/${p.slug}</guid><pubDate>${new Date(p.published_at!).toUTCString()}</pubDate><description>${esc(excerpt(p, blocks))}</description><content:encoded><![CDATA[${html.replace(/]]>/g, "]]]]><![CDATA[>")}]]></content:encoded></item>`;
  }).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>${esc(pub.name)}</title><link>${base}${prefix || "/"}</link><description>${esc(pub.description || pub.name)}</description>\n${items}\n</channel></rss>`;
}

function sitemap(db: DB, cfg: Config, pub: Publication, prefix: string): string {
  const base = baseUrl(db, cfg, pub);
  const posts = db.prepare("SELECT slug, published_at FROM posts WHERE web_enabled = 1 AND published_at IS NOT NULL AND published_at <= ?").all(now()) as { slug: string; published_at: number }[];
  const pages = db.prepare("SELECT slug FROM pages WHERE published = 1").all() as { slug: string }[];
  const urls = [`<url><loc>${base}${prefix || "/"}</loc></url>`, ...posts.map((p) => `<url><loc>${base}${prefix}/${p.slug}</loc><lastmod>${new Date(p.published_at).toISOString()}</lastmod></url>`), ...pages.map((p) => `<url><loc>${base}${prefix}/${p.slug}</loc></url>`)];
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join("")}</urlset>`;
}

/**
 * Serves the public website. `hostMode` means the request came in on the publication's own domain,
 * so the site lives at / instead of /p/.
 */
export function handleSite(db: DB, cfg: Config, req: IncomingMessage, res: ServerResponse, pathname: string, query: URLSearchParams, hostMode: boolean): boolean {
  const prefix = hostMode ? "" : "/p";
  const rel = hostMode ? pathname : pathname.replace(/^\/p/, "") || "/";
  if (!hostMode && !(pathname === "/p" || pathname.startsWith("/p/"))) return false;
  const pub = getPublication(db);
  const send = (status: number, body: string, type = "text/html; charset=utf-8"): true => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
    res.end(body);
    return true;
  };

  if (rel === "/" || rel === "") return send(200, archivePage(db, cfg, pub, prefix, Math.max(1, Number(query.get("page")) || 1)));
  if (rel === "/feed.xml") return send(200, feed(db, cfg, pub, prefix), "application/rss+xml; charset=utf-8");
  if (rel === "/sitemap.xml") return send(200, sitemap(db, cfg, pub, prefix), "application/xml; charset=utf-8");
  if (rel === "/robots.txt" && hostMode) return send(200, `User-agent: *\nAllow: /\nSitemap: ${baseUrl(db, cfg, pub)}/sitemap.xml\n`, "text/plain; charset=utf-8");

  const slug = /^\/([a-z0-9-]+)\/?$/.exec(rel)?.[1];
  if (slug) {
    const reader = readerFrom(db, req.headers.cookie);
    const post = db.prepare("SELECT * FROM posts WHERE slug = ?").get(slug) as unknown as PostRow | undefined;
    if (post && readable(db, post)) return send(200, postPage(db, cfg, pub, prefix, post, reader));
    const page = customPage(db, cfg, pub, prefix, slug, reader);
    if (page) return send(200, page);
  }
  return send(404, shell(db, cfg, pub, prefix, { title: `Not found — ${pub.name}`, noindex: true, body: `<h1 class="title">Page not found</h1><p><a href="${prefix || "/"}">Back to ${esc(pub.name)}</a></p>` }));
}

export { postUrl };
