"use client";

/**
 * Home page view — composes the trending shelf, recently-played shelf, and the
 * "jump back in" hero, all server-safe but hydrating client hooks.
 *
 * WHY a client view: it reads play history via IndexedDB (getHistoryWithTimestamps)
 * and fires client playback through playerBridge, both of which require the
 * browser. The page itself stays a "use client" boundary; SSR never touches
 * IndexedDB because db.ts only opens it inside a guarded call (see
 * src/lib/client/db.ts).
 *
 * Playback wiring (per plan task 5): tapping a TRENDING card seeds the whole
 * trending list as a queue via requestPlayQueue so NEXT flows through the shelf.
 * History rows and the Jump-back-in card play a single track via requestPlay —
 * the player resolves the ephemeral stream server-side from the track's videoId.
 */
import { useEffect, useRef, useState } from "react";
import type { SearchResponse, Track } from "@/lib/types";
import { getHistoryWithTimestamps } from "@/lib/client/db";
import { requestPlay, requestPlayQueue } from "@/lib/client/playerBridge";
import { usePlayer, LIBRARY_UPDATED_EVENT } from "@/lib/client/PlayerContext";
import { usePageVisible } from "@/hooks/usePageVisible";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import TrackCardRow, {
  type RowState,
  type TrackCardRowItem,
  type TrackWithMeta,
} from "@/components/home/TrackCardRow";
import JumpBackIn from "@/components/home/JumpBackIn";
import DiscoveryWheel from "@/components/home/DiscoveryWheel";

/** Lifecycle of the /api/trending fetch; mirrors the search page's Status union. */
type TrendingState =
  | { phase: "loading" }
  | { phase: "error" }
  | { phase: "ready" };

/**
 * Collapse duplicate track ids in a history list, keeping the MOST RECENT
 * occurrence (F9), and preserving each kept row's play time so cards can show a
 * relative age.
 *
 * WHY at the consumer: recordPlay only skips a write when the LAST history row
 * matches, so A → B → A leaves two rows for A. getHistory returns newest-first,
 * so the first occurrence of each id is the freshest — first pass wins. db.ts is
 * frozen to this workstream (§5), so the dedupe happens where the shelf renders.
 */
interface HistoryEntry {
  track: Track;
  /** Epoch ms of the play, or null when the row carried no usable timestamp. */
  at: number | null;
}

/**
 * Same dedupe, but preserving each kept row's timestamp so the shelf can label
 * how long ago it was played (F9 residual). Newest-first input, so the first
 * occurrence of an id wins — one pass, kept rows and their times never drift.
 */
function dedupeHistoryWithTimestamps(rows: Array<{ track: Track; at: number }>): HistoryEntry[] {
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const row of rows) {
    if (seen.has(row.track.id)) continue;
    seen.add(row.track.id);
    // A malformed/absent tick degrades to null, which suppresses the label.
    const at = typeof row.at === "number" && Number.isFinite(row.at) ? row.at : null;
    out.push({ track: row.track, at });
  }
  return out;
}

/**
 * Short relative label for a play timestamp ("just now", "2 h ago", "3 d ago").
 *
 * WHY Intl.RelativeTimeFormat: it produces correctly localized, compact strings
 * ("2 hr. ago" in en-US numeric:"auto" style) instead of hand-rolled pluralising.
 * Returns null when the timestamp is missing/invalid or in the future beyond a
 * small clock-skew allowance — callers then render the row exactly as before, so
 * a bad tick can only ever cost the label, never the row.
 */
