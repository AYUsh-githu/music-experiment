/**
 * yt-dlp-based extraction engine — an independent audio source.
 *
 * WHY it exists: the app's primary stream path (YouTube via youtubei.js) is
 * PO-Token blocked in this environment, and the Saavn fallback host is down.
 * yt-dlp is a keyless standalone binary (`bin/yt-dlp.exe`) that can both search
 * YouTube and, crucially, produce a real googlevideo.com audio URL (verified —
 * `--simulate -g` returns a live streaming URL the proxy can Range-serve).
 * This module wraps that binary as a first-class source so the app has a
 * third, demonstrably-working audio backend.
 *
 * SECURITY MODEL (the invariants that matter most):
 *   - yt-dlp NEVER receives free-form user text as a URL. We only ever build
 *     `https://www.youtube.com/watch?v={videoId}` where videoId is validated
 *     against a strict YouTube-id charset. The search QUERY is passed as a
 *     single argv element via execFile (no shell), and prefixed with `ytsearch1:` so
 *     it can only ever be interpreted as a search term, never as option text.
 *   - The extracted streaming URL is validated to be `https://` before it is
 *     trusted; anything else is dropped as a failure.
 *   - The browser never sees a googlevideo URL. getStream/resolveStreamFor
 *     route through buildProxyUrl → `/api/proxy` (same-origin, SSRF-safe,
 *     Range→206). The raw URL is transient and never persisted.
 *
 * NOTE on type unions: this source is intentionally NOT a `MusicSource` from
 * sources/types.ts, because that interface's `source`/`id` unions only accept
 * 'youtube' | 'saavn' | 'itunes'. Adding 'ytdlp' would require editing shared
 * files owned by other teammates. Instead this exposes the same SHAPE
 * (search/getStream/resolveStreamFor/health) with its own result types where
 * `source: 'ytdlp'`.
 */

import { runYtDlp } from "@/lib/server/spawn";
import { TTLCache } from "@/lib/server/cache";
import { buildProxyUrl } from "@/lib/server/http";
import { cleanTitle, cleanArtist } from "@/lib/server/text";
import type { Track } from "@/lib/types";

/** Concurrency cap for yt-dlp spawns. yt-dlp is heavy (Python runtime); running
 *  more than two at once is wasteful and risks being rate-limited by YouTube. */
const CONCURRENCY = 2;

/** Extraction wall-clock cap; `-g` and search are quick when the network is up. */
const SPAWN_TIMEOUT_MS = 60_000;
/** Search runs are light; a shorter cap fails over faster on a bad network. */
const SEARCH_TIMEOUT_MS = 30_000;

/** How long a resolved raw googlevideo URL is cached before re-spawning. */
const URL_TTL_MS = 20 * 60 * 1000;

/** youtube URL the app constructs; watch?v={videoId}. */
const YT_WATCH_PREFIX = "https://www.youtube.com/watch?v=";

/** MIME chosen for yt-dlp's bestaudio (usually Opus in a webm container). */
const MIME_WEBM = "audio/webm";
/** MIME when the URL's itag is an AAC/m4a format (itag 140/141). */
const MIME_MP4 = "audio/mp4";

/** Approx validity of a googlevideo streaming URL (mirrors other sources). */
const EXPIRES_SEC = 6 * 3600;

/**
 * A minimal promise-semaphore. WHY: copying the pattern from throttle.ts (which
 * does not export its private Semaphore) lets us cap concurrent yt-dlp spawns
 * independently of the iTunes throttle.
 */
class Semaphore {
  private active = 0;
  private readonly queue: Array<() => void> = [];

  acquire(): Promise<void> {
    if (this.active < CONCURRENCY) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
    }).then(() => {
      this.active++;
    });
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** Module-level singleton shared by ALL yt-dlp calls across the process. */
const slot = new Semaphore();

/**
 * TTL cache mapping videoId → raw (unproxied) streaming URL.
 *
 * WHY: `getStream` pays a full yt-dlp spawn + YouTube round-trip per call.
 * Re-resolving the same video repeatedly (every failover pass) would re-spawn
 * yt-dlp each time. Keying on the videoId and caching for 20min (under the 6h
 * URL validity) lets repeated requests share one successful extraction.
 */
const urlCache = new TTLCache<string>(URL_TTL_MS, 512);

/**
 * A strict YouTube video-id validator. YouTube ids are alphanumeric plus `-`
 * and `_`, 6–24 chars. Requiring only this charset guarantees any id we
 * interpolate into a watch URL can never smuggle in URL metacharacters or
 * option tokens — the core of the "only youtube URLs we construct" rule.
 */
