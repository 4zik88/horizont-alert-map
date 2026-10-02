# Stage 1 — database schema and realtime contract

Status: **approved 2026-10-02**, all six proposals, with D4 amended: Groq stays the
default fallback provider; Anthropic uses Haiku when selected.

## 0. Decisions that need a yes/no before stage 2

| # | Brief says | Current repo does | Proposal |
|---|------------|-------------------|----------|
| D1 | New pnpm monorepo, Fastify, Postgres | Single npm package, SQLite, Telegram-only, map removed on purpose | Build the monorepo, **port** proven modules instead of rewriting them (see §1). |
| D2 | Node 20 | Node 22 | **Node 22 LTS.** Node 20 went end-of-life on 2026-04-30 and gets no security fixes. |
| D3 | Alerts by oblast / hromada | Alerts by **raion**, after oblast-level alerts proved misleading | Store all three levels. Bot keys on raion, falls back to oblast. Map fills raions, outlines oblasts. |
| D4 | LLM fallback = Claude Haiku | Groq by default, Anthropic optional | **Approved as amended:** Groq stays the default; Anthropic defaults to `claude-haiku-4-5-20251001`. Strict JSON schema, at most one call per message, cached by content hash. |
| D5 | Tests include «збито» as a false positive | Air-defence results and impacts are flagged sensitive and never shown | Keep that rule. «збито» creates no target and **does not close a track**. Tracks end by staleness only. |
| D6 | Gazetteer of ~2000 settlements | All-Ukraine OSM gazetteer with generated case forms | Keep the bigger one. Fuzzy match only as a last resort after exact form lookup. **Implemented at distance 1, inside a known oblast only:** on the stored corpus every distance-2 hit was wrong. |

## 1. Layout

```
apps/api       Fastify: auth, REST snapshot/history, WebSocket, static PWA
apps/worker    pollers (t.me/s, alerts.in.ua), parser, tracker, bot, notifier
apps/web       Vite + vanilla TS + MapLibre, service worker
packages/parser  ported from src/parser + src/telegram/parsePage + src/sensitive
packages/geo     gazetteer, raion/oblast polygons, bearing/distance, extrapolation
packages/contract  shared TS types + zod schemas for REST and WS (this doc, in code)
```

The bot lives in the worker so only one process ever calls `getUpdates`.
Worker → api realtime goes through Postgres `LISTEN/NOTIFY`. No Redis.

## 2. Schema (PostgreSQL 16)

All times are `timestamptz`. Coordinates are plain `double precision` lat/lng.
PostGIS is not needed at this scale. Migrations are append-only SQL files.

