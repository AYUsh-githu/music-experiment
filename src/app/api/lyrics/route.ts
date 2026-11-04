/**
 * GET /api/lyrics — Lyrics endpoint (plan §3.4 / Phase 3, Task 1).
 *
 * Fetches plain + time-synced lyrics from LRCLIB (keyless, CORS-open).
 *
 * Strategy:
 *   1. Prefer exact match: `GET /api/get?track_name=&artist_name=&album_name=&duration=`.
 *   2. On a non-happy response or a miss, fall back to
 *      `GET /api/search?q=<title> <artist>` and pick the result whose duration is
 *      closest to the track's real duration.
 *
 * Every external call is wrapped in try/catch with a 10s AbortController timeout —
 * never throw raw, never leak stack traces. Failures surface as typed ApiError /
 * LyricsResponse envelopes (an `ok: false` union branch), matching the app-wide
 * API contract established by the search route.
 */
import { NextRequest, NextResponse } from "next/server";
import { parseLRC } from "@/lib/client/lyricsParser";
import type { LyricLine } from "@/lib/client/lyricsParser";
import type { ApiError } from "@/lib/types";

/** URL-encoded track context. */
interface LyricsQuery {
  title: string;
  artist: string;
  album?: string;
  duration?: number; // seconds
}

/**
 * Shape of a single candidate returned by LRCLIB's JSON endpoints.
 * We only consume the fields we need; every name is optional defensively so a
 * schema drift upstream degrades to a typed miss rather than a crash.
 */
interface LrclibTrack {
  id?: number;
  trackName?: string | null;
  artistName?: string | null;
  albumName?: string | null;
  duration?: number | null;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

/**
 * Success envelope for this endpoint. `plain` is the raw plainLyrics text; an
 * optional `synced` array carries the parsed LRC lines. When there is no synced
 * data we return only `plain` so the client shows a plain-lyrics fallback.
 *
 * WHY `LyricLine` is imported (not redefined): this route authorizes the import
 * from the parser util so both share one definition. The endpoint's lyrics types
 * intentionally live here rather than types.ts to stay scoped to Task 1.
 */
export type LyricsResponse =
  | { ok: true; plain?: string; synced?: LyricLine[] }
  | { ok: false; code: string; message: string };

/** LRCLIB asks for a client id header to raise rate limits (~90 req/min). */
const LRCLIB_CLIENT_HEADER = "Sonic v1.0 (personal-project)";

const TIMEOUT_MS = 10_000;
const LRCLIB_BASE = "https://lrclib.net/api";

/**
 * Handles `GET /api/lyrics?title=&artist=&album=&duration=`.
 *
 * - `title` and `artist` are required; missing → 400 BAD_REQUEST.
 * - Calls LRCLIB's `/api/get` first, then `/api/search` on a miss.
 * - No lyrics at all → 404 NO_LYRICS.
 * - Any provider failure → typed 502 (LYRICS_UNAVAILABLE) or 429-adjacent error.
 */
export async function GET(
  request: NextRequest,
): Promise<NextResponse<LyricsResponse>> {
  const query = readQuery(request);
  if (!query.title || !query.artist) {
    return err("BAD_REQUEST", "Missing title or artist", 400);
  }

  // Try exact match first, then search-based closest-duration fallback.
  const exact = await fetchJson<LrclibTrack>(buildGetUrl(query));
  if (exact !== null && hasLyrics(exact)) {
    return okResponse(exact);
  }

  // Fallback: search and pick the closest-duration match.
  const fallback = await fetchSearchFallback(query);
  if (fallback !== null && hasLyrics(fallback)) {
    return okResponse(fallback);
  }

  return err("NO_LYRICS", "No lyrics found for this track.", 404);
}

/* -------------------------------------------------------------------------- */
/* JSON fetch helpers (shared by both LRCLIB calls)                            */
/* -------------------------------------------------------------------------- */

/**
 * Builds the LRCLIB `/api/get` URL from the track query. Only includes params
 * that were actually provided (LRCLIB treats an empty album_name as a
 * wildcard, which can hurt exact matching).
 */
function buildGetUrl(q: LyricsQuery): string {
  const url = new URL(`${LRCLIB_BASE}/get`);
  url.searchParams.set("track_name", q.title);
  url.searchParams.set("artist_name", q.artist);
  if (q.album) url.searchParams.set("album_name", q.album);
  if (typeof q.duration === "number" && Number.isFinite(q.duration)) {
    url.searchParams.set("duration", String(Math.round(q.duration)));
  }
  return url.toString();
}

/**
 * LRCLIB `/api/search` fallback. Searches `<title> <artist>`, then picks the
 * candidate whose `duration` is closest to the requested track's duration.
 * Returns the single best match (or null when nothing qualifies).
 */
async function fetchSearchFallback(q: LyricsQuery): Promise<LrclibTrack | null> {
  const url = new URL(`${LRCLIB_BASE}/search`);
  url.searchParams.set("q", `${q.title} ${q.artist}`.trim());

  const list = await fetchJson<LrclibTrack[]>(url.toString());
  if (!Array.isArray(list) || list.length === 0) return null;

  // Best-effort closest-duration pick. Without a known duration we take the
  // first candidate (LRCLIB returns results sorted by relevance).
  if (typeof q.duration !== "number" || !Number.isFinite(q.duration)) {
    return list[0] ?? null;
  }

  let best: LrclibTrack | null = null;
  let bestDelta = Infinity;
  for (const cand of list) {
    const candDur = typeof cand.duration === "number" ? cand.duration : NaN;
    const delta = Math.abs(candDur - q.duration);
    if (Number.isFinite(delta) && delta < bestDelta) {
      bestDelta = delta;
      best = cand;
    }
  }
  return best;
}

/**
 * Fetches a JSON body from LRCLIB with the app-wide resilience policy:
 *  - 10s timeout via AbortController (never leave a request hanging).
 *  - Correct client-id + browser UA headers for better rate limits.
 *  - `Retry-After`-aware 429 handling: one short wait, then a typed miss (so we
 *    can still try another strategy) — the final fallback to NO_LYRICS keeps the
 *    client from seeing a raw 5xx.
 *
 * Returns parsed JSON on success, or `null` on any non-2xx / network error /
 * timeout. Distinguishing "no result" from "upstream failed" is unnecessary
 * here: both should funnel into the search fallback and then NO_LYRICS.
 */
async function fetchJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    // One real retry after a 429: the Retry-After wait sits between attempts, and
    // only a second 429 (or any other non-ok on the retry) makes us give up.
    for (let attempt = 0; attempt < 2; attempt++) {
      const res = await fetch(url, {
        headers: {
          // LRCLIB's documented client-id header; the UA also carries the same
          // client value so its rate-limit heuristics recognise us.
          "Lrclib-Client": LRCLIB_CLIENT_HEADER,
          "X-User-Agent": LRCLIB_CLIENT_HEADER,
        },
        signal: controller.signal,
      });

      if (res.status === 429) {
        const retrySec = Number(res.headers.get("retry-after")) || 1;
        // Short, bounded wait (LRCLIB uses seconds, but never block the request
        // pipeline for more than ~2s even if the header claims otherwise).
        await new Promise((r) => setTimeout(r, Math.min(retrySec, 2) * 1000));
        console.warn(`[api/lyrics] 429 from LRCLIB, retried after ${retrySec}s`);
        continue; // one more attempt with the very same request
      }

      if (!res.ok) {
        // e.g. 404 from /api/get → a clean miss, not an exception.
        console.warn(`[api/lyrics] LRCLIB returned ${res.status} for ${url}`);
        return null;
      }

      return (await res.json()) as T;
    }

