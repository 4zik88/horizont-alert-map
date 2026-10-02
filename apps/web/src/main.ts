import './style.css';
import { DISCLAIMER, type Me, type ServerMessage, type Snapshot } from '@horizont/contract';
import { HttpError, fetchHistory, fetchMe, fetchRegions, fetchSnapshot, login, logout } from './api.js';
import { currentSubscription, disablePush, enablePush, pushAvailability, pushEnvironment, pushInfo } from './push.js';
import { Connection, wsUrl, type ConnState } from './connection.js';
import { DEMO_ME, demoHistory, demoSnapshot, startDemoStream } from './demo.js';
import { esc, hhmm, oblastName } from './format.js';
import { AlertMap } from './map.js';
import { nearMe, type LatLon } from './nearMe.js';
import { loadMe, loadPrefs, loadSnapshot, saveMe, savePrefs, saveSnapshot, type Prefs } from './persist.js';
import { filterToOblast, regionAlertStates, type RegionCollection } from './regions.js';
import { sourcesSummary, sliderToTime, timeToSlider, SLIDER_MAX } from './status.js';
import {
  emptyState,
  fromSnapshot,
  liveView,
  prune,
  reduce,
  snapshotView,
  toSnapshot,
  type LiveState,
  type View,
} from './store.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const DEMO = new URLSearchParams(location.search).get('demo') === '1';

/* ── logged out ──────────────────────────────────────────────────────── */

let appStarted = false;

function showLogin(): void {
  $('boot').hidden = true;
  $('app').hidden = true;
  $('login').hidden = false;
  $('login-disclaimer').textContent = DISCLAIMER;
  const form = $<HTMLFormElement>('login-form');
  const input = $<HTMLInputElement>('login-code');
  const err = $('login-error');
  const submit = $<HTMLButtonElement>('login-submit');
  form.onsubmit = async (ev) => {
    ev.preventDefault();
    const code = input.value.trim();
    if (!code) {
      input.focus();
      return;
    }
    err.hidden = true;
    submit.disabled = true;
    const result = await login(code);
    submit.disabled = false;
    if (result === 'ok') {
      if (appStarted) {
        location.reload();
        return;
      }
      void boot();
      return;
    }
    err.textContent =
      result === 'invalid'
        ? 'Код невірний або застарів'
        : result === 'rate-limited'
          ? 'Забагато спроб, зачекайте хвилину'
          : 'Немає зʼєднання із сервером, спробуйте ще раз';
    err.hidden = false;
  };
}

/* ── boot ────────────────────────────────────────────────────────────── */

async function boot(): Promise<void> {
  if (DEMO) {
    startApp(DEMO_ME, false);
    return;
  }
  try {
    const me = await fetchMe();
    saveMe(me);
    startApp(me, false);
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) {
      saveMe(null);
      saveSnapshot(null);
      showLogin();
      return;
    }
    // Network failure: carry on with what this device remembers.
    startApp(loadMe() ?? { name: null, oblast: null }, true);
  }
}

/* ── the app ─────────────────────────────────────────────────────────── */

