"use client";

/**
 * One search-result row: index, artwork, title/artist, duration and actions.
 *
 * WHY a client component: it wires click/playback handlers and hover styling.
 * Both the whole row and its play button trigger playback, so the click target
 * is comfortably larger than 48px (plan §5.1 accessibility), while the explicit
 * button remains the single focusable, keyboard-operable control.
 *
 * Active-track indicator (F7): when this row holds the currently playing track,
 * the index becomes animated equalizer bars (EqualizerBars — the WS0 canonical
 * indicator) and the title turns accent. The index/bar slot is a FIXED width, so
 * swapping the number for bars can never shift the layout (no CLS).
 * `aria-current="true"` marks the row for assistive tech.
 *
 * Touch parity (F3): the play button + ⋯ menu are gated on pointer CAPABILITY,
 * not viewport width. `useCanHover()` drives the reveal, so on a large touch
 * screen (landscape tablet, >768px, no hover) the controls stay visible instead
 * of being hidden by a `md:` width breakpoint. The `.touch-visible` utility is
 * the CSS half of the same gate (opacity 0 only under
 * `(hover:hover) and (pointer:fine)`), which also covers the no-JS first paint.
 * Whole-row tap still plays, so the affordance is never the only route.
 *
 * WS2 polish: a 0.98 press-scale on the row (DUR.instant), and a long-press /
 * right-click surface that opens the shared track menu (F8).
 */

import { useRef } from "react";
import type { Track } from "@/lib/types";
import { usePlayer } from "@/lib/client/PlayerContext";
import { useCanHover } from "@/hooks/useCanHover";
import { useRipple } from "@/hooks/useRipple";
import Artwork from "@/components/track/Artwork";
import FavoriteButton from "@/components/track/FavoriteButton";
import TrackContextMenu from "@/components/track/TrackContextMenu";
import EqualizerBars from "@/components/ui/EqualizerBars";
import { Text } from "@/components/ui/Highlight";
import { cn } from "@/components/track/cn";

interface TrackRowProps {
  track: Track;
  /** Position of this row within its parent list; used to seed the queue. */
  index: number;
  onPlay: (track: Track, index: number) => void;
  /**
   * Optional short caption rendered beside the duration (F9 residual), e.g.
   * "2 h ago" on the Library History tab. Null/absent renders nothing at all, so
   * every existing consumer's markup is unchanged.
   */
  meta?: string | null;
}

/** Seconds -> "m:ss" (273 -> "4:33"). Tolerates missing/bad data. */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Small inline play glyph; aria-hidden because it is decorative next to the label.
 *  Size is a prop so the same path serves both the big play button and the
 *  index-slot cross-fade (kept local — ui/icons.tsx is another workstream's). */
function PlayIcon({ className = "h-5 w-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={cn("fill-current", className)} aria-hidden>
      <path d="M8 5.14v13.72c0 .8.87 1.3 1.56.89l11.02-6.86a1.05 1.05 0 0 0 0-1.78L9.56 4.25A1.04 1.04 0 0 0 8 5.14Z" />
    </svg>
  );
}

/** Inline pause glyph (two bars). */
function PauseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden>
      <path d="M7 5h3v14H7zM14 5h3v14h-3z" />
    </svg>
  );
}

