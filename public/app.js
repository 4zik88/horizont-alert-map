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
  // "×4" rather than "4": on a map that also shows cluster rings, a bare number was
  // ambiguous between "four aircraft" and "four contacts".
  const badge = count > 1 ? `<s>×${count}</s>` : '';

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
/*
 * Relations that say where the target IS, as opposed to where it is going.
 *
 * "курсом на Піщану" means it is flying toward Піщана and is not there — the town may
 * not even be under alert yet. Drawing a solid aircraft on it says something is
 * overhead that is not, which is the same error as putting a marker on a launch site.
 * "над Піщаною" and "повз Піщану" do report a position.
 */
const POSITION_RELATIONS = new Set(['over', 'past', 'through']);

function targetIcon(spec, course, count, relation, rel) {
  const rotation = course === null ? 0 : course;
  const heading = !POSITION_RELATIONS.has(relation);
  const tier = TIER[rel?.tier ?? 'mid'];

  // Unknown heading is drawn upright in a dashed ring rather than pointed north.
  const ring = course === null
    ? '<circle cx="12" cy="12" r="11" fill="none" stroke="currentColor" stroke-width="1.1"' +
      ' stroke-dasharray="2.6 2.6" opacity="0.75"/>'
    : '';

  // "×4" rather than "4": on a map that also shows cluster rings, a bare number was
  // ambiguous between "four aircraft" and "four contacts merged".
  const badge = count > 1 ? `<s>×${count}</s>` : '';
  /*
   * A destination is drawn hollow and prefixed with an arrow: the shape still says
   * what kind of thing is coming, the outline says it has not arrived. A filled
   * silhouette is reserved for a reported position.
   */
  const cls = `tgt-mark${heading ? ' heading' : ''} t-${rel?.tier ?? 'mid'}`;

  /*
   * A heading target is drawn *behind* its destination, on the side it is coming
   * from, with its nose pointing at the town — not sitting on the town itself.
   *
   * Placing it on the settlement said the drone was there; the hollow outline said
   * otherwise, but the position spoke louder. Offsetting it backwards along its own
   * course says "approaching from here" with the geometry rather than with a legend,
   * and it frees the town label underneath.
   *
   * Screen axes: x right, y down, course measured clockwise from north. Travelling
   * along (sin, -cos), so the tail sits at the negation of that.
   */
  const lead = Math.round(tier.size * 0.85);
  let shift = '';
  let leader = '';
  if (heading && course !== null) {
    const rad = (course * Math.PI) / 180;
    const dx = -Math.sin(rad) * lead;
    const dy = Math.cos(rad) * lead;
    shift = `--dx:${dx.toFixed(1)}px;--dy:${dy.toFixed(1)}px;`;
    // Rotating a downward unit vector clockwise by (180 - course) points it forward.
    leader = `<i class="lead" style="--lead:${lead}px;--lrot:${(180 - course).toFixed(1)}deg"></i>`;
  }

  /*
   * The near label carries the number worth reading. Distance answers "where", the
   * minutes answer "how long have I got" — and the minutes are shown only when the
   * thing is actually pointed at you, or they would be a guess dressed as a fact.
   */
  let label = heading ? `→ ${spec.short}` : spec.short;
  if (rel?.tier === 'near' && rel.km !== null) {
    label += rel.approaching
      ? ` · ${Math.round(rel.etaMin)} хв`
      : ` · ${Math.round(rel.km)} км`;
  }

  return L.divIcon({
    className: 'tgt',
    html:
      `<span class="${cls}" style="--c:${spec.color};--s:${tier.size}px;${shift}">` +
      leader +
      `<svg viewBox="0 0 24 24" width="${tier.size}" height="${tier.size}" ` +
      `style="transform:rotate(${rotation}deg)">` +
      `${ring}<path d="${spec.path}"/></svg>` +
      `<em>${label}</em>${badge}</span>`,
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
  /*
   * Three states, not one switch. The old rule hid labels below zoom 6 — but the
   * default view *is* zoom 6, so labels were always on at the view everyone opens,
   * which is the view that was unreadable.
   */
  const z = map.getZoom();
  document.body.dataset.zoom = z <= 6 ? 'country' : z <= 7 ? 'region' : 'local';
}
map.on('zoomend', () => {
  applyZoomClass();
  // Clustering and the tail rules read the zoom, so a zoom change must redraw —
  // relabelling alone would leave clusters from the previous zoom on screen.
  drawTargets();
  drawLaunches();
});
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

/*
 * One alert colour, not two.
 *
 * The feed used to paint the partial level amber and the oblast-wide level red,
 * mirroring alerts.in.ua. In use that read as two things to decide between at a
 * glance, and the amber shading also sat close enough to the amber drone icons to
 * blur which was which. An alert is an alert: what matters is whether to take cover,
 * and the level is still in the data for anyone who wants it.
 */
const ALERT_RED = '#f85149';
/*
 * The edge is a lighter tone than the fill rather than the same red.
 *
 * Stroke and fill in one colour made the boundary dissolve into the area, so a raion
 * under alert read as a vague red smear. A brighter edge states where the alert
 * actually stops, and being lighter rather than a different hue keeps "red means
 * alert" intact — the amber and orange of the target icons stay unambiguous against
 * it.
 */
const ALERT_EDGE = '#ff9d97';
/*
 * A wash, not a flood — but still a wash. 0.20 drowned the targets; 0.06, tried
 * first, left "тільки контури" and the alert stopped reading as an area at all. 0.16
 * is the middle that keeps the shaded region obvious while the markers stay on top of
 * it. The heavier stroke stays: the edge does the work of saying *which* raion.
 *
 * The quiet-oblast outline stays, because the dark basemap gives little else to
 * navigate by, but demoted hard: 24 grey polygons were competing with the alert
 * edges before a single alert existed.
 */
const PAINT = {
  full:    { color: ALERT_EDGE, fill: ALERT_RED, fillOpacity: 0.16, weight: 1.7, opacity: 0.95 },
  partial: { color: ALERT_EDGE, fill: ALERT_RED, fillOpacity: 0.14, weight: 1.6, opacity: 0.9 },
  none:    { color: '#30363d', fill: ALERT_RED, fillOpacity: 0,    weight: 0.5, opacity: 0.10 },
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
        opacity: active ? 0.7 : 0.10,
        fillColor: paint.fill,
        // Fill only when nothing finer was available for this oblast.
        fillOpacity: active && !precise ? 0.05 : 0,
        interactive: false,
      };
    },
  }).addTo(alertLayer);
}

