"use client";

/**
 * EqualizerBars — WS0 canonical active-track indicator.
 *
 * Animated bars shown in place of a row's index number (or as a badge on a
 * card) to mark the currently-playing track. Consumes the global `eq-bounce`
 * keyframe and `.eq-anim` / `.eq-paused` utilities defined in globals.css so
 * there is exactly one source of truth for the keyframe.
 *
 * Props (frozen in WS0 — read-only for workstreams):
 *  - `playing`: true animates the bars; false freezes them at a static ~60%
 *    height so a paused current track reads as "selected but calm".
 *  - `bars`: bar count (default 3).
 *  - `className`: sizing/spacing override (default a 16px square).
 *
 * Reduced motion: the global `prefers-reduced-motion` guard collapses the
 * animation to the static state (see `.eq-anim` in globals.css). The guard's
 * duration override keeps the keyframe's INTRO frame, which is `scaleY(0.25)`
 * — so the bars parked at 25% height and read as a thin shrunk artifact rather
 * than the documented ~60%. An explicit rule inside the same guard fixes the
 * scale to 0.6; `.eq-paused` set below has the same value inline so a paused
 * track looks identical either way.
 *
 * Motion-only: only `transform` (scaleY, origin bottom) animates, so the row
 * layout never shifts. `playing={false}` emits no animation class at all — the
 * bars stop consuming frames instead of running a paused infinite animation.
 */
import { cn } from "@/components/track/cn";

interface EqualizerBarsProps {
  playing?: boolean;
  bars?: number;
  className?: string;
}

export default function EqualizerBars({
  playing = true,
  bars = 3,
  className = "h-4 w-4",
}: EqualizerBarsProps) {
  return (
    <span
      className={cn("flex items-end justify-center gap-[2px]", className)}
      // Purely decorative: the surrounding row/link already announces the track
      // and its playing state. A screen reader must not hear a second, empty
      // element for every row in a list.
      aria-hidden
    >
      {Array.from({ length: bars }, (_, i) => (
        <span
          key={i}
          className={cn(
            "h-full w-1 rounded-sm bg-accent",
            // `.eq-anim` only while playing, so a paused indicator lets the
            // compositor idle; `.eq-paused` is the static 60% pose.
            playing ? "eq-anim" : "eq-paused"
          )}
          // Stagger each bar's phase so they bounce out of sync, like audio.
          style={{ animationDelay: `${-(i * 0.38)}s`, transformOrigin: "bottom" }}
        />
      ))}
    </span>
  );
}
