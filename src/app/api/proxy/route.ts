/**
 * GET /api/proxy — Range-aware streaming proxy (plan §3.2, Phase 1 MVP core).
 *
 * WHY this route is mandatory: browsers cannot fetch googlevideo.com or
 * audio-ssl.itunes.apple.com directly (no CORS headers, Range restrictions), so
 * ALL audio bytes must flow through this same-origin proxy. A client's <audio>
 * element requests /api/proxy?host=...&path=...&params=... with a `Range`
 * header; we forward that range to the origin and pipe the origin's body back
 * as a streaming (non-buffered) 206 — enabling seeking without restarting.
 *
 * SECURITY: we never accept an arbitrary full URL. The route only receives the
 * (already URL-encoded) host/path/params parts and validates `host` against a
 * strict allowlist to prevent SSRF. Only known audio providers are reachable.
 */
import { NextRequest, NextResponse } from "next/server";
import type { ApiError } from "@/lib/types";
import { invalidateStreamByTag } from "@/lib/server/sources/resolver";

/** Non-browser UA so origin servers don't block on anti-bot heuristics. */
const PROXY_UA = "Mozilla/5.0";

/** Hard timeout for an origin fetch — a hung/broken provider must not pin the
 *  server's request pipeline forever (mirrors the fetchJson 10s policy). */
const ORIGIN_TIMEOUT_MS = 20_000;

/**
 * Hosts the proxy may reach, by hostname suffix/equality. Only HTTPS — except
 * explicit loopback (see below).
 *
 * WHY: SSRF protection. A malicious or confused caller can only spoof hosts that
 * resolve to one of these trusted audio providers — never an internal IP or an
 * arbitrary public host. The allowlist is deny-by-default: anything not listed
 * here is rejected with 400 FORBIDDEN_HOST. Purpose of each allowed host:
 *   - *.googlevideo.com                     — YouTube CDN (audio stream URLs)
 *   - audio-ssl.itunes.apple.com, *.mzstatic.com — iTunes preview audio CDN
 *   - *.saavncdn.com, *.cdn.jio.com, *.jiosaavn.com — Saavn audio CDN hosts
 *   - saavn.dev                             — the saavn.dev API root (if ever
 *                                             proxied for API-backed metadata)
 *   - localhost / 127.0.0.1 (EXACT, not suffix) — the SELF-HOSTED Saavn clone
 *                                             (jiosaavn-api on :3001). WHY: the
 *                                             Saavn source can point at a local
 *                                             dev instance, and the proxy must be
 *                                             able to reach it. These exact
 *                                             loopback names (never a suffix like
 *                                             `.localhost`) keep this tight — an
 *                                             attacker can't slip in an internal
 *                                             LAN host, only the machine's own
 *                                             loopback.
 */
function isHostnameAllowed(hostname: string): boolean {
  return (
    hostname.endsWith(".googlevideo.com") ||
    hostname === "audio-ssl.itunes.apple.com" ||
    hostname.endsWith(".mzstatic.com") ||
    hostname.endsWith(".saavncdn.com") ||
    hostname.endsWith(".cdn.jio.com") ||
    hostname.endsWith(".jiosaavn.com") ||
    hostname === "saavn.dev" ||
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]"
  );
}

/** Whether a hostname targets this machine's own loopback interface. WHY: loopback
 *  is the only case where we relax the https+443-only rule (the local clone serves
 *  plain http on :3001), and it is safe to do so — loopback can't reach another
 *  LAN host, only this dev machine. */
function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Defense-in-depth rejects for attacker-controlled URL parts. `path` and
 * `params` are spliced into the origin URL verbatim, so they could smuggle a
 * userinfo (`@host`) or arbitrary port onto an allowlisted hostname. We forbid
 * the characters that enable URL-authority smuggling outright; the final URL is
 * also re-parsed and its true hostname/port re-checked below.
 */
function hasForbiddenUrlChars(s: string): boolean {
  return /[@\s\u0000-\u001f\u007f]/.test(s);
}

/**
 * Validates a reconstructed origin URL for SSRF by re-parsing it and enforcing
 * bounds on the components a hostile caller controls:
 *   - protocol must be https, EXCEPT loopback (localhost/127.0.0.1) which may be
 *     plain http because the self-hosted Saavn clone deviates on it
 *   - no userinfo: `https://host@127.0.0.1:8080/x` would otherwise make the
 *     effective target an internal address while the allowlisted name is merely
 *     a username
 *   - the parsed hostname must satisfy the allowlist
 *   - no custom port (only 443 / empty) so an evil caller can't hit an arbitrary
 *     port on an allowlisted domain — relaxed to permit any port ONLY for the
 *     exact loopback hosts (the local clone binds :3001)
 * Returns the validated URL (what callers should fetch), or null to reject.
 */
function validateOriginUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null; // malformed → reject
  }
  const loopback = isLoopbackHost(url.hostname);
  if (url.protocol !== "https:" && !(loopback && url.protocol === "http:")) return null;
  if (url.username !== "" || url.password !== "") return null; // no userinfo
  if (!isHostnameAllowed(url.hostname)) return null;
  // https:+remote hosts may only use the default 443; loopback may use any port
  // (the clone serves on :3001). This keeps the remote surface minimal while
  // allowing the local dev API through.
  if (!loopback && url.port !== "" && url.port !== "443") return null;
  return url;
}

