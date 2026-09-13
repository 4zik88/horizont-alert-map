# horizont-alert

Private air-target tracking for Ukraine. Closed tool for a handful of people — no
registration, no indexing, map reachable only via a secret token in the URL.

Polls the public HTML preview of three Telegram channels, extracts structured
targets (type, direction, settlement with coordinates), warns a closed list of users
by Telegram DM when a target is near them or heading their way, and serves a private
Leaflet PWA map.

## Sources

`@kpszsu`, `@KozakChornobay`, `@sectorv666` — read through `https://t.me/s/<channel>`,
the public web preview. No Telegram API, no account, no logged-in session. Nothing is
ever pulled from єППО or any closed system.

## Requirements

Node 22 LTS (pinned in `.nvmrc`). Newer Node will not match the `better-sqlite3`
prebuild that Railway uses:

```bash
fnm use          # or: nvm use
npm ci
```

## Running

```bash
cp .env.example .env
npm run build:toponyms      # one-off: builds the all-Ukraine gazetteer from OSM
npm run backfill            # one-off: ~500 messages per channel
npm run dev                 # poller + parser + /healthz, pretty logs
npm test
npm run typecheck
```

`npm run build:toponyms` must run before the parser is useful — it populates
`toponyms`/`toponym_forms` from Overpass and takes a few minutes. Re-run it whenever
you want fresher OSM data; it replaces the tables wholesale.

`npm run backfill` is safe to re-run — ingest is idempotent. Its real purpose is to
build a corpus of real messages to develop the step-2 parser against.

`GET /healthz` returns 200 only while every enabled channel has polled successfully
within five intervals, and 503 otherwise, so a poller that has silently stopped gets
restarted rather than lingering.

## Deploying to Railway

One service, one process. Two settings are not optional:

1. **Mount a Volume at `/data`** and set `DB_PATH=/data/app.db`. Railway's container
   filesystem is ephemeral — without the volume the database resets on every redeploy,
   and it will look like it is working.
2. **Set replicas to 1.** SQLite is single-writer and WAL is not safe across
   containers; two replicas means two pollers double-writing.

Also set `NODE_VERSION=22.23.2`. Build `npm ci && npm run build`, start `npm start`,
healthcheck `/healthz` (all in `railway.json`).

Railway volumes are not backed up. A nightly `VACUUM INTO` is worth adding before this
holds anything you would miss.

## Layout

```
src/config.ts          env schema; parse-or-exit, secrets never logged
src/logger.ts          pino + redaction of user coordinates and chat ids
src/sensitive.ts       impact / air-defence deny-list applied at ingest
src/db/migrations.ts   append-only schema, versioned by PRAGMA user_version
src/db/repo.ts         every SQL statement in the project
src/telegram/parsePage.ts   pure HTML -> messages; the tricky part
src/telegram/ingest.ts      messages -> DB, idempotent, edit-aware
src/telegram/poller.ts      the loop: jitter, backoff, gap-fill, shutdown
src/telegram/policy.ts      pure scheduling decisions, unit-tested
```

## Things the markup will do to you

Four behaviours of Telegram's preview HTML that the extractor depends on, each covered
by a test in `test/parsePage.test.ts`:

- **Reply previews reuse the message-text class.** A quoted post carries
  `js-message_reply_text`, a real body carries `js-message_text`. Message 58360 quotes
  58359, and the quoted text reads exactly like a live target report — attribute it to
  the wrong message and step 2 invents a target that does not exist.
- **Reactions are a sibling div.** A regex over the message block swallows `983👍66🫡`
  into the text; DOM-scoped extraction does not.
- **Line breaks are load-bearing.** Channels list one target per line under a sticky
  oblast heading, so `<br/>` must survive as `\n` or step 2 loses the grouping.
- **Post ids are not contiguous.** Deleted posts leave permanent holes, so nothing may
  treat a missing id as evidence that a message was missed. Gap-fill stops when a page
  yields no id newer than the cursor, never on contiguity.

