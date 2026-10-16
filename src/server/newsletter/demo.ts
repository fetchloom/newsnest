import type { Config } from "../config.ts";
import type { DB } from "../db.ts";
import { ApiError } from "../errors.ts";
import { newId, now } from "../ids.ts";
import { createAutomation } from "./automations.ts";
import { createPage } from "./pages.ts";
import { createPoll } from "./polls.ts";
import { getPublication } from "./publication.ts";
import { createSegment } from "./segments.ts";
import { parseJson, token } from "./util.ts";

// Sample data: an empty Newsnest is hard to judge, so this fills one with believable subscribers, sent issues with
// opens and clicks, a poll, a segment, an automation and referral rewards. Everything it makes is recorded so it
// can be removed again, every subscriber carries the "sample" tag, and every address is on example.com/.org/.net.

const DAY = 24 * 3600 * 1000;
const KEY = "demo_data";

interface Created { posts: string[]; segments: string[]; polls: string[]; automations: string[]; pages: string[]; rewards: string[] }

/** A small seeded random number generator, so the sample data is the same every time. */
function rng(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FIRST = ["Ada", "Ben", "Cleo", "Dev", "Elif", "Finn", "Grace", "Hugo", "Iris", "Jon", "Kira", "Leo", "Maya", "Noah", "Omar", "Pia", "Quinn", "Rosa", "Sam", "Tara", "Uma", "Vic", "Wren", "Xavi", "Yara", "Zane", "Nina", "Theo", "Lena", "Jules", "Mira", "Otis", "Anya", "Cal", "Dina", "Eli", "Faye", "Gus", "Hana", "Ivan"];
const LAST = ["Stone", "Rivera", "Okafor", "Lindqvist", "Moreau", "Tanaka", "Haddad", "Novak", "Bianchi", "Walsh", "Costa", "Ibrahim", "Kowalski", "Singh", "Alvarez", "Fischer", "Nguyen", "Abbott", "Kaya", "Larsen"];
const REFERRERS = ["https://x.com", "https://news.ycombinator.com", "https://www.google.com", "https://www.reddit.com", "https://www.linkedin.com"];
const UTM = ["twitter", "newsletter-swap", "google", "hn", "linkedin"];

const ISSUES: { title: string; subject: string; text: string; list: string[]; quote: [string, string]; button: string; design: string }[] = [
  { title: "Why small newsletters win", subject: "Why small newsletters win", text: "Big audiences are loud. Small ones **listen**. This week: what the best independent writers do differently, and why you do not need ten thousand readers to build something that lasts.", list: ["Write for one person you know", "Reply to every email you get", "Say no to growth tricks that cost trust"], quote: ["Make it so good they forward it.", "A reader"], button: "Read the full issue", design: "" },
  { title: "The tools behind a calm workflow", subject: "The tools behind a calm workflow", text: "A short tour of the setup we use to write, schedule and send without the chaos, plus the **one habit** that saved us the most time.", list: ["One inbox for ideas", "A weekly writing block", "Templates for everything repeatable"], quote: ["Constraints are a gift.", "Someone wise"], button: "See the setup", design: "" },
  { title: "Ten subject lines, tested", subject: "We tested ten subject lines. Here is what won", text: "We split-tested ten subject lines across **four issues**. The winner surprised us, and the loser taught us more than the winner did.", list: ["Specific beat clever", "Questions lost to statements", "Short won on phones"], quote: ["Curiosity opens. Clarity clicks.", "Our own notes"], button: "Get the results", design: "bold" },
  { title: "Your first thousand readers", subject: "Your first thousand readers", text: "Everyone asks how to get to a thousand. Here is the unglamorous answer, with the **numbers** from three newsletters that did it without ads.", list: ["Referrals did the heavy lifting", "A great welcome email matters", "Consistency over cleverness"], quote: ["Start where your readers already are.", "A founder"], button: "Read the breakdown", design: "" },
  { title: "What we got wrong this year", subject: "What we got wrong this year", text: "A candid look back: the experiments that failed, the ones that worked by accident, and what we are changing next. **Thank you** for reading along.", list: ["We sent too often", "We buried the best link", "We forgot to ask for replies"], quote: ["Learn out loud.", "Newsletter motto"], button: "Join the conversation", design: "editorial" },
];

export function demoStatus(db: DB): { loaded: boolean; empty: boolean } {
  const loaded = !!db.prepare("SELECT 1 FROM settings WHERE key = ?").get(KEY);
  const subs = (db.prepare("SELECT COUNT(*) AS n FROM subscribers").get() as { n: number }).n;
  const posts = (db.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n;
  return { loaded, empty: subs === 0 && posts === 0 };
}

export function seedDemo(db: DB, cfg: Config): { subscribers: number; posts: number } {
  const state = demoStatus(db);
  if (state.loaded) throw new ApiError(409, "demo_loaded", "Sample data is already loaded.");
  if (!state.empty) throw new ApiError(409, "demo_needs_empty", "Sample data can only be loaded into an empty Newsnest, so it never mixes with your real subscribers.");

  const rand = rng(2026);
  const pick = <T>(a: T[]): T => a[Math.floor(rand() * a.length)];
  const at = now();
  const pub = getPublication(db);
  const created: Created = { posts: [], segments: [], polls: [], automations: [], pages: [], rewards: [] };

  db.exec("BEGIN");
  try {
    // ---- subscribers, oldest first, with more recent sign-ups than old ones ----
    interface Sub { id: string; email: string; status: string; created: number; confirmed: number | null; unsubscribed: number | null; propensity: number; opens: number; clicks: number; lastOpen: number | null; lastClick: number | null; received: number }
    const subs: Sub[] = [];
    const used = new Set<string>();
    const ages = Array.from({ length: 420 }, () => Math.pow(rand(), 1.7) * 75).sort((a, b) => b - a);
    const insertSub = db.prepare(`INSERT INTO subscribers (id, email, status, token, referral_code, referred_by, fields, source, utm_source, utm_medium, referrer, created_at, confirmed_at, unsubscribed_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insertTag = db.prepare("INSERT OR IGNORE INTO subscriber_tags (subscriber_id, tag) VALUES (?, ?)");
    const insertEvent = db.prepare("INSERT INTO subscriber_events (subscriber_id, type, post_id, created_at) VALUES (?, ?, ?, ?)");
    const power: string[] = [];
    for (const [i, age] of ages.entries()) {
      const first = pick(FIRST), last = pick(LAST);
      let email = `${first}.${last}${i}@example.${pick(["com", "org", "net"])}`.toLowerCase();
      while (used.has(email)) email = `x${email}`;
      used.add(email);
      const createdAt = Math.round(at - age * DAY - rand() * DAY * 0.5);
      const roll = rand();
      const status = roll < 0.88 ? "active" : roll < 0.93 ? "unsubscribed" : roll < 0.96 ? "pending" : "bounced";
      const confirmed = status === "pending" ? null : createdAt + Math.round(30_000 + rand() * 7_200_000);
      const unsubscribed = status === "unsubscribed" ? Math.min(at - 3600_000, createdAt + Math.round((3 + rand() * 40) * DAY)) : null;
      const src = rand();
      const source = src < 0.5 ? "form" : src < 0.68 ? "referral" : src < 0.8 ? "import" : src < 0.9 ? "api" : "manual";
      const referredBy = source === "referral" && power.length ? power[Math.floor(Math.pow(rand(), 2) * power.length)] : null;
      const id = newId("sub");
      insertSub.run(id, email, status, token(), token(6), referredBy, JSON.stringify({ first_name: first, last_name: last }), source,
        source === "form" ? pick(UTM) : null, source === "form" ? "social" : null, source === "form" ? pick(REFERRERS) : null, createdAt, confirmed, unsubscribed);
      insertTag.run(id, "sample");
      for (const [tag, p] of [["vip", 0.18], ["writer", 0.22], ["maker", 0.15], ["beta", 0.12]] as const) if (rand() < p) insertTag.run(id, tag);
      insertEvent.run(id, "subscribed", null, createdAt);
      if (confirmed) insertEvent.run(id, "confirmed", null, confirmed);
      if (status === "bounced") insertEvent.run(id, "bounced", null, createdAt + 2 * DAY);
      if (status === "active" && power.length < 7 && i > 5 && i < 80) power.push(id);
      subs.push({ id, email, status, created: createdAt, confirmed, unsubscribed, propensity: Math.pow(rand(), 0.8) * 0.9, opens: 0, clicks: 0, lastOpen: null, lastClick: null, received: 0 });
    }

    // ---- sent issues, a few weeks apart, with opens and clicks spread over the following days ----
    const insertPost = db.prepare(`INSERT INTO posts (id, title, subject, slug, preview_text, blocks, status, email_enabled, web_enabled, access, audience, design, cover_url, recipients, send_at, sent_at, published_at, author, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'sent', 1, 1, 'public', 'all', ?, '', ?, ?, ?, ?, ?, ?, ?)`);
    const insertEmail = db.prepare(`INSERT INTO emails (id, from_name, from_email, subject, html, text, to_json, message_id, last_event, created_at, kind, post_id, subscriber_id)
      VALUES (?, ?, ?, ?, '', '', ?, ?, ?, ?, 'broadcast', ?, ?)`);
    const insertDelivery = db.prepare("INSERT INTO deliveries (id, email_id, recipient, status, attempts, next_attempt_at, updated_at, bulk) VALUES (?, ?, ?, ?, 1, ?, ?, 1)");
    const insertEv = db.prepare("INSERT INTO events (id, email_id, type, recipient, data, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    const insertLink = db.prepare("INSERT OR IGNORE INTO links (id, scope, url) VALUES (?, ?, ?)");
    const unsubs = subs.filter((s) => s.unsubscribed);
    const fromEmail = pub.from_email || "news@example.com";
    const fromName = pub.from_name || pub.name;

    for (const [n, issue] of ISSUES.entries()) {
      const sentAt = at - (34 - n * 7) * DAY + 9 * 3600_000;
      const id = newId("post");
      const slug = issue.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const url = `https://example.com/${slug}`;
      const blocks = [
        { id: newId("b").slice(0, 10), type: "text", props: { markdown: issue.text } },
        { id: newId("b").slice(0, 10), type: "list", props: { style: "bullet", items: issue.list } },
        { id: newId("b").slice(0, 10), type: "quote", props: { text: issue.quote[0], cite: issue.quote[1] } },
        { id: newId("b").slice(0, 10), type: "button", props: { label: issue.button, url, align: "left" } },
      ];
      const audience = subs.filter((s) => s.created < sentAt && (s.status === "active" || (s.unsubscribed && s.unsubscribed > sentAt)));
      insertPost.run(id, issue.title, issue.subject, slug, "", JSON.stringify(blocks), issue.design, audience.length, sentAt, sentAt + 120_000, sentAt, "", sentAt - DAY, sentAt);
      created.posts.push(id);
      const linkId = `lnk_${token(8)}`;
      insertLink.run(linkId, `post:${id}`, url);

      let k = 0;
      for (const s of audience) {
        const emailId = `em_${token(10)}${k++}`;
        const t0 = sentAt + Math.round(rand() * 90_000);
        const opened = rand() < s.propensity * 0.85;
        const opens = opened ? 1 + (rand() < 0.3 ? 1 : 0) : 0;
        const clicked = opened && rand() < 0.2 + s.propensity * 0.15;
        insertEmail.run(emailId, fromName, fromEmail, issue.subject, JSON.stringify([{ email: s.email }]), `<${emailId}@sample.invalid>`,
          clicked ? "email.clicked" : opened ? "email.opened" : "email.delivered", t0, id, s.id);
        insertDelivery.run(`dlv_${token(8)}${k}`, emailId, s.email, "delivered", t0, t0 + 1500);
        insertEv.run(`evt_${token(8)}${k}a`, emailId, "email.sent", s.email, "{}", t0 + 400);
        insertEv.run(`evt_${token(8)}${k}b`, emailId, "email.delivered", s.email, "{}", t0 + 1500);
        s.received++;
        if (!opened) continue;
        const device = rand() < 0.58 ? "mobile" : "desktop";
        let openAt = t0;
        for (let o = 0; o < opens; o++) {
          openAt = Math.min(at - 60_000, t0 + Math.round(-Math.log(1 - rand()) * 4 * 3600_000 * (o + 1)));
          insertEv.run(`evt_${token(8)}${k}o${o}`, emailId, "email.opened", s.email, JSON.stringify({ device, proxy: null }), openAt);
        }
        s.opens++;
        s.lastOpen = Math.max(s.lastOpen ?? 0, openAt);
        if (clicked) {
          const clickAt = Math.min(at - 30_000, openAt + Math.round(5_000 + rand() * 600_000));
          insertEv.run(`evt_${token(8)}${k}c`, emailId, "email.clicked", s.email, JSON.stringify({ url, verified: 1, device, link: linkId }), clickAt);
          s.clicks++;
          s.lastClick = Math.max(s.lastClick ?? 0, clickAt);
        }
      }
      // A few unsubscribes were caused by this issue.
      for (const s of unsubs) if (s.unsubscribed! > sentAt && s.unsubscribed! < sentAt + 2 * DAY) insertEvent.run(s.id, "unsubscribed", id, s.unsubscribed!);
    }
    for (const s of unsubs) if (!db.prepare("SELECT 1 FROM subscriber_events WHERE subscriber_id = ? AND type = 'unsubscribed'").get(s.id)) insertEvent.run(s.id, "unsubscribed", null, s.unsubscribed!);
    const update = db.prepare("UPDATE subscribers SET emails_received = ?, opens = ?, clicks = ?, last_open_at = ?, last_click_at = ? WHERE id = ?");
    for (const s of subs) update.run(s.received, s.opens, s.clicks, s.lastOpen, s.lastClick, s.id);

    // ---- drafts, so the Posts page has work in progress ----
    for (const [title, md] of [["Draft: how we plan an issue", "Outline the three sections, then write the opening."], ["Draft: reader mailbag", "Pick five questions from the replies."]] as const) {
      const id = newId("post");
      db.prepare("INSERT INTO posts (id, title, slug, blocks, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'draft', ?, ?)")
        .run(id, title, title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""), JSON.stringify([{ id: "d1", type: "text", props: { markdown: md } }]), at - DAY, at - 3600_000);
      created.posts.push(id);
    }

    // ---- a poll with votes, a segment, an automation, rewards, a page ----
    const poll = createPoll(db, { question: "What should we cover next?", options: ["Deliverability", "Automations", "Growth tactics", "Design"] }) as { id: string };
    created.polls.push(poll.id);
    const vote = db.prepare("INSERT OR IGNORE INTO poll_votes (poll_id, subscriber_id, option, created_at) VALUES (?, ?, ?, ?)");
    for (const s of subs) if (s.status === "active" && rand() < 0.3) vote.run(poll.id, s.id, Math.floor(Math.pow(rand(), 1.4) * 4), at - Math.round(rand() * 10 * DAY));

    created.segments.push((createSegment(db, { name: "VIP readers", rules: { match: "all", conditions: [{ field: "tag", op: "has", value: "vip" }, { field: "status", op: "is", value: "active" }] } }) as { id: string }).id);
    created.segments.push((createSegment(db, { name: "Engaged this month", rules: { match: "all", conditions: [{ field: "last_open_at", op: "within_days", value: 30 }] } }) as { id: string }).id);

    const auto = createAutomation(db, {
      name: "Welcome series", trigger: { type: "signup" },
      steps: [
        { type: "email", subject: "Welcome, {{first_name | friend}}", blocks: [{ type: "text", props: { markdown: "Glad you're here. **Hit reply** and tell us what you'd like to read." } }] },
        { type: "delay", minutes: 2880 },
        { type: "email", subject: "Our best three issues", blocks: [{ type: "text", props: { markdown: "If you only read three, start with these." } }] },
        { type: "add_tag", tag: "welcomed" },
      ],
    }) as { id: string };
    db.prepare("UPDATE automations SET status = 'live' WHERE id = ?").run(auto.id); // not via setAutomationStatus: that insists on a From address
    created.automations.push(auto.id);

    const reward = db.prepare("INSERT INTO rewards (id, name, threshold, kind, description, url, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
    for (const [name, threshold, kind, description, url] of [["Sticker pack", 3, "physical", "We will email you for your address.", ""], ["The handbook", 5, "digital", "Our guide to writing a newsletter people finish.", "https://example.com/handbook.pdf"]] as const) {
      const id = newId("rw");
      reward.run(id, name, threshold, kind, description, url, at - 20 * DAY);
      created.rewards.push(id);
    }

    created.pages.push((createPage(db, { title: "About", in_nav: true, blocks: [{ type: "text", props: { markdown: `${pub.name} is a small newsletter about writing, tools and the people who make things. One email a week, no ads.` } }] }) as { id: string }).id);

    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(KEY, JSON.stringify(created));
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { subscribers: (db.prepare("SELECT COUNT(*) AS n FROM subscribers").get() as { n: number }).n, posts: created.posts.length };
}

export function removeDemo(db: DB): { removed: boolean } {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(KEY) as { value: string } | undefined;
  if (!row) return { removed: false };
  const c = parseJson<Created>(row.value, { posts: [], segments: [], polls: [], automations: [], pages: [], rewards: [] });
  const ids = (db.prepare("SELECT subscriber_id AS id FROM subscriber_tags WHERE tag = 'sample'").all() as { id: string }[]).map((r) => r.id);
  db.exec("BEGIN");
  try {
    const del = (table: string, col: string, values: string[]): void => { const s = db.prepare(`DELETE FROM ${table} WHERE ${col} = ?`); for (const v of values) s.run(v); };
    del("emails", "post_id", c.posts);
    del("links", "scope", c.posts.map((p) => `post:${p}`));
    del("subscriber_events", "subscriber_id", ids);
    del("subscribers", "id", ids);
    del("posts", "id", c.posts);
    del("segments", "id", c.segments);
    del("polls", "id", c.polls);
    del("automations", "id", c.automations);
    del("pages", "id", c.pages);
    del("rewards", "id", c.rewards);
    db.prepare("DELETE FROM settings WHERE key = ?").run(KEY);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return { removed: true };
}
