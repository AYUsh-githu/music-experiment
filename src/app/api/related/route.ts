/**
 * GET /api/related — Similar tracks for radio autoplay (plan §3.6 / §4.1).
 *
 * WHY this is a thin route: all the related-tracks orchestration (YouTube native
 * radio → search fallback → empty) lives in the resolver
 * (src/lib/server/sources/resolver.ts). This handler only parses the query,
 * enforces limits, and maps results to the canonical JSON contract — keeping the
 * HTTP layer dumb, mirroring /api/search's style.
 *
 * The response is deliberately un-enriched (no iTunes artwork upgrade): radio is
 * cheap autoplay, so we skip the fan-out that search pays for.
 */
import { NextRequest, NextResponse } from "next/server";
import { getRelatedTracks } from "@/lib/server/sources/resolver";
import type { ApiError, Track } from "@/lib/types";

/** Success/error envelope for this route (shape mirrors SearchResponse). */
type RelatedResponse = { ok: true; results: Track[] } | ApiError;

/** Clamped result count — radio can't bloat the payload (plan asks sane limit). */
const DEFAULT_LIMIT = 15;
const MIN_LIMIT = 1;
const MAX_LIMIT = 40;

/**
 * Handles `GET /api/related?videoId=<id>&title=<t>&artist=<a>&limit=<n>`.
 *
 * - `videoId` is required; missing → 400 BAD_REQUEST.
 * - `limit` optional; clamped into [1,40], default 15.
 * - Delegates to the resolver: YouTube native related → search fallback → [].
 * - The resolver never throws for radio; a residual failure here → 502 typed
 *   ApiError so raw errors are never leaked to the client.
 */
export async function GET(request: NextRequest): Promise<NextResponse<RelatedResponse>> {
  const sp = request.nextUrl.searchParams;
  const videoId = sp.get("videoId") ?? "";
  const title = sp.get("title") ?? "";
  const artist = sp.get("artist") ?? "";

  if (!videoId) {
    const err: ApiError = {
      ok: false,
      code: "BAD_REQUEST",
      message: "Missing videoId",
    };
    return NextResponse.json(err, { status: 400 });
  }

  const limit = clampLimit(sp.get("limit"));

  try {
    const results = await getRelatedTracks(videoId, title, artist, limit);
    return NextResponse.json({ ok: true, results } satisfies RelatedResponse);
  } catch (err) {
    // Log the underlying cause server-side; the client only sees a typed 502.
    console.error(`[api/related] failed for "${title}"`, err);
    const apiErr: ApiError = {
      ok: false,
      code: "RELATED_FAILED",
      message: "Related tracks unavailable",
      source: "youtube",
    };
    return NextResponse.json(apiErr, { status: 502 });
  }
}

/**
 * Parses and clamps the `limit` query param into the allowed [1,40] window.
 *
 * WHY: a missing/garbage value must not throw — degrade to the default rather
 * than failing the whole request. Floor preserves an integer for downstream
 * array slicing.
 */
function clampLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
}
