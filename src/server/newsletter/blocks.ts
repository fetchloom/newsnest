import { randomBytes } from "node:crypto";
import { validation } from "../errors.ts";
import { isUrl } from "./util.ts";

export interface Block { id: string; type: string; props: Record<string, any> }

export const BLOCK_TYPES = ["heading", "text", "image", "button", "divider", "spacer", "quote", "list", "code", "html", "social", "poll", "survey", "referral", "subscribe", "dynamic"] as const;

const MAX_BLOCKS = 300;
const NETWORKS = ["website", "x", "instagram", "facebook", "linkedin", "youtube", "tiktok", "github", "mastodon", "bluesky", "threads", "email"];

const s = (v: unknown, field: string, max: number): string => {
  if (v == null) return "";
  if (typeof v !== "string") throw validation(`Block field "${field}" must be text`);
  if (v.length > max) throw validation(`Block field "${field}" is too long (max ${max})`);
  return v;
};

/** Image and link URLs: http(s), site-relative uploads, or a merge tag such as {{referral_link}}. */
function url(v: unknown, field: string, { allowMailto = false, required = false } = {}): string {
  const u = s(v, field, 2000).trim();
  if (!u) { if (required) throw validation(`Block field "${field}" is required`); return ""; }
  if (isUrl(u) || u.startsWith("/uploads/") || /^\{\{\s*[a-z0-9_.]+\s*(\|[^}]*)?\}\}$/i.test(u) || (allowMailto && /^mailto:[^\s]+$/.test(u))) return u;
  throw validation(`Block field "${field}" must be an http(s) URL`);
}

const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T => ((allowed as readonly string[]).includes(String(v)) ? (v as T) : fallback);

function cleanProps(type: string, p: Record<string, any>, depth: number): Record<string, any> {
  switch (type) {
    case "heading": return { text: s(p.text, "text", 500), level: [1, 2, 3].includes(Number(p.level)) ? Number(p.level) : 2, align: pick(p.align, ["left", "center"], "left") };
    case "text": return { markdown: s(p.markdown, "markdown", 100_000) };
    case "image": {
      const width = p.width == null || p.width === "" ? null : Math.min(Math.max(Math.round(Number(p.width)), 40), 620);
      return { url: url(p.url, "url"), alt: s(p.alt, "alt", 300), link: url(p.link, "link"), width: Number.isFinite(width) ? width : null, caption: s(p.caption, "caption", 300) };
    }
    case "button": return { label: s(p.label, "label", 80), url: url(p.url, "url", { allowMailto: true }), align: pick(p.align, ["left", "center"], "left") };
    case "divider": return {};
    case "spacer": return { height: Math.min(Math.max(Math.round(Number(p.height) || 24), 4), 160) };
    case "quote": return { text: s(p.text, "text", 2000), cite: s(p.cite, "cite", 200) };
    case "list": {
      const items = Array.isArray(p.items) ? p.items.slice(0, 50).map((i: unknown) => s(i, "items", 500)).filter(Boolean) : [];
      return { style: pick(p.style, ["bullet", "number"], "bullet"), items };
    }
    case "code": return { text: s(p.text, "text", 20_000) };
    case "html": return { html: s(p.html, "html", 200_000) };
    case "social": {
      const links = Array.isArray(p.links) ? p.links.slice(0, 10) : [];
      return { links: links.map((l: any) => ({ network: pick(l?.network, NETWORKS as unknown as readonly string[], "website"), url: url(l?.url, "url", { allowMailto: true, required: true }) })) };
    }
    case "poll": return { pollId: s(p.pollId, "pollId", 60) };
    case "survey": return { surveyId: s(p.surveyId, "surveyId", 60), label: s(p.label, "label", 80) || "Take the survey" };
    case "referral": return { title: s(p.title, "title", 120) };
    case "subscribe": return { label: s(p.label, "label", 80) || "Subscribe", text: s(p.text, "text", 300) };
    case "dynamic": {
      if (depth > 0) throw validation("Dynamic content blocks can't be nested");
      return { rules: p.rules && typeof p.rules === "object" ? p.rules : { match: "all", conditions: [] }, blocks: cleanBlocks(p.blocks ?? [], depth + 1) };
    }
  }
  throw validation(`Unknown block type "${type}"`);
}

