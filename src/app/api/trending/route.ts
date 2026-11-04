/**
 * GET /api/trending — "Trending / popular now" row for the Home page.
 *
 * WHY this backend is YouTube, not Deezer charts: the keyless public Deezer
 * chart/search endpoints now return EMPTY arrays for unauthenticated callers
 * (they need a token/partner_id). The reliable keyless source is the existing
 * YouTube resolver, which we already wrap server-side in searchTracks (returns
 * iTunes-enriched Track[]). So "trending" is assembled from a few rotating
 * artist seeds rather than a charts feed — deterministic-ish within an hour so
 * the row changes over time but doesn't flicker between every request.
 *
 * The route is a thin envelope mirroring src/app/api/search/route.ts: it calls
 * searchTracks with the seed queries, de-duplicates by track.id, orders
 * iTunes-matched (playable) tracks first, and maps to the canonical
 * { ok: true, results: Track[] } / ApiError contract. Any failure returns a
 * typed 502 and never throws an unhandled rejection.
 */
import { NextRequest, NextResponse } from "next/server";
import { searchTracks } from "@/lib/server/sources/resolver";
import type { ApiError, Track } from "@/lib/types";

// This route MUST be request-time (it performs real network I/O via searchTracks),
// never statically prerendered. In this Cache Components build, route segment
// configs like `dynamic='force-dynamic'` are incompatible; the supported signal is
// reading request data. Per the Next docs, the reads that block prerendering are
// `cookies()`, `headers()` and `searchParams` — NOT `request.nextUrl` on its own.
// So the handler below reads `request.nextUrl.searchParams` (an optional `limit`),
// which is both a small feature and the signal that pins this route to request time.

/**
 * Rotating pool of seed queries. "Trending" is a rough editorial stand-in: these
 * are popular ARTIST names, not generic "top hits"/"charts" phrases.
 *
 * WHY artist names (verified live): generic chart phrases ("top 2024 hits",
 * "electro hits") make YouTube return long compilation/playlist videos, which
 * iTunes cannot match — so they carry no 30s preview and are unplayable when
 * tapped. An artist-name search instead returns individual songs, ~5 of 6 of
 * which iTunes matches and can stream. That keeps the Home row actually playable.
 */
const SEED_QUERIES: readonly string[] = [
  "Taylor Swift",
  "The Weeknd",
  "Dua Lipa",
  "Ed Sheeran",
  "Billie Eilish",
  "Drake",
  "Ariana Grande",
  "Post Malone",
  "SZA",
  "Harry Styles",
  "Olivia Rodrigo",
  "Bruno Mars",
];

/**
 * How many seed queries we fan out per request. WHY 4: each artist seed yields
 * ~5 iTunes-matched songs, so 4 seeds (~20 candidates) give the matched-first
 * sort enough playable tracks to fill a 14-item row with room to spare.
 */
const QUERIES_PER_REQUEST = 4;
/** Per-query limit — kept modest so the iTunes enrichment fan-out stays cheap. */
const TRACKS_PER_QUERY = 6;
/** Cap on the final de-duplicated list so the payload stays bounded. */
const MAX_TRACKS = 14;

/**
 * A "rotation" is the starting index into SEED_QUERIES for this request.
 * WHY hour-based: deterministic within an hour (no Math.random, so SSR and
 * client-triggered refetches agree), yet rotates across hours so the row isn't
 * frozen forever.
 */
function rotationStart(now: number): number {
  const hour = Math.floor(now / (1000 * 60 * 60));
  return hour % SEED_QUERIES.length;
}

