/**
 * Shared Innertube client singleton (youtubei.js).
 *
 * WHY a singleton: `Innertube.create()` is moderately expensive (it resolves
 * the YouTube player/config endpoints once). Creating it on every request
 * would add latency and load. We create it lazily on first use and reuse it
 * across requests in the dev/prod server process.
 *
 * CLIENT STRATEGY (verified Wave 4 / refactor, youtubei.js 18.3.0):
 *   - The SESSION stays on the WEB client because search, trending, related and
 *     health probes only parse correctly under WEB (the ANDROID_VR / IOS mobile
 *     search responses carry a SearchMobileHeader the library can't cast).
 *   - Streaming URL extraction OVERRIDES the client PER-REQUEST via a CLIENT
 *     MATRIX: `getBasicInfo(id, { client })` is called once per inner client in
 *     order until one returns a usable (non-empty, deciphered, https) audio URL.
 *     The plain WEB client returns formats with EMPTY `url` (PO-Token wall);
 *     the mobile-inner clients (IOS / ANDROID_VR) return non-empty, streamable
 *     audio URLs (verified: GET Range -> HTTP 206).
 *
 * SERVER-ONLY — never import this module from a client component.
 */
import { Innertube, ClientType } from "youtubei.js";
import type { Innertube as InnertubeType } from "youtubei.js";

/**
 * InnerTube client used for the session-wide WEB browsing (search, related,
 * health). Kept on WEB: switching the whole session to a mobile client breaks
 * search parsing.
 */
const SESSION_CLIENT = ClientType.WEB;

/**
 * Ordered CLIENT MATRIX used for STREAMING lookups (getBasicInfo with
 * `{ client }`). We try each inner client in order until one hands back a
 * usable audio URL, falling through to the next on failure.
 *
 * ORDER & WHY (verified against youtubei.js 18.3.0's CLIENTS map):
 *   'IOS'        → NAME 'iOS'; preferred first per the streaming-fallback brief.
 *   'ANDROID_VR' → NAME 'ANDROID_VR'; the client PROVEN to return working URLs
 *                  in this app today (more audio formats: mp4 139/140 + opus/webm
 *                  249/251). Kept second as the known-good defensive pick.
 *   'MWEB', 'TV', 'WEB' follow as further fallbacks.
 *
 * IMPORTANT: these strings are the CLIENTS KEYS accepted by `getBasicInfo`'s
 * `client` option, not the client NAMEs. The `'TV'` key resolves to the
 * TVHTML5 client (NAME 'TVHTML5'); `'IOS'` resolves to NAME 'iOS'. Passing
 * `'TVHTML5'` literally would fail youtubei.js's `SUPPORTED_CLIENTS` check and
 * throw ("Invalid client") — never use the NAME here.
 */
export type StreamClient = "IOS" | "ANDROID_VR" | "MWEB" | "TV" | "WEB";
export const streamClients: readonly StreamClient[] = [
  "IOS",
  "ANDROID_VR",
  "MWEB",
  "TV",
  "WEB",
];

/**
 * Default / proven-good streaming client (ANDROID_VR). Kept exported so callers
 * that just want "the client that works" (e.g. getTrackInfo metadata lookups)
 * don't have to iterate the whole matrix.
 */
export const STREAM_CLIENT = "ANDROID_VR";

/**
 * Optional YouTube cookies / visitor data read from the environment. If present
 * they are passed to Innertube.create (visitor_data in particular improves how
 * reliably YouTube returns usable formats). The app runs WITHOUT these — they are
 * a strictly-optional enhancement, never required.
 */
const YTM_COOKIE = process.env.YTM_COOKIE ?? undefined;
const YTM_VISITOR_DATA = process.env.YTM_VISITOR_DATA ?? undefined;

let cached: Promise<InnertubeType> | null = null;

/**
 * Returns the shared Innertube instance, creating it on first call.
 *
 * SINGLETON GUARANTEE: the `Innertube.create(...)` promise itself is memoized in
 * `cached`, so every caller reuses the same in-flight/resolved session rather
 * than paying the (expensive) player/config round-trips each time. On failure
 * the `.catch` clears `cached` so a transient startup error does NOT poison the
 * process forever — the next call retries creation fresh.
 */
