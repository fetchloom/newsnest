import type { DB } from "../db.ts";
import { esc, defaultStyles, render as markdown, toText } from "../markdown.ts";
import type { Styles } from "../markdown.ts";
import type { Block } from "./blocks.ts";
import { composeEmail, contrastText, fontStack, isDesignId, tokens } from "./designs.ts";
import type { DesignId, Tokens } from "./designs.ts";
import type { Publication } from "./publication.ts";
import type { SubscriberRow } from "./subscribers.ts";
import { parseJson } from "./util.ts";

export interface RenderCtx {
  db: DB;
  pub: Publication;
  base: string;
  mode: "email" | "web";
  subscriber: SubscriberRow | null;
  vars: Record<string, string>;
  /** dynamic block id -> subscriber ids that match its rules */
  dynamic: Map<string, Set<string>>;
  /** Editor previews show every dynamic block instead of hiding the ones this reader doesn't match. */
  showAllDynamic?: boolean;
  /** Set while rendering an email so blocks pick up the design's colours and type. */
  design?: Tokens;
}

interface Pal { text: string; muted: string; line: string; surface: string; bg: string }
const EMAIL_PAL: Pal = { text: "#27272a", muted: "#71717a", line: "#e4e4e7", surface: "#f4f4f5", bg: "#ffffff" };
const WEB_PAL: Pal = { text: "var(--fg)", muted: "var(--muted)", line: "var(--line)", surface: "var(--surface)", bg: "var(--bg)" };
const pal = (c: RenderCtx): Pal => (c.mode !== "email" ? WEB_PAL : c.design ? { text: c.design.text, muted: c.design.muted, line: c.design.line, surface: c.design.soft, bg: c.design.card } : EMAIL_PAL);
const bodyFont = (c: RenderCtx): string => c.design?.font ?? fontStack(c.pub.font);
const headFont = (c: RenderCtx): string => c.design?.headFont ?? fontStack(c.pub.font);
const btnRadius = (c: RenderCtx): string => c.design?.button ?? "8px";

export { contrastText, fontStack };

const abs = (u: string, base: string): string => (u.startsWith("/") ? base + u : u);

// ---- merge tags: {{first_name}}, {{first_name | there}} -------------------------
const TAG = /\{\{\s*([a-z0-9_.]+)\s*(?:\|\s*([^}]*?))?\s*\}\}/gi;

