import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { DATA_MODE, fetchIpLocation, fetchLive, fetchRoute } from './api';
import { fmtAge, fmtAltitude, fmtHeading, fmtSpeed, fmtVRate } from './format';
import { routeFitsPosition, viewportToQuery } from './geo';
import { AircraftLayer } from './map/aircraftLayer';
import { RouteLayer } from './map/routeLayer';
import { Poller } from './poller';
import { RouteStore, type Airport } from './routes';
import { AircraftStore } from './store';
import type { Aircraft } from './types';

const POLL_MS = 10_000;
const STALE_MS = 60_000;
const LOCATED_ZOOM = 9;
const FALLBACK_VIEW = { center: [-46.63, -23.55] as [number, number], zoom: 7 }; // São Paulo

/** Vista inicial vinda da URL: ?lat=38.8777&lon=-9.0815&z=10 (tem prioridade sobre a localização). */
function viewFromUrl(): { center: [number, number]; zoom: number } | null {
  const qs = new URLSearchParams(location.search);
  const lat = Number(qs.get('lat'));
  const lon = Number(qs.get('lon'));
  if (!qs.has('lat') || !qs.has('lon') || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const z = Number(qs.get('z'));
  return { center: [lon, lat], zoom: Number.isFinite(z) && z > 0 && z <= 20 ? z : 10 };
}
const URL_VIEW = viewFromUrl();

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;
const statusEl = $('#status');
const panel = $<HTMLElement>('#panel');

const map = new maplibregl.Map({
  container: 'map',
  style: 'https://tiles.openfreemap.org/styles/dark',
  ...(URL_VIEW ?? FALLBACK_VIEW),
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
const routes = new RouteStore(fetchRoute);
let layer: AircraftLayer;
let routeLayer: RouteLayer;
let locationNote = '';
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
    for (const a of aircraft) if (a.callsign && !a.onGround) routes.want(a.callsign);
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
  if (locationNote) parts.push(locationNote);
  statusEl.textContent = parts.join(' · ');
  statusEl.classList.toggle('warn', truncated || !!lastError);
  if (lastError) statusEl.textContent += ` · ⚠ ${lastError}`;
  else if (truncated) statusEl.textContent += ' · aproxime o mapa para ver todos os voos da área';
}

const fmtAirport = (ap: Airport) => [ap.city, ap.iata ?? ap.icao].filter(Boolean).join(' · ') || '—';

function routeRows(a: Aircraft): [string, string][] {
  if (!a.callsign) return [['Rota', 'indisponível']];
  routes.want(a.callsign, true);
  const route = routes.get(a.callsign);
  if (route === undefined) return [['Rota', routes.failed(a.callsign) ? 'indisponível' : 'buscando…']];
  if (route === null) return [['Rota', 'desconhecida']];
  const rows: [string, string][] = [['Origem', fmtAirport(route.origin)], ['Destino', fmtAirport(route.destination)]];
  if (!routeFitsPosition(route.origin, route.destination, a)) rows.push(['Atenção', 'a rota não confere com a posição']);
  return rows;
}

function renderPanel(hex: string | null): void {
  const a = hex ? store.byHex.get(hex) : undefined;
  panel.hidden = !a;
  routeLayer.update(a?.hex ?? null, Date.now());
  if (!a) return;
  const rows: [string, string][] = [
    ...routeRows(a),
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

// Se o mapa base não carregar, dizer porquê em vez de ficar em "Carregando…".
map.on('error', (e) => {
  if (map.loaded()) return;
  statusEl.classList.add('warn');
  statusEl.textContent = `⚠ Não foi possível carregar o mapa base: ${e.error?.message ?? 'erro de rede'}`;
});

/**
 * Abre logo no local aproximado pelo IP e passa para o GPS se for autorizado.
 * Só move o mapa se a URL não indicar a vista e o utilizador ainda não o tiver mexido.
 */
function startLocation(): void {
  const dot = document.createElement('div');
  const marker = new maplibregl.Marker({ element: dot });
  let userMoved = !!URL_VIEW;
  let hasGps = false;
  map.on('dragstart', () => (userMoved = true));
  map.on('zoomstart', (e) => {
    if ('originalEvent' in e) userMoved = true;
  });

  const place = (lat: number, lon: number, approximate: boolean) => {
    dot.className = approximate ? 'me-dot approx' : 'me-dot';
    dot.title = approximate ? 'Sua localização aproximada (pelo IP)' : 'Sua localização';
    locationNote = approximate ? 'localização aproximada (IP)' : '';
    marker.setLngLat([lon, lat]).addTo(map);
    if (!userMoved) map.jumpTo({ center: [lon, lat], zoom: LOCATED_ZOOM });
  };

  void fetchIpLocation().then((ip) => {
    if (ip && !hasGps) place(ip.lat, ip.lon, true);
  });
  navigator.geolocation?.getCurrentPosition(
    (pos) => {
      hasGps = true;
      place(pos.coords.latitude, pos.coords.longitude, false);
    },
    () => undefined,
    { timeout: 8000, maximumAge: 600_000 },
  );
}
startLocation();

map.on('load', () => {
  routeLayer = new RouteLayer(map, store, routes);
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
});
