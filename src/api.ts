import { ENRICH, fetchFirstOk, MAX_RADIUS_NM, TELEMETRY_PROVIDERS, type LiveQuery } from './shared/providers';
import type { OfficialFlight } from './shared/flight';
import { AIRCRAFT_CACHE, cached, FLIGHT_CACHE, ROUTE_CACHE } from './cache';
import { normalizeReadsb } from './normalize';
import { parseAirline, parseHexdbAirport, parseHexdbRoute, parseRoute, type Airline, type Route } from './routes';
import type { Aircraft } from './types';

/**
 * "proxy" (produção): tudo passa pelo Worker em /api (mesma origem, cache, failover).
 * "direct" (dev): o navegador chama as APIs diretamente — só funciona se tiverem CORS.
 */
export const DATA_MODE: 'proxy' | 'direct' = import.meta.env.VITE_DATA_MODE === 'direct' ? 'direct' : 'proxy';

export interface LiveResult {
  aircraft: Aircraft[];
  provider: string;
}

/**
 * null quando a fonte não conhece a rota; lança erro em falha passageira.
 * Direto do navegador (o adsbdb tem CORS): pelo Worker, o IP partilhado da
 * Cloudflare recebe 429. Guarda no navegador para não repetir pedidos ao recarregar.
 */
export async function fetchRoute(callsign: string): Promise<Route | null> {
  return cached(ROUTE_CACHE, callsign, async () => {
    const route = parseRoute(await getJson(ENRICH.route(callsign)));
    return route ?? fetchHexdbRoute(callsign);
  });
}

/** Segunda fonte, para voos que o adsbdb não conhece. Falhas aqui contam como "sem rota". */
async function fetchHexdbRoute(callsign: string): Promise<Route | null> {
  try {
    const codes = parseHexdbRoute(await getJson(ENRICH.hexdbRoute(callsign)));
    if (!codes) return null;
    const [origin, destination, airlines] = await Promise.all([
      getJson(ENRICH.hexdbAirport(codes.origin)),
      getJson(ENRICH.hexdbAirport(codes.destination)),
      getJson(ENRICH.airline(callsign.slice(0, 3))).catch(() => null),
    ]);
    const o = parseHexdbAirport(origin);
    const d = parseHexdbAirport(destination);
    const list = (airlines as { response?: unknown[] } | null)?.response;
    return o && d ? { origin: o, destination: d, airline: parseAirline(Array.isArray(list) ? list[0] : null) } : null;
  } catch {
    return null;
  }
}

export interface AircraftInfo {
  manufacturer: string | null;
  model: string | null;
  owner: string | null;
  country: string | null;
  photo: { src: string; link: string; credit: string } | null;
}

/** Fabricante, modelo, dono e foto. As duas fontes têm CORS. null se nenhuma conhecer o avião. */
export async function fetchAircraftInfo(hex: string): Promise<AircraftInfo | null> {
  return cached(AIRCRAFT_CACHE, hex, async () => {
    const [details, photos] = await Promise.all([
      getJson(ENRICH.aircraft(hex)).catch(() => null),
      getJson(ENRICH.photo(hex)).catch(() => null),
    ]);
    const a = (details as { response?: { aircraft?: Record<string, string | null> } } | null)?.response?.aircraft;
    const p = (photos as { photos?: { thumbnail_large?: { src?: string }; link?: string; photographer?: string }[] } | null)?.photos?.[0];
    const src = p?.thumbnail_large?.src;
    const photo = src ? { src, link: p?.link ?? src, credit: `© ${p?.photographer ?? 'Planespotters.net'} / Planespotters.net` } : null;
    if (!a && !photo) return null;
    return { manufacturer: a?.manufacturer ?? null, model: a?.type ?? null, owner: a?.registered_owner ?? null, country: a?.registered_owner_country_name ?? null, photo };
  });
}

/** Corpo JSON; null em 404; lança erro nas outras falhas. */
async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

/**
 * Horários e status oficiais, só para o voo aberto no painel (cada consulta é paga).
 * null se a fonte não conhecer o voo; lança erro se estiver indisponível ou no teto de gastos.
 */
export async function fetchOfficialFlight(callsign: string): Promise<OfficialFlight | null> {
  return cached(FLIGHT_CACHE, callsign, async () => {
    const res = await fetch(`/api/flight/${callsign}`, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return (await res.json()) as OfficialFlight | null;
  });
}

/** A AeroAPI não dá coordenadas: busca no hexdb para desenhar a rota oficial no mapa. null se faltar algum aeroporto. */
export async function fetchOfficialRoute(flight: OfficialFlight, airline: Airline | null): Promise<Route | null> {
  const { origin, destination } = flight;
  if (!origin?.icao || !destination?.icao) return null;
  const [o, d] = await Promise.all([getJson(ENRICH.hexdbAirport(origin.icao)), getJson(ENRICH.hexdbAirport(destination.icao))]);
  const from = parseHexdbAirport(o);
  const to = parseHexdbAirport(d);
  if (!from || !to) return null;
  return { origin: { ...origin, lat: from.lat, lon: from.lon }, destination: { ...destination, lat: to.lat, lon: to.lon }, airline };
}

/** Localização aproximada pelo IP, calculada pelo Worker. null se não houver. */
export async function fetchIpLocation(): Promise<{ lat: number; lon: number } | null> {
  try {
    const res = await fetch('/api/geo', { signal: AbortSignal.timeout(5000) });
    return res.ok ? ((await res.json()) as { lat: number; lon: number }) : null;
  } catch {
    return null;
  }
}

export async function fetchLive(q: LiveQuery): Promise<LiveResult> {
  const receivedAt = Date.now();
  if (DATA_MODE === 'proxy') {
    // Centro e raio arredondados (com folga): pequenos movimentos reaproveitam o cache do Worker.
    const dist = Math.min(MAX_RADIUS_NM, Math.ceil((q.distNm + 6) / 25) * 25);
    const params = new URLSearchParams({ lat: q.lat.toFixed(1), lon: q.lon.toFixed(1), dist: String(dist) });
    const res = await fetch(`/api/live?${params}`, { signal: AbortSignal.timeout(15000) });
    if (res.status === 502) throw new Error('fonte de voos ocupada, tentando de novo');
    if (!res.ok) throw new Error(`Worker respondeu HTTP ${res.status}`);
    return { aircraft: normalizeReadsb(await res.json(), receivedAt), provider: res.headers.get('x-provider') ?? '?' };
  }
  const { res, index } = await fetchFirstOk(TELEMETRY_PROVIDERS.map((p) => p.live(q))).catch((e: unknown) => {
    // Em modo direto, "Failed to fetch" quase sempre significa CORS bloqueado.
    throw new Error(`nenhuma fonte respondeu ao navegador (CORS ou rede): ${e instanceof Error ? e.message.split('\n')[1] ?? '' : ''}`);
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return { aircraft: normalizeReadsb(await res.json(), receivedAt), provider: TELEMETRY_PROVIDERS[index]?.name ?? '?' };
}
