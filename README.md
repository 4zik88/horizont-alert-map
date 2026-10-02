# horizont-alert

Private air-target tracking for Ukraine. Closed tool for a handful of people — no
registration, no public surface at all.

Polls the public HTML preview of three Telegram channels, extracts structured targets
(type, direction, settlement with coordinates), and warns a closed list of users by
Telegram DM when a target is near them or heading their way. Air-raid alerts are
delivered per **raion**, from the location each user shared with the bot.

Telegram is the whole product. There was a Leaflet PWA map behind a secret link; it
was removed. It was a second surface to keep correct — its own auth, its own cookie-jar
behaviour on iOS, its own rendering rules — for information the bot already puts on the
phone that is already in the reader's hand. `git log` has it if it is ever wanted back.

## Sources

`@kpszsu`, `@KozakChornobay`, `@sectorv666` — read through `https://t.me/s/<channel>`,
the public web preview. No Telegram API, no account, no logged-in session. Nothing is
ever pulled from єППО or any closed system.

## Requirements

Node 22 LTS (pinned in `.nvmrc`). Newer Node will not match the `better-sqlite3`
prebuild that Railway uses:

```bash
fnm use          # or: nvm use
pnpm install
```

## Running

```bash
cp .env.example .env
pnpm build:toponyms      # one-off: builds the all-Ukraine gazetteer from OSM
pnpm backfill            # one-off: ~500 messages per channel
pnpm dev                 # poller + parser + /healthz, pretty logs
pnpm test
pnpm typecheck
```

`pnpm build:toponyms` must run before the parser is useful — it populates
`toponyms`/`toponym_forms` from Overpass and takes a few minutes. Re-run it whenever
you want fresher OSM data; it replaces the tables wholesale.

`pnpm backfill` is safe to re-run — ingest is idempotent. Its real purpose is to
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

Also set `NODE_VERSION=22.23.2`. Build `pnpm install --frozen-lockfile && pnpm build`,
start `pnpm start` (the compiled worker, run from the repo root),
healthcheck `/healthz` (all in `railway.json`).

Railway volumes are not backed up. A nightly `VACUUM INTO` is worth adding before this
holds anything you would miss.

## Layout

A pnpm monorepo. The packages are pure and storage-agnostic; the worker owns the
database, the network and the logger. `apps/api` and `apps/web` arrive with the map
stage — see `docs/stage-1-design.md`.

```
apps/worker/src/config.ts          env schema; parse-or-exit, secrets never logged
apps/worker/src/logger.ts          pino + redaction of user coordinates and chat ids
apps/worker/src/db/migrations.ts   append-only schema, versioned by PRAGMA user_version
apps/worker/src/db/repo.ts         every SQL statement in the project
apps/worker/src/db/gazetteer.ts    loads the toponym tables into the in-memory gazetteer
apps/worker/src/telegram/          ingest (idempotent, edit-aware), poller, policy
apps/worker/src/parser/worker.ts   the parse queue, the LLM budget and cache
apps/worker/src/parser/llm-*.ts    Groq and Anthropic providers
apps/worker/src/notify/            proximity (pure) and the notifier
apps/worker/src/alerts/watcher.ts  raion air-raid transitions -> DMs
apps/worker/src/http/server.ts     /healthz, and nothing else

packages/parser/src/parsePage.ts   pure HTML -> messages; the tricky part
packages/parser/src/sensitive.ts   impact / air-defence deny-list
packages/parser/src/message.ts     message -> targets: lost/stand-down lines, time, LLM gate
packages/parser/src/rules.ts       line -> targets; the other tricky part
packages/parser/src/gazetteer.ts   in-memory place lookup, ranking, fuzzy fallback
packages/parser/src/morphology.ts  inflected forms for every settlement name
packages/parser/src/extraction.ts  the LLM contract: schema, prompt, gazetteer grounding
packages/parser/src/time.ts        Kyiv clock times in messages -> instants

packages/geo/src/sphere.ts         bearing, distance, destination point
packages/geo/src/forecast.ts       10/20/30-minute projection, closest approach, ETA
packages/geo/src/raions.ts         point-in-polygon; which raion a reader is in (Node only)
packages/geo/data/                 gazetteer seed and raion polygons
```

