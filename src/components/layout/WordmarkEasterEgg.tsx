"use client";

/**
 * WordmarkEasterEgg — five quick taps on the "Sonic" wordmark detonate a short
 * confetti burst.
 *
 * WHY this is safe to bury in the brand block: it wraps the existing wordmark
 * span, adds no focusable element, and changes nothing about the text, its
 * colour or its accessible name. A user who never taps it five times sees
 * literally the same sidebar they always did.
 *
 * WHY the tap counter RESETS on a timeout rather than counting forever: a user
 * who clicks the wordmark casually over a session (it is next to the nav) would
 * otherwise accumulate stray taps and trigger confetti at an arbitrary moment.
 * A 900ms window means only a deliberate double-handful of fast taps counts.
 *
 * WHY the burst is capped and deterministic: a random 8–14 fragments is enough
 * to read as a celebration and keeps the DOM trivial. Angles are distributed
 * evenly with a small jitter so it never looks like a mechanical star, and
 * every fragment is `pointer-events-none` + `aria-hidden` so it cannot block a
 * click or be announced.
 *
 * Reduced motion: the counter still runs (so the behaviour is identical for
 * everyone) but no fragments are rendered — the CSS `display: none` guard on
 * `.sonic-confetti` is the backstop, and the JS gate means they are not even
 * created.
 */

import { useCallback, useRef, useState } from "react";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";

/** Taps required, and the window they must land inside (ms). */
const TAPS_REQUIRED = 5;
const TAP_WINDOW_MS = 900;
/** Fragment count bounds. */
const MIN_PIECES = 8;
const MAX_PIECES = 14;

interface Fragment {
  /** Unique per burst so React re-keys and the CSS animation replays. */
  id: string;
  /** Final translate offsets, in px, expressed as the keyframe's vars. */
  cx: number;
  cy: number;
  /** Colour token for this piece. */
  color: string;
  /** Small rotation/scale variation so it does not read as a perfect fan. */
  size: number;
}

/** Palette drawn from the theme so the burst matches the app, not a rainbow. */
const COLORS = ["var(--accent)", "var(--accent-2)", "var(--text)", "var(--danger)"];

/**
 * Build one burst. Separated from the component so the randomness is obviously
 * confined here, and so a future caller could seed it.
 */
function makeBurst(): Fragment[] {
  const count =
    MIN_PIECES + Math.floor(Math.random() * (MAX_PIECES - MIN_PIECES + 1));
  return Array.from({ length: count }, (_, i) => {
    // Even angular spread with jitter: `i/count` guarantees coverage of all
    // directions, the jitter stops it looking like a clock face.
    const angle = (i / count) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    const distance = 26 + Math.random() * 26;
    return {
      id: `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 6)}`,
      cx: Math.cos(angle) * distance,
      // Bias upward: confetti that falls reads as heavier; a slight lift is
      // more celebratory and keeps pieces off the nav items below.
      cy: Math.sin(angle) * distance - 10,
      color: COLORS[i % COLORS.length] as string,
      size: 3 + Math.random() * 3,
    };
  });
}

export default function WordmarkEasterEgg({ children }: { children: React.ReactNode }) {
  const reducedMotion = usePrefersReducedMotion();
  const [fragments, setFragments] = useState<Fragment[]>([]);
  // Tap bookkeeping lives in refs: it must not trigger a render per tap, and it
  // must not be a dependency of the handler (which would re-create it and reset
  // the closure every render).
  const tapsRef = useRef(0);
  const firstTapRef = useRef(0);
  const clearTimerRef = useRef<number | null>(null);

  const onActivate = useCallback(() => {
    const now = Date.now();
    // Outside the window: start a fresh count from this tap.
    if (now - firstTapRef.current > TAP_WINDOW_MS) {
      tapsRef.current = 1;
      firstTapRef.current = now;
      return;
    }
    tapsRef.current += 1;
    if (tapsRef.current < TAPS_REQUIRED) return;

    // Triggered — reset immediately so a sixth tap starts a new count rather
    // than re-firing on every subsequent tap.
    tapsRef.current = 0;
    firstTapRef.current = 0;

    if (reducedMotion) return; // behaviour identical, visual skipped

    const burst = makeBurst();
    setFragments(burst);
    // Clear after the animation so the DOM does not keep dead spans. Uses the
    // documented page token (400ms) plus a frame of slack.
    if (clearTimerRef.current !== null) window.clearTimeout(clearTimerRef.current);
    clearTimerRef.current = window.setTimeout(() => {
      setFragments([]);
      clearTimerRef.current = null;
    }, 500);
  }, [reducedMotion]);

  return (
    <span
      className="relative inline-block"
      // A pointer-only flourish. Clicking the brand is not an action with a
      // keyboard equivalent because it is not an action at all — it is an egg.
      // Deliberately NOT a button: adding one would insert a phantom tab stop
      // and announce a control that does nothing. The wordmark itself already
      // sits inside the sidebar as decoration (the nav links are the real
      // controls), so a click handler here is an enhancement, not an affordance.
      onClick={onActivate}
    >
      {children}
      {fragments.length > 0 && (
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 z-20 block h-0 w-0"
        >
          {fragments.map((f) => (
            <span
              key={f.id}
              className="sonic-confetti absolute block rounded-[1px]"
              style={
                {
                  width: f.size,
                  height: f.size,
                  backgroundColor: f.color,
                  // The keyframe reads these; they are set per fragment so one
                  // shared animation produces a different trajectory each time.
                  "--cx": `${f.cx}px`,
                  "--cy": `${f.cy}px`,
                } as React.CSSProperties
              }
            />
          ))}
        </span>
      )}
    </span>
  );
}