```sql
-- ── sources ────────────────────────────────────────────────────────────────
CREATE TABLE channels (
  channel              text PRIMARY KEY,           -- 'kpszsu'
  last_message_id      bigint NOT NULL DEFAULT 0,
  last_success_at      timestamptz,
  last_error           text,
  consecutive_failures int NOT NULL DEFAULT 0,
  enabled              boolean NOT NULL DEFAULT true
);

CREATE TABLE messages (
  id             bigserial PRIMARY KEY,
  channel        text NOT NULL REFERENCES channels,
  message_id     bigint NOT NULL,
  posted_at      timestamptz NOT NULL,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  edited_at      timestamptz,
  text           text NOT NULL DEFAULT '',
  content_hash   text NOT NULL,                    -- sha1(normalised text); edits change it
  is_sensitive   boolean NOT NULL DEFAULT false,   -- impacts / AD: never a target, never shown
  parse_state    text NOT NULL DEFAULT 'pending'
                 CHECK (parse_state IN ('pending','parsed','unparsed','skipped','error')),
  parser_version int,
  UNIQUE (channel, message_id)                     -- the dedup key
);
CREATE INDEX ON messages (posted_at DESC);
CREATE INDEX ON messages (posted_at) WHERE parse_state = 'pending';

-- One LLM call per distinct text, ever. Edits that restore old text hit the cache.
CREATE TABLE llm_cache (
  content_hash  text PRIMARY KEY,
  model         text NOT NULL,
  response      jsonb NOT NULL,                    -- validated against the schema
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- ── geography (seeded) ──────────────────────────────────────────────────────
CREATE TABLE regions (
  id         text PRIMARY KEY,                     -- alerts.in.ua uid as text
  level      text NOT NULL CHECK (level IN ('oblast','raion','hromada')),
  name       text NOT NULL,
  parent_id  text REFERENCES regions,
  oblast_id  text NOT NULL                         -- denormalised for "my oblast" filter
);
-- Polygons ship as static GeoJSON to the client; the worker keeps its own copy in memory.

CREATE TABLE toponyms (                            -- ported as is
  id bigserial PRIMARY KEY, name text NOT NULL, name_norm text NOT NULL,
  oblast_id text, place text NOT NULL, population int NOT NULL DEFAULT 0,
  lat double precision NOT NULL, lng double precision NOT NULL, rank int NOT NULL DEFAULT 0
);
CREATE TABLE toponym_forms (form text NOT NULL, toponym_id bigint NOT NULL
  REFERENCES toponyms ON DELETE CASCADE, PRIMARY KEY (form, toponym_id));

-- ── alerts ───────────────────────────────────────────────────────────────────
-- An interval per alert. Open alert = ended_at IS NULL. History for the timeline
-- is "intervals overlapping [t-3h, t]".
CREATE TABLE alerts (
  id          bigserial PRIMARY KEY,
  region_id   text NOT NULL REFERENCES regions,
  level       text NOT NULL CHECK (level IN ('oblast','raion','hromada')),
  alert_type  text NOT NULL DEFAULT 'air_raid',
  started_at  timestamptz NOT NULL,
  ended_at    timestamptz,
  CHECK (ended_at IS NULL OR ended_at >= started_at)
);
CREATE UNIQUE INDEX ON alerts (region_id, alert_type) WHERE ended_at IS NULL;
CREATE INDEX ON alerts (started_at DESC);
CREATE INDEX ON alerts (ended_at DESC);

-- ── targets and tracks ──────────────────────────────────────────────────────
CREATE TABLE target_tracks (
  id              bigserial PRIMARY KEY,
  type            text NOT NULL,                   -- shahed|jet_uav|cruise|ballistic|kab|recon_uav|aviation|unknown
  first_seen_at   timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL,
  last_lat        double precision NOT NULL,
  last_lng        double precision NOT NULL,
  heading_deg     double precision,                -- smoothed over the last observations
  speed_kmh       double precision,                -- typical for the type, not measured
  count           int NOT NULL DEFAULT 1,
  confidence      real NOT NULL,                   -- min of the last observation and link score
  closed_at       timestamptz                      -- set at last_seen_at + 25 min
);
CREATE INDEX ON target_tracks (last_seen_at DESC);

CREATE TABLE targets (                             -- one observation
  id             bigserial PRIMARY KEY,
  message_id     bigint NOT NULL REFERENCES messages ON DELETE CASCADE,
  seq            int NOT NULL DEFAULT 0,           -- nth target in a multi-target message
  track_id       bigint REFERENCES target_tracks ON DELETE SET NULL,
  type           text NOT NULL,
  raw_type       text,
  count          int NOT NULL DEFAULT 1,
  relation       text NOT NULL,                    -- over|towards|through|past|from|launch
  place_name     text,
  lat            double precision NOT NULL,        -- where it is (or the launch site)
  lng            double precision NOT NULL,
  to_name        text,                             -- "курсом на X": a destination, not a position
  to_lat         double precision,
  to_lng         double precision,
  heading_deg    double precision,                 -- null for ballistic without a stated direction
  speed_kmh      double precision,                 -- typical: shahed 165, cruise 800, ballistic null
  confidence     real NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source         text NOT NULL CHECK (source IN ('rules','llm')),
  observed_at    timestamptz NOT NULL,             -- time in the text, else posted_at
  UNIQUE (message_id, seq)
);
CREATE INDEX ON targets (observed_at DESC);
CREATE INDEX ON targets (track_id);
```

**Track linking rule** (worker, after each parse). A new observation joins the open
track that has the same type and the best score, when all of these hold:

- distance ≤ type speed × elapsed time × 1.5 + 15 km;
- bearing from the track's last point to the new point is within 60° of the track heading
  (skipped when the track has no heading yet);
- the track's last observation is younger than 25 min.

Otherwise a new track starts. An edited message deletes its old observations and
re-runs linking for the affected tracks.

**Ballistic** observations get a point and an optional heading, never a speed or a
forecast vector.

## 3. Users, access, notifications

```sql
CREATE TABLE users (
  telegram_user_id  bigint PRIMARY KEY,           -- the allowlist; seeded from env ALLOWLIST
  display_name      text,
  is_active         boolean NOT NULL DEFAULT true,
  lat               double precision,             -- never logged, never sent over WS
  lng               double precision,
  location_at       timestamptz,
  raion_id          text REFERENCES regions,
  oblast_id         text REFERENCES regions,
  radius_km         real NOT NULL DEFAULT 40,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE login_tokens (                       -- one-time magic links
  token_hash   text PRIMARY KEY,                   -- sha256; the raw token only exists in the DM
  user_id      bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  expires_at   timestamptz NOT NULL,               -- +10 min
  used_at      timestamptz
);

CREATE TABLE sessions (
  id_hash      text PRIMARY KEY,                   -- sha256 of the cookie value
  user_id      bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL                -- +90 days, sliding
);

CREATE TABLE push_subscriptions (
  endpoint     text PRIMARY KEY,
  user_id      bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  p256dh       text NOT NULL,
  auth         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Anti-spam, keyed on what the reader sees (lesson from the current notice_ledger).
CREATE TABLE notice_ledger (
  user_id      bigint NOT NULL REFERENCES users ON DELETE CASCADE,
  subject      text NOT NULL,                      -- 'alert:<region>:start' | 'track:<id>'
  channel      text NOT NULL CHECK (channel IN ('telegram','webpush')),
  eta_min      real,
  sent_at      timestamptz NOT NULL,
  PRIMARY KEY (user_id, subject, channel)
);
```

