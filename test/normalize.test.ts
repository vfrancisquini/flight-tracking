import { describe, expect, it } from 'vitest';
import sample from './fixtures/readsb-sample.json';
import { normalizeReadsb } from '../src/normalize';

describe('normalizeReadsb', () => {
  const list = normalizeReadsb(sample);
  const by = (hex: string) => list.find((a) => a.hex === hex);

  it('descarta aviões sem posição ou com posição velha', () => {
    expect(list.map((a) => a.hex).sort()).toEqual(['e40001', 'e48a12', 'e4c0de']);
  });

  it('converte unidades e limpa campos', () => {
    const a = by('e48a12')!;
    expect(a.callsign).toBe('TAM3301');
    expect(a.altitudeM).toBe(3048);
    expect(a.speedKmh).toBe(463);
    expect(a.heading).toBe(90);
    expect(a.verticalRateMs).toBeCloseTo(5.08, 2);
    expect(a.registration).toBe('PR-MYA');
    expect(a.positionAt).toBe(1700000000000 - 2000);
  });

  it('trata "ground" e rumos alternativos', () => {
    const g = by('e4c0de')!;
    expect(g.onGround).toBe(true);
    expect(g.altitudeM).toBe(0);
    expect(g.heading).toBe(180);
    const m = by('e40001')!;
    expect(m.altitudeM).toBe(914);
    expect(m.heading).toBe(45);
    expect(m.callsign).toBeNull();
    expect(m.speedKmh).toBeNull();
  });

  it('aceita `now` em segundos e o formato antigo `aircraft`', () => {
    const r = normalizeReadsb({ now: 1700000000, aircraft: [{ hex: 'abc123', lat: 1, lon: 2, seen_pos: 0 }] });
    expect(r[0]?.positionAt).toBe(1700000000000);
  });

  it('tolera lixo', () => {
    expect(normalizeReadsb(null)).toEqual([]);
    expect(normalizeReadsb({ ac: 'x' })).toEqual([]);
  });
});