function isSafeVideoId(videoId: string): boolean {
  return /^[A-Za-z0-9_-]{6,32}$/.test(videoId);
}

/** Validates that an extracted streaming URL is https (never http/data/js). */
function isHttpsUrl(url: string): boolean {
  return /^https:\/\//i.test(url);
}

/** Builds a streaming URL string from a validated, https-extracted URL. */
function rawStreamUrl(videoId: string): string {
  return `${YT_WATCH_PREFIX}${videoId}`;
}

/** Result of a yt-dlp search (metadata only, no stream yet). */
export interface YtDlpSearchResult {
  videoId: string;
  title: string;
  artist: string;
  /** Duration in seconds, 0 when unknown. */
  duration: number;
}

/** A resolved stream from this engine. `url` empty ⇔ extraction FAILED. */
export interface YtDlpStreamResult {
  url: string;
  format: string;
  expiresSec: number;
  source: "ytdlp";
}

/** The meta-search + stream resolution result (the full resolveStreamFor shape). */
export interface YtDlpResolved {
  url: string;
  format: string;
  expiresSec: number;
  source: "ytdlp";
  videoId: string;
  title?: string;
  artist?: string;
  durationSeconds?: number;
}

/** Raw shape yt-dlp emits; only the fields we read are typed. */
interface YtDlpMeta {
  id?: string;
  title?: string;
  channel?: string;
  uploader?: string;
  duration?: number;
  entries?: YtDlpMeta[];
}

export class YtDlpSource {
  readonly source = "ytdlp" as const;

  /**
   * Runs one yt-dlp invocation under the concurrency semaphore.
   * WHY indirection: every spawn (search or extract) shares the same semaphore
   * + timeout handling, so concurrency stays at 2 across the whole engine.
   * Never throws for normal failures — returns the raw SpawnResult.
   */
  private async run(args: string[], timeoutMs: number) {
    await slot.acquire();
    try {
      return await runYtDlp({ args, timeoutMs });
    } finally {
      slot.release();
    }
  }

  /**
   * Best-effort search: resolves the top `ytsearch1` hit into video metadata.
   *
   * WHY `ytsearch1:` prefix + `--no-playlist` + `--dump-single-json`: this is
   * yt-dlp's canonical "give me the single best hit as JSON" idiom. We then
   * read the first playlist `entry` (ytsearch always wraps results in an
   * entries array, even with --dump-single-json). Any hard failure (network,
   * no hit, bot-wall) returns null so callers fail over — never throw.
   *
   * The search QUERY is user/music-controlled text, so it must be an argv
   * element (execFile, no shell) AND prefixed with `ytsearch1:` so it is only
   * ever interpreted as a search term — the injection-safe boundary lives in
   * spawn.ts and here.
   */
  async searchTrack(query: string): Promise<YtDlpSearchResult | null> {
    const safeQuery = String(query).trim();
    if (!safeQuery) return null;

    const spawn = await this.run(
      [
        `ytsearch1:${safeQuery}`,
        "--dump-single-json",
        "--no-playlist",
        "--skip-download",
        "--no-cache-dir",
        "--no-warnings",
        "--simulate",
      ],
      SEARCH_TIMEOUT_MS,
    );

    if (spawn.code !== 0 || spawn.timedOut || !spawn.stdout.trim()) return null;

    return this.parseSearchJson(spawn.stdout);
  }

  /** Parses `--dump-single-json` output into the first search hit, or null. */
  private parseSearchJson(stdout: string): YtDlpSearchResult | null {
    try {
      const root = JSON.parse(stdout) as YtDlpMeta;
      // ytsearch1 wraps the single hit in `entries`; a direct (non-search)
      // video would put fields at the top level. Handle both defensively.
      const entry = root.entries?.[0] ?? root;
      const videoId = entry.id;
      if (!videoId || !isSafeVideoId(videoId)) return null;

      return {
        videoId,
        title: entry.title ?? "",
        artist: entry.uploader ?? entry.channel ?? "Unknown",
        duration:
          typeof entry.duration === "number" && Number.isFinite(entry.duration)
            ? Math.max(0, Math.round(entry.duration))
            : 0,
      };
    } catch {
      // Malformed JSON (or an odd yt-dlp shape) → treat as "no usable hit".
      return null;
    }
  }