/*
 * Should this target still be drawn?
 *
 * An all-clear means the threat has left, so a marker that lingers for the rest of
 * the window says something is overhead when it is not.
 *
 * Three rails, because the failure mode here is hiding a real target during a raid —
 * far worse than showing a stale one:
 *
 *  1. Only when the alert feed actually answered. An empty `alerts` array means we
 *     know nothing, not that the country is clear, and must hide nothing.
 *  2. Only for an oblast explicitly reported clear. A target whose oblast we could
 *     not determine stays on the map.
 *  3. Never for a target younger than the grace period. These channels are routinely
 *     faster than the official alert — those first minutes before the siren are the
 *     most valuable thing this map shows, and gating them on an alert that has not
 *     been declared yet would delete exactly the warning worth having.
 */
const ALERT_GRACE_MS = 5 * 60 * 1000;

/*
 * Which raion a point falls in.
 *
 * The all-clear rule started at oblast granularity, which left drones drawn over
 * quiet raions of an oblast that was under alert somewhere else entirely — visible on
 * the map as markers sitting in unshaded territory. The polygons are already loaded
 * for the shading, so the same geometry answers it properly.
 *
 * Bounding boxes are precomputed and the answer memoised per target: a redraw runs
 * every 15 seconds over every target, and ray-casting 161 raions each time would not
 * be free.
 */
let raionBoxes = null;
const raionOfTarget = new Map();

function indexRaions() {
  raionBoxes = raions.features.map((f) => {
    let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
    eachRing(f, (ring) => {
      for (const [lon, lat] of ring) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
    });
    return { feature: f, minLat, maxLat, minLon, maxLon };
  });
}

function eachRing(feature, fn) {
  const g = feature.geometry;
  if (!g) return;
  if (g.type === 'Polygon') g.coordinates.forEach(fn);
  else if (g.type === 'MultiPolygon') for (const poly of g.coordinates) poly.forEach(fn);
}

