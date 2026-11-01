import type { Aircraft } from './types';

const nf = new Intl.NumberFormat('pt-BR');

export const fmtAltitude = (a: Aircraft) =>
  a.onGround ? 'No solo' : a.altitudeM === null ? '—' : `${nf.format(a.altitudeM)} m`;
export const fmtSpeed = (a: Aircraft) => (a.speedKmh === null ? '—' : `${nf.format(a.speedKmh)} km/h`);
export const fmtHeading = (a: Aircraft) => (a.heading === null ? '—' : `${Math.round(a.heading)}°`);
export const fmtVRate = (a: Aircraft) => {
  if (a.verticalRateMs === null) return '—';
  const v = Math.round(a.verticalRateMs * 10) / 10;
  return `${v > 0 ? '↑ ' : v < 0 ? '↓ ' : ''}${nf.format(Math.abs(v))} m/s`;
};
export const fmtAge = (positionAt: number, now = Date.now()) => `${Math.max(0, Math.round((now - positionAt) / 1000))} s`;
