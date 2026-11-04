"use client";

/**
 * JumpBackIn - the Home hero gallery (frontend.md §2.3).
 *
 * Rebuilt from the Phase-5 "jump back in" strip into a large featured card:
 *   (a) the artwork tile in a fixed frame, with a bottom-left gradient scrim
 *       carrying the title/artist + a tag pill,
 *   (b) a play FAB that scales in on hover but stays full-size on touch,
 *   (c) a card background tinted from the artwork's own color at ~18%.
 *
 * WHY the hero owns its own color scan instead of using `useArtworkColor`: that
 * hook is bound to the NOW-PLAYING track (it publishes into ArtworkTheme so the
 * player surfaces tint together). The hero shows an arbitrary track that is not
 * playing, so it runs one local, one-shot extraction on its own artwork and
 * keeps the result in component state. The technique is deliberately the same
 * (hidden crossOrigin <img> -> 24x24 canvas -> most-saturated pixel -> 25% blend
 * toward the brand accent) so the two surfaces agree on what "the artwork color"
 * means. It never throws: any CDN/decode/taint failure resolves null and every
 * tint falls back to --accent.
 *
 * WHY the artwork is drawn ONCE (owner requirement B): the original build had
 * two stacked <img> of the same URL - a Ken-Burns drift layer under an opaque
 * tile - which meant a second download of the same bytes and a drift nobody
 * could ever see. The visible tile now carries the Ken-Burns class itself, so
 * the 1.0 -> 1.06 drift is real, costs one image, and still animates
 * transform-only.
 *
 * Data contract (unchanged from the previous implementation):
 *   - `mostRecent`    the newest history entry, if the user has played anything
 *   - `fallbackTrack` the top trending track, used when history is empty (§2.3)
 *   - neither -> an empty state pointing at Search
 */

import { useEffect, useMemo, useState } from "react";
import type { Track } from "@/lib/types";
import type { TrackWithMeta } from "@/components/home/TrackCardRow";
import { usePlayer } from "@/lib/client/PlayerContext";
import { useCanHover } from "@/hooks/useCanHover";
import { usePageVisible } from "@/hooks/usePageVisible";
import { DUR, EASE } from "@/lib/client/motion";
import { cn } from "@/components/track/cn";
import EqualizerBars from "@/components/ui/EqualizerBars";
import { Play, Pause } from "@/components/ui/icons";

interface JumpBackInProps {
  /** Newest history entry, or null when the user has not played anything yet. */
  mostRecent: TrackWithMeta | null;
  /** Trending top item - the §2.3 fallback when history is empty. */
  fallbackTrack: Track | TrackWithMeta | null;
  /** Play one track (keeps the existing `requestPlay` bridge path). */
  onPlay: (track: Track) => void;
}

/* -------------------------------------------------------------------------- */
/* Local artwork color extraction (see the WHY in the header comment).         */
/* -------------------------------------------------------------------------- */

/** Downscale target - 24x24 is enough for a representative hue and is free. */
const SAMPLE = 24;
/** Blend toward the brand accent so wildly different covers still cohere. */
const BLEND = 0.25;
/** Brand accent (#7c5cff in globals.css) - the blend destination. */
const ACCENT: [number, number, number] = [124, 92, 255];
/** Bounded load: a hung decode must resolve (to null) instead of hanging. */
const LOAD_TIMEOUT_MS = 8000;

/**
 * One-shot extraction for a single artwork URL.
 * Resolves `rgb(r g b)` on success, or null for every failure mode.
 */
async function extractArtworkColor(url: string): Promise<string | null> {
  const img = await loadCorsImage(url).catch(() => null);
  if (!img || img.naturalWidth === 0) return null;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = SAMPLE;
    canvas.height = SAMPLE;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, SAMPLE, SAMPLE);
    const { data } = ctx.getImageData(0, 0, SAMPLE, SAMPLE);

    let best: [number, number, number] | null = null;
    let bestScore = -1;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 128) continue; // skip transparent padding
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      // Saturation x value: never let a near-black/near-white pixel win.
      const score = max === 0 ? 0 : ((max - min) / max) * (max / 255);
      if (score > bestScore) {
        bestScore = score;
        best = [r, g, b];
      }
    }
    if (!best) return null;
    const [br, bg, bb] = best;
    const mix = (c: number, a: number) => Math.round(c + (a - c) * BLEND);
    return `rgb(${mix(br, ACCENT[0])} ${mix(bg, ACCENT[1])} ${mix(bb, ACCENT[2])})`;
  } catch {
    // Canvas taint / decode edge case -> no tint rather than a broken hero.
    return null;
  }
}