/** Ray casting; only the outer ring of each polygon is tested, which is enough here. */
function inRing(lat, lon, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function raionAt(lat, lon) {
  if (!raions) return undefined;
  if (!raionBoxes) indexRaions();

  for (const box of raionBoxes) {
    if (lat < box.minLat || lat > box.maxLat || lon < box.minLon || lon > box.maxLon) continue;
    let hit = false;
    eachRing(box.feature, (ring) => { if (!hit && inRing(lat, lon, ring)) hit = true; });
    if (hit) return box.feature.properties;
  }
  return undefined;
}

/*
 * Collapse repeated reports of the same target.
 *
 * Four channels cover the same sky, and one drone crossing an oblast is posted again
 * every few minutes as it moves — so a single Shahed over Ananyiv arrived as seven
 * markers stacked on one point. Measured over an hour of real traffic: 89 targets for
 * 56 distinct places, 37% of the map redundant.
 *
 * Identity is the type plus the position rounded to ~1 km. Type matters: a КАБ and a
 * БпЛА over the same town are two different threats and must stay two markers.
 *
 * The surviving marker is the freshest report, but it carries the *largest* count
 * anyone gave, never the sum — "5 шахедів на Затоку" repeated by three channels is
 * five drones, not fifteen. Same rule the bot already uses when batching a warning.
 */
function dedupeTargets(targets) {
  const best = new Map();

  for (const t of targets) {
    const key = `${t.type}|${t.lat.toFixed(2)},${t.lon.toFixed(2)}`;
    const seen = best.get(key);

    if (!seen) {
      best.set(key, { ...t, reports: 1 });
      continue;
    }

    const fresher = t.at > seen.at ? t : seen;
    best.set(key, {
      ...fresher,
      count: Math.max(t.count, seen.count),
      // A heading from either report beats none: the fresher line may omit it.
      course: fresher.course !== null ? fresher.course : (seen.course ?? t.course),
      reports: seen.reports + 1,
    });
  }

  return [...best.values()];
}

function silencedByAllClear(target, byOblast, now) {
  if (!state.alerts || state.alerts.length === 0) return false;
  if (!target.oblast) return false;
  if (now - target.at < ALERT_GRACE_MS) return false;

  const alert = byOblast.get(target.oblast);
  if (alert === undefined) return false;
  if (!alert.active) return true;

  /*
   * The oblast is under alert, but perhaps not here. Hide a target sitting in a raion
   * that is not one of the warned areas.
   *
   * Two guards. A raion we cannot locate is never hidden. And when none of an
   * oblast's warned areas match a raion polygon — which happens when the warning is
   * hromada- or city-level, as Dnipropetrovsk's Nikopol area usually is — the whole
   * oblast falls back to "shown", or a legitimate alert would clear its own map.
   */
  if (!raions) return false;
  let raion = raionOfTarget.get(target.id);
  if (raion === undefined) {
    raion = raionAt(target.lat, target.lon) ?? null;
    raionOfTarget.set(target.id, raion);
  }
  if (!raion) return false;

  const warned = alert.areas || [];
  if (warned.length === 0) return false;

  const anyRaionMatches = raionBoxes.some(
    (b) => b.feature.properties.oblast === target.oblast
      && warned.includes(b.feature.properties.match),
  );
  if (!anyRaionMatches) return false;

  return !warned.includes(raion.match);
}

/*
 * Cruise speeds, mirroring src/parser/targetTypes.ts. Used only to decide whether two
 * sightings can be the same aircraft, so being roughly right is enough.
 */
const SPEED_KMH = {
  uav: 180, jet_uav: 600, cruise: 800, ballistic: 3000,
  kab: 700, aviation: 800, recon: 150, unknown: 200,
};

/** Beyond this gap two sightings are separate events, not one flight. */
const TRACK_MAX_GAP_MS = 15 * 60 * 1000;
/* Reports name a settlement, not a point, so allow slack for that plus a speed
 * margin — a drone that detours reads as faster than its cruise speed. */
const TRACK_SLACK_KM = 20;
const TRACK_SPEED_MARGIN = 1.3;
/*
 * A flight does not double back. Without this, a jet UAV at 600 km/h can reach
 * anywhere in an oblast inside the time window, so distance alone chained unrelated
 * drones into one zigzag: Радомишль → Житомир → Тетіїв → Погребище was three
 * aircraft drawn as one itinerary going nowhere.
 *
 * 90 degrees was chosen by comparing thresholds against an hour of live traffic:
 * 60 and 75 fragmented real flights (longest track 3 and 5 points), 100 let a 123 km
 * leg back through. At 90 the flight count is the same as 100 and the worst leg drops
 * to 67 km.
 */
const TRACK_MAX_TURN_DEG = 90;

/** Initial bearing between two points, degrees, 0 = north. */
function bearingBetween(lat1, lon1, lat2, lon2) {
  const rad = Math.PI / 180;
  const f1 = lat1 * rad;
  const f2 = lat2 * rad;
  const dLon = (lon2 - lon1) * rad;
  const y = Math.sin(dLon) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dLon);
  return (Math.atan2(y, x) / rad + 360) % 360;
}

