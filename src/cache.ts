/**
 * Cache de rotas e dados de aeronaves no armazenamento do navegador.
 *
 * Cada entrada é `{ at, value }` sob uma chave `<prefixo><id>`. Ao abrir o site
 * apagamos as vencidas, as de versões antigas do formato e, se houver demasiadas,
 * as mais velhas — para o armazenamento (≈5 MB) não encher com o tempo.
 */

export interface CacheKind {
  prefix: string;
  ttlMs: number;
}

const DAY_MS = 24 * 3600_000;
export const ROUTE_CACHE: CacheKind = { prefix: 'route2:', ttlMs: DAY_MS };
export const AIRCRAFT_CACHE: CacheKind = { prefix: 'aircraft1:', ttlMs: 7 * DAY_MS };
const KINDS = [ROUTE_CACHE, AIRCRAFT_CACHE];

/** Chaves deste cache, em qualquer versão (route1:, aircraft0:…). */
const OURS = /^(route|aircraft)\d+:/;
/** Acima disto removemos as mais antigas. */
export const MAX_ENTRIES = 3000;

interface Entry<T> {
  at: number;
  value: T;
}

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null; // acesso bloqueado (modo privado, cookies desligados)
  }
}

function readEntry<T>(raw: string | null): Entry<T> | null {
  if (!raw) return null;
  try {
    const e = JSON.parse(raw) as Entry<T>;
    return typeof e?.at === 'number' ? e : null;
  } catch {
    return null;
  }
}

/** Remove entradas vencidas, inválidas ou de versões antigas e aplica o limite. Devolve quantas apagou. */
export function pruneCache(now = Date.now(), store: Storage | null = storage(), max = MAX_ENTRIES): number {
  if (!store) return 0;
  const keys: string[] = [];
  try {
    for (let i = 0; i < store.length; i++) {
      const k = store.key(i);
      if (k && OURS.test(k)) keys.push(k);
    }
  } catch {
    return 0;
  }

  const drop = new Set<string>();
  const alive: { key: string; at: number }[] = [];
  for (const key of keys) {
    const kind = KINDS.find((k) => key.startsWith(k.prefix));
    const entry = kind ? readEntry(store.getItem(key)) : null;
    if (!kind || !entry || now - entry.at >= kind.ttlMs || entry.at > now + DAY_MS) drop.add(key);
    else alive.push({ key, at: entry.at });
  }
  if (alive.length > max) {
    alive.sort((a, b) => a.at - b.at);
    for (const { key } of alive.slice(0, alive.length - max)) drop.add(key);
  }
  for (const key of drop) {
    try {
      store.removeItem(key);
    } catch {
      // ignorar
    }
  }
  return drop.size;
}

/**
 * Devolve o valor guardado se ainda for válido; senão chama `load` e guarda o resultado.
 * Falhas de `load` (erros lançados) não ficam guardadas. Se o armazenamento estiver
 * cheio, limpa e tenta mais uma vez; se continuar sem espaço, segue sem cache.
 */
export async function cached<T>(kind: CacheKind, id: string, load: () => Promise<T>, store: Storage | null = storage()): Promise<T> {
  const key = kind.prefix + id;
  const saved = store ? readEntry<T>(safeGet(store, key)) : null;
  if (saved && Date.now() - saved.at < kind.ttlMs) return saved.value;

  const value = await load();
  if (store) {
    const raw = JSON.stringify({ at: Date.now(), value } satisfies Entry<T>);
    try {
      store.setItem(key, raw);
    } catch {
      pruneCache(Date.now(), store, Math.floor(MAX_ENTRIES / 2));
      try {
        store.setItem(key, raw);
      } catch {
        // Continua sem cache.
      }
    }
  }
  return value;
}

function safeGet(store: Storage, key: string): string | null {
  try {
    return store.getItem(key);
  } catch {
    return null;
  }
}