`@KozakChornobay` also edits nearly every message as a target moves, so dedup is by
content hash, not by id alone: an edit rewrites the row and sets `parse_state` back to
`pending` so step 2 re-parses it.

Run `npm run fixtures:refresh` when a parser test starts failing — it re-downloads all
three fixtures so you can diff the markup.

## Parsing (step 2)

`parse_state = 'pending'` is a work queue. The worker takes a batch, runs the rules,
and falls back to Claude only for what the rules cannot resolve. Anything still
unresolved stays `unparsed` and the feed will show it as plain text — **a wrong pin
is worse than no pin**, so the parser never guesses a location.

### Why the gazetteer is the hard part

Channels never write a settlement in the nominative. They write "курсом на
**Охтирку**" (accusative), "в напрямку **Охтирки**" (genitive), "над
**Павлоградом**" (instrumental). Matching raw tokens against OSM names finds almost
nothing, so `morphology.ts` generates a superset of inflected forms for all ~30k
gazetteer entries and the lookup is an exact match on a normalised token.
Over-generation is deliberate: an unreal form is harmless unless it collides with
another real toponym, whereas a missing form silently loses a target.

Measured against the 1,497-message corpus: **67% of messages parse into targets**
(3,356 targets), 33% stay unparsed and go to the feed as text, and ~27% of messages
are the ones the Claude fallback would be asked about. Every extracted coordinate
falls inside Ukraine, and no target ever comes from a message flagged sensitive.

Re-measure after any parser change with `npm run coverage` — it prints the stats plus
a frequency-ranked list of destination phrases that still fail to resolve, which is
the worklist for the next rule worth writing.

### Shapes that needed explicit handling

Each of these was found by measuring against the real corpus, not by guessing:

- **A header city line.** "⚠ Дніпро" followed by "Реактивний БпЛА над містом!" — the
  second line's "містом" only means something if the first line is remembered.
- **Several targets on one line.** "реактивний над Одесою кружляє, реактивний на
  Суми" is two targets; merging them invented a 576 km Odesa→Sumy course. A clause
  starts a new target only when it carries its own type word or count, so "БпЛА повз
  Путивль, курсом на Охтирку" stays one target with a waypoint.
- **An oblast is usually context, not a destination.** "БпЛА на Житомирщині, змінив
  курс на Коростень" heads for Korosten. Oblasts are resolved first to disambiguate
  settlements, and stand in as a destination only when no settlement is named.
- **Course without a destination.** "Ударні БпЛА на півдні Сумщини, курс західний" —
  a compass bearing is read only when a course word is present, since "на півночі
  Чернігівщини" is a location and reading it as a heading points the arrow wrongly.
- **Slash alternatives.** "у напрямку Одеси/Лиманки" takes the first that resolves.

### Ambiguity

511 gazetteer names are ambiguous nationally (20 places called Олександрівка), and
215 stay ambiguous even within one oblast. Two things resolve it: the sticky oblast
heading a line sits under ("Сумщина:"), then a deterministic rank — settlement class
first, population second. The confidence stored on each target reflects how sure that
choice was.

### The LLM fallback

Off unless a provider key is set; the parser then runs rules-only and unresolved
messages simply go to the feed. Two providers ship behind one interface
(`LlmExtractor`), chosen by `LLM_PROVIDER` (`auto` picks Groq if `GROQ_API_KEY` is
set, else Anthropic, else nothing):

| Provider | Cost at this volume | Notes |
|---|---|---|
| **Groq** (default) | free tier | OpenAI-compatible endpoint, no SDK dependency |
| Anthropic | ~$3-10/month | structured outputs + prompt caching |

The model is **never trusted for coordinates**. It returns place *names*, resolved
through the same gazetteer as the rules, so a model that invents a town produces
nothing rather than a wrong pin. That guard is what makes a small free model a
reasonable choice: it can fail to help, but it cannot put a false marker on the map.
Every failure path — rate limit, retired model name, prose instead of JSON, network
error — returns no targets and leaves the message in the feed as text.

