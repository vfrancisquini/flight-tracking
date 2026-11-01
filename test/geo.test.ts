import { describe, expect, it } from 'vitest';
import { destinationPoint, haversineKm, viewportToQuery } from '../src/geo';
import { predictPosition } from '../src/store';
import type { Aircraft } from '../src/types';

describe('geo', () => {
  it('haversine GRU → GIG ≈ 340 km', () => {
    expect(haversineKm({ lat: -23.4356, lon: -46.4731 }, { lat: -22.81, lon: -43.2506 })).toBeCloseTo(337, -1);
  });

  it('destinationPoint é o inverso da distância', () => {
    const a = { lat: -23.5, lon: -46.6 };
    const b = destinationPoint(a, 37, 100);
    expect(haversineKm(a, b)).toBeCloseTo(100, 6);
  });

  it('viewportToQuery cobre o retângulo e corta em 250 NM', () => {
    const small = viewportToQuery({ lat: 0, lon: 0 }, [{ lat: 0.5, lon: 0.5 }, { lat: -0.5, lon: -0.5 }]);
    expect(small.truncated).toBe(false);
    expect(small.distNm).toBeCloseTo(42.4, 0);
    const big = viewportToQuery({ lat: 0, lon: 0 }, [{ lat: 20, lon: 20 }]);
    expect(big.truncated).toBe(true);
    expect(big.distNm).toBe(250);
  });
});

describe('predictPosition', () => {
  const base: Aircraft = {
    hex: 'abc123', callsign: null, registration: null, type: null, lat: 0, lon: 0, altitudeM: 10000,
    onGround: false, speedKmh: 900, heading: 90, verticalRateMs: null, squawk: null, positionAt: 0,
  };

  it('avança na direção do rumo', () => {
    const p = predictPosition(base, 10_000); // 10 s a 900 km/h = 2,5 km
    expect(haversineKm(base, p)).toBeCloseTo(2.5, 3);
    expect(p.lon).toBeGreaterThan(0);
  });

  it('limita a extrapolação a 30 s e não mexe aviões no solo', () => {
    expect(haversineKm(base, predictPosition(base, 600_000))).toBeCloseTo(7.5, 3);
    expect(predictPosition({ ...base, onGround: true }, 10_000)).toMatchObject({ lat: 0, lon: 0 });
  });
});
