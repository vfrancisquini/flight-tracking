import { FPM_TO_MS, FT_TO_M, KT_TO_KMH } from './shared/units';
import type { Aircraft } from './types';

/** Posições mais velhas do que isto não entram no mapa. */
export const MAX_POSITION_AGE_S = 60;

type Raw = Record<string, unknown>;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** Converte uma resposta readsb v2 (adsb.lol / adsb.fi / airplanes.live) no modelo interno. */
export function normalizeReadsb(json: unknown, receivedAt = Date.now()): Aircraft[] {
  if (!json || typeof json !== 'object') return [];
  const body = json as Raw;
  const list = (Array.isArray(body.ac) ? body.ac : Array.isArray(body.aircraft) ? body.aircraft : []) as Raw[];

  // `now` vem em ms no adsb.lol; noutras instâncias readsb pode vir em segundos.
  let now = num(body.now) ?? receivedAt;
  if (now < 1e12) now *= 1000;

  const out: Aircraft[] = [];
  for (const a of list) {
    const hex = str(a.hex)?.toLowerCase();
    const lat = num(a.lat);
    const lon = num(a.lon);
    if (!hex || lat === null || lon === null) continue;

    const seenPos = num(a.seen_pos) ?? num(a.seen) ?? 0;
    if (seenPos > MAX_POSITION_AGE_S) continue;

    const onGround = a.alt_baro === 'ground';
    const altFt = onGround ? 0 : (num(a.alt_baro) ?? num(a.alt_geom));
    const gs = num(a.gs);
    const rate = num(a.baro_rate) ?? num(a.geom_rate);

    out.push({
      hex,
      callsign: str(a.flight),
      registration: str(a.r),
      type: str(a.t),
      lat,
      lon,
      altitudeM: altFt === null ? null : Math.round(altFt * FT_TO_M),
      onGround,
      speedKmh: gs === null ? null : Math.round(gs * KT_TO_KMH),
      heading: num(a.track) ?? num(a.true_heading) ?? num(a.mag_heading),
      verticalRateMs: rate === null ? null : rate * FPM_TO_MS,
      squawk: str(a.squawk),
      positionAt: now - seenPos * 1000,
    });
  }
  return out;
}