/**
 * Hidden dedicated crossOrigin <img> (never the shared visible Artwork).
 *
 * Every settle path is terminal exactly once: the timeout, onload and onerror
 * all funnel through `finish`, which clears the timer and detaches both
 * handlers, so a late event after a timeout can never resolve twice and the
 * timer can never leak past the promise.
 */
function loadCorsImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // MUST precede src, otherwise the canvas taints silently.
    img.crossOrigin = "anonymous";
    img.decoding = "async";
    let done = false;
    const finish = (fn: () => void) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      img.onload = null;
      img.onerror = null;
      fn();
    };
    const timer = window.setTimeout(
      () => finish(() => reject(new Error("artwork load timed out"))),
      LOAD_TIMEOUT_MS,
    );
    img.onload = () => finish(() => resolve(img));
    img.onerror = () => finish(() => reject(new Error("artwork not CORS-loadable")));
    img.src = url;
  });
}

/* -------------------------------------------------------------------------- */
/* Component                                                                   */
/* -------------------------------------------------------------------------- */

export default function JumpBackIn({ mostRecent, fallbackTrack, onPlay }: JumpBackInProps) {
  const featured: TrackWithMeta | null = mostRecent ?? fallbackTrack ?? null;
  const isFallback = !mostRecent && !!fallbackTrack;

  const { currentTrack, playing, togglePlay } = usePlayer();
  const canHover = useCanHover();
  const pageVisible = usePageVisible();
  // The extraction result is stored WITH the URL it belongs to. Storing the
  // color alone let a stale color survive a track change (the old effect's
  // cleanup flips its own flag, not the new one's), so a new cover could be
  // tinted with the PREVIOUS cover's hue until its own scan finished. Pairing
  // them makes "is this color current?" a plain equality check during render,
  // so no reset-in-effect is needed (react-hooks/set-state-in-effect).
  const [tintResult, setTintResult] = useState<{ url: string; color: string | null } | null>(
    null,
  );
  const artwork = featured?.artwork ?? "";
  const isCurrent = !!featured && currentTrack?.id === featured.id;
  const isPlayingCurrent = isCurrent && playing;

  // One extraction per artwork URL change. A result that belongs to an older
  // URL is simply never read (see `tint`), so a late publish cannot bleed
  // through even if the effect's own cancel flag were somehow bypassed.
  useEffect(() => {
    if (!artwork) return;
    let cancelled = false;
    void extractArtworkColor(artwork).then((color) => {
      // Async continuation only - publishing an external-system result.
      if (!cancelled) setTintResult({ url: artwork, color });
    });
    return () => {
      cancelled = true;
    };
  }, [artwork]);

  // null -> unknown for THIS artwork -> every tint falls back to --accent.
  const tint = tintResult && tintResult.url === artwork ? tintResult.color : null;

  // --aw drives every tint/shadow on the hero; absent -> --accent fallback.
  const tintVars = useMemo(
    () => ({ ["--aw" as string]: tint ?? undefined }) as React.CSSProperties,
    [tint],
  );

  function handlePrimary(): void {
    if (!featured) return;
    if (isCurrent) togglePlay();
    else onPlay(featured);
  }

  /* ------------------------------- empty ------------------------------- */
  if (!featured) {
    return (
      <section aria-labelledby="jump-back-in-heading" className="mt-2">
        <h2
          id="jump-back-in-heading"
          className="text-lg font-semibold tracking-tight text-text"
        >
          Jump back in
        </h2>
        <div className="mt-3 rounded-2xl border border-border bg-surface p-8 text-center">
          <p className="text-sm text-muted">
            Nothing to jump back into yet - play something and it lands here.
          </p>
          <a
            href="/search"
            className="mt-4 inline-flex h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-transform duration-[var(--dur-micro)] ease-out active:scale-[0.97] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
          >
            Find music
          </a>
        </div>
      </section>
    );
  }

  return (
    <section aria-labelledby="jump-back-in-heading">
      <h2
        id="jump-back-in-heading"
        className="text-lg font-semibold tracking-tight text-text"
      >
        {isFallback ? "Start here" : "Jump back in"}
      </h2>

      <article
        style={tintVars}
        className={cn(
          "group relative mt-3 overflow-hidden rounded-2xl border border-white/10",
          "bg-surface sonic-card-shadow",
        )}
      >
        {/* Artwork-color wash behind everything: ~18% of the extracted color. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background: tint
              ? `linear-gradient(115deg, ${tint} 0%, transparent 62%)`
              : "linear-gradient(115deg, var(--accent) 0%, transparent 62%)",
            opacity: 0.18,
          }}
        />

        <div className="relative flex flex-col gap-5 p-4 sm:flex-row sm:items-end sm:p-5">
          {/* ---------------------------- artwork ---------------------------- */}
          <div className="relative mx-auto w-full max-w-[320px] shrink-0 sm:mx-0 sm:w-56 md:w-64 lg:w-72">
            {/* The real, interactive artwork tile - and the ONLY image element.
                The tile carries the Ken-Burns drift itself (transform-only,
                20s, killed under prefers-reduced-motion by the global guard in
                globals.css) so the motion is visible rather than hidden behind
                an opaque copy, and the same URL is fetched once. Paused while
                the tab is hidden so a backgrounded hero costs no compositor
                frames. The tile is just the wrapper; the play control is the
                button below, so the two never nest. */}
            <div
              className="relative aspect-square w-full overflow-hidden rounded-xl bg-surface-2 sonic-art-shadow"
              style={{
                // Static shadow tinted from the artwork; --aw falls back to the
                // brand accent via sonic-art-shadow when the scan failed.
                boxShadow: tint
                  ? `0 12px 32px -8px ${tint}, 0 2px 8px rgb(0 0 0 / 0.45)`
                  : undefined,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- hero art; a plain img keeps the drift layer and tile in one element with no Image wrapper */}
              <img
                src={artwork}
                alt={`${featured.title} album art`}
                loading="eager"
                className="sonic-kenburns h-full w-full object-cover"
                style={{
                  animationPlayState: pageVisible ? "running" : "paused",
                }}
              />
              {/* Active-track indicator (F7): bars live on the cover bottom,
                  over a scrim so they read on any artwork. Static text is the
                  visible state; the aria-current on the play button carries it
                  for assistive tech. */}
              {isCurrent && (
                <span className="pointer-events-none absolute inset-x-0 bottom-0 flex items-center gap-2 bg-gradient-to-t from-black/70 to-transparent px-3 pb-2 pt-6">
                  <EqualizerBars playing={playing} bars={3} />
                  <span className="text-[11px] font-medium text-white/90">
                    {playing ? "Now playing" : "Paused"}
                  </span>
                </span>
              )}
            </div>
          </div>

          {/* ----------------------------- meta ------------------------------ */}
          <div className="min-w-0 flex-1 pb-1">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white/85 backdrop-blur-sm">
              {isFallback ? "Trending now" : (featured.meta ? "Recently played" : "Jump back in")}
              {!isFallback && featured.meta && (
                <span className="text-white/60">· {featured.meta}</span>
              )}
            </span>

            <h3 className="mt-3 truncate text-xl font-bold text-text sm:text-2xl">
              {featured.title}
            </h3>
            <p className="mt-1 truncate text-sm text-muted">{featured.artist}</p>

            <div className="mt-4 flex items-center gap-3">
              {/* Play FAB. Transform/opacity only (DUR.instant via the tokens):
                  hover lifts it a hair and brightens it; touch (no hover
                  capability) gets the full-size, full-opacity form, so the
                  primary action is never hover-only. h-12 clears the 44px hit
                  target. */}
              <button
                type="button"
                onClick={handlePrimary}
                aria-label={
                  isPlayingCurrent
                    ? `Pause ${featured.title}`
                    : `Play ${featured.title} by ${featured.artist}`
                }
                aria-current={isCurrent ? "true" : undefined}
                className={cn(
                  "inline-flex h-12 items-center gap-2 rounded-full bg-accent px-6 text-sm font-semibold text-white",
                  "shadow-lg shadow-accent/30 transition-[transform,opacity,background-color] active:scale-[0.97]",
                  "hover:bg-accent-2",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
                  // The micro-lift is gated on hover capability in the class
                  // list (not inline style) so the two can never disagree.
                  { "hover:-translate-y-0.5": canHover },
                )}
                style={{
                  transitionDuration: `${DUR.instant * 1000}ms`,
                  transitionTimingFunction: `cubic-bezier(${EASE.out.join(",")})`,
                }}
              >
                {isPlayingCurrent ? (
                  <Pause className="h-5 w-5" />
                ) : (
                  <Play className="h-5 w-5" />
                )}
                {isPlayingCurrent ? "Pause" : "Play"}
              </button>

              <a
                href="/library"
                className="inline-flex h-12 items-center rounded-full border border-white/15 px-5 text-sm font-medium text-text/90 transition-colors hover:bg-white/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-2 focus-visible:ring-offset-2 focus-visible:ring-offset-bg active:scale-[0.97]"
              >
                Open library
              </a>
            </div>
          </div>
        </div>
      </article>
    </section>
  );
}
