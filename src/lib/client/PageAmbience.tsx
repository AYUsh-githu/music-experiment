"use client";

/**
 * PageAmbience — global now-playing ambience layer (frontend.md §2.4).
 *
 * A fixed, aria-hidden page-level radial gradient that reflects the
 * now-playing artwork color at very low opacity (~7%) — the "whole app
 * subtly reacts to the music" effect. It lives ABOVE the route outlet (mounted
 * in AppProviders, next to the player surfaces) so navigation never remounts
 * it — no fade-out on every page change — and crossfades (320ms, opacity-only)
 * when the color changes.
 *
 * Decorative only: aria-hidden, pointer-events-none, behind interaction. Under
 * prefers-reduced-motion the opacity crossfade runs but no other motion exists
 * (it is a static wash per color — MotionConfig additionally collapses any
 * framer usage; this component uses plain CSS transitions).
 */

import { useEffect, useState } from "react";
import { useArtworkThemeColor } from "@/lib/client/ArtworkTheme";
import { useMounted } from "@/hooks/useMounted";

/** Global wash cap (§2.4: 6–8% opacity, desktop/now-playing only). */
const MAX_WASH = 0.07;
/** Crossfade duration — DUR.standard (320ms) from the motion tokens. */
const CROSSFADE_MS = 320;

export default function PageAmbience(): React.ReactNode {
  const color = useArtworkThemeColor();
  const mounted = useMounted();

  // Two-layer crossfade (same proven pattern as AmbientBackdrop): the rendered
  // layer plus a fading-out stale layer keyed by the previous color.
  const [rendered, setRendered] = useState<string | null>(null);
  const [fading, setFading] = useState<string | null>(null);

  useEffect(() => {
    if (color === rendered) return;
    // Derived-from-external-state sync: promote current to fading, adopt new.
    // (Same legitimate pattern AmbientBackdrop uses for its artwork layers.)
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFading((prev) => prev ?? rendered);
    setRendered(color);
    const t = window.setTimeout(() => setFading(null), CROSSFADE_MS);
    return () => window.clearTimeout(t);
  }, [color, rendered]);

  // SSR-safe: nothing before hydration (the wash is client-only decoration).
  if (!mounted) return null;
  if (!color && !fading) return null;

  const layer = (rgb: string | null, visible: boolean) => (
    <div
      key={rgb ?? "none"}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10"
      style={{
        background: rgb
          ? `radial-gradient(120% 90% at 50% 0%, ${rgb} 0%, transparent 65%)`
          : undefined,
        opacity: visible ? MAX_WASH : 0,
        transition: `opacity ${CROSSFADE_MS}ms linear`,
        willChange: "opacity",
      }}
    />
  );

  return (
    <div aria-hidden className="pointer-events-none">
      {layer(rendered, true)}
      {fading !== null && layer(fading, false)}
    </div>
  );
}
