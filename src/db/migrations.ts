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
  {
    version: 2,
    name: 'toponyms',
    sql: `
-- ─── toponyms: the all-Ukraine gazetteer, built by scripts/build-toponyms.ts ──
CREATE TABLE toponyms (
  id         INTEGER PRIMARY KEY,
  osm_id     INTEGER,
  name       TEXT    NOT NULL,           -- nominative, as OSM spells it
  name_norm  TEXT    NOT NULL,           -- normalise(name); for exact-name lookups
  oblast     TEXT,                       -- oblast key, from the KATOTTH/KOATUU prefix
  place      TEXT    NOT NULL,           -- city | town | village | hamlet
  population INTEGER NOT NULL DEFAULT 0,
  lat        REAL    NOT NULL,
  lon        REAL    NOT NULL,
  -- Precomputed tie-breaker: 511 gazetteer names are ambiguous nationally and 215
  -- stay ambiguous even once the oblast is known, so a deterministic ranking is
  -- required rather than "first row wins".
  rank       INTEGER NOT NULL DEFAULT 0
) STRICT;

CREATE INDEX ix_toponyms_name_norm ON toponyms(name_norm);
CREATE INDEX ix_toponyms_oblast ON toponyms(oblast);

-- ─── toponym_forms: every inflected form -> toponym ─────────────────────────
-- Channels write settlements in the accusative or genitive ("курсом на Охтирку"),
-- never the nominative, so lookups happen against generated forms.
CREATE TABLE toponym_forms (
  form       TEXT    NOT NULL,
  toponym_id INTEGER NOT NULL REFERENCES toponyms(id) ON DELETE CASCADE,
  PRIMARY KEY (form, toponym_id)
) STRICT, WITHOUT ROWID;
`,
  },
  {
    version: 3,
    name: 'notifications',
    sql: `
-- ─── notifications: the anti-spam ledger ────────────────────────────────────
-- One row per (user, target) actually delivered. The spec's rule is at most one
-- message about a given target to a given user per 5 minutes; this is what enforces
-- it, and it survives restarts so a redeploy cannot re-alert everyone.
CREATE TABLE notifications (
  chat_id   INTEGER NOT NULL,
  target_id INTEGER NOT NULL REFERENCES targets(id) ON DELETE CASCADE,
  sent_at   INTEGER NOT NULL,
  PRIMARY KEY (chat_id, target_id)
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_notifications_sent_at ON notifications(sent_at);

-- ─── oblast_alerts: air-raid state per oblast ───────────────────────────────
-- Only transitions are worth a message, so the last known state is persisted;
-- without it every poll of alerts.in.ua would look like a fresh alert start.
CREATE TABLE oblast_alerts (
  oblast     TEXT    PRIMARY KEY,
  active     INTEGER NOT NULL DEFAULT 0,
  changed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

-- ─── app_state: small durable key/value ─────────────────────────────────────
-- Holds the Telegram getUpdates offset and the notifier's target cursor. Both must
-- outlive a restart: a lost offset replays old commands, and a lost target cursor
-- re-notifies about targets that have already been sent.
CREATE TABLE app_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`,
  },
  {
    version: 4,
    name: 'alert_levels',
    sql: `
-- Alert severity, not just on/off: several oblasts run a yellow level for drone
-- threat and a red one for missile threat, and the map paints them differently.
ALTER TABLE oblast_alerts ADD COLUMN level TEXT NOT NULL DEFAULT 'none';
UPDATE oblast_alerts SET level = CASE WHEN active = 1 THEN 'full' ELSE 'none' END;
`,
  },
  {
    version: 5,
    name: 'alert_areas',
    sql: `
-- The individual raions under warning, as a JSON array of normalised names.
-- Alerts are declared per raion; shading a whole oblast because one raion is warned
-- overstates the emergency across an area the size of a small country.
ALTER TABLE oblast_alerts ADD COLUMN areas TEXT NOT NULL DEFAULT '[]';
`,
  },
  {
    version: 6,
    name: 'notice_ledger',
    sql: `
-- ─── notice_ledger: anti-spam, keyed on what the reader sees ─────────────────
-- Replaces the target-id ledger, which never suppressed anything. Three channels
-- reporting one drone produce three target rows, and every fresh message about the
-- same drone produces another — so each was a new id, the cooldown never matched, and
-- "БпЛА — Козятин, ~1 км від вас" arrived five times in fourteen minutes.
--
-- The key is the subject as the reader would state it: this kind of thing, over this
-- place, for this reason. distance_km is kept so an unchanged warning can be held
-- back longer than one that has actually moved.
CREATE TABLE notice_ledger (
  chat_id     INTEGER NOT NULL,
  subject     TEXT    NOT NULL,
  distance_km REAL    NOT NULL,
  sent_at     INTEGER NOT NULL,
  PRIMARY KEY (chat_id, subject)
) STRICT, WITHOUT ROWID;

CREATE INDEX ix_notice_ledger_sent_at ON notice_ledger(sent_at);

-- The old table cascaded from targets, which is how it was pruned. The new one has no
-- such anchor and is pruned by age instead; see src/maintenance/retention.ts.
DROP TABLE notifications;
`,
  },
  {
    version: 7,
    name: 'user_raion',
    sql: `
-- Alerts are declared per raion, and a raion is about an hour's drive across, so an
-- oblast-wide "Повітряна тривога — Вінницька обл." mostly announced an emergency
-- somewhere the reader was not. Derived by point-in-polygon from the coordinates
-- already held, and null outside every polygon (Kyiv city), where the oblast-level
-- message is the correct one anyway.
ALTER TABLE users ADD COLUMN raion TEXT;

-- Per-raion alert state, for the same reason oblast_alerts exists: only transitions
-- are worth a message, and without the last known state every poll looks like a
-- fresh alert start.
CREATE TABLE raion_alerts (
  raion      TEXT    PRIMARY KEY,
  oblast     TEXT    NOT NULL,
  active     INTEGER NOT NULL DEFAULT 0,
  changed_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX ix_raion_alerts_oblast ON raion_alerts(oblast);
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