export function getInnertube(): Promise<InnertubeType> {
  if (!cached) {
    cached = Innertube.create({
      // Keep the session on WEB so search/related/health parse correctly.
      client_type: SESSION_CLIENT,
      // Optional PO-Token helpers; both are strictly optional — without them the
      // app still works (search on WEB, streaming via the per-request mobile
      // client override). visitor_data improves format reliability.
      ...(YTM_COOKIE ? { cookie: YTM_COOKIE } : {}),
      ...(YTM_VISITOR_DATA ? { visitor_data: YTM_VISITOR_DATA } : {}),
    }).catch((err: unknown) => {
      // Reset the cache so a broken startup can be retried on the next request
      // instead of being cached-forever-failed.
      cached = null;
      throw err;
    });
  }
  return cached;
}

/**
 * Minimal structural shape we read off a returned VideoInfo when deciding
 * whether a client produced a usable stream, and when selecting a final audio
 * format. We deliberately avoid importing youtubei.js's `VideoInfo` type (it is
 * nested under `YT.*` and not a stable named export) — we only ever inspect
 * `streaming_data` format URLs and call `chooseFormat`, which the existing
 * getStream code already consumes loosely.
 */
export interface StreamingInfo {
  streaming_data?: {
    formats?: Array<{ has_audio?: boolean; url?: string }>;
    adaptive_formats?: Array<{ has_audio?: boolean; url?: string }>;
  };
  /**
   * Format selector (youtubei.js `chooseFormat`). Typed to the subset of
   * FormatOptions getStream uses; the returned shape matches how getStream
   * reads `.url` and `mimeOf` reads `.mime_type`.
   */
  chooseFormat(options: {
    quality?: string;
    type?: "video" | "audio" | "video+audio";
  }): { url?: string; mime_type?: string };
}

/**
 * True when at least one audio format carries a non-empty, already-decoded
 * HTTPS URL. This is THE test that distinguishes a working client from the
 * PO-Token wall: the WEB client returns formats whose `url` is an empty string,
 * while the mobile-inner clients return deciphered, streamable URLs.
 */
function hasUsableAudioUrl(info: StreamingInfo): boolean {
  const all = info.streaming_data
    ? [
        ...(info.streaming_data.formats ?? []),
        ...(info.streaming_data.adaptive_formats ?? []),
      ]
    : [];
  return all.some(
    (f) =>
      f.has_audio &&
      typeof f.url === "string" &&
      f.url.startsWith("https://")
  );
}

/**
 * Iterates the CLIENT MATRIX in order, calling `getBasicInfo(videoId, { client })`
 * per client, and returns the first client whose response includes a usable
 * non-empty, deciphered, https audio URL.
 *
 * WHY: no single inner client is guaranteed to hand back a streamable URL (WEB
 * is PO-Token-walled; a given video may be playable only under one mobile client).
 * Trying the matrix in order with graceful per-client failure makes streaming as
 * resilient as the fallback brief requires while keeping the known-good
 * ANDROID_VR as the second pick.
 *
 * Throws only if the shared session itself cannot be created; a per-client
 * rejection is swallowed and we just move to the next candidate.
 */
export async function tryGetStreamingFormats(
  videoId: string
): Promise<{ info: StreamingInfo; client: StreamClient } | null> {
  const yt = await getInnertube();
  for (const client of streamClients) {
    try {
      const info = await yt.getBasicInfo(videoId, { client });
      if (hasUsableAudioUrl(info)) {
        // got the winning client — hand back its info + which client served it.
        return { info, client };
      }
    } catch {
      // This client threw (network, extraction, PO-Token, parse) or yielded no
      // usable URL — move on to the next candidate in the matrix.
    }
  }
  return null;
}

/** Type re-export so route handlers don't import the heavy lib directly. */
export type { InnertubeType };
