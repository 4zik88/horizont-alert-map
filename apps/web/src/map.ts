import {
  Map as MapLibre,
  Marker,
  Popup,
  type GeoJSONSource,
  type LngLatBoundsLike,
  type MapMouseEvent,
  type StyleSpecification,
  setWorkerUrl,
} from 'maplibre-gl';
// MapLibre finds its worker next to its own module, which a bundler moves. Hand it the
// URL Vite gives the bundled worker instead.
import workerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Track } from '@horizont/contract';
import { launchSvg, targetSvg } from './icons.js';
import { markerLabel, regionPopupHtml, trackPopupHtml } from './popup.js';
import { bbox, oblastFeatures, type RegionAlertState, type RegionCollection } from './regions.js';
import { markerModel, offsetPx, tailSegments, trackForecast } from './targets.js';
import { esc, oblastName } from './format.js';

setWorkerUrl(workerUrl);

const STYLE_URL = 'https://tiles.openfreemap.org/styles/dark';
const UKRAINE: LngLatBoundsLike = [
  [22.1, 44.3],
  [40.3, 52.4],
];

/** Used when the basemap cannot be fetched (offline, first run): borders still draw. */
const FALLBACK_STYLE: StyleSpecification = {
  version: 8,
  sources: {},
  layers: [{ id: 'background', type: 'background', paint: { 'background-color': '#0e1116' } }],
};

/** Prefer Ukrainian place names where OpenStreetMap has them. */
function ukrainianLabels(style: StyleSpecification): StyleSpecification {
  for (const layer of style.layers) {
    if (layer.type !== 'symbol' || !layer.layout) continue;
    const field = JSON.stringify(layer.layout['text-field'] ?? '');
    if (field.includes('name')) {
      layer.layout['text-field'] = ['coalesce', ['get', 'name:uk'], ['get', 'name']];
    }
  }
  return style;
}

async function loadStyle(): Promise<StyleSpecification | string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 6000);
  try {
    const res = await fetch(STYLE_URL, { signal: ctrl.signal });
    if (!res.ok) throw new Error(String(res.status));
    return ukrainianLabels((await res.json()) as StyleSpecification);
  } catch {
    return FALLBACK_STYLE;
  } finally {
    clearTimeout(timer);
  }
}

function typeColour(t: Track, stale: boolean): string {
  if (stale) return '#8a8f98';
  return t.type === 'ballistic' || t.type === 'cruise' ? '#ff5a4f' : '#ffb020';
}

interface MarkerEntry {
  marker: Marker;
  popup: Popup;
  key: string;
}

/** Just enough GeoJSON typing for our own sources. */
interface Feature {
  type: 'Feature';
  properties: Record<string, unknown>;
  geometry:
    | { type: 'LineString'; coordinates: [number, number][] | number[][] }
    | { type: 'Point'; coordinates: [number, number] | number[] };
}
interface FC {
  type: 'FeatureCollection';
  features: Feature[];
}
const emptyFC = (): FC => ({ type: 'FeatureCollection', features: [] });

export class AlertMap {
  readonly map: MapLibre;
  private ready: Promise<void>;
  private regions: RegionCollection | null = null;
  private regionStates = new Map<string, RegionAlertState>();
  private paintedIds = new Set<string>();
  private markers = new Map<number, MarkerEntry>();
  private labelMarkers: Marker[] = [];
  private meMarker: Marker | null = null;
  private regionPopup: Popup | null = null;
  private now = Date.now();

  constructor(container: HTMLElement) {
    this.map = new MapLibre({
      container,
      style: FALLBACK_STYLE,
      bounds: UKRAINE,
      fitBoundsOptions: { padding: 12 },
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      maxZoom: 13,
      minZoom: 4,
    });
    this.map.touchZoomRotate.disableRotation();
    this.map.keyboard.disableRotation();
    this.ready = this.init();
  }

