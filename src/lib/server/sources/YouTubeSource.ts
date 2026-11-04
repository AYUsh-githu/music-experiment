/**
 * YouTube music source (primary search/metadata backend).
 *
 * STREAMING STATUS (verified Wave 4, youtubei.js 18.3.0): search and metadata
 * work on the WEB session. Streaming works by overriding the client PER-REQUEST
 * with the mobile streaming client (STREAM_CLIENT from innertube.ts) via
 * `getBasicInfo(id, { client })` — that client returns non-empty, deciphered
 * audio URLs (verified GET Range -> HTTP 206) where the plain WEB client returns
 * URL-less formats (PO-Token wall). getStream still guards: if getInfo yields
 * zero usable audio (byte-for-byte no URL), it throws a typed STREAM_UNAVAILABLE
 * so the resolver transparently fails over to iTunes previews.
 */
import { getInnertube, STREAM_CLIENT, tryGetStreamingFormats } from "@/lib/server/innertube";
import { healthCache } from "@/lib/server/cache";
import { buildProxyUrl, mimeOf } from "@/lib/server/http";
import type { Track, SearchOpts, StreamResult } from "@/lib/types";
import type { MusicSource, ServiceError } from "@/lib/server/sources/types";

/** Max related/radio videos we normalize per request (route clamps on top). */
const RELATED_LIMIT = 40;

/** Type guard / narrow helper for the youtubei.js video search results. */
interface YtVideo {
  id?: string;
  title?: { text?: string };
  author?: { name?: string };
  duration?: { seconds?: number };
  thumbnails?: { url?: string }[];
}

/**
 * Shape of a watch-next feed node (CompactVideo in youtubei.js 18.3.0).
 * Surfaced so getRelated can normalize it into the shared YtVideo shape.
 */
interface RelatedNode {
  video_id?: string;
  id?: string;
  title?: { text?: string };
  author?: { name?: string };
  duration?: { seconds?: number };
  thumbnails?: { url?: string }[];
}

/**
 * Maps raw youtubei.js video-shaped rows into normalized Tracks.
 *
 * WHY it's shared: search (query results) and getRelated (radio autoplay) both
 * reduce the same Innertube video shape into Tracks. Keeping one mapper here
 * guarantees every track — search, stream, radio — has the identical contract
 * (plan §3.6). Rows we can't key or display (no id → no stream resolution; no
 * title → unusable in the queue UI) are skipped defensively; never throws.
 */
function toTracks(videos: unknown[], limit: number): Track[] {
  const tracks: Track[] = [];
  for (const raw of videos) {
    if (tracks.length >= limit) break;
    const v = raw as YtVideo;
    const id = v.id;
    const title = v.title?.text;
    if (!id || !title) continue;

    const artwork =
      v.thumbnails && v.thumbnails.length > 0
        ? (v.thumbnails[v.thumbnails.length - 1].url ?? "")
        : "";

    tracks.push({
      id: `yt:${id}`,
      source: "youtube",
      videoId: id,
      title,
      artist: v.author?.name ?? "Unknown",
      duration: v.duration?.seconds ?? 0,
      artwork,
      matched: false,
    });
  }
  return tracks;
}

/** Preferred audio format selector passed to youtubei.js chooseFormat. */
type StreamQualityOpts = { quality?: "best" | "low" };

export class YouTubeSource implements MusicSource {
  readonly id = "youtube" as const;

  /**
   * Searches YouTube and normalizes the top video hits into Tracks.
   *
   * WHY: search results carry no playable stream yet — streams must be resolved
   * lazily at play time because YouTube URLs expire (~6h). So search only builds
   * metadata + metadata-based ids (`yt:${videoId}`).
   * Never throws for bad input: rows without an id/title are skipped defensively.
   *
   * The Innertube init + search are wrapped in a 10s timeout (mirroring getStream/
   * getRelated) so a hung network/DNS can't stall /api/search or every /api/trending
   * seed indefinitely (final audit finding) — it fails over or 502s promptly.
   */
  async search(q: string, opts?: SearchOpts): Promise<Track[]> {
    const yt = await withTimeout(getInnertube(), 10_000, "YouTube init timed out");
    const limit = opts?.limit ?? 20;

    const search = await withTimeout(yt.search(q), 10_000, "YouTube search timed out");
    const videos = (search.videos ?? []) as unknown[];
    return toTracks(videos, limit);
  }

