/** Modelo normalizado — o resto da app nunca vê o formato bruto das APIs. */
export interface Aircraft {
  hex: string;
  callsign: string | null;
  registration: string | null;
  type: string | null;
  lat: number;
  lon: number;
  /** Altitude barométrica em metros; 0 quando no solo; null se desconhecida. */
  altitudeM: number | null;
  onGround: boolean;
  speedKmh: number | null;
  /** Rumo em graus (0 = norte), para rodar o ícone. */
  heading: number | null;
  verticalRateMs: number | null;
  squawk: string | null;
  /** Epoch (ms) do instante em que a posição foi medida. */
  positionAt: number;
}
