/**
 * Source orchestrator / failover resolver.
 *
 * WHY this file is the single choreography point: every route handler asks the
 * resolver "give me tracks" or "resolve a stream" and never needs to know which
 * backend answered. Failover (yt-dlp primary → YouTube → Saavn (health-gated) →
 * iTunes preview → typed error) lives here so it happens exactly once, in one place.
 *
 * IMPORTANT (verified 2026-10-26, BACKEND REBUILD): yt-dlp (bin/yt-dlp.exe) is
 * the NEW PRIMARY stream source. It produces a real, proxied googlevideo audio
 * URL keylessly, so full-track playback works. YouTube (youtubei.js, IOS/ANDROID_VR
 * client matrix) is secondary. Saavn (self-hosted :3001 or saavn.dev) and the
 * iTunes 30s preview are the final fallbacks.
 */
import { YouTubeSource } from "@/lib/server/sources/YouTubeSource";
import { iTunesSource, enrichFromItunes } from "@/lib/server/sources/iTunesSource";
import { SaavnSource } from "@/lib/server/sources/SaavnSource";
import { YtDlpSource } from "@/lib/server/sources/YtDlpSource";
import { streamCache } from "@/lib/server/cache";
import type { Track } from "@/lib/types";
import type { ServiceError } from "@/lib/server/sources/types";

/** Single shared instances — never recreate per request (reuse caches + Innertube). */
export const sources: {
  youtube: YouTubeSource;
  itunes: iTunesSource;
  saavn: SaavnSource;
  ytdlp: YtDlpSource;
} = {
  youtube: new YouTubeSource(),
  itunes: new iTunesSource(),
  saavn: new SaavnSource(),
  ytdlp: new YtDlpSource(),
};

/** Backends that can actually answer a stream resolution. */
export type StreamSource = "youtube" | "itunes" | "saavn" | "ytdlp";

/** Result of resolving a playable stream, with which backend answered. */
export interface ResolvedStream {
  url: string;
  format: string;
  source: StreamSource;
  expiresSec: number;
}

/**
 * Searches YouTube and returns enriched tracks (hi-res iTunes artwork).
 *
 * WHY: search/metadata comes from YouTube; cover art is upgraded via iTunes.
 * Enrichment is best-effort — we use Promise.allSettled semantics so a library
 * that throws for one track never discards the other (already-valid) YT results.
 */
export async function searchTracks(q: string, limit?: number): Promise<Track[]> {
  const tracks = await sources.youtube.search(q, { limit });
  const settled = await Promise.allSettled(
    tracks.map((t) => enrichFromItunes(t)),
  );
  // enriched.length === tracks.length by construction (index-aligned); on a
  // rejected enrichment fall back to the original YT track for that index so
  // a single iTunes failure never drops a valid YouTube result.
  return settled.map((r, i) => (r.status === "fulfilled" ? r.value : tracks[i]));
}

/**
 * Resolves a playable stream for a track with automatic failover:
 *   yt-dlp (PRIMARY, keyless) → YouTube (youtubei.js matrix) → Saavn (only if
 *   healthy) → iTunes preview → on total failure → typed NO_SOURCE error.
 *
 * WHY yt-dlp is primary (BACKEND REBUILD): it can extract a real, proxied
 * googlevideo audio URL with zero API keys — the thing youtubei.js couldn't do
 * reliably (PO-Token). When the track already has a YouTube videoId we extract
 * directly (`getStream`); otherwise (Saavn/library tracks) we meta-search
 * (`resolveStreamFor`). An empty `url` from yt-dlp is a typed FAILURE that
 * triggers failover — never faked success.
 *
 * `quality` (plan §4.3) threads through to YouTube's format selection. Saavn sits
 * between as a true fallback but is gated behind its cheap `isAvailable()` probe
 * (cached 60s) — when the host is down (ENOTFOUND) we skip it without paying a
 * per-track network timeout, and the moment it flips healthy the four-source
 * failover re-activates with zero code changes. Failovers are console.warn'd so
 * fallback is visible in logs (§5.3).
 *
 * Streams are cached server-side (plan §4.4): a resolved URL is valid ~6h, so
 * re-resolving the same track+quality within the 4h TTL reuses the cached
 * /api/proxy URL instead of paying a full extraction + chooseFormat. Only genuinely
 * playable resolutions are cached — a failed/empty resolution is never stored
 * (would poison the window).
 */
