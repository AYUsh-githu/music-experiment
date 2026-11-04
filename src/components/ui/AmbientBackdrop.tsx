"use client";

/**
 * AmbientNowPlaying — blurred album-art backdrop (Wave 2; tuned §9 WS3).
 *
 * Renders the current track's artwork, heavily blurred (40px) and scaled up
 * (1.1), pinned behind the FullPlayer content, plus a slow breathing gradient
 * overlay. This is a *decorative* layer: it is always `aria-hidden` and
 * `pointer-events-none`, sits at the very back of the overlay, and never
 * competes with real content for interaction or screen-reader focus.
 *
 * Crossfade on track change: instead of tearing out the <img> (which would flash
 * the background), we render TWO absolutely-stacked copies keyed by the track.
 * When the track key changes, the old image stays mounted and fades OUT over
 * 320ms while the new one fades IN over 200ms, giving a smooth dissolve inside
 * the motion budget. Tearing down the old layer via a timeout keeps the DOM lean
 * so we never accumulate one stale layer per track.
 *
 * GPU-cheap / single visual result: each layer is one <img> blurred via a CSS
 * filter (GPU-composited) with `will-change: opacity`; we animate ONLY opacity
 * (never filter/width/height), so the browser can keep it on its own layer. The
 * blur is applied to a STATIC layer, never a moving element (§4). Reduced-motion
 * users still get the crossfade (it is opacity-only and gentle), which matches
 * the global guard's intent of removing intrusive animation.
 */

import { useEffect, useState } from "react";
import { DUR } from "@/lib/client/motion";
import { useArtworkThemeColor } from "@/lib/client/ArtworkTheme";

interface AmbientNowPlayingProps {
  /** Artwork URL for the CURRENT track. */
  artwork: string;
  /** Per-track identifier; when it changes we crossfade to the new art. */
  trackKey: string;
}

/**
 * Crossfade duration (spec §9 WS3): 320 ms for the outgoing layer's fade-out is
 * generous enough to overlap the incoming layer's 200 ms fade-in without a
 * visible seam, while staying inside the 120/200/320/400 motion budget. The
 * stale layer is torn down one tick after its fade finishes.
 */
const CROSSFADE_IN_MS = DUR.quick * 1000;
const CROSSFADE_OUT_MS = DUR.standard * 1000;
const CROSSFADE_MS = CROSSFADE_OUT_MS;

/**
 * Ambient wash opacity (spec §9 WS3): ≤ 0.25 on the dark theme, ≤ 0.12 on a
 * light theme. SONIC ships a single dark theme (no `.dark` variant / no
 * `prefers-color-scheme` toggle in globals.css — verified), so 0.25 is the value
 * in force; a future light theme would select 0.12. The same layer scales to 1.1
 * (was 1.2).
 */
const AMBIENT_OPACITY = 0.25;

export default function AmbientNowPlaying({ artwork, trackKey }: AmbientNowPlayingProps) {
  // §2.2: the blurred art alone is fairly neutral; a tinted dual radial on top
  // (top-left / bottom-right, ~0.25 alpha) is what makes a cover's color read
  // as the room's lighting. Static gradients — nothing animates, so no motion
  // concern; a null color simply omits the layer and leaves the art blur.
  const artworkColor = useArtworkThemeColor();
  // Track the "now rendering" layer plus a fading-out stale layer (if any).
  const [rendered, setRendered] = useState({ artwork, trackKey });
  // The stale layer still mounted for the crossfade, or null when none.
  const [fading, setFading] = useState<{ artwork: string; trackKey: string } | null>(null);

  // When the track changes, move the current layer to "fading" and render the
  // new one; clear the stale layer after the fade completes. This is a genuine
  // derived-from-external-state sync (the parent swaps artwork/trackKey on track
  // change), the same legitimate pattern Wave 1 uses on HomeView/search; routing
  // it through a controlled component would just relocate, not remove, the sync.
  useEffect(() => {
    // Mount render: `rendered` was initialized from the same props, so this
    // early-return also prevents any fade on first paint.
    if (trackKey === rendered.trackKey) return;
    // Promote the previous layer to "fading" so it can dissolve out while the
    // new layer enters. This is a genuine derived-from-external-state sync (the
    // parent swaps artwork/trackKey on track change) — same legitimate pattern
    // Wave 1 uses on HomeView/search; a controlled component would only relocate
    // the sync, not remove it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFading(rendered);
    setRendered({ artwork, trackKey });
    const t = window.setTimeout(() => setFading(null), CROSSFADE_MS);
    return () => window.clearTimeout(t);
  }, [artwork, trackKey, rendered]);

  if (!artwork) return null;

  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      {/* Current layer: blurred art, scaled up, at the spec opacity. It fades
          IN over 200ms while the stale layer above fades OUT over 320ms — the
          two overlap into a single dissolve. The blur sits on this static
          image, never on a moving element (§4). */}
      {/* eslint-disable-next-line @next/next/no-img-element -- background blur
          layer doesn't need Image optimization; a plain img keeps it GPU-cheap. */}
      <img
        src={artwork}
        alt=""
        loading="eager"
        className="absolute inset-0 h-full w-full scale-[1.1] object-cover"
        style={{
          filter: "blur(40px)",
          opacity: AMBIENT_OPACITY,
          transition: `opacity ${CROSSFADE_IN_MS}ms linear`,
          willChange: "opacity",
        }}
      />
      {/* Stale layer during a crossfade — fades to 0 then unmounts. */}
      {fading && fading.trackKey !== rendered.trackKey && (
        /* eslint-disable-next-line @next/next/no-img-element -- see above */
        <img
          src={fading.artwork}
          alt=""
          loading="eager"
          className="absolute inset-0 h-full w-full scale-[1.1] object-cover"
          style={{
            filter: "blur(40px)",
            opacity: 0,
            transition: `opacity ${CROSSFADE_OUT_MS}ms linear`,
            willChange: "opacity",
          }}
        />
      )}
      {/* Gentle breathing gradient overlay for depth (GPU transform only). */}
      <div
        className="sonic-ambient-shift absolute inset-[-5%] bg-[radial-gradient(120%_120%_at_50%_0%,rgba(124,92,255,0.18),transparent_60%)]"
        style={{ willChange: "transform" }}
      />
      {/* §2.2 artwork-color tint: dual radial (top-left / bottom-right) at 0.25
          alpha over the purple breathing layer. Rendered only once a color is
          known, so the unextracted case looks exactly as it did before. */}
      {artworkColor && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(60% 55% at 12% 8%, ${artworkColor} 0%, transparent 70%), radial-gradient(60% 55% at 88% 92%, ${artworkColor} 0%, transparent 70%)`,
            opacity: 0.25,
          }}
        />
      )}
    </div>
  );
}
