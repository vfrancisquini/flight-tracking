import { fetchFirstOk, TELEMETRY_PROVIDERS, type LiveQuery } from './shared/providers';
import { normalizeReadsb } from './normalize';
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
