/**
 * Small TTL + LRU cache used by server-side utilities.
 *
 * WHY: stream URLs from YouTube are valid only ~6h, and resolving them is
 * relatively expensive. Within a session we cache resolved URLs (TTL ≤ 4h,
 * plan §3.1 / §4.4) and source-health probes (60s) to avoid redundant work.
 *
 * This is intentionally dependency-free and safe for a single server process.
 * It is NOT for shared/durable state — that lives in the client's IndexedDB.
 */

interface Entry<V> {
  value: V;
  expiresAt: number; // epoch ms
}

/**
 * A TTL cache with approximate-LRU eviction. Keys are strings; values are
 * arbitrary. `maxSize` trades memory for hit-rate.
 */
export class TTLCache<V> {
  private store = new Map<string, Entry<V>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs: number, maxSize = 200) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  /** Returns the value if present and not expired, else undefined. */
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    // Re-insert to simulate "recently used" ordering for LRU eviction.
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /**
   * Stores a value with a fresh TTL. Evicts oldest when over capacity.
   *
   * `ttlMsOverride` bounds THIS entry instead of the cache-wide default, for
   * values that carry their own expiry. WHY it exists: resolved stream URLs
   * advertise an `expiresSec`, and that advertised life is the only honest bound
   * for that one entry — a single blanket TTL either expires short-lived URLs too
   * late (serving dead links) or throws away long-lived ones too early. The
   * override is clamped to the cache default so a caller can only ever make an
   * entry SHORTER-lived, never extend it past the cache-wide policy.
   */
  set(key: string, value: V, ttlMsOverride?: number): void {
    this.store.delete(key);
    const ttl =
      typeof ttlMsOverride === "number" && Number.isFinite(ttlMsOverride) && ttlMsOverride > 0
        ? Math.min(ttlMsOverride, this.ttlMs)
        : this.ttlMs;
    this.store.set(key, { value, expiresAt: Date.now() + ttl });
    if (this.store.size > this.maxSize) {
      // Map preserves insertion order; the first key is the least-recently-set.
      const oldest = this.store.keys().next().value;
      if (oldest !== undefined) this.store.delete(oldest);
    }
  }

  /**
   * Removes a single key (used when e.g. a source health probe goes stale, or a
   * resolved stream URL is found dead). Returns whether an entry was actually
   * removed, so callers can log "evicted a stale entry" vs "nothing to evict"
   * without a second lookup.
   */
  delete(key: string): boolean {
    return this.store.delete(key);
  }

  /** Current number of unexpired entries (for logs). */
  get size(): number {
    return this.store.size;
  }
}

/** Health-probe cache: YT availability, ~60s. */
export const healthCache = new TTLCache<boolean>(60_000, 32);

/**
 * Resolved stream-URL cache. Key = `stream:${trackId}:${quality}`.
 *
 * WHY 30 minutes and not the nominal 4–6h the sources advertise: verified
 * 2026-10-28, YouTube/googlevideo invalidates an extracted URL long before its
 * `expire=` parameter. A URL resolved ~30 min prior returned 403 from
 * googlevideo itself (fetched directly, no proxy involved), while a freshly
 * resolved one for the same video returned 200. A cache that outlives the real
 * URL turns the second play of a track into silence. The advertised
 * `expiresSec` is also passed per-entry (see `set`'s override) so each entry is
 * bounded by the shorter of the two.
 */
export const streamCache = new TTLCache<string>(30 * 60 * 1000, 256);
