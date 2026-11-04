/**
 * JioSaavn music source — the plan's fallback audio/metadata backend.
 *
 * WHY it exists: the primary source (YouTube) breaks periodically (PO-Token /
 * 403) and iTunes previews are only 30s clips. Saavn gives full-length song
 * streams + real search results, so when saavn.dev is reachable it is the
 * strongest fallback in the three-source failover topology (YouTube → Saavn →
 * iTunes).
 *
 * STATUS (verified this phase): the public instance `https://saavn.dev` is
 * CURRENTLY DOWN in this environment (ENOTFOUND). This source is therefore
 * written "hot" — fully implemented, correct, and probing — so the moment the
 * host resolves, failover works with ZERO code changes. Every network call
 * goes through fetchJson (already constructs the "saavn" error source from the
 * URL), and every method maps failures into typed ServiceError — never a raw
 * exception.
 *
 * The base URL is deliberately centralized in one const: if the instance
 * moves, restoring Saavn is a one-line edit here.
 */
import { healthCache, TTLCache } from "@/lib/server/cache";
import { buildProxyUrl, fetchJson } from "@/lib/server/http";
import { cleanTrackQuery } from "@/lib/server/text";
import type { Track, SearchOpts, StreamResult } from "@/lib/types";
import type { MusicSource, ServiceError } from "@/lib/server/sources/types";

/**
 * Base URL for the Saavn unofficial API. Read from SAAVN_API_BASE so a
 * self-hosted instance (the sumitkolhe/jiosaavn-api clone) can replace the
 * public saavn.dev host, falling back to saavn.dev when the env var is unset
 * (ZERO-secret default). ENDPOINT TREE NOTE: the env var is the host root
 * (e.g. `http://localhost:3001`); both the clone and saavn.dev expose their
 * API under an `/api` path prefix, so we append `/api` here. Endpoints below
 * join with `${BASE}/<path>`; never leave a trailing slash.
 */
function apiBase(): string {
  const configured = process.env.SAAVN_API_BASE;
  if (configured) return `${configured.replace(/\/+$/, "")}/api`;
  return "https://saavn.dev/api";
}

/** Highest→lowest quality preference when picking a downloadUrl entry. */
const QUALITY_ORDER = ["320kbps", "160kbps", "12kbps"] as const;

/** MIME echoed to /api/proxy; saavn.dev exposes MP3 streams. */
const STREAM_MIME = "audio/mp3";

/** Proxied stream URLs from saavn.dev CDNs are stable; 1h is plenty. */
const STREAM_EXPIRY_SEC = 3600;

/** DSP string sent with every search query so pagination stays aligned. */
const DEFAULT_LIMIT = 20;

/**
 * TTL cache mapping a cleaned search query → the chosen Saavn song id.
 *
 * WHY: resolveStreamFor pays a network search per unique track. Re-resolving
 * the same track repeatedly (each /api/stream call goes through failover) would
 * re-hit Saavn every time. Keying on the *cleaned* query string (via
 * cleanTrackQuery) keeps the mapping stable and lets repeated resolves for the
 * same track share one search. 1h matches the iTunes/Saavn metadata cadence.
 */
const idCache = new TTLCache<string>(60 * 60 * 1000, 256);

/* -------------------------------------------------------------------------- */
/* Defensive payload shapes (saavn.dev is an unofficial, evolving API).        */
/* -------------------------------------------------------------------------- */

/** A raw song row from saavn.dev. All fields optional so a slightly-off
 *  payload degrades to a skipped row / [] — never a crash. */
interface SaavnSong {
  id?: string;
  name?: string;
  duration?: number;
  image?: { quality?: string; url?: string }[];
  artists?: { primary?: { name?: string }[] };
  downloadUrl?: { quality?: string; url?: string }[];
}

/** Search response envelope: { success: true, data: { results: [...] } }. */
interface SaavnSearchResponse {
  success?: boolean;
  data?: { results?: SaavnSong[] };
}

/** Song lookup envelope. NOTE: the self-hosted clone returns `data` as an ARRAY
 *  of songs (data[0] holds the resolved song) while saavn.dev returns a single
 *  object; tolerate both so one resolver serves either backend. */
interface SaavnSongResponse {
  success?: boolean;
  data?: SaavnSong | SaavnSong[];
}

/** Builds a typed ServiceError with the 'saavn' source label. */
function saavnError(code: string, message: string): ServiceError {
  return { ok: false, code, message, source: "saavn" };
}

/** Matches the optional chaining on a possibly-absent results array. */
function emptySongs(): SaavnSong[] {
  return [];
}

export class SaavnSource implements MusicSource {
  readonly id = "saavn" as const;