```bash
npm run llm:check      # lists the models your key can use, then runs the
                       # extractor over real unresolved messages from your DB
```

Run that first. Groq rotates its model catalogue, so the `GROQ_MODEL` default will
eventually 404 — `llm:check` prints exactly what your key accepts and flags a
mismatch. `LLM_BUDGET_PER_BATCH` caps calls per batch.

**Measured traffic:** 452 messages/day, of which ~27% (121/day) reach the fallback.

Whether the LLM earns its place is worth measuring rather than assuming: many
unresolved messages are not locatable target reports at all ("Загроза застосування
балістичного озброєння" names no place). If `llm:check` recovers little, the rules
are the better investment — they cost nothing per message and run in ~0.13 ms, which
matters on a path where an alert is only useful while it is still early.

Bump `PARSER_VERSION` in `src/parser/worker.ts` and requeue to re-parse the archive:

```sql
UPDATE messages SET parse_state = 'pending' WHERE parser_version < 2;
```

## The bot (step 3)

Long polling, not webhooks: one Railway service, one replica, so there is no public
callback to register. Commands are `/start`, `/radius <km>`, `/status`, `/stop`, plus
sending a location (static or live).

**Access is closed.** `ALLOWED_CHAT_IDS` / `ALLOWED_USERNAMES` in env; anyone else is
ignored entirely rather than refused, so the bot never confirms its own existence to
a stranger. An empty allowlist admits *nobody* — defaulting the other way would open
a private family tool to the internet on a config slip.

Live locations arrive as **edits** to the original message, not as new messages, so
the bot subscribes to `edited_message`. Without that a live location would be stored
once and never move again.

```bash
npm run bot:check   # verifies the token, shows the allowlist and registered users,
                    # then dry-runs recent targets to show who would be warned
```

### When someone gets a message

Two independent reasons, from `src/notify/proximity.ts` — pure and heavily tested,
because this is what makes a phone buzz at 03:00:

1. **In radius** — the target is within the user's own radius (default 40 km).
2. **Heading towards** — the course points at them and the target can plausibly
   arrive soon. The lookahead scales with how fast the type actually flies, so a
   cruise missile warns from much further out than a propeller drone.

False alarms are the real risk: for a group of ten, a bot that cries wolf gets muted
and is then worse than useless. Three guards, all tunable by env:

| Guard | Default | Why |
|---|---|---|
| `NOTIFY_MIN_CONFIDENCE` | 0.6 | a guessed location must never wake anyone |
| `NOTIFY_MAX_AGE_MS` | 30 min | an hour-old sighting is not actionable |
| `NOTIFY_COURSE_TOLERANCE_DEG` | 30 | narrow corridor, not a broad sweep |
| `NOTIFY_LEAD_MINUTES` | 25 | further out and the course will likely change |

Message format is the one the spec asked for:
`⚠️ БпЛА, курс на Охтирка, ~23 км от вас`

**Anti-spam** works on three levels. The spec's rule — one message per target per
user per 5 minutes — is enforced by the `notifications` ledger, which survives
restarts so a redeploy cannot re-alert everyone. Beyond that, a user's matches in one
pass are **combined into a single message** rather than sent separately (a mass attack
can match one person against dozens of targets, which the per-target rule does not
bound), and duplicate reports of the same target from different channels collapse to
one line, keeping the nearest reading.

Only what is actually delivered is recorded, so a failed send is retried rather than
silently swallowed by the cooldown.

### Oblast alerts

Separate from target warnings: air-raid start and all-clear for the oblast the user is
in, polled from alerts.in.ua. The user's oblast is derived from the nearest gazetteer
settlement, whose oblast tags come from official KATOTTH codes.

Only *transitions* are messaged, and the last state per oblast is persisted — without
that, every poll after a restart would look like a fresh alert. An oblast seen for the
first time is recorded silently, so a fresh database does not announce every alert
currently in progress. A truncated API response is ignored rather than read as "all
clear everywhere", which would fire a false all-clear to everyone at once.

Without `ALERTS_IN_UA_TOKEN` this part simply does not start.

## The map (step 4)

A single Leaflet page, no bundler, installable to a phone home screen. Reachable only
through a secret link.

```bash
npm run map:token         # prints a token and the one-time link
npm run build:boundaries  # oblast polygons for the alert overlay (one-off, resumable)
npm run build:icons       # PWA icons (already committed)
```

### Access

The token appears once, in the path (`/t/<token>`), is exchanged for an httpOnly
cookie, and the browser is redirected to a clean URL. A token left in a query string
leaks through the `Referer` header to every tile request and into Railway's access
logs; this way it never travels. Anything unauthorised gets a flat **404, never 403** —
a 403 would confirm that a valid link exists to be guessed. `/healthz` and
`robots.txt` stay public, and every response carries `noindex`.

### On the map

- **Alert polygons** shaded by level: red for a declared air-raid alert, yellow for a
  threat without one.
- **Target silhouettes** rotated to their course — a delta wing for a drone, a finned
  cylinder for a missile, a swept airframe for aircraft — each labelled with its type.
  A target with no known heading is drawn upright inside a dashed ring rather than
  pointed north, because inventing a direction is worse than admitting none.
- **Your position** from the browser, with your radius circle. It is computed in the
  page and **never sent to the server**; the last fix is remembered in `localStorage`
  so a reload does not blank it, and is discarded after 12 hours rather than drawing a
  stale circle.
- **The feed**, carrying parsed and unparsed messages alike — unresolved text appears
  as text, with no marker.
- Targets fade as they age and are gone by 30 minutes.

Tiles come from OpenStreetMap, darkened with a CSS filter rather than a dark-themed
provider, because every free dark basemap now requires an API key that can expire or
be revoked. Swap providers with `MAP_TILE_URL` / `MAP_TILE_ATTRIBUTION` /
`MAP_TILE_DARKEN` — no code change. Note that a `no-referrer` policy gets tile
requests rejected: the page sends `strict-origin`, which identifies it without
revealing any path.

### Where alert data comes from

Default is **alerts.in.ua's public situation report** (`/v3/alerts/active.md`) —
published for unauthenticated use, continuously updated, and the only keyless source
tested that separates the standing administrative alerts over occupied territory from
live ones. That distinction is not cosmetic: `alerts.com.ua` was measured reporting a
single alert (Luhansk, nominal) at a moment when eight oblasts were genuinely under
one. A third source, `vadimklimenko.com`, was rejected outright — its newest state
change was from 2022.

Set `ALERTS_IN_UA_TOKEN` to use their tokened API instead; `ALERTS_PROVIDER` forces a
specific source. A report whose shape is unrecognised yields *nothing* rather than an
empty alert map, since an empty map would read as a nationwide all-clear and fire a
false відбій to every user at once.

## Constraints

- **No air-defence positions, no impacts.** Messages matching the deny-list in
  `src/sensitive.ts` are flagged `is_sensitive` at ingest; they must never become map
  targets or reach the feed. The raw text is still stored so a false positive is
  recoverable — the flag is advisory and deliberately over-broad.
- **User coordinates live only in SQLite.** They are never logged: `src/logger.ts`
  redacts `lat`, `lon` and `chat_id` paths. The bot never echoes a location back
  either — it would then sit in Telegram's history and in any screenshot of the chat —
  and `bot:check` prints oblast and radius but never coordinates.
- Message text *is* logged at debug level. It is public channel content, and it is how
  the step-2 parser gets debugged against real traffic.

## Possible next steps

- Raion-level alert polygons (the report carries them; only oblasts are drawn today).
- Map: alert polygons, target markers with course arrows, mobile-first PWA.
