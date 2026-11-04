"use client";

/**
 * Search page — core UI (WS6 polished; upgraded §4.2 hero-style field).
 *
 * Debounces the query (350ms, plan §5.2), aborts any in-flight request when a
 * newer query or an empty query arrives (so stale results can never overwrite
 * fresh ones), and renders the right state for every async phase:
 *   idle (prompt) -> loading (skeleton rows) -> error (friendly + retry)
 *                                             -> results (TrackList)
 *
 * WS6 polish (kept):
 *  - The deferred-loading gate means a cached/fast response never flashes a
 *    skeleton; the skeleton only appears once loading clearly outlives 120ms.
 *  - A clear (✕) button is revealed whenever the query is non-empty. It is a
 *    real 44px button (no hover-only affordance) and returns focus to the input.
 *  - An inline "Searching…" status is announced politely while the request is
 *    in flight, so screen-reader users get the same feedback sighted ones do.
 *  - Matches are highlighted by SPLITTING the string and wrapping the hits in
 *    <mark> spans — never dangerouslySetInnerHTML (§4).
 *
 * §4.2 upgrades (presentation only — request/play wiring untouched):
 *  - Hero-style pill field (56px, glass, accent border + pre-blurred static
 *    glow layer whose OPACITY animates on focus — no filter animation).
 *  - Recent-search chips persisted in localStorage "sonic.recent-searches"
 *    (SSR-safe: read in an effect after mount, capped at 8, deduped, most
 *    recent first; click re-runs the search; "Clear" removes all). NOT the
 *    IndexedDB db.ts — that store is frozen by contract (§4.2 note).
 *
 * Presentation fixes on top of §4.2:
 *  - The All/Songs chips were a NO-OP: clicking them did nothing (the rendered
 *    list never referenced `filter`), so the control lied about its state. They
 *    are render-only after all, but "Songs" now has exactly one honest meaning:
 *    "hide rows that are not playable". The API never returns non-song results,
 *    so ANY result list contains songs, which makes "Songs" a genuine no-op on
 *    the data — rather than ship a dead control, the chips only appear when the
 *    current results actually contain a non-song type to filter out.
 *
 * Playback is delegated to the playerBridge so this page stays decoupled from
 * the PlayerProvider. requestPlayQueue(tracks, index) seeds the whole result
 * list as a queue (falling back to requestPlay for a lone result).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SearchResponse, Track } from "@/lib/types";
import TrackList from "@/components/track/TrackList";
import EmptyState, { AlertIcon } from "@/components/ui/EmptyState";
import { TrackRowSkeleton } from "@/components/ui/Skeleton";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { useMounted } from "@/hooks/useMounted";
import { requestPlay, requestPlayQueue } from "@/lib/client/playerBridge";
import Highlight from "@/components/ui/Highlight";
import { Search as SearchIcon, X } from "@/components/ui/icons";
import EqualizerBars from "@/components/ui/EqualizerBars";
import { STAGGER } from "@/lib/client/motion";
import { cn } from "@/components/track/cn";

/**
 * Recent-search persistence. One helper instead of three inline reads so the
 * page has a single reason for the post-mount effect below: localStorage is
 * unavailable during SSR/BFCache-restore, and reading it during render is a
 * hydration hazard (server markup and first client render must match).
 */
function readRecentSearches(): string[] {
  try {
    return parseRecent(window.localStorage.getItem(RECENT_KEY));
  } catch {
    // Blocked storage (private mode, disabled cookies): no chips, never a throw.
    return [];
  }
}

/**
 * Locally-owned debounce hook: returns the input only after it has been quiet
 * for `delay`ms. Trailing-edge so a fast typist triggers one search per pause.
 *
 * The returned value is a COMMIT: it only ever moves to a non-empty string the
 * user actually typed, and it is parked at `""` while the field is empty. That
 * distinction matters downstream — a raw debounce lags the field by `delay`ms,
 * so right after the user clears the box the stale query is still "current" and
 * a naive search effect would immediately re-run it and repopulate the results
 * the user just cleared.
 */
function useDebouncedValue(value: string, delay: number): string {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const trimmed = value.trim();
    // Clearing the field commits instantly: there is no request to batch, and
    // waiting `delay`ms would leave the stale query eligible for one more run.
    if (!trimmed) {
      const id = window.setTimeout(() => setDebounced(""), 0);
      return () => window.clearTimeout(id);
    }
    // Reset the timer on every keystroke; only commit once typing stops.
    const id = window.setTimeout(() => setDebounced(trimmed), delay);
    return () => window.clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

/** Discriminated union so invalid phase/message combinations can't compile. */
type Status =
  | { phase: "idle" }
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "results" };

