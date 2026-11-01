/**
 * Catálogo de fontes de dados, partilhado entre o cliente (modo "direct")
 * e o Worker (functions/api). Todas as fontes de telemetria falam o formato
 * readsb v2 (array `ac`), por isso trocar de fornecedor é só mudar a ordem.
 */

export interface LiveQuery {
  lat: number;
  lon: number;
  /** Raio em milhas náuticas (máx. MAX_RADIUS_NM). */
  distNm: number;
}

export interface TelemetryProvider {
  id: string;
  name: string;
  live(q: LiveQuery): string;
  callsign(cs: string): string;
  hex(hex: string): string;
}

export const MAX_RADIUS_NM = 250;
export const CALLSIGN_RE = /^[A-Z0-9]{2,8}$/;
export const HEX_RE = /^[0-9a-f]{6}$/;

const c = (n: number) => n.toFixed(2);
const d = (n: number) => Math.max(1, Math.min(MAX_RADIUS_NM, Math.ceil(n)));

/** Ordem = prioridade de failover. */
export const TELEMETRY_PROVIDERS: TelemetryProvider[] = [
  {
    id: 'adsblol',
    name: 'adsb.lol',
    live: (q) => `https://api.adsb.lol/v2/lat/${c(q.lat)}/lon/${c(q.lon)}/dist/${d(q.distNm)}`,
    callsign: (cs) => `https://api.adsb.lol/v2/callsign/${cs}`,
    hex: (h) => `https://api.adsb.lol/v2/hex/${h}`,
  },
  {
    id: 'adsbfi',
    name: 'adsb.fi',
    live: (q) => `https://opendata.adsb.fi/api/v2/lat/${c(q.lat)}/lon/${c(q.lon)}/dist/${d(q.distNm)}`,
    callsign: (cs) => `https://opendata.adsb.fi/api/v2/callsign/${cs}`,
    hex: (h) => `https://opendata.adsb.fi/api/v2/hex/${h}`,
  },
  {
    id: 'airplaneslive',
    name: 'airplanes.live',
    live: (q) => `https://api.airplanes.live/v2/point/${c(q.lat)}/${c(q.lon)}/${d(q.distNm)}`,
    callsign: (cs) => `https://api.airplanes.live/v2/callsign/${cs}`,
    hex: (h) => `https://api.airplanes.live/v2/hex/${h}`,
  },
];

export const ENRICH = {
  route: (cs: string) => `https://api.adsbdb.com/v0/callsign/${cs}`,
  airline: (icao: string) => `https://api.adsbdb.com/v0/airline/${icao}`,
  hexdbRoute: (cs: string) => `https://hexdb.io/api/v1/route/icao/${cs}`,
  hexdbAirport: (icao: string) => `https://hexdb.io/api/v1/airport/icao/${icao}`,
  aircraft: (hex: string) => `https://api.adsbdb.com/v0/aircraft/${hex}`,
  photo: (hex: string) => `https://api.planespotters.net/pub/photos/hex/${hex}`,
};

export function parseLiveQuery(lat: unknown, lon: unknown, dist: unknown): LiveQuery | null {
  const q = { lat: Number(lat), lon: Number(lon), distNm: Number(dist) };
  if (![q.lat, q.lon, q.distNm].every(Number.isFinite)) return null;
  if (Math.abs(q.lat) > 90 || Math.abs(q.lon) > 180 || q.distNm <= 0) return null;
  q.distNm = Math.min(q.distNm, MAX_RADIUS_NM);
  return q;
}

/** Status que justificam tentar o próximo fornecedor. */
const RETRYABLE = (s: number) => s === 403 || s === 408 || s === 429 || s >= 500;

/**
 * Tenta cada URL por ordem e devolve a primeira resposta não-retentável
 * (2xx ou 4xx definitivo como 404). Lança erro se todas falharem.
 */
export async function fetchFirstOk(
  urls: string[],
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<{ res: Response; index: number }> {
  const errors: string[] = [];
  for (const [index, url] of urls.entries()) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (!RETRYABLE(res.status)) return { res, index };
      errors.push(`${url} → HTTP ${res.status}`);
    } catch (e) {
      errors.push(`${url} → ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(`Todas as fontes falharam:\n${errors.join('\n')}`);
}
