/*
 * Horizont map.
 *
 * No bundler and no framework — one file the browser runs as-is, which keeps the
 * whole page a couple of hundred kilobytes including Leaflet.
 *
 * Two rules this file must respect:
 *  - The browser's geolocation never leaves the device. "Near me" is computed here;
 *    nothing about the viewer's position is ever sent to the server.
 *  - Messages the parser could not resolve appear in the feed as plain text and get
 *    no marker. A wrong pin is worse than no pin.
 */
'use strict';

const POLL_MS = 10000;
const FADE_MS = 30 * 60 * 1000; // targets older than this are spent, per the spec
/*
 * Launches stay legible longer than targets. A drone reported over a town 30 minutes
 * ago has moved on; a launch from Crimea 30 minutes ago is still the reason something
 * is in the air, and fading it to 12% made the marker effectively invisible for most
 * of the window the server keeps sending it.
 */
const LAUNCH_FADE_MS = 60 * 60 * 1000;
const REDRAW_MS = 15000;        // re-age markers without refetching

/*
 * Target iconography.
 *
 * Every silhouette is drawn nose-up in a 24x24 box, so rotating by the course in
 * degrees points it the right way with no offset maths. Shapes are deliberately
 * distinguishable in a glance at thumbnail size: a delta wing reads as a drone, a
 * finned cylinder as a missile, a swept airframe as aircraft. A coloured dot cannot
 * tell you whether something is a Shahed or a guided bomb, and that is the first
 * thing you want to know.
 */
const TYPES = {
  uav: {
    color: '#e3b341', label: 'БпЛА', short: 'БпЛА',
    /*
     * Shahed-136 from above: swept delta, a narrow fuselage running past the
     * trailing edge, the pusher propeller across the tail, and the winglets that
     * make the airframe recognisable. A plain triangle read as an arrowhead — a
     * direction indicator rather than the thing that is flying.
     */
    path:
      'M12 2 L20.6 17.6 L3.4 17.6 Z' +
      'M19.4 15.6 L22.3 20.4 L18.6 18.6 Z' +
      'M4.6 15.6 L1.7 20.4 L5.4 18.6 Z' +
      'M10.9 5.4 L13.1 5.4 L13.1 20.4 L10.9 20.4 Z' +
      'M8.4 20 L15.6 20 L15.6 21.3 L8.4 21.3 Z',
  },
  jet_uav: {
    color: '#f0883e', label: 'Реактивний БпЛА', short: 'Реакт. БпЛА',
    // The same airframe, sharper: a narrower wing and a jet nozzle instead of the
    // propeller, so the faster variant is distinguishable at a glance.
    path:
      'M12 1.6 L18.8 17.4 L5.2 17.4 Z' +
      'M17.8 15.4 L20.6 20.2 L17 18.4 Z' +
      'M6.2 15.4 L3.4 20.2 L7 18.4 Z' +
      'M10.7 4.6 L13.3 4.6 L13.3 20.6 L10.7 20.6 Z' +
      'M10.2 20.6 L13.8 20.6 L13.1 22.6 L10.9 22.6 Z',
  },
  cruise: {
    color: '#f85149', label: 'Крилата ракета', short: 'Ракета',
    // Slim body with mid-body wings and tail fins.
    path: 'M12 1 C13.6 4 14.2 8 14.2 11 L19 15 L14.2 13.6 L14.2 18 L16 22 L12 20 L8 22 L9.8 18 L9.8 13.6 L5 15 L9.8 11 C9.8 8 10.4 4 12 1 Z',
  },
  ballistic: {
    color: '#ff7b72', label: 'Балістика', short: 'Балістика',
    // Narrow spike: no wings, just a cone and tail flare.
    path: 'M12 1 L14.6 11 L14.6 17 L16.4 22 L12 19.6 L7.6 22 L9.4 17 L9.4 11 Z',
  },
  kab: {
    color: '#bc8cff', label: 'КАБ', short: 'КАБ',
    // Bomb body with a boxed tail unit.
    path: 'M12 1 C14.4 5 15.4 9 15.4 13 L15.4 16 L18 16 L18 22 L6 22 L6 16 L8.6 16 L8.6 13 C8.6 9 9.6 5 12 1 Z',
  },
  aviation: {
    color: '#79c0ff', label: 'Авіація', short: 'Авіація',
    // Classic swept airframe.
    path: 'M12 1 L13.4 8 L22 14.5 L22 16.6 L13.4 13.6 L13.4 19 L16.4 21.4 L16.4 23 L12 21.6 L7.6 23 L7.6 21.4 L10.6 19 L10.6 13.6 L2 16.6 L2 14.5 L10.6 8 Z',
  },
  recon: {
    color: '#8b949e', label: 'Розвідник', short: 'Розвідник',
    // Long straight wings — a loitering surveillance planform.
    path: 'M12 3 L13.2 10 L22 12 L22 13.8 L13.2 12.8 L13.2 18 L15.6 21 L8.4 21 L10.8 18 L10.8 12.8 L2 13.8 L2 12 L10.8 10 Z',
  },
  unknown: {
    color: '#8b949e', label: 'Ціль', short: 'Ціль',
    path: 'M12 2 L19 20 L12 16 L5 20 Z',
  },
};

