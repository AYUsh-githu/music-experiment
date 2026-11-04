"use client";

/**
 * A labeled, horizontally-scrolling shelf of TrackCards, with graceful
 * loading/error/empty states. Shared by the Trending and Recently Played
 * rows so both get an identical, mobile-safe shelf layout (scrolls sideways,
 * never the page).
 *
 * Plan 1.6 shelf polish:
 *  - Edge fades: `::before`-equivalent gradient overlays (aria-hidden) at both
 *    ends of the scroller hint at more content. They sit ABOVE the cards but
 *    are pointer-events-none, so scrolling and taps pass through untouched.
 *  - Scroll snap: `snap-x snap-proximity` on the container, `snap-start` on
 *    each card, so a flick settles near a card edge without fighting the user.
 *  - Desktop chevrons: capability-gated (useCanHover) arrow buttons that
 *    scroll one card width smoothly via scrollBy({behavior:"smooth"}) — that
 *    is a scroll, not an animation, so the transform/opacity-only rule and
 *    prefers-reduced-motion gating are not implicated. Hidden on touch.
 *  - Staggered entrance: cards fade/rise in with the shared STAGGER token
 *    (same pattern as TrackList), capped at STAGGER.maxItems.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { motion, MotionConfig } from "framer-motion";
import type { Track } from "@/lib/types";
import TrackCard from "@/components/home/TrackCard";
import EmptyState from "@/components/ui/EmptyState";
import { TrackCardSkeleton } from "@/components/ui/Skeleton";
import { ChevronLeft, ChevronRight } from "@/components/ui/icons";
import { useCanHover } from "@/hooks/useCanHover";
import { revealTransition } from "@/lib/client/motion";
import { cn } from "@/components/track/cn";

/** Async lifecycle of a single shelf — a discriminated union keeps impossible
 *  phase/message combinations from compiling. */
export type RowState =
  | { phase: "loading" }
  | { phase: "error"; message: string }
  | { phase: "empty" }
  | { phase: "ready" };

/**
 * One card in a shelf: the track, plus an optional short caption line.
 *
 * WHY `meta` rather than a second track list: the "Recently played" shelf needs
 * a relative-age label per card (F9 residual — "2 h ago"), and pairing it with
 * its track here keeps the row and its caption from ever drifting apart. Callers
 * that have nothing to say pass just `{ track }`, and the card renders exactly as
 * it did before the field existed (null/undefined -> no caption line).
 */
export interface TrackCardRowItem {
  track: Track;
  /** Optional short caption under the artist (e.g. "2 h ago"). */
  meta?: string | null;
}

/**
 * A Track widened with an optional recency caption, spread flat onto the same
 * object (unlike TrackCardRowItem, which nests the track).
 *
 * WHY this exists alongside TrackCardRowItem: TrackCard takes a bare Track and
 * renders `meta` off it directly, so consumers that hand a single track to a
 * card (JumpBackIn's hero) need the caption on the Track itself, not beside it.
 * Both shapes are exported from here so the caption convention has one owner
 * and the two can't drift apart.
 */
export type TrackWithMeta = Track & { meta?: string | null };

/** Accepts either bare Tracks (legacy callers) or {track,meta} items. */
type TrackCardRowEntry = Track | TrackCardRowItem;

/** One card + text column is 8rem wide (h-32 w-32 card) and the gap is 1rem,
 *  so a "one card" chevron hop is 9rem. Kept in sync with the layout below. */
const CARD_STEP_PX = 144;

interface TrackCardRowProps {
  heading: string;
  /** Screen-reader label for the scroll region (distinct from the heading). */
  ariaLabel: string;
  state: RowState;
  /** The shelf's cards: bare Tracks, or {track, meta} pairs when a caption is
   *  needed. A Track passed here is widened to {track} internally. */
  rows: TrackCardRowEntry[];
  /** Fired with a single track; the parent seeds the row as a queue. */
  onPlay: (track: Track, index: number) => void;
  /** Optional per-section retry — shown with the error state when provided. */
  onRetry?: () => void;
  /** True while the deferred-loading gate says the skeleton should be visible. */
  showSkeleton?: boolean;
  /**
   * §2.3 "Show all" affordance: an in-app route that lists this shelf's
   * content at full length (e.g. "/search" for Trending, "/library" for
   * Recently played). Omitted → no link renders (a shelf without a backing
   * route keeps its header unchanged).
   */
  showAllHref?: string;
  /** Accessible name for the "Show all" link when one renders. */
  showAllLabel?: string;
}

/** Inline chevron for the desktop scroll buttons — shared ui/icons glyph
 *  (§1.1 single icon source; decorative, the button carries the name). */
function ChevronIcon({ direction }: { direction: "left" | "right" }) {
  const Glyph = direction === "left" ? ChevronLeft : ChevronRight;
  return <Glyph className="h-5 w-5" />;
}