  private async init(): Promise<void> {
    const stylePromise = loadStyle();
    // First let the placeholder style finish loading, then swap in the basemap and wait
    // for *that* style: adding our layers in between would lose them to the swap.
    await new Promise<void>((resolve) => {
      if (this.map.loaded()) resolve();
      else this.map.once('load', () => resolve());
    });
    const style = await stylePromise;
    if (style !== FALLBACK_STYLE) {
      const swapped = new Promise<void>((resolve) => this.map.once('style.load', () => resolve()));
      this.map.setStyle(style, { diff: false });
      await swapped;
    }
    this.addLayers();
  }

  whenReady(): Promise<void> {
    return this.ready;
  }

  private firstSymbolLayer(): string | undefined {
    return this.map.getStyle().layers.find((l) => l.type === 'symbol')?.id;
  }

  private addLayers(): void {
    const m = this.map;
    const before = this.firstSymbolLayer();
    m.addSource('regions', { type: 'geojson', data: emptyFC(), promoteId: 'id' });
    m.addLayer(
      {
        id: 'oblast-fill',
        type: 'fill',
        source: 'regions',
        filter: ['==', ['get', 'kind'], 'oblast'],
        paint: {
          'fill-color': ['case', ['==', ['feature-state', 'alert'], 2], '#e5332a', '#f5c400'],
          'fill-opacity': ['case', ['==', ['feature-state', 'alert'], 2], 0.42, ['==', ['feature-state', 'alert'], 1], 0.24, 0],
        },
      },
      before,
    );
    m.addLayer(
      {
        id: 'raion-fill',
        type: 'fill',
        source: 'regions',
        filter: ['==', ['get', 'kind'], 'raion'],
        paint: {
          'fill-color': '#e5332a',
          'fill-opacity': ['case', ['>=', ['coalesce', ['feature-state', 'alert'], 0], 1], 0.45, 0],
        },
      },
      before,
    );
    m.addLayer(
      {
        id: 'raion-line',
        type: 'line',
        source: 'regions',
        filter: ['==', ['get', 'kind'], 'raion'],
        minzoom: 6,
        paint: { 'line-color': '#5b6472', 'line-width': 0.4, 'line-opacity': 0.5 },
      },
      before,
    );
    m.addLayer(
      {
        id: 'oblast-line',
        type: 'line',
        source: 'regions',
        filter: ['==', ['get', 'kind'], 'oblast'],
        paint: { 'line-color': '#9aa4b2', 'line-width': 0.9, 'line-opacity': 0.75 },
      },
      before,
    );

    m.addSource('tails', { type: 'geojson', data: emptyFC() });
    m.addLayer({
      id: 'tails',
      type: 'line',
      source: 'tails',
      layout: { 'line-cap': 'round', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'colour'], 'line-width': 2.5, 'line-opacity': ['get', 'opacity'] },
    });
    m.addSource('forecast', { type: 'geojson', data: emptyFC() });
    m.addLayer({
      id: 'forecast-line',
      type: 'line',
      source: 'forecast',
      filter: ['==', ['geometry-type'], 'LineString'],
      paint: { 'line-color': ['get', 'colour'], 'line-width': 1.6, 'line-dasharray': [2, 2], 'line-opacity': 0.85 },
    });
    m.addLayer({
      id: 'forecast-ticks',
      type: 'circle',
      source: 'forecast',
      filter: ['==', ['geometry-type'], 'Point'],
      paint: { 'circle-radius': 3, 'circle-color': '#0e1116', 'circle-stroke-color': ['get', 'colour'], 'circle-stroke-width': 1.5 },
    });

