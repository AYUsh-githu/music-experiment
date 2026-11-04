"use client";

/**
 * Library page — Favorites / Playlists / History tabs (Phase 3).
 *
 * User-owned library state is persisted client-side in IndexedDB (the db-core
 * agent's layer); this page is a thin read/write view over it. Data is fetched
 * on mount and re-fetched on tab switch so the visible tab is always fresh
 * (and to honor "fetch on tab switch + on mount"). Each tab shows a light
 * Skeleton while its data is loading and an EmptyState when a tab is empty.
 *
 * Playback is delegated to the playerBridge (requestPlayQueue) so this page
 * stays decoupled from the PlayerProvider, matching the search page. Rows are
 * rendered manually (mirroring TrackRow) wherever an action slot is needed — a
 * heart for favorites, a remove button inside playlists — and TrackRow itself is
 * reused for History, which tags each row with a relative play age (F9 residual).
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { SearchResponse, Track } from "@/lib/types";
import {
  getFavorites,
  getHistoryWithTimestamps,
  getPlaylists,
  createPlaylist,
  renamePlaylist,
  deletePlaylist,
  addToPlaylist,
  removeFromPlaylist,
  toggleFavorite,
} from "@/lib/client/db";
import type { Playlist } from "@/lib/client/db";
import TrackRow from "@/components/track/TrackRow";
import TrackContextMenu from "@/components/track/TrackContextMenu";
import { HistoryShelfSkeleton } from "@/components/ui/Skeleton";
import EmptyState, { AlertIcon } from "@/components/ui/EmptyState";
import LibraryBadges from "@/components/library/LibraryBadges";
import Artwork from "@/components/track/Artwork";
import { requestPlayQueue } from "@/lib/client/playerBridge";
import { usePlayer, LIBRARY_UPDATED_EVENT } from "@/lib/client/PlayerContext";
import { useDialog } from "@/lib/client/useDialog";
import { toast } from "@/lib/client/toast";
import { useDeferredLoading } from "@/hooks/useDeferredLoading";
import { useCanHover } from "@/hooks/useCanHover";
import { usePageVisible } from "@/hooks/usePageVisible";
import EqualizerBars from "@/components/ui/EqualizerBars";
import { Play, Heart, Clock, Library } from "@/components/ui/icons";
import { motion } from "framer-motion";
import { revealTransition } from "@/lib/client/motion";
import { cn } from "@/components/track/cn";

const TABS = [
  { id: "favorites", label: "Favorites" },
  { id: "playlists", label: "Playlists" },
  { id: "history", label: "History" },
] as const;

type Tab = (typeof TABS)[number]["id"];

/**
 * Which tab's data failed to load. IndexedDB reads are non-throwing by contract,
 * but a surprise failure must not blank the whole page — the failing section
 * shows its own retry instead (WS6: "one section failing must not blank the
 * page; surface per-section retry").
 */
type SectionError = Partial<Record<Tab, true>>;

/** Seconds -> "m:ss" (273 -> "4:33"). Tolerates missing data. Mirrors TrackRow. */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/**
 * Filled heart for "remove this favorite". Drawn locally rather than reusing
 * ui/icons' Heart: that icon's outline geometry does not fill cleanly, and an
 * outline heart on a "remove" action reads as "not yet favorited".
 */
function FilledHeartIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden>
      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35Z" />
    </svg>
  );
}

/** Removal glyph for "take this track out of the playlist". */
function RemoveIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden>
      <path d="M6 12h12v2H6z" />
    </svg>
  );
}

/** One history row plus the play time it was recorded at (F9 residual). */
interface HistoryEntry {
  track: Track;
  /** Epoch ms of the play, or null when the row carried no usable timestamp. */
  at: number | null;
}

/**
 * Collapse duplicate track ids in a history list, keeping the MOST RECENT
 * occurrence (F9) and preserving each kept row's play time so the History tab
 * can label how long ago a track was played (F9 residual).
 *
 * WHY at the consumer and not in db.ts: recordPlay only skips a write when the
 * LAST history row is the same track, so an A → B → A sequence legitimately
 * leaves two rows for A. The timestamp-preserving read returns them newest-first,
 * so the FIRST occurrence of each id is the most recent one — the first pass
 * through the list wins.
 *
 * The result can never exceed the length of the input list, i.e. the existing
 * shelf length, so deduping never grows the list.
 */
function dedupeHistoryWithTimestamps(rows: Array<{ track: Track; at: number }>): HistoryEntry[] {
  const seen = new Set<string>();
  const out: HistoryEntry[] = [];
  for (const row of rows) {
    if (seen.has(row.track.id)) continue;
    seen.add(row.track.id);
    // A malformed/absent tick degrades to null, which suppresses the label and
    // leaves the row rendering exactly as it did before this upgrade.
    const at = typeof row.at === "number" && Number.isFinite(row.at) ? row.at : null;
    out.push({ track: row.track, at });
  }
  return out;
}

/**
 * Short relative label for a play timestamp ("just now", "2 h ago", "3 d ago").
 *
 * WHY Intl.RelativeTimeFormat: it yields correctly localized compact strings
 * without hand-rolled pluralising. Returns null for a missing/invalid timestamp
 * (or an environment without the API), and callers then render the row with no
 * label — an unusable tick can only cost the label, never the row.
 */
function formatRelativeTime(at: number | null): string | null {
  if (at === null || !Number.isFinite(at)) return null;
  const diffMs = Date.now() - at;
  if (!Number.isFinite(diffMs)) return null;
  const seconds = Math.round(diffMs / 1000);
  // Anything under a minute (including small negative clock skew) reads as "now".
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
    // No RelativeTimeFormat -> degrade to no label rather than a raw timestamp.
    return null;
  }
}

