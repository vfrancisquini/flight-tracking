import { haversineKm, type LatLon } from './geo';
import { CALLSIGN_RE } from './shared/providers';

export interface Airport {
  iata: string | null;
  icao: string | null;
  city: string | null;
  lat: number;
  lon: number;
}

export interface Airline {
  name: string;
  iata: string | null;
  country: string | null;
}

export interface Route {
  origin: Airport;
  destination: Airport;
  airline: Airline | null;
}

function parseAirport(raw: unknown): Airport | null {
  const a = raw as { iata_code?: string; icao_code?: string; municipality?: string; latitude?: number; longitude?: number } | null;
  if (!a || !Number.isFinite(a.latitude) || !Number.isFinite(a.longitude)) return null;
  return { iata: a.iata_code ?? null, icao: a.icao_code ?? null, city: a.municipality ?? null, lat: a.latitude!, lon: a.longitude! };
}

export function parseAirline(raw: unknown): Airline | null {
  const a = raw as { name?: string; iata?: string; country?: string } | null;
  return a?.name ? { name: a.name, iata: a.iata ?? null, country: a.country ?? null } : null;
}

/** Formato do adsbdb: response.flightroute.{origin,destination,airline}. */
export function parseRoute(raw: unknown): Route | null {
  const r = (raw as { response?: { flightroute?: { origin?: unknown; destination?: unknown; airline?: unknown } } } | null)?.response?.flightroute;
  const origin = parseAirport(r?.origin);
  const destination = parseAirport(r?.destination);
  return origin && destination ? { origin, destination, airline: parseAirline(r?.airline) } : null;
}

/** Formato do hexdb: {"route":"GCTS-LFLL"}. Com escalas, fica com o primeiro e o último. */
export function parseHexdbRoute(raw: unknown): { origin: string; destination: string } | null {
  const codes = (raw as { route?: string } | null)?.route?.split('-') ?? [];
  return codes.length >= 2 ? { origin: codes[0]!, destination: codes.at(-1)! } : null;
}

export function parseHexdbAirport(raw: unknown): Airport | null {
  const a = raw as { iata?: string; icao?: string; airport?: string; region_name?: string; latitude?: number; longitude?: number } | null;
  if (!a || !Number.isFinite(a.latitude) || !Number.isFinite(a.longitude)) return null;
  return { iata: a.iata ?? null, icao: a.icao ?? null, city: a.airport ?? a.region_name ?? null, lat: a.latitude!, lon: a.longitude! };
}

export interface Progress {
  percent: number;
  remainingKm: number;
  /** Epoch (ms). Estimativas pela distância e velocidade, não horários oficiais. */
  departedAt: number | null;
  arrivesAt: number | null;
}

/** Abaixo disto o avião está a subir ou a aproximar-se e a conta deixa de fazer sentido. */
const MIN_ESTIMATE_KMH = 300;

export function flightProgress(route: Route, position: LatLon, speedKmh: number | null, now: number): Progress {
  const flownKm = haversineKm(route.origin, position);
  const remainingKm = haversineKm(position, route.destination);
  const usable = speedKmh !== null && speedKmh >= MIN_ESTIMATE_KMH;
  return {
    percent: Math.round((100 * flownKm) / Math.max(1, flownKm + remainingKm)),
    remainingKm,
    departedAt: usable ? now - (flownKm / speedKmh) * 3600_000 : null,
    arrivesAt: usable ? now + (remainingKm / speedKmh) * 3600_000 : null,
  };
}

const CONCURRENCY = 3;
const RETRY_MS = 60_000;
/** Pausa da fila depois de uma falha, para não insistir numa API gratuita que limitou pedidos. */
const PAUSE_MS = 30_000;

/** Rotas por callsign, buscadas aos poucos. null = a fonte não conhece a rota. */
export class RouteStore {
  private readonly known = new Map<string, Route | null>();
  private readonly retryAt = new Map<string, number>();
  private readonly inFlight = new Set<string>();
  private queue: string[] = [];
  private pausedUntil = 0;
  private wake: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly fetcher: (callsign: string) => Promise<Route | null>) {}

  get(callsign: string): Route | null | undefined {
    return this.known.get(callsign);
  }

  failed(callsign: string): boolean {
    return (this.retryAt.get(callsign) ?? 0) > Date.now();
  }

  /** Pede a rota. `urgent` passa à frente da fila (avião selecionado). */
  want(callsign: string, urgent = false): void {
    if (!CALLSIGN_RE.test(callsign) || this.known.has(callsign) || this.inFlight.has(callsign) || this.failed(callsign)) return;
    const i = this.queue.indexOf(callsign);
    if (i >= 0) {
      if (!urgent) return;
      this.queue.splice(i, 1);
    }
    if (urgent) this.queue.unshift(callsign);
    else this.queue.push(callsign);
    this.pump();
  }

  private pump(): void {
    const wait = this.pausedUntil - Date.now();
    if (wait > 0) {
      this.wake ??= setTimeout(() => {
        this.wake = null;
        this.pump();
      }, wait);
      return;
    }
    while (this.inFlight.size < CONCURRENCY && this.queue.length) void this.load(this.queue.shift()!);
  }

  private async load(callsign: string): Promise<void> {
    this.inFlight.add(callsign);
    try {
      this.known.set(callsign, await this.fetcher(callsign));
    } catch {
      this.retryAt.set(callsign, Date.now() + RETRY_MS);
      this.pausedUntil = Date.now() + PAUSE_MS;
    } finally {
      this.inFlight.delete(callsign);
      this.pump();
    }
  }
}
