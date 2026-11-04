"use client";

/**
 * One "card" in a horizontal home row: artwork tile, title and artist, tappable
 * to play. WHY a card rather than a list row: the Home rows are meant to be
 * browsed sideways like a radio/charts shelf, so each unit is a compact
 * portrait with the art doing the heavy lifting.
 *
 * Accessibility: the play surface is TWO sibling <button>s that fire the same
 * action — the artwork tile and the title/artist block — and the "…" context
 * menu is a THIRD sibling pinned to the tile's corner. They sit side by side
 * inside a plain <div>, so no interactive element is ever nested inside another
 * (the tile's overlays — ring, equalizer badge, play glyph, sheen — are spans
 * for exactly that reason).
 *
 * Active-track indicator (F7): while this track is current the title turns
 * accent, an accent ~2px ring sits on the cover (opacity/transform only), the
 * equalizer bars overlay the cover BOTTOM, and the card carries
 * aria-current="true".
 *
 * Touch parity (F3): the play overlay and ⋯ menu are gated on pointer
 * CAPABILITY (useCanHover), not viewport width, so they stay visible on large
 * touch screens where a `md:` width breakpoint would wrongly hide them. Whole-
 * card tap still plays, so neither is the only route to playback.
 *
 * WS2 polish: 0.98 press-scale (DUR.instant) and a long-press / right-click
 * surface opening the shared track menu (F8).
 */
import { useRef } from "react";
import type { Track } from "@/lib/types";
import { usePlayer } from "@/lib/client/PlayerContext";
import { useCanHover } from "@/hooks/useCanHover";
import { useRipple } from "@/hooks/useRipple";
import Artwork from "@/components/track/Artwork";
import TrackContextMenu from "@/components/track/TrackContextMenu";
import EqualizerBars from "@/components/ui/EqualizerBars";
import { cn } from "@/components/track/cn";

interface TrackCardProps {
  track: Track;
  onPlay: (track: Track) => void;
  /** True for the larger "Jump back in" hero card (bigger art + subtitle line). */
  featured?: boolean;
  /**
   * Optional short caption shown under the artist (F9 residual), e.g. "2 h ago"
   * for the recently-played shelf. Absent/null renders nothing at all, so every
   * card that does not pass it is pixel-identical to before.
   */
  meta?: string | null;
}

/** A Track may travel with a `meta` caption attached (see TrackCardRowItem) —
 *  reading it here keeps the caption wired to its own track with no lookup. */
type TrackWithMeta = Track & { meta?: string | null };