/** What a link or image address may be once merge tags are filled in. Subscribers choose some of those values (first_name), so a whole-URL tag can't be allowed to turn into javascript: or data:. */
const SAFE_TARGET = /^(https?:\/\/|mailto:|tel:|\/(?![/\\])|#)/i;

export function merge(input: string, vars: Record<string, string>, escape = false): string {
  return input.replace(TAG, (_, key: string, fallback: string | undefined, at: number) => {
    const k = key.toLowerCase();
    const v = Object.hasOwn(vars, k) ? vars[k] : undefined; // {{constructor}} is an unknown tag, not Object's constructor
    const out = v !== undefined && v !== "" ? v : fallback ?? "";
    if (escape && out && /(?:href|src)="$/i.test(input.slice(Math.max(0, at - 6), at)) && !SAFE_TARGET.test(out)) return "#";
    return escape ? esc(out) : out;
  });
}

export function buildVars(db: DB, pub: Publication, base: string, s: SubscriberRow | null, extra: Record<string, string> = {}): Record<string, string> {
  const fields = s ? parseJson<Record<string, unknown>>(s.fields, {}) : {};
  const vars: Record<string, string> = {
    publication_name: pub.name,
    email: s?.email ?? "",
    first_name: String(fields.first_name ?? ""),
    last_name: String(fields.last_name ?? ""),
    name: [fields.first_name, fields.last_name].filter(Boolean).join(" "),
    unsubscribe_url: s ? `${base}/u/${s.token}` : `${base}/u/preview`,
    referral_link: s ? `${base}/subscribe?ref=${s.referral_code}` : `${base}/subscribe`,
    referral_count: s ? String((db.prepare("SELECT COUNT(*) AS n FROM subscribers WHERE referred_by = ? AND status = 'active'").get(s.id) as { n: number }).n) : "0",
    ...extra,
  };
  for (const [k, v] of Object.entries(fields)) vars[`custom.${k}`] = String(v);
  return vars;
}

/** The merge variables a subject line can use. Cheaper than buildVars, which also counts referrals. */
export function subjectVars(pub: Publication, s: SubscriberRow): Record<string, string> {
  const fields = parseJson<Record<string, unknown>>(s.fields, {});
  const vars: Record<string, string> = {
    publication_name: pub.name, email: s.email, first_name: String(fields.first_name ?? ""), last_name: String(fields.last_name ?? ""),
    name: [fields.first_name, fields.last_name].filter(Boolean).join(" "),
  };
  for (const [k, v] of Object.entries(fields)) vars[`custom.${k}`] = String(v);
  return vars;
}

function stylesFor(c: RenderCtx): Styles {
  const p = pal(c);
  const brand = c.pub.brand_color;
  const font = bodyFont(c);
  const head = (size: number, mt: number) => `margin:${mt}px 0 12px;font:700 ${size}px/1.25 ${headFont(c)};color:${p.text};letter-spacing:-0.01em;`;
  return {
    ...defaultStyles,
    p: `margin:0 0 16px;font:16px/1.65 ${font};color:${p.text};`,
    h1: head(28, 8), h2: head(22, 24), h3: head(18, 20),
    a: `color:${brand};text-decoration:underline;`,
    button: `display:inline-block;background:${brand};color:${contrastText(brand)};text-decoration:none;font-weight:600;padding:12px 22px;border-radius:${btnRadius(c)};margin:4px 0;`,
    code: `font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:0.9em;background:${p.surface};padding:2px 5px;border-radius:4px;`,
    pre: `font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;background:${p.surface};color:${p.text};padding:14px 16px;border-radius:8px;overflow:auto;margin:0 0 16px;white-space:pre-wrap;`,
    hr: `border:0;border-top:1px solid ${p.line};margin:24px 0;`,
    blockquote: `margin:0 0 16px;padding:2px 0 2px 16px;border-left:3px solid ${brand};color:${p.muted};`,
    list: `margin:0 0 16px;padding-left:22px;font:16px/1.65 ${font};color:${p.text};`,
    li: "margin:0 0 6px;",
  };
}

function pollBlock(b: Block, c: RenderCtx): string {
  const poll = c.db.prepare("SELECT * FROM polls WHERE id = ?").get(b.props.pollId) as { id: string; question: string; options: string; closed: number } | undefined;
  if (!poll) return "";
  const p = pal(c);
  const font = bodyFont(c);
  const opts = parseJson<string[]>(poll.options, []);
  const tok = c.subscriber?.token ?? "";
  const rows = opts.map((o, i) =>
    `<a href="${c.base}/poll/${poll.id}/${i}${tok ? `?s=${tok}` : ""}" style="display:block;margin:0 0 8px;padding:12px 16px;border:1px solid ${p.line};border-radius:8px;color:${p.text};text-decoration:none;font:500 15px ${font};">${esc(o)}</a>`).join("");
  return `<div style="margin:8px 0 20px;"><div style="font:700 17px/1.35 ${font};color:${p.text};margin:0 0 12px;">${esc(poll.question)}</div>${poll.closed ? `<a href="${c.base}/poll/${poll.id}" style="color:${c.pub.brand_color};font:15px ${font};">This poll is closed. See the results</a>` : rows}</div>`;
}

function referralBlock(b: Block, c: RenderCtx): string {
  if (!c.pub.referral_enabled) return "";
  const p = pal(c);
  const font = bodyFont(c);
  const link = c.vars.referral_link;
  const count = Number(c.vars.referral_count || 0);
  const next = c.db.prepare("SELECT name, threshold FROM rewards WHERE threshold > ? ORDER BY threshold LIMIT 1").get(count) as { name: string; threshold: number } | undefined;
  const title = b.props.title || `Share ${c.pub.name}`;
  const progress = c.subscriber
    ? `<div style="font:14px/1.5 ${font};color:${p.muted};margin:0 0 10px;">You've referred <b style="color:${p.text}">${count}</b> ${count === 1 ? "person" : "people"}${next ? `. ${next.threshold - count} more to unlock <b style="color:${p.text}">${esc(next.name)}</b>.` : "."}</div>` : "";
  return `<div style="margin:8px 0 20px;padding:18px 20px;border:1px solid ${p.line};border-radius:12px;background:${p.surface};"><div style="font:700 17px/1.35 ${font};color:${p.text};margin:0 0 8px;">${esc(title)}</div>${progress}<div style="font:14px/1.5 ${font};color:${p.muted};margin:0 0 6px;">Your personal link:</div><a href="${esc(link)}" style="font:600 14px ${font};color:${c.pub.brand_color};word-break:break-all;">${esc(link)}</a></div>`;
}

function renderBlock(b: Block, c: RenderCtx): string {
  const p = pal(c);
  const font = bodyFont(c);
  const brand = c.pub.brand_color;
  const pr = b.props;
  switch (b.type) {
    case "heading": {
      const size = [0, 28, 22, 18][pr.level];
      return `<h${pr.level} style="margin:${pr.level === 1 ? 8 : 24}px 0 12px;font:700 ${size}px/1.25 ${headFont(c)};color:${p.text};letter-spacing:-0.01em;text-align:${pr.align};">${esc(pr.text)}</h${pr.level}>`;
    }
    case "text": return markdown(pr.markdown, stylesFor(c));
    case "image": {
      if (!pr.url) return "";
      const img = `<img src="${esc(abs(pr.url, c.base))}" alt="${esc(pr.alt)}"${pr.width ? ` width="${pr.width}"` : ""} style="display:block;max-width:100%;height:auto;border:0;border-radius:8px;${pr.width ? `width:${pr.width}px;` : ""}">`;
      const inner = pr.link ? `<a href="${esc(abs(pr.link, c.base))}">${img}</a>` : img;
      return `<div style="margin:8px 0 16px;">${inner}${pr.caption ? `<div style="font:13px/1.5 ${font};color:${p.muted};margin-top:6px;">${esc(pr.caption)}</div>` : ""}</div>`;
    }
    case "button": {
      if (!pr.label || !pr.url) return "";
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" align="${pr.align}" style="margin:8px ${pr.align === "center" ? "auto" : "0"} 20px;"><tr><td bgcolor="${brand}" style="background:${brand};border-radius:${btnRadius(c)};"><a href="${esc(abs(pr.url, c.base))}" style="display:inline-block;padding:12px 22px;color:${contrastText(brand)};font:600 15px ${font};text-decoration:none;border-radius:${btnRadius(c)};">${esc(pr.label)}</a></td></tr></table>`;
    }
    case "divider": return `<hr style="border:0;border-top:1px solid ${p.line};margin:24px 0;">`;
    case "spacer": return `<div style="height:${pr.height}px;line-height:${pr.height}px;font-size:1px;">&nbsp;</div>`;
    case "quote": return `<blockquote style="margin:0 0 20px;padding:4px 0 4px 18px;border-left:3px solid ${brand};font:italic 18px/1.6 ${font};color:${p.text};">${esc(pr.text)}${pr.cite ? `<div style="font:normal 14px ${font};color:${p.muted};margin-top:6px;">— ${esc(pr.cite)}</div>` : ""}</blockquote>`;
    case "list": {
      const tag = pr.style === "number" ? "ol" : "ul";
      return `<${tag} style="margin:0 0 16px;padding-left:22px;font:16px/1.65 ${font};color:${p.text};">${pr.items.map((i: string) => `<li style="margin:0 0 6px;">${esc(i)}</li>`).join("")}</${tag}>`;
    }
    case "code": return `<pre style="font:13px/1.55 ui-monospace,SFMono-Regular,Menlo,monospace;background:${p.surface};color:${p.text};padding:14px 16px;border-radius:8px;overflow:auto;margin:0 0 16px;white-space:pre-wrap;">${esc(pr.text)}</pre>`;
    // The owner's own HTML, which is trusted. On the website the filter below only drops obvious <script> tags and on* attributes; it is not a sanitiser.
    case "html": return c.mode === "web" ? pr.html.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "") : pr.html;
    case "social": {
      const links = pr.links.map((l: { network: string; url: string }) => `<a href="${esc(l.url)}" style="color:${brand};text-decoration:none;font:600 14px ${font};margin-right:16px;">${esc(l.network[0].toUpperCase() + l.network.slice(1))}</a>`).join("");
      return links ? `<div style="margin:8px 0 16px;">${links}</div>` : "";
    }
    case "poll": return pollBlock(b, c);
    case "survey": {
      const survey = c.db.prepare("SELECT id, closed FROM surveys WHERE id = ?").get(pr.surveyId) as { id: string; closed: number } | undefined;
      if (!survey || survey.closed) return "";
      const href = `${c.base}/s/${survey.id}${c.subscriber ? `?s=${c.subscriber.token}` : ""}`;
      return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 20px;"><tr><td bgcolor="${brand}" style="background:${brand};border-radius:${btnRadius(c)};"><a href="${href}" style="display:inline-block;padding:12px 22px;color:${contrastText(brand)};font:600 15px ${font};text-decoration:none;border-radius:${btnRadius(c)};">${esc(pr.label)}</a></td></tr></table>`;
    }
    case "referral": return referralBlock(b, c);
    case "subscribe": {
      if (c.mode === "email") return `<div style="margin:8px 0 20px;"><a href="${c.base}/subscribe" style="color:${brand};font:600 15px ${font};">${esc(pr.label)} →</a></div>`;
      return `<form method="post" action="${c.base}/subscribe" novalidate style="margin:16px 0;padding:18px 20px;border:1px solid ${p.line};border-radius:12px;background:${p.surface};">${pr.text ? `<div style="font:15px/1.5 ${font};color:${p.text};margin:0 0 12px;">${esc(pr.text)}</div>` : ""}<div style="display:flex;gap:8px;flex-wrap:wrap;"><input type="email" name="email" placeholder="you@example.com" aria-label="Email address" style="flex:1;min-width:200px;padding:11px 14px;border:1px solid ${p.line};border-radius:8px;font:15px ${font};background:${p.bg};color:${p.text};"><input type="text" name="website" tabindex="-1" autocomplete="off" style="position:absolute;left:-9999px;" aria-hidden="true"><button type="submit" style="padding:11px 20px;border:0;border-radius:8px;background:${brand};color:${contrastText(brand)};font:600 15px ${font};cursor:pointer;">${esc(pr.label)}</button></div></form>`;
    }
    case "dynamic": {
      const show = c.showAllDynamic || (c.subscriber && c.dynamic.get(b.id)?.has(c.subscriber.id));
      if (!show) return "";
      const inner = renderBlocks(pr.blocks, c);
      return c.showAllDynamic ? `<div style="border:1px dashed ${p.line};border-radius:8px;padding:4px 14px;margin:8px 0;"><div style="font:600 11px ${font};color:${p.muted};text-transform:uppercase;letter-spacing:.06em;margin:8px 0;">Only for matching subscribers</div>${inner}</div>` : inner;
    }
  }
  return "";
}

export const renderBlocks = (blocks: Block[], c: RenderCtx): string => blocks.map((b) => renderBlock(b, c)).join("\n");

/** Plain-text alternative of a block list. */
export function blocksToText(blocks: Block[], c: RenderCtx): string {
  const out: string[] = [];
  for (const b of blocks) {
    const pr = b.props;
    switch (b.type) {
      case "heading": out.push(String(pr.text).toUpperCase()); break;
      case "text": out.push(toText(pr.markdown)); break;
      case "image": if (pr.alt) out.push(`[${pr.alt}]`); break;
      case "button": if (pr.label && pr.url) out.push(`${pr.label}: ${abs(pr.url, c.base)}`); break;
      case "divider": out.push("————"); break;
      case "quote": out.push(`"${pr.text}"${pr.cite ? ` — ${pr.cite}` : ""}`); break;
      case "list": out.push(pr.items.map((i: string, n: number) => (pr.style === "number" ? `${n + 1}. ${i}` : `• ${i}`)).join("\n")); break;
      case "code": out.push(pr.text); break;
      case "html": out.push(toText(pr.html)); break;
      case "social": out.push(pr.links.map((l: { url: string }) => l.url).join("\n")); break;
      case "poll": { const poll = c.db.prepare("SELECT question, options, id FROM polls WHERE id = ?").get(pr.pollId) as { question: string; options: string; id: string } | undefined; if (poll) out.push(`${poll.question}\n${parseJson<string[]>(poll.options, []).map((o, i) => `${o}: ${c.base}/poll/${poll.id}/${i}${c.subscriber ? `?s=${c.subscriber.token}` : ""}`).join("\n")}`); break; }
      case "survey": out.push(`${pr.label}: ${c.base}/s/${pr.surveyId}${c.subscriber ? `?s=${c.subscriber.token}` : ""}`); break;
      case "referral": if (c.pub.referral_enabled) out.push(`${pr.title || `Share ${c.pub.name}`}: ${c.vars.referral_link}`); break;
      case "subscribe": out.push(`${pr.label}: ${c.base}/subscribe`); break;
      case "dynamic": if (c.showAllDynamic || (c.subscriber && c.dynamic.get(b.id)?.has(c.subscriber.id))) out.push(blocksToText(pr.blocks, c)); break;
    }
  }
  return out.filter(Boolean).join("\n\n");
}

export interface EmailParts { subject: string; previewText: string; title?: string; blocks: Block[]; viewUrl?: string | null; pixelUrl?: string | null; design?: string }

/** Which design applies: the post's own, else the publication's, else plain. */
export const resolveDesign = (own: string | undefined, pub: Publication): DesignId => (isDesignId(own) ? own : isDesignId(pub.design) ? pub.design : "plain");

/** The full email document around a block list, laid out by a design, with the footer and unsubscribe link. */
export function renderEmailDocument(parts: EmailParts, ctx: RenderCtx): { html: string; text: string } {
  const pub = ctx.pub;
  const id = resolveDesign(parts.design, pub);
  const t = tokens(id, pub);
  const c: RenderCtx = { ...ctx, design: t };
  const unsub = c.vars.unsubscribe_url;
  const html = composeEmail(id, {
    t, brand: pub.brand_color, name: pub.name, description: pub.description,
    logoUrl: pub.logo_url ? abs(pub.logo_url, c.base) : null,
    subject: merge(parts.subject, c.vars),
    preheader: merge(parts.previewText, c.vars),
    title: parts.title ? merge(parts.title, c.vars) : null,
    body: merge(renderBlocks(parts.blocks, c), c.vars, true),
    footerText: pub.footer ? merge(pub.footer, c.vars) : "",
    address: pub.address,
    unsubscribeUrl: unsub,
    viewUrl: parts.viewUrl ?? null,
    date: new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    pixel: parts.pixelUrl ? `<img src="${esc(parts.pixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;">` : "",
  });

  const text = [
    parts.title ? merge(parts.title, c.vars) : "",
    merge(blocksToText(parts.blocks, c), c.vars),
    "—",
    pub.footer ? merge(pub.footer, c.vars) : "",
    pub.address,
    parts.viewUrl ? `View in browser: ${parts.viewUrl}` : "",
    `Unsubscribe: ${unsub}`,
  ].filter(Boolean).join("\n\n");
  return { html, text };
}

export const MAX_CUSTOM_HTML = 500_000;

/**
 * An email written by hand as a complete HTML file. Merge tags are filled in (values escaped), scripts and event
 * handlers are removed, the preview text is added, and an unsubscribe link and postal address are appended
 * if the file doesn't already link to the subscriber's unsubscribe address.
 */
export function renderCustomEmail(source: string, parts: { subject: string; previewText: string; pixelUrl?: string | null }, c: RenderCtx): { html: string; text: string } {
  const unsub = c.vars.unsubscribe_url;
  let html = merge(source, c.vars, true)
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/href='(https?:\/\/[^']*)'/gi, 'href="$1"'); // click tracking only rewrites double-quoted links
  if (!/<html[\s>]/i.test(html)) html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>${html}</body></html>`;
  if (!/<body[\s>]/i.test(html)) html = html.replace(/<\/head>/i, "</head><body>") + "</body>";
  if (!/<\/body>/i.test(html)) html += "</body>";

  const hidden = `<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(merge(parts.previewText, c.vars))}${"&#847;&zwnj;&nbsp;".repeat(40)}</div>`;
  html = html.replace(/<body[^>]*>/i, (m) => m + hidden);

  if (!html.includes(esc(unsub)) && !html.includes(unsub)) {
    const p = EMAIL_PAL;
    const f = fontStack(c.pub.font);
    const address = c.pub.address ? `<div style="margin:0 0 8px;">${esc(c.pub.address)}</div>` : "";
    html = html.replace(/<\/body>/i, `<div style="max-width:600px;margin:0 auto;padding:20px 24px 32px;font:12.5px/1.6 ${f};color:${p.muted};text-align:center;">${address}<div><a href="${esc(unsub)}" style="color:${p.muted};">Unsubscribe</a></div></div></body>`);
  }
  if (parts.pixelUrl) html = html.replace(/<\/body>/i, `<img src="${esc(parts.pixelUrl)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;"></body>`);
  const text = [toText(merge(source, c.vars)), c.pub.address, `Unsubscribe: ${unsub}`].filter(Boolean).join("\n\n");
  return { html, text };
}

/** Small transactional layout for confirmation, welcome, magic-link and reward emails. */
export function renderSimpleEmail(c: RenderCtx, o: { subject: string; markdown: string; buttonLabel?: string; buttonUrl?: string; footerNote?: string; unsubscribe?: boolean }): { html: string; text: string } {
  const blocks: Block[] = [{ id: "s", type: "text", props: { markdown: o.markdown } }];
  if (o.buttonLabel && o.buttonUrl) blocks.push({ id: "b", type: "button", props: { label: o.buttonLabel, url: o.buttonUrl, align: "left" } });
  const doc = renderEmailDocument({ subject: o.subject, previewText: "", blocks }, c);
  if (o.unsubscribe !== false) return doc;
  // Transactional mail has no unsubscribe link (the recipient asked for this message).
  const html = doc.html.replace(/<div><a href="[^"]*" style="[^"]*">Unsubscribe<\/a><\/div>/, o.footerNote ? `<div>${esc(o.footerNote)}</div>` : "");
  return { html, text: doc.text.replace(/\n\nUnsubscribe: \S+$/, o.footerNote ? `\n\n${o.footerNote}` : "") };
}
