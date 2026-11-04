/**
 * Shared throttle + cache for the iTunes Search API.
 *
 * WHY this exists: `searchTracks` fans out up to ~15 iTunes enrichment calls in
 * parallel, and `/api/trending` invokes it 4x — so a single request can fire
 * dozens of near-simultaneous `itunes.apple.com/search` requests. Akamai (iTunes'
 * edge) rate-limits that as abusive, returning HTTP 429 then hardening to 403
 * and IP-banning. This module funnels every iTunes lookup through three guards:
 *
 *   1) A promise-semaphore that caps concurrent in-flight requests (avoid the
 *      parallel blast Akamai flags).
 *   2) A 1-hour TTL cache keyed by the request URL, so re-resolving the same
 *      song within the hour makes zero outgoing requests.
 *   3) A 429-aware retry that honors `Retry-After`, bounded so a rejected call
 *      can never stall the queue, retrying at most once before failing soft.
 *
 * Calls here are best-effort in the SAME way iTunesSource treats them: on any
 * failure we throw a normal ServiceError and the source's existing try/catch
 * preserves the already-valid track. Never a hard throw that breaks failover.
 */
import { TTLCache } from "@/lib/server/cache";
import type { ServiceError } from "@/lib/server/sources/types";

/** Max concurrent in-flight iTunes requests — keeps us under Akamai's blast radius. */
const CONCURRENCY = 2;
/**
 * Cache identical iTunes search responses for 1 hour. iTunes metadata is
 * immutable-ish in practice, and the search term encodes the same song+artist,
 * so an identical URL within an hour is a safe cache hit.
 */
const TTL_MS = 60 * 60 * 1000;
/** Upper bound on how long we'll wait out a Retry-After — never stall a slow path. */
const MAX_RETRY_WAIT_MS = 2_000;
/** Mirrors fetchJson's default timeout: a hanging iTunes call must not hold a semaphore slot. */
const TIMEOUT_MS = 10_000;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A tiny promise-semaphore: grants a single slot to at most `CONCURRENCY`
 * callers at once; everyone else queues and runs as a slot frees. This is what
 * turns the "alright, fire all 15 at once" fan-out into a gentle 2-at-a-time
 * stream Akamai won't flag.
 */
class Semaphore {
  private active = 0;
  private queue: Array<() => void> = [];

  /** Claims a slot, waiting in the FIFO queue when all slots are busy. */
  async acquire(): Promise<void> {
    if (this.active < CONCURRENCY) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
  }

  /** Releases a slot and wakes the longest-waiting queued caller. */
  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }
}

/** Module-level singleton: shared by ALL iTunes requests across the process. */
const slot = new Semaphore();

/** 1-hour TTL cache of decoded iTunes responses, keyed by the full request URL. */
const cache = new TTLCache<unknown>(TTL_MS, 256);

/**
 * The one entry point every iTunes Search lookup should use. It serializes
 * identical in-flight lookups (semaphore + post-acquire cache re-check), memoizes
 * the decoded JSON for an hour, and retries a single 429 before failing soft.
 *
 * Returns the decoded JSON body. On any failure it throws a normal ServiceError
 * (NETWORK_FAILURE) so the caller's existing error handling owns the fallout —
 * enrichment swallows it, resolvePreviewFor surfaces it as before.
 */
export async function itunesFetchJson<T = unknown>(url: string): Promise<T> {
  // Cache hit → no semaphore wait, no outgoing request at all.
  const cached = cache.get(url);
  if (cached !== undefined) return cached as T;

  await slot.acquire();
  try {
    // Now that we hold a slot, re-check the cache: a queued duplicate request may
    // have completed and populated it while we waited — avoid a duplicate fetch.
    const recheck = cache.get(url);
    if (recheck !== undefined) return recheck as T;

    const data = await fetchWithRetry(url);
    cache.set(url, data);
    return data as T;
  } finally {
    slot.release();
  }
}

/**
 * Fetches + JSON-decodes one iTunes URL with a 429-aware single retry.
 *
 * Attempt 0: on HTTP 429, honor Retry-After (bounded) then retry once.
 * Attempt 1 (or any non-429 non-ok status): fail soft via a normal ServiceError,
 * identical to how http.ts's fetchJson would surface it — so the source treats a
 * rate-limit like any other iTunes outage rather than a new hard failure.
 */
async function fetchWithRetry(url: string): Promise<unknown> {
  for (let attempt = 0; attempt <= 1; attempt++) {
    const res = await rawFetch(url);

    // Only the FIRST attempt gets a 429 retry; a second 429 falls through to the
    // generic non-ok path below and fails soft (bounded by the max-1 retry rule).
    if (res.status === 429 && attempt === 0) {
      await delay(retryAfterMs(res.headers.get("retry-after")));
      continue;
    }

    if (!res.ok) {
      throw makeServiceError(`HTTP ${res.status} ${res.statusText} for ${url}`);
    }

    // JSON.parse can throw on a non-JSON body; surface that as a typed error too.
    try {
      return await res.json();
    } catch (err) {
      throw makeServiceError(err instanceof Error ? err.message : "Invalid JSON from iTunes");
    }
  }
  // Defensive tail: loop above only reaches here if both attempts 429'd, which
  // the `continue` structure prevents; kept for exhaustiveness.
  throw makeServiceError(`HTTP 429 for ${url}`);
}

/**
 * Performs the raw fetch with fetchJson's timeout semantics: abort after
 * TIMEOUT_MS and translate network-level failures into a typed ServiceError.
 */
async function rawFetch(url: string): Promise<Response> {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw makeServiceError(
      err instanceof Error ? err.message : "iTunes unreachable",
    );
  }
}

/**
 * Parses a Retry-After header into a bounded wait in ms. Retry-After is either
 * a number of seconds or an HTTP-date; we honor the numeric form and cap the
 * wait so a hostile/large value can't stall a request. When absent/invalid we
 * fall back to a small exponential-backoff base.
 */
function retryAfterMs(header: string | null): number {
  if (header) {
    const asSeconds = Number(header);
    if (Number.isFinite(asSeconds) && asSeconds > 0) {
      return Math.min(asSeconds * 1000, MAX_RETRY_WAIT_MS);
    }
    // HTTP-date form is rare here and fiddly to parse; treat as "not usable".
  }
  // Exponential-backoff base for attempt 0 (2^0 * 250ms), already under the cap.
  return Math.min(250, MAX_RETRY_WAIT_MS);
}

/**
 * Builds a typed ServiceError labeled as the iTunes source. Local to this module
 * (http.ts's helper is private and this is iTunes-only), kept consistent with
 * the rest of the codebase's error contract.
 */
function makeServiceError(message: string): ServiceError {
  return { ok: false, code: "NETWORK_FAILURE", message, source: "itunes" };
}
