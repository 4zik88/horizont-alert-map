# horizont-alert

Private air-target tracking for Ukraine. Closed tool for a handful of people — no
registration, no indexing, map reachable only via a secret token in the URL.

**Steps 1-2 done: ingest + parse.** Polls the public HTML preview of three Telegram
channels, stores raw messages in SQLite, and extracts structured targets (type,
direction, settlement with coordinates). No bot and no map yet.

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

### The Claude fallback

Off unless `ANTHROPIC_API_KEY` is set; the parser then runs rules-only and unresolved
messages simply go to the feed. When enabled it uses structured outputs
(`output_config.format` + Zod) so the response is schema-valid by construction, with
the system prompt cached across calls. `LLM_BUDGET_PER_BATCH` caps spend per batch.
The model is **never trusted for coordinates** — it returns place *names*, which are
then resolved through the same gazetteer as the rules.

Bump `PARSER_VERSION` in `src/parser/worker.ts` and requeue to re-parse the archive:

```sql
UPDATE messages SET parse_state = 'pending' WHERE parser_version < 2;
```

## Constraints

- **No air-defence positions, no impacts.** Messages matching the deny-list in
  `src/sensitive.ts` are flagged `is_sensitive` at ingest; they must never become map
  targets or reach the feed. The raw text is still stored so a false positive is
  recoverable — the flag is advisory and deliberately over-broad.
- **User coordinates live only in SQLite.** They are never logged: `src/logger.ts`
  redacts `lat`, `lon` and `chat_id` paths, wired up before any user row exists.
- Message text *is* logged at debug level. It is public channel content, and it is how
  the step-2 parser gets debugged against real traffic.

## Next

3. Telegram bot: `/start`, location, `/radius`, `/stop`, proximity DMs with anti-spam.
4. Map: alert polygons, target markers with course arrows, mobile-first PWA.
