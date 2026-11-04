/**
 * iTunes music source — the chosen *playable* audio backend.
 *
 * WHY it exists: YouTube search/metadata works but its streams are PO-Token
 * blocked (URL always empty). iTunes Search API returns a short 30s AAC preview
 * URL (`previewUrl`) that supports HTTP Range (206 verified), so Preview URLs
 * are the actual audio source while YouTube supplies search/metadata.
 *
 * iTunesSource implements MusicSource for completeness (id 'itunes'), but it is
 * NOT a search backend: search() returns [] and getStream() delegates to
 * resolvePreviewFor() because a bare track id carries no title/artist to query.
 */
import { healthCache } from "@/lib/server/cache";
import { buildProxyUrl, fetchJson } from "@/lib/server/http";
import { itunesFetchJson } from "@/lib/server/throttle";
import type { Track, SearchOpts, StreamResult } from "@/lib/types";
import type { MusicSource, ServiceError } from "@/lib/server/sources/types";

/** Shape of one result row returned by the iTunes Search API. */
interface ItunesResult {
  trackName?: string;
  artistName?: string;
  trackTimeMillis?: number;
  artworkUrl100?: string;
  previewUrl?: string;
  collectionName?: string;
}

/** Shape of the iTunes Search API response. */
interface ItunesSearchResponse {
  resultCount: number;
  results: ItunesResult[];
}

/** Upgrade artwork from 100x100 to 600x600 — iTunes sizes common thumbnails this way. */
const ART_SMALL = "100x100bb";

export class iTunesSource implements MusicSource {
  readonly id = "itunes" as const;

  /**
   * iTunes is a stream/metadata fallback, not a search backend — return [].
   * (YouTube supplies all search results; see the resolver's searchTracks().)
   */
  async search(_q: string, _opts?: SearchOpts): Promise<Track[]> {
    return [];
  }

  /**
   * Resolves a playable preview for a track. Because a bare id carries no
   * title/artist to query iTunes with, this always delegates to a full Track.
   *
   * WHY the indirection: the resolver holds rich track metadata from YouTube,
   * so it can call resolvePreviewFor(track) directly and get a reliable match.
   */
  async getStream(_id: string): Promise<StreamResult> {
    // A bare id gives us nothing to search on; the only sane path is via a
    // concrete Track. Keep a friendly typed error for direct misuse.
    const err: ServiceError = {
      ok: false,
      code: "NO_PREVIEW",
      message: "iTunes requires full track metadata to resolve a preview",
      source: "itunes",
    };
    throw err;
  }

  /**
   * Looks up a 30s iTunes preview for the given track and returns a proxied
   * stream URL. Throws NO_PREVIEW when nothing matches.
   *
   * WHY: previewUrl supports Range (206 verified), so it is the chosen playable
   * source. We route it through /api/proxy (same-origin) so the browser can
   * fetch it without CORS issues.
   */
  async resolvePreviewFor(track: Track): Promise<StreamResult> {
    const term = encodeURIComponent(`${track.title} ${track.artist}`);
    const url = `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=1`;
    // Throttled + cached + 429-aware: the shared iTunes fan-out guard (see throttle.ts).
    const data = await itunesFetchJson<ItunesSearchResponse>(url);

    const first = data.results?.[0];
    if (!first?.previewUrl) {
      const err: ServiceError = {
        ok: false,
        code: "NO_PREVIEW",
        message: "No iTunes preview found",
        source: "itunes",
      };
      throw err;
    }

    return {
      url: buildProxyUrl(first.previewUrl, "audio/x-m4a"),
      format: "audio/x-m4a",
      expiresSec: 3600,
    };
  }

  /** Related-tracks radio is Phase 4; return empty for now. */
  async getRelated(_id: string): Promise<Track[]> {
    return [];
  }

  /**
   * Cheap health probe of the iTunes Search API, cached ~60s.
   *
   * WHY: isAvailable() gates whether the resolver even bothers attempting the
   * iTunes fallback. A 1-result search is a minimal, cheap liveness check.
   */
  async isAvailable(): Promise<boolean> {
    const cached = healthCache.get("itunes");
    if (cached !== undefined) return cached;

    const probe = async (): Promise<boolean> => {
      try {
        await fetchJson(
          "https://itunes.apple.com/search?term=test&media=music&entity=song&limit=1",
        );
        return true;
      } catch {
        return false;
      }
    };

    const result = await probe();
    healthCache.set("itunes", result);
    return result;
  }
}

/**
 * Returns a NEW Track with iTunes-upgraded 600x600 artwork and matched:true.
 *
 * WHY: search results come from YouTube with small/large thumbnails; the client
 * wants hi-res cover art. We re-run the iTunes lookup (best-effort) and, on any
 * failure, safely return the input unchanged — enrichment must never break the
 * already-valid YouTube metadata.
 *
 * The returned track keeps its original id/source ('youtube'); only artwork and
 * the matched flag change.
 */
export async function enrichFromItunes(track: Track): Promise<Track> {
  try {
    const term = encodeURIComponent(`${track.title} ${track.artist}`);
    const url = `https://itunes.apple.com/search?term=${term}&media=music&entity=song&limit=1`;
    // Throttled + cached + 429-aware: the shared iTunes fan-out guard (see throttle.ts).
    const data = await itunesFetchJson<ItunesSearchResponse>(url);

    const first = data.results?.[0];
    if (!first?.artworkUrl100) return track;

    const upgraded = first.artworkUrl100.replace(ART_SMALL, "600x600bb");
    return {
      ...track,
      artwork: upgraded.length > 0 ? upgraded : track.artwork,
      matched: true,
    };
  } catch {
    // Best-effort enrichment: preserve the original track on any failure.
    return track;
  }
}