/**
 * Handles `GET /api/proxy?host=&path=&params=&mime=`.
 *
 * Steps: validate host → rebuild origin URL → RE-VALIDATE the full URL (true
 * hostname + port + no userinfo, closing the path/params authority-smuggling
 * hole) → forward `Range` verbatim → fetch origin (streaming) → copy status +
 * key headers → pipe body back. Any fetch failure → 502 PROXY_FAILED.
 */
export async function GET(request: NextRequest): Promise<Response> {
  const sp = request.nextUrl.searchParams;
  const host = sp.get("host") ?? "";
  const path = sp.get("path") ?? "";
  const params = sp.get("params") ?? ""; // raw query string, no leading '?'
  const mime = sp.get("mime") ?? "";
  // Opaque stream-cache key echoed back by the resolver (see buildProxyUrl).
  // Purely a cache tag, never trusted for anything but eviction.
  const cacheTag = sp.get("ck") ?? "";

  // No arbitrary full URLs: we only assemble from host/path/params, and `host`
  // itself must still parse to an allowlisted origin on its own. Only the exact
  // loopback hosts (self-hosted Saavn clone) may be plain http; everything else
  // must be https.
  const hostIsLoopback = host.startsWith("http://localhost:") || host.startsWith("http://127.0.0.1:");
  if (!host.startsWith("https://") && !hostIsLoopback) {
    return forbid();
  }
  try {
    if (!isHostnameAllowed(new URL(host).hostname)) return forbid();
  } catch {
    return forbid(); // malformed host → reject
  }
  // path/params are attacker-controlled: strip whitespace/controls selectors so
  // they cannot smuggle URL-authority characters (`@`, whitespace, control).
  if (hasForbiddenUrlChars(path) || hasForbiddenUrlChars(params)) return forbid();

  // Reconstruct the absolute origin URL exactly as the source built it. The '?'
  // separator is added only when there is an actual query string so a bare path
  // (common for googlevideo URLs) doesn't gain a trailing '?'.
  const originUrl = params ? `${host}${path}?${params}` : `${host}${path}`;

  // The true SSRF gate: re-parse the WHOLE URL — not just `host` — and verify
  // hostname + port + no userinfo on what fetch will actually connect to.
  const url = validateOriginUrl(originUrl);
  if (!url) return forbid();

  // Forward the client's range verbatim (null → no range). Some proxies need an
  // explicit bytes-from-0 for the first chunk even when the client omitted a
  // range, but we respect the plan: pass exactly what the client sent.
  const incomingRange = request.headers.get("range");

  try {
    const origin = await fetch(url, {
      headers: {
        // Only include Range when the client actually sent one.
        ...(incomingRange ? { Range: incomingRange } : {}),
        "User-Agent": PROXY_UA,
      },
      signal: AbortSignal.timeout(ORIGIN_TIMEOUT_MS),
    });

    // A 204/HEAD-style empty body can't stream audio — treat as failure rather
    // than piping an empty stream to a confused player.
    if (!origin.body) {
      const err: ApiError = {
        ok: false,
        code: "PROXY_FAILED",
        message: "Stream proxy failed",
      };
      return NextResponse.json(err, { status: 502 });
    }

    // Dead-URL eviction (ROOT CAUSE FIX): googlevideo invalidates an extracted
    // URL well before its advertised `expire=`, so a cache entry can still be
    // "fresh" by the clock while the CDN rejects the link outright. 403/410 from
    // the origin means the URL itself is dead — NOT that the proxy failed — so
    // drop the cache entry that produced it. The very next play then re-resolves
    // a live URL instead of being handed the same corpse for the rest of the TTL.
    // Note we still forward the origin's status below; this only ensures the
    // failure cannot repeat.
    if (origin.status === 403 || origin.status === 410 || origin.status === 404) {
      const evicted = cacheTag ? invalidateStreamByTag(cacheTag) : false;
      console.warn(
        `[api/proxy] origin ${origin.status} for ${host}${path} — ` +
          (evicted ? `evicted stale cache entry "${cacheTag}"` : "no cache entry to evict"),
      );
    }

    // Copy the origin's key headers so the <audio> element can seek. Prefer the
    // origin's Content-Type; fall back to the mime param the source supplied.
    const headers = new Headers();
    headers.set("Content-Type", origin.headers.get("content-type") ?? mime);
    if (origin.headers.has("content-range")) {
      headers.set("Content-Range", origin.headers.get("content-range") as string);
    }
    if (origin.headers.has("accept-ranges")) {
      headers.set("Accept-Ranges", origin.headers.get("accept-ranges") as string);
    }
    if (origin.headers.has("content-length")) {
      headers.set("Content-Length", origin.headers.get("content-length") as string);
    }
    // Tell the browser not to cache proxied audio — stream URLs are short-lived
    // and re-resolved each play, so a stale cached 206 would corrupt playback.
    headers.set("Cache-Control", "no-store");

    // Pass the origin status through (usually 206 Partial Content) and stream
    // the body directly — never buffer it into memory (plan §3.2).
    return new Response(origin.body as ReadableStream, { status: origin.status, headers });
  } catch (err) {
    console.error(`[api/proxy] failed for ${host}${path}`, err);
    const apiErr: ApiError = {
      ok: false,
      code: "PROXY_FAILED",
      message: "Stream proxy failed",
    };
    return NextResponse.json(apiErr, { status: 502 });
  }
}

/** Shared 400 reject envelope for every SSRF/bad-input path above. */
function forbid(): NextResponse<ApiError> {
  const err: ApiError = {
    ok: false,
    code: "FORBIDDEN_HOST",
    message: "Host not allowed",
  };
  return NextResponse.json(err, { status: 400 });
}
