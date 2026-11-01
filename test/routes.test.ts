import { describe, expect, it, vi } from 'vitest';
import { greatCircle, haversineKm, routeFitsPosition } from '../src/geo';
import { flightProgress, parseHexdbAirport, parseHexdbRoute, parseRoute, RouteStore, type Route } from '../src/routes';

const LIS = { lat: 38.78, lon: -9.14 };
const BER = { lat: 52.35, lon: 13.49 };
const tick = () => new Promise((r) => setTimeout(r));

describe('greatCircle', () => {
  it('começa e termina nos extremos', () => {
    const pts = greatCircle(LIS, BER);
    expect(pts[0]![0]).toBeCloseTo(LIS.lon, 6);
    expect(pts.at(-1)![1]).toBeCloseTo(BER.lat, 6);
  });

  it('atravessa o antimeridiano sem saltar de um lado ao outro do mapa', () => {
    const pts = greatCircle({ lat: 35, lon: 170 }, { lat: 35, lon: -170 });
    for (let i = 1; i < pts.length; i++) expect(Math.abs(pts[i]![0] - pts[i - 1]![0])).toBeLessThan(5);
    expect(pts.at(-1)![0]).toBeCloseTo(190, 6);
  });

  it('aguenta pontos iguais', () => {
    expect(greatCircle(LIS, LIS)).toHaveLength(2);
  });
});

describe('routeFitsPosition', () => {
  it('aceita um avião a caminho e rejeita um fora da rota', () => {
    const mid = { lat: 46, lon: 2 };
    expect(haversineKm(LIS, mid)).toBeGreaterThan(0);
    expect(routeFitsPosition(LIS, BER, mid)).toBe(true);
    expect(routeFitsPosition(LIS, BER, { lat: -23.4, lon: -46.5 })).toBe(false);
  });
});

describe('parseRoute', () => {
  it('lê o formato do adsbdb e devolve null sem coordenadas', () => {
    const airport = { iata_code: 'LIS', icao_code: 'LPPT', municipality: 'Lisbon', latitude: 38.78, longitude: -9.14 };
    const route = parseRoute({ response: { flightroute: { origin: airport, destination: airport } } });
    expect(route?.destination).toEqual({ iata: 'LIS', icao: 'LPPT', city: 'Lisbon', lat: 38.78, lon: -9.14 });
    expect(parseRoute({ response: 'unknown callsign' })).toBeNull();
  });
});

describe('hexdb', () => {
  it('lê a rota, com escalas, e o aeroporto', () => {
    expect(parseHexdbRoute({ route: 'GCTS-LFLL' })).toEqual({ origin: 'GCTS', destination: 'LFLL' });
    expect(parseHexdbRoute({ route: 'AAAA-BBBB-CCCC' })).toEqual({ origin: 'AAAA', destination: 'CCCC' });
    expect(parseHexdbRoute(null)).toBeNull();
    expect(parseHexdbAirport({ iata: 'LIS', icao: 'LPPT', airport: 'Lisbon Portela Airport', region_name: 'Lisboa', latitude: 38.78, longitude: -9.14 })?.city).toBe('Lisbon Portela Airport');
  });
});

describe('flightProgress', () => {
  const route = { origin: LIS, destination: BER } as unknown as Route;
  const now = 1_000_000_000;

  it('estima partida e chegada pela distância e velocidade', () => {
    const p = flightProgress(route, { lat: 46, lon: 2 }, 800, now);
    expect(p.percent).toBeGreaterThan(30);
    expect(p.percent).toBeLessThan(70);
    expect(p.arrivesAt! - now).toBeCloseTo((p.remainingKm / 800) * 3600_000, 3);
    expect(p.departedAt!).toBeLessThan(now);
  });

  it('não estima com velocidade baixa ou desconhecida', () => {
    expect(flightProgress(route, LIS, 150, now).arrivesAt).toBeNull();
    expect(flightProgress(route, LIS, null, now).departedAt).toBeNull();
  });
});

describe('RouteStore', () => {
  const route = {} as Route;

  it('busca cada callsign uma vez e guarda rota desconhecida', async () => {
    const fetcher = vi.fn(async (cs: string) => (cs === 'TAP1' ? route : null));
    const s = new RouteStore(fetcher);
    s.want('TAP1');
    s.want('TAP1');
    s.want('N123');
    s.want('inválido');
    await tick();
    s.want('TAP1');
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(s.get('TAP1')).toBe(route);
    expect(s.get('N123')).toBeNull();
  });

  it('marca a falha, sem tentar de novo de imediato', async () => {
    const fetcher = vi.fn(async () => {
      throw new Error('HTTP 502');
    });
    const s = new RouteStore(fetcher);
    s.want('TAP1');
    await tick();
    s.want('TAP1', true);
    expect(s.failed('TAP1')).toBe(true);
    expect(s.get('TAP1')).toBeUndefined();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('o pedido urgente passa à frente da fila', async () => {
    const order: string[] = [];
    const s = new RouteStore(async (cs) => {
      order.push(cs);
      return null;
    });
    for (const cs of ['AA1', 'AA2', 'AA3', 'AA4', 'AA5']) s.want(cs);
    s.want('AA5', true);
    await tick();
    expect(order.indexOf('AA5')).toBeLessThan(order.indexOf('AA4'));
  });
});
