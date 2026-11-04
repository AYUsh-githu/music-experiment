"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Deferred-loading gate for skeleton placeholders.
 *
 * Returns `true` (show the skeleton) only when `loading` has persisted at
 * least `delay` ms, and once shown stays `true` for at least `minDisplay` ms
 * even if loading clears early.
 *
 * WHY: two loading artifacts it prevents —
 *  - a fast/cached load resolves so quickly that flashing a skeleton for one
 *    frame is a visible "blink" (this delays the reveal until loading clearly
 *    outlives a fast response);
 *  - a load that clears just after the skeleton appears is a jarring
 *    flash-and-gone (this enforces a minimum display window).
 */
export function useDeferredLoading(
  loading: boolean,
  opts: { delay?: number; minDisplay?: number } = {},
): boolean {
  const { delay = 120, minDisplay = 350 } = opts;
  const [show, setShow] = useState(false);
  // When the skeleton first became visible (performance.now basis).
  const shownAt = useRef<number | null>(null);
  // Handle for the hold-open timer that fires after `minDisplay`.
  const holdTimer = useRef<number | null>(null);

  useEffect(() => {
    if (!loading) {
      // Loading finished. If we never showed it, nothing to do.
      if (shownAt.current === null) return;
      const elapsed = performance.now() - shownAt.current;
      const remaining = Math.max(0, minDisplay - elapsed);
      if (remaining === 0) {
        setShow(false);
        shownAt.current = null;
      } else {
        // Keep it visible until the minimum display window elapses.
        if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
        holdTimer.current = window.setTimeout(() => {
          setShow(false);
          shownAt.current = null;
        }, remaining);
      }
      return;
    }

    // Still loading: reveal only after `delay` ms of continuous loading.
    if (shownAt.current === null) {
      const t = window.setTimeout(() => {
        shownAt.current = performance.now();
        setShow(true);
      }, delay);
      return () => window.clearTimeout(t);
    }
  }, [loading, delay, minDisplay]);

  return show;
}