Dev scripts run from the repo root with `--conditions=source`, so packages are used
straight from their TypeScript sources; `pnpm build` compiles them in dependency
order for production.

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

Run `pnpm fixtures:refresh` when a parser test starts failing — it re-downloads all
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

Measured against the 1,957-message corpus (October 2026): **80.9% of messages parse
into targets** (4,403 targets), 19.1% stay unparsed and go to the feed as text, and
14.2% are the ones the LLM fallback would be asked about. No target ever comes from a
message flagged sensitive — `parseMessage` refuses such text itself, not only the
worker.

The gazetteer is held in memory (`Gazetteer`), filled by whoever owns the database.
Forms are regenerated from each name at load time, so a morphology fix takes effect on
the next restart without rebuilding the toponym tables; restart after
`pnpm build:toponyms` to pick up new names.

Re-measure after any parser change with `pnpm coverage` — it prints the stats plus
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
- **An inline heading before a comma list.** "Сумщина: 8 біля Кролевця, 1 на
  Лебедин" is two groups. The heading used to hide the first clause's count, so the
  two merged into one target with an invented Krolevets→Lebedyn course.
- **A target reported gone.** "мінус по шахеду на Барабой", "На Тернопільщині -
  зник", "Не фіксується більше" name where a target *was*. Those lines are dropped;
  other lines of the same message still count.
- **A threat stood down.** "Одещина відбій тривоги", "локаційно чисто", "без
  фіксації" lines are dropped and never sent to the model.
- **Stated times.** "О 15:20 пуски…" and "[13.09.2026 16:25] Пуск…" are observation
  times, in Kyiv time. "якщо в бік Одещини +- 23:50" and "орієнтовно о 23:50" are
  forecast arrivals and are ignored.

### Misspellings

After every exact lookup fails, a fuzzy match (Levenshtein distance 1) may resolve a
misspelt name — but only under an oblast heading, only to a settlement in that oblast,
for words of five letters or more, with the first letter equal, and never by shrinking
a two-word name ("Чорний Кут" must not become "Чорна"). The brief allowed distance 2;
measured on the corpus every distance-2 hit and every hit without an oblast heading was
wrong ("Бугаз" near Odesa became "Бугас" in Donetsk oblast). `pnpm fuzzy:audit` lists
every fuzzy resolution in the corpus with its source line for review.

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
| Anthropic (`claude-haiku-4-5-20251001`) | ~$2-4/month at ~64 calls/day | structured outputs + prompt caching |

The model is **never trusted for coordinates**. It returns place *names*, resolved
through the same gazetteer as the rules, so a model that invents a town produces
nothing rather than a wrong pin. That guard is what makes a small free model a
reasonable choice: it can fail to help, but it cannot put a false marker on the map.
Every failure path — rate limit, retired model name, prose instead of JSON, network
error — returns no answer (`null`) and leaves the message in the feed as text.

**At most one call per message, and one per distinct text.** Answers are cached in
`llm_cache` by the message's content hash, so a re-parse or a reposted text reads the
stored answer. A message that has had its call never gets another, even when edited —
@KozakChornobay edits nearly every post as a target moves. A failed call is neither
cached nor counted, so the next parse of that message may try again.

```bash
pnpm llm:check      # lists the models your key can use, then runs the
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

Bump `PARSER_VERSION` in `apps/worker/src/parser/worker.ts` and requeue to re-parse the archive:

```sql
UPDATE messages SET parse_state = 'pending' WHERE parser_version < 9;
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
pnpm bot:check   # verifies the token, shows the allowlist and registered users,
                    # then dry-runs recent targets to show who would be warned