export async function resolveStream(
  track: Track,
  opts?: { quality?: "best" | "low" },
): Promise<ResolvedStream> {
  const quality = opts?.quality ?? "best";

  // 4a) Cache hit → return the previously resolved /api/proxy URL immediately.
  // The cache key includes quality: 'best' and 'low' resolutions of the same
  // track are different payloads and must not collide (verifier finding).
  const cacheKey = streamCacheKey(track, quality);
  const cached = streamCache.get(cacheKey);
  if (cached) {
    const hit = parseCachedStream(cached);
    // Defensive: reuse only a well-formed entry — a corrupt/legacy JSON string
    // must not short-circuit failover (e.g. resolve again normally).
    if (hit && hit.url) return hit;
  }

  let resolved: ResolvedStream | undefined;

  // New PRIMARY: yt-dlp keyless extraction. Cheap when we already have the
  // videoId; meta-search fallback otherwise. Empty url ⇔ extraction failed → next.
  try {
    const yd =
      track.videoId && /^[A-Za-z0-9_-]{6,32}$/.test(track.videoId)
        ? await sources.ytdlp.getStream(track.videoId)
        : await sources.ytdlp.resolveStreamFor(track);
    if (yd.url) resolved = { ...yd, source: "ytdlp" };
  } catch (err) {
    console.warn(
      `[resolveStream] yt-dlp failed for "${track.title}" (${(err as Error)?.message ?? err}) — trying YouTube/Saavn/iTunes`,
    );
  }

  if (!resolved) {
    try {
      const yt = await sources.youtube.getStream(track.videoId || "", { quality });
      // Defensive: only trust it if a real URL came back.
      if (yt.url) {
        resolved = { ...yt, source: "youtube" };
      }
    } catch (err) {
      console.warn(
        `[resolveStream] youtube failed for "${track.title}" (${(err as Error)?.message ?? err}) — trying Saavn/iTunes`,
      );
    }
  }

  // Saavn is a genuine middle fallback, but only attempted when its (cached 60s)
  // health probe says it is reachable — otherwise we'd block on a dead host for
  // every stream and make playback slower for zero benefit.
  if (!resolved && (await sources.saavn.isAvailable())) {
    try {
      // resolveStreamFor searches Saavn by the track's cleaned title/artist and
      // resolves the *Saavn* song id it finds — NOT the YouTube videoId (Bug #4).
      // Passing track.videoId here was the bug: /songs/{id} expects a numeric
      // Saavn id, and a YouTube id never matched, so the fallback never fired.
      const sn = await sources.saavn.resolveStreamFor(track);
      if (sn.url) resolved = { ...sn, source: "saavn" };
    } catch (err) {
      console.warn(
        `[resolveStream] saavn failed for "${track.title}" (${(err as Error)?.message ?? err}) — trying iTunes`,
      );
    }
  }

  if (!resolved) {
    try {
      const it = await sources.itunes.resolvePreviewFor(track);
      resolved = { ...it, source: "itunes" };
    } catch (err) {
      console.warn(
        `[resolveStream] itunes failed for "${track.title}" (${(err as Error)?.message ?? err}) — no source left`,
      );
    }
  }

  if (!resolved) {
    const noSource: ServiceError = {
      ok: false,
      code: "NO_SOURCE",
      message: "Track unavailable — no stream source responded",
      source: "itunes",
    };
    throw noSource;
  }

  // 4b) Cache the final playable /api/proxy URL (only when it's real + typed).
  // Guarded: a store/`set` failure must never discard a resolution that worked
  // (it would turn a playable URL into a spurious 503), per §4.4 "guard against
  // caching failures".
  //
  // The entry is bounded by the SOURCE'S OWN advertised life (`expiresSec`) as
  // well as the cache default — the advertised value is the more honest bound
  // for a single URL, and the cache clamps it so it can never extend an entry.
  //
  // The URL is tagged with `cacheKey` on the way out (and cached tagged, so a
  // hit returns the same shape) — that tag is what lets /api/proxy evict THIS
  // entry when the origin rejects the URL as stale. See buildProxyUrl.
  if (resolved.url && resolved.format) {
    resolved = { ...resolved, url: tagProxyUrl(resolved.url, cacheKey) };
    try {
      const advertisedMs = resolved.expiresSec > 0 ? resolved.expiresSec * 1000 : undefined;
      streamCache.set(cacheKey, serializeCachedStream(resolved), advertisedMs);
    } catch (err) {
      console.warn(`[resolveStream] cache write failed for "${track.title}" (${(err as Error)?.message ?? err}) — streaming uncached`);
    }
  }
  return resolved;
}

/**
 * Appends the stream-cache key to an /api/proxy URL as `ck`, so a URL that dies
 * at the origin can be traced back to the exact cache entry that handed it out.
 *
 * WHY here and not in each source: the key is a resolver concept (it composes
 * the track id with the quality), so the resolver is the only layer that knows
 * it. Sources keep building plain proxy URLs; the tag is added once, centrally.
 * Idempotent — an already-tagged URL is returned unchanged, so re-caching a
 * cache hit cannot stack duplicate params.
 */
function tagProxyUrl(proxyUrl: string, cacheKey: string): string {
  if (!proxyUrl.startsWith("/api/proxy") || proxyUrl.includes("&ck=")) return proxyUrl;
  // The key is a plain `stream:<id>:<quality>` string, but it still gets encoded
  // so a track id containing '&' or '#' can never split the query string.
  return `${proxyUrl}&ck=${encodeURIComponent(cacheKey)}`;
}

