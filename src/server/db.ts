import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export type DB = DatabaseSync;

// Append-only. Each entry runs once, in order, and bumps PRAGMA user_version.
const MIGRATIONS: string[] = [
  `
  CREATE TABLE domains (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending',      -- pending | verified | failed
    selector TEXT NOT NULL,
    dkim_private TEXT NOT NULL,                  -- PEM; protect the database file
    dkim_public TEXT NOT NULL,                   -- base64 DER (SPKI), goes in DNS
    checks TEXT NOT NULL DEFAULT '{}',           -- last DNS check per record
    created_at INTEGER NOT NULL,
    verified_at INTEGER,
    checked_at INTEGER
  );

  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    prefix TEXT NOT NULL,
    hash TEXT NOT NULL UNIQUE,                   -- sha256 of the key; the key itself is never stored
    permission TEXT NOT NULL DEFAULT 'full',     -- full | sending
    domain_id TEXT REFERENCES domains(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    revoked_at INTEGER
  );

  CREATE TABLE emails (
    id TEXT PRIMARY KEY,
    api_key_id TEXT REFERENCES api_keys(id) ON DELETE SET NULL,
    domain_id TEXT REFERENCES domains(id) ON DELETE SET NULL,
    from_name TEXT,
    from_email TEXT NOT NULL,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_to TEXT NOT NULL DEFAULT '[]',
    headers TEXT NOT NULL DEFAULT '{}',
    tags TEXT NOT NULL DEFAULT '[]',
    to_json TEXT NOT NULL,
    cc_json TEXT NOT NULL DEFAULT '[]',
    bcc_json TEXT NOT NULL DEFAULT '[]',
    message_id TEXT NOT NULL,
    scheduled_at INTEGER,
    last_event TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX emails_created ON emails(created_at DESC);

  CREATE TABLE deliveries (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    recipient TEXT NOT NULL,
    status TEXT NOT NULL,                        -- queued | sending | sent | delivered | bounced | failed | suppressed | canceled
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_error TEXT,
    response TEXT,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX deliveries_due ON deliveries(status, next_attempt_at);
  CREATE INDEX deliveries_email ON deliveries(email_id);

  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    email_id TEXT NOT NULL REFERENCES emails(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    recipient TEXT,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE INDEX events_email ON events(email_id, created_at);

  CREATE TABLE suppressions (
    email TEXT PRIMARY KEY,
    reason TEXT NOT NULL,                        -- bounce | complaint | manual
    detail TEXT,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE webhooks (
    id TEXT PRIMARY KEY,
    url TEXT NOT NULL,
    events TEXT NOT NULL DEFAULT '[]',           -- empty = every event
    secret TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE webhook_attempts (
    id TEXT PRIMARY KEY,
    webhook_id TEXT NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
    status TEXT NOT NULL,                        -- queued | sending | delivered | failed
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_status INTEGER,
    last_error TEXT
  );
  CREATE INDEX webhook_attempts_due ON webhook_attempts(status, next_attempt_at);

  CREATE TABLE idempotency (
    key TEXT NOT NULL,
    api_key_id TEXT NOT NULL,
    request_hash TEXT NOT NULL,
    status INTEGER NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (api_key_id, key)
  );
  `,
  `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,                         -- sha256 of the cookie token
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  `,
  `
  -- ===== Newsletter platform =====
  CREATE TABLE publication (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL DEFAULT 'My newsletter',
    description TEXT NOT NULL DEFAULT '',
    slug TEXT NOT NULL DEFAULT 'newsletter',
    from_name TEXT NOT NULL DEFAULT '',
    from_email TEXT NOT NULL DEFAULT '',
    reply_to TEXT NOT NULL DEFAULT '',
    site_url TEXT NOT NULL DEFAULT '',            -- public base URL, e.g. https://news.example.com
    site_domain TEXT NOT NULL DEFAULT '',         -- if set, requests for this Host serve the site at /
    address TEXT NOT NULL DEFAULT '',             -- postal address shown in every footer
    brand_color TEXT NOT NULL DEFAULT '#1663fe',
    font TEXT NOT NULL DEFAULT 'sans',            -- sans | serif | mono
    logo_url TEXT NOT NULL DEFAULT '',
    footer TEXT NOT NULL DEFAULT '',
    double_opt_in INTEGER NOT NULL DEFAULT 1,
    welcome_enabled INTEGER NOT NULL DEFAULT 1,
    welcome_subject TEXT NOT NULL DEFAULT 'Welcome to {{publication_name}}',
    welcome_body TEXT NOT NULL DEFAULT 'Thanks for subscribing. You will hear from us soon.',
    track_opens INTEGER NOT NULL DEFAULT 1,
    track_clicks INTEGER NOT NULL DEFAULT 1,
    utm_links INTEGER NOT NULL DEFAULT 1,
    referral_enabled INTEGER NOT NULL DEFAULT 0,
    nav TEXT NOT NULL DEFAULT '[]',               -- site menu: [{label, url}]
    seo_title TEXT NOT NULL DEFAULT '',
    seo_description TEXT NOT NULL DEFAULT '',
    og_image_url TEXT NOT NULL DEFAULT '',
    updated_at INTEGER NOT NULL
  );
  INSERT INTO publication (id, updated_at) VALUES (1, 0);

  CREATE TABLE subscribers (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,                         -- pending | active | unsubscribed | bounced
    token TEXT NOT NULL UNIQUE,                   -- public id used in confirm / unsubscribe / poll links
    referral_code TEXT NOT NULL UNIQUE,
    referred_by TEXT REFERENCES subscribers(id) ON DELETE SET NULL,
    fields TEXT NOT NULL DEFAULT '{}',            -- custom fields (first_name, last_name, ...)
    source TEXT NOT NULL DEFAULT 'manual',        -- form | import | api | referral | manual
    utm_source TEXT, utm_medium TEXT, utm_campaign TEXT, referrer TEXT, country TEXT,
    created_at INTEGER NOT NULL,
    confirmed_at INTEGER,
    unsubscribed_at INTEGER,
    emails_received INTEGER NOT NULL DEFAULT 0,
    opens INTEGER NOT NULL DEFAULT 0,
    clicks INTEGER NOT NULL DEFAULT 0,
    last_open_at INTEGER,
    last_click_at INTEGER
  );
  CREATE INDEX subscribers_status ON subscribers(status, created_at);
  CREATE INDEX subscribers_referred ON subscribers(referred_by);

  CREATE TABLE subscriber_tags (
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    tag TEXT NOT NULL,
    PRIMARY KEY (subscriber_id, tag)
  );
  CREATE INDEX subscriber_tags_tag ON subscriber_tags(tag);

  CREATE TABLE subscriber_events (                -- subscription history, for growth charts and attribution
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    subscriber_id TEXT NOT NULL,
    type TEXT NOT NULL,                           -- subscribed | confirmed | unsubscribed | bounced
    post_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX subscriber_events_time ON subscriber_events(type, created_at);

  CREATE TABLE field_defs (
    key TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'text'             -- text | number | date | boolean
  );

  CREATE TABLE segments (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,                           -- dynamic (rules) | static (fixed members)
    rules TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE segment_members (
    segment_id TEXT NOT NULL REFERENCES segments(id) ON DELETE CASCADE,
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    PRIMARY KEY (segment_id, subscriber_id)
  );

  CREATE TABLE posts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    subject TEXT NOT NULL DEFAULT '',             -- email subject; falls back to the title
    slug TEXT NOT NULL UNIQUE,
    preview_text TEXT NOT NULL DEFAULT '',
    blocks TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'draft',         -- draft | scheduled | sending | sent
    email_enabled INTEGER NOT NULL DEFAULT 1,
    web_enabled INTEGER NOT NULL DEFAULT 1,
    access TEXT NOT NULL DEFAULT 'public',        -- public | subscribers (readers log in with a magic link)
    audience TEXT NOT NULL DEFAULT 'all',         -- all | segment:<id> | tag:<name>
    from_name TEXT, from_email TEXT,
    author TEXT NOT NULL DEFAULT '',
    cover_url TEXT NOT NULL DEFAULT '',
    seo_title TEXT NOT NULL DEFAULT '',
    seo_description TEXT NOT NULL DEFAULT '',
    ab TEXT NOT NULL DEFAULT '{}',                -- A/B test config
    ab_state TEXT NOT NULL DEFAULT '{}',          -- progress of a running test
    send_at INTEGER,
    sent_at INTEGER,
    published_at INTEGER,                         -- when it went live on the website; null = not published
    recipients INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX posts_status ON posts(status, send_at);

  CREATE TABLE templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    blocks TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE pages (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    blocks TEXT NOT NULL DEFAULT '[]',
    published INTEGER NOT NULL DEFAULT 1,
    in_nav INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE links (                            -- tracked links; the redirect only goes to URLs stored here
    id TEXT PRIMARY KEY,
    scope TEXT NOT NULL,                          -- post:<id> | auto:<id>
    url TEXT NOT NULL,
    UNIQUE (scope, url)
  );

  CREATE TABLE polls (
    id TEXT PRIMARY KEY,
    question TEXT NOT NULL,
    options TEXT NOT NULL,
    closed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE poll_votes (
    poll_id TEXT NOT NULL REFERENCES polls(id) ON DELETE CASCADE,
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    option INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (poll_id, subscriber_id)
  );

  CREATE TABLE surveys (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    questions TEXT NOT NULL DEFAULT '[]',
    closed INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE survey_responses (
    id TEXT PRIMARY KEY,
    survey_id TEXT NOT NULL REFERENCES surveys(id) ON DELETE CASCADE,
    subscriber_id TEXT REFERENCES subscribers(id) ON DELETE SET NULL,
    answers TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX survey_one_response ON survey_responses(survey_id, subscriber_id) WHERE subscriber_id IS NOT NULL;

  CREATE TABLE rewards (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'digital',         -- digital (link emailed automatically) | physical (you fulfil it)
    description TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  CREATE TABLE reward_claims (
    id TEXT PRIMARY KEY,
    reward_id TEXT NOT NULL REFERENCES rewards(id) ON DELETE CASCADE,
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'earned',        -- earned | fulfilled
    earned_at INTEGER NOT NULL,
    fulfilled_at INTEGER,
    UNIQUE (reward_id, subscriber_id)
  );

  CREATE TABLE automations (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',         -- draft | live | paused
    trigger TEXT NOT NULL DEFAULT '{}',
    steps TEXT NOT NULL DEFAULT '[]',
    allow_reentry INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE automation_runs (
    id TEXT PRIMARY KEY,
    automation_id TEXT NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'active',        -- active | completed | canceled | failed
    cursor TEXT NOT NULL DEFAULT '0',             -- path into the step tree, e.g. 2.yes.0
    next_run_at INTEGER NOT NULL,
    last_error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX automation_runs_due ON automation_runs(status, next_run_at);
  CREATE INDEX automation_runs_sub ON automation_runs(automation_id, subscriber_id);

  CREATE TABLE custom_events (
    id TEXT PRIMARY KEY,
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE reader_sessions (                  -- readers of gated posts, signed in with a magic link
    id TEXT PRIMARY KEY,                          -- sha256 of the cookie token
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE magic_tokens (
    id TEXT PRIMARY KEY,                          -- sha256 of the emailed token
    subscriber_id TEXT NOT NULL REFERENCES subscribers(id) ON DELETE CASCADE,
    redirect TEXT NOT NULL DEFAULT '/',
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE uploads (
    id TEXT PRIMARY KEY,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  ALTER TABLE emails ADD COLUMN kind TEXT NOT NULL DEFAULT 'api';   -- api | broadcast | automation | system
  ALTER TABLE emails ADD COLUMN post_id TEXT;
  ALTER TABLE emails ADD COLUMN subscriber_id TEXT;
  ALTER TABLE emails ADD COLUMN variant TEXT;                        -- A/B variant label, or automation step id
  ALTER TABLE emails ADD COLUMN automation_run_id TEXT;
  ALTER TABLE deliveries ADD COLUMN bulk INTEGER NOT NULL DEFAULT 0;   -- newsletter / automation mail is rate limited; API mail is not
  CREATE INDEX emails_post ON emails(post_id);
  CREATE INDEX emails_subscriber ON emails(subscriber_id);
  CREATE INDEX events_type ON events(type, created_at);
  `,
  // 4: email designs, and posts written as raw HTML
  `
  ALTER TABLE posts ADD COLUMN design TEXT NOT NULL DEFAULT '';          -- '' = the publication's design | plain | editorial | modern | bold | custom
  ALTER TABLE posts ADD COLUMN custom_html TEXT NOT NULL DEFAULT '';
  ALTER TABLE publication ADD COLUMN design TEXT NOT NULL DEFAULT 'modern';
  `,
];

export function openDb(file: string): DB {
  if (file !== ":memory:") mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  if (file !== ":memory:") chmodSync(file, 0o600);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");

  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < MIGRATIONS.length; v++) {
    db.exec("BEGIN");
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return db;
}

/** Runs `fn` in a transaction. Rolls back if it throws. Nested calls join the outer transaction. */
export function tx<T>(db: DB, fn: () => T): T {
  if (db.isTransaction) return fn();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
