import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import './style.css';
import { DATA_MODE, fetchAircraftInfo, fetchLive, fetchOfficialFlight, fetchOfficialRoute, fetchRoute, type AircraftInfo } from './api';
import type { FlightAirport, OfficialFlight } from './shared/flight';
import { pruneCache } from './cache';
import { fmtAge, fmtAltitude, fmtHeading, fmtSpeed, fmtVRate } from './format';
import { routeFitsPosition, viewportToQuery } from './geo';
import { AircraftLayer } from './map/aircraftLayer';
import { RouteLayer } from './map/routeLayer';
import { UserLocation } from './map/userLocation';
import { Poller } from './poller';
import { flightProgress, RouteStore, type Airport, type Route } from './routes';
import { AircraftStore } from './store';
import { Toast } from './toast';
import type { Aircraft } from './types';

const POLL_MS = 10_000;
const STALE_MS = 60_000;
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
      'Rotas: <a href="https://www.adsbdb.com" target="_blank" rel="noopener">adsbdb</a> · ' +
      '<a href="https://hexdb.io" target="_blank" rel="noopener">hexdb</a> · ' +
      'Horários: <a href="https://www.flightaware.com" target="_blank" rel="noopener">FlightAware</a>',
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

const fmtClock = (at: number | null) =>
  at === null ? '—' : `≈ ${new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`;

const fmtTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' }) : null;

/** "prevista 18:10 · real 18:22": só o que a fonte tiver. */
function fmtOfficial(scheduled: string | null, estimated: string | null, actual: string | null, actualLabel: string): string {
  const parts = [scheduled && `prevista ${fmtTime(scheduled)}`];
  if (actual) parts.push(`${actualLabel} ${fmtTime(actual)}`);
  else if (estimated && estimated !== scheduled) parts.push(`estimada ${fmtTime(estimated)}`);
  return parts.filter(Boolean).join(' · ') || '—';
}

function fmtDelay(seconds: number | null): string | null {
  if (seconds === null || Math.abs(seconds) < 60) return null;
  return `${Math.round(Math.abs(seconds) / 60)} min ${seconds > 0 ? 'de atraso' : 'adiantado'}`;
}

const fmtGate = (terminal: string | null, gate: string | null) =>
  [terminal && `terminal ${terminal}`, gate && `portão ${gate}`].filter(Boolean).join(' · ') || null;

function officialRows(f: OfficialFlight): [string, string][] {
  const rows: [string, string | null][] = [
    ['Status', f.cancelled ? 'Cancelado' : f.diverted ? 'Desviado' : f.status],
    ['Partida', fmtOfficial(f.scheduledOut, f.estimatedOut, f.actualOut, 'real')],
    ['Atraso na partida', fmtDelay(f.departureDelay)],
    ['Embarque', fmtGate(f.terminalOrigin, f.gateOrigin)],
    ['Chegada', fmtOfficial(f.scheduledIn, f.estimatedIn, f.actualIn, 'real')],
    ['Atraso na chegada', fmtDelay(f.arrivalDelay)],
    ['Desembarque', fmtGate(f.terminalDestination, f.gateDestination)],
    ['Bagagem', f.baggageClaim],
  ];
  return rows.filter((r): r is [string, string] => r[1] !== null);
}

const fmtOfficialAirport = (ap: FlightAirport) => [ap.city, ap.iata ?? ap.icao].filter(Boolean).join(' · ') || '—';

function routeRows(a: Aircraft, route: Route | null | undefined, official: OfficialFlight | null | undefined): [string, string][] {
  if (!a.callsign) return [['Rota', 'indisponível']];
  const rows: [string, string][] = [];
  if (official?.origin && official.destination) {
    rows.push(['Origem', fmtOfficialAirport(official.origin)], ['Destino', fmtOfficialAirport(official.destination)]);
  } else if (route) {
    rows.push(['Origem', fmtAirport(route.origin)], ['Destino', fmtAirport(route.destination)]);
  } else if (route === undefined) {
    rows.push(['Rota', routes.failed(a.callsign) ? 'indisponível' : 'buscando…']);
  } else {
    rows.push(['Rota', 'desconhecida']);
  }
  if (official) rows.push(...officialRows(official));
  if (!route) return rows;
  if (!routeFitsPosition(route.origin, route.destination, a)) {
    rows.push(['Atenção', 'a linha da rota não confere com a posição']);
    return rows;
  }
  const p = flightProgress(route, a, a.speedKmh, Date.now());
  if (!official) rows.push(['Partida (estimada)', fmtClock(p.departedAt)], ['Chegada (estimada)', fmtClock(p.arrivesAt)]);
  rows.push(['Progresso', `${p.percent}% · faltam ${Math.round(p.remainingKm)} km`]);
  return rows;
}