/** Compact list of real-size skeleton rows shown while IndexedDB answers. */
function ListSkeleton() {
  return <HistoryShelfSkeleton rows={3} />;
}

/**
 * Per-section load failure: the section that failed shows its own message and
 * retry button while the rest of the page stays intact.
 *
 * The retry reports progress through `aria-busy` on the button (there is no
 * per-section skeleton once the section has data), so a slow re-read is not a
 * dead tap.
 */
function SectionErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <EmptyState
      headingLevel={2}
      icon={<AlertIcon />}
      title="Couldn’t load this section"
      description="Your library data is still safe — this read just failed."
      action={
        <button
          type="button"
          onClick={onRetry}
          className="h-11 rounded-lg bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent-2 active:scale-[0.98]"
        >
          Try again
        </button>
      }
    />
  );
}

/**
 * One playable row with an injected trailing action (heart / remove). Used where
 * TrackList's plain contract doesn't fit because we need an action button.
 * Mirror of TrackRow: whole row plays, explicit button is the focusable control.
 * `icon` is an explicit discriminator rather than inferred from the label, so
 * the rendered glyph can never drift from the caller's intent.
 *
 * Active-track indicator (F7): matches TrackRow — the index becomes
 * EqualizerBars (the WS0 canonical indicator) driven by the player's `playing`
 * state, the title turns accent, aria-current="true" marks the row, and the
 * index/bars slot keeps a FIXED width so swapping number for bars is CLS-free.
 * F3: the trailing action button is capability-gated (useCanHover) so it stays
 * visible on large touch screens instead of being hidden by a width breakpoint.
 * WS2: 0.98 press-scale and a long-press / right-click track menu.
 *
 * `meta` (F9 residual) is an optional relative-age caption ("2 h ago") rendered
 * beside the duration. It is omitted entirely when the timestamp is missing, so
 * a row with no usable tick is byte-identical to its pre-upgrade markup.
 */
function ActionRow({
  track,
  index,
  onPlay,
  actionLabel,
  icon,
  onAction,
  meta,
}: {
  track: Track;
  index: number;
  onPlay: (track: Track, index: number) => void;
  actionLabel: string;
  /** Which glyph to draw: a filled heart (remove favorite) or a minus (remove track). */
  icon: "heart" | "remove";
  onAction: (track: Track) => void;
  /** Optional relative recency label ("2 h ago"). Null/absent renders nothing. */
  meta?: string | null;
}) {
  const { currentTrack, playing, togglePlay } = usePlayer();
  const isCurrent = currentTrack?.id === track.id;
  const isPlayingCurrent = isCurrent && playing;
  const canHover = useCanHover();
  // Long-press / right-click surface for the shared track menu (F8).
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  function triggerPlay() {
    // Tapping the current row toggles play/pause; anything else starts it.
    if (isCurrent) togglePlay();
    else onPlay(track, index);
  }

  return (
    <div
      ref={surfaceRef}
      onClick={triggerPlay}
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        "group flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-2 py-1.5",
        "transition-[background-color,transform] duration-[var(--dur-micro)] active:scale-[0.98]",
        // A white wash (not flat bg-surface-2) so the hover state reads over any
        // artwork-neutral surface — matches TrackRow exactly.
        "hover:bg-white/[0.06]",
      )}
    >
      {/* Index / now-playing equalizer. Fixed width — no layout shift (F7). */}
      <div className="w-6 shrink-0 text-center">
        {isCurrent ? (
          <EqualizerBars className="inline-flex h-4 w-4" playing={isPlayingCurrent} />
        ) : (
          <span className="text-xs tabular-nums text-muted">{index + 1}</span>
        )}
      </div>

      <Artwork track={track} />
      <div className="min-w-0 flex-1">
        <p
          className={cn("truncate text-sm font-medium transition-colors", {
            "text-accent": isCurrent,
            "text-text": !isCurrent,
          })}
          title={track.title}
        >
          {track.title}
        </p>
        <p className="truncate text-xs text-muted" title={track.artist}>
          {track.artist}
        </p>
      </div>
      <span className="shrink-0 text-xs tabular-nums text-muted">
        {formatDuration(track.duration)}
      </span>

      {/* Relative recency (F9 residual): a small static label between the
          duration and the actions, rendered only when a valid timestamp exists
          so a history row without one keeps its original layout exactly. */}
      {meta && (
        <span className="shrink-0 text-[11px] text-muted/80" title={meta}>
          {meta}
        </span>
      )}

      {/* "…" menu (F3/F8): gated on pointer capability, with the row itself as
          the long-press / right-click surface. */}
      <TrackContextMenu
        track={track}
        label={`More options for ${track.title}`}
        pressSurfaceRef={surfaceRef}
        triggerClassName={cn({
          "opacity-100": !canHover,
          "opacity-0 group-hover:opacity-100 focus-visible:opacity-100": canHover,
        })}
      />

      <button
        type="button"
        aria-label={actionLabel}
        onClick={(e) => {
          // Row click plays; the button must not double-play, so stop the bubble.
          e.stopPropagation();
          onAction(track);
        }}
        className={cn(
          // 44px hit area (rule 3) even though the glyph is 20px.
          "grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted",
          "transition-[color,background-color,opacity] duration-[var(--dur-micro)]",
          "hover:bg-surface hover:text-accent focus-visible:text-accent",
          // Capability gate (F3): always reachable when hover is unavailable.
          {
            "opacity-100": !canHover,
            "opacity-0 group-hover:opacity-100 focus-visible:opacity-100": canHover,
          },
        )}
      >
        {icon === "heart" ? <FilledHeartIcon /> : <RemoveIcon />}
      </button>
    </div>
  );
}

