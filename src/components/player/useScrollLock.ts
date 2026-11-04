"use client";

/**
 * useScrollLock — lock the app's REAL scroll container while an overlay is open
 * (WS3 / F12).
 *
 * WHY not `document.body`: SONIC's scroll surface is Shell's `<main id="main">`
 * (the CSS class `overflow-y-auto` on that element), not `window`. Locking body
 * alone would do nothing because the page itself never scrolls.
 *
 * WHY a data attribute + CSS rule rather than editing Shell.tsx: Shell is owned
 * by the Surfaces agent (this agent does not own it), so we set an attribute on
 * <html> and let a single globals.css rule neutralize shell scrolling for that
 * state. That keeps all player-adjacent scroll behaviour inside player-owned
 * files while still targeting the correct element.
 *
 * Behaviour: while `locked` is true we set `data-scroll-locked` on
 * documentElement; globals.css then applies `overflow: hidden` to `#main` so the
 * route beneath an overlay can't scroll behind it (and the FullPlayer overlay's
 * own inner scroller is untouched — it is a separate element).
 */
import { useEffect } from "react";

export function useScrollLock(locked: boolean): void {
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    if (!locked) return;
    root.setAttribute("data-scroll-locked", "true");
    return () => {
      root.removeAttribute("data-scroll-locked");
    };
  }, [locked]);
}
