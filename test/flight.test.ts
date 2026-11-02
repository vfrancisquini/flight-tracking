import { describe, expect, it } from 'vitest';
import { parseOfficialFlight, pickFlight } from '../src/shared/flight';

const now = Date.parse('2026-11-02T12:00:00Z');

describe('pickFlight', () => {
  it('prefere o voo no ar', () => {
    const flights = [
      { id: 'amanha', scheduled_out: '2026-11-02T12:05:00Z' },
      { id: 'no-ar', scheduled_out: '2026-11-02T10:00:00Z', actual_off: '2026-11-02T10:10:00Z' },
    ];
    expect(pickFlight(flights, now)?.id).toBe('no-ar');
  });

  it('sem voo no ar, escolhe o horário mais próximo e ignora os já pousados', () => {
    const flights = [
      { id: 'ontem', scheduled_out: '2026-11-01T12:00:00Z', actual_off: '2026-11-01T12:10:00Z', actual_on: '2026-11-01T14:00:00Z' },
      { id: 'hoje', scheduled_out: '2026-11-02T13:00:00Z' },
    ];
    expect(pickFlight(flights, now)?.id).toBe('hoje');
    expect(pickFlight([], now)).toBeNull();
  });
});

describe('parseOfficialFlight', () => {
  it('reduz ao que o painel usa', () => {
    const f = parseOfficialFlight(
      {
        flights: [{
          status: 'En Route / On Time', cancelled: false, departure_delay: 720, gate_origin: '12',
          origin: { code_iata: 'BER', code_icao: 'EDDB', city: 'Berlin', name: 'Brandenburg', timezone: 'Europe/Berlin' }, destination: null,
          scheduled_off: '2026-11-02T10:10:00Z', estimated_off: '2026-11-02T10:20:00Z', scheduled_on: '2026-11-02T13:00:00Z',
        }],
      },
      now,
    );
    expect(f).toMatchObject({
      status: 'En Route / On Time', departureDelay: 720, gateOrigin: '12', destination: null,
      origin: { iata: 'BER', icao: 'EDDB', city: 'Berlin', name: 'Brandenburg', timezone: 'Europe/Berlin' },
      scheduledOff: '2026-11-02T10:10:00Z', estimatedOff: '2026-11-02T10:20:00Z', scheduledOn: '2026-11-02T13:00:00Z',
    });
  });

  it('devolve null sem voos ou com corpo inesperado', () => {
    expect(parseOfficialFlight({ flights: [] }, now)).toBeNull();
    expect(parseOfficialFlight(null, now)).toBeNull();
  });
});