/**
 * One cell of the collage. A raw <img> here (the Artwork component is sized for
 * a square tile, not a grid cell), so the failure path is owned locally: an
 * artwork URL that 404s would otherwise draw the browser's broken-image glyph
 * inside the cover. On error the cell degrades to the track's initial on the
 * surface tile — the collage keeps its grid and never shows a broken icon.
 */
function MosaicCell({ track, className }: { track: Track; className?: string }) {
  const [failed, setFailed] = useState(false);
  const initial = (track.title.trim().charAt(0) || "♪").toUpperCase();

  return (
    <span className={cn("relative block overflow-hidden bg-surface-2", className)}>
      {failed || !track.artwork ? (
        <span className="grid h-full w-full place-items-center text-xs font-bold text-muted">
          {initial}
        </span>
      ) : (
        // eslint-disable-next-line @next/next/no-img-element -- tiny collage thumbs; plain img matches the Artwork component's plain-img policy.
        <img
          src={track.artwork}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="h-full w-full object-cover"
        />
      )}
    </span>
  );
}

/**
 * §4.1 playlist cover mosaic: a 2×2 collage of the first 4 track artworks,
 * built client-side purely from data already loaded from IndexedDB (no API).
 * Fewer than 2 artworks falls back to a two-color gradient cover with the
 * playlist's initial (Deezer-style), because a 1-up crop of a single artwork
 * would read as a broken grid while 2 can form a real (asymmetric) collage.
 * Fixed aspect square via `aspect-square` — never animated dimensions.
 */
function PlaylistMosaic({ tracks, name }: { tracks: Track[]; name: string }) {
  const shown = tracks.slice(0, 4);
  if (shown.length < 2) {
    const initial = (name.trim().charAt(0) || "♪").toUpperCase();
    return (
      <div
        aria-hidden
        className="grid aspect-square w-full place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-2xl font-bold text-white"
      >
        {initial}
      </div>
    );
  }
  return (
    <div
      aria-hidden
      className="grid aspect-square w-full grid-cols-2 grid-rows-2 gap-[2px] overflow-hidden rounded-lg bg-surface-2"
    >
      {shown.map((track, i) => (
        // 2 covers: first spans the left column. 3 covers: prescribed cells —
        // (0) left-top 1x1, (1) right-top 1x1, (2) spans the full bottom row
        // via col-span-2. 4 covers: plain 2×2.
        <MosaicCell
          key={track.id}
          track={track}
          className={cn(
            shown.length === 2 && i === 0 && "row-span-2",
            shown.length === 3 && i === 2 && "col-span-2",
          )}
        />
      ))}
    </div>
  );
}

/**
 * §4.1 playlist card — B's TrackCard primitives pattern re-hosted HERE (this
 * file owns it; TrackCard itself is untouched). Card: mosaic cover, name +
 * track count, lift -4px + shadow grow on hover (opacity-animated shadow
 * LAYER — never animating box-shadow), a hover-revealed play FAB
 * (capability-gated via useCanHover, whole-card tap as the touch path), and a
 * 0.97 press scale. Whole card toggles expansion (same as the old header
 * button); keyboard users get a real <button>. The appear/expanded chevron is
 * replaced by rotate-90 on the ChevronRight-style glyph — rotation is a
 * transform, so it stays inside the motion rules.
 *
 * Expansion behavior, row rendering and per-playlist actions all stay in the
 * existing code below — this card is only the collapsed header surface.
 */
function PlaylistCard({
  playlist,
  open,
  onToggle,
  index,
  canHover,
}: {
  playlist: Playlist;
  open: boolean;
  onToggle: () => void;
  index: number;
  canHover: boolean;
}) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={revealTransition(index)}
      className="group relative min-w-0"
      // The grid is a list (see the caller); this is its item. The expanded
      // state itself belongs to the inner <button>, which is the interactive
      // element — aria-expanded on a non-interactive wrapper is not exposed.
      role="listitem"
    >
      {/* Lift shadow: pre-rendered layer, opacity-only on hover (§4). */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute -inset-0.5 -z-10 rounded-xl opacity-0 shadow-xl shadow-black/50",
          "transition-opacity duration-[var(--dur-standard)] ease-out",
          canHover && "group-hover:opacity-100",
        )}
      />
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        aria-label={`${open ? "Collapse" : "Expand"} playlist ${playlist.name} (${playlist.tracks.length} tracks)`}
        className={cn(
          "block w-full rounded-xl border border-border bg-surface p-3 text-left",
          "transition-transform duration-[var(--dur-standard)] ease-out",
          "active:scale-[0.97] focus-visible:outline-none",
          canHover && "group-hover:-translate-y-1",
        )}
      >
        <div className="relative">
          <PlaylistMosaic tracks={playlist.tracks} name={playlist.name} />
          {/* Hover play FAB: scales in (§1.5 primitive); on touch (no hover)
              it is hidden — whole-card tap still expands, and the Play button
              inside the expanded panel is always visible, so play remains
              reachable without hover. */}
          {canHover && (
            <span
              aria-hidden
              className={cn(
                "pointer-events-none absolute bottom-2 right-2 grid h-10 w-10 place-items-center rounded-full bg-accent text-white shadow-lg",
                "scale-75 opacity-0 transition-[opacity,transform] duration-[var(--dur-standard)] ease-out",
                "group-hover:scale-100 group-hover:opacity-100",
              )}
            >
              <Play className="ml-0.5 h-4 w-4" />
            </span>
          )}
        </div>
        <span className="mt-2 block truncate text-sm font-semibold text-text" title={playlist.name}>
          {playlist.name}
        </span>
        <span className="block text-xs text-muted">
          {playlist.tracks.length} track{playlist.tracks.length === 1 ? "" : "s"}
        </span>
      </button>
    </motion.div>
  );
}

