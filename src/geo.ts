import { MAX_RADIUS_NM, type LiveQuery } from './shared/providers';
import { NM_TO_KM } from './shared/units';

const R_KM = 6371.0088;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

export interface LatLon {
  lat: number;
  lon: number;
}

export function haversineKm(a: LatLon, b: LatLon): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Ponto a `distKm` de `from` no rumo `bearingDeg` (grande círculo). */
export function destinationPoint(from: LatLon, bearingDeg: number, distKm: number): LatLon {
  const δ = distKm / R_KM;
  const θ = rad(bearingDeg);
  const φ1 = rad(from.lat);
  const λ1 = rad(from.lon);
  const φ2 = Math.asin(Math.sin(φ1) * Math.cos(δ) + Math.cos(φ1) * Math.sin(δ) * Math.cos(θ));
  const λ2 = λ1 + Math.atan2(Math.sin(θ) * Math.sin(δ) * Math.cos(φ1), Math.cos(δ) - Math.sin(φ1) * Math.sin(φ2));
  return { lat: deg(φ2), lon: ((deg(λ2) + 540) % 360) - 180 };
}

/**
 * As APIs pedem centro + raio, o mapa dá um retângulo. Usa o círculo que
 * cobre o viewport inteiro; se passar do máximo, corta e sinaliza.
 */
export function viewportToQuery(center: LatLon, corners: LatLon[]): LiveQuery & { truncated: boolean } {
  const farthestKm = Math.max(...corners.map((c) => haversineKm(center, c)));
  const distNm = farthestKm / NM_TO_KM;
  return {
    lat: center.lat,
    lon: center.lon,
    distNm: Math.min(distNm, MAX_RADIUS_NM),
    truncated: distNm > MAX_RADIUS_NM,
  };
}
