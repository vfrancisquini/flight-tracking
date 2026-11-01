import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { DATA_MODE, fetchLive } from './api';
import { fmtAge, fmtAltitude, fmtHeading, fmtSpeed, fmtVRate } from './format';
import { viewportToQuery } from './geo';
import { AircraftLayer } from './map/aircraftLayer';
import { Poller } from './poller';
import { AircraftStore } from './store';

const POLL_MS = 10_000;
const STALE_MS = 60_000;
const FALLBACK_VIEW = { center: [-46.63, -23.55] as [number, number], zoom: 7 }; // São Paulo

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const statusEl = $('#status');
const panel = $<HTMLElement>('#panel');

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  ...FALLBACK_VIEW,
  attributionControl: {
    compact: true,
    customAttribution:
      'Voos: <a href="https://adsb.lol" target="_blank" rel="noopener">adsb.lol</a> (ODbL) · ' +
      '<a href="https://adsb.fi" target="_blank" rel="noopener">adsb.fi</a> · ' +
      '<a href="https://airplanes.live" target="_blank" rel="noopener">airplanes.live</a>',
  },
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: false }), 'bottom-right');

const store = new AircraftStore();
let layer: AircraftLayer;
let lastProvider = '—';
let lastOkAt = 0;
let truncated = false;
let lastError: string | null = null;

async function refresh(): Promise<void> {
  const b = map.getBounds();
  const q = viewportToQuery(
    { lat: map.getCenter().lat, lon: map.getCenter().lng },
    [b.getNorthEast(), b.getSouthWest(), b.getNorthWest(), b.getSouthEast()].map((p) => ({ lat: p.lat, lon: p.lng })),
  );
  truncated = q.truncated;
  try {
    const { aircraft, provider } = await fetchLive(q);
    store.upsert(aircraft);
    store.prune(Date.now(), STALE_MS);
    lastProvider = provider;
    lastOkAt = Date.now();
    lastError = null;
    layer.render();
  } catch (e) {
    lastError = e instanceof Error ? e.message.split('\n')[0] ?? 'erro' : 'erro';
    throw e;
  } finally {
    renderStatus();
  }
}

function renderStatus(): void {
  const parts = [`✈ ${store.size}`, `fonte: ${lastProvider}`];
  if (lastOkAt) parts.push(`atualizado há ${fmtAge(lastOkAt)}`);
  if (DATA_MODE === 'direct') parts.push('modo direto');
  statusEl.textContent = parts.join(' · ');
  statusEl.classList.toggle('warn', truncated || !!lastError);
  if (lastError) statusEl.textContent += ` · ⚠ ${lastError}`;
  else if (truncated) statusEl.textContent += ' · aproxime o mapa para ver todos os voos da área';
}

function renderPanel(hex: string | null): void {
  const a = hex ? store.byHex.get(hex) : undefined;
  panel.hidden = !a;
  if (!a) return;
  const rows: [string, string][] = [
    ['Altitude', fmtAltitude(a)],
    ['Velocidade', fmtSpeed(a)],
    ['Rumo', fmtHeading(a)],
    ['Razão vertical', fmtVRate(a)],
    ['Matrícula', a.registration ?? '—'],
    ['Modelo', a.type ?? '—'],
    ['Squawk', a.squawk ?? '—'],
    ['ICAO 24-bit', a.hex.toUpperCase()],
    ['Última posição', `há ${fmtAge(a.positionAt)}`],
  ];
  panel.querySelector('h2')!.textContent = a.callsign ?? a.registration ?? a.hex.toUpperCase();
  panel.querySelector('dl')!.replaceChildren(
    ...rows.flatMap(([k, v]) => {
      const dt = document.createElement('dt');
      dt.textContent = k;
      const dd = document.createElement('dd');
      dd.textContent = v;
      return [dt, dd];
    }),
  );
}

panel.querySelector('button.close')!.addEventListener('click', () => layer.select(null));

map.on('load', () => {
  layer = new AircraftLayer(map, store, renderPanel);
  const poller = new Poller(refresh, POLL_MS);
  let moveTimer: ReturnType<typeof setTimeout>;
  map.on('moveend', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => poller.trigger(), 400);
  });
  setInterval(() => {
    renderStatus();
    renderPanel(layer.selectedHex);
  }, 1000);
  poller.start();

  navigator.geolocation?.getCurrentPosition(
    (pos) => map.jumpTo({ center: [pos.coords.longitude, pos.coords.latitude], zoom: 8 }),
    () => undefined,
    { timeout: 8000, maximumAge: 600_000 },
  );
});
