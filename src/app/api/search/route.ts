/**
 * GET /api/search — Search endpoint (plan §3.1 / Phase 1).
 *
 * WHY this is a thin route: all search/enrichment/failover logic lives in the
 * resolver (src/lib/server/sources/resolver.ts), which is the single choreography
 * point. This handler only parses the query, enforces limits, and maps results
 * to the canonical JSON contract (SearchResponse) — keeping the HTTP layer dumb
 * and swappable.
 */
import { NextRequest, NextResponse } from "next/server";
import { searchTracks } from "@/lib/server/sources/resolver";
import type { ApiError, SearchResponse } from "@/lib/types";

/** Clamped search-result count. Plan asks for a sane limit so one huge query
 *  never bloats the payload or the iTunes enrichment fan-out. */
const DEFAULT_LIMIT = 12;
const MIN_LIMIT = 1;
const MAX_LIMIT = 50;

/**
 * Handles `GET /api/search?q=<query>&limit=<n>`.
 *
 * - `q` is required; missing → 400 BAD_REQUEST.
 * - `limit` optional; clamped into [1,50], default 12.
 * - Delegates to the resolver which returns enriched YouTube tracks.
 * - Any resolver failure → 502 SEARCH_FAILED (typed ApiError envelope).
 */
export async function GET(request: NextRequest): Promise<NextResponse<SearchResponse>> {
  const q = request.nextUrl.searchParams.get("q");

  if (!q) {
    const err: ApiError = {
      ok: false,
      code: "BAD_REQUEST",
      message: "Missing search query",
    };
    return NextResponse.json(err, { status: 400 });
  }

  const limit = clampLimit(request.nextUrl.searchParams.get("limit"));

  try {
    const results = await searchTracks(q, limit);
    return NextResponse.json({ ok: true, results } satisfies SearchResponse);
  } catch (err) {
    // Log the underlying cause server-side; never leak raw stack traces to the
    // client. The client only needs a friendly, typed 502.
    console.error(`[api/search] failed for "${q}"`, err);
    const apiErr: ApiError = {
      ok: false,
      code: "SEARCH_FAILED",
      message: "Search unavailable",
      source: "youtube",
    };
    return NextResponse.json(apiErr, { status: 502 });
  }
}

/**
 * Parses and clamps the `limit` query param into the allowed [1,50] window.
 *
 * WHY: a missing/garbage value must not throw — degrade to the default rather
 * than failing the whole search. Floor preserves an integer for downstream
 * array slicing.
 */
function clampLimit(raw: string | null): number {
  if (raw === null) return DEFAULT_LIMIT;
  const parsed = Math.floor(Number(raw));
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, parsed));
}