  /**
   * Resolves a playable stream URL for a track's source-native id.
   *
   * WHY the client MATRIX (fallback): the default WEB client returns URL-less
   * formats (PO-Token wall), so getStream walks the CLIENT MATRIX from innertube
   * (IOS → ANDROID_VR → MWEB → TV → WEB) via tryGetStreamingFormats until one
   * inner client hands back a non-empty, deciphered https audio URL. No single
   * client is guaranteed for every video, so trying the matrix in order with
   * graceful per-client failure maximizes the odds of a playable stream. If NO
   * client yields a usable URL, we throw a typed STREAM_UNAVAILABLE so the
   * resolver transparently fails over to iTunes — never a URL-less success.
   *
   * A 10s timeout wraps the whole matrix walk (plan §3.1) so a hung Innertube /
   * getInfo chain can't stall playback — the resolver fails over promptly.
   *
   * `opts.quality` (plan §4.3) lets the resolver request the leanest available
   * audio format ('low') for constrained connections; absent it, we keep the
   * best audio quality. When 'low' is requested but no low-bitrate audio exists
   * on the video, chooseFormat throws — we degrade to 'best' rather than fail.
   */
  async getStream(id: string, opts?: StreamQualityOpts): Promise<StreamResult> {
    try {
      // Walk the client matrix — getInnertube() + per-client getBasicInfo are
      // both inside the shared 10s budget so the whole fallback chain can't
      // exceed it. Returns null only if every client failed/unusable.
      const hit = await withTimeout(
        tryGetStreamingFormats(id),
        10_000,
        "YouTube getInfo timed out"
      );
      if (!hit) {
        const err: ServiceError = {
          ok: false,
          code: "STREAM_UNAVAILABLE",
          message: "YouTube stream blocked (PO-Token) — trying another source",
          source: "youtube",
        };
        throw err;
      }
      const info = hit.info;

      const quality = opts?.quality ?? "best";
      // youtubei.js's chooseFormat either returns a matching Format or throws a
      // NoStreamingDataError; we cast defensively because we only read .url.
      let chosen: { url?: string } | undefined;
      if (quality === "low") {
        try {
          chosen = info.chooseFormat({ quality: "low", type: "audio" }) as unknown as { url?: string };
        } catch {
          // No low-bitrate audio on this video — degrade to best instead of
          // losing playback entirely (plan §4.3).
          chosen = info.chooseFormat({ quality: "best", type: "audio" }) as unknown as { url?: string };
        }
      } else {
        chosen = info.chooseFormat({ quality: "best", type: "audio" }) as unknown as { url?: string };
      }

      if (!chosen || !chosen.url) {
        const err: ServiceError = {
          ok: false,
          code: "STREAM_UNAVAILABLE",
          message: "YouTube stream blocked (PO-Token) — trying another source",
          source: "youtube",
        };
        throw err;
      }

      const mime = mimeOf(chosen);
      return { url: buildProxyUrl(chosen.url, mime), format: mime, expiresSec: 6 * 3600 };
    } catch (e) {
      // Normalize any timeout/network error into a typed failover trigger, but
      // pass through the already-typed STREAM_UNAVAILABLE unchanged.
      if ((e as ServiceError)?.code === "STREAM_UNAVAILABLE") throw e;
      const err: ServiceError = {
        ok: false,
        code: "STREAM_UNAVAILABLE",
        message: (e as Error).message ?? "YouTube stream unavailable",
        source: "youtube",
      };
      throw err;
    }
  }

