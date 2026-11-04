"use client";

/**
 * Marquee — horizontal scroll for overflowing single-line text (Wave 2).
 *
 * WHY a component: MiniPlayer and FullPlayer both truncate long titles with
 * `truncate`, which hides additional text. A marquee reveals overflowing titles
 * by smoothly sliding them, but ONLY when the content actually overflows its
 * container — a short title must render static. That overflow check needs a
 * ref measurement, so it lives here as a tiny component.
 *
 * Technique: the text is rendered TWICE inside a flex track; the track
 * translates -50% in a loop, so the second copy slides seamlessly into the
 * first copy's vacated space. One copy is `invisible` text, `aria-hidden`, so
 * screen readers hear (and the a11y tree holds) the title once.
 *
 * Motion rules: animates ONLY `transform` (the CSS keyframe `sonic-marquee`),
 * pauses on hover/focus, and is fully disabled under prefers-reduced-motion by
 * the global guard in globals.css (which sets `animation: none`, leaving the
 * text statically at translateX(0)).
 *
 * HOW overflow is decided: the content is laid out at its natural width
 * (`w-max`, never wrapped), and the WRAPPER's `scrollWidth > clientWidth`
 * answers "does it fit" — the wrapper is the clipping box, so that is exactly
 * the question a marquee asks. Measuring a copy's own width would be wrong:
 * with the wrapper's width imposed on it, a long title wraps and reports a
 * width equal to the wrapper, i.e. always "fits".
 *
 * RESIZE (bug fix): the previous version measured once and re-measured only on
 * a raw `window` resize — no ResizeObserver — so a sidebar toggle, a font swap,
 * or the FullPlayer opening (each changes the available width WITHOUT resizing
 * the window) left a title in the wrong mode, and the animation kept running
 * after the text no longer overflowed. A ResizeObserver on the wrapper now
 * re-measures on every width change and is disconnected on unmount and on a
 * text change.
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/components/track/cn";

interface MarqueeProps {
  /** The text to scroll (the full, untruncated title/artist). */
  text: string;
  /** Extra classes for the wrapper (sizing/line-height). Defaults to "text-sm". */
  className?: string;
  /** Round-trip duration for one full loop; longer text can take longer. */
  durationSec?: number;
}

export default function Marquee({ text, className = "text-sm", durationSec = 20 }: MarqueeProps) {
  // Overflowing == a single copy of the text is wider than the visible box.
  const [overflowing, setOverflowing] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);

  /**
   * Compare the (unclipped) natural text width with the wrapper's inner width.
   * See the header for why the wrapper is the only reliable measuring box.
   */
  const measure = () => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const available = wrapper.clientWidth;
    if (available === 0) return; // not laid out yet — keep the last answer
    // +1px absorbs fractional font metrics so text that exactly fills its box
    // never flickers into marquee mode.
    const over = wrapper.scrollWidth > available + 1;
    setOverflowing((prev) => (prev === over ? prev : over));
  };

  // Layout effect: measure before the first paint so a scrolling title never
  // flashes one static frame. `measure` reads refs only; the updater bails out
  // when the answer is unchanged, so re-running on a text change is free.
  useLayoutEffect(() => {
    measure();
  }, [text]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper || typeof ResizeObserver === "undefined") return;
    // Width changes AND font/paint changes (the latter re-runs on any resize of
    // the observed box, which a late font load also triggers).
    const observer = new ResizeObserver(measure);
    observer.observe(wrapper);
    return () => observer.disconnect();
  }, [text]);

  return (
    <span
      ref={wrapperRef}
      // `block min-w-0` lets the wrapper shrink inside the player's flex rows;
      // `overflow-hidden` makes it the clipping/measuring box; the title keeps
      // the untruncated text one hover away.
      title={text}
      className={cn("block min-w-0 overflow-hidden whitespace-nowrap", className)}
    >
      {overflowing ? (
        // The sliding track holds two copies, each sized by its content, so a
        // -50% translate loops seamlessly. Second copy is invisible + aria-hidden.
        <span
          className="sonic-marquee group-hover/marquee:[animation-play-state:paused] group-focus-within/marquee:[animation-play-state:paused] inline-flex w-max whitespace-nowrap will-change-transform"
          style={{ animationDuration: `${durationSec}s` }}
        >
          <span className="shrink-0 pr-10">{text}</span>
          <span className="invisible shrink-0 pr-10" aria-hidden>
            {text}
          </span>
        </span>
      ) : (
        // Fits: plain, unclipped, non-animating text. `w-max` keeps it on one
        // line so the wrapper's scrollWidth stays equal to the text width.
        <span className="block w-max">{text}</span>
      )}
    </span>
  );
}