export default function TrackCard({ track, onPlay, featured = false, meta }: TrackCardProps) {
  const { currentTrack, playing, togglePlay } = usePlayer();
  const isCurrent = currentTrack?.id === track.id;
  const isPlayingCurrent = isCurrent && playing;
  const canHover = useCanHover();
  // Explicit prop first, then a `meta` riding along on the Track object (how the
  // Home hero passes it, where the row is built as `{...track, meta}`).
  const label = meta ?? (track as TrackWithMeta).meta ?? null;
  // Long-press / right-click surface for the track menu (F8): the whole card.
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  // Press wash on the artwork tile (§ Phase 5). Only the tile ripples: it is
  // the surface with a defined visual boundary, whereas a ripple across the
  // title block would bleed under the text with nothing to clip it.
  const ripple = useRipple();

  function triggerPlay() {
    // Current track: toggle play/pause; anything else starts this track.
    if (isCurrent) togglePlay();
    else onPlay(track);
  }

  // One accessible name per action, shared by the two play buttons so assistive
  // tech hears the SAME label whichever surface the user reaches first.
  const playLabel = isPlayingCurrent
    ? `Pause ${track.title}`
    : `Play ${track.title} by ${track.artist}`;

  return (
    <div
      ref={surfaceRef}
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        "group/sheen group relative flex shrink-0 flex-col items-start",
        "transition-transform duration-[var(--dur-micro)] active:scale-[0.97]"
      )}
    >
      {/* "…" overflow menu (F3/F8) pinned to the artwork's corner. It is a
          SIBLING of the play buttons (never a child of one: interactive content
          may not nest) and is lifted above the tile with z-10, since it is
          painted before the tile in DOM order. On hover-capable pointers it
          appears on card hover OR when either play button holds keyboard focus
          (`group-focus-within`), so a keyboard user always finds it on screen. */}
      <TrackContextMenu
        track={track}
        label={`More options for ${track.title}`}
        pressSurfaceRef={surfaceRef}
        triggerClassName={cn(
          "absolute right-1.5 top-1.5 z-10 bg-black/40 text-white backdrop-blur hover:bg-black/60",
          "focus-visible:bg-black/60",
          {
            "opacity-100": !canHover,
            "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100": canHover,
          }
        )}
      />

      {/* Hover/lift shadow, drawn as a pre-rendered layer whose OPACITY
          animates. WHY here and not on the card button: §4 forbids animating
          box-shadow (it repaints every frame). The button is `overflow-hidden`
          (it clips the artwork's 1.05 scale), which would clip a sibling shadow
          too — so the layer lives on this non-clipping wrapper instead, sitting
          beneath the tile (-z-10). It carries the SAME w/h as the tile rather
          than inset-0, because the wrapper also holds the title/artist block
          below the artwork; inset-0 would throw a shadow under the text as
          well. §4.1: the shadow utility is .sonic-card-shadow (ambient +
          accent-tinted lift) so the "artwork shadow grows on hover" upgrade is
          one class; the tint falls back to --accent when no --aw is set. */}
      <span
        aria-hidden
        className={cn(
          "sonic-card-shadow pointer-events-none absolute left-0 top-0 -z-10 rounded-xl opacity-0",
          "transition-[opacity,transform] duration-[var(--dur-expressive)] ease-out",
          "group-hover:-translate-y-1 group-hover:opacity-100 group-focus-within:opacity-100",
          { "h-44 w-44": featured, "h-32 w-32": !featured }
        )}
      />

      {/* Primary play surface, part 1: the artwork tile. Hover: the card lifts
          -4px, the artwork scales 1.05 inside its overflow-hidden frame, and a
          sheen gloss sweeps across. All transform/opacity only. */}
      <button
        type="button"
        onClick={triggerPlay}
        {...ripple}
        aria-label={playLabel}
        className={cn(
          "relative overflow-hidden rounded-xl bg-surface transition-[transform,opacity] duration-[var(--dur-expressive)] ease-out",
          "group-hover:-translate-y-1 group-hover:opacity-90",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
          { "h-44 w-44": featured, "h-32 w-32": !featured }
        )}
      >
        {/* Artwork scales up inside the overflow-hidden frame on hover. */}
        <span
          aria-hidden
          className="block h-full w-full transition-transform duration-[var(--dur-expressive)] ease-out group-hover:scale-[1.05]"
        >
          <Artwork track={track} size="h-full w-full" />
        </span>

        {/* Sheen sweep across the card on hover/focus. */}
        <span className="sonic-sheen-overlay" aria-hidden />

        {/* Now-playing ring (F7): a 2px accent ring drawn as a ring overlay so it
            never animates box-shadow. Rendered only for the current track.
            WHY `ring-inset`: the enclosing play button is `overflow-hidden` (it
            clips the artwork's 1.05 hover scale), so a ring drawn outside the box
            would be clipped away and never seen. An inset ring sits ON the cover
            edge instead, which is F7's "subtle scale on cover" read as a halo
            INSIDE the frame. Transform/ring only — no layout, no box-shadow. */}
        {isCurrent && (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 scale-[0.97] rounded-xl ring-2 ring-accent ring-inset"
          />
        )}

        {/* Now-playing equalizer bars at the cover BOTTOM (F7). Pauses when
            paused. Backed by a scrim so the bars read over any artwork. */}
        {isCurrent && (
          <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end justify-between gap-2 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-4">
            <EqualizerBars className="h-3.5 w-4" playing={isPlayingCurrent} />
          </span>
        )}

        {/* Play/pause overlay — always visible on touch (capability-gated), only
            hover/focus-revealed on fine pointers.
            NOTE on the no-JS first paint (F3): this overlay intentionally does
            NOT use `.touch-visible`. That utility emits `opacity: 0` under
            `(hover: hover)`, which would fight the `opacity-100` that `cn()`
            emits below for `!canHover` — Tailwind's output order, not intent,
            would then decide which wins (the same hazard TrackContextMenu
            documents). Instead the state opens at `canHover === false`, so the
            first client paint IS visible; only a JS-disabled client sees a
            ghosted overlay, and with no JS the card cannot play at all, so the
            affordance is moot rather than lost. */}
        <span
          aria-hidden
          className={cn(
            "absolute inset-0 grid place-items-center bg-black/0 text-white transition-[opacity,background-color] duration-[var(--dur-standard)]",
            {
              "opacity-100": !canHover,
              "opacity-0 group-hover:bg-black/30 group-hover:opacity-100 group-focus-within:opacity-100":
                canHover,
            }
          )}
        >
          <span
            className={cn(
              "grid h-10 w-10 place-items-center rounded-full bg-accent shadow-lg transition-transform duration-[var(--dur-standard)]",
              // Neon glow (§ Phase 5): a STATIC accent halo that is simply
              // always on for the current track, rather than something that
              // animates — animating a filter would repaint the FAB every
              // frame (§4). `drop-shadow` (not `box-shadow`) so the glow
              // follows the circle's silhouette. Only the current track gets
              // it, which makes "this is playing" readable at a glance from
              // the play overlay alone.
              isCurrent && "[filter:drop-shadow(0_0_10px_color-mix(in_srgb,var(--accent)_75%,transparent))]"
            )}
          >
            {isPlayingCurrent ? (
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current">
                <path d="M7 5h3v14H7zM14 5h3v14h-3z" />
              </svg>
            ) : (
              <svg viewBox="0 0 24 24" className="ml-0.5 h-5 w-5 fill-current">
                <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.89l11.02-6.86a1.05 1.05 0 0 0 0-1.78L9.56 4.25A1.04 1.04 0 0 0 8 5.14Z" />
              </svg>
            )}
          </span>
        </span>
      </button>

      {/* Primary play surface, part 2: the title/artist block. A separate
          sibling button for the same action, so the text is a full-width tap
          target and its own keyboard stop — NOT nested in the tile button. */}
      <button
        type="button"
        onClick={triggerPlay}
        aria-label={playLabel}
        className="mt-2 min-w-0 max-w-full rounded-sm text-left transition-transform duration-[var(--dur-micro)] active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
      >
        <span
          className={cn(
            "block w-full truncate font-medium transition-colors",
            { "text-accent": isCurrent, "text-text": !isCurrent },
            { "text-base": featured, "text-sm": !featured }
          )}
        >
          {track.title}
        </span>
        <span className="block w-full truncate text-xs text-muted">{track.artist}</span>
        {/* Relative recency caption (F9 residual). Static text, no motion; the
            block only exists when a label is present, so cards without one keep
            their original height. Hidden from the accessible name — it is
            metadata ("2 h ago"), not part of "what this button does". */}
        {label && (
          <span
            aria-hidden
            className="mt-0.5 block w-full truncate text-[11px] text-muted/80"
          >
            {label}
          </span>
        )}
      </button>
    </div>
  );
}