/**
 * Drops a cached stream resolution by its proxy-URL tag.
 *
 * WHY this is exported: /api/proxy is the only place that observes an origin
 * rejecting a URL (403/410) for a link we previously handed out as playable.
 * When that happens the cached entry is known-dead, so evicting it here makes
 * the very next play re-resolve from scratch instead of replaying the corpse.
 * Unknown/absent keys are a no-op — eviction must never be able to throw into
 * the proxy's response path.
 */
export function invalidateStreamByTag(tag: string): boolean {
  if (!tag) return false;
  try {
    return streamCache.delete(tag);
  } catch {
    return false;
  }
}

/**
 * Cache key for a resolved stream. Namespaced by 'stream:' and the track's
 * stable id (`yt:<videoId>` etc.), PLUS the requested quality so a 'best' and a
 * 'low' resolution of the same track never collide in the shared cache (they
 * are different payloads — same track, different format choice).
 */
function streamCacheKey(track: Track, quality: "best" | "low"): string {
  return `stream:${track.id}:${quality}`;
}

/**
 * Serializes a resolved stream into the string value stored in streamCache.
 *
 * WHY JSON-as-string: the shared cache (src/lib/server/cache.ts) is typed
 * TTLCache<string> — we encode the full { url, format, source, expiresSec }
 * so a cache hit can reconstruct a *typed* ResolvedStream without re-resolving.
 */
function serializeCachedStream(r: ResolvedStream): string {
  return JSON.stringify({ ...r });
}

/** Safely parses a cached stream string; returns undefined when malformed. */
function parseCachedStream(raw: string): ResolvedStream | undefined {
  try {
    const o = JSON.parse(raw) as Partial<ResolvedStream>;
    if (typeof o.url === "string" && o.url && typeof o.format === "string") {
      return {
        url: o.url,
        format: o.format,
        source:
          o.source === "youtube" || o.source === "saavn" || o.source === "ytdlp"
            ? o.source
            : "itunes",
        expiresSec: typeof o.expiresSec === "number" ? o.expiresSec : 3600,
      };
    }
  } catch {
    // A corrupt entry is treated as a miss — fall through to a fresh resolve.
  }
  return undefined;
}

/**
 * Returns similar tracks for radio autoplay (plan §3.6 / §4.1), best-effort:
 *   1) YouTube's native "related" feed for the video; any real result wins.
 *   2) Fallback: a YouTube search for the artist (or title), minus the given
 *      video itself, so we always have *other* tracks to queue.
 *   3) Final fallback: [] when nothing resolves — never throw (cheap; no iTunes
 *      enrichment here, per plan).
 */
export async function getRelatedTracks(
  videoId: string,
  title?: string,
  artist?: string,
  limit?: number,
): Promise<Track[]> {
  const cap = clampPositive(limit);

  // 1) Native related feed. getRelated never throws (source returns [] on
  //    failure), but guard its result defensively and drop the seed video.
  try {
    const related = await sources.youtube.getRelated(videoId);
    const others = related.filter((t) => t.videoId !== videoId);
    if (others.length >= 1) return others.slice(0, cap);
  } catch {
    // Belts and braces: a non-conforming throw still means "use the fallback".
  }

  // 2) Search fallback keyed on the artist (preferred) then the title.
  const query = artist?.trim?.() || title?.trim?.();
  if (query) {
    try {
      const results = await sources.youtube.search(query, { limit: cap });
      const others = results.filter((t) => t.videoId !== videoId);
      if (others.length >= 1) return others.slice(0, cap);
    } catch {
      // Search failed too — fall through to the empty result.
    }
  }

  // 3) No radio material available.
  return [];
}

/** Coerces undefined/zero/garbage limits to a sane positive integer default. */
function clampPositive(limit?: number): number {
  const n = Math.floor(Number(limit ?? 15));
  return Number.isFinite(n) && n > 0 ? n : 15;
}

/**
 * Returns a map of source id → availability boolean, probed in parallel.
 *
 * WHY: the API /health or debugging surfaces want one snapshot of all backends
 * without a slow serial probe. allSettled keeps one dead backend (Saavn) from
 * failing the whole report.
 */
export async function sourceHealth(): Promise<Record<string, boolean>> {
  const [youtube, itunes, saavn, ytdlp] = await Promise.allSettled([
    sources.youtube.isAvailable(),
    sources.itunes.isAvailable(),
    sources.saavn.isAvailable(),
    sources.ytdlp.isAvailable(),
  ]);
  return {
    youtube: youtube.status === "fulfilled" ? youtube.value : false,
    itunes: itunes.status === "fulfilled" ? itunes.value : false,
    saavn: saavn.status === "fulfilled" ? saavn.value : false,
    ytdlp: ytdlp.status === "fulfilled" ? ytdlp.value : false,
  };
}
