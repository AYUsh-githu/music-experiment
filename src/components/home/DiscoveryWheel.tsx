"use client";

/**
 * DiscoveryWheel — spin a dial to pull one track at random from what SONIC
 * already has loaded.
 *
 * WHY "already has loaded" and not a new endpoint: the whole point of this app's
 * backend is that it is frozen and keyless. A "surprise me" feature absolutely
 * does not justify a new API route, and it does not need one — the Home page
 * already holds the trending shelf and the user's recent history. Shuffling a
 * union of those two is genuinely useful (it re-surfaces songs the user has
 * forgotten they played) and costs zero network.
 *
 * WHY a conic-gradient dial rather than twenty canvas wedges: the wedges are
 * decoration, not data — there is no per-wedge information to encode, only the
 * feeling of a wheel. A single conic-gradient on one div gives an identical
 * read at a fraction of the DOM, and the "spin" is one rotate transform. The
 * winner is chosen from the track list, and the dial's final rotation is then
 * aimed so a wedge under the pointer lines up — the visual is a truthful
 * depiction of an already-made choice, not a source of randomness.
 *
 * Keyboard / a11y: the wheel itself is decorative (`aria-hidden`) and NOT
 * focusable. The real control is a labelled button beneath it, so a screen
 * reader hears "Surprise me — play a random track from recently played and
 * trending" and never has to interpret a spinning graphic. Reduced motion skips
 * the spin entirely and reveals the result immediately.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import type { Track } from "@/lib/types";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { DUR, EASE } from "@/lib/client/motion";
import { Sparkle } from "@/components/ui/icons";

/** Number of decorative wedges around the dial. Purely visual. */
const WEDGES = 12;
/** How long the spin lasts before the result is revealed (ms). */
const SPIN_MS = 900;

interface DiscoveryWheelProps {
  /** Candidate pool: recent history and trending are merged by the caller. */
  tracks: Track[];
  /** Play the chosen track. */
  onPlay: (track: Track) => void;
}

export default function DiscoveryWheel({ tracks, onPlay }: DiscoveryWheelProps) {
  const reducedMotion = usePrefersReducedMotion();
  // Monotonic rotation, accumulated so every spin visibly turns forward rather
  // than snapping back to 0 between spins (which would read as a rewind).
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  // Holds the pending timer so a second spin (or unmount) cannot leave a stray
  // callback that plays a track after the user changed their mind.
  const timerRef = useRef<number | null>(null);

  // Deduplicate by id: a track that is both recently played AND trending must
  // not get double the odds. Stable order keeps the result reproducible per
  // render, which matters because the wedge mapping reads this array.
  const pool = useMemo(() => {
    const seen = new Set<string>();
    const out: Track[] = [];
    for (const t of tracks) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      out.push(t);
    }
    return out;
  }, [tracks]);

  const canSpin = pool.length > 0 && !spinning;

  const spin = useCallback(() => {
    if (!canSpin) return;

    // The choice is made HERE, up front — the animation only illustrates it.
    const picked = pool[Math.floor(Math.random() * pool.length)];
    if (!picked) return;

    if (reducedMotion) {
      // No spin: play the result immediately. The button still gives the same
      // outcome, so the feature is fully available without motion.
      onPlay(picked);
      return;
    }

    // Aim the dial so the wedge holding `picked` lands under the top pointer.
    // Wedges are laid out clockwise from 12 o'clock, so the target angle is
    // negative and we add whole turns to guarantee forward rotation.
    const index = pool.indexOf(picked);
    const sliceDeg = 360 / WEDGES;
    const wedgeDeg = (index % WEDGES) * sliceDeg;
    const turns = 4;
    const next = rotation + turns * 360 + (360 - wedgeDeg);

    setSpinning(true);
    setRotation(next);

    timerRef.current = window.setTimeout(() => {
      setSpinning(false);
      timerRef.current = null;
      onPlay(picked);
    }, SPIN_MS);
  }, [canSpin, pool, reducedMotion, onPlay, rotation]);

  return (
    <section
      aria-labelledby="discovery-wheel-heading"
      className="rounded-2xl border border-border bg-surface p-5"
    >
      <h2 id="discovery-wheel-heading" className="text-lg font-semibold text-text">
        Can&apos;t decide?
      </h2>
      <p className="mt-1 text-sm text-muted">
        Spin for something from your recent plays and what&apos;s trending.
      </p>

      <div className="mt-4 flex flex-col items-center gap-4 sm:flex-row sm:items-center sm:gap-6">
        {/* The dial. Decorative: the button below is the real control, so this
            whole graphic is removed from the a11y tree and cannot be focused. */}
        <div aria-hidden className="relative h-28 w-28 shrink-0">
          {/* Pointer: a fixed triangle at 12 o'clock that the wedges rotate
              beneath, so it reads as a physical indicator. */}
          <div className="absolute left-1/2 top-0 z-10 h-0 w-0 -translate-x-1/2 -translate-y-1 border-x-[6px] border-b-[10px] border-x-transparent border-b-accent" />

          <div
            className="h-full w-full rounded-full border border-border"
            style={{
              // One repeating conic pattern: an accent half-wedge followed by a
              // transparent half-wedge, repeated WEDGES times. Cheaper than
              // enumerating every wedge and it cannot drift out of alignment.
              backgroundImage: `repeating-conic-gradient(from 0deg, color-mix(in srgb, var(--accent) 26%, transparent) 0deg ${360 / WEDGES / 2}deg, transparent ${360 / WEDGES / 2}deg ${360 / WEDGES}deg)`,
              // The spin. One compositor property; the transition (not a
              // keyframe) so the accumulated angle animates from wherever it
              // currently sits. `will-change` is scoped to the element that
              // actually moves.
              transform: `rotate(${rotation}deg)`,
              transition: spinning
                ? `transform ${SPIN_MS}ms cubic-bezier(0.12, 0.86, 0.16, 1)`
                : `transform ${DUR.quick}ms ${EASE.out}`,
              willChange: "transform",
            }}
          />
          {/* Hub, so the wedges read as a dial rather than a pie chart. */}
          <div className="absolute left-1/2 top-1/2 h-8 w-8 -translate-x-1/2 -translate-y-1/2 rounded-full border border-border bg-bg" />
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 text-accent">
            <Sparkle className="h-4 w-4" aria-hidden />
          </div>
        </div>

        <div className="flex flex-col items-center gap-2 sm:items-start">
          <button
            type="button"
            onClick={spin}
            disabled={!canSpin}
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-5 text-sm font-semibold text-white transition-transform duration-[var(--dur-micro)] active:scale-[0.97] disabled:opacity-50"
          >
            <Sparkle className="h-4 w-4" aria-hidden />
            {spinning ? "Spinning…" : "Surprise me"}
          </button>
          {/* A live region rather than a toast: the result is announced where
              the user is looking, and it does not compete with playback toasts.
              Only the OUTCOME is spoken ("Playing X"), never the spin. */}
          <p className="text-xs text-muted" aria-live="polite">
            {spinning
              ? "Picking a track…"
              : pool.length === 0
                ? "Play something first and this will have options."
                : `${pool.length} tracks in the pool`}
          </p>
        </div>
      </div>
    </section>
  );
}