  /**
   * Resolves a playable (proxied) audio URL for a YouTube videoId.
   *
   * WHY `-f "bestaudio/best" -g --skip-download --simulate`: `-g` makes
   * yt-dlp print the direct streaming URL and exit, without downloading. This
   * returns a **raw googlevideo.com URL** which must NEVER reach the browser;
   * we immediately route it through buildProxyUrl → /api/proxy.
   *
   * EMPTY-URL = FAILURE: when yt-dlp extracted nothing (bot-wall, geo-block,
   * missing JS runtime), stdout is empty. We return a typed result with an
   * empty `url` and `source: 'ytdlp'` so the caller can distinguish "engine
   * answered but produced nothing" from "engine crashed", and fail over.
   */
  async getStream(videoId: string): Promise<YtDlpStreamResult> {
    // Reject anything that isn't a real youtube id BEFORE reaching yt-dlp.
    if (!isSafeVideoId(videoId)) {
      return { url: "", format: "", expiresSec: 0, source: "ytdlp" };
    }

    // Cache hit → reuse the previously extracted raw URL without a new spawn.
    const cached = urlCache.get(videoId);
    if (cached) return this.proxyResult(cached);

    const spawn = await this.run(
      [
        "-f",
        "bestaudio/best",
        "-g",
        rawStreamUrl(videoId),
        "--skip-download",
        "--no-playlist",
        "--no-cache-dir",
        "--no-warnings",
        "--simulate",
      ],
      SPAWN_TIMEOUT_MS,
    );

    if (spawn.timedOut || spawn.code !== 0) {
      return { url: "", format: "", expiresSec: 0, source: "ytdlp" };
    }

    // `-g` prints exactly one line: the streaming URL. Take the first non-empty
    // https line and discard everything else (stderr noise is already separated).
    const rawUrl = this.firstHttpsLine(spawn.stdout);
    if (!rawUrl) {
      return { url: "", format: "", expiresSec: 0, source: "ytdlp" };
    }

    // Persist the raw URL so a repeated getStream for this video skips the spawn.
    urlCache.set(videoId, rawUrl);
    return this.proxyResult(rawUrl);
  }

  /** Picks the first genuinely-https URL line from yt-dlp's stdout, or "". */
  private firstHttpsLine(stdout: string): string {
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed && isHttpsUrl(trimmed)) return trimmed;
    }
    return "";
  }

  /** Wraps a raw streaming URL into a proxied, mime-typed result. */
  private proxyResult(rawUrl: string): YtDlpStreamResult {
    // Best-effort mime by itag in the query: 140/141 are m4a AAC; anything else
    // (251/250 bestaudio default) is webm/opus.
    let format = MIME_WEBM;
    try {
      const itag = new URL(rawUrl).searchParams.get("itag");
      if (itag === "140" || itag === "141") format = MIME_MP4;
    } catch {
      // Unparseable URL — keep the default format.
    }
    return {
      url: buildProxyUrl(rawUrl, format),
      format,
      expiresSec: EXPIRES_SEC,
      source: "ytdlp",
    };
  }

  /**
   * Full resolve: clean the track, search yt-dlp, then extract the stream.
   *
   * WHY we re-use cleanTitle/cleanArtist (text.ts — imported, never edited):
   * the same cleaning that keeps Saavn/iTunes matching correct applies here,
   * so searching yt-dlp on "((official video))" clutter is avoided identically.
   *
   * Returns a resolved object; `url` empty ⇔ resolution failed (engine
   * produced nothing usable). Callers should treat an empty `url` as a typed
   * failure with `source: 'ytdlp'` and fail over.
   */
  async resolveStreamFor(track: Track): Promise<YtDlpResolved> {
    const title = cleanTitle(track.title || "");
    const artist = cleanArtist(track.artist || "");
    const query = `${title} ${artist}`.trim();
    if (!query) {
      return { url: "", format: "", expiresSec: 0, source: "ytdlp", videoId: "" };
    }

    const hit = await this.searchTrack(query);
    if (!hit) {
      return { url: "", format: "", expiresSec: 0, source: "ytdlp", videoId: "" };
    }

    const stream = await this.getStream(hit.videoId);
    return {
      url: stream.url,
      format: stream.format,
      expiresSec: stream.expiresSec,
      source: "ytdlp",
      videoId: hit.videoId,
      title: hit.title || undefined,
      artist: hit.artist || undefined,
      durationSeconds: hit.duration > 0 ? hit.duration : undefined,
    };
  }

  /**
   * Cheap liveness probe: a single 1-hit search, no stream extraction.
   * Mirrors the other sources' isAvailable pattern so the engine can be gated
   * behind a health check in a future failover wiring without new code.
   */
  async isAvailable(): Promise<boolean> {
    const hit = await this.searchTrack("aa");
    return hit !== null;
  }
}
