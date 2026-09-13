import type { Database } from 'better-sqlite3';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Append-only. Never edit a migration that has been deployed — add a new one.
 * Versioning rides on `PRAGMA user_version`, so no bookkeeping table is needed and a
 * fresh Railway volume self-initialises on first boot.
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init',
    sql: `
-- ─── messages: the raw ingest log and the step-2 parser's work queue ─────────
CREATE TABLE messages (
  id             INTEGER PRIMARY KEY,
  channel        TEXT    NOT NULL,            -- lowercased username, e.g. 'kpszsu'
  message_id     INTEGER NOT NULL,            -- post number from data-post="channel/58348"
  posted_at      INTEGER NOT NULL,            -- epoch ms UTC from <time datetime>
  fetched_at     INTEGER NOT NULL,            -- epoch ms we first saw it
  text           TEXT    NOT NULL DEFAULT '', -- normalised; '' for media-only posts
  text_html      TEXT,                        -- raw innerHTML; NULL when there is no body
  content_hash   TEXT    NOT NULL,            -- sha1(text); detects edits without long compares
  has_media      INTEGER NOT NULL DEFAULT 0,
  edited_at      INTEGER,                     -- epoch ms we noticed the text change
  is_sensitive   INTEGER NOT NULL DEFAULT 0,  -- impacts / AD results: never map, never feed
  parse_state    TEXT    NOT NULL DEFAULT 'pending'
                 CHECK (parse_state IN ('pending','parsed','unparsed','skipped','error')),
  parsed_at      INTEGER,                     -- step 2
  parser_version INTEGER                      -- step 2: bump to requeue everything
) STRICT;

-- This index IS the dedup mechanism; INSERT OR IGNORE relies on it.
CREATE UNIQUE INDEX ux_messages_channel_post ON messages(channel, message_id);
CREATE INDEX ix_messages_posted_at ON messages(posted_at DESC);
-- The step-2 work queue. Partial, so it only holds rows that still need parsing.
CREATE INDEX ix_messages_parse_queue ON messages(posted_at) WHERE parse_state = 'pending';

-- ─── channel_state: poll cursors + health. Three rows, ever. ────────────────
CREATE TABLE channel_state (
  channel              TEXT    PRIMARY KEY,
  last_message_id      INTEGER NOT NULL DEFAULT 0, -- gap-fill cursor (highest ingested)
  oldest_message_id    INTEGER NOT NULL DEFAULT 0, -- backfill cursor (lowest ingested)
  last_success_at      INTEGER,                    -- drives /healthz staleness
  last_error           TEXT,                       -- short reason; never an HTML body
  last_error_at        INTEGER,
  -- Persisted so a crash-loop cannot reset backoff and hammer Telegram.
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  enabled              INTEGER NOT NULL DEFAULT 1  -- kill a channel without a redeploy
) STRICT;

-- ─── targets: created now, populated in step 2 ──────────────────────────────
CREATE TABLE targets (
  id           INTEGER PRIMARY KEY,
  message_id   INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL DEFAULT 0, -- nth target in a multi-target message;
                                           -- gives step-3 anti-spam a stable key
  type         TEXT    NOT NULL,           -- uav|jet_uav|cruise|ballistic|kab|aviation|unknown
  raw_type     TEXT,                       -- as written: 'Реактивний БпЛА'
  count        INTEGER NOT NULL DEFAULT 1,
  oblast       TEXT,                       -- from the sticky heading ('Сумщина:')
  relation     TEXT,                       -- towards|past|through|changed_course|from
  from_name    TEXT,
  from_lat     REAL,
  from_lon     REAL,
  to_name      TEXT,
  to_lat       REAL,
  to_lon       REAL,
  course_deg   REAL,
  confidence   REAL,
  source       TEXT,                       -- rules|llm
  -- Denormalised from messages.posted_at: every map and bot query is "last 30 min".
  observed_at  INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_targets_observed_at ON targets(observed_at DESC);
CREATE INDEX ix_targets_message ON targets(message_id);

-- ─── users: created now, populated in step 3 ────────────────────────────────
-- lat/lon live here and nowhere else. Never logged, never sent anywhere.
CREATE TABLE users (
  id                  INTEGER PRIMARY KEY,
  chat_id             INTEGER NOT NULL UNIQUE,
  username            TEXT,
  lat                 REAL,
  lon                 REAL,
  location_kind       TEXT CHECK (location_kind IN ('static','live')),
  location_updated_at INTEGER,
  live_until          INTEGER,                    -- Telegram live_period expiry
  radius_km           REAL    NOT NULL DEFAULT 40,
  oblast              TEXT,                       -- for alert start / all-clear DMs
  is_active           INTEGER NOT NULL DEFAULT 1, -- /stop -> 0, settings preserved
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
) STRICT;
`,
  },
];

export function migrate(db: Database, onApplied?: (m: Migration) => void): number {
  const current = db.pragma('user_version', { simple: true }) as number;
  let version = current;

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    // SQLite DDL and user_version are both transactional, so a failed migration
    // leaves the database exactly as it was.
    db.transaction(() => {
      db.exec(m.sql);
      db.pragma(`user_version = ${m.version}`);
    })();
    version = m.version;
    onApplied?.(m);
  }

  return version;
}
