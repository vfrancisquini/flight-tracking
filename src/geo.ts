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
 * Pontos [lon, lat] do grande círculo entre a e b. As longitudes seguem contínuas
 * (podem passar de ±180) para a linha não atravessar o mapa no antimeridiano.
 */
export function greatCircle(a: LatLon, b: LatLon, segments = 48): [number, number][] {
  const δ = haversineKm(a, b) / R_KM;
  if (δ < 1e-6) return [[a.lon, a.lat], [b.lon, b.lat]];
  const φ1 = rad(a.lat);
  const λ1 = rad(a.lon);
  const φ2 = rad(b.lat);
  const λ2 = rad(b.lon);
  const points: [number, number][] = [];
  for (let i = 0; i <= segments; i++) {
    const f = i / segments;
    const A = Math.sin((1 - f) * δ) / Math.sin(δ);
    const B = Math.sin(f * δ) / Math.sin(δ);
    const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
    const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
    const z = A * Math.sin(φ1) + B * Math.sin(φ2);
    let lon = deg(Math.atan2(y, x));
    const prev = points[i - 1]?.[0];
    if (prev !== undefined) lon += 360 * Math.round((prev - lon) / 360);
    points.push([lon, deg(Math.atan2(z, Math.hypot(x, y)))]);
  }
  return points;
}

/**
 * As rotas vêm do callsign e podem estar desatualizadas. Se passar pela posição
 * atual obrigaria a um desvio grande, a rota não é a deste voo.
 */
export function routeFitsPosition(origin: LatLon, destination: LatLon, position: LatLon): boolean {
  const viaPosition = haversineKm(origin, position) + haversineKm(position, destination);
  return viaPosition <= haversineKm(origin, destination) * 1.25 + 150;
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