/*
 * Launch marker.
 *
 * A launch site is the one thing on this map that is NOT where a threat currently
 * is — it is where one started, minutes or hours ago. So it must not look like a
 * target at any size: no silhouette, no heading, a hollow burst radiating from a
 * point instead. The label says "Пуск" rather than the weapon, for the same reason.
 */
const LAUNCH_COLOR = '#ff9bd2';

function launchIcon(spec, count) {
  const badge = count > 1 ? `<s>${count}</s>` : '';

  return L.divIcon({
    className: 'tgt',
    html:
      `<span class="tgt-mark launch" style="--c:${LAUNCH_COLOR}">` +
      '<svg viewBox="0 0 24 24" width="24" height="24">' +
      // Rays outward from the centre: an origin, pointing everywhere and nowhere.
      '<g stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none">' +
      '<path d="M12 9.5 L12 3.5"/><path d="M14.5 10.5 L18.7 6.3"/>' +
      '<path d="M9.5 10.5 L5.3 6.3"/><path d="M15.5 13 L21.5 13"/>' +
      '<path d="M8.5 13 L2.5 13"/>' +
      '</g>' +
      '<circle cx="12" cy="12.5" r="2.6" fill="currentColor"/>' +
      '</svg>' +
      `<em>Пуск${spec.short === 'Ціль' ? '' : ' · ' + spec.short}</em>${badge}</span>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

/**
 * One marker.
 *
 * A known course rotates the silhouette. An unknown one is drawn upright inside a
 * dashed ring instead — pointing it north by default would invent a heading the
 * parser never extracted, and on this map a wrong direction is worse than none.
 */
function targetIcon(spec, course, count) {
  const rotation = course === null ? 0 : course;
  const ring = course === null
    ? '<circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" stroke-width="1.1"' +
      ' stroke-dasharray="2.6 2.6" opacity="0.75"/>'
    : '';

  const badge = count > 1 ? `<s>${count}</s>` : '';

  return L.divIcon({
    className: 'tgt',
    html:
      `<span class="tgt-mark" style="--c:${spec.color}">` +
      `<svg viewBox="0 0 24 24" width="26" height="26" style="transform:rotate(${rotation}deg)">` +
      `${ring}<path d="${spec.path}"/></svg>` +
      `<em>${spec.short}</em>${badge}</span>`,
    iconSize: [0, 0],
    iconAnchor: [0, 0],
  });
}

const map = L.map('map', { zoomControl: false, attributionControl: true })
  .setView([49.0, 31.5], 6);

L.control.zoom({ position: 'bottomleft' }).addTo(map);

/*
 * Standard OSM tiles, darkened in CSS rather than fetched from a dark-themed
 * provider. Every free dark basemap now wants an API key, and this map has to keep
 * working during an air raid without depending on a third party's signup, quota, or
 * terms. The CSS filter costs nothing and cannot expire.
 */
const TILES = window.HZ_CONFIG || {};
L.tileLayer(TILES.tileUrl || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: TILES.tileMaxZoom || 18,
  attribution: TILES.tileAttribution || '&copy; OpenStreetMap',
  // Only darken a light basemap; a provider that is already dark must be left alone.
  className: TILES.darkenTiles === false ? '' : 'basemap',
}).addTo(map);

function applyZoomClass() {
  // Labels are hidden only at the far-out zooms where dozens would overlap.
  document.body.classList.toggle('zoomed-out', map.getZoom() < 6);
}
map.on('zoomend', applyZoomClass);
applyZoomClass();

const alertLayer = L.layerGroup().addTo(map);
const raionLayer = L.layerGroup().addTo(map);
const targetLayer = L.layerGroup().addTo(map);
const launchLayer = L.layerGroup().addTo(map);
const meLayer = L.layerGroup().addTo(map);

let state = null;
let boundaries = null;
let raions = null;
let me = null;             // { lat, lon } — stays on this device, never sent anywhere
let watching = false;
let radiusKm = Number(localStorage.getItem('radiusKm') || 40);

/*
 * The last known position is remembered in this browser so a reload does not blank
 * the "me" circle while the device re-acquires a fix. It is stored on the device
 * only — the server never receives it, which is the whole point of computing
 * "near me" in the page.
 */
function rememberMe(pos) {
  try {
    localStorage.setItem('me', JSON.stringify({ lat: pos.lat, lon: pos.lon, at: Date.now() }));
  } catch { /* private mode: the map still works, it just will not remember */ }
}

function recallMe() {
  try {
    const saved = JSON.parse(localStorage.getItem('me') || 'null');
    // A stale fix is worse than none: a day-old position would draw the radius circle
    // somewhere the viewer no longer is.
    if (saved && Date.now() - saved.at < 12 * 3600 * 1000) return { lat: saved.lat, lon: saved.lon };
  } catch { /* ignore */ }
  return null;
}

/* ── helpers ──────────────────────────────────────────────── */

const el = (id) => document.getElementById(id);

function ageOpacity(at, now, over = FADE_MS) {
  const age = now - at;
  if (age <= 0) return 1;
  if (age >= over) return 0.12;
  return 1 - 0.88 * (age / over);
}

function minutesAgo(at, now) {
  const m = Math.max(0, Math.round((now - at) / 60000));
  if (m < 1) return 'щойно';
  if (m < 60) return m + ' хв';
  return Math.floor(m / 60) + ' год ' + (m % 60) + ' хв';
}

function distanceKm(a, b, c, d) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (c - a) * rad, dLon = (d - b) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a * rad) * Math.cos(c * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/* ── rendering ────────────────────────────────────────────── */

const PAINT = {
  full:    { color: '#f85149', fill: '#f85149', fillOpacity: 0.20, weight: 1.4, opacity: 0.9 },
  partial: { color: '#d29922', fill: '#d29922', fillOpacity: 0.18, weight: 1.3, opacity: 0.85 },
  none:    { color: '#30363d', fill: '#f85149', fillOpacity: 0,    weight: 0.7, opacity: 0.3 },
};

/*
 * Alerts are declared per raion, so that is what gets shaded.
 *
 * Painting a whole oblast because one of its raions is warned claims an emergency
 * across an area the size of a small country — the map reads as far worse than the
 * situation, and people stop trusting it. Oblast outlines stay as faint context; the
 * fill is only ever on the raions actually under warning.
 *
 * An oblast whose warned areas are hromadas or cities has no raion polygon to match,
 * so it falls back to a light oblast tint: still visible, visibly less precise.
 */
function drawAlerts() {
  alertLayer.clearLayers();
  raionLayer.clearLayers();
  if (!state) return;

  const byOblast = new Map(state.alerts.map((a) => [a.oblast, a]));
  const warnedAreas = new Set();
  for (const alert of state.alerts) {
    for (const area of alert.areas || []) warnedAreas.add(alert.oblast + '|' + area);
  }

  let matched = new Set();
  if (raions) {
    L.geoJSON(raions, {
      filter: (feature) => {
        const key = feature.properties.oblast + '|' + feature.properties.match;
        if (!warnedAreas.has(key)) return false;
        matched.add(feature.properties.oblast);
        return true;
      },
      style: (feature) => {
        const paint = PAINT[byOblast.get(feature.properties.oblast)?.level] || PAINT.full;
        return {
          color: paint.color,
          weight: paint.weight,
          opacity: paint.opacity,
          fillColor: paint.fill,
          fillOpacity: paint.fillOpacity,
          interactive: false,
        };
      },
    }).addTo(raionLayer);
  }

  if (!boundaries) return;

  L.geoJSON(boundaries, {
    style: (feature) => {
      const alert = byOblast.get(feature.properties.key);
      const active = alert && alert.level !== 'none';
      // Already shown precisely at raion level — draw only a thin outline.
      const precise = active && matched.has(feature.properties.key);
      const paint = PAINT[active ? alert.level : 'none'];

      return {
        color: active ? paint.color : PAINT.none.color,
        weight: active ? 1.2 : 0.6,
        opacity: active ? 0.7 : 0.28,
        fillColor: paint.fill,
        // Fill only when nothing finer was available for this oblast.
        fillOpacity: active && !precise ? 0.1 : 0,
        interactive: false,
      };
    },
  }).addTo(alertLayer);
}

function drawTargets() {
  targetLayer.clearLayers();
  if (!state) return;

  const now = Date.now();

  for (const t of state.targets) {
    const spec = TYPES[t.type] || TYPES.unknown;
    const opacity = ageOpacity(t.at, now);

    const marker = L.marker([t.lat, t.lon], {
      icon: targetIcon(spec, t.course, t.count),
      opacity,
      riseOnHover: true,
      // Fresher targets sit above older, faded ones where they overlap.
      zIndexOffset: Math.round(opacity * 500),
    });

    const near = me ? Math.round(distanceKm(me.lat, me.lon, t.lat, t.lon)) : null;
    marker.bindPopup(
      `<strong>${spec.label}${t.count > 1 ? ' ×' + t.count : ''}</strong><br>` +
      (t.label ? escapeHtml(t.label) + '<br>' : '') +
      `<span class="muted">${minutesAgo(t.at, now)} тому</span>` +
      (near !== null ? `<br><span class="muted">~${near} км від вас</span>` : ''),
    );

    marker.addTo(targetLayer);

    // A track line makes the direction readable at a glance, which a small rotated
    // glyph alone does not achieve on a phone.
    if (t.fromLat !== null && t.fromLon !== null) {
      L.polyline([[t.fromLat, t.fromLon], [t.lat, t.lon]], {
        color: spec.color,
        weight: 1.5,
        opacity: opacity * 0.5,
        dashArray: '4 5',
        interactive: false,
      }).addTo(targetLayer);
    }
  }
}

/*
 * Launch sites.
 *
 * Drawn under the targets and never counted as one: these say "something started
 * here", not "something is here". The popup spells that out rather than leaving the
 * icon to carry the whole distinction.
 */
function drawLaunches() {
  launchLayer.clearLayers();
  if (!state || !state.launches) return;

  const now = Date.now();

  for (const l of state.launches) {
    const spec = TYPES[l.type] || TYPES.unknown;
    const opacity = ageOpacity(l.at, now, LAUNCH_FADE_MS);

    const marker = L.marker([l.lat, l.lon], {
      icon: launchIcon(spec, l.count),
      opacity: opacity * 0.9,
      riseOnHover: true,
      // Always below a live target: what is in the air outranks where it came from.
      zIndexOffset: Math.round(opacity * 200) - 400,
    });

    marker.bindPopup(
      `<strong>Пуск: ${spec.label}${l.count > 1 ? ' ×' + l.count : ''}</strong><br>` +
      (l.label ? escapeHtml(l.label) + '<br>' : '') +
      `<span class="muted">${minutesAgo(l.at, now)} тому</span><br>` +
      '<span class="muted">місце пуску, не поточна позиція</span>',
    );

    marker.addTo(launchLayer);
  }
}

function drawMe() {
  meLayer.clearLayers();
  if (!me) return;

  L.marker([me.lat, me.lon], {
    icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [14, 14], iconAnchor: [7, 7] }),
    interactive: false,
  }).addTo(meLayer);

  L.circle([me.lat, me.lon], {
    radius: radiusKm * 1000,
    color: '#58a6ff',
    weight: 1,
    opacity: 0.55,
    fillColor: '#58a6ff',
    fillOpacity: 0.05,
    interactive: false,
  }).addTo(meLayer);
}

function drawFeed() {
  if (!state) return;
  const now = Date.now();

  el('feed').innerHTML = state.feed.map((item) => {
    // Unparsed messages show as text with no marker — the specified behaviour.
    const cls = item.parsed ? 'feed-text' : 'feed-text plain';
    return `<li>
      <div class="feed-meta"><span>@${escapeHtml(item.channel)}</span><span>${minutesAgo(item.at, now)}</span></div>
      <div class="${cls}">${escapeHtml(item.text)}</div>
    </li>`;
  }).join('');
}

function drawStatus() {
  if (!state) return;
  const now = Date.now();

  // Only count what is still live; the map keeps faded ones for context.
  const live = state.targets.filter((t) => now - t.at < FADE_MS).length;
  el('count').textContent = String(live);

  const red = state.alerts.filter((a) => a.level === 'full').length;
  const yellow = state.alerts.filter((a) => a.level === 'partial').length;
  el('alerts').innerHTML = yellow > 0
    ? `тривог: <b class="lvl-red">${red}</b> / <b class="lvl-yellow">${yellow}</b>`
    : `тривог: <b class="lvl-red">${red}</b>`;
  el('updated').textContent = 'оновлено ' + minutesAgo(state.now, now);

  const newest = Math.max(0, ...state.channels.map((c) => c.lastSuccessAt || 0));
  const lag = now - newest;
  const dot = el('dot');
  dot.className = 'dot ' + (!newest ? 'down' : lag < 120000 ? 'ok' : lag < 600000 ? 'stale' : 'down');
  dot.title = newest ? 'джерела оновлено ' + minutesAgo(newest, now) + ' тому' : 'немає даних';
}

function redraw() {
  drawTargets();
  drawLaunches();
  drawFeed();
  drawStatus();
}

/* ── data ─────────────────────────────────────────────────── */

async function loadRaions() {
  try {
    const res = await fetch('/data/raions.geojson', { credentials: 'same-origin' });
    if (!res.ok) return;
    raions = await res.json();
    drawAlerts();
  } catch {
    // Falls back to oblast-level shading.
  }
}

async function loadBoundaries() {
  try {
    const res = await fetch('/data/oblasts.geojson', { credentials: 'same-origin' });
    if (!res.ok) return;
    boundaries = await res.json();
    drawAlerts();

    /*
     * A short file means the region outlines were still being built when this copy
     * was cached. Re-fetch past the cache once so the map does not sit on an
     * incomplete set of regions until the next reload.
     */
    if ((boundaries.features || []).length < 24) {
      const fresh = await fetch('/data/oblasts.geojson', { cache: 'reload', credentials: 'same-origin' });
      if (fresh.ok) {
        const next = await fresh.json();
        if ((next.features || []).length > boundaries.features.length) {
          boundaries = next;
          drawAlerts();
        }
      }
    }
  } catch {
    // The map is still useful without region shading.
  }
}

async function poll() {
  try {
    const res = await fetch('/api/state', { credentials: 'same-origin' });
    if (res.ok) {
      state = await res.json();
      redraw();
      drawAlerts();
    }
  } catch {
    // Offline or asleep: keep showing the last known state rather than blanking.
  }
}

/* ── interaction ──────────────────────────────────────────── */

/*
 * Closing the feed needs more than the drag handle: once open the sheet covers most
 * of the screen, so there is an explicit close button, the map itself closes it, and
 * Escape works on a desktop browser.
 */
const sheet = el('sheet');
const toggleSheet = (open) => {
  const collapsed = open === undefined ? !sheet.classList.contains('collapsed') : !open;
  sheet.classList.toggle('collapsed', collapsed);
  el('feed-toggle').classList.toggle('on', !collapsed);
  // Hides the map controls, which would otherwise sit on top of the feed text.
  document.body.classList.toggle('sheet-open', !collapsed);
};

el('grip').addEventListener('click', () => toggleSheet());
el('feed-toggle').addEventListener('click', () => toggleSheet());
el('sheet-close').addEventListener('click', () => toggleSheet(false));
map.on('click', () => toggleSheet(false));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') toggleSheet(false); });

const radiusInput = el('radius');
radiusInput.value = String(radiusKm);
el('radius-val').textContent = radiusKm + ' км';
radiusInput.addEventListener('input', () => {
  radiusKm = Number(radiusInput.value);
  el('radius-val').textContent = radiusKm + ' км';
  localStorage.setItem('radiusKm', String(radiusKm));
  drawMe();
});

function startWatching(recentre) {
  if (!navigator.geolocation || watching) return;
  watching = true;
  el('locate').classList.add('on');

  // watchPosition, not getCurrentPosition: the position stays current while the page
  // is open. It is held in memory and in this browser only — never sent anywhere.
  navigator.geolocation.watchPosition(
    (pos) => {
      const first = me === null;
      me = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      rememberMe(me);
      drawMe();
      if (recentre && first) map.setView([me.lat, me.lon], 9);
      redraw();
    },
    () => {
      watching = false;
      el('locate').classList.remove('on');
    },
    { enableHighAccuracy: false, maximumAge: 30000, timeout: 15000 },
  );
}

el('locate').addEventListener('click', () => {
  if (me) map.setView([me.lat, me.lon], Math.max(map.getZoom(), 9));
  startWatching(true);
});

// Restore the remembered position immediately, then re-acquire without waiting for a
// tap if this browser has already granted permission.
me = recallMe();
if (me) drawMe();

if (navigator.permissions && navigator.permissions.query) {
  navigator.permissions.query({ name: 'geolocation' })
    .then((status) => { if (status.state === 'granted') startWatching(me === null); })
    .catch(() => {});
} else if (me) {
  startWatching(false);
}

// Refetch as soon as the screen comes back, rather than waiting out the interval.
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });

loadBoundaries();
loadRaions();
poll();
setInterval(poll, POLL_MS);
setInterval(redraw, REDRAW_MS); // age the markers between fetches

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
}