    // Both attempts were throttled — surface a miss rather than a raw 5xx.
    console.warn(`[api/lyrics] LRCLIB still 429 for ${url}`);
    return null;
  } catch (err) {
    // Timeout (abort), network error, or JSON parse failure. Log the cause
    // server-side; the caller degrades to the fallback / typed error.
    console.error(`[api/lyrics] fetch failed for ${url}`, err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Response builders                                                           */
/* -------------------------------------------------------------------------- */

/** True when a candidate carries usable lyric text (plain and/or synced). */
function hasLyrics(t: LrclibTrack | null | undefined): boolean {
  if (!t) return false;
  return Boolean(
    (t.plainLyrics && t.plainLyrics.trim()) ||
      (t.syncedLyrics && t.syncedLyrics.trim()),
  );
}

/**
 * Builds the success envelope. Plain text is always included when present; the
 * synced lines are only added when the LRC parser produces valid timestamps.
 * When only plain lyrics exist, `synced` is omitted so the client displays the
 * plain-lyrics fallback.
 */
function okResponse(t: LrclibTrack): NextResponse<LyricsResponse> {
  const payload: LyricsResponse = { ok: true };

  const plain = t.plainLyrics?.trim();
  if (plain) payload.plain = plain;

  const synced = t.syncedLyrics ? parseLRC(t.syncedLyrics) : null;
  if (synced) payload.synced = synced;

  return NextResponse.json(payload);
}

/** Standard typed error envelope — kept internal so callers stay terse. */
function err(
  code: string,
  message: string,
  status: number,
): NextResponse<LyricsResponse> {
  const body: ApiError = { ok: false, code, message };
  return NextResponse.json(body, { status });
}

/** Reads + validates the track query params from the request. */
function readQuery(request: NextRequest): LyricsQuery {
  const sp = request.nextUrl.searchParams;
  const durationRaw = sp.get("duration");
  const duration = durationRaw ? Number(durationRaw) : undefined;
  return {
    title: sp.get("title")?.trim() ?? "",
    artist: sp.get("artist")?.trim() ?? "",
    album: sp.get("album")?.trim() || undefined,
    duration:
      duration !== undefined && Number.isFinite(duration) ? duration : undefined,
  };
}
