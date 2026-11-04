"use client";

/**
 * useArtworkColor — extract a themable color from artwork (frontend.md §2.1).
 *
 * HOW it stays CDN-safe: instead of stamping `crossOrigin="anonymous"` on the
 * SHARED Artwork.tsx <img> elements (which some CDNs reject and which would
 * pollute every consumer), this hook creates its own hidden dedicated <img>
 * with crossOrigin set — one per extraction. Any CDN that refuses CORS (or any
 * canvas-taint error at all) resolves to null and every consumer falls back to
 * the brand accent, so the failure mode degrades to "no tint" rather than a
 * broken visible image.
 *
 * The 24×24 downscale (frontend.md's spec) keeps the per-pixel scan ~576
 * samples — trivially cheap — and cancels JPEG noise. We scan for the most-
 * SATURATED color (not most-common: the dominant color is usually a white/grey
 * background) then blend 25% toward the brand purple for cohesion (§2.2).
 */

import { useEffect, useRef } from "react";

/** Downscale target: 24×24 = 576 samples. */
const SAMPLE = 24;

/** Blend factor toward the brand accent (§2.2). */
const BLEND_TOWARD_ACCENT = 0.25;

/** Brand accent to blend toward — mirrors --accent in globals.css (#7c5cff). */
const ACCENT: [number, number, number] = [124, 92, 255];

/** Hard timeout so a hung image decode can't leave the theme stale forever. */
const LOAD_TIMEOUT_MS = 8000;

export interface UseArtworkColorOptions {
  /** Extraction is skipped entirely while no track is loaded. */
  disabled?: boolean;
}

/**
 * Extract the themable color for `artworkUrl`.
 *
 * @param artworkUrl the now-playing artwork URL ("" / undefined → reset)
 * @param onColor invoked with `rgb(r g b)` on success, `null` on track-change
 *        to no-artwork or on any extraction failure (reset semantics)
 */
export function useArtworkColor(
  artworkUrl: string | undefined,
  onColor: (color: string | null) => void,
  { disabled = false }: UseArtworkColorOptions = {},
): void {
  const onColorRef = useRef(onColor);
  // Keep the latest callback without re-running the extraction effect.
  useEffect(() => {
    onColorRef.current = onColor;
  });

  useEffect(() => {
    // Nothing to extract → reset so consumers fold back to brand accent
    // instead of tinting from the PREVIOUS track's artwork.
    if (disabled || !artworkUrl) {
      onColorRef.current(null);
      return;
    }

    let cancelled = false;
    let timeoutId = 0;

    // Off the critical path: let the browser idle first so extraction never
    // competes with the artwork's own decode or the track-change transition.
    const schedule = (
      window.requestIdleCallback ?? ((cb: IdleRequestCallback) => window.setTimeout(cb, 50))
    ) as (cb: () => void) => number;
    const cancelSchedule = window.cancelIdleCallback
      ? (id: number) => window.cancelIdleCallback(id)
      : (id: number) => window.clearTimeout(id);

    const idleId = schedule(() => {
      void loadCorsImage(artworkUrl).then(
        (img) => {
          if (cancelled) return;
          try {
            onColorRef.current(extractColor(img));
          } catch {
            // getImageData taint / any canvas failure → graceful no-tint.
            onColorRef.current(null);
          }
        },
        () => {
          if (!cancelled) onColorRef.current(null);
        },
      );
    });
    // Bounded load: if the CDN hangs, reset to null rather than staying stale.
    timeoutId = window.setTimeout(() => {
      if (!cancelled) onColorRef.current(null);
    }, 5000 + LOAD_TIMEOUT_MS);

    return () => {
      cancelled = true;
      cancelSchedule(idleId);
      window.clearTimeout(timeoutId);
    };
  }, [artworkUrl, disabled]);
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                   */
/* -------------------------------------------------------------------------- */

/** Hidden dedicated <img> load with crossOrigin set BEFORE src (§2.1). */
function loadCorsImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // MUST be set before src — setting it after the load starts does nothing
    // and the canvas would taint silently.
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    // Keep the element out of layout / a11y entirely.
    img.style.position = "absolute";
    img.style.width = "1px";
    img.style.height = "1px";
    img.style.opacity = "0";
    img.style.pointerEvents = "none";
    img.alt = "";

    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error("artwork CORS load timed out"));
    }, LOAD_TIMEOUT_MS);

    function cleanup(): void {
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      img.remove();
    }

    img.onload = () => {
      cleanup();
      resolve(img);
    };
    img.onerror = () => {
      cleanup();
      reject(new Error("artwork not CORS-loadable"));
    };
    img.src = url;
  });
}

/** 24×24 draw + most-saturated pixel scan → 25% blend toward accent. */
function extractColor(img: HTMLImageElement): string | null {
  if (img.naturalWidth === 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = SAMPLE;
  canvas.height = SAMPLE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);

  const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);

  let best: [number, number, number] | null = null;
  let bestScore = -1;

  // 576 iterations — negligible. Score = saturation × value so near-black and
  // near-white pixels (α-saturated but empty) never win.
  for (let i = 0; i < data.length; i += 4) {
    // Skip fully transparent pixels (edge padding on non-square art).
    if (data[i + 3] < 128) continue;
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];

    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const value = max / 255;
    const saturation = max === 0 ? 0 : (max - min) / max;
    const score = saturation * value;

    if (score > bestScore) {
      bestScore = score;
      best = [r, g, b];
    }
  }

  // Fully transparent / blank artwork → no tint.
  if (!best) return null;

  // Blend 25% toward brand accent so wildly different artworks still feel
  // like one app (§2.2).
  const [br, bg, bb] = best;
  const mixed: [number, number, number] = [
    Math.round(br + (ACCENT[0] - br) * BLEND_TOWARD_ACCENT),
    Math.round(bg + (ACCENT[1] - bg) * BLEND_TOWARD_ACCENT),
    Math.round(bb + (ACCENT[2] - bb) * BLEND_TOWARD_ACCENT),
  ];

  return `rgb(${mixed[0]} ${mixed[1]} ${mixed[2]})`;
}
