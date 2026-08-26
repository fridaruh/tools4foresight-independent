import { describe, expect, it } from 'vitest';
import { Cache } from '../src/client/cache.js';

// Reloj falso e inyectable: nunca usamos setTimeout/Date.now reales, así que estos
// tests corren instantáneos y son deterministas (docs/PLAN.md §2.11).
function fakeClock(startMs = 0) {
  let current = startMs;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

describe('Cache', () => {
  it('devuelve un hit mientras la entrada está dentro del TTL', () => {
    const clock = fakeClock();
    const cache = new Cache<string>({ maxEntries: 10, now: clock.now });

    cache.set('k', 'v1', 1_000);
    clock.advance(999);

    expect(cache.get('k')).toBe('v1');
    expect(cache.stats().hits).toBe(1);
    expect(cache.stats().misses).toBe(0);
  });

  it('es un miss justo al expirar el TTL, y limpia la entrada', () => {
    const clock = fakeClock();
    const cache = new Cache<string>({ maxEntries: 10, now: clock.now });

    cache.set('k', 'v1', 1_000);
    clock.advance(1_000); // now() >= expiresAt

    expect(cache.get('k')).toBeUndefined();
    expect(cache.stats().misses).toBe(1);
    expect(cache.stats().size).toBe(0);
  });

  it('evita entradas menos usadas recientemente al superar maxEntries (LRU)', () => {
    const clock = fakeClock();
    const cache = new Cache<string>({ maxEntries: 2, now: clock.now });

    cache.set('a', 'va', 10_000);
    cache.set('b', 'vb', 10_000);
    // Tocar "a" la vuelve más reciente que "b".
    expect(cache.get('a')).toBe('va');

    cache.set('c', 'vc', 10_000); // debe expulsar a "b", no a "a"

    expect(cache.get('a')).toBe('va');
    expect(cache.get('b')).toBeUndefined();
    expect(cache.get('c')).toBe('vc');
    expect(cache.stats().evictions).toBe(1);
    expect(cache.stats().size).toBe(2);
  });

  it('ttlMs=0 desactiva la caché para esa entrada (nunca se sirve desde caché)', () => {
    const clock = fakeClock();
    const cache = new Cache<string>({ maxEntries: 10, now: clock.now });

    cache.set('k', 'v1', 0);

    expect(cache.get('k')).toBeUndefined();
    expect(cache.stats().size).toBe(0);
  });

  it('ttlMs=Infinity nunca expira, aunque pase mucho tiempo', () => {
    const clock = fakeClock();
    const cache = new Cache<string>({ maxEntries: 10, now: clock.now });

    cache.set('k', 'v1', Infinity);
    clock.advance(1_000 * 60 * 60 * 24 * 365); // un año

    expect(cache.get('k')).toBe('v1');
  });

  it('clear() vacía todas las entradas', () => {
    const cache = new Cache<string>({ maxEntries: 10 });
    cache.set('a', 'va', 1_000);
    cache.set('b', 'vb', 1_000);

    cache.clear();

    expect(cache.stats().size).toBe(0);
    expect(cache.get('a')).toBeUndefined();
  });

  it('set() sobrescribe el valor y reinicia el TTL de una clave existente', () => {
    const clock = fakeClock();
    const cache = new Cache<string>({ maxEntries: 10, now: clock.now });

    cache.set('k', 'v1', 1_000);
    clock.advance(500);
    cache.set('k', 'v2', 1_000); // TTL reiniciado desde aquí
    clock.advance(999);

    expect(cache.get('k')).toBe('v2');
  });
});