function turnDeg(a, b) {
  const d = Math.abs(((a - b) % 360 + 360) % 360);
  return d > 180 ? 360 - d : d;
}

/*
 * Join successive sightings of the same aircraft into one track.
 *
 * Position dedupe alone was not enough: a drone crossing Vinnytsia oblast is reported
 * at six different towns as it goes, so it became six markers and the header said
 * "13 цілей" when three aircraft were in the air. That over-counts the threat and
 * hides the one thing worth knowing — where it is going.
 *
 * A sighting joins the most recent open track of the same type whose last point it
 * could plausibly have reached: within the time gap, and within cruise speed times
 * elapsed plus slack. Nothing else links them — these messages carry no aircraft id —
 * so this is a heuristic, and two drones flying the same corridor minutes apart can
 * merge. That is a better failure than the current one: it under-counts rather than
 * multiplying one aircraft into six.
 */
function buildTracks(targets) {
  const sorted = [...targets].sort((a, b) => a.at - b.at);
  const tracks = [];

  for (const t of sorted) {
    const speed = SPEED_KMH[t.type] ?? SPEED_KMH.unknown;
    let best;
    let bestKm = Infinity;

    for (const track of tracks) {
      if (track.type !== t.type) continue;
      const last = track.points[track.points.length - 1];
      const gapMs = t.at - last.at;
      if (gapMs < 0 || gapMs > TRACK_MAX_GAP_MS) continue;

      const km = distanceKm(last.lat, last.lon, t.lat, t.lon);
      const reach = (speed * TRACK_SPEED_MARGIN * gapMs) / 3_600_000 + TRACK_SLACK_KM;
      if (km > reach || km >= bestKm) continue;

      // Established heading must roughly continue: no doubling back.
      if (track.points.length > 1) {
        const prev = track.points[track.points.length - 2];
        const legIn = bearingBetween(prev.lat, prev.lon, last.lat, last.lon);
        const legOut = bearingBetween(last.lat, last.lon, t.lat, t.lon);
        if (km > 1 && turnDeg(legIn, legOut) > TRACK_MAX_TURN_DEG) continue;
      }

      best = track;
      bestKm = km;
    }

    if (best) {
      best.points.push(t);
      // The count of a flight is the most anyone reported in it, never the sum.
      best.count = Math.max(best.count, t.count);
    } else {
      tracks.push({ type: t.type, points: [t], count: t.count });
    }
  }

  // Head is the newest sighting: where the aircraft was last seen.
  for (const track of tracks) track.head = track.points[track.points.length - 1];
  return tracks;
}

/*
 * How relevant is this flight to the reader?
 *
 * The rules deliberately mirror src/notify/proximity.ts — radius, a 30-degree course
 * corridor and a 25-minute lead. What the map calls "поруч" is then exactly what
 * makes the phone buzz, and that consistency is worth more than any tuning: a map
 * that disagrees with the alert you just received is worse than either alone.
 *
 * Distance alone would not do. Measured over an hour of live traffic, a 50 km radius
 * held 1 target of 65 while "within 10 minutes" held 7, so a distance-only near tier
 * would almost never fire. Time-to-reach also ranks correctly across types: a jet UAV
 * 60 km out is 6 minutes away, an ordinary Shahed at the same distance is 20.
 */
const COURSE_TOLERANCE_DEG = 30;
const LEAD_MINUTES = 25;
const MID_LEAD_MINUTES = 60;
const MID_RADIUS_FACTOR = 3;

const TIER = {
  near: { size: 34, dim: 1, rank: 0, z: 900 },
  mid: { size: 26, dim: 0.9, rank: 1, z: 500 },
  far: { size: 18, dim: 0.65, rank: 2, z: 100 },
};

