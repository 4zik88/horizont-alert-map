import assert from 'node:assert/strict';
import { after, beforeEach, describe, test } from 'node:test';
import { destination } from '@horizont/geo';
import {
  alertsAt, eventsAfter, kindOf, publishMessage, syncAlerts, trackIdsOfMessage, tracksAt,
  type DesiredAlert, type Sql,
} from '../src/index.js';
import { testDb, truncateAll } from '../src/testing.js';

const MIN = 60_000;
const T0 = Date.UTC(2026, 9, 2, 20, 0);
const KYIV = { lat: 50.45, lon: 30.52 };
const speed = { speedKmh: (t: string) => (t === 'cruise' ? 800 : 180) };

const sql: Sql = await testDb();
after(() => sql.close());
beforeEach(() => truncateAll(sql));

let post = 1;
async function message(at: number): Promise<number> {
  const { rows } = await sql.query<{ id: number }>(
    `INSERT INTO messages (channel, message_id, posted_at, fetched_at, content_hash, text)
     VALUES ('kpszsu', $1, $2, $2, $3, 'x') RETURNING id`,
    [post++, at, `h${post}`],
  );
  return rows[0]!.id;
}

interface T { area?: boolean; type?: string; relation?: string; to?: { lat: number; lon: number } | null; from?: { lat: number; lon: number } | null; course?: number | null; at: number; count?: number; seq?: number }
async function target(messageId: number, t: T): Promise<void> {
  const to = t.to === undefined ? KYIV : t.to;
  await sql.query(
    `INSERT INTO targets (message_id, seq, type, count, relation, to_name, to_lat, to_lon,
                          from_name, from_lat, from_lon, course_deg, confidence, source, observed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, 'X', $6, $7, $8, $9, $10, $11, 0.9, 'rules', $12, $12)`,
    [messageId, t.seq ?? 0, t.type ?? 'uav', t.count ?? 1, t.relation ?? 'over', to?.lat ?? null, to?.lon ?? null,
     t.from ? 'Y' : null, t.from?.lat ?? null, t.from?.lon ?? null, t.course ?? null, t.at],
  );
  if (t.area) await sql.query('UPDATE targets SET to_area = 1 WHERE message_id = $1', [messageId]);
}

describe('what a relation means on the map', () => {
  test('only over/past/through are positions; towards is a destination; from draws nothing', () => {
    assert.equal(kindOf('over'), 'position');
    assert.equal(kindOf('past'), 'position');
    assert.equal(kindOf('through'), 'position');
    assert.equal(kindOf('towards'), 'destination');
    assert.equal(kindOf('launch'), 'launch');
    assert.equal(kindOf('from'), null);
  });
});

