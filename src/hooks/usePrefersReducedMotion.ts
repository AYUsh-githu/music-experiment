"use client";

/**
 * Whether the user has asked the OS to minimise motion.
 *
 * WHY a hook rather than only the global CSS guard: the CSS guard in
 * globals.css collapses animations to 0.01ms, which is right for a keyframe
 * that should still paint its END state. It is WRONG for effects that only make
 * sense as motion — a ripple, a shake, a swipe-back — because those become an
 * instantaneous flash on the element at the moment of the click. The honest
 * reduced-motion behaviour for those is to not build the DOM at all, and that
 * is a render-time decision the CSS cannot make.
 *
 * SSR-safe by construction: `useSyncExternalStore` gives the server (and the
 * hydration pass) a stable `false`, then the client snapshot reflects the real
 * media query. No set-state-in-effect, no hydration mismatch.
 */

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/** No-op unsubscriber for the server snapshot. */
function noop(): () => void {
  return () => {};
}

function subscribe(onChange: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return noop();
  }
  const mq = window.matchMedia(QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(QUERY).matches;
}

/** Server + hydration snapshot: always false, so SSR output never assumes motion. */
function getServerSnapshot(): boolean {
  return false;
}

export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