```

### When someone gets a message

Two independent reasons, from `apps/worker/src/notify/proximity.ts` — pure and heavily tested,
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

Message format:
`⚠️ Реактивний БпЛА — курс на Жашків (~106 км від вас) · до вас ~23 хв`

**Each number is tied to the thing it measures.** The earlier format printed one
distance for both, and which fact you got depended on why the alert had fired:
"курс на Жашків, ~201 км від вас" was the distance to the *drone*, printed under the
name of the *town*, which is 106 km away. The distance now sits in brackets against
the name it belongs to; the time-to-reach is labelled separately and appears only when
the target is actually pointed at the reader.

**Anti-spam** works on three levels.

The spec's rule — one message per target per user per 5 minutes — is enforced by the
`notice_ledger`, which survives restarts so a redeploy cannot re-alert everyone. It is
keyed on the *subject* as the reader would state it — this kind of thing, over this
place, for this reason — and not on the target row id. Keying it on the id meant it
never suppressed anything at all: three channels reporting one drone produce three
rows, every fresh message about that drone produces another, and each new id missed
the ledger. "БпЛА — Козятин, ~1 км від вас" arrived five times in fourteen minutes.

Past the cooldown a warning still has to have *changed* — the distance must have moved
by 25% — or it waits out a 20-minute repeat window. A drone circling one town produces
the identical sentence every poll, and repeating it is how a reader learns to ignore
the bot.

Finally, a user's matches in one pass are **combined into a single message** rather
than sent separately, and duplicate reports of the same target from different channels
collapse to one line, keeping the nearest reading.

Only what is actually delivered is recorded, so a failed send is retried rather than
silently swallowed by the cooldown. The ledger is pruned by age rather than by
cascade, since it is no longer anchored to a target row.

### Raion alerts

Separate from target warnings: air-raid start and all-clear for the **raion** the user
is in, polled from alerts.in.ua — which declares them per raion in the first place.

An oblast is roughly the size of a small country. Announcing per oblast meant a reader
in Kozyatyn heard about anything happening anywhere in Vinnytsia oblast, and — the
dangerous direction — could get an all-clear while their own raion was still under
warning.

The user's raion is a point-in-polygon lookup against `packages/geo/data/raions.geojson` (161
polygons, `packages/geo/src/raions.ts`), done once when they share a location rather than on
every poll. The oblast is still derived from the nearest gazetteer settlement, and is
the fallback for a point inside no polygon — Kyiv city, which is its own administrative
unit, so the oblast-level message is the correct one there anyway.

A warning naming only hromadas or a city resolves to no raion polygon. That warning is
still real, so the whole oblast is treated as warned: the error falls toward telling
someone rather than leaving them unwarned.

Only *transitions* are messaged, and the last state per raion is persisted — without
that, every poll after a restart would look like a fresh alert. A raion seen for the
first time is recorded silently, so a fresh database does not announce every alert
currently in progress. A truncated API response is ignored rather than read as "all
clear everywhere", which would fire a false all-clear to everyone at once.

Without `ALERTS_IN_UA_TOKEN` this part simply does not start.

## Where alert data comes from

Default is **alerts.in.ua's public situation report** (`/v3/alerts/active.md`) —
published for unauthenticated use, continuously updated, and the only keyless source
tested that separates the standing administrative alerts over occupied territory from
live ones. That distinction is not cosmetic: `alerts.com.ua` was measured reporting a
single alert (Luhansk, nominal) at a moment when eight oblasts were genuinely under
one. A third source, `vadimklimenko.com`, was rejected outright — its newest state
change was from 2022.

Set `ALERTS_IN_UA_TOKEN` to use their tokened API instead; `ALERTS_PROVIDER` forces a
specific source. A report whose shape is unrecognised yields *nothing* rather than an
empty alert set, since an empty set would read as a nationwide all-clear and fire a
false відбій to every user at once.

## Constraints

- **No air-defence positions, no impacts.** Messages matching the deny-list in
  `packages/parser/src/sensitive.ts` are flagged `is_sensitive` at ingest; they must never become
  targets or reach anyone. The raw text is still stored so a false positive is
  recoverable — the flag is advisory and deliberately over-broad.
- **User coordinates live only in SQLite.** They are never logged: `apps/worker/src/logger.ts`
  redacts `lat`, `lon` and `chat_id` paths. The bot never echoes a location back
  either — it would then sit in Telegram's history and in any screenshot of the chat —
  and `bot:check` prints oblast and radius but never coordinates.
- Message text *is* logged at debug level. It is public channel content, and it is how
  the step-2 parser gets debugged against real traffic.

## Possible next steps

- **Hromada-level warnings.** Sub-raion alerts (the Nikopol area is the usual case)
  name no polygon, so the whole oblast is treated as warned. A hromada → raion table
  would narrow those to the right raion.
- **Quiet hours.** Nothing currently distinguishes 03:00 from 15:00.