  /**
   * Searches JioSaavn songs and normalizes the hits into Tracks.
   *
   * WHY: search builds only metadata + ids (`saavn:${song.id}`); streams are
   * resolved lazily at play time via getStream (they expire and cost a lookup).
   * We reuse the song's own `id` as videoId — the getStream endpoint keys off it.
   * Defensive: any malformed row (missing id/name/artwork) is skipped rather
   * than crashing the whole result set.
   */
  async search(q: string, opts?: SearchOpts): Promise<Track[]> {
    const limit = opts?.limit ?? DEFAULT_LIMIT;
    const query = encodeURIComponent(q);
    const url = `${apiBase()}/search/songs?query=${query}&limit=${limit}`;

    const body = await fetchJson<SaavnSearchResponse>(url);
    return normalizeResults(body.data?.results ?? emptySongs());
  }

  /**
   * Resolves a playable stream for an arbitrary track via a search-then-lookup.
   *
   * WHY this exists (Bug #4): the resolver previously passed a *YouTube* video id
   * into getStream (the `/songs/{id}` endpoint), but that endpoint expects a
   * numeric Saavn song id — so the fallback never matched. This method bridges
   * the gap by deriving Saavn's id from the track's cleaned title/artist:
   *   1) search Saavn for the cleaned `<title> <artist>` query,
   *   2) pick the best hit (duration within ±3s of the track when known,
   *      otherwise the first hit),
   *   3) resolve the selected hit's proxy URL — reusing the row's own
   *      downloadUrl when present, else the `/songs/{id}` lookup via getStream,
   *   4) cache the query→id mapping (1h) so repeated resolves skip re-searching.
   *
   * Fails soft with a typed ServiceError (STREAM_UNAVAILABLE) when Saavn finds
   * nothing usable, so the resolver continues to fail over to iTunes.
   */
  async resolveStreamFor(track: Track): Promise<StreamResult> {
    const query = cleanTrackQuery(track);
    if (!query) {
      throw saavnError("STREAM_UNAVAILABLE", "No clean title/artist to search Saavn with");
    }

    // Cache hit: reuse the known id without re-searching — the cleaned query is
    // a stable key, so repeated resolves for the same track amortize one search.
    const cachedId = idCache.get(query);
    if (cachedId) {
      return this.resolveById(cachedId);
    }

    const url = `${apiBase()}/search/songs?query=${encodeURIComponent(query)}&limit=${DEFAULT_LIMIT}`;
    const body = await fetchJson<SaavnSearchResponse>(url);
    const results = body.data?.results ?? emptySongs();
    const chosen = pickBestMatch(results, track);

    if (!chosen?.id) {
      throw saavnError("STREAM_UNAVAILABLE", `No Saavn match for "${query}"`);
    }

    // Persist the mapping so the next resolve for this track is a cache hit.
    idCache.set(query, chosen.id);

    // Prefer the search row's own downloadUrl (avoids a second lookup); the row
    // may not carry a playable entry, in which case getStream does /songs/{id}.
    const directUrl = pickBestDownload(chosen.downloadUrl ?? []);
    if (directUrl) {
      return {
        url: buildProxyUrl(directUrl, STREAM_MIME),
        format: STREAM_MIME,
        expiresSec: STREAM_EXPIRY_SEC,
      };
    }
    return this.getStream(chosen.id);
  }

  /**
   * Resolves a direct, proxied audio URL for a song id.
   *
   * WHY: a search row carries no playable stream, so we look the song up by id
   * (GET /songs/{id}) whose body carries `downloadUrl` entries. We pick the
   * highest available quality (320kbps → 160kbps → 12kbps) and route it through
   * buildProxyUrl so the browser <audio> element gets a same-origin URL (the
   * saavn.dev CDN sends no CORS headers). When no downloadable URL exists we
   * throw a typed STREAM_UNAVAILABLE so the resolver fails over — never return
   * a broken URL.
   */
  async getStream(id: string): Promise<StreamResult> {
    return this.resolveById(id);
  }

  /** Shared /songs/{id} + pick-download step for both resolve-path call sites. */
  private async resolveById(id: string): Promise<StreamResult> {
    const songId = encodeURIComponent(id);
    const url = `${apiBase()}/songs/${songId}`;

    const body = await fetchJson<SaavnSongResponse>(url);
    // The clone's /songs/{id} returns `data` as a single-element array; saavn.dev
    // returns a single object. Unwrap the array form so the downloadUrl lookup
    // below sees one song regardless of backend.
    const song = Array.isArray(body.data) ? body.data[0] : body.data;
    const downloadUrls = song?.downloadUrl ?? [];

    const chosen = pickBestDownload(downloadUrls);
    if (!chosen) {
      throw saavnError(
        "STREAM_UNAVAILABLE",
        "No downloadable stream found for this Saavn song",
      );
    }

    return {
      url: buildProxyUrl(chosen, STREAM_MIME),
      format: STREAM_MIME,
      expiresSec: STREAM_EXPIRY_SEC,
    };
  }

