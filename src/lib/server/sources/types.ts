/**
 * Music source abstraction (plan §5.3) — the single most important structural
 * rule of the project. Every stream/search/related call goes through this
 * interface so backends are swappable and failover is automatic.
 *
 * WHY it exists: YouTube (`youtubei.js`) is the primary source but breaks
 * periodically (PO-token / 403 issues). JioSaavn is the fallback. Enforcing a
 * common interface means the resolver can try primary → fallback → typed error
 * without any route handler knowing which backend answered.
 */
import type { Track, SearchOpts, StreamResult } from "@/lib/types";

/**
 * A pluggable music backend. Each concrete source implements all methods.
 */
export interface MusicSource {
  /** Stable identifier. 'youtube' (primary search), 'saavn' (plan fallback),
   *  'itunes' (preview-stream fallback source, used when YouTube streaming is
   *  blocked — see progress.md). 'ytdlp' is the keyless yt-dlp extraction engine
   *  (see YtDlpSource), which is the rebuild's new primary for audio streams. */
  id: "youtube" | "saavn" | "itunes" | "ytdlp";
  /** Returns normalized tracks for a search query. Never throws for bad input. */
  search(q: string, opts?: SearchOpts): Promise<Track[]>;
  /** Resolves a playable stream URL for a track's source-native id. */
  getStream(id: string): Promise<StreamResult>;
  /** Tracks similar to the given one, for radio autoplay (Phase 4). */
  getRelated(id: string): Promise<Track[]>;
  /**
   * Cheap health probe, cached ~60s by the caller. Used to decide failover
   * without paying a full request cost on every call.
   */
  isAvailable(): Promise<boolean>;
}

/** Structured error thrown by sources / proxies. */
export interface ServiceError {
  ok: false;
  code: string;
  message: string;
  source?: "youtube" | "saavn" | "itunes" | "ytdlp";
}
