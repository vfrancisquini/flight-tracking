/**
 * Worker mínimo (Cloudflare Pages Function) servido em /api/*.
 * - Mesma origem que o site → sem problemas de CORS.
 * - Cache na edge (TTL por tipo de dado) → poupa as APIs comunitárias.
 * - Failover entre fornecedores de telemetria.
 * Só monta URLs a partir de parâmetros validados (sem proxy aberto / SSRF).
 *
 * Rotas, dados da aeronave e fotos NÃO passam por aqui: essas APIs têm CORS e o
 * adsbdb responde 429 ao IP partilhado da Cloudflare, por isso o navegador chama-as direto.
 *
 *   GET /api/live?lat=&lon=&dist=   telemetria por raio (NM, máx. 250)
 *   GET /api/callsign/:cs            procurar voo pelo callsign (global)
 *   GET /api/hex/:hex                procurar aeronave pelo ICAO 24-bit
 *   GET /api/geo                     localização aproximada do visitante, pelo IP (dados da Cloudflare)
 *   GET /api/flight/:cs              horários, status e portões oficiais (FlightAware, paga: tem teto)
 */
import { parseOfficialFlight } from '../../src/shared/flight';
import {
  CALLSIGN_RE,
  fetchFirstOk,
  HEX_RE,
  parseLiveQuery,
  TELEMETRY_PROVIDERS,
} from '../../src/shared/providers';

interface Ctx {
  request: Request & { cf?: { latitude?: string; longitude?: string } };
  params: { path?: string | string[] };
  waitUntil(p: Promise<unknown>): void;
  env?: { flightaware_key?: string; AEROAPI_BUDGET?: BudgetStore };
}

interface BudgetStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

const USER_AGENT = 'radar-voos/0.1 (projeto pessoal, nao comercial)';

/** Segundos de cache na edge por tipo. */
const TTL = { live: 5, lookup: 10, flight: 900 } as const;
const STALE_TTL = 120;
/** A US$ 0,005 por consulta: 800 = US$ 4, abaixo do crédito mensal de US$ 5 da FlightAware. */
const AEROAPI_MONTH_CAP = 800;
const AEROAPI_DAY_CAP = 60;

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
    default:
      return json({ error: 'not_found' }, 404);
  }
}

export async function onRequestGet(ctx: Ctx): Promise<Response> {
  const url = new URL(ctx.request.url);
  const segs = Array.isArray(ctx.params.path) ? ctx.params.path : [ctx.params.path ?? ''];
  if (segs[0] === 'geo') return geo(ctx.request);
  if (segs[0] === 'flight') return flight(ctx, url, (segs[1] ?? '').toUpperCase());
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
    // 404 também é informação útil (ex.: hex desconhecido) — cacheia.
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

/** Reserva uma consulta no orçamento. Sem contador disponível não gasta: falha fechada. */
async function reserveBudget(store: BudgetStore | undefined, now: Date): Promise<boolean> {
  if (!store) return false;
  const month = `month:${now.toISOString().slice(0, 7)}`;
  const day = `day:${now.toISOString().slice(0, 10)}`;
  try {
    const [usedMonth, usedDay] = await Promise.all([store.get(month), store.get(day)]);
    const m = Number(usedMonth ?? 0);
    const d = Number(usedDay ?? 0);
    if (m >= AEROAPI_MONTH_CAP || d >= AEROAPI_DAY_CAP) return false;
    await Promise.all([
      store.put(month, String(m + 1), { expirationTtl: 40 * 86_400 }),
      store.put(day, String(d + 1), { expirationTtl: 2 * 86_400 }),
    ]);
    return true;
  } catch (e) {
    console.error(e);
    return false;
  }
}

async function flight(ctx: Ctx, url: URL, cs: string): Promise<Response> {
  if (!CALLSIGN_RE.test(cs)) return bad('callsign inválido');
  // Cada consulta custa dinheiro: só para o próprio site. O teto cobre quem falsificar este cabeçalho.
  const site = ctx.request.headers.get('sec-fetch-site');
  if (site && site !== 'same-origin') return json({ error: 'forbidden' }, 403);
  const apiKey = ctx.env?.flightaware_key;
  if (!apiKey) return json({ error: 'not_configured' }, 503);

  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request(`${url.origin}/__flight/${cs}`, { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;

  if (!(await reserveBudget(ctx.env?.AEROAPI_BUDGET, new Date()))) return json({ error: 'budget_exhausted' }, 429);
  try {
    const res = await fetch(`https://aeroapi.flightaware.com/aeroapi/flights/${cs}?ident_type=designator&max_pages=1`, {
      headers: { 'x-apikey': apiKey, Accept: 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status !== 404 && !res.ok) {
      console.error(`AeroAPI HTTP ${res.status}`);
      return json({ error: 'upstream_unavailable', status: res.status }, 502);
    }
    const parsed = res.ok ? parseOfficialFlight(await res.json(), Date.now()) : null;
    const out = new Response(JSON.stringify(parsed), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${TTL.flight}` },
    });
    ctx.waitUntil(cache.put(key, out.clone()));
    return out;
  } catch (e) {
    console.error(e);
    return json({ error: 'upstream_unavailable' }, 502);
  }
}

/** Específico de cada visitante: nunca entra em cache nem é registado. */
function geo(request: Ctx['request']): Response {
  const lat = parseFloat(request.cf?.latitude ?? '');
  const lon = parseFloat(request.cf?.longitude ?? '');
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return json({ error: 'not_found' }, 404);
  return new Response(JSON.stringify({ lat, lon }), {
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });
}

function bad(message: string): Response {
  return json({ error: 'bad_request', message }, 400);
}
