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
    expect((await onRequestGet(ctx('route/..%2Fx'))).status).toBe(400);
    expect((await onRequestGet(ctx('aircraft/zzzzzz'))).status).toBe(400);
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
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"response":{}}'));
    await onRequestGet(ctx('route/azu4152'));
    await onRequestGet(ctx('route/azu4152'));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(String(spy.mock.calls[0]?.[0])).toBe('https://api.adsbdb.com/v0/callsign/AZU4152');
  });

  it('devolve 502 quando todas as fontes falham', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network'));
    expect((await onRequestGet(ctx('callsign/TAM3301'))).status).toBe(502);
  });
});
