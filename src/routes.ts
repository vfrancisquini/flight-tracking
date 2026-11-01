import { CALLSIGN_RE } from './shared/providers';

export interface Airport {
  iata: string | null;
  icao: string | null;
  city: string | null;
  lat: number;
  lon: number;
}

export interface Route {
  origin: Airport;
  destination: Airport;
}

function parseAirport(raw: unknown): Airport | null {
  const a = raw as { iata_code?: string; icao_code?: string; municipality?: string; latitude?: number; longitude?: number } | null;
  if (!a || !Number.isFinite(a.latitude) || !Number.isFinite(a.longitude)) return null;
  return { iata: a.iata_code ?? null, icao: a.icao_code ?? null, city: a.municipality ?? null, lat: a.latitude!, lon: a.longitude! };
}

/** Formato do adsbdb: response.flightroute.{origin,destination}. */
export function parseRoute(raw: unknown): Route | null {
  const r = (raw as { response?: { flightroute?: { origin?: unknown; destination?: unknown } } } | null)?.response?.flightroute;
  const origin = parseAirport(r?.origin);
  const destination = parseAirport(r?.destination);
  return origin && destination ? { origin, destination } : null;
}

const CONCURRENCY = 3;
const RETRY_MS = 5 * 60_000;
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
