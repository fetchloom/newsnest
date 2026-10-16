import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { validation } from "../errors.ts";
import { now } from "../ids.ts";
import { parseAddress } from "../validate.ts";
import { flag, isUrl, oneOf, parseJson, text } from "./util.ts";

export interface Publication {
  name: string; description: string; slug: string;
  from_name: string; from_email: string; reply_to: string;
  site_url: string; site_domain: string; address: string;
  brand_color: string; font: "sans" | "serif" | "mono"; logo_url: string; footer: string;
  double_opt_in: boolean; welcome_enabled: boolean; welcome_subject: string; welcome_body: string;
  track_opens: boolean; track_clicks: boolean; utm_links: boolean; referral_enabled: boolean;
  nav: { label: string; url: string }[];
  seo_title: string; seo_description: string; og_image_url: string;
}

const BOOLS = ["double_opt_in", "welcome_enabled", "track_opens", "track_clicks", "utm_links", "referral_enabled"] as const;

export function getPublication(db: DB): Publication {
  const r = db.prepare("SELECT * FROM publication WHERE id = 1").get() as Record<string, string | number>;
  const out: Record<string, unknown> = { ...r };
  delete out.id; delete out.updated_at;
  for (const k of BOOLS) out[k] = r[k] === 1;
  out.nav = parseJson(r.nav as string, []);
  return out as unknown as Publication;
}

export function updatePublication(db: DB, body: Record<string, unknown>): Publication {
  const cur = getPublication(db);
  const next: Record<string, unknown> = { ...cur };

  for (const k of ["name", "slug", "from_name", "welcome_subject", "seo_title"] as const) {
    const v = text(body[k], k, 200); if (v !== undefined) next[k] = v;
  }
  for (const k of ["description", "seo_description"] as const) { const v = text(body[k], k, 600); if (v !== undefined) next[k] = v; }
  for (const k of ["footer", "address"] as const) { const v = text(body[k], k, 1000); if (v !== undefined) next[k] = v; }
  { const v = text(body.welcome_body, "welcome_body", 20000); if (v !== undefined) next.welcome_body = v; }

  if (body.from_email !== undefined) {
    const v = text(body.from_email, "from_email", 254)!;
    next.from_email = v ? parseAddress(v, "from_email").email : "";
  }
  if (body.reply_to !== undefined) {
    const v = text(body.reply_to, "reply_to", 254)!;
    next.reply_to = v ? parseAddress(v, "reply_to").email : "";
  }
  for (const k of ["site_url", "logo_url", "og_image_url"] as const) {
    const v = text(body[k], k, 500);
    if (v === undefined) continue;
    if (v && !isUrl(v) && !(k !== "site_url" && v.startsWith("/uploads/"))) throw validation(`"${k}" must be an http(s) URL`);
    next[k] = k === "site_url" ? v.replace(/\/+$/, "") : v;
  }
  if (body.site_domain !== undefined) {
    const v = text(body.site_domain, "site_domain", 253)!.toLowerCase();
    if (v && !/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(v)) throw validation(`"site_domain" must be a hostname such as news.example.com`);
    next.site_domain = v;
  }
  if (body.brand_color !== undefined) {
    const v = text(body.brand_color, "brand_color", 7)!;
    if (!/^#[0-9a-fA-F]{6}$/.test(v)) throw validation(`"brand_color" must look like #1663fe`);
    next.brand_color = v.toLowerCase();
  }
  { const v = oneOf(body.font, "font", ["sans", "serif", "mono"] as const); if (v) next.font = v; }
  for (const k of BOOLS) { const v = flag(body[k], k); if (v !== undefined) next[k] = v; }

  if (body.nav !== undefined) {
    if (!Array.isArray(body.nav) || body.nav.length > 10) throw validation(`"nav" must be a list of up to 10 {label, url} items`);
    next.nav = body.nav.map((n) => {
      if (!n || typeof n.label !== "string" || typeof n.url !== "string" || !n.label.trim() || n.label.length > 40 || n.url.length > 500) throw validation(`Each nav item needs a short "label" and a "url"`);
      if (!/^(https?:\/\/|\/)/.test(n.url)) throw validation(`Nav URLs must start with http(s):// or /`);
      return { label: n.label.trim(), url: n.url.trim() };
    });
  }
  if (!/^[a-z0-9-]{1,60}$/.test(String(next.slug))) throw validation(`"slug" may only contain lowercase letters, numbers and dashes`);

  const n = next as unknown as Publication;
  db.prepare(`UPDATE publication SET name=?, description=?, slug=?, from_name=?, from_email=?, reply_to=?, site_url=?, site_domain=?, address=?,
    brand_color=?, font=?, logo_url=?, footer=?, double_opt_in=?, welcome_enabled=?, welcome_subject=?, welcome_body=?, track_opens=?, track_clicks=?,
    utm_links=?, referral_enabled=?, nav=?, seo_title=?, seo_description=?, og_image_url=?, updated_at=? WHERE id = 1`).run(
    n.name, n.description, n.slug, n.from_name, n.from_email, n.reply_to, n.site_url, n.site_domain, n.address,
    n.brand_color, n.font, n.logo_url, n.footer, +n.double_opt_in, +n.welcome_enabled, n.welcome_subject, n.welcome_body, +n.track_opens, +n.track_clicks,
    +n.utm_links, +n.referral_enabled, JSON.stringify(n.nav), n.seo_title, n.seo_description, n.og_image_url, now());
  return getPublication(db);
}

/** Base URL for links inside emails and the public site. */
export function baseUrl(db: DB, cfg: Config, pub: Publication = getPublication(db)): string {
  return (pub.site_url || cfg.publicUrl || `http://127.0.0.1:${cfg.port}`).replace(/\/+$/, "");
}

export const isLocalUrl = (url: string): boolean => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/i.test(url);
