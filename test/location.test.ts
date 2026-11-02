import { describe, expect, it, vi } from 'vitest';
import { FAST, failureHelp, isInAppBrowser, locate, LocateError, permissionState, platformOf, PRECISE, type GeoEnv } from '../src/location';

const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const IPAD_AS_MAC = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
const WHATSAPP = IPHONE + ' WhatsApp/24.1';

const pos = (lat: number, lon: number) => ({ coords: { latitude: lat, longitude: lon } }) as GeolocationPosition;
const err = (code: number) => ({ code, message: 'x' }) as GeolocationPositionError;

/** Geolocation falsa que responde a cada chamada com o próximo resultado da lista. */
function fakeGeo(...results: (GeolocationPosition | GeolocationPositionError)[]) {
  const calls: PositionOptions[] = [];
  const geolocation = {
    getCurrentPosition: (ok: PositionCallback, fail: PositionErrorCallback, opts: PositionOptions) => {
      calls.push(opts);
      const r = results.shift();
      if (r && 'coords' in r) ok(r);
      else fail((r ?? err(2)) as GeolocationPositionError);
    },
  } as unknown as Geolocation;
  return { geolocation, calls };
}

const env = (over: Partial<GeoEnv> = {}): GeoEnv => ({ isSecureContext: true, userAgent: IPHONE, maxTouchPoints: 5, ...over });

describe('permissionState', () => {
  it('lê o estado sem pedir nada', async () => {
    const query = vi.fn().mockResolvedValue({ state: 'prompt' });
    expect((await permissionState(env({ permissions: { query } }))).state).toBe('prompt');
    expect(query).toHaveBeenCalledWith({ name: 'geolocation' });
  });

  it('"unknown" sem Permissions API ou quando a consulta falha', async () => {
    expect((await permissionState(env())).state).toBe('unknown');
    const query = vi.fn().mockRejectedValue(new TypeError('não suportado'));
    expect((await permissionState(env({ permissions: { query } }))).state).toBe('unknown');
  });
});

describe('locate', () => {
  it('usa a tentativa rápida quando funciona', async () => {
    const g = fakeGeo(pos(38.87, -9.08));
    expect((await locate(env(g))).coords.latitude).toBe(38.87);
    expect(g.calls).toEqual([FAST]);
  });

  it('tenta de novo com GPS quando a primeira demora ou não tem sinal', async () => {
    const g = fakeGeo(err(3), pos(1, 2));
    expect((await locate(env(g))).coords.longitude).toBe(2);
    expect(g.calls).toEqual([FAST, PRECISE]);
  });

  it('permissão negada falha logo, sem segunda tentativa', async () => {
    const g = fakeGeo(err(1));
    await expect(locate(env(g))).rejects.toMatchObject({ kind: 'denied' });
    expect(g.calls).toHaveLength(1);
  });

  it('classifica a falha da segunda tentativa', async () => {
    await expect(locate(env(fakeGeo(err(2), err(3))))).rejects.toMatchObject({ kind: 'timeout' });
    await expect(locate(env(fakeGeo(err(3), err(2))))).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('sem https ou sem API não chega a chamar o navegador', async () => {
    await expect(locate(env({ isSecureContext: false, ...fakeGeo() }))).rejects.toBeInstanceOf(LocateError);
    await expect(locate(env())).rejects.toMatchObject({ kind: 'unsupported' });
  });
});

describe('plataforma e ajuda', () => {
  it('reconhece iPhone, iPad (que se diz Mac), Android e apps', () => {
    expect(platformOf({ userAgent: IPHONE, maxTouchPoints: 5 })).toBe('ios');
    expect(platformOf({ userAgent: IPAD_AS_MAC, maxTouchPoints: 5 })).toBe('ios');
    expect(platformOf({ userAgent: IPAD_AS_MAC, maxTouchPoints: 0 })).toBe('other');
    expect(platformOf({ userAgent: ANDROID, maxTouchPoints: 5 })).toBe('android');
    expect(isInAppBrowser(WHATSAPP)).toBe(true);
    expect(isInAppBrowser(IPHONE)).toBe(false);
  });

  it('explica como liberar no Safari do iPhone e no Chrome do Android', () => {
    const ios = failureHelp('denied', { userAgent: IPHONE, maxTouchPoints: 5 });
    expect(ios.steps.join(' ')).toMatch(/Ajustes do Site › Localização/);
    expect(ios.steps.join(' ')).toMatch(/Sites do Safari/);
    const android = failureHelp('denied', { userAgent: ANDROID, maxTouchPoints: 5 });
    expect(android.steps.join(' ')).toMatch(/Permissões › Localização/);
  });

  it('dentro de outro app, sugere abrir no navegador', () => {
    expect(failureHelp('denied', { userAgent: WHATSAPP, maxTouchPoints: 5 }).steps[0]).toMatch(/Abra no Safari/);
  });
});