function formatRelativeTime(at: number | null): string | null {
  if (at === null || !Number.isFinite(at)) return null;
  const diffMs = Date.now() - at;
  if (!Number.isFinite(diffMs)) return null;
  const seconds = Math.round(diffMs / 1000);
  // Anything under a minute (including small negative skew) reads as "now".
  if (seconds < 60) return "just now";
  try {
    const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto", style: "short" });
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return rtf.format(-minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (hours < 24) return rtf.format(-hours, "hour");
    const days = Math.round(hours / 24);
    if (days < 7) return rtf.format(-days, "day");
    const weeks = Math.round(days / 7);
    if (days < 30) return rtf.format(-weeks, "week");
    const months = Math.round(days / 30);
    if (days < 365) return rtf.format(-months, "month");
    return rtf.format(-Math.round(days / 365), "year");
  } catch {
    // A runtime without RelativeTimeFormat degrades to no label.
    return null;
  }
}

export default function HomeView() {
  const [trendingState, setTrendingState] = useState<TrendingState>({ phase: "loading" });
  const [trending, setTrending] = useState<Track[]>([]);
  // Recently played, most-recent-first (top item is the "jump back in" target),
  // each row paired with its recorded play time so it can be labeled with a
  // relative age (F9 residual). `at` is null whenever the stored tick is absent
  // or unusable, and that row simply renders without a label.
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  // Bumping this re-fetches trending (retry path for a failed row).
  const [retryKey, setRetryKey] = useState(0);
  // Live abort handle so a stale/mounted-away request can be cancelled.
  const abortRef = useRef<AbortController | null>(null);

  // The currently-playing track drives a "recently played" refresh (defect 9).
  const { currentTrack } = usePlayer();

  /* Fetch the trending shelf once (and again on retry). */
  useEffect(() => {
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;

    // Show skeletons immediately for snappy feedback (same intent as the search
    // page; eslint flags setState-in-effect, so we note WHY it is deliberate).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setTrendingState({ phase: "loading" });

    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/trending", { signal: controller.signal });
        if (cancelled) return;
        const data = (await res.json()) as SearchResponse;
        if (cancelled) return;
        if (data.ok && data.results.length > 0) {
          setTrending(data.results);
          setTrendingState({ phase: "ready" });
        } else {
          // Server typed error OR empty list — both render as a friendly "ready
          // row with nothing" so the shelf never shows a raw crash.
          setTrending([]);
          setTrendingState(data.ok ? { phase: "ready" } : { phase: "error" });
        }
      } catch (err) {
        // An abort is expected when a newer fetch supersedes us — ignore it.
        if (err instanceof DOMException && err.name === "AbortError") return;
        if (cancelled) return;
        setTrending([]);
        setTrendingState({ phase: "error" });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [retryKey]);

  /* Read play history to populate "recently played" + "jump back in".
     Re-fetches when the current track changes (a fresh play has bumped the
     history) AND on a library-updated event broadcast after a recordPlay
     (defect 9). Also still runs on mount (currentTrack is null then). */
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows = await getHistoryWithTimestamps();
        // Dedupe by id, newest first (F9), keeping each row's timestamp so the
        // card can show a relative age — see dedupeHistoryWithTimestamps above.
        if (!cancelled) setHistory(dedupeHistoryWithTimestamps(rows));
      } catch {
        // Both history reads are non-throwing by contract; keep the UI safe anyway.
        if (!cancelled) setHistory([]);
      }
    };
    void load();
    // The player broadcasts this after a play is written to history; refresh
    // even if `currentTrack` didn't change identity (e.g. a replay of the same
    // track, which recordPlay still timestamps).
    window.addEventListener(LIBRARY_UPDATED_EVENT, load);
    return () => {
      cancelled = true;
      window.removeEventListener(LIBRARY_UPDATED_EVENT, load);
    };
  }, [currentTrack]);

  /* Revalidate the shelf when the user comes BACK to the page (F9): a play made
     in another tab, or while this tab was backgrounded, must not leave a stale
     shelf. Two triggers per the spec — the document becoming visible again, and
     the window regaining focus — plus the existing library-updated event. */
  const pageVisible = usePageVisible();
  const lastVisibleRef = useRef(pageVisible);
  useEffect(() => {
    const wasVisible = lastVisibleRef.current;
    lastVisibleRef.current = pageVisible;
    // Only on the hidden → visible transition (not on every render).
    if (!pageVisible || wasVisible) return;
    let cancelled = false;
    getHistoryWithTimestamps()
      .then((rows) => {
        if (!cancelled) setHistory(dedupeHistoryWithTimestamps(rows));
      })
      .catch(() => {
        if (!cancelled) setHistory([]);
      });
    return () => {
      cancelled = true;
    };
  }, [pageVisible]);

  useEffect(() => {
    let cancelled = false;
    const revalidate = async () => {
      try {
        const rows = await getHistoryWithTimestamps();
        if (!cancelled) setHistory(dedupeHistoryWithTimestamps(rows));
      } catch {
        if (!cancelled) setHistory([]);
      }
    };
    const onFocus = () => void revalidate();
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  // Trending taps seed the whole shelf as a queue starting at the clicked card,
  // so NEXT walks the rest of the row (matches the search page's queue seeding).
  const handleTrendingPlay = (track: Track, index: number) => {
    requestPlayQueue(trending, index);
    void track; // index is the queue pointer; track is implied by it
  };

  // History / jump-back-in play a single track via the plain bridge path.
  const handleSinglePlay = (track: Track) => requestPlay(track);

  const trendingRowState: RowState =
    trendingState.phase === "loading"
      ? { phase: "loading" }
      : trendingState.phase === "error"
        ? { phase: "error", message: "Trending unavailable" }
        : trending.length > 0
          ? { phase: "ready" }
          : { phase: "empty" };

  const historyRowState: RowState =
    history.length > 0 ? { phase: "ready" } : { phase: "empty" };

  const historyRows: TrackCardRowItem[] = history.map((entry) => ({
    track: entry.track,
    meta: formatRelativeTime(entry.at),
  }));

  // Most recent play = the first row in the history list; drives Jump back in.
  // The recency caption rides on the same object as the track (TrackWithMeta,
  // declared above) so JumpBackIn/TrackCard can show it without a second prop
  // path, and every other Track field is passed through untouched.
  const jumpRow: TrackCardRowItem | null =
    historyRows.length > 0 ? historyRows[0] : null;
  const mostRecent: TrackWithMeta | null = jumpRow
    ? { ...jumpRow.track, meta: jumpRow.meta }
    : null;

  // §2.3 hero fallback: when there is no history yet, the featured card shows
  // the top trending item instead (data already fetched — no new API call).
  // Neither source having anything leaves the existing "Ready when you are."
  // empty state on screen.
  const heroFallback: TrackWithMeta | null = trending[0] ?? null;

  // Deferred gate (WS6): Trending shows its skeletons only once loading clearly
  // outlives a fast/cached response, and holds them a minimum window when shown.
  // Recently played reads local IndexedDB and resolves in a frame, so it starts
  // as an empty shelf rather than a skeleton — no flash, no false loading.
  const showTrendingSkeleton = useDeferredLoading(trendingState.phase === "loading", {
    delay: 120,
    minDisplay: 350,
  });

  return (
    <>
      <h1 className="text-3xl font-bold text-text sm:text-4xl">Home</h1>
      <p className="mt-1 text-sm text-muted">Trending now and where you left off.</p>

      <div className="mt-6 flex flex-col gap-8">
        {/* Each shelf owns its own state, so a failure in one never blanks the
            page — the failed shelf shows its own retry (WS6). */}
        <TrackCardRow
          heading="Trending"
          ariaLabel="Trending tracks"
          state={trendingRowState}
          rows={trending.map((track) => ({ track }))}
          onPlay={handleTrendingPlay}
          showSkeleton={showTrendingSkeleton}
          onRetry={() => setRetryKey((k) => k + 1)}
          // §2.3: Search is the route that lists more of what trending offers.
          showAllHref="/search"
          showAllLabel="Search for more"
        />

        <TrackCardRow
          heading="Recently played"
          ariaLabel="Recently played tracks"
          state={historyRowState}
          rows={historyRows}
          onPlay={handleSinglePlay}
          // §2.3: the Library history tab is the full-list home for this shelf.
          showAllHref="/library"
          showAllLabel="Show all"
        />

        <JumpBackIn
          mostRecent={mostRecent}
          fallbackTrack={heroFallback}
          onPlay={handleSinglePlay}
        />

        {/* Discovery wheel (§ Phase 5). Pool = recent history + trending, both
            already in memory — the wheel adds no fetch. Deduplication happens
            inside the component, and it plays through the same single-track
            bridge path as the history rows, so it needs no new plumbing. */}
        <DiscoveryWheel
          tracks={[...history.map((h) => h.track), ...trending]}
          onPlay={handleSinglePlay}
        />
      </div>

      {/* Mobile users don't see the desktop sidebar disclaimer, so repeat it
          here (plan task 6) — small and muted so it never competes with content. */}
      <footer className="mt-10 border-t border-border pt-4 text-[11px] leading-relaxed text-muted">
        For personal testing/education only. Sources are public; not affiliated
        with YouTube/Deezer/Saavn.
      </footer>
    </>
  );
}