/** Validates a block list from the editor. Unknown shapes are rejected, text is length-capped, URLs are checked. */
export function cleanBlocks(raw: unknown, depth = 0): Block[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw validation(`"blocks" must be a list`);
  if (raw.length > MAX_BLOCKS) throw validation(`A post can have at most ${MAX_BLOCKS} blocks`);
  const seen = new Set<string>();
  return raw.map((b) => {
    if (!b || typeof b !== "object" || typeof b.type !== "string") throw validation("Each block needs a type");
    if (!(BLOCK_TYPES as readonly string[]).includes(b.type)) throw validation(`Unknown block type "${b.type}"`);
    let id = typeof b.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(b.id) ? b.id : "b" + randomBytes(5).toString("hex");
    if (seen.has(id)) id = "b" + randomBytes(5).toString("hex");
    seen.add(id);
    return { id, type: b.type, props: cleanProps(b.type, (b.props && typeof b.props === "object" ? b.props : {}) as Record<string, any>, depth) };
  });
}

/** Every dynamic block anywhere in a list, so callers can validate or precompute their rules. */
export const dynamicBlocks = (blocks: Block[]): Block[] => blocks.filter((b) => b.type === "dynamic");

export const BUILTIN_TEMPLATES: { id: string; name: string; blocks: Block[] }[] = [
  { id: "tpl_blank", name: "Blank", blocks: [] },
  {
    id: "tpl_newsletter", name: "Newsletter",
    blocks: [
      { id: "n1", type: "text", props: { markdown: "Hi {{first_name | there}},\n\nHere's what's new this week." } },
      { id: "n2", type: "heading", props: { text: "The big story", level: 2, align: "left" } },
      { id: "n3", type: "text", props: { markdown: "Write the main story here. Keep paragraphs short, and use **bold** to guide the eye." } },
      { id: "n4", type: "button", props: { label: "Read more", url: "https://example.com", align: "left" } },
      { id: "n5", type: "divider", props: {} },
      { id: "n6", type: "heading", props: { text: "Quick links", level: 3, align: "left" } },
      { id: "n7", type: "list", props: { style: "bullet", items: ["First link", "Second link", "Third link"] } },
      { id: "n8", type: "divider", props: {} },
      { id: "n9", type: "referral", props: { title: "Share this newsletter" } },
    ],
  },
  {
    id: "tpl_announcement", name: "Announcement",
    blocks: [
      { id: "a1", type: "heading", props: { text: "We have news", level: 1, align: "left" } },
      { id: "a2", type: "text", props: { markdown: "Tell people what changed, why it matters, and what they should do next." } },
      { id: "a3", type: "button", props: { label: "See what's new", url: "https://example.com", align: "center" } },
    ],
  },
  {
    id: "tpl_digest", name: "Link digest",
    blocks: [
      { id: "d1", type: "text", props: { markdown: "A few things worth your time this week:" } },
      { id: "d2", type: "heading", props: { text: "1. Title of the first link", level: 3, align: "left" } },
      { id: "d3", type: "text", props: { markdown: "Why it's worth reading, in a sentence or two. [Read it](https://example.com)" } },
      { id: "d4", type: "heading", props: { text: "2. Title of the second link", level: 3, align: "left" } },
      { id: "d5", type: "text", props: { markdown: "Another short note. [Read it](https://example.com)" } },
      { id: "d6", type: "divider", props: {} },
      { id: "d7", type: "poll", props: { pollId: "" } },
    ],
  },
];
