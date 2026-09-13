# horizont-alert

Private air-target tracking for Ukraine. Closed tool for a handful of people — no
registration, no indexing, map reachable only via a secret token in the URL.

**Step 1 (this commit): ingest.** Polls the public HTML preview of three Telegram
channels and stores raw messages in SQLite. No parsing, no bot, no map yet.

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
npm run dev                 # poller + /healthz, pretty logs
npm run backfill            # one-off: ~500 messages per channel
npm test
npm run typecheck
```

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

2. Parser: target type, direction, settlements against an all-Ukraine toponym
   dictionary; ambiguous messages to Claude for strict-JSON extraction.
3. Telegram bot: `/start`, location, `/radius`, `/stop`, proximity DMs with anti-spam.
4. Map: alert polygons, target markers with course arrows, mobile-first PWA.
