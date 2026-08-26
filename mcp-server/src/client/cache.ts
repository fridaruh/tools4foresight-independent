// Caché en memoria del cliente HTTP: Map + TTL + evicción LRU con tope de entradas
// (docs/PLAN.md §2.5, §2.11). Nada de dependencias externas (regla de §2.2: cero
// deps de runtime más allá del SDK y zod) — un `Map` de JS ya preserva el orden de
// inserción, que es todo lo que hace falta para implementar LRU sin una librería.

export type CacheStats = {
  /** Entradas actualmente almacenadas (incluye las que ya expiraron pero no se han tocado). */
  size: number;
  maxEntries: number;
  hits: number;
  misses: number;
  evictions: number;
};

type CacheEntry<V> = {
  value: V;
  /** `Infinity` = nunca expira (p.ej. un snapshot por id, que es inmutable). */
  expiresAt: number;
};

export class Cache<V = unknown> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly maxEntries: number;
  /** Inyectable para poder testear TTL/expiración sin `setTimeout` ni relojes reales. */
  private readonly now: () => number;

  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(opts: { maxEntries: number; now?: () => number }) {
    this.maxEntries = opts.maxEntries;
    this.now = opts.now ?? (() => Date.now());
  }

  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (this.now() >= entry.expiresAt) {
      // Expiró: se trata como miss y se limpia de inmediato para no contarla
      // contra `maxEntries` hasta el próximo `set`.
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    // LRU por recencia de acceso: borrar y reinsertar mueve la clave al final del
    // Map (que preserva orden de inserción), así el candidato a evicción siempre
    // es `store.keys().next().value` — el menos usado recientemente.
    this.store.delete(key);
    this.store.set(key, entry);
    this.hits++;
    return entry.value;
  }

  set(key: string, value: V, ttlMs: number): void {
    // ttlMs === 0: caché desactivada para esta entrada (o globalmente, si el
    // llamador siempre pasa 0 porque T4F_CACHE_TTL_MS=0). En vez de no tocar el
    // Map, se borra cualquier entrada previa: así `set` es idempotente respecto a
    // "esta clave nunca debe servirse desde caché", sin que el llamador tenga que
    // acordarse de no llamar a `get` para ella.
    if (ttlMs === 0) {
      this.store.delete(key);
      return;
    }
    const expiresAt = ttlMs === Infinity ? Infinity : this.now() + ttlMs;
    this.store.delete(key); // por si ya existía: reinsertar la manda al final (recency)
    this.store.set(key, { value, expiresAt });
    this.evictIfNeeded();
  }

  clear(): void {
    this.store.clear();
  }

  stats(): CacheStats {
    return {
      size: this.store.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  private evictIfNeeded(): void {
    while (this.store.size > this.maxEntries) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) break;
      this.store.delete(oldestKey);
      this.evictions++;
    }
  }
}