/** The flight's heading, strongest evidence first. */
function headingOf(track) {
  const points = track.points;
  if (points.length > 1) {
    const a = points[points.length - 2];
    const b = track.head;
    if (distanceKm(a.lat, a.lon, b.lat, b.lon) > 1) {
      return bearingBetween(a.lat, a.lon, b.lat, b.lon);
    }
  }
  if (track.head.course !== null) return track.head.course;
  if (track.head.fromLat !== null && track.head.fromLon !== null) {
    return bearingBetween(track.head.fromLat, track.head.fromLon, track.head.lat, track.head.lon);
  }
  return null;
}

function relevanceOf(track, from, radiusKm, now) {
  // No geolocation: one uniform weight. The map must not look broken, or empty,
  // because the reader declined a permission.
  if (!from) return { tier: 'mid', km: null, etaMin: null, approaching: false };

  /*
   * Nearest of the two known points, same as the bot's positionOf: a target may have
   * a reported position and a destination, and the closer one is what concerns you.
   */
  const head = track.head;
  let km = distanceKm(from.lat, from.lon, head.lat, head.lon);
  if (head.fromLat !== null && head.fromLon !== null) {
    km = Math.min(km, distanceKm(from.lat, from.lon, head.fromLat, head.fromLon));
  }

  const heading = headingOf(track);
  const bearingToMe = bearingBetween(head.lat, head.lon, from.lat, from.lon);
  const approaching = heading !== null
    && turnDeg(bearingToMe, heading) <= COURSE_TOLERANCE_DEG;
  const etaMin = (km / (SPEED_KMH[track.type] || SPEED_KMH.unknown)) * 60;

  let tier;
  if (km <= radiusKm || (approaching && etaMin <= LEAD_MINUTES)) tier = 'near';
  else if (km <= radiusKm * MID_RADIUS_FACTOR || (approaching && etaMin <= MID_LEAD_MINUTES)) tier = 'mid';
  else tier = 'far';

  /*
   * A report younger than the grace period is never demoted to far. These channels
   * are routinely ahead of the official siren, and those first minutes are the most
   * valuable thing this map shows — burying them in a cluster would throw away
   * exactly what the all-clear rule goes out of its way to protect.
   */
  if (now - head.at < ALERT_GRACE_MS && tier === 'far') tier = 'mid';

  return { tier, km, etaMin, approaching };
}

/*
 * One pipeline, read by both the map and the header.
 *
 * They used to run it separately and then apply different freshness rules, which is
 * why the header said 14 while 21 markers were drawn. Sharing it makes them agree by
 * construction rather than by coincidence.
 */
function liveTracks(now) {
  if (!state) return [];

  const byOblast = new Map(state.alerts.map((a) => [a.oblast, a]));
  const visible = dedupeTargets(state.targets)
    .filter((t) => !silencedByAllClear(t, byOblast, now));

  return buildTracks(visible)
    // The head is what the marker shows; a flight whose newest sighting has aged out
    // is over. Its older points may legitimately be 45 minutes old.
    .filter((track) => now - track.head.at < FADE_MS)
    .map((track) => ({ ...track, rel: relevanceOf(track, me, radiusKm, now) }))
    .sort((a, b) => TIER[a.rel.tier].rank - TIER[b.rel.tier].rank);
}

/*
 * Grid clustering for distant flights, without a library — leaflet.markercluster
 * needs a bundler and this client is deliberately one file the browser runs as-is.
 *
 * Bucketed in world-pixel space via `map.project(latlng, zoom)`, which is independent
 * of panning, so membership changes only on zoom. `latLngToLayerPoint` would be
 * pan-dependent and make markers hop while dragging; a degree grid would over-cluster
 * at high zoom and distort with latitude. Both are easy to "simplify" into by
 * accident, hence this note.
 *
 * Honest about its worth: buildTracks already does the heavy collapsing, so at
 * today's density most cells hold one flight and this changes nothing. It exists for
 * the night 200 targets are up, which is when the map has to stay readable.
 */
const CLUSTER_CELL_PX = 44;
const CLUSTER_MAX_ZOOM = 7;

/** Threat order, for colouring a mixed cell by its worst member. */
const THREAT_ORDER = ['ballistic', 'cruise', 'kab', 'jet_uav', 'aviation', 'uav', 'recon', 'unknown'];