/** Ghost icon for the shelf's error state (replaces the ⚠️ emoji, §1.6). */
function AlertGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-20 w-20 mx-auto" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 4 2.8 19.5h18.4L12 4Z" />
      <path d="M12 10.2v4" />
      <circle cx="12" cy="17" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

/** Ghost icon for the shelf's empty state (replaces the 🎧 emoji, §1.6). */
function SearchGlyph() {
  return (
    <svg viewBox="0 0 24 24" className="h-20 w-20 mx-auto" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15.2 15.2 4.8 4.8" />
    </svg>
  );
}

export default function TrackCardRow({
  heading,
  ariaLabel,
  state,
  rows,
  onPlay,
  onRetry,
  showSkeleton = true,
  showAllHref,
  showAllLabel,
}: TrackCardRowProps) {
  const canHover = useCanHover();
  // The ready scroller, for the chevrons' one-card hops and the edge mask.
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  // The chevrons' enable/disable state. Seeded `false` (a shelf narrower than
  // the viewport needs no arrows) and refreshed by the scroll listener below.
  const [edges, setEdges] = useState({ left: false, right: false });

  // Every card in a shelf is the non-featured w-32 scale (TrackCard's own
  // default). Spelled out here so the snap target and the card can never drift
  // to different widths.
  const cardSize = "w-32";

  // The edge fade is the ONLY affordance telling a user the shelf scrolls
  // further, so a STATIC mask is wrong in two directions: it faded the leading
  // card even at scroll 0 (the most prominent card looked broken), and it kept
  // fading the trailing card after the user had reached the end (nothing is
  // hidden there). Both are now measured live.
  //
  // WHY the mask is written straight to the node's style instead of through a
  // :style binding: the scroll handler fires per frame, and the repo's
  // react-hooks/set-state-in-effect rule treats ANY setState reachable from an
  // effect body (including a helper the effect calls) as a cascading-render
  // bug. A direct style write is also simply cheaper — it repaints the mask and
  // never re-renders this React subtree. `edges` is only the coarser chevron
  // state, written from the listener and bailed out when unchanged.
  const updateEdges = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const max = el.scrollWidth - el.clientWidth;
    // 1px tolerance so sub-pixel rounding cannot leave a permanent fade.
    const left = el.scrollLeft > 1;
    const right = max > 1 && el.scrollLeft < max - 1;
    const start = left ? "transparent 0, black 8%" : "black 0";
    const end = right ? "black 92%, transparent 100%" : "black 100%";
    const mask = left || right
      ? `linear-gradient(to right, ${start}, ${end})`
      : "none";
    el.style.maskImage = mask;
    el.style.webkitMaskImage = mask;
    setEdges((prev) => (prev.left === left && prev.right === right ? prev : { left, right }));
  }, []);

  // Re-bind whenever the ready scroller is (re)created — it only exists once the
  // shelf reaches "ready", so `state.phase` is the trigger. Content can also
  // arrive AFTER mount (skeleton -> cards), hence the item count too. A resize
  // listener covers a rotated phone or a resized window changing how many
  // cards fit; the initial call covers first paint.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    updateEdges();
    el.addEventListener("scroll", updateEdges, { passive: true });
    window.addEventListener("resize", updateEdges);
    return () => {
      el.removeEventListener("scroll", updateEdges);
      window.removeEventListener("resize", updateEdges);
    };
  }, [updateEdges, state.phase, rows.length]);

  // Normalize: a bare Track has no `track` property of its own (Track has id,
  // title, ... but never `track`), so this discriminates the two shapes without
  // an extra wrapper object per render.
  const items: TrackCardRowItem[] = rows.map((entry) =>
    "track" in entry ? entry : { track: entry }
  );

  /** Chevron hop: one card width, smooth. Not an animation (a scroll), so no
   *  motion-token/reduced-motion concerns; unsupported APIs degrade to instant. */
  function scrollByCard(direction: 1 | -1) {
    try {
      scrollerRef.current?.scrollBy({
        left: direction * CARD_STEP_PX,
        behavior: "smooth",
      });
    } catch {
      // Very old engines without smooth options still accept the plain form.
      scrollerRef.current?.scrollBy(direction * CARD_STEP_PX, 0);
    }
  }

  /** Shared classes for the scroll containers (skeleton + ready rows use the
   *  same layout so heights and gutters match exactly). pt-1 keeps the cards'
   *  hover lift (-4px) inside the scroller's own clip box of the mask, so a
   *  lifting first/last card is never sliced off. The edge fade itself is
   *  written by updateEdges() above, on the side(s) where content is hidden. */
  const scrollerClass = cn(
    "-mx-4 flex gap-4 overflow-x-auto px-4 pb-2 pt-1",
    "snap-x snap-proximity scroll-smooth"
  );

  return (
    <section aria-label={heading}>
      {/* §2.3 consistent header: text-lg tracking-tight, with an optional
          "Show all" affordance on the right when the parent passed a route. */}
      <div className="mb-3 flex items-baseline justify-between gap-4">
        <h2 className="text-lg font-semibold tracking-tight text-text">{heading}</h2>
        {showAllHref && (
          <Link
            href={showAllHref}
            className="inline-flex h-11 shrink-0 items-center rounded-lg px-2 text-xs font-semibold uppercase tracking-wide text-muted transition-colors duration-[var(--dur-micro)] hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:text-text"
          >
            {showAllLabel ?? "Show all"}
          </Link>
        )}
      </div>

      {state.phase === "loading" && showSkeleton && (
        // Measured card variant — the real TrackCard box (h-32 w-32 + text), so
        // the shelf's height is identical before and after content arrives.
        <div
          className={scrollerClass}
          aria-busy="true"
          aria-label={ariaLabel}
        >
          {Array.from({ length: 4 }, (_, i) => (
            <TrackCardSkeleton key={i} />
          ))}
        </div>
      )}

      {state.phase === "error" && (
        <EmptyState
          icon={<AlertGlyph />}
          title="Couldn’t load this row"
          description="We hit a snag pulling this content. Try the search bar to find something else."
          action={
            onRetry ? (
              <button
                type="button"
                onClick={onRetry}
                className="h-11 rounded-lg bg-accent px-6 text-sm font-semibold text-white transition-colors hover:bg-accent-2"
              >
                Try again
              </button>
            ) : undefined
          }
        />
      )}

      {state.phase === "empty" && (
        <EmptyState
          icon={<SearchGlyph />}
          title="Nothing here yet"
          description="This shelf needs some tracks. Play a song from Search and it’ll show up."
        />
      )}

      {state.phase === "ready" && items.length > 0 && (
        <div className="group/row relative">
          {/* Chevrons: capability-gated (F3 parity), not width-gated, so they
              never appear on a large touch screen that cannot hover.
              Each arrow is rendered ONLY while that direction has content —
              a "scroll left" button at scroll 0 is a dead end that looks live,
              and a `[disabled]:opacity-0` variant would have to out-specify the
              `group-hover/row:opacity-100` reveal, which is Tailwind output
              order rather than intent. Not rendering it is unambiguous.
              The reveal is hover/focus only, so the arrows are never the only
              way to scroll (swipe/wheel/trackpad all work), and their h-11/w-11
              boxes clear the 44px target rule for hybrid devices. */}
          {canHover && edges.left && (
            <button
              type="button"
              aria-label={`Scroll ${heading} left`}
              onClick={() => scrollByCard(-1)}
              className="group/chev absolute -left-1 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full text-text opacity-0 transition-opacity duration-[var(--dur-micro)] group-hover/row:opacity-100 focus-visible:opacity-100"
            >
              <span className="grid h-9 w-9 place-items-center rounded-full border border-border bg-surface shadow-lg transition-[background-color,transform] duration-[var(--dur-micro)] group-hover/chev:bg-surface-2 group-active/chev:scale-[0.94]">
                <ChevronIcon direction="left" />
              </span>
            </button>
          )}
          {canHover && edges.right && (
            <button
              type="button"
              aria-label={`Scroll ${heading} right`}
              onClick={() => scrollByCard(1)}
              className="group/chev absolute -right-1 top-1/2 z-20 grid h-11 w-11 -translate-y-1/2 place-items-center rounded-full text-text opacity-0 transition-opacity duration-[var(--dur-micro)] group-hover/row:opacity-100 focus-visible:opacity-100"
            >
              <span className="grid h-9 w-9 place-items-center rounded-full border border-border bg-surface shadow-lg transition-[background-color,transform] duration-[var(--dur-micro)] group-hover/chev:bg-surface-2 group-active/chev:scale-[0.94]">
                <ChevronIcon direction="right" />
              </span>
            </button>
          )}

          <MotionConfig reducedMotion="user">
            <div
              ref={scrollerRef}
              aria-label={ariaLabel}
              className={scrollerClass}
            >
              {items.map((item, index) => (
                // Staggered entrance reusing the TrackList pattern / shared
                // STAGGER token: capped delay, opacity + translateY only, and
                // motion.NONE for reduced-motion users via MotionConfig.
                // `snap-start` + a definite width keep every card a full card
                // (no half-cropped card at rest) and give the snap a target.
                <motion.div
                  key={item.track.id}
                  className={cn("shrink-0 snap-start pb-1", cardSize)}
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={revealTransition(index)}
                >
                  <TrackCard
                    track={item.track}
                    meta={item.meta}
                    onPlay={() => onPlay(item.track, index)}
                  />
                </motion.div>
              ))}
              {/* Trailing gutter: some engines exclude the scroller's right
                  `px-4` padding from the scroll end, which snapped the last
                  card flush against the mask. A tiny spacer keeps it fully
                  clear of the fade. */}
              <span aria-hidden className="w-1 shrink-0" />
            </div>
          </MotionConfig>
        </div>
      )}
    </section>
  );
}