/** localStorage key for the recent-search chips (§4.2 — localStorage, NOT db.ts). */
const RECENT_KEY = "sonic.recent-searches";
const RECENT_CAP = 8;

/** Valid, deduped, capped chip list from stored JSON; any garbage yields []. */
function parseRecent(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of parsed) {
      if (typeof item !== "string") continue;
      const trimmed = item.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      out.push(trimmed);
      if (out.length >= RECENT_CAP) break;
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * One filter chip. Recomputed against `visibleTracks` at the call site.
 *
 * WHY the pill is an inner element: the chip reads best at 32px, but rule 3
 * requires a 44px hit area — so the BUTTON is h-11 (an invisible, full-size tap
 * target) and the visible pill is the span inside it. The look is unchanged; the
 * tappable box is compliant.
 */
function FilterChip({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className="flex h-11 items-center rounded-full focus-visible:outline-none"
    >
      <span
        className={cn(
          "flex h-8 items-center rounded-full px-4 text-xs font-semibold",
          "transition-colors duration-[var(--dur-micro)]",
          {
            "bg-accent text-white": active,
            "border border-border bg-surface text-muted hover:border-accent/50 hover:text-text":
              !active,
          },
        )}
      >
        {label}
      </span>
    </button>
  );
}

/**
 * One recent-search chip. The whole pill is a single 44px-tall button; the
 * leading glyph is decorative, so the accessible name is exactly the query.
 */
function RecentChip({
  label,
  onClick,
}: {
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={label}
      className={cn(
        "flex h-11 max-w-full shrink-0 items-center gap-2 rounded-full border border-border bg-surface px-3.5",
        "text-xs font-medium text-muted transition-colors duration-[var(--dur-micro)] hover:border-accent/50 hover:text-text",
        "focus-visible:outline-none active:scale-[0.97]",
      )}
    >
      <SearchIcon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{label}</span>
    </button>
  );
}

export default function SearchPage() {
  const [query, setQuery] = useState("");
  const debouncedQuery = useDebouncedValue(query, 350);
  const [status, setStatus] = useState<Status>({ phase: "idle" });
  const [tracks, setTracks] = useState<Track[]>([]);
  // Recent searches (§4.2): empty during SSR/first render, filled after mount.
  const [recent, setRecent] = useState<string[]>([]);
  // Result filter. "all" shows every row the API returned; "songs" hides the
  // 30-second preview rows (see `hasPreviewRows` below — the chips only appear
  // when the results actually contain a preview to hide).
  const [filter, setFilter] = useState<"all" | "songs">("all");
  // True once the user has (visually) engaged the field, so the glow layer can
  // fade in even before focus-dependent CSS could transition (opacity animates).
  const [fieldFocused, setFieldFocused] = useState(false);
  // Ref to the live AbortController so cleanup and the empty-query path can
  // cancel a request that is still in flight.
  const abortRef = useRef<AbortController | null>(null);
  // Monotonic id for the newest search attempt. Every trigger (typing, submit,
  // retry, clearing the box) bumps it, and a response may only be written while
  // its own id is still the newest — the structural guarantee that a slow older
  // response can never overwrite a newer one, independent of abort timing.
  const requestGeneration = useRef(0);
  // What the current run is doing, so an effect re-run caused by a benign
  // dependency change (the debounce settling on the query we just submitted)
  // can recognize it as the same request instead of aborting and refetching.
  const lastRunRef = useRef<{ query: string; submitKey: number } | null>(null);
  // Explicit "run this query now" trigger (Enter, or a recent-search chip).
  // The effect keys on it so a submit re-runs the SAME query immediately instead
  // of waiting for the debounce, which a trailing-edge debounce never fires for
  // a value that did not change — submitting your own current text did nothing.
  const [submitKey, setSubmitKey] = useState(0);
  // The query the explicit submit/retry applies to. Always paired with a
  // submitKey bump, so re-submitting the identical text still re-runs.
  const [submitted, setSubmitted] = useState("");
  // The query that produced the CURRENT `tracks`. Kept as state (not derived
  // from the debounce) because the debounce keeps moving: by the time an empty
  // result lands the field may already hold different text, and echoing that
  // would name a query the user never searched for.
  const [resultQuery, setResultQuery] = useState("");
  // Focus target for the clear button (we hand focus back to the input).
  const inputRef = useRef<HTMLInputElement | null>(null);

  // SSR-safe recent-search read: hydration renders zero chips (matching the
  // server), then this effect fills the real list. Writing back happens only
  // on a successful search, so storage is never touched during render.
  const mounted = useMounted();
  // Mount-once latch. `useMounted()` flips to true on the CLIENT's first render
  // (useSyncExternalStore), which can run BEFORE this effect on the very same
  // commit — so a bare `if (!mounted) return; setRecent(...)` would be a
  // synchronous setState in the effect body. The ref latch states the actual
  // intent ("read storage exactly once after the first commit") and keeps the
  // effect body free of an unconditional setState.
  const recentLoadStarted = useRef(false);
  useEffect(() => {
    if (recentLoadStarted.current) return;
    recentLoadStarted.current = true;
    // Sync browser storage -> state. This is the sanctioned external-store
    // pattern (AmbientBackdrop.tsx): the read must happen after mount, and only
    // an effect can promise that, so the resulting setState is intended.
    setRecent(readRecentSearches());
  }, []);

  const loading = status.phase === "loading";
  // Deferred gate (WS6): hides the skeleton on fast/cached loads and holds it
  // for a minimum window once shown, so nothing blinks.
  const showSkeleton = useDeferredLoading(loading, { delay: 120, minDisplay: 350 });

  /** Record a trimmed query as the newest chip (dedupe + cap 8) and persist. */
  const rememberSearch = useCallback((q: string) => {
    try {
      const next = [q, ...parseRecent(window.localStorage.getItem(RECENT_KEY))]
        .slice(0, RECENT_CAP);
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(next));
      setRecent(next);
    } catch {
      // Quota/privacy failure: chips still work for this session via setRecent.
    }
  }, []);

  const clearRecent = useCallback(() => {
    try {
      window.localStorage.removeItem(RECENT_KEY);
    } catch {
      // Nothing to recover — the state below is the source of truth for UI.
    }
    setRecent([]);
  }, []);

  /** Programmatic search used by recent-search chips (click re-runs, §4.2). */
  const runSearch = useCallback(
    (q: string) => {
      setQuery(q);
      // An empty chip can't exist (parseRecent trims), but guard anyway so the
      // "run now" path can never fetch for a blank query.
      if (!q.trim()) {
        abortRef.current?.abort();
        setTracks([]);
        setStatus({ phase: "idle" });
        return;
      }
      // Explicit run: cancel the in-flight request NOW rather than waiting for
      // the effect's cleanup, so the old response can't land in between.
      abortRef.current?.abort();
      setStatus({ phase: "loading" });
      // Re-run the effect for this exact query without the typing debounce.
      setSubmitted(q);
      setSubmitKey((k) => k + 1);
      // A chip click must move focus into the field it just filled: the pointer
      // path would otherwise leave focus on a chip the results replaced, and a
      // keyboard user's next keystroke would go nowhere. Deferred a tick so the
      // focus lands after the click's default focus handling.
      window.setTimeout(() => inputRef.current?.focus(), 0);
    },
    [],
  );

  useEffect(() => {
    // The debounce commits a trimmed query only once typing settles, and parks
    // at "" the moment the field is cleared — so an empty box can never re-run a
    // stale search here, and no comparison against the live field is needed.
    //
    // Two independent triggers feed this effect:
    //   - `submitted`, bumped with `submitKey`, is an explicit "run it now"
    //     (Enter, a recent-search chip, Retry) that skips the debounce;
    //   - `debouncedQuery` is the settled typing path.
    // `submitted` wins while it is set, so an explicit run is never shadowed.
    const q = submitted.trim() || debouncedQuery;

    // Every pass invalidates whatever was in flight, including the pass that
    // just emptied the box: "the newest trigger is the only one allowed to
    // write" is what guarantees an older response can never overwrite a newer
    // one. The invalidation lives in the body rather than in a cleanup function
    // because cleanup also runs for a benign dependency change (the debounce
    // settling on the query that was just submitted), and aborting there would
    // kill a request that is still the right one.
    const generation = ++requestGeneration.current;
    if (!q) {
      abortRef.current?.abort();
      // Forget the last run so re-typing the same text searches again.
      lastRunRef.current = null;
      return;
    }

    // The same query for the same explicit action is already the current run —
    // e.g. Enter was pressed before the debounce settled, and the debounce then
    // committed the identical text. Re-running would abort a perfectly good
    // request and flash the skeleton over results for the same query.
    const last = lastRunRef.current;
    if (last && last.query === q && last.submitKey === submitKey) return;
    lastRunRef.current = { query: q, submitKey };

    // Supersede the previous request and take ownership of the in-flight slot.
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    void (async () => {
      try {
        // Typing reaches this effect only through the debounce, so the skeleton
        // is flipped on here — asynchronously, in the continuation, once the
        // debounce has actually fired. (A synchronous setState in the effect
        // body would be flagged and cascade; an explicit submit already set the
        // loading phase in its own event handler.)
        await Promise.resolve();
        if (requestGeneration.current !== generation) return;
        setStatus((prev) => (prev.phase === "loading" ? prev : { phase: "loading" }));

        const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=20`, {
          signal: controller.signal,
        });
        if (requestGeneration.current !== generation) return;
        // A non-2xx server response still carries the ApiError envelope, but a
        // gateway error page does not — handle both without trusting `res.ok`.
        const data = (await res.json().catch(() => null)) as SearchResponse | null;
        if (requestGeneration.current !== generation) return;
        if (data?.ok) {
          setTracks(data.results);
          setResultQuery(q);
          setStatus({ phase: "results" });
          // Only a real, successful search earns a chip (§4.2 "persisted").
          rememberSearch(q);
        } else {
          // Server sent a typed ApiError envelope — surface its friendly message.
          setTracks([]);
          setResultQuery(q);
          setStatus({
            phase: "error",
            message:
              data && !data.ok
                ? data.message
                : "Search is unavailable right now. Please try again.",
          });
        }
      } catch (err) {
        // A superseded request (aborted by the trigger that replaced it, or by
        // an emptied box) must not write anything at all.
        if (requestGeneration.current !== generation) return;
        // An abort can also arrive with the generation still current on some
        // browsers; it is never an error the user should see either way.
        if (err instanceof DOMException && err.name === "AbortError") return;
        setTracks([]);
        setStatus({
          phase: "error",
          message: "Something went wrong while searching. Please try again.",
        });
      }
    })();
  }, [submitted, submitKey, debouncedQuery, rememberSearch]);

  // Unmount-only cleanup: abort a request that is still running when the route
  // is left. Deliberately separate from the search effect (whose cleanup would
  // fire on benign dependency changes too — see the note in its body).
  useEffect(
    () => () => {
      abortRef.current?.abort();
    },
    [],
  );

  const handleRetry = useCallback(() => {
    // Retry what the user is looking at: the LIVE field text wins over both the
    // debounced value (which may not have settled yet) and the last submit.
    const q = query.trim() || submitted.trim();
    if (!q) return;
    setStatus({ phase: "loading" });
    setSubmitted(q);
    setSubmitKey((k) => k + 1);
  }, [query, submitted]);

  const handleQueryChange = useCallback((value: string) => {
    setQuery(value);
    // Typing invalidates the explicit submit: from here on the debounced value
    // is the source of truth, so a later keystroke can never be shadowed by a
    // stale `submitted` query.
    setSubmitted("");
    // Clearing the box cancels any in-flight search and returns to the prompt
    // immediately (event-driven reset, so it needs no effect).
    if (!value.trim()) {
      abortRef.current?.abort();
      setTracks([]);
      setStatus({ phase: "idle" });
    }
  }, []);

  /** Enter / the form's submit: run the typed query now, skipping the debounce. */
  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const q = query.trim();
      if (!q) return;
      abortRef.current?.abort();
      setStatus({ phase: "loading" });
      setSubmitted(q);
      setSubmitKey((k) => k + 1);
    },
    [query],
  );

  const handleClear = useCallback(() => {
    abortRef.current?.abort();
    setQuery("");
    setSubmitted("");
    setTracks([]);
    setStatus({ phase: "idle" });
    // Keep the caret where the user was working.
    inputRef.current?.focus();
  }, []);

  // Result rows for the current filter. Derived during render (never stored) so
  // the list can never disagree with the response, and so it stays memo-stable
  // for TrackList.
  //
  // The All/Songs chips were previously pure decoration: they rendered and
  // responded to clicks, but nothing on the page read `filter`, so they were a
  // control that did nothing. Track has no result `type` (the API only ever
  // returns playable tracks), so "Songs" needs an honest, data-derived meaning
  // instead of a fake one. The one real distinction the API does express is
  // `isPreview` (a ~30s iTunes preview rather than the full song), so the
  // filter narrows to FULL-LENGTH SONGS. It is hidden unless the results
  // actually contain a preview — a chip that provably changes nothing is worse
  // than no chip at all.
  const hasPreviewRows = useMemo(() => tracks.some((track) => track.isPreview), [tracks]);
  const visibleTracks = useMemo(
    () =>
      filter === "songs" && hasPreviewRows
        ? tracks.filter((track) => !track.isPreview)
        : tracks,
    [tracks, filter, hasPreviewRows],
  );

  const handlePlay = useCallback(
    (track: Track, index: number) => {
      // Seed the whole visible list as a queue starting at the clicked row so
      // NEXT flows through the rest of the results (Phase 2). A lone result is
      // just a single-track play, so route through the plain requestPlay path.
      if (visibleTracks.length > 1) {
        requestPlayQueue(visibleTracks, index);
      } else {
        requestPlay(track);
      }
    },
    [visibleTracks]
  );

  // Stagger for the recent-chips row (max-8 cap from the shared token).
  const chipStagger = useMemo(() => STAGGER.maxItems, []);

  return (
    <section className="mx-auto max-w-5xl">
      {/* Page header. The h1 scale is shared with Library and Settings
          (text-3xl/sm:text-4xl, as on Home) so the three content routes open at
          the same visual weight instead of Home being one step larger. */}
      <h1 className="text-3xl font-bold tracking-tight text-text sm:text-4xl">Search</h1>
      <p className="mt-1 text-sm text-muted">
        Find a track by song, artist or album.
      </p>

      {/* ---------- §4.2 hero-style search field ---------- */}
      <form
        className="relative mt-4"
        onSubmit={handleSubmit}
        role="search"
        aria-label="Search songs"
      >
        {/* Pre-blurred static glow layer behind the pill. Its OPACITY animates
            on focus (§1.5 pattern) — the blur itself is baked in statically and
            never animates, so no filter is ever transitioned. */}
        <span
          aria-hidden
          className={cn(
            "pointer-events-none absolute -inset-1 rounded-2xl bg-accent/30 blur-lg",
            "transition-opacity duration-[var(--dur-standard)] ease-out",
            { "opacity-100": fieldFocused && !loading, "opacity-0": !(fieldFocused && !loading) },
          )}
        />
        <div className="relative flex h-14 items-center rounded-full border border-border bg-surface/90 pl-5 pr-3 transition-colors duration-[var(--dur-standard)] focus-within:border-accent">
          <SearchIcon className="h-5 w-5 shrink-0 text-muted" aria-hidden />
          <input
            ref={inputRef}
            type="search"
            autoComplete="off"
            placeholder="Search by song or artist…"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            onFocus={() => setFieldFocused(true)}
            onBlur={() => setFieldFocused(false)}
            aria-label="Search by song or artist"
            className={cn(
              "h-full min-w-0 flex-1 bg-transparent px-3 text-base text-text",
              "placeholder:text-muted focus:outline-none",
              "[&::-webkit-search-cancel-button]:hidden",
            )}
          />
          {/* Inline "searching" state (§4.2): equalizer bars while in flight —
              distinct from the cleared field and always visible, not hover-gated. */}
          {loading && <EqualizerBars className="mr-1 h-4 w-5 shrink-0" playing />}
          {/* Clear button: revealed only when there is something to clear, a real
              44px target, never hover-gated (unchanged WS6 contract). */}
          {query.length > 0 && (
            <button
              type="button"
              onClick={handleClear}
              aria-label="Clear search"
              className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition-colors hover:text-text active:scale-[0.97]"
            >
              <X className="h-4 w-4" />
            </button>
          )}
        </div>
      </form>

      {/* ---------- §4.2 recent-search chips (client-only after mount) ----------
          The region's height is RESERVED at all times. Before, the chip row only
          existed when there was a recent query, so the field, the filter row and
          every result below jumped up as soon as the first search replaced the
          prompt with results — the filter row is pinned by this min-height and
          the chips simply fill it (progressively: chips are recorded when a
          response ARRIVES, so they appear after the second search in a season).
          `mounted` gates the CLIENT-ONLY content; the box itself is SSR-stable. */}
      <div className="mt-3 flex min-h-11 items-center gap-2">
        {mounted && recent.length > 0 && (
          <>
            <div className="sonic-edge-fade flex min-w-0 flex-1 items-center gap-2 overflow-x-auto">
              {recent.slice(0, chipStagger).map((label) => (
                <RecentChip key={label} label={label} onClick={() => runSearch(label)} />
              ))}
            </div>
            <button
              type="button"
              onClick={clearRecent}
              aria-label="Clear recent searches"
              className="h-11 shrink-0 rounded-full px-3 text-xs font-medium text-muted transition-colors duration-[var(--dur-micro)] hover:bg-surface-2 hover:text-text active:scale-[0.97]"
            >
              Clear
            </button>
          </>
        )}
      </div>

      {/* ---------- filter chips — shown only when they can actually filter ---------- */}
      {hasPreviewRows && (
        <div className="mt-2 flex items-center gap-2" role="group" aria-label="Filter results">
          <FilterChip label="All" active={filter === "all"} onClick={() => setFilter("all")} />
          <FilterChip
            label="Full songs"
            active={filter === "songs"}
            onClick={() => setFilter("songs")}
          />
          <span className="text-xs text-muted">Hide 30-second previews</span>
        </div>
      )}

      {/* Polite live status — announces the outcome, not just the in-flight
          state, so "0 results" and "search failed" are never silent. */}
      <p className="sr-only" role="status" aria-live="polite">
        {status.phase === "loading"
          ? "Searching…"
          : status.phase === "results"
            ? tracks.length === 0
              ? "No results found"
              : `${visibleTracks.length} result${visibleTracks.length === 1 ? "" : "s"} found`
            : status.phase === "error"
              ? "Search failed"
              : ""}
      </p>

      <div className="mt-5">
        {status.phase === "idle" && (
          <EmptyState
            headingLevel={2}
            icon={<SearchIcon className="h-20 w-20" />}
            title="Search for a song"
            description="Try an artist, track or album name."
          />
        )}

        {showSkeleton && (
          <div className="flex flex-col gap-1" aria-busy="true" aria-label="Loading results">
            {Array.from({ length: 6 }, (_, i) => (
              <TrackRowSkeleton key={i} />
            ))}
          </div>
        )}

        {status.phase === "error" && (
          <EmptyState
            headingLevel={2}
            icon={<AlertIcon />}
            title="Search failed"
            description={status.message}
            action={
              <button
                type="button"
                onClick={handleRetry}
                className="h-11 rounded-lg bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent-2"
              >
                Try again
              </button>
            }
          />
        )}

        {status.phase === "results" && tracks.length > 0 && (
          <Highlight query={resultQuery}>
            <TrackList tracks={visibleTracks} onPlay={handlePlay} />
          </Highlight>
        )}

        {/* Every row was preview-only and got filtered out: the result set is
            non-empty but nothing is visible, so say so instead of a blank gap
            under the filter chips. */}
        {status.phase === "results" && tracks.length > 0 && visibleTracks.length === 0 && (
          <EmptyState
            headingLevel={2}
            icon={<SearchIcon className="h-20 w-20" />}
            title="No full songs here"
            description="Every match for this search is a 30-second preview. Switch back to All to see them."
            action={
              <button
                type="button"
                onClick={() => setFilter("all")}
                className="h-11 rounded-lg bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent-2"
              >
                Show all results
              </button>
            }
          />
        )}

        {/* A search that returned nothing is a distinct state from "never
            searched", so it gets its own empty message. The query echoed here is
            the one that actually produced the response — `debouncedQuery` can
            already have moved on (or been emptied) by the time the empty result
            lands, which would otherwise name the wrong query or nothing at all. */}
        {status.phase === "results" && tracks.length === 0 && (
          <EmptyState
            headingLevel={2}
            icon={<SearchIcon className="h-20 w-20" />}
            title="No results"
            description={
              resultQuery
                ? `Nothing matched “${resultQuery}”. Try a different song or artist.`
                : "Nothing matched that search. Try a different song or artist."
            }
            action={
              <button
                type="button"
                onClick={handleClear}
                className="h-11 rounded-lg border border-border px-6 text-sm font-semibold text-text transition-colors hover:bg-surface-2"
              >
                Clear search
              </button>
            }
          />
        )}
      </div>
    </section>
  );
}
