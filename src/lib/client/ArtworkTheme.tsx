"use client";

/**
 * ArtworkTheme — lightweight artwork-driven theming context (frontend.md §2.1).
 *
 * WHY a separate context: PlayerContext is the playback contract and must stay
 * untouched (§5 shared-care). This is a purely additive, presentation-only
 * context: one producer (ArtworkColorSync, mounted in AppProviders) extracts a
 * dominant accent color from the now-playing artwork, and any consumer — the
 * player surfaces, the hero card, the page ambience — reads it without the
 * play/pause machinery knowing or caring.
 *
 * The color is exposed as a CSS-ready `rgb(r g b)` string, or null before the
 * first extraction / when extraction fails. Consumers fold it into gradients
 * and shadows via the `--aw` CSS variable (see globals.css) so a null color
 * degrades to the brand accent everywhere with zero per-consumer branching.
 */

import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

interface ArtworkThemeValue {
  /** Extracted now-playing artwork color as `rgb(r g b)`, or null when unknown. */
  color: string | null;
}

interface ArtworkThemeApi extends ArtworkThemeValue {
  /** Producer-only: publish a newly extracted color (null resets to fallback). */
  setArtworkColor: (color: string | null) => void;
}

const ArtworkThemeContext = createContext<ArtworkThemeApi>({
  color: null,
  setArtworkColor: () => {},
});

export function ArtworkThemeProvider({ children }: { children: ReactNode }) {
  const [color, setColor] = useState<string | null>(null);

  const setArtworkColor = useCallback((next: string | null) => {
    setColor(next);
  }, []);

  const value = useMemo<ArtworkThemeApi>(
    () => ({ color, setArtworkColor }),
    [color, setArtworkColor],
  );

  return <ArtworkThemeContext.Provider value={value}>{children}</ArtworkThemeContext.Provider>;
}

/** Read-only consumer: the current artwork color (null → fall back to accent). */
export function useArtworkThemeColor(): string | null {
  return useContext(ArtworkThemeContext).color;
}

/** Producer handle — used only by the ArtworkColorSync component. */
export function useSetArtworkColor(): (color: string | null) => void {
  return useContext(ArtworkThemeContext).setArtworkColor;
}