/**
 * Handles `GET /api/trending`.
 *
 * Reads `request.nextUrl.searchParams` (the optional `limit`) — and that read is
 * ALSO what pins the route to request time. Per the Next docs, the reads that
 * block prerendering are `cookies()`, `headers()` and `searchParams`; `nextUrl`
 * alone is not one, and without a request read the route was statically
 * prerendered at build and the YouTube fetches below threw the "prerender
 * complete" rejection. The `limit` is a mild feature that doubles as the signal.
 *
 * Strategy: search a window of artist seeds, de-duplicate by stable `track.id`,
 * sort each seed's bucket matched-first (iTunes-enriched => playable), then
 * INTERLEAVE the buckets round-robin so the row mixes artists and leads with
 * songs that actually have a stream rather than unmatched compilation videos.
 * Degrades gracefully: any resolver failure becomes a typed 502
 * TRENDING_FAILED, never an unhandled rejection.
 */
export async function GET(request: NextRequest): Promise<NextResponse<{ ok: true; results: Track[] } | ApiError>> {
  const rawLimit = request.nextUrl.searchParams.get("limit");
  // Optional caller-supplied cap on the final row, clamped into [1, MAX_TRACKS]
  // so a garbage/huge value can't blow up the payload.
  const cap = clampLimit(rawLimit);

  try {
    const start = rotationStart(Date.now());
    // Take a window of seeds, wrapping around the array edge so a rotation
    // landing near the end still yields a full spread.
    const seedWindow = Array.from(
      { length: QUERIES_PER_REQUEST },
      (_, i) => SEED_QUERIES[(start + i) % SEED_QUERIES.length],
    );

    // Search each seed and keep its own bucket, de-duplicated by stable
    // `track.id` across ALL buckets (the same song can match more than one seed).
    const seen = new Set<string>();
    const buckets: Track[][] = [];
    for (const query of seedWindow) {
      try {
        const tracks = await searchTracks(query, TRACKS_PER_QUERY);
        const bucket: Track[] = [];
        for (const track of tracks) {
          if (seen.has(track.id)) continue;
          seen.add(track.id);
          bucket.push(track);
        }
        if (bucket.length > 0) buckets.push(bucket);
      } catch (err) {
        // One bad seed query (e.g. a transient source outage) must not sink the
        // whole row — log and try the next seed.
        console.warn(`[api/trending] seed "${query}" failed:`, err);
      }
    }

    // Within each bucket, put iTunes-matched (playable) tracks first: `matched`
    // means the track has a 30s preview and will actually stream.
    for (const bucket of buckets) {
      bucket.sort((a, b) => Number(b.matched ?? false) - Number(a.matched ?? false));
    }

    // Interleave the buckets round-robin so the row MIXES artists (e.g. one song
    // each from four artists) instead of running six Harry Styles in a row —
    // a "trending" shelf reads as more varied and less like one artist's page.
    const results: Track[] = [];
    const maxBucket = Math.max(0, ...buckets.map((b) => b.length));
    for (let i = 0; i < maxBucket && results.length < cap; i++) {
      for (const bucket of buckets) {
        if (results.length >= cap) break;
        const track = bucket[i];
        if (track) results.push(track);
      }
    }

    if (results.length === 0) {
      // Every seed failed — surface a typed error rather than an empty "ok".
      const err: ApiError = {
        ok: false,
        code: "TRENDING_FAILED",
        message: "Trending unavailable",
        source: "youtube",
      };
      return NextResponse.json(err, { status: 502 });
    }
    return NextResponse.json({ ok: true, results });
  } catch (err) {
    // Top-level guard: never throw an unhandled rejection out of the handler.
    console.error("[api/trending] unexpected failure:", err);
    const apiErr: ApiError = {
      ok: false,
      code: "TRENDING_FAILED",
      message: "Trending unavailable",
      source: "youtube",
    };
    return NextResponse.json(apiErr, { status: 502 });
  }
}

/**
 * Parses and clamps the optional `limit` query param into the [1, MAX_TRACKS]
 * window (defaulting to MAX_TRACKS). WHY clamp: a missing/garbage/huge value must
 * not widen the row past the bounded cap — floor keeps an integer for slicing.
 */
function clampLimit(raw: string | null): number {
  if (raw === null) return MAX_TRACKS;
  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed)) return MAX_TRACKS;
  return Math.min(MAX_TRACKS, Math.max(1, parsed));
}
