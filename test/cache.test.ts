import { describe, expect, it } from 'vitest';
import { AIRCRAFT_CACHE, cached, pruneCache, ROUTE_CACHE } from '../src/cache';

/** Storage em memória, com limite opcional de entradas para simular "cheio". */
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  constructor(private readonly limit = Infinity) {}
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    if (!this.m.has(k) && this.m.size >= this.limit) throw new DOMException('cheio', 'QuotaExceededError');
    this.m.set(k, v);
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
  keys() {
    return [...this.m.keys()].sort();
  }
}

const DAY = 24 * 3600_000;
const put = (s: Storage, key: string, at: number) => s.setItem(key, JSON.stringify({ at, value: key }));

describe('pruneCache', () => {
  it('apaga vencidas, inválidas e de versões antigas; mantém as válidas e as de outros donos', () => {
    const s = new MemoryStorage();
    const now = 100 * DAY;
    put(s, 'route2:TAP1', now - DAY / 2); // válida
    put(s, 'route2:TAP2', now - 2 * DAY); // vencida (rotas: 1 dia)
    put(s, 'aircraft1:abc', now - 3 * DAY); // válida (aeronaves: 7 dias)
    put(s, 'aircraft1:old', now - 8 * DAY); // vencida
    put(s, 'route1:TAP3', now); // versão antiga do formato
    s.setItem('route2:BAD', 'não é json');
    s.setItem('loc-hint-dismissed', '1'); // não é deste cache
    expect(pruneCache(now, s)).toBe(4);
    expect(s.keys()).toEqual(['aircraft1:abc', 'loc-hint-dismissed', 'route2:TAP1']);
  });

  it('acima do limite, remove as mais antigas', () => {
    const s = new MemoryStorage();
    for (let i = 0; i < 5; i++) put(s, `route2:F${i}`, 1000 + i);
    pruneCache(2000, s, 3);
    expect(s.keys()).toEqual(['route2:F2', 'route2:F3', 'route2:F4']);
  });

  it('não rebenta sem armazenamento', () => {
    expect(pruneCache(Date.now(), null)).toBe(0);
  });
});

describe('cached', () => {
  it('usa o valor guardado enquanto válido e não guarda falhas', async () => {
    const s = new MemoryStorage();
    let calls = 0;
    const load = async () => ++calls;
    expect(await cached(ROUTE_CACHE, 'X', load, s)).toBe(1);
    expect(await cached(ROUTE_CACHE, 'X', load, s)).toBe(1);
    expect(calls).toBe(1);
    await expect(cached(AIRCRAFT_CACHE, 'y', () => Promise.reject(new Error('429')), s)).rejects.toThrow('429');
    expect(s.getItem('aircraft1:y')).toBeNull();
  });

  it('com o armazenamento cheio, limpa e grava', async () => {
    const s = new MemoryStorage(2);
    put(s, 'route2:OLD', 0); // vencida há muito
    put(s, 'route2:OLD2', 1);
    expect(await cached(ROUTE_CACHE, 'NEW', async () => 'v', s)).toBe('v');
    expect(s.getItem('route2:NEW')).not.toBeNull();
  });

  it('funciona sem armazenamento', async () => {
    expect(await cached(ROUTE_CACHE, 'Z', async () => 7, null)).toBe(7);
  });
});