    // One handler for both fill layers, so a tap that hits a raion and its oblast opens one tooltip.
    m.on('click', (e) => this.onRegionClick(e));
  }

  private onRegionClick(e: MapMouseEvent): void {
    // A tap on a target marker bubbles to the map too; the marker's own popup wins.
    const target = e.originalEvent.target;
    if (target instanceof Element && target.closest('.maplibregl-marker')) return;
    if (!this.map.getLayer('oblast-fill')) return;
    const feats = this.map.queryRenderedFeatures(e.point, { layers: ['raion-fill', 'oblast-fill'] });
    const raion = feats.find((f) => f.properties.kind === 'raion');
    const oblast = feats.find((f) => f.properties.kind === 'oblast');
    const f = raion && this.regionStates.has(String(raion.properties.id)) ? raion : oblast ?? raion;
    if (!f) return;
    const props = f.properties as { id: string; kind: string; oblast: string; name?: string };
    const name = props.kind === 'oblast' ? oblastName(props.oblast) : props.name ?? props.id;
    let state = this.regionStates.get(props.id);
    // A raion with no alert of its own: show its oblast's alert if there is one.
    if (!state && props.kind === 'raion') state = this.regionStates.get(`oblast:${props.oblast}`);
    this.regionPopup?.remove();
    this.regionPopup = new Popup({ maxWidth: '260px' })
      .setLngLat(e.lngLat)
      .setHTML(regionPopupHtml(name, props.oblast, state, Date.now()))
      .addTo(this.map);
  }

  async setRegions(regions: RegionCollection): Promise<void> {
    await this.ready;
    this.regions = regions;
    (this.map.getSource('regions') as GeoJSONSource).setData(regions as unknown as Parameters<GeoJSONSource['setData']>[0]);
    this.paintedIds.clear();
    this.applyRegionStates();
  }

  async setAlertStates(states: Map<string, RegionAlertState>): Promise<void> {
    this.regionStates = states;
    await this.ready;
    this.applyRegionStates();
  }

  private applyRegionStates(): void {
    if (!this.regions) return;
    for (const id of this.paintedIds) {
      if (!this.regionStates.has(id)) this.map.setFeatureState({ source: 'regions', id }, { alert: 0 });
    }
    this.paintedIds.clear();
    for (const [id, s] of this.regionStates) {
      this.map.setFeatureState({ source: 'regions', id }, { alert: s.level });
      this.paintedIds.add(id);
    }
  }

  fitOblast(oblast: string): void {
    if (!this.regions) return;
    const b = bbox(oblastFeatures(this.regions, oblast));
    if (b) this.map.fitBounds([[b[0], b[1]], [b[2], b[3]]], { padding: 30, duration: 600 });
  }

  fitUkraine(): void {
    this.map.fitBounds(UKRAINE, { padding: 12, duration: 600 });
  }

  async setTracks(tracks: Track[], now: number): Promise<void> {
    await this.ready;
    this.now = now;
    this.drawTails(tracks);
    this.drawForecasts(tracks);
    this.drawMarkers(tracks);
  }

  private drawTails(tracks: Track[]): void {
    const features: Feature[] = [];
    for (const t of tracks) {
      const stale = markerModel(t, this.now).stale;
      for (const s of tailSegments(t, this.now)) {
        features.push({
          type: 'Feature',
          properties: { opacity: stale ? s.opacity * 0.6 : s.opacity, colour: typeColour(t, stale) },
          geometry: { type: 'LineString', coordinates: [s.from, s.to] },
        });
      }
    }
    (this.map.getSource('tails') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  private drawForecasts(tracks: Track[]): void {
    for (const m of this.labelMarkers) m.remove();
    this.labelMarkers = [];
    const features: Feature[] = [];
    for (const t of tracks) {
      const pts = trackForecast(t, this.now);
      if (pts.length === 0) continue;
      const colour = typeColour(t, false);
      features.push({
        type: 'Feature',
        properties: { colour },
        geometry: { type: 'LineString', coordinates: [[t.last.lon, t.last.lat], ...pts.map((p) => [p.lon, p.lat])] },
      });
      pts.forEach((p, i) => {
        features.push({ type: 'Feature', properties: { colour }, geometry: { type: 'Point', coordinates: [p.lon, p.lat] } });
        const el = document.createElement('div');
        el.className = 'fc-label';
        el.innerHTML =
          `<span>${p.minutes} хв</span>` + (i === pts.length - 1 ? '<span class="fc-approx">орієнтовно</span>' : '');
        this.labelMarkers.push(
          new Marker({ element: el, anchor: 'left', offset: [7, 0] }).setLngLat([p.lon, p.lat]).addTo(this.map),
        );
      });
    }
    (this.map.getSource('forecast') as GeoJSONSource).setData({ type: 'FeatureCollection', features });
  }

  private markerHtml(t: Track): { html: string; key: string } {
    const m = markerModel(t, this.now);
    const size = m.size;
    const hollow = m.style === 'hollow';
    const svg = m.style === 'launch' ? launchSvg(m.stale) : targetSvg(t.type, { hollow, stale: m.stale });
    const rot = m.rotation === null ? '' : `transform:rotate(${Math.round(m.rotation)}deg)`;
    const ring = m.rotation === null && m.style !== 'launch' ? '<span class="tg-ring"></span>' : '';
    const badge = t.count > 1 ? `<span class="tg-badge">${t.count}</span>` : '';
    let dx = 0;
    let dy = 0;
    let leader = '';
    let town = '';
    if (hollow) {
      [dx, dy] = offsetPx(m.offsetBearing ?? 0, size * 0.5 + 26);
      const w = Math.abs(dx) * 2 + 4;
      const h = Math.abs(dy) * 2 + 4;
      leader =
        `<svg class="tg-leader" width="${w}" height="${h}" style="left:${-w / 2}px;top:${-h / 2}px" aria-hidden="true">` +
        `<line x1="${w / 2}" y1="${h / 2}" x2="${w / 2 + dx}" y2="${h / 2 + dy}" /></svg>`;
      town = '<span class="tg-town"></span>';
    }
    const cls = ['tg', `tg-${m.style}`, m.stale ? 'tg-stale' : ''].filter(Boolean).join(' ');
    const html =
      `${leader}${town}<div class="${cls}" style="width:${size}px;height:${size}px;left:${dx - size / 2}px;top:${dy - size / 2}px">` +
      `${ring}<span class="tg-icon" style="${rot}">${svg}</span>${badge}` +
      `<span class="tg-label">${esc(markerLabel(t))}</span></div>`;
    return { html, key: html };
  }

  private drawMarkers(tracks: Track[]): void {
    const seen = new Set<number>();
    // Fresher on top: add stale ones first.
    const ordered = [...tracks].sort((a, b) => a.lastSeenAt - b.lastSeenAt);
    for (const t of ordered) {
      seen.add(t.id);
      const { html, key } = this.markerHtml(t);
      let entry = this.markers.get(t.id);
      if (!entry) {
        const el = document.createElement('div');
        el.className = 'tg-anchor';
        const popup = new Popup({ maxWidth: '260px', offset: 16 });
        const marker = new Marker({ element: el, anchor: 'center' }).setLngLat([t.last.lon, t.last.lat]);
        marker.setPopup(popup).addTo(this.map);
        entry = { marker, popup, key: '' };
        this.markers.set(t.id, entry);
      }
      entry.marker.setLngLat([t.last.lon, t.last.lat]);
      if (entry.key !== key) {
        entry.marker.getElement().innerHTML = html;
        entry.key = key;
      }
      entry.marker.getElement().setAttribute('aria-label', markerLabel(t));
      entry.popup.setHTML(trackPopupHtml(t, this.now));
    }
    for (const [id, entry] of this.markers) {
      if (!seen.has(id)) {
        entry.marker.remove();
        this.markers.delete(id);
      }
    }
  }

  setMe(pos: { lat: number; lon: number } | null): void {
    if (!pos) {
      this.meMarker?.remove();
      this.meMarker = null;
      return;
    }
    if (!this.meMarker) {
      const el = document.createElement('div');
      el.className = 'me-dot';
      el.title = 'Ви тут (лише на цьому пристрої)';
      this.meMarker = new Marker({ element: el });
      this.meMarker.setLngLat([pos.lon, pos.lat]).addTo(this.map);
    } else {
      this.meMarker.setLngLat([pos.lon, pos.lat]);
    }
  }

  flyTo(pos: { lat: number; lon: number }): void {
    this.map.flyTo({ center: [pos.lon, pos.lat], zoom: Math.max(this.map.getZoom(), 8) });
  }
}