  /**
   * Best-effort metadata lookup for a video id (Bug #6).
   *
   * WHY: /api/stream can be called with ONLY a videoId (no title/artist), which
   * left the iTunes/Saavn fallbacks nothing to search with → NO_SOURCE. This
   * resolves that metadata server-side from getInfo so the route can populate a
   * real track. It is deliberately best-effort: any failure (PO-Token, network,
   * extraction) returns empty values instead of throwing, so the route falls
   * through to its existing failover rather than 5xxing.
   *
   * youtubei.js exposes `basic_info.title` / `basic_info.author` /
   * `basic_info.duration` (verified in 18.3.0's MediaInfo.d.ts) — the same
   * author string that search's `v.author?.name` reads.
   */
  async getTrackInfo(videoId: string): Promise<{
    title: string;
    artist: string;
    duration: number;
  }> {
    try {
      const yt = await withTimeout(getInnertube(), 10_000, "YouTube init timed out");
      // Use the streaming client like getStream so a videoId-only lookup resolves
      // against the same client that will serve the stream; basic_info (title /
      // author / duration) is present on getBasicInfo regardless of client.
      const info = await withTimeout(
        yt.getBasicInfo(videoId, { client: STREAM_CLIENT }),
        10_000,
        "YouTube getInfo timed out"
      );
      const basic = info.basic_info ?? {};
      return {
        title: basic.title ?? "",
        artist: basic.author ?? "",
        duration: typeof basic.duration === "number" ? basic.duration : 0,
      };
    } catch {
      // Never let metadata resolution break the stream request — empty values
      // keep the route's normal failover path intact.
      return { title: "", artist: "", duration: 0 };
    }
  }

  /**
   * Returns similar tracks for radio autoplay (plan §3.6 / §4.1).
   *
   * WHY best-effort: getInfo is PO-Token affected and can throw for many reasons
   * (network, extraction, permission), and related tracks are an enhancement,
   * not a hard dependency. We return [] on ANY failure so the /api/related route
   * never 5xxes for a missing radio list; the resolver has a search-based
   * fallback upstream.
   *
   * NOTE (verified against youtubei.js 18.3.0): VideoInfo exposes the related
   * back-half through `watch_next_feed` (CompactVideo nodes) — there is no
   * `getRelated()` method. We read that feed and normalize each node into the
   * same YtVideo shape search produces, so toTracks maps both uniformly.
   */
  async getRelated(id: string): Promise<Track[]> {
    try {
      const yt = await withTimeout(getInnertube(), 10_000, "YouTube init timed out");
      const info = await withTimeout(yt.getInfo(id), 10_000, "YouTube getInfo timed out");
      const nodes = (info.watch_next_feed ?? []) as unknown as RelatedNode[];
      const shaped: YtVideo[] = [];
      for (const n of nodes) {
        // CompactVideo keys its id as `video_id` (the deprecated `id` getter
        // just forwards it); other node types may surface plain `id`. Accept
        // either, then drop anything we still can't key.
        const vidId = typeof n.video_id === "string" ? n.video_id : typeof n.id === "string" ? n.id : undefined;
        if (!vidId) continue;
        shaped.push({
          id: vidId,
          title: n.title,
          author: n.author,
          duration: n.duration,
          thumbnails: n.thumbnails,
        });
      }
      return toTracks(shaped, RELATED_LIMIT);
    } catch {
      // Never leak a PO-token / extraction failure into the radio pipeline.
      return [];
    }
  }

  /**
   * Cheap health probe via a tiny search, cached ~60s.
   *
   * WHY: isAvailable() decides failover ordering without paying a full request
   * on every call. The result is cached in healthCache so repeated lookups in a
   * short window reuse the same answer.
   */
  async isAvailable(): Promise<boolean> {
    const cached = healthCache.get("youtube");
    if (cached !== undefined) return cached;

    const probe = async (): Promise<boolean> => {
      try {
        const yt = await getInnertube();
        await yt.search("aa");
        return true;
      } catch {
        return false;
      }
    };

    return probeAndCache("youtube", probe);
  }
}

/**
 * Runs a health probe and stores its result in healthCache for 60s.
 *
 * WHY: keeping the probe-and-cache logic here (rather than inside each source)
 * guarantees every source caches identically — read once, reuse for a minute.
 */
async function probeAndCache(key: string, probe: () => Promise<boolean>): Promise<boolean> {
  const result = await probe();
  healthCache.set(key, result);
  return result;
}

/**
 * Races a promise against a timeout, rejecting with a clear Error on exceed.
 *
 * WHY: youtubei.js network calls don't always accept an AbortSignal, so we race
 * them against an AbortSignal.timeout to enforce the plan's 10s cap without
 * depending on the library to honour cancellation.
 */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer)) as Promise<T>;
}