  /**
   * Related-tracks radio for Saavn.
   *
   * WHY it can be an empty stub: Phase-4 radio (per plan §4.2) resolves related
   * tracks through the resolver's search fallback for Saavn rather than a
   * dedicated /recommend endpoint — this source contributes no cheap dedicated
   * call, so returning [] keeps cost at zero and delegates the value up.
   */
  async getRelated(_id: string): Promise<Track[]> {
    return [];
  }

  /**
   * Real liveness probe of the saavn.dev API, cached ~60s.
   *
   * WHY: isAvailable() gates whether the resolver attempts the Saavn fallback,
   * and the whole point is that it must FLIP AUTOMATICALLY when the host comes
   * back. A tiny 1-result search is a cheap, authoritative check; the result is
   * cached in healthCache under "saavn" for 60s so repeated lookups reuse the
   * answer instead of hammering the API.
   */
  async isAvailable(): Promise<boolean> {
    const cached = healthCache.get("saavn");
    if (cached !== undefined) return cached;

    const probe = async (): Promise<boolean> => {
      try {
        await fetchJson<SaavnSearchResponse>(
          `${apiBase()}/search/songs?query=test&limit=1`,
        );
        return true;
      } catch {
        return false;
      }
    };

    const result = await probe();
    healthCache.set("saavn", result);
    return result;
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Normalizes raw saavn.dev song rows into app Tracks, skipping malformed rows.
 *
 * @param results raw song rows from a search (or an empty list on missing data)
 * @returns normalized Tracks
 */
function normalizeResults(results: SaavnSong[]): Track[] {
  const tracks: Track[] = [];
  for (const song of results) {
    // Skip rows we can't key or display — no id → no stream resolution; no
    // name → unusable in the queue UI. This keeps a slightly-off payload from
    // ever crashing the list.
    if (!song.id || !song.name) continue;

    const artwork = largestArtwork(song);
    tracks.push({
      id: `saavn:${song.id}`,
      source: "saavn",
      videoId: song.id,
      title: song.name,
      artist: song.artists?.primary?.[0]?.name ?? "Unknown",
      duration: typeof song.duration === "number" ? song.duration : 0,
      artwork,
      // Not enriched via iTunes — marked false so the client doesn't assume a match.
      matched: false,
    });
  }
  return tracks;
}

/**
 * Returns the largest/dominant artwork URL from a song row, or "" if none.
 *
 * WHY: saavn.dev `image` is an array of {quality, url} entries ordered
 * small→large (e.g. "50x50" → "500x500"). Taking the LAST entry yields the
 * largest cover the API provides — the same convention the client uses to swap
 * for an even larger art size when present.
 */
function largestArtwork(song: SaavnSong): string {
  const images = song.image ?? [];
  const last = images.length > 0 ? images[images.length - 1] : undefined;
  return last?.url ?? "";
}

/**
 * Picks the best search hit for a track.
 *
 * WHY: a Saavn search returns several slightly-different rows (remix, cover,
 * live) and the first isn't always the canonical recording. When the requesting
 * track carries a real duration (> 0), bias toward a row whose duration is
 * within ±3s — that anonymity check strongly disambiguates the right version;
 * otherwise fall back to the first row. Returns undefined when there is no row.
 */
function pickBestMatch(results: SaavnSong[], track: Track): SaavnSong | undefined {
  if (results.length === 0) return undefined;
  // The first hit is our catch-all fallback when the track has no duration to
  // disambiguate by.
  const first = results[0];
  if (typeof track.duration === "number" && track.duration > 0) {
    // Prefer the first row within ±3s; keep the search order (API relevance) as a
    // tie-break so the "best" is still the most relevant even when several match.
    const within = results.find((r) => {
      const d = r.duration;
      return typeof d === "number" && Math.abs(d - track.duration) <= 3;
    });
    return within ?? first;
  }
  return first;
}

/**
 * Picks the highest-quality playable download URL from a song's downloadUrl.
 *
 * @param entries raw downloadUrl entries ({quality, url}) for one song
 * @returns the URL string of the best available quality, or "" if none playable
 *
 * WHY: saavn.dev lists the same stream at several bitrates. We want the best
 * audible quality, but only downstream if a real URL exists.
 */
function pickBestDownload(entries: { quality?: string; url?: string }[]): string {
  for (const quality of QUALITY_ORDER) {
    const entry = entries.find(
      (d) => d?.quality === quality && typeof d?.url === "string" && d.url.length > 0,
    );
    if (entry?.url) return entry.url;
  }
  return "";
}