export default function TrackRow({ track, onPlay, index, meta }: TrackRowProps) {
  const { currentTrack, playing, togglePlay } = usePlayer();
  const isCurrent = currentTrack?.id === track.id;
  const isPlayingCurrent = isCurrent && playing;
  // Capability gate for hover-revealed controls (F3). `false` on the server and
  // on first client paint, so the controls start visible and are then only
  // hidden once we know the device truly hovers — never the other way round.
  const canHover = useCanHover();

  // The long-press / right-click surface for the track menu (F8). It is the row
  // element itself, so a press anywhere on the row opens the menu.
  const surfaceRef = useRef<HTMLDivElement | null>(null);

  // Press acknowledgement (§ Phase 5): a light wash spreading from the touch
  // point. Deliberately on the ROW, not on the play button — the row is the far
  // larger target and is what a tap actually lands on for most of its width.
  // The hook is a no-op under reduced motion, and it only ever appends a
  // decorative span, so the row's own handlers and focus behaviour are untouched.
  const ripple = useRipple();

  function triggerPlay() {
    // Tapping the current (playing/paused) row toggles playback rather than
    // re-seeding the queue — the least surprising behavior for "the song I'm on".
    if (isCurrent) togglePlay();
    else onPlay(track, index);
  }

  return (
    <div
      ref={surfaceRef}
      onClick={triggerPlay}
      {...ripple}
      // Keyboard twin of the click path, for a surface that is itself focused
      // (an assistive tool or a future tabIndex). WHY the target check: the
      // heart and the play button are descendants, and their Enter/Space would
      // otherwise bubble here and play underneath — so only a key event whose
      // target IS the row counts.
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        triggerPlay();
      }}
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        "group relative flex min-h-12 cursor-pointer items-center gap-3 overflow-hidden rounded-lg px-2 py-1.5",
        "transition-[background-color,transform] duration-[var(--dur-micro)]",
        // WS2 plan 1.5: a white wash instead of the flat bg-surface-2 so the
        // hover state reads on ANY artwork-neutral surface, not only the one
        // surface-2 was tuned against.
        "hover:bg-white/[0.06] active:scale-[0.98]"
      )}
    >
      {/* Index / now-playing equalizer. FIXED width so replacing the index
          number with bars never reflows the row (F7 "keep the reserved slot"). */}
      <div className="w-6 shrink-0 text-center">
        {isCurrent ? (
          <EqualizerBars className="inline-flex h-4 w-4" playing={isPlayingCurrent} />
        ) : (
          /* Plan 1.5 cross-fade: on row hover the index number fades into an
             accent play glyph. Two opacity-only layers stacked in the SAME
             fixed slot (w-6, h-4) so no layout ever shifts; only the current
             row keeps EqualizerBars — bars always win over the glyph. */
          <span className="relative inline-grid h-4 w-6 place-items-center">
            <span
              aria-hidden
              className="absolute inset-0 grid place-items-center text-xs tabular-nums text-muted transition-opacity duration-[var(--dur-micro)] group-hover:opacity-0"
            >
              {index + 1}
            </span>
            <span
              aria-hidden
              className="absolute inset-0 grid place-items-center text-accent opacity-0 transition-opacity duration-[var(--dur-micro)] group-hover:opacity-100"
            >
              <PlayIcon className="h-3.5 w-3.5" />
            </span>
          </span>
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
          <Text text={track.title} />
        </p>
        <p className="truncate text-xs text-muted" title={track.artist}>
          <Text text={track.artist} />
        </p>
      </div>

      {/* Duration → ⋯ menu swap (§1.5): one fixed-width slot renders the
          duration, and on hover (capable pointers only) the duration fades out
          while the SAME TrackContextMenu trigger fades in over it. Touch users
          keep both: the slot never hides the duration (no hover → no swap) and
          the row's long-press/right-click still opens the menu, so the
          affordance is never hover-only. The slot is the menu trigger's
          positioning context. */}
      <div className="relative h-6 w-9 shrink-0">
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-0 right-0 flex items-center text-xs tabular-nums text-muted transition-opacity duration-[var(--dur-micro)]",
            { "group-hover:opacity-0": canHover }
          )}
        >
          {formatDuration(track.duration)}
        </span>
        {canHover && (
          <div className="absolute inset-y-0 right-0 flex items-center opacity-0 transition-opacity duration-[var(--dur-micro)] group-hover:opacity-100 group-focus-within:opacity-100">
            <TrackContextMenu
              track={track}
              label={`More options for ${track.title}`}
              pressSurfaceRef={surfaceRef}
              // Hover-revealed, so it can never be the ONLY way to the menu:
              // taken out of the tab order here (a ghosted trigger would
              // otherwise read as a dead tab stop). Keyboard users open the
              // SAME menu with Shift+F10 / the context-menu key on a focused
              // control, which the trigger's own onKeyDown handles.
              triggerTabIndex={-1}
              // Compact trigger tailored to the duration slot: 36px box, no
              // extra bg on hover beyond the shared surface wash (the slot is
              // too small for a full 44px hover pill).
              triggerClassName="h-6 w-9 rounded-md focus-visible:bg-surface-2"
            />
          </div>
        )}
      </div>

      {/* Relative recency (F9 residual): a static caption between the duration
          and the action cluster, present only when a label was supplied. */}
      {meta && <span className="shrink-0 text-[11px] text-muted/80">{meta}</span>}

      {/* Favorite/play control cluster: heart (ghost) to the left of play (accent). */}
      <FavoriteButton track={track} />

      {/* Touch parity path for the SAME menu (F3): on pointers that cannot hover
          the slot above never swaps (duration stays put), so this explicit
          trigger remains the always-visible opener (.touch-visible pins it); on
          hover-capable devices it is not rendered at all — the duration-slot
          duplicate above is the opener there, so the row never carries two
          visible triggers. It keeps its natural tab order here: on a touch
          device this IS the menu's only visible affordance. */}
      {!canHover && (
        <TrackContextMenu
          track={track}
          label={`More options for ${track.title}`}
          pressSurfaceRef={surfaceRef}
        />
      )}

      <button
        type="button"
        aria-label={isPlayingCurrent ? `Pause ${track.title}` : `Play ${track.title}`}
        aria-pressed={isCurrent ? playing : undefined}
        onClick={(e) => {
          // Row click already plays; the button stops the bubble so we don't
          // issue the play request twice for a single click.
          e.stopPropagation();
          triggerPlay();
        }}
        className={cn(
          "touch-visible grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent text-white",
          "transition-[opacity,transform] duration-[var(--dur-standard)]",
          "active:scale-[0.96] focus-visible:opacity-100",
          // The hover reveal (and its 8px "slide in" offset) applies ONLY to
          // capable pointers. A `md:` variant here would otherwise hide/reposition
          // the button on a large TOUCH screen, which is exactly the F3 defect —
          // so every opacity/translate decision is gated on `canHover`.
          {
            "opacity-100": !canHover,
            "md:opacity-0 md:translate-x-2 md:group-hover:translate-x-0 md:group-hover:opacity-100":
              canHover,
          }
        )}
      >
        {isPlayingCurrent ? <PauseIcon /> : <PlayIcon />}
      </button>
    </div>
  );
}