Login flow: `/start` in the bot checks the allowlist and DMs
`https://<host>/auth?t=<token>`. `GET /auth` marks the token used, sets an
`HttpOnly; Secure; SameSite=Lax` cookie and redirects to `/`. Everything else
returns 401 without a valid session, including the WebSocket upgrade.

**Privacy rule.** The server never sends a user's coordinates to any client. In the PWA,
"time to reach you" is computed on the device from browser geolocation, which never
leaves the phone. The bot computes it server-side from the location shared with the bot.

## 4. Realtime contract

Transport: **WebSocket** at `/ws`, JSON text frames. SSE would also work, but
WebSocket lets the client send `resume` without a second request.

### Event log

```sql
CREATE TABLE events (
  seq         bigserial PRIMARY KEY,               -- the diff cursor
  at          timestamptz NOT NULL DEFAULT now(),
  type        text NOT NULL,
  payload     jsonb NOT NULL
);
CREATE INDEX ON events (at);                       -- pruned after 6 h
```

The worker writes domain rows and the matching `events` row in one transaction, then
`NOTIFY events, '<seq>'`. The api reads new rows by seq and fans them out. A client that
reconnects with a known `seq` gets exactly what it missed, from the same table.

### Client → server

```ts
type ClientMsg =
  | { t: 'resume'; seq: number | null }   // null or too old -> server sends a snapshot
  | { t: 'ping' };
```

### Server → client

```ts
type ServerMsg =
  | { t: 'snapshot'; seq: number; at: string; alerts: Alert[]; tracks: Track[];
      sources: SourceStatus[] }
  | { t: 'event'; seq: number; at: string; e: DomainEvent }
  | { t: 'pong' };

type DomainEvent =
  | { type: 'alert.started';  alert: Alert }
  | { type: 'alert.ended';    alertId: number; endedAt: string }
  | { type: 'track.observed'; track: Track; observation: Observation }  // new or extended
  | { type: 'track.revised';  track: Track; removedObservationIds: number[] } // message edited
  | { type: 'track.stale';    trackId: number; at: string }             // 25 min without news
  | { type: 'source.status';  source: SourceStatus };

interface Alert {
  id: number; regionId: string; level: 'oblast'|'raion'|'hromada';
  alertType: string; startedAt: string; endedAt: string | null;
}
interface Observation {
  id: number; trackId: number; type: TargetType; count: number;
  relation: 'over'|'towards'|'through'|'past'|'from'|'launch';
  lat: number; lng: number; placeName: string | null;
  toName: string | null; toLat: number | null; toLng: number | null;
  headingDeg: number | null; speedKmh: number | null;
  confidence: number; source: 'rules'|'llm';
  observedAt: string; channel: string; messageId: number;   // links back to t.me/<channel>/<id>
}
interface Track {
  id: number; type: TargetType; count: number;
  lastLat: number; lastLng: number; headingDeg: number | null; speedKmh: number | null;
  confidence: number; firstSeenAt: string; lastSeenAt: string; stale: boolean;
  path: { lat: number; lng: number; at: string }[];   // last 60 min, oldest first
}
interface SourceStatus {
  source: 'kpszsu'|'kozakchornobay'|'sectorv666'|'alerts.in.ua';
  lastSuccessAt: string | null; healthy: boolean;
}
```

Rules:

- `seq` is strictly increasing. On a gap the client sends `resume` with its last seq.
- If the requested seq is older than the event log keeps, the server answers with a snapshot.
- Forecast vectors are **not** sent. The client draws them from `lastLat/lastLng`,
  `headingDeg`, `speedKmh` and `lastSeenAt`, and hides them once `lastSeenAt` is older
  than 25 min. That keeps the "approximate" logic in one place.
- Server heartbeat: a WebSocket ping every 25 s. Railway's proxy drops idle sockets.

### REST (all behind the session cookie)

```
GET /api/snapshot              same body as the snapshot frame
GET /api/history?at=<iso>      state at a moment in the last 3 h, for the timeline
GET /api/regions.geojson       simplified raion + oblast borders, long cache, ETag
POST /api/push/subscribe       Web Push subscription
GET /auth?t=<token>            magic link
```

`/api/history` rebuilds state from `alerts` intervals and `targets` with
`observed_at ≤ at`, so the timeline does not depend on the 6-hour event log.

## 5. Retention

| Table | Kept |
|-------|------|
| events | 6 h |
| targets, target_tracks | 7 days |
| messages | 30 days, matching the current retention job |
| alerts | 90 days |
| llm_cache | 30 days |
