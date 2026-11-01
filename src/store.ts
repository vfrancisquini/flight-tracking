import { destinationPoint } from './geo';
import type { Aircraft } from './types';

/** Para além disto não extrapolamos (evita aviões "a fugir" se a API parar). */
const MAX_EXTRAPOLATION_S = 30;

export class AircraftStore {
  readonly byHex = new Map<string, Aircraft>();

  /** Junta um lote novo. Só substitui se a posição for mais recente. */
  upsert(list: Aircraft[]): void {
    for (const a of list) {
      const prev = this.byHex.get(a.hex);
      if (!prev || a.positionAt >= prev.positionAt) this.byHex.set(a.hex, a);
    }
  }

  /** Remove aviões sem posição nova há `maxAgeMs`. Devolve os hex removidos. */
  prune(now: number, maxAgeMs: number): string[] {
    const removed: string[] = [];
    for (const [hex, a] of this.byHex) {
      if (now - a.positionAt > maxAgeMs) {
        this.byHex.delete(hex);
        removed.push(hex);
      }
    }
    return removed;
  }

  get size(): number {
    return this.byHex.size;
  }
}

/** Dead reckoning: posição estimada agora a partir da última medida, velocidade e rumo. */
export function predictPosition(a: Aircraft, now: number): { lat: number; lon: number } {
  if (a.onGround || a.speedKmh === null || a.heading === null || a.speedKmh < 1) return a;
  const dt = Math.min(Math.max(0, (now - a.positionAt) / 1000), MAX_EXTRAPOLATION_S);
  return destinationPoint(a, a.heading, (a.speedKmh / 3600) * dt);
}