const OFFICIAL_REFRESH_MS = 15 * 60_000;
/** O pedido fica registado mesmo em erro: uma falha só tenta de novo no próximo ciclo, não a cada segundo. */
const officialFlights = new Map<string, { at: number; value: OfficialFlight | null }>();

function wantOfficialFlight(callsign: string): void {
  const known = officialFlights.get(callsign);
  if (known && Date.now() - known.at < OFFICIAL_REFRESH_MS) return;
  const entry = { at: Date.now(), value: known?.value ?? null };
  officialFlights.set(callsign, entry);
  void fetchOfficialFlight(callsign)
    .then(async (value) => {
      entry.value = value;
      if (!value) return;
      // A rota da base gratuita pode estar desatualizada: a linha passa a seguir a oficial.
      const current = routes.get(callsign);
      if (current && current.origin.icao === value.origin?.icao && current.destination.icao === value.destination?.icao) return;
      const route = await fetchOfficialRoute(value, current?.airline ?? null);
      if (route) routes.set(callsign, route);
    })
    .catch(() => undefined);
}

const infoLoading = new Set<string>();
const aircraftInfo = new Map<string, AircraftInfo | null>();

function wantAircraftInfo(hex: string): void {
  if (aircraftInfo.has(hex) || infoLoading.has(hex)) return;
  infoLoading.add(hex);
  void fetchAircraftInfo(hex)
    .then((info) => aircraftInfo.set(hex, info))
    .catch(() => aircraftInfo.set(hex, null))
    .finally(() => infoLoading.delete(hex));
}

/** Só troca a imagem quando muda: o painel redesenha a cada segundo. */
function setImage(img: HTMLImageElement, src: string | null): void {
  const value = src ?? '';
  if (img.dataset.src === value) return;
  img.dataset.src = value;
  img.hidden = !src;
  if (src) img.src = src;
  else img.removeAttribute('src');
}

const logoEl = panel.querySelector<HTMLImageElement>('.logo')!;
logoEl.addEventListener('error', () => (logoEl.hidden = true));

function renderPanel(hex: string | null): void {
  const a = hex ? store.byHex.get(hex) : undefined;
  panel.hidden = !a;
  routeLayer.update(a?.hex ?? null, Date.now());
  if (!a) return;
  if (a.callsign) {
    routes.want(a.callsign, true);
    wantOfficialFlight(a.callsign);
  }
  wantAircraftInfo(a.hex);
  const official = a.callsign ? officialFlights.get(a.callsign)?.value : null;
  const route = a.callsign ? routes.get(a.callsign) : null;
  const info = aircraftInfo.get(a.hex);
  const airline = route?.airline;

  setImage(logoEl, airline?.iata ? `https://pics.avs.io/96/96/${airline.iata}.png` : null);
  panel.querySelector('.airline')!.textContent = airline?.name ?? info?.owner ?? '';
  const routeLine = panel.querySelector<HTMLElement>('.route-line')!;
  const from = official?.origin ?? route?.origin;
  const to = official?.destination ?? route?.destination;
  routeLine.hidden = !from || !to;
  if (from && to) routeLine.textContent = `${from.city ?? from.iata ?? '?'} → ${to.city ?? to.iata ?? '?'}`;

  const figure = panel.querySelector<HTMLElement>('.photo')!;
  figure.hidden = !info?.photo;
  if (info?.photo) {
    setImage(figure.querySelector('img')!, info.photo.src);
    figure.querySelector('a')!.href = info.photo.link;
    figure.querySelector('figcaption')!.textContent = info.photo.credit;
  }

  const rowsRoute = routeRows(a, route, official);
  const note = panel.querySelector<HTMLElement>('.note')!;
  note.hidden = !rowsRoute.some(([k]) => k.startsWith('Partida'));
  note.textContent = official
    ? 'Horários oficiais da FlightAware, na hora do seu dispositivo.'
    : 'Horários estimados pela distância e velocidade atuais; não são os horários oficiais do voo.';
  const rows: [string, string][] = [
    ...rowsRoute,
    ['Aeronave', [info?.manufacturer, info?.model ?? a.type].filter(Boolean).join(' ') || '—'],
    ['Operador', info?.owner ?? '—'],
    ['País de registro', info?.country ?? '—'],
    ['Matrícula', a.registration ?? '—'],
    ['Altitude', fmtAltitude(a)],
    ['Velocidade', fmtSpeed(a)],
    ['Rumo', fmtHeading(a)],
    ['Razão vertical', fmtVRate(a)],
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

const userLocation = new UserLocation(map, new Toast($('#toast')), {
  urlView: !!URL_VIEW,
  onNote: (note) => (locationNote = note),
});
map.addControl(userLocation.control, 'bottom-right');
void userLocation.start();

// Limpa rotas e aeronaves vencidas do cache do navegador, sem atrasar a abertura.
setTimeout(() => pruneCache(), 3000);

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
