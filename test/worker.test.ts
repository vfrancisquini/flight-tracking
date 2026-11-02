import { afterEach, describe, expect, it, vi } from 'vitest';
import { onRequestGet } from '../functions/api/[[path]]';

const cacheStore = new Map<string, Response>();
vi.stubGlobal('caches', {
  default: {
    match: async (r: Request) => cacheStore.get(r.url)?.clone(),
    put: async (r: Request, res: Response) => void cacheStore.set(r.url, res),
  },
});

const ctx = (path: string) => {
  const u = new URL(`https://radar.test/api/${path}`);
  return { request: new Request(u), params: { path: u.pathname.slice(5).split('/') }, waitUntil: (p: Promise<unknown>) => void p };
};

afterEach(() => {
  vi.restoreAllMocks();
  cacheStore.clear();
});

describe('Worker /api', () => {
  it('rejeita parâmetros inválidos sem chamar upstream', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    expect((await onRequestGet(ctx('live?lat=abc&lon=1&dist=10'))).status).toBe(400);
    expect((await onRequestGet(ctx('callsign/..%2Fx'))).status).toBe(400);
    expect((await onRequestGet(ctx('hex/zzzzzz'))).status).toBe(400);
    expect((await onRequestGet(ctx('nada'))).status).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('faz failover para o próximo fornecedor em 429 e identifica a fonte', async () => {
    const spy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockResolvedValueOnce(new Response('{"ac":[]}', { status: 200 }));
    const res = await onRequestGet(ctx('live?lat=-23.4&lon=-46.5&dist=999'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-provider')).toBe('adsb.fi');
    expect(String(spy.mock.calls[0]?.[0])).toBe('https://api.adsb.lol/v2/lat/-23.40/lon/-46.50/dist/250');
  });

  it('serve do cache no segundo pedido', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"ac":[]}'));
    await onRequestGet(ctx('callsign/azu4152'));
    await onRequestGet(ctx('callsign/azu4152'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toBe('https://api.adsb.lol/v2/callsign/AZU4152');
  });

  it('já não serve rotas, aeronaves nem fotos (o navegador busca direto)', async () => {
    const spy = vi.spyOn(globalThis, 'fetch');
    for (const path of ['route/AZU4152', 'aircraft/e48a12', 'photo/e48a12']) {
      expect((await onRequestGet(ctx(path))).status).toBe(404);
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('serve a última telemetria boa, identificada, quando todas as fontes falham', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(new Response('{"ac":[{"hex":"abc123"}]}'));
    await onRequestGet(ctx('live?lat=1&lon=2&dist=3'));
    cacheStore.delete('https://radar.test/api/live?lat=1&lon=2&dist=3');
    spy.mockResolvedValue(new Response('', { status: 429 }));
    const res = await onRequestGet(ctx('live?lat=1&lon=2&dist=3'));
    expect(res.status).toBe(200);
    expect(res.headers.get('x-provider')).toBe('adsb.lol (dados em cache)');
    expect(await res.text()).toContain('abc123');
  });

  it('/geo devolve a localização da Cloudflare sem cache e 404 se não houver', async () => {
    const c = ctx('geo');
    const withCf = { ...c, request: Object.assign(c.request, { cf: { latitude: '38.72', longitude: '-9.13' } }) };
    const res = await onRequestGet(withCf);
    expect(await res.json()).toEqual({ lat: 38.72, lon: -9.13 });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect((await onRequestGet(ctx('geo'))).status).toBe(404);
  });

  describe('/flight (paga)', () => {
    const kv = (initial: Record<string, string> = {}) => {
      const data = new Map(Object.entries(initial));
      return { data, get: async (k: string) => data.get(k) ?? null, put: async (k: string, v: string) => void data.set(k, v) };
    };
    const body = JSON.stringify({ flights: [{ ident: 'TAP1', status: 'En Route', actual_off: '2026-11-02T10:00:00Z', scheduled_off: '2026-11-02T09:50:00Z' }] });
    const month = () => `month:${new Date().toISOString().slice(0, 7)}`;
    const flightCtx = (env: object, init?: RequestInit) => {
      const c = ctx('flight/tap1');
      return { ...c, env, request: new Request(c.request, init) };
    };

    it('consulta com a chave, resume, conta no orçamento e usa o cache', async () => {
      const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(body));
      const budget = kv();
      const res = await onRequestGet(flightCtx({ flightaware_key: 'k', AEROAPI_BUDGET: budget }));
      expect(await res.json()).toMatchObject({ status: 'En Route', scheduledOff: '2026-11-02T09:50:00Z' });
      const [url, init] = spy.mock.calls[0]!;
      expect(String(url)).toContain('/flights/TAP1?');
      expect((init?.headers as Record<string, string>)['x-apikey']).toBe('k');
      await onRequestGet(flightCtx({ flightaware_key: 'k', AEROAPI_BUDGET: budget }));
      expect(spy).toHaveBeenCalledTimes(1);
      expect(budget.data.get(month())).toBe('1');
    });

    it('não gasta no teto, sem contador, sem chave nem vindo de outro site', async () => {
      const spy = vi.spyOn(globalThis, 'fetch');
      expect((await onRequestGet(flightCtx({ flightaware_key: 'k', AEROAPI_BUDGET: kv({ [month()]: '800' }) }))).status).toBe(429);
      expect((await onRequestGet(flightCtx({ flightaware_key: 'k' }))).status).toBe(429);
      expect((await onRequestGet(flightCtx({ AEROAPI_BUDGET: kv() }))).status).toBe(503);
      const foreign = flightCtx({ flightaware_key: 'k', AEROAPI_BUDGET: kv() }, { headers: { 'sec-fetch-site': 'cross-site' } });
      expect((await onRequestGet(foreign)).status).toBe(403);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  it('devolve 502 quando todas as fontes falham', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network'));
    expect((await onRequestGet(ctx('callsign/TAM3301'))).status).toBe(502);
  });
});
