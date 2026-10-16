import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { audienceFilter, compileRules } from "./segments.ts";
import { cleanBlocks, dynamicBlocks } from "./blocks.ts";
import type { Block } from "./blocks.ts";
import { baseUrl, getPublication } from "./publication.ts";
import { buildVars, renderCustomEmail, renderEmailDocument } from "./render.ts";
import type { RenderCtx } from "./render.ts";
import { findById } from "./subscribers.ts";
import { pixelUrl, trackHtml } from "./tracking.ts";
import { parseJson } from "./util.ts";

export interface AbVariant { label: string; subject?: string; blocks?: Block[] }
export interface AbConfig { enabled: boolean; variants: AbVariant[]; test_percent: number; metric: "opens" | "clicks"; wait_minutes: number }

export interface PostRow {
  id: string; title: string; subject: string; slug: string; preview_text: string; blocks: string; status: string;
  email_enabled: number; web_enabled: number; access: string; audience: string; from_name: string | null; from_email: string | null;
  author: string; design: string; custom_html: string; cover_url: string; seo_title: string; seo_description: string; ab: string; ab_state: string;
  send_at: number | null; sent_at: number | null; published_at: number | null; recipients: number; created_at: number; updated_at: number;
}

export const subjectOf = (p: Pick<PostRow, "subject" | "title">): string => p.subject || p.title;

/** Subscriber ids that satisfy each dynamic block's rules, computed once per render session. */
export function dynamicSets(db: DB, blocks: Block[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const b of dynamicBlocks(blocks)) {
    const w = compileRules(db, b.props.rules);
    const ids = db.prepare(`SELECT s.id FROM subscribers s WHERE s.status = 'active' AND ${w.sql}`).all(...(w.params as never[])) as { id: string }[];
    out.set(b.id, new Set(ids.map((r) => r.id)));
  }
  return out;
}

interface Plan { blocks: Block[]; ab: AbConfig | null; dynamic: Map<string, Set<string>>; expires: number }
const plans = new Map<string, Plan>();

/** Parsed content for a post, cached briefly so rendering 100k emails doesn't re-parse and re-query for each one. */
function planFor(db: DB, post: PostRow): Plan {
  const key = `${post.id}:${post.updated_at}`;
  const hit = plans.get(key);
  if (hit && hit.expires > Date.now()) return hit;
  const blocks = cleanBlocks(parseJson(post.blocks, []));
  const ab = parseJson<AbConfig | null>(post.ab, null);
  const all = [...blocks, ...(ab?.variants ?? []).flatMap((v) => v.blocks ?? [])];
  const plan: Plan = { blocks, ab: ab?.enabled ? ab : null, dynamic: dynamicSets(db, all), expires: Date.now() + 60_000 };
  if (plans.size > 20) plans.clear();
  plans.set(key, plan);
  return plan;
}

export const postUrl = (base: string, post: Pick<PostRow, "slug">): string => `${base}/p/${post.slug}`;

export interface EmailRowLike { id: string; kind: string; post_id: string | null; subscriber_id: string | null; variant: string | null; automation_run_id: string | null }

/** Renders the HTML and text of a newsletter or automation email for one recipient, at the moment it is sent. */
export function renderStoredEmail(db: DB, cfg: Config, email: EmailRowLike): { html: string; text: string } | null {
  const pub = getPublication(db);
  const base = baseUrl(db, cfg, pub);
  const subscriber = email.subscriber_id ? db.prepare("SELECT * FROM subscribers WHERE id = ?").get(email.subscriber_id) as unknown as ReturnType<typeof findById> | undefined : undefined;
  if (!subscriber) return null;

  if (email.post_id) {
    const post = db.prepare("SELECT * FROM posts WHERE id = ?").get(email.post_id) as unknown as PostRow | undefined;
    if (!post) return null;
    const plan = planFor(db, post);
    const variant = plan.ab?.variants.find((v) => v.label === email.variant);
    const blocks = variant?.blocks?.length ? variant.blocks : plan.blocks;
    const viewUrl = post.web_enabled && post.published_at ? postUrl(base, post) : null;
    const c: RenderCtx = { db, pub, base, mode: "email", subscriber, dynamic: plan.dynamic, vars: buildVars(db, pub, base, subscriber, { view_url: viewUrl ?? "", post_title: post.title }) };
    const subject = variant?.subject || subjectOf(post);
    const doc = post.design === "custom"
      ? renderCustomEmail(post.custom_html, { subject, previewText: post.preview_text }, c)
      : renderEmailDocument({ subject, previewText: post.preview_text, title: post.title, blocks, viewUrl, design: post.design }, c);
    return {
      html: finish(db, doc.html, pub, base, email.id, `post:${post.id}`, post.slug),
      text: doc.text,
    };
  }

  if (email.kind === "automation" && email.automation_run_id) {
    const run = db.prepare("SELECT automation_id FROM automation_runs WHERE id = ?").get(email.automation_run_id) as { automation_id: string } | undefined;
    const auto = run && (db.prepare("SELECT id, name, steps FROM automations WHERE id = ?").get(run.automation_id) as { id: string; name: string; steps: string } | undefined);
    if (!auto) return null;
    const step = findStep(parseJson(auto.steps, []), email.variant ?? "");
    if (!step) return null;
    const blocks = cleanBlocks(step.blocks ?? []);
    const c: RenderCtx = { db, pub, base, mode: "email", subscriber, dynamic: dynamicSets(db, blocks), vars: buildVars(db, pub, base, subscriber) };
    const doc = renderEmailDocument({ subject: step.subject ?? "", previewText: step.preview ?? "", blocks }, c);
    return { html: finish(db, doc.html, pub, base, email.id, `auto:${auto.id}`, auto.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")), text: doc.text };
  }
  return null;
}

function finish(db: DB, html: string, pub: ReturnType<typeof getPublication>, base: string, emailId: string, scope: string, campaign: string): string {
  const tracked = trackHtml(db, html, { scope, emailId, base, pub, campaign });
  return pub.track_opens ? tracked.replace("</body>", `<img src="${pixelUrl(base, emailId)}" width="1" height="1" alt="" style="display:block;border:0;width:1px;height:1px;"></body>`) : tracked;
}

interface StepLike { id: string; type: string; subject?: string; preview?: string; blocks?: unknown; yes?: StepLike[]; no?: StepLike[] }
export function findStep(steps: StepLike[], id: string): StepLike | null {
  for (const s of steps) {
    if (s.id === id) return s;
    const inner = findStep([...(s.yes ?? []), ...(s.no ?? [])], id);
    if (inner) return inner;
  }
  return null;
}

export { audienceFilter };