function clusterIcon(members) {
  const worst = members.reduce((a, b) =>
    THREAT_ORDER.indexOf(b.type) < THREAT_ORDER.indexOf(a.type) ? b : a);
  const spec = TYPES[worst.type] || TYPES.unknown;
  const count = members.reduce((n, t) => n + t.count, 0);
  const size = count >= 10 ? 40 : count >= 5 ? 34 : 30;

  /*
   * The number is the count of aircraft, not of merged contacts.
   *
   * It first showed contacts, and "4" left the reader unable to tell whether four
   * things were flying or four reports had been merged — "ніде не видно що 4 штуки
   * летить". How many are in the air is the question; the breakdown into contacts
   * belongs in the popup, where there is room to say it in words.
   *
   * The chevron restores the one thing clustering destroys — whether the blob is
   * coming your way — and is drawn only when the members actually agree on a heading.
   */
  const bearings = members.map(headingOf).filter((b) => b !== null);
  let chevron = '';
  if (bearings.length >= Math.ceil(members.length * 0.6)) {
    const mean = meanBearing(bearings);
    if (bearings.every((b) => turnDeg(b, mean) <= 45)) {
      chevron = `<i style="transform:rotate(${mean}deg)"></i>`;
    }
  }

  return L.divIcon({
    className: 'cluster-wrap',
    html: `<span class="tgt-cluster" style="--c:${spec.color};--s:${size}px">` +
      `<b>${count}</b>${chevron}</span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });
}

/** Circular mean of bearings in degrees. */
function meanBearing(bearings) {
  const rad = Math.PI / 180;
  let x = 0;
  let y = 0;
  for (const b of bearings) {
    x += Math.cos(b * rad);
    y += Math.sin(b * rad);
  }
  return (Math.atan2(y, x) / rad + 360) % 360;
}

function drawTargets() {
  targetLayer.clearLayers();
  if (!state) return;

  const now = Date.now();
  const zoom = map.getZoom();
  const clustering = zoom <= CLUSTER_MAX_ZOOM;

  const buckets = new Map();
  const solo = [];

  for (const track of liveTracks(now)) {
    /*
     * Never clustered: anything near you, and anything reported in the last few
     * minutes. The second rule matters most — it is the same window the all-clear
     * rule protects, for the same reason.
     */
    const pinned = track.rel.tier === 'near' || now - track.head.at < ALERT_GRACE_MS;

    if (!clustering || pinned) {
      solo.push(track);
      continue;
    }

    const p = map.project([track.head.lat, track.head.lon], zoom);
    const key = `${Math.floor(p.x / CLUSTER_CELL_PX)}:${Math.floor(p.y / CLUSTER_CELL_PX)}`;
    const group = buckets.get(key);
    if (group) group.push(track);
    else buckets.set(key, [track]);
  }

  for (const members of buckets.values()) {
    // A chip reading "1" is strictly worse than the silhouette it replaced.
    if (members.length === 1) solo.push(members[0]);
    else drawCluster(members, now);
  }

  for (const track of solo) drawTrack(track, now, zoom);
}

function drawCluster(members, now) {
  const lat = members.reduce((n, t) => n + t.head.lat, 0) / members.length;
  const lon = members.reduce((n, t) => n + t.head.lon, 0) / members.length;
  const newest = Math.max(...members.map((t) => t.head.at));

  const aircraft = members.reduce((n, t) => n + t.count, 0);
  const counts = new Map();
  for (const t of members) {
    const spec = TYPES[t.type] || TYPES.unknown;
    counts.set(spec.short, (counts.get(spec.short) ?? 0) + t.count);
  }
  const breakdown = [...counts].map(([name, n]) => `${n} × ${name}`).join(', ');
  const near = me ? Math.round(Math.min(...members.map(
    (t) => distanceKm(me.lat, me.lon, t.head.lat, t.head.lon)))) : null;

  L.marker([lat, lon], {
    icon: clusterIcon(members),
    opacity: ageOpacity(newest, now),
    zIndexOffset: 300,
  })
    .bindPopup(
      `<strong>${aircraft} цілей</strong><br>${escapeHtml(breakdown)}<br>` +
      `<span class="muted">${members.length} окремих відміток</span><br>` +
      `<span class="muted">найсвіжіша ${minutesAgo(newest, now)} тому</span>` +
      (near !== null ? `<br><span class="muted">~${near} км від вас</span>` : ''),
    )
    .on('click', (e) => {
      const bounds = L.latLngBounds(members.map((t) => [t.head.lat, t.head.lon]));
      map.flyToBounds(bounds.pad(0.25), { maxZoom: 9 });
      e.target.closePopup();
    })
    .addTo(targetLayer);
}

function drawTrack(track, now, zoom) {
  const t = { ...track.head, count: track.count, reports: track.points.length };
  const spec = TYPES[track.type] || TYPES.unknown;
  const tier = TIER[track.rel.tier];
  const opacity = ageOpacity(t.at, now) * tier.dim;

  /*
   * No route line, and no breadcrumbs.
   *
   * Drawing where a flight had been turned the map into a web of crossing lines that
   * said little about where anything is now. `buildTracks` still does its work — it
   * is why one drone is one marker rather than six — but its output is a position and
   * a heading, not a drawing of the past. The count of merged sightings stays in the
   * popup for anyone who wants it.
   */
  const marker = L.marker([t.lat, t.lon], {
    icon: targetIcon(spec, t.course, t.count, t.relation, track.rel),
    opacity,
    riseOnHover: true,
    // Tier first, then recency within it: a near flight is never buried under a far one.
    zIndexOffset: tier.z + Math.round(opacity * 80),
  });

  /*
   * Say plainly which of the two this is. The icon carries it too, but the popup is
   * where someone checks before deciding whether to move.
   */
  const where = POSITION_RELATIONS.has(t.relation)
    ? (t.label ? `над ${escapeHtml(t.label)}` : '')
    : (t.label ? `курс на ${escapeHtml(t.label)}<br><span class="muted">ще не там</span>` : '');

  // Distance is the question; time is the answer to it, and only honest when the
  // thing is actually pointed at you.
  const proximity = track.rel.km === null ? ''
    : `<br><span class="muted">~${Math.round(track.rel.km)} км від вас` +
      (track.rel.approaching ? ` · ~${Math.round(track.rel.etaMin)} хв` : '') +
      '</span>';

  marker.bindPopup(
    `<strong>${spec.label}${t.count > 1 ? ' ×' + t.count : ''}</strong><br>` +
    (where ? where + '<br>' : '') +
    `<span class="muted">${minutesAgo(t.at, now)} тому</span>` +
    (t.reports > 1 ? `<span class="muted"> · ${t.reports} відміток на маршруті</span>` : '') +
    proximity,
  );

  marker.addTo(targetLayer);

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

  /*
   * Same collapse as targets. Several channels report one launch, and the same site
   * launches repeatedly through a night, so Прим.-Ахтарськ arrived as a stack of
   * identical bursts on one point.
   */
  for (const l of dedupeTargets(state.launches)) {
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
      `<span class="muted">${minutesAgo(l.at, now)} тому</span>` +
      (l.reports > 1 ? `<span class="muted"> · ${l.reports} пусків</span>` : '') +
      '<br><span class="muted">місце пуску, не поточна позиція</span>',
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

  /*
   * Same population the map draws — `liveTracks` is shared precisely so the header
   * and the markers cannot drift apart, which is how "13 цілей" once sat above three
   * drones.
   */
  const tracks = liveTracks(now);
  el('total').textContent = String(tracks.length);
  el('near').textContent = me
    ? String(tracks.filter((t) => t.rel.tier === 'near').length)
    : '—';
  // Without a position there is no "near", and the map should say so rather than
  // quietly showing a zero that looks like good news.
  document.body.classList.toggle('no-me', !me);

  // One number, matching the single colour on the map.
  const active = state.alerts.filter((a) => a.active).length;
  el('alerts').innerHTML = `тривог: <b class="lvl-red">${active}</b>`;
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
/*
 * The slider now decides which flights count as near, so it has to redraw the map,
 * not just resize the ring. Coalesced with rAF because `input` fires continuously
 * while dragging and a redraw walks every track.
 */
let radiusFrame = 0;
radiusInput.addEventListener('input', () => {
  radiusKm = Number(radiusInput.value);
  el('radius-val').textContent = radiusKm + ' км';
  localStorage.setItem('radiusKm', String(radiusKm));
  drawMe();

  if (radiusFrame) cancelAnimationFrame(radiusFrame);
  radiusFrame = requestAnimationFrame(() => {
    radiusFrame = 0;
    drawTargets();
    drawStatus();
  });
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
