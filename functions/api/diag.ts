/** TEMPORÁRIO: testa as chaves a partir da Cloudflare. Exige token, esconde as chaves e será removido. */
interface Env {
  opensky_client?: string;
  opensky_key?: string;
  airlabs_key?: string;
  openaip_key?: string;
  flightaware_key?: string;
}
interface Ctx {
  request: Request & { cf?: Record<string, unknown> };
  env: Env;
}

const TOKEN_SHA256 = '8a845a939631d0640b9d94e2488a206267ba014bc1c3c74d9d22aaa8889de4f4';
const UA = { 'User-Agent': 'radar-voos/0.1 (projeto pessoal, nao comercial)', Accept: 'application/json' };
const BBOX = 'lamin=37.5&lomin=-10.5&lamax=40&lomax=-7.5';

async function sha256(text: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function openskyToken(env: Env): Promise<{ status: number; token?: string; expires?: number; error?: string }> {
  const res = await fetch('https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: env.opensky_client ?? '', client_secret: env.opensky_key ?? '' }),
  });
  const text = await res.text();
  if (!res.ok) return { status: res.status, error: text.slice(0, 300) };
  const j = JSON.parse(text) as { access_token: string; expires_in: number };
  return { status: res.status, token: j.access_token, expires: j.expires_in };
}

export async function onRequestGet({ request, env }: Ctx): Promise<Response> {
  if ((await sha256(request.headers.get('x-diag-token') ?? '')) !== TOKEN_SHA256) return new Response('not found', { status: 404 });
  const q = new URL(request.url).searchParams;
  const test = q.get('t') ?? '';
  const hex = q.get('hex') ?? '4951d1';
  const ident = q.get('ident') ?? 'TAP1';
  const now = Math.floor(Date.now() / 1000);
  const air = (path: string) => `https://airlabs.co/api/v9/${path}${path.includes('?') ? '&' : '?'}api_key=${env.airlabs_key}`;
  const aip = (path: string) => `https://api.core.openaip.net/api/${path}`;
  const aipHeaders = { ...UA, 'x-openaip-api-key': env.openaip_key ?? '' };
  const near = 'pos=38.77,-9.13&dist=30000&limit=2';

  if (test === 'env') {
    return Response.json({
      keys: Object.fromEntries((['opensky_client', 'opensky_key', 'airlabs_key', 'openaip_key', 'flightaware_key'] as const).map((k) => [k, !!env[k]])),
      cfFields: Object.keys(request.cf ?? {}),
      colo: request.cf?.colo,
    });
  }
  if (test === 'opensky_token') {
    const t = await openskyToken(env);
    return Response.json({ status: t.status, ok: !!t.token, expires: t.expires, error: t.error });
  }

  let url: string;
  let headers: Record<string, string> = UA;
  const opensky = test.startsWith('opensky_') && test !== 'opensky_anon';
  if (opensky) {
    const t = await openskyToken(env);
    if (!t.token) return Response.json({ tokenStatus: t.status, error: t.error });
    headers = { ...UA, Authorization: `Bearer ${t.token}` };
  }
  const urls: Record<string, string> = {
    opensky_states: `https://opensky-network.org/api/states/all?${BBOX}&extended=1`,
    opensky_arrival: `https://opensky-network.org/api/flights/arrival?airport=LPPT&begin=${now - 2 * 86400}&end=${now - 86400}`,
    opensky_departure: `https://opensky-network.org/api/flights/departure?airport=LPPT&begin=${now - 2 * 86400}&end=${now - 86400}`,
    opensky_aircraft: `https://opensky-network.org/api/flights/aircraft?icao24=${hex}&begin=${now - 2 * 86400}&end=${now}`,
    opensky_track: `https://opensky-network.org/api/tracks/all?icao24=${hex}&time=0`,
    airlabs_ping: air('ping'),
    airlabs_flights: air('flights?bbox=37.5,-10.5,40,-7.5&_fields='),
    airlabs_flight: air(`flight?flight_icao=${ident}`),
    airlabs_schedules: air('schedules?dep_iata=LIS&limit=2'),
    airlabs_routes: air('routes?dep_iata=LIS&limit=2'),
    airlabs_airports: air('airports?iata_code=LIS'),
    airlabs_airlines: air('airlines?iata_code=TP'),
    airlabs_fleets: air(`fleets?hex=${hex}`),
    airlabs_nearby: air('nearby?lat=38.77&lng=-9.13&distance=30'),
    airlabs_suggest: air('suggest?q=Lisb'),
    openaip_query: aip(`airports?${near}&apiKey=${env.openaip_key}`),
    openaip_noua: aip(`airports?${near}`),
    opensky_anon: 'https://opensky-network.org/api/states/all?lamin=38&lomin=-10&lamax=39&lomax=-9',
    airlabs_hex: air(`flights?hex=${hex}`),
    openaip_airports: aip(`airports?${near}`),
    openaip_airspaces: aip(`airspaces?${near}`),
    openaip_navaids: aip(`navaids?${near}`),
    openaip_obstacles: aip(`obstacles?${near}`),
    openaip_reporting: aip(`reporting-points?${near}`),
    aeroapi_flight: `https://aeroapi.flightaware.com/aeroapi/flights/${ident}?ident_type=designator&max_pages=1`,
    adsbfi_live: 'https://opendata.adsb.fi/api/v2/lat/38.8/lon/-9.1/dist/25',
    airplanes_live: 'https://api.airplanes.live/v2/point/38.8/-9.1/25',
    adsblol_live: 'https://api.adsb.lol/v2/lat/38.8/lon/-9.1/dist/25',
  };
  url = urls[test] ?? '';
  if (!url) return new Response('teste desconhecido', { status: 400 });
  if (test.startsWith('openaip_')) headers = aipHeaders;
  if (test === 'openaip_query') headers = UA;
  if (test === 'openaip_noua') headers = { 'x-openaip-api-key': env.openaip_key ?? '' };
  if (test.startsWith('aeroapi_')) headers = { ...UA, 'x-apikey': env.flightaware_key ?? '' };

  const start = Date.now();
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  let body = await res.text();
  for (const secret of [env.airlabs_key, env.openaip_key, env.flightaware_key, env.opensky_key, env.opensky_client]) {
    if (secret) body = body.replaceAll(secret, '***');
  }
  const kept = ['content-type', 'retry-after', 'x-rate-limit-remaining', 'x-rate-limit-retry-after-seconds', 'access-control-allow-origin', 'x-ratelimit-remaining'];
  return Response.json({
    test,
    status: res.status,
    ms: Date.now() - start,
    colo: request.cf?.colo,
    headers: Object.fromEntries(kept.flatMap((k) => (res.headers.get(k) ? [[k, res.headers.get(k)]] : []))),
    size: body.length,
    body: body.slice(0, 60_000),
  });
}