describe('publishMessage', () => {
  test('a sighting starts a track and announces it', async () => {
    const m = await message(T0);
    await target(m, { at: T0, course: 270 });
    const { tracks } = await publishMessage(sql, m, { ...speed, now: T0 });
    assert.equal(tracks.length, 1);

    const events = await eventsAfter(sql, 0);
    assert.equal(events.length, 1);
    assert.equal(events[0]!.e.type, 'track.observed');
    const view = (await tracksAt(sql, T0))[0]!;
    assert.equal(view.last.kind, 'position');
    assert.equal(view.last.speedKmh, 180);
    assert.equal(view.last.headingDeg, 270);
    assert.equal(view.last.channel, 'kpszsu');
  });

  test('a second channel reporting the group further along joins the same track', async () => {
    const m1 = await message(T0);
    await target(m1, { at: T0, course: 270 });
    await publishMessage(sql, m1, { ...speed, now: T0 });

    const m2 = await message(T0 + 10 * MIN);
    await target(m2, { at: T0 + 10 * MIN, to: destination(KYIV.lat, KYIV.lon, 270, 30) });
    await publishMessage(sql, m2, { ...speed, now: T0 + 10 * MIN });

    const views = await tracksAt(sql, T0 + 10 * MIN);
    assert.equal(views.length, 1);
    assert.equal(views[0]!.path.length, 2);
  });

  test('a destination keeps its kind and never gets a projection speed', async () => {
    const m = await message(T0);
    await target(m, { at: T0, relation: 'towards' });
    await publishMessage(sql, m, { ...speed, now: T0 });
    const view = (await tracksAt(sql, T0))[0]!;
    assert.equal(view.last.kind, 'destination');
    assert.equal(view.last.speedKmh, null);
  });

  test('a whole-oblast position keeps its kind but is never projected', async () => {
    const m = await message(T0);
    await target(m, { at: T0, course: 180, area: true, type: 'jet_uav' });
    await publishMessage(sql, m, { ...speed, now: T0 });
    const last = (await tracksAt(sql, T0))[0]!.last;
    assert.equal(last.kind, 'position');
    assert.equal(last.area, true);
    assert.equal(last.speedKmh, null);
  });

  test('a launch is drawn at its site, and a bare origin is not drawn', async () => {
    const m = await message(T0);
    await target(m, { at: T0, relation: 'launch', to: null, from: { lat: 46.0, lon: 38.1 } });
    await target(m, { at: T0, relation: 'from', to: null, from: { lat: 48.0, lon: 37.8 }, seq: 1 });
    await publishMessage(sql, m, { ...speed, now: T0 });
    const views = await tracksAt(sql, T0);
    assert.equal(views.length, 1);
    assert.equal(views[0]!.last.kind, 'launch');
    assert.equal(views[0]!.last.lat, 46.0);
  });

  test('an edit that moves the only sighting deletes the old track', async () => {
    const m = await message(T0);
    await target(m, { at: T0, course: 0 });
    await publishMessage(sql, m, { ...speed, now: T0 });
    const before = await trackIdsOfMessage(sql, m);

    await sql.query('DELETE FROM targets WHERE message_id = $1', [m]);
    await target(m, { at: T0, type: 'cruise', to: destination(KYIV.lat, KYIV.lon, 180, 300) });
    await publishMessage(sql, m, { ...speed, now: T0 + MIN, previousTrackIds: before });

    const types = (await eventsAfter(sql, 0)).map((e) => e.e.type);
    assert.deepEqual(types, ['track.observed', 'track.observed', 'track.revised']);
    const views = await tracksAt(sql, T0 + MIN);
    assert.equal(views.length, 1);
    assert.equal(views[0]!.type, 'cruise');
  });

  test('tracks older than an hour are not drawn', async () => {
    const m = await message(T0);
    await target(m, { at: T0 });
    await publishMessage(sql, m, { ...speed, now: T0 });
    assert.equal((await tracksAt(sql, T0 + 59 * MIN)).length, 1);
    assert.equal((await tracksAt(sql, T0 + 61 * MIN)).length, 0);
    assert.equal((await tracksAt(sql, T0 - MIN)).length, 0, 'not before it was seen');
  });
});

describe('syncAlerts', () => {
  const raion = (id: string, severity: DesiredAlert['severity'] = 'full'): DesiredAlert => ({
    regionId: `raion:sumska:${id}`, oblast: 'sumska', level: 'raion', severity, areas: [],
  });

  test('opens, keeps, changes and closes intervals, with events', async () => {
    assert.deepEqual(await syncAlerts(sql, [raion('сумський'), raion('охтирський')], T0), { started: 2, ended: 0 });
    assert.deepEqual(await syncAlerts(sql, [raion('сумський'), raion('охтирський')], T0 + MIN), { started: 0, ended: 0 });
    assert.deepEqual(await syncAlerts(sql, [raion('сумський', 'partial')], T0 + 2 * MIN), { started: 1, ended: 2 });

    assert.equal((await alertsAt(sql, T0 + 30_000)).length, 2, 'history: both were on');
    const now = await alertsAt(sql, T0 + 3 * MIN);
    assert.equal(now.length, 1);
    assert.equal(now[0]!.severity, 'partial');
    assert.deepEqual((await eventsAfter(sql, 0)).map((e) => e.e.type),
      ['alert.started', 'alert.started', 'alert.ended', 'alert.ended', 'alert.started']);
  });

  test('hromada areas are compared regardless of order', async () => {
    const h = (areas: string[]): DesiredAlert => ({ regionId: 'oblast:sumska', oblast: 'sumska', level: 'hromada', severity: 'partial', areas });
    await syncAlerts(sql, [h(['b', 'a'])], T0);
    assert.deepEqual(await syncAlerts(sql, [h(['a', 'b'])], T0 + MIN), { started: 0, ended: 0 });
  });
});