function startApp(me: Me, offlineBoot: boolean): void {
  appStarted = true;
  $('boot').hidden = true;
  $('login').hidden = true;
  $('app').hidden = false;
  $('disclaimer').textContent = DISCLAIMER;

  const prefs: Prefs = loadPrefs();
  const map = new AlertMap($('map'));
  let regions: RegionCollection | null = null;
  let state: LiveState = emptyState();
  /** True while what is on screen came from storage, not from the server. */
  let fromCache = false;
  let conn: ConnState = DEMO ? 'live' : offlineBoot ? 'offline' : 'connecting';
  let connection: Connection | null = null;
  let stopDemo: (() => void) | null = null;
  let history: { at: number; snapshot: Snapshot | null } | null = null;
  let myPos: LatLon | null = null;
  let watchId: number | null = null;
  let flewToMe = false;

  const cached = DEMO ? null : loadSnapshot();
  if (cached) {
    state = fromSnapshot(cached);
    fromCache = true;
  }

  /* ── rendering ── */

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  function persistSoon(): void {
    if (DEMO || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      saveSnapshot(toSnapshot(state));
    }, 2000);
  }

  function currentView(now: number): { view: View; viewNow: number } {
    let view: View;
    let viewNow = now;
    if (history) {
      view = history.snapshot ? snapshotView(history.snapshot) : { at: history.at, alerts: [], tracks: [], sources: [] };
      viewNow = history.at;
    } else {
      view = liveView(state, now);
    }
    if (prefs.onlyMyOblast && me.oblast) view = filterToOblast(view, me.oblast, regions);
    return { view, viewNow };
  }

  function render(): void {
    const now = Date.now();
    const { view, viewNow } = currentView(now);
    void map.setAlertStates(regionAlertStates(view.alerts));
    void map.setTracks(view.tracks, viewNow);
    renderStatus(view);
    renderNear(now);
  }

  function renderStatus(view: View): void {
    const c = $('conn');
    const label: Record<ConnState, string> = {
      connecting: 'зʼєднання…',
      live: DEMO ? 'демо' : 'наживо',
      reconnecting: 'перепідключення…',
      offline: 'офлайн',
    };
    c.textContent = label[conn];
    c.className = `pill ${conn === 'live' ? 'ok' : conn === 'offline' ? 'bad' : 'warn'}`;

    const latest = history ? state.at : view.at;
    $('updated').textContent = latest ? `оновлено ${hhmm(latest)}` : 'немає даних';

    const src = sourcesSummary(state.sources.size ? [...state.sources.values()] : view.sources);
    const s = $('sources');
    s.textContent = src.short;
    s.title = src.detail;
    s.className = `pill pill-btn ${src.level}`;

    const off = $('offline-banner');
    if ((fromCache || conn === 'offline') && !history && !DEMO) {
      off.textContent = state.at ? `офлайн — стан на ${hhmm(state.at)}` : 'офлайн — даних ще немає';
      off.hidden = false;
    } else off.hidden = true;

    const hb = $('history-banner');
    if (history) {
      $('history-text').textContent =
        `Перегляд на ${hhmm(history.at)}` + (history.snapshot ? '' : ' · завантаження…');
      hb.hidden = false;
    } else hb.hidden = true;
  }

  function renderNear(now: number): void {
    const panel = $('near');
    if (!prefs.locate || history) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const list = $('near-list');
    if (!myPos) {
      list.innerHTML = '<li class="empty">Визначаємо ваше місце…</li>';
      return;
    }
    const items = nearMe(liveView(state, now).tracks, myPos, now);
    if (items.length === 0) {
      list.innerHTML = '<li class="empty">Поруч нічого не повідомляють</li>';
      return;
    }
    list.innerHTML = items
      .map(
        (i) =>
          `<li class="${i.kind === 'destination' ? 'dest' : 'appr'}"><button type="button" data-track="${i.trackId}">${esc(i.text)}</button></li>`,
      )
      .join('');
  }

  $('near-list').addEventListener('click', (ev) => {
    const btn = (ev.target as HTMLElement).closest<HTMLElement>('[data-track]');
    if (!btn) return;
    const t = state.tracks.get(Number(btn.dataset.track));
    if (t) map.flyTo(t.last);
  });

  /* ── toast ── */

  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  function toast(text: string): void {
    const el = $('toast');
    el.textContent = text;
    el.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (el.hidden = true), 3500);
  }

  /* ── live data ── */

  function onMessage(msg: ServerMessage): void {
    const r = reduce(state, msg);
    if (r.kind === 'gap') {
      connection?.resume();
      return;
    }
    if (r.kind !== 'applied') return;
    state = prune(r.state, Date.now());
    fromCache = false;
    persistSoon();
    render();
  }

  function setConn(s: ConnState): void {
    conn = s;
    render();
  }

  if (DEMO) {
    state = fromSnapshot(demoSnapshot(Date.now()));
    stopDemo = startDemoStream(toSnapshot(state), onMessage);
  } else {
    fetchSnapshot()
      .then((snap) => {
        // A snapshot older than what the socket already gave us is ignored.
        if (snap.seq >= state.seq || fromCache) {
          state = fromSnapshot(snap);
          fromCache = false;
          persistSoon();
          render();
        }
      })
      .catch((e: unknown) => {
        if (e instanceof HttpError && e.status === 401) showLogin();
      })
      .finally(() => {
        connection = new Connection({
          url: wsUrl(),
          lastSeq: () => (state.seq > 0 ? state.seq : null),
          onMessage,
          onState: setConn,
        });
        connection.start();
      });
  }

  fetchRegions()
    .then(async (r) => {
      regions = r;
      await map.setRegions(r);
      if (prefs.onlyMyOblast && me.oblast) map.fitOblast(me.oblast);
      render();
    })
    .catch(() => toast('Не вдалося завантажити межі областей'));

  setInterval(render, 30_000);

  /* ── only my oblast ── */

  const btnOblast = $<HTMLButtonElement>('btn-oblast');
  if (!me.oblast) {
    btnOblast.setAttribute('aria-disabled', 'true');
    btnOblast.classList.add('is-disabled');
    btnOblast.disabled = true;
    btnOblast.title = 'надішліть боту свою локацію';
    btnOblast.textContent = 'Моя область: надішліть боту свою локацію';
    prefs.onlyMyOblast = false;
  } else {
    btnOblast.title = oblastName(me.oblast);
  }
  btnOblast.setAttribute('aria-pressed', String(prefs.onlyMyOblast));
  btnOblast.addEventListener('click', () => {
    if (!me.oblast) return;
    prefs.onlyMyOblast = !prefs.onlyMyOblast;
    savePrefs(prefs);
    btnOblast.setAttribute('aria-pressed', String(prefs.onlyMyOblast));
    if (prefs.onlyMyOblast) map.fitOblast(me.oblast);
    else map.fitUkraine();
    render();
  });

  /* ── geolocation (stays on this device) ── */

  const btnLocate = $<HTMLButtonElement>('btn-locate');
  function startLocating(): void {
    if (!('geolocation' in navigator)) {
      toast('Геолокація недоступна на цьому пристрої');
      return;
    }
    prefs.locate = true;
    savePrefs(prefs);
    btnLocate.setAttribute('aria-pressed', 'true');
    watchId = navigator.geolocation.watchPosition(
      (p) => {
        myPos = { lat: p.coords.latitude, lon: p.coords.longitude };
        map.setMe(myPos);
        if (!flewToMe) {
          flewToMe = true;
          map.flyTo(myPos);
        }
        render();
      },
      (err) => {
        toast(err.code === err.PERMISSION_DENIED ? 'Доступ до геолокації заборонено' : 'Не вдалося визначити місце');
        stopLocating();
      },
      { enableHighAccuracy: false, maximumAge: 60_000, timeout: 20_000 },
    );
    render();
  }
  function stopLocating(): void {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    myPos = null;
    flewToMe = false;
    map.setMe(null);
    prefs.locate = false;
    savePrefs(prefs);
    btnLocate.setAttribute('aria-pressed', 'false');
    render();
  }
  btnLocate.addEventListener('click', () => (prefs.locate ? stopLocating() : startLocating()));
  if (prefs.locate) startLocating();

  /* ── web push: the same warnings as the bot, in this browser ── */

  const btnPush = $<HTMLButtonElement>('btn-push');
  async function setupPush(): Promise<void> {
    if (DEMO) return;
    let key: string | null = null;
    try {
      key = (await pushInfo()).publicKey;
    } catch {
      return;
    }
    const avail = pushAvailability(pushEnvironment(key));
    if (!avail.show) return;
    btnPush.hidden = false;
    if (!avail.usable) {
      btnPush.addEventListener('click', () => toast(avail.hint));
      return;
    }
    const on = (await currentSubscription().catch(() => null)) !== null;
    btnPush.setAttribute('aria-pressed', String(on));
    btnPush.addEventListener('click', async () => {
      if (btnPush.getAttribute('aria-pressed') === 'true') {
        await disablePush();
        btnPush.setAttribute('aria-pressed', 'false');
        toast('Сповіщення в цьому браузері вимкнено');
        return;
      }
      const result = await enablePush(key!);
      if (result === 'ok') {
        btnPush.setAttribute('aria-pressed', 'true');
        // Warnings are decided from the location shared with the bot, never this one.
        toast(me.oblast
          ? 'Сповіщення увімкнено — ті самі попередження, що й у боті'
          : 'Сповіщення увімкнено. Щоб вони приходили, надішліть боту свою локацію');
      } else {
        toast(result === 'denied' ? 'Сповіщення не дозволено' : 'Не вдалося увімкнути сповіщення');
      }
    });
  }
  void setupPush();

  /* ── sources ── */

  $('sources').addEventListener('click', () => toast($('sources').title));

  /* ── timeline ── */

  const slider = $<HTMLInputElement>('slider');
  const sliderLabel = $('slider-label');
  const btnLive = $<HTMLButtonElement>('btn-live');
  let historyTimer: ReturnType<typeof setTimeout> | null = null;
  let historyAbort: AbortController | null = null;

  function goLive(): void {
    if (historyTimer) clearTimeout(historyTimer);
    historyAbort?.abort();
    history = null;
    slider.value = String(SLIDER_MAX);
    sliderLabel.textContent = 'зараз';
    btnLive.setAttribute('aria-pressed', 'true');
    render();
  }

  function scrubTo(value: number): void {
    if (value >= SLIDER_MAX) {
      goLive();
      return;
    }
    const at = sliderToTime(value, Date.now());
    sliderLabel.textContent = hhmm(at);
    btnLive.setAttribute('aria-pressed', 'false');
    history = { at, snapshot: history?.snapshot ?? null };
    render();
    if (historyTimer) clearTimeout(historyTimer);
    historyTimer = setTimeout(() => void loadHistory(at), 350);
  }

  async function loadHistory(at: number): Promise<void> {
    historyAbort?.abort();
    const ctrl = new AbortController();
    historyAbort = ctrl;
    try {
      const snap = DEMO ? demoHistory(Date.now(), at) : await fetchHistory(at, ctrl.signal);
      if (ctrl.signal.aborted || !history || history.at !== at) return;
      history = { at, snapshot: snap };
      render();
    } catch (e) {
      if (ctrl.signal.aborted) return;
      toast('Історія недоступна (потрібне зʼєднання)');
      if (history?.at === at) history = { at, snapshot: null };
      render();
    }
  }

  slider.addEventListener('input', () => scrubTo(Number(slider.value)));
  btnLive.addEventListener('click', goLive);
  $('btn-live-banner').addEventListener('click', goLive);
  slider.min = '0';
  slider.max = String(SLIDER_MAX);
  slider.value = String(timeToSlider(Date.now(), Date.now()));

  /* ── logout ── */

  const btnLogout = $<HTMLButtonElement>('btn-logout');
  btnLogout.hidden = DEMO;
  btnLogout.addEventListener('click', async () => {
    try {
      // Before the session ends: this browser must not keep receiving the previous
      // user's warnings.
      await disablePush().catch(() => undefined);
      await logout();
    } catch {
      toast('Немає зʼєднання — вийти не вдалося');
      return;
    }
    connection?.stop();
    stopDemo?.();
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    saveSnapshot(null);
    saveMe(null);
    try {
      await caches.delete('horizont-api-v1');
    } catch {
      /* no Cache Storage: nothing cached */
    }
    showLogin();
  });

  render();
}

/* ── service worker ──────────────────────────────────────────────────── */

if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* the app works without it, just not offline */
    });
  });
}

void boot();
