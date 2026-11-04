/**
 * Shared type contracts for the Sonic app.
 *
 * These are the single source of truth shared by BOTH server (API routes,
 * music sources) and client (player, search UI). Keep the JSON shapes here
 * stable — any change must be reflected in the server routes and the client
 * code together.
 *
 * WHY these live in one file: the server sources, the API route handlers,
 * and the client all need the exact same Track / API-response shapes. A
 * single canonical file prevents drift between the three layers.
 */

/** Source-native identifiers use a stable scheme so tracks survive reloads. */
export type TrackId = `yt:${string}` | `saavn:${string}`;

/** Which backend produced this track. 'youtube' is primary, 'saavn' fallback. */
export type SourceId = "youtube" | "saavn";

/**
 * Normalized track model used everywhere (client & server).
 * `streamUrl` is ephemeral (never persisted) — it carries the proxied URL
 * only for the currently-playing/looked-up track.
 */
export interface Track {
  id: TrackId;
  source: SourceId;
  videoId: string;
  title: string;
  artist: string;
  album?: string;
  duration: number; // seconds
  artwork: string; // best-size URL; client may swap for a larger size
  /** Set ONLY transiently; never persisted. Contains the /api/proxy URL. */
  streamUrl?: string;
  /** true when playback uses a ~30s preview (iTunes) rather than the full song.
   *  Transient, like streamUrl — CRUCIALLY OPTIONAL so a persisted snapshot
   *  (which already strips streamUrl via db.ts toPersisted) that accidentally
   *  retained it would still be a valid Track. Never written by the reducers'
   *  persisted slice (queue/repeat/shuffle only). */
  isPreview?: boolean;
  /** true when metadata was enriched/looked-up via iTunes/Deezer. */
  matched?: boolean;
}

/** Options passed to a source's search method. */
export interface SearchOpts {
  /** Rough category filter. Sources may ignore it. */
  filter?: "songs" | "albums" | "artists";
  limit?: number;
}

/** Result of resolving a playable stream for a track. */
export interface StreamResult {
  url: string; // → /api/proxy?... form (the caller re-writes host/path)
  format: string; // e.g. 'audio/webm', 'audio/mp4'
  expiresSec: number; // how long the underlying googlevideo URL stays valid
}

/* -------------------------------------------------------------------------- */
/* API route contracts (JSON returned to the client)                           */
/* -------------------------------------------------------------------------- */

/** Typed error envelope returned by every API route. */
export interface ApiError {
  ok: false;
  code: string;
  message: string;
  source?: SourceId;
}

/** GET /api/search -> either an error or a normalized list. */
export type SearchResponse = { ok: true; results: Track[] } | ApiError;

/** GET /api/stream?videoId= -> proxy URL + format for the player. */
export type StreamResponse = { ok: true; track: Track } | ApiError;

/* -------------------------------------------------------------------------- */
/* Player / queue state                                                        */
/* -------------------------------------------------------------------------- */

/** Single-item play modes. */
export type RepeatMode = "off" | "all" | "one";

/** Immutable-ish snapshot of the player reducer state (persisted to storage). */
export interface QueueState {
  queue: Track[];
  currentIndex: number; // -1 when nothing loaded
  repeat: RepeatMode;
  shuffle: boolean;
}
