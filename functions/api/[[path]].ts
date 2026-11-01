/**
 * Worker mínimo (Cloudflare Pages Function) servido em /api/*.
 * - Mesma origem que o site → sem problemas de CORS.
 * - Cache na edge (TTL por tipo de dado) → poupa as APIs comunitárias.
 * - Failover entre fornecedores de telemetria.
 * Só monta URLs a partir de parâmetros validados (sem proxy aberto / SSRF).
 *
 *   GET /api/live?lat=&lon=&dist=   telemetria por raio (NM, máx. 250)
 *   GET /api/callsign/:cs            procurar voo pelo callsign (global)
 *   GET /api/hex/:hex                procurar aeronave pelo ICAO 24-bit
 *   GET /api/route/:cs               origem/destino (adsbdb)
 *   GET /api/aircraft/:hex           matrícula/modelo/operador (adsbdb)
 *   GET /api/photo/:hex              foto (planespotters)
 */
import {
  CALLSIGN_RE,
  ENRICH,
  fetchFirstOk,
  HEX_RE,
  parseLiveQuery,
  TELEMETRY_PROVIDERS,
} from '../../src/shared/providers';

interface Ctx {
  request: Request;
  params: { path?: string | string[] };
  waitUntil(p: Promise<unknown>): void;
}

const USER_AGENT = 'radar-voos/0.1 (projeto pessoal, nao comercial)';

/** Segundos de cache na edge por tipo. */
const TTL = { live: 5, lookup: 10, route: 86_400, aircraft: 604_800, photo: 86_400 } as const;
const STALE_TTL = 120;

interface Plan {
  urls: string[];
  ttl: number;
  names: string[];
}

function plan(kind: string | undefined, arg: string | undefined, search: URLSearchParams): Plan | Response {
  const telemetry = (f: (p: (typeof TELEMETRY_PROVIDERS)[number]) => string, ttl: number): Plan => ({
    urls: TELEMETRY_PROVIDERS.map(f),
    names: TELEMETRY_PROVIDERS.map((p) => p.name),
    ttl,
  });
  const cs = (arg ?? '').toUpperCase();
  const hex = (arg ?? '').toLowerCase();

  switch (kind) {
    case 'live': {
      const q = parseLiveQuery(search.get('lat'), search.get('lon'), search.get('dist'));
      return q ? telemetry((p) => p.live(q), TTL.live) : bad('lat, lon e dist são obrigatórios');
    }
    case 'callsign':
      return CALLSIGN_RE.test(cs) ? telemetry((p) => p.callsign(cs), TTL.lookup) : bad('callsign inválido');
    case 'hex':
      return HEX_RE.test(hex) ? telemetry((p) => p.hex(hex), TTL.lookup) : bad('hex inválido');
    case 'route':
      return CALLSIGN_RE.test(cs) ? { urls: [ENRICH.route(cs)], names: ['adsbdb'], ttl: TTL.route } : bad('callsign inválido');
    case 'aircraft':
      return HEX_RE.test(hex) ? { urls: [ENRICH.aircraft(hex)], names: ['adsbdb'], ttl: TTL.aircraft } : bad('hex inválido');
    case 'photo':
      return HEX_RE.test(hex) ? { urls: [ENRICH.photo(hex)], names: ['planespotters'], ttl: TTL.photo } : bad('hex inválido');
    default:
      return json({ error: 'not_found' }, 404);
  }
}

export async function onRequestGet(ctx: Ctx): Promise<Response> {
  const url = new URL(ctx.request.url);
  const segs = Array.isArray(ctx.params.path) ? ctx.params.path : [ctx.params.path ?? ''];
  const p = plan(segs[0], segs[1], url.searchParams);
  if (p instanceof Response) return p;

  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(url.toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  // Última resposta boa da telemetria, para aguentar 429 passageiros da fonte.
  const staleKey = segs[0] === 'live' ? new Request(`${url.origin}/__stale${url.pathname}${url.search}`, { method: 'GET' }) : null;

  try {
    const { res, index } = await fetchFirstOk(p.urls, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    const out = new Response(await res.arrayBuffer(), {
      status: res.status,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': `public, max-age=${p.ttl}`,
        'x-provider': p.names[index] ?? '?',
      },
    });
    // 404 também é informação útil (ex.: callsign sem rota conhecida) — cacheia.
    if (res.ok || res.status === 404) ctx.waitUntil(cache.put(key, out.clone()));
    if (staleKey && res.ok) {
      const headers = new Headers(out.headers);
      headers.set('cache-control', `public, max-age=${STALE_TTL}`);
      ctx.waitUntil(cache.put(staleKey, new Response(out.clone().body, { headers })));
    }
    return out;
  } catch (e) {
    console.error(e);
    const stale = staleKey && (await cache.match(staleKey));
    if (stale) {
      const headers = new Headers(stale.headers);
      headers.set('cache-control', 'no-store');
      headers.set('x-provider', `${stale.headers.get('x-provider') ?? '?'} (dados em cache)`);
      return new Response(stale.body, { headers });
    }
    return json({ error: 'upstream_unavailable', detail: e instanceof Error ? e.message : String(e) }, 502);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function bad(message: string): Response {
  return json({ error: 'bad_request', message }, 400);
}
