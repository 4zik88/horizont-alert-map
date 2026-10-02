import type { Sql } from './sql.js';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Append-only. Never edit a migration that has been deployed — add a new one.
 *
 * Version 1 is the SQLite schema ported as it stood at its version 8, so the worker's
 * queries keep their shape: times stay epoch ms (`bigint`), flags stay 0/1 integers.
 * Version 2 adds what the map needs (tracks, alert intervals, the event log) and what
 * map access needs (login tokens, sessions, push subscriptions).
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'ported_sqlite_schema',
    sql: `
CREATE TABLE messages (
  id             bigserial PRIMARY KEY,
  channel        text    NOT NULL,
  message_id     bigint  NOT NULL,
  posted_at      bigint  NOT NULL,
  fetched_at     bigint  NOT NULL,
  text           text    NOT NULL DEFAULT '',
  text_html      text,
  content_hash   text    NOT NULL,
  has_media      integer NOT NULL DEFAULT 0,
  edited_at      bigint,
  is_sensitive   integer NOT NULL DEFAULT 0,
  parse_state    text    NOT NULL DEFAULT 'pending'
                 CHECK (parse_state IN ('pending','parsed','unparsed','skipped','error')),
  parsed_at      bigint,
  parser_version integer,
  llm_called_at  bigint
);
CREATE UNIQUE INDEX ux_messages_channel_post ON messages(channel, message_id);
CREATE INDEX ix_messages_posted_at ON messages(posted_at DESC);
CREATE INDEX ix_messages_parse_queue ON messages(posted_at) WHERE parse_state = 'pending';

CREATE TABLE channel_state (
  channel              text    PRIMARY KEY,
  last_message_id      bigint  NOT NULL DEFAULT 0,
  oldest_message_id    bigint  NOT NULL DEFAULT 0,
  last_success_at      bigint,
  last_error           text,
  last_error_at        bigint,
  consecutive_failures integer NOT NULL DEFAULT 0,
  enabled              integer NOT NULL DEFAULT 1
);

CREATE TABLE targets (
  id           bigserial PRIMARY KEY,
  message_id   bigint  NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  seq          integer NOT NULL DEFAULT 0,
  type         text    NOT NULL,
  raw_type     text,
  count        integer NOT NULL DEFAULT 1,
  oblast       text,
  relation     text,
  from_name    text,
  from_lat     double precision,
  from_lon     double precision,
  to_name      text,
  to_lat       double precision,
  to_lon       double precision,
  course_deg   double precision,
  confidence   double precision,
  source       text,
  observed_at  bigint  NOT NULL,
  created_at   bigint  NOT NULL
);
CREATE INDEX ix_targets_observed_at ON targets(observed_at DESC);
CREATE INDEX ix_targets_message ON targets(message_id);

-- lat/lon live here and nowhere else. Never logged, never sent to a browser.
CREATE TABLE users (
  id                  bigserial PRIMARY KEY,
  chat_id             bigint  NOT NULL UNIQUE,
  username            text,
  lat                 double precision,
  lon                 double precision,
  location_kind       text CHECK (location_kind IN ('static','live')),
  location_updated_at bigint,
  live_until          bigint,
  radius_km           double precision NOT NULL DEFAULT 40,
  oblast              text,
  raion               text,
  is_active           integer NOT NULL DEFAULT 1,
  created_at          bigint  NOT NULL,
  updated_at          bigint  NOT NULL
);

CREATE TABLE toponyms (
  id         bigserial PRIMARY KEY,
  osm_id     bigint,
  name       text    NOT NULL,
  name_norm  text    NOT NULL,
  oblast     text,
  place      text    NOT NULL,
  population integer NOT NULL DEFAULT 0,
  lat        double precision NOT NULL,
  lon        double precision NOT NULL,
  rank       bigint  NOT NULL DEFAULT 0
);
CREATE INDEX ix_toponyms_name_norm ON toponyms(name_norm);
CREATE INDEX ix_toponyms_oblast ON toponyms(oblast);

CREATE TABLE toponym_forms (
  form       text   NOT NULL,
  toponym_id bigint NOT NULL REFERENCES toponyms(id) ON DELETE CASCADE,
  PRIMARY KEY (form, toponym_id)
);

CREATE TABLE notice_ledger (
  chat_id     bigint NOT NULL,
  subject     text   NOT NULL,
  distance_km double precision NOT NULL,
  sent_at     bigint NOT NULL,
  PRIMARY KEY (chat_id, subject)
);
CREATE INDEX ix_notice_ledger_sent_at ON notice_ledger(sent_at);

CREATE TABLE oblast_alerts (
  oblast     text    PRIMARY KEY,
  active     integer NOT NULL DEFAULT 0,
  changed_at bigint  NOT NULL,
  updated_at bigint  NOT NULL,
  level      text    NOT NULL DEFAULT 'none',
  areas      text    NOT NULL DEFAULT '[]'
);

CREATE TABLE raion_alerts (
  raion      text    PRIMARY KEY,
  oblast     text    NOT NULL,
  active     integer NOT NULL DEFAULT 0,
  changed_at bigint  NOT NULL,
  updated_at bigint  NOT NULL
);
CREATE INDEX ix_raion_alerts_oblast ON raion_alerts(oblast);

CREATE TABLE app_state (
  key        text   PRIMARY KEY,
  value      text   NOT NULL,
  updated_at bigint NOT NULL
);

CREATE TABLE llm_cache (
  content_hash text   PRIMARY KEY,
  provider     text   NOT NULL,
  targets      text   NOT NULL,
  created_at   bigint NOT NULL
);
CREATE INDEX ix_llm_cache_created_at ON llm_cache(created_at);
`,
  },
  {
    version: 2,
    name: 'map_and_access',
    sql: `
-- ─── tracks: consecutive sightings of one group, joined ────────────────────
CREATE TABLE target_tracks (
  id            bigserial PRIMARY KEY,
  type          text    NOT NULL,
  count         integer NOT NULL DEFAULT 1,
  first_seen_at bigint  NOT NULL,
  last_seen_at  bigint  NOT NULL,
  last_lat      double precision NOT NULL,
  last_lon      double precision NOT NULL,
  heading_deg   double precision,
  confidence    double precision NOT NULL,
  -- position | destination | launch, of the latest sighting; see PointKind.
  last_kind     text    NOT NULL DEFAULT 'position'
);
CREATE INDEX ix_target_tracks_last_seen ON target_tracks(last_seen_at DESC);

ALTER TABLE targets ADD COLUMN track_id bigint REFERENCES target_tracks(id) ON DELETE SET NULL;
CREATE INDEX ix_targets_track ON targets(track_id);

-- ─── alerts: one interval per alert, for the map and its timeline ──────────
-- Open alert = ended_at IS NULL. The timeline asks "which intervals overlap t".
CREATE TABLE alerts (
  id          bigserial PRIMARY KEY,
  region_id   text    NOT NULL,
  oblast      text    NOT NULL,
  level       text    NOT NULL CHECK (level IN ('oblast','raion','hromada')),
  severity    text    NOT NULL CHECK (severity IN ('full','partial')),
  areas       text[]  NOT NULL DEFAULT '{}',
  alert_type  text    NOT NULL DEFAULT 'air_raid',
  started_at  bigint  NOT NULL,
  ended_at    bigint,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX ux_alerts_open ON alerts(region_id, alert_type) WHERE ended_at IS NULL;
CREATE INDEX ix_alerts_started ON alerts(started_at DESC);
CREATE INDEX ix_alerts_ended ON alerts(ended_at DESC);

-- ─── events: the realtime diff log ───────────────────────────────────────
-- Written in the same transaction as the change it describes, then NOTIFY 'events'.
-- A reconnecting client resumes from its last seq. Pruned after six hours.
CREATE TABLE events (
  seq      bigserial PRIMARY KEY,
  at       bigint NOT NULL,
  type     text   NOT NULL,
  payload  jsonb  NOT NULL
);
CREATE INDEX ix_events_at ON events(at);

-- ─── map access ──────────────────────────────────────────────────────────
-- Only hashes are stored. The raw token exists only in the bot's DM; the raw session
-- id only in the reader's cookie.
-- A login carries two secrets for the same grant: a link, and a short code typed into
-- an installed iOS app, whose cookie jar a link opened in Safari never reaches.
CREATE TABLE login_tokens (
  token_hash  text   PRIMARY KEY,
  code_hash   text   NOT NULL UNIQUE,
  chat_id     bigint NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
  created_at  bigint NOT NULL,
  expires_at  bigint NOT NULL,
  used_at     bigint
);

CREATE TABLE sessions (
  id_hash      text   PRIMARY KEY,
  chat_id      bigint NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
  created_at   bigint NOT NULL,
  last_seen_at bigint NOT NULL,
  expires_at   bigint NOT NULL
);
CREATE INDEX ix_sessions_chat ON sessions(chat_id);

CREATE TABLE push_subscriptions (
  endpoint    text   PRIMARY KEY,
  chat_id     bigint NOT NULL REFERENCES users(chat_id) ON DELETE CASCADE,
  p256dh      text   NOT NULL,
  auth        text   NOT NULL,
  created_at  bigint NOT NULL
);
`,
  },
  {
    version: 3,
    name: 'target_area',
    sql: `
-- The named place is a whole region resolved to its centre, not a point. Such a
-- target is drawn as an area: never projected forward and never given an arrival time.
ALTER TABLE targets ADD COLUMN to_area integer NOT NULL DEFAULT 0;

-- Rows parsed before the flag existed: a destination that is exactly an oblast name.
-- Kyiv is left out; it is a city, small enough to be a point.
UPDATE targets SET to_area = 1 WHERE to_name IN (
  'Вінницька','Волинська','Дніпропетровська','Донецька','Житомирська','Закарпатська',
  'Запорізька','Івано-Франківська','Київська','Кіровоградська','Луганська','Львівська',
  'Миколаївська','Одеська','Полтавська','Рівненська','Сумська','Тернопільська',
  'Харківська','Херсонська','Хмельницька','Черкаська','Чернівецька','Чернігівська','Крим'
);
`,
  },
];

/**
 * Apply pending migrations. Safe to call from the API and the worker at the same
 * time: an advisory lock serialises them, and each migration is its own transaction.
 */
export async function migrate(sql: Sql, onApplied?: (m: Migration) => void): Promise<number> {
  await sql.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    integer PRIMARY KEY,
      name       text    NOT NULL,
      applied_at bigint  NOT NULL
    )
  `);

  let current = 0;
  for (const m of MIGRATIONS) {
    const applied = await sql.transaction(async (tx) => {
      await tx.query(`SELECT pg_advisory_xact_lock(hashtext('horizont-migrate'))`);
      const done = await tx.query('SELECT 1 FROM schema_migrations WHERE version = $1', [m.version]);
      if (done.rows.length > 0) return false;
      await tx.exec(m.sql);
      await tx.query(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES ($1, $2, $3)',
        [m.version, m.name, Date.now()],
      );
      return true;
    });
    if (applied) onApplied?.(m);
    current = m.version;
  }
  return current;
}