export default function LibraryPage() {
  const [tab, setTab] = useState<Tab>("favorites");
  // Capability gate (§4.1 hover primitives): hoisted once here so the playlist
  // grid consumes it without a hook per card.
  const canHover = useCanHover();

  // Accessible Promise-based dialogs replace the native prompt/confirm (defect 8).
  const dialog = useDialog();

  // Each tab's data. `null` = not yet loaded (show skeleton).
  const [favorites, setFavorites] = useState<Track[] | null>(null);
  const [playlists, setPlaylists] = useState<Playlist[] | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);

  // Which playlist is expanded to show its tracks + "add song" mini-flow.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Per-section failures (WS6). A failed read no longer blanks the page.
  const [errors, setErrors] = useState<SectionError>({});

  // "Add song" mini-flow: inline search + picked results for the expanded playlist.
  const [addQuery, setAddQuery] = useState("");
  const [addStatus, setAddStatus] = useState<"idle" | "loading" | "error">("idle");
  const [addResults, setAddResults] = useState<Track[]>([]);
  const [addError, setAddError] = useState("");
  // True once the user has run an add-search. Distinguishes "never searched"
  // (idle, nothing to show) from "searched and found nothing" (show an empty
  // message) — otherwise a zero-result search would render as if untouched.
  const [addTouched, setAddTouched] = useState(false);

  const loadFavorites = useCallback(async () => {
    try {
      setFavorites(await getFavorites());
      setErrors((e) => ({ ...e, favorites: undefined }));
    } catch {
      // A failed read surfaces as a per-section retry, never a blank page.
      setFavorites([]);
      setErrors((e) => ({ ...e, favorites: true }));
    }
  }, []);
  const loadPlaylists = useCallback(async () => {
    try {
      setPlaylists(await getPlaylists());
      setErrors((e) => ({ ...e, playlists: undefined }));
    } catch {
      setPlaylists([]);
      setErrors((e) => ({ ...e, playlists: true }));
    }
  }, []);
  const loadHistory = useCallback(async () => {
    try {
      // Timestamp-preserving read (F9 residual): identical rows to getHistory(),
      // plus the stored play tick the relative label needs.
      setHistory(dedupeHistoryWithTimestamps(await getHistoryWithTimestamps()));
      setErrors((e) => ({ ...e, history: undefined }));
    } catch {
      setHistory([]);
      setErrors((e) => ({ ...e, history: true }));
    }
  }, []);

  // Fetch all three on mount so any tab switch resolves instantly. The reads are
  // independent — each resolves (or fails) on its own, so one failing section
  // never blocks the others. The cancelled flag drops results if the page
  // unmounts mid-read.
  useEffect(() => {
    let cancelled = false;
    getFavorites()
      .then((t) => {
        if (!cancelled) setFavorites(t);
      })
      .catch(() => {
        if (!cancelled) {
          setFavorites([]);
          setErrors((e) => ({ ...e, favorites: true }));
        }
      });
    getPlaylists()
      .then((p) => {
        if (!cancelled) setPlaylists(p);
      })
      .catch(() => {
        if (!cancelled) {
          setPlaylists([]);
          setErrors((e) => ({ ...e, playlists: true }));
        }
      });
    getHistoryWithTimestamps()
      .then((h) => {
        // Dedupe here too (F9): the mount path bypasses loadHistory. The
        // timestamps are kept so the History tab can show a relative age.
        if (!cancelled) setHistory(dedupeHistoryWithTimestamps(h));
      })
      .catch(() => {
        if (!cancelled) {
          setHistory([]);
          setErrors((e) => ({ ...e, history: true }));
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  /**
   * History revalidation (F9). The shelf used to go stale: a play recorded on a
   * different route (or in another tab) did not refresh this one. Re-read on
   * (a) the tab becoming visible again, (b) the window regaining focus, and
   * (c) the player's LIBRARY_UPDATED_EVENT (fired right after a play is written
   * to history). Only the History tab's data is refreshed — the other tabs are
   * unaffected by a play.
   *
   * WHY a playing guard: re-reading while the History tab is open but the page
   * is hidden would be wasted work; the visibility signal covers the return.
   */
  const pageVisible = usePageVisible();
  const lastVisibleRef = useRef(pageVisible);
  useEffect(() => {
    const wasVisible = lastVisibleRef.current;
    lastVisibleRef.current = pageVisible;
    // Only revalidate on the hidden → visible transition.
    if (pageVisible && !wasVisible) void loadHistory();
  }, [pageVisible, loadHistory]);

  useEffect(() => {
    // Revalidate EVERY tab's data, not just history. All three stores live in
    // IndexedDB and can be changed from elsewhere: another route (favoriting a
    // row, creating a playlist), another browser tab, or the player writing a
    // play. Refreshing only history left the Favorites and Playlists tabs
    // silently stale until an explicit tab switch.
    const revalidate = () => {
      void loadFavorites();
      void loadPlaylists();
      void loadHistory();
    };
    // `storage` only fires for OTHER tabs (localStorage/IndexedDB-adjacent
    // mutations make it fire without a matching key), so this is the cross-tab
    // signal; `focus`/visibility handle the same-tab return; LIBRARY_UPDATED_EVENT
    // is the in-app publish from the player.
    const onStorage = (e: StorageEvent) => {
      // e.key === null means clear(), which also invalidates our view.
      if (e.key !== null && !e.key.startsWith("sonic.")) return;
      revalidate();
    };
    window.addEventListener("focus", revalidate);
    window.addEventListener(LIBRARY_UPDATED_EVENT, revalidate);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener("focus", revalidate);
      window.removeEventListener(LIBRARY_UPDATED_EVENT, revalidate);
      window.removeEventListener("storage", onStorage);
    };
  }, [loadFavorites, loadPlaylists, loadHistory]);

  // On tab switch, re-fetch that tab's data so it reflects the latest state.
  const handleTabChange = useCallback(
    (next: Tab) => {
      setTab(next);
      if (next === "favorites") void loadFavorites();
      if (next === "playlists") void loadPlaylists();
      if (next === "history") void loadHistory();
    },
    [loadFavorites, loadPlaylists, loadHistory]
  );

  /* ----------------------------- Favorites ----------------------------- */

  const handleToggleFavorite = useCallback(
    async (track: Track) => {
      try {
        await toggleFavorite(track);
      } catch (err) {
        // A failed write must say so: otherwise the heart looks like it worked
        // until the very next reload silently brings the track back.
        console.warn("[library] favorite toggle failed:", err);
        toast.error("Couldn't update favorites. Please try again.");
        return;
      }
      await loadFavorites();
    },
    [loadFavorites]
  );

  /* ----------------------------- Playlists ----------------------------- */

  /**
   * Synchronous in-flight latch for every playlist mutation.
   *
   * WHY a ref and not a state flag: `await dialog.prompt(...)` yields between
   * the click and the write, so a fast double-click (or Enter + click) can open
   * TWO dialogs for the same intent, and the second Enter fires the mutation a
   * second time — creating a duplicate playlist or double-deleting. A ref flips
   * synchronously on the first call, so every later call in that window is
   * dropped before it can open anything. The `mutating` state is the visible
   * half (disabled + aria-busy on the controls), updated a render later.
   */
  const mutatingRef = useRef(false);
  const [mutating, setMutating] = useState(false);

  /** Run `work` behind the latch; a call while busy is a no-op. */
  const exclusive = useCallback((work: () => Promise<void>) => {
    if (mutatingRef.current) return;
    mutatingRef.current = true;
    setMutating(true);
    void (async () => {
      try {
        await work();
      } catch (err) {
        // The db layer is non-throwing by contract, but a surprise failure must
        // surface as a message rather than a silently dead button.
        console.warn("[library] mutation failed:", err);
        toast.error("That didn't work. Please try again.");
      } finally {
        mutatingRef.current = false;
        setMutating(false);
      }
    })();
  }, []);

  const handleCreatePlaylist = useCallback(() => {
    exclusive(async () => {
      const name = await dialog.prompt({
        title: "New playlist",
        label: "Playlist name",
        placeholder: "My playlist",
        confirmLabel: "Create",
      });
      const trimmed = name?.trim();
      if (!trimmed) return;
      await createPlaylist(trimmed);
      await loadPlaylists();
      toast.success(`Playlist “${trimmed}” created`);
    });
  }, [exclusive, loadPlaylists, dialog]);

  const handleRenamePlaylist = useCallback(
    (playlist: Playlist) => {
      exclusive(async () => {
        const name = await dialog.prompt({
          title: "Rename playlist",
          label: `Name for “${playlist.name}”`,
          initialValue: playlist.name,
          confirmLabel: "Rename",
        });
        const trimmed = name?.trim();
        // Nothing to do when the dialog was cancelled, the submitted value was
        // blank (the dialog already blocks that), or the name is unchanged.
        if (!trimmed || trimmed === playlist.name) return;
        await renamePlaylist(playlist.id, trimmed);
        await loadPlaylists();
        toast.success("Playlist renamed");
      });
    },
    [exclusive, loadPlaylists, dialog]
  );

  const handleDeletePlaylist = useCallback(
    (playlist: Playlist) => {
      exclusive(async () => {
        const ok = await dialog.confirm({
          title: "Delete playlist",
          message: `Delete “${playlist.name}”? This cannot be undone.`,
          confirmLabel: "Delete",
          danger: true,
        });
        if (!ok) return;
        await deletePlaylist(playlist.id);
        // Collapse the panel the deleted playlist owned, so the page does not
        // keep rendering an expanded shell for an id that no longer exists.
        setExpandedId((prev) => (prev === playlist.id ? null : prev));
        await loadPlaylists();
        toast.success(`Playlist “${playlist.name}” deleted`);
      });
    },
    [exclusive, loadPlaylists, dialog]
  );

  const handleRemoveFromPlaylist = useCallback(
    async (playlistId: string, track: Track) => {
      try {
        await removeFromPlaylist(playlistId, track.id);
      } catch (err) {
        // Same reasoning as the favorite toggle: an un-announced failure leaves
        // a row that reappears on the next read.
        console.warn("[library] remove from playlist failed:", err);
        toast.error("Couldn't remove that song. Please try again.");
        return;
      }
      await loadPlaylists();
    },
    [loadPlaylists]
  );

  const handleAddToPlaylist = useCallback(
    async (playlistId: string, track: Track) => {
      try {
        await addToPlaylist(playlistId, track);
      } catch (err) {
        console.warn("[library] add to playlist failed:", err);
        toast.error("Couldn't add that song. Please try again.");
        return;
      }
      toast.success(`Added to playlist`);
      void loadPlaylists();
    },
    [loadPlaylists]
  );

  /* ------------------------- "Add song" search ------------------------- */

  // Abort any in-flight add-song request when we re-enter or change tab so stale
  // results never overwrite fresh ones (same guard as the search page).
  const addAbortRef = useRef<AbortController | null>(null);

  /**
   * Run the add-song search for the current field value. Kept separate from the
   * form handler so the inline Retry button can re-run the SAME query without
   * synthesising a submit event.
   */
  const runAddSearch = useCallback(async () => {
    const q = addQuery.trim();
    if (!q) return;
    addAbortRef.current?.abort();
    const controller = new AbortController();
    addAbortRef.current = controller;
    setAddStatus("loading");
    // Mark that a search was submitted so a zero-result response can render
    // its own "nothing found" empty message (see render below).
    setAddTouched(true);
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&limit=6`, {
        signal: controller.signal,
      });
      // A gateway error page has no JSON envelope — survive it like a failure.
      const data = (await res.json().catch(() => null)) as SearchResponse | null;
      // A newer search may have superseded us while this one was parsing.
      if (controller.signal.aborted) return;
      if (data && data.ok) {
        setAddResults(data.results);
        setAddStatus("idle");
        setAddError("");
      } else {
        setAddResults([]);
        setAddStatus("error");
        setAddError(
          data && !data.ok ? data.message : "Couldn't search. Please try again.",
        );
      }
    } catch (err) {
      // Expected when a newer search supersedes us; ignore.
      if (err instanceof DOMException && err.name === "AbortError") return;
      setAddResults([]);
      setAddStatus("error");
      setAddError("Couldn't search. Please try again.");
    }
  }, [addQuery]);

  const handleAddSearch = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      void runAddSearch();
    },
    [runAddSearch],
  );

  const handleExpand = useCallback((id: string) => {
    // Re-expanding an already-open playlist collapses it; opening another resets
    // the mini-flow state so results are never shown against the wrong playlist.
    setExpandedId((prev) => (prev === id ? null : id));
    // Cancel any in-flight add-search too, so its results cannot land against a
    // playlist the user has since collapsed (the guard the search page uses).
    addAbortRef.current?.abort();
    setAddQuery("");
    setAddResults([]);
    setAddStatus("idle");
    setAddError("");
    setAddTouched(false);
  }, []);

  /* ----------------------------- Render ------------------------------- */

  // Deferred gates (WS6): each tab shows its skeleton only once loading clearly
  // outlives a fast/cached read, and holds it for a minimum window when shown.
  const showFavSkeleton = useDeferredLoading(favorites === null, {
    delay: 120,
    minDisplay: 350,
  });
  const showPlaylistSkeleton = useDeferredLoading(playlists === null, {
    delay: 120,
    minDisplay: 350,
  });
  const showHistorySkeleton = useDeferredLoading(history === null, {
    delay: 120,
    minDisplay: 350,
  });

  // History rows for the History tab (F9 residual): cleaned, offset-stable, and
  // carrying BOTH the track list (seeds the play queue) and the per-row relative
  // label. Memoized above the return (hooks cannot run after the early branches
  // below); the empty-array fallback is itself memoized so the two derived memos
  // keep a stable dependency across renders of an as-yet-unloaded tab.
  const noHistory = useMemo<HistoryEntry[]>(() => [], []);
  const historyRows = useMemo(() => history ?? noHistory, [history, noHistory]);
  const historyTracks = useMemo(() => historyRows.map((entry) => entry.track), [historyRows]);
  const historyMetas = useMemo(
    () => historyRows.map((entry) => formatRelativeTime(entry.at)),
    [historyRows]
  );

  return (
    <section className="mx-auto max-w-5xl">
      {/* Shared page header scale with Search and Settings (and Home). */}
      <h1 className="text-3xl font-bold tracking-tight text-text sm:text-4xl">Library</h1>
      <p className="mt-1 text-sm text-muted">
        Your favorites, playlists and play history.
      </p>

      {/* Milestone chips (§ Phase 5). Derived from the same IndexedDB data the
          tabs below read, so they can never disagree with the lists on screen,
          and they need no storage of their own. */}
      <LibraryBadges />

      {/* Tab bar — active tab underline in accent-2, horizontal-scroll on tiny widths. */}
      <nav
        aria-label="Library sections"
        className="mt-4 flex gap-1 overflow-x-auto border-b border-border"
      >
        {TABS.map((t) => {
          const active = tab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => handleTabChange(t.id)}
              aria-current={active ? "page" : undefined}
              className={cn(
                "h-11 shrink-0 border-b-2 px-4 text-sm font-medium transition-colors duration-[var(--dur-micro)]",
                "focus-visible:outline-none",
                {
                  "border-accent-2 text-text": active,
                  "border-transparent text-muted hover:text-text": !active,
                },
              )}
            >
              {t.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-6">
        {/* ---------- Favorites ---------- */}
        {tab === "favorites" &&
          (errors.favorites ? (
            <SectionErrorState onRetry={() => void loadFavorites()} />
          ) : showFavSkeleton ? (
            <ListSkeleton />
          ) : favorites !== null && favorites.length === 0 ? (
            <EmptyState
              headingLevel={2}
              icon={<Heart />}
              title="Nothing favorited yet"
              description="Heart a song from search to keep it here."
              action={
                <Link
                  href="/search"
                  className="inline-flex h-11 items-center rounded-lg bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent-2"
                >
                  Find songs
                </Link>
              }
            />
          ) : (
            <ul className="flex flex-col gap-1" aria-label="Favorite tracks">
              {(favorites ?? []).map((track, index) => (
                <li key={track.id}>
                  <ActionRow
                    track={track}
                    index={index}
                    onPlay={(t, i) => requestPlayQueue(favorites ?? [], i)}
                    actionLabel={`Remove ${track.title} from favorites`}
                    icon="heart"
                    onAction={handleToggleFavorite}
                  />
                </li>
              ))}
            </ul>
          ))}

        {/* ---------- Playlists ---------- */}
        {tab === "playlists" &&
          (errors.playlists ? (
            <SectionErrorState onRetry={() => void loadPlaylists()} />
          ) : showPlaylistSkeleton ? (
            <ListSkeleton />
          ) : playlists !== null ? (
            <div className="space-y-3">
              <button
                type="button"
                onClick={handleCreatePlaylist}
                disabled={mutating}
                aria-busy={mutating}
                className="h-11 rounded-lg bg-accent px-4 text-sm font-semibold text-white transition-colors hover:bg-accent-2 active:scale-[0.98] disabled:opacity-40 disabled:hover:bg-accent"
              >
                + New playlist
              </button>

              {playlists.length === 0 ? (
                <EmptyState
                  headingLevel={2}
                  icon={<Library />}
                  title="No playlists yet"
                  description="Create one to organize your songs."
                  action={
                    <button
                      type="button"
                      onClick={handleCreatePlaylist}
                      className="h-11 rounded-lg border border-border px-6 text-sm font-semibold text-text transition-colors hover:bg-surface-2"
                    >
                      New playlist
                    </button>
                  }
                />
              ) : (
                /* §4.1: responsive auto-fill card grid for the COLLAPSED
                   playlists; the expanded playlist's panel renders full-width
                   beneath the grid so long track lists keep the rows' width. */
                <>
                  {playlists.some((p) => p.id !== expandedId) && (
                    <div
                      className="grid grid-cols-[repeat(auto-fill,minmax(160px,1fr))] gap-3"
                      // A grid of cards is a list: role="list" makes the
                      // accessible name meaningful and gives the items a grouping
                      // (a plain <div> with aria-label exposes neither).
                      role="list"
                      aria-label="Playlists"
                    >
                      {playlists.map((playlist, index) => {
                        if (playlist.id === expandedId) return null;
                        return (
                          <PlaylistCard
                            key={playlist.id}
                            playlist={playlist}
                            open={false}
                            index={index}
                            onToggle={() => handleExpand(playlist.id)}
                            canHover={canHover}
                          />
                        );
                      })}
                    </div>
                  )}
                </>
              )}

              {/* Expanded playlist panel (unchanged behavior/styling aside from
                  the header row it replaces) — rendered outside the grid. */}
              {playlists.map((playlist) => {
                if (playlist.id !== expandedId) return null;
                const open = true;
                return (
                    <div
                      key={playlist.id}
                      className="overflow-hidden rounded-xl border border-border bg-surface"
                    >
                      {/* Expanded header: name + collapse affordance. The old ▸
                          glyph rotated on open, which is lost here in favor of a
                          labeled "Collapse" button (clearer for a11y; rotation
                          was decorative only). Buttons stop propagation. */}
                      <div className="flex w-full items-center gap-3 px-4 py-3">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-text" title={playlist.name}>
                            {playlist.name}
                          </span>
                          <span className="block text-xs text-muted">
                            {playlist.tracks.length} track{playlist.tracks.length === 1 ? "" : "s"}
                          </span>
                        </span>
                        <button
                          type="button"
                          onClick={() => handleExpand(playlist.id)}
                          aria-expanded="true"
                          aria-label={`Collapse playlist ${playlist.name}`}
                          className="h-11 shrink-0 rounded-lg border border-border px-3 text-xs font-semibold text-muted transition-colors hover:text-text active:scale-[0.97]"
                        >
                          Collapse
                        </button>
                      </div>

                      {open && (
                        <div className="border-t border-border px-4 py-3">
                          {/* Per-playlist actions — separate buttons so they don't toggle expansion.
                              Rename/Delete share the page's mutation latch, so a double-click can
                              never open two dialogs (and therefore never double-write). */}
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => requestPlayQueue(playlist.tracks, 0)}
                              disabled={playlist.tracks.length === 0}
                              aria-label={`Play ${playlist.name}`}
                              className="inline-flex h-11 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-white transition-colors hover:bg-accent-2 active:scale-[0.98] disabled:opacity-40 disabled:hover:bg-accent"
                            >
                              <Play className="h-3.5 w-3.5" aria-hidden />
                              Play
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRenamePlaylist(playlist)}
                              disabled={mutating}
                              className="h-11 rounded-lg border border-border px-3 text-xs font-semibold text-text transition-colors hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent"
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeletePlaylist(playlist)}
                              disabled={mutating}
                              className="h-11 rounded-lg border border-border px-3 text-xs font-semibold text-danger transition-colors hover:bg-surface-2 disabled:opacity-40 disabled:hover:bg-transparent"
                            >
                              Delete
                            </button>
                          </div>

                          {/* "Add song" mini-flow */}
                          <form onSubmit={handleAddSearch} className="mt-4">
                            <label
                              htmlFor={`add-${playlist.id}`}
                              className="text-xs font-medium text-muted"
                            >
                              Add a song from search
                            </label>
                            <div className="mt-1 flex gap-2">
                              <input
                                id={`add-${playlist.id}`}
                                type="search"
                                autoComplete="off"
                                placeholder="Search a song…"
                                value={addQuery}
                                onChange={(e) => setAddQuery(e.target.value)}
                                className="h-11 min-w-0 flex-1 rounded-lg border border-border bg-surface px-3 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
                              />
                              <button
                                type="submit"
                                disabled={!addQuery.trim() || addStatus === "loading"}
                                aria-label="Search songs to add"
                                className="h-11 w-11 shrink-0 rounded-lg border border-border text-sm font-semibold text-text transition-colors hover:bg-surface-2 disabled:opacity-40 sm:w-auto sm:px-4"
                              >
                                {/* Narrow screens keep the 44px square and show the
                                    in-flight/undo state as a glyph; wide screens carry
                                    the word. Never a spinner-only dead end. */}
                                <span className="sm:hidden" aria-hidden>
                                  {addStatus === "loading" ? "…" : "⌕"}
                                </span>
                                <span className="hidden sm:inline">
                                  {addStatus === "loading" ? "Searching…" : "Search"}
                                </span>
                              </button>
                            </div>
                          </form>

                          {/* Add-search failure: an error is a distinct, actionable
                              state, so it gets a real retry path — the failed query
                              stays in the field, so one tap retries exactly it. */}
                          {addStatus === "error" && (
                            <div className="mt-2 flex items-center gap-2">
                              <p className="min-w-0 flex-1 text-xs text-danger">{addError}</p>
                              <button
                                type="button"
                                onClick={() => void runAddSearch()}
                                disabled={!addQuery.trim()}
                                className="h-11 shrink-0 rounded-lg border border-border px-3 text-xs font-semibold text-text transition-colors hover:bg-surface-2 disabled:opacity-40"
                              >
                                Retry
                              </button>
                            </div>
                          )}

                          {/* Zero-result add-search: without this, a search that
                              finds nothing would render as an untouched form (no
                              loading/error/results), leaving the user guessing. */}
                          {addTouched &&
                            addStatus === "idle" &&
                            addResults.length === 0 &&
                            addQuery.trim() !== "" && (
                              <p className="mt-2 text-xs text-muted">
                                No songs found for that search.
                              </p>
                            )}

                          {addStatus !== "loading" && addResults.length > 0 && (
                            <ul className="mt-3 flex flex-col gap-1" aria-label="Search results to add">
                              {addResults.map((track) => (
                                <li key={track.id}>
                                  <div className="group flex min-h-12 items-center gap-3 rounded-lg px-2 py-1.5 hover:bg-surface-2">
                                    <Artwork track={track} size="w-10 h-10" />
                                    <div className="min-w-0 flex-1">
                                      <p className="truncate text-sm font-medium text-text" title={track.title}>
                                        {track.title}
                                      </p>
                                      <p className="truncate text-xs text-muted" title={track.artist}>
                                        {track.artist}
                                      </p>
                                    </div>
                                    <button
                                      type="button"
                                      onClick={() => handleAddToPlaylist(playlist.id, track)}
                                      className="h-11 shrink-0 rounded-lg bg-accent px-4 text-xs font-semibold text-white transition-colors hover:bg-accent-2"
                                    >
                                      Add
                                    </button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          )}

                          {/* Playlist's tracks (empty vs populated) */}
                          {playlist.tracks.length === 0 ? (
                            <p className="mt-3 rounded-lg border border-dashed border-border px-3 py-6 text-center text-sm text-muted">
                              This playlist is empty. Add a song above.
                            </p>
                          ) : (
                            <ul className="mt-3 flex flex-col gap-1" aria-label={`Tracks in ${playlist.name}`}>
                              {playlist.tracks.map((track, index) => (
                                <li key={track.id}>
                                  <ActionRow
                                    track={track}
                                    index={index}
                                    onPlay={(t, i) => requestPlayQueue(playlist.tracks, i)}
                                    actionLabel={`Remove ${track.title} from playlist`}
                                    icon="remove"
                                    onAction={() => handleRemoveFromPlaylist(playlist.id, track)}
                                  />
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          ) : null)}

        {/* ---------- History ---------- */}
        {tab === "history" &&
          (errors.history ? (
            <SectionErrorState onRetry={() => void loadHistory()} />
          ) : showHistorySkeleton ? (
            <ListSkeleton />
          ) : history !== null && history.length === 0 ? (
            <EmptyState
              headingLevel={2}
              icon={<Clock />}
              title="No play history"
              description="Songs you play will show up here."
              action={
                <Link
                  href="/search"
                  className="inline-flex h-11 items-center rounded-lg bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent-2"
                >
                  Find songs
                </Link>
              }
            />
          ) : (
            // Rows are rendered locally from the memoized track list + label
            // memo (F9 residual) instead of through TrackList's plain
            // onPlay(track, index) contract, which has no slot for a per-row
            // caption. The markup mirrors TrackList/TrackRow so the History tab
            // stays visually identical to Search.
            <ul className="flex flex-col gap-1" aria-label="Play history">
              {historyTracks.map((track, index) => (
                <li key={`${track.id}-${index}`}>
                  <TrackRow
                    track={track}
                    index={index}
                    meta={historyMetas[index] ?? null}
                    onPlay={(t, i) => requestPlayQueue(historyTracks, i)}
                  />
                </li>
              ))}
            </ul>
          ))}
      </div>

      {/* Promise-based dialogs (new playlist / rename / delete) render here so
          they stay within the page but portaled to the top layer by Modal. */}
      {dialog.host}
    </section>
  );
}
