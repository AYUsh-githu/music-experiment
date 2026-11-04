/**
 * GET /api/stream — Resolve a playable stream URL for a track (Plan §3.1 / §3.2).
 *
 * WHY: browsers cannot load googlevideo.com or audio-ssl.itunes.apple.com
 * directly (no CORS, Range restrictions), so this route asks the resolver for a
 * playable stream and hands back a SAME-ORIGIN /api/proxy URL. The client's
 * <audio> element then plays through our proxy. The resolver already rewrites
 * the source URL into `/api/proxy?...` form (via buildProxyUrl), so we just
 * attach it to the track as `streamUrl`.
 *
 * The track reconstructed here is deliberately minimal (no artwork): the client
 * that calls /api/stream already has the full Track from search and merely needs
 * a stream URL; richer metadata is not required for playback. Title/artist/
 * duration are populated from the query params, or resolved server-side from
 * YouTube when only a videoId is supplied (Bug #6) so the fallbacks can search.
 * Its `source` stays 'youtube' (the search origin) — only `streamUrl` is added.
 */
import { NextRequest, NextResponse } from "next/server";
import { resolveStream, sources } from "@/lib/server/sources/resolver";
import { cleanArtist, cleanTitle } from "@/lib/server/text";
import type { ServiceError } from "@/lib/server/sources/types";
import type { ApiError, SourceId, StreamResponse, Track, TrackId } from "@/lib/types";
/**
 * Handles `GET /api/stream?videoId=<id>&title=<t>&artist=<a>&quality=<best|low>`.
 *
 * - Builds a minimal Track from the query params (fields may be empty).
 * - `quality` is optional; defaults to "best". It threads through the resolver
 *   into YouTube's format selection (plan §4.3) so constrained connections can
 *   request the leanest audio format.
 * - Delegates to the resolver, which fails over yt-dlp → YouTube → Saavn
 *   → iTunes preview.
 * - Success → 200 { ok, track: { ...track, streamUrl } }.
 * - Failure → 503 typed ApiError (code/message/source from the ServiceError).
 */
export async function GET(request: NextRequest): Promise<NextResponse<StreamResponse>> {
  const sp = request.nextUrl.searchParams;
  const videoId = sp.get("videoId") ?? "";
  let title = sp.get("title") ?? "";
  let artist = sp.get("artist") ?? "";
  let duration = 0; // unknown at stream time; search already carries the real value
  // Coerce an invalid/garbage value back to "best" rather than fail the request.
  const q = sp.get("quality");
  const quality: "best" | "low" = q === "low" ? "low" : "best";

  // Bug #6: when title/artist are missing (client often calls /api/stream with
  // only a videoId), the iTunes/Saavn fallbacks had nothing to search with and
  // every request died with NO_SOURCE. Resolve metadata server-side from
  // YouTube, best-effort — on failure we keep the empty fields and the request
  // still fails over to Saavn (now that it searches by title) rather than
  // throwing. Cleaned values help downstream search match.
  if (videoId && (!title || !artist)) {
    const info = await sources.youtube.getTrackInfo(videoId);
    if (!title) title = cleanTitle(info.title);
    if (!artist) artist = cleanArtist(info.artist);
    if (duration === 0 && info.duration > 0) duration = info.duration;
  }

  const track: Track = {
    id: `yt:${videoId}` as TrackId,
    source: "youtube",
    videoId,
    title,
    artist,
    duration, // real value when resolved from YouTube above, else 0
    artwork: "",
  };

  try {
    const resolved = await resolveStream(track, { quality });
    // result.url is already a same-origin /api/proxy?... URL (resolveStream /
    // buildProxyUrl). Attach it transiently — never persisted per the Track
    // contract (streamUrl is ephemeral). isPreview is true ONLY for the iTunes
    // 30s preview; yt-dlp / YouTube / Saavn are full-track playback.
    const playable: Track = { ...track, streamUrl: resolved.url, isPreview: resolved.source === "itunes" };
    return NextResponse.json({ ok: true, track: playable } satisfies StreamResponse);
  } catch (err) {
    // resolveStream only throws ServiceError-shaped errors; narrow defensively so
    // a non-conforming throw still yields a typed 503 rather than a 500.
    const e = err as Partial<ServiceError>;
    // Never interpolate the (attacker-controlled) title/artist verbatim into the
    // log line — a crafted value could spoof/carriage-return-inject the log.
    // Log the opaque videoId (clamped to a short length) and a sanitized message.
    const safeTitle = title.replace(/[\r\n\u0000-\u001f\u007f]+/g, "").slice(0, 80);
    console.warn(`[api/stream] failed for "${safeTitle}"`, err);
    // ApiError.source is limited to SourceId ('youtube' | 'saavn'), but a
    // ServiceError may name 'itunes' as the failing source. Narrow defensively so
    // an iTunes-reported failure still type-checks while staying null when unknown.
    const source: SourceId | undefined =
      e?.source === "youtube" || e?.source === "saavn" ? e.source : undefined;
    const apiErr: ApiError = {
      ok: false,
      code: e?.code ?? "NO_SOURCE",
      message: e?.message ?? "Track unavailable — trying another source…",
      source,
    };
    return NextResponse.json(apiErr, { status: 503 });
  }
}
