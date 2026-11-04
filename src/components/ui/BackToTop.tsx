"use client";

/**
 * BackToTop — a small floating "scroll to top" affordance for long lists (WS6).
 *
 * WHY scroll-target aware: this app does NOT scroll `window`. Shell.tsx gives
 * its <main> `overflow-y-auto`, so the real scroll container is that element.
 * Attaching a window scroll listener here would simply never fire. The
 * component therefore takes the scroll container as a prop (Shell owns it) and
 * listens there.
 *
 * Motion: appear/disappear is opacity + an 8px translateY via framer-motion, so
 * it never triggers layout. Reduced motion collapses the movement through the
 * root MotionConfig reducedMotion="user".
 *
 * A11y: a real <button> with an accessible name and a 44px touch target. It is
 * REMOVED from the DOM while hidden (AnimatePresence unmounts it), so it can
 * never be tabbed to or clicked mid-fade.
 */
import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { DUR, EASE } from "@/lib/client/motion";
import { cn } from "@/components/track/cn";

interface BackToTopProps {
  /** The real scroll container (Shell's <main>), or null before mount. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Scroll distance, in px, past which the button appears. */
  threshold?: number;
}

export default function BackToTop({ scrollRef, threshold = 400 }: BackToTopProps) {
  const [show, setShow] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Hysteresis: appear past `threshold`, hide only once well back up. Without
    // the gap, a scroll position resting near the threshold makes the button
    // flicker on every pixel of scroll.
    const onScroll = () => {
      const top = el.scrollTop;
      setShow((prev) => (prev ? top > threshold * 0.5 : top > threshold));
    };
    // Read once on mount so a restored scroll position is reflected immediately.
    // The functional updater bails out when the value is unchanged, so this does
    // not cost an extra render.
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef, threshold]);

  const toTop = () => {
    const el = scrollRef.current;
    if (!el) return;
    // Respect reduced motion: jump instantly instead of animating the scroll.
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({ top: 0, behavior: reduce ? "auto" : "smooth" });
    // Return focus to the content landmark so keyboard users are not stranded
    // at the button after the viewport jumps.
    el.focus({ preventScroll: true });
  };

  return (
    <AnimatePresence>
      {show && (
        <motion.button
          type="button"
          onClick={toTop}
          aria-label="Back to top"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8 }}
          transition={{ duration: DUR.quick, ease: EASE.out }}
          // Sits above the fixed mini-player on mobile and clear of the desktop
          // bar on md+. 44px hit area on every breakpoint.
          className={cn(
            "fixed bottom-28 left-1/2 z-30 grid h-11 w-11 -translate-x-1/2 place-items-center rounded-full",
            "border border-border bg-surface/95 text-text shadow-lg shadow-black/40 backdrop-blur",
            "transition-colors hover:bg-surface-2 hover:text-text",
            "focus-visible:outline-2 focus-visible:outline-accent",
            "md:bottom-24 md:left-auto md:right-6 md:translate-x-0"
          )}
        >
          {/* Up chevron drawn inline on the shared 1.8px / round-cap geometry
              (same as ui/icons), because the icon set has no "up" arrow and the
              previous inline path used a heavier 2px weight. */}
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.8}
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <path d="m6 14.5 6-6 6 6" />
          </svg>
        </motion.button>
      )}
    </AnimatePresence>
  );
}
