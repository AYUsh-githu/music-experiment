/**
 * Resilient HTTP + URL helpers shared by every music source.
 *
 * WHY: every source talks to a different third-party backend (YouTube,
 * iTunes). We funnel all network calls through fetchJson so that a timeout /
 * DNS failure / HTTP error becomes a *typed* ServiceError instead of an
 * unhandled raw exception — the resolver can then catch it and fail over.
 */
import type { ServiceError } from "@/lib/server/sources/types";

/**
 * Fetches a URL and decodes the JSON body, or rejects with a typed
 * ServiceError on any network-level failure (DNS, timeout, non-2xx HTTP).
 *
 * WHY: sources need one consistent error contract so the resolver knows
 * "this backend is unusable" without inspecting raw Error shapes. The 10s
 * default timeout keeps a hanging backend (see saavn.dev ENOTFOUND) from
 * blocking the request pipeline indefinitely.
 */
export async function fetchJson<T>(
  url: string,
  init?: RequestInit,
  timeoutMs = 10_000,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      // AbortSignal.timeout is available in Node 18+/Next server runtime.
      signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    // fetch only rejects on network-level problems: ENOTFOUND, refused,
    // aborted-by-timeout. All of these mean the backend is unreachable.
    throw makeServiceError(err, url);
  }

  if (!res.ok) {
    throw makeServiceError(
      new Error(`HTTP ${res.status} ${res.statusText} for ${url}`),
      url,
    );
  }

  // JSON.parse can throw on a non-JSON body; surface that as a typed error too.
  try {
    return (await res.json()) as T;
  } catch (err) {
    throw makeServiceError(err, url);
  }
}

/**
 * Builds a typed ServiceError from an arbitrary thrown value with the source
 * label filled in from the URL so logs say *which* backend failed.
 */
function makeServiceError(err: unknown, url: string): ServiceError {
  const source = errLabelFromUrl(url);
  const message = err instanceof Error ? err.message : "Unknown network error";
  return { ok: false, code: "NETWORK_FAILURE", message, source };
}

/** Maps a request URL to the source id that likely owns it (for error logs). */
function errLabelFromUrl(url: string): "youtube" | "itunes" | "saavn" | undefined {
  if (url.includes("googlevideo") || url.includes("youtube")) return "youtube";
  if (url.includes("itunes") || url.includes("mzstatic")) return "itunes";
  if (url.includes("saavn")) return "saavn";
  return undefined;
}

/**
 * Rewrites an absolute origin URL into the same-origin /api/proxy form the
 * client's <audio> element can actually load (third-party hosts like
 * audio-ssl.itunes.apple.com don't send CORS headers to browsers).
 *
 * WHY we split host/path/params instead of passing the raw URL: the proxy route
 * validates the host against an allowlist (SSRF protection) and needs each part
 * separately to forward Range/headers correctly.
 *
 * `cacheKeyTag` is the resolver's stream-cache key for this URL, echoed back
 * through the proxy as an opaque `ck` param. WHY: googlevideo invalidates
 * extracted URLs well before their advertised `expire=` — a cached URL can go
 * dead while still "valid" by the clock, and the proxy is the only place that
 * ever SEES the origin's 403. With the key travelling alongside the URL, the
 * proxy can evict exactly the entry that produced a dead link, so the next
 * play re-resolves instead of replaying the corpse. It is a cache key, never a
 * credential — no token or URL material is exposed by including it.
 *
 * @returns e.g. /api/proxy?host=https%3A%2F%2Faudio-ssl.itunes.apple.com&path=%2F...&params=...&mime=...
 */
export function buildProxyUrl(originUrl: string, mime: string, cacheKeyTag?: string): string {
  const u = new URL(originUrl);
  const host = `${u.protocol}//${u.hostname}`;
  const path = u.pathname;
  // raw query string WITHOUT the leading '?'; empty when no query is present.
  const params = u.search ? u.search.slice(1) : "";
  return (
    `/api/proxy` +
    `?host=${encodeURIComponent(host)}` +
    `&path=${encodeURIComponent(path)}` +
    `&params=${encodeURIComponent(params)}` +
    `&mime=${encodeURIComponent(mime)}` +
    (cacheKeyTag ? `&ck=${encodeURIComponent(cacheKeyTag)}` : "")
  );
}

/**
 * Returns the content type for a youtubei.js format object.
 *
 * WHY: getStream must echo back the correct `audio/...` MIME so the /api/proxy
 * route sets the right Content-Type header downstream. youtubei.js renamed the
 * field across versions, so we fall through a chain of aliases defensively.
 */
export function mimeOf(format: unknown): string {
  if (format && typeof format === "object") {
    const f = format as Record<string, unknown>;
    // Newer youtubei.js uses mime_type; older used mimeType.
    const explicit =
      typeof f.mime_type === "string" ? f.mime_type : typeof f.mimeType === "string" ? f.mimeType : undefined;
    if (explicit) return explicit;
    if (typeof f.container === "string") return `audio/${f.container}`;
  }
  return "audio/webm";
}
