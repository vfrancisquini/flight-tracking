import { ENRICH, fetchFirstOk, TELEMETRY_PROVIDERS, type LiveQuery } from './shared/providers';
import { normalizeReadsb } from './normalize';
import { parseRoute, type Route } from './routes';
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

/** null quando a fonte não conhece a rota; lança erro em falha passageira. */
export async function fetchRoute(callsign: string): Promise<Route | null> {
  const url = DATA_MODE === 'proxy' ? `/api/route/${callsign}` : ENRICH.route(callsign);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return parseRoute(await res.json());
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
    const params = new URLSearchParams({ lat: q.lat.toFixed(2), lon: q.lon.toFixed(2), dist: String(Math.ceil(q.distNm)) });
    const res = await fetch(`/api/live?${params}`, { signal: AbortSignal.timeout(15000) });
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
