"use client";

/**
 * Per-row heart/favorite toggle.
 *
 * WHY a separate component: it owns its own async state (loads the stored
 * favorite flag on mount, updates optimistically after a toggle), so TrackRow
 * stays small and purely presentational. Also, encapsulating the isFavorite /
 * toggleFavorite calls here keeps the row decoupled from the IndexedDB layer.
 *
 * WS2 polish (F8 / feedback):
 *   - Heart pop on toggle (existing) using the shared SPRING.snappy token.
 *   - A "like burst": 6 particles that fly outward and fade, driven only by
 *     transform + opacity, capped at DUR.deliberate (400 ms). Under
 *     prefers-reduced-motion the particles are not rendered at all — the heart
 *     pop alone (or nothing) is the static fallback, and the bg/border color
 *     change still communicates state.
 *   - ONE guarded `navigator.vibrate(8)` haptic tap, only on touch devices and
 *     only when the API actually exists, wrapped in try/catch.
 *
 * Reduced motion is read directly (matchMedia) rather than via a motion config
 * so the burst's DOM is genuinely absent for those users, not merely
 * instant — a burst with a 0ms duration would still flash.
 */
import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { Track } from "@/lib/types";
import { isFavorite, toggleFavorite } from "@/lib/client/db";
import { usePlayer } from "@/lib/client/PlayerContext";
import { DUR, SPRING } from "@/lib/client/motion";
import { useCanHover } from "@/hooks/useCanHover";
import { useArtworkThemeColor } from "@/lib/client/ArtworkTheme";
import { cn } from "@/components/track/cn";

/** Heart glyph; decorative next to the aria-label, so aria-hidden. */
function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden>
      <path d="M12 21s-7.5-4.7-9.9-9.2C.6 8.6 2.5 4.8 6 4.3c2-.3 3.9.6 5 2.2 1.1-1.6 3-2.5 5-2.2 3.5.5 5.4 4.3 3.9 7.5C19.5 16.3 12 21 12 21Z" />
    </svg>
  );
}

/** Particle count for the like burst (spec: 6–8). */
const BURST_PARTICLES = 6;
/** Radius (px) a particle travels outward; kept small so it stays cheap. */
const BURST_RADIUS = 18;

/** True when the user has asked for reduced motion (SSR-safe: false on server). */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export default function FavoriteButton({ track }: { track: Track }) {
  const [isFav, setIsFav] = useState(false);
  const [busy, setBusy] = useState(false);
  // Bumped on each successful "favorite on" so the burst re-keys and replays.
  // Set only from the click handler (a user event), never from an effect — and
  // only when motion is allowed, so the reduced-motion fallback is the absence
  // of this subtree rather than a 0 ms animation.
  const [burstKey, setBurstKey] = useState(0);
  const canHover = useCanHover();
  const { currentTrack } = usePlayer();
  // Artwork tint (§2.2): only the NOW-PLAYING track's cover color is known to
  // this context, so a filled heart picks it up only when this row IS that
  // track. Every other row keeps the brand accent — tinting a row with an
  // unrelated song's color would be wrong (and is exactly the trap of reading
  // a global color from a per-row component).
  const themeColor = useArtworkThemeColor();
  const isCurrent = currentTrack?.id === track.id;
  const heartColor = isCurrent ? themeColor : null;

  useEffect(() => {
    let cancelled = false;
    // Load the stored state without blocking first paint; guard against a
    // re-render/unmount racing the read (fast clicks across rows).
    isFavorite(track)
      .then((fav) => {
        if (!cancelled) setIsFav(fav);
      })
      .catch(() => {
        /* db layer is non-throwing by contract, but stay safe */
        if (!cancelled) setIsFav(false);
      });
    return () => {
      cancelled = true;
    };
  }, [track]);

  async function handleClick() {
    if (busy) return; // ignore double-taps while a toggle is in flight
    setBusy(true);
    // Snapshot the state this toggle was derived from. The write is NOT truly
    // atomic from React's point of view: db.toggleFavorite reads the row inside
    // its own transaction, while `isFav` here may still be waiting on the mount
    // read (or the storage layer may have refused the write entirely — run()
    // resolves its fallback instead of throwing). If the value that comes back
    // disagrees with the one we showed the user, trusting it would leave the
    // heart permanently out of step with IndexedDB. Trust it only when the two
    // agree; otherwise re-read the authoritative row and settle on that.
    const optimistic = !isFav;
    try {
      const next = await toggleFavorite(track); // contract: returns NEW state
      if (next === optimistic) {
        setIsFav(next);
      } else {
        // Disagreement → ask the db what the stored truth actually is.
        const stored = await isFavorite(track).catch(() => next);
        setIsFav(stored);
      }
      if (next) {
        // Fire the burst + one haptic tap only when ADDING to favorites (a
        // removal is a quieter action and needs no celebration). The
        // reduced-motion check happens HERE, in the event handler, so no effect
        // has to seed render state and no particle DOM is ever created for a
        // user who opted out of motion.
        if (!prefersReducedMotion()) setBurstKey((k) => k + 1);
        vibrateOnLike(canHover);
      }
    } catch {
      // Never crash the row on a storage failure; just leave state as-is.
    } finally {
      setBusy(false);
    }
  }

  return (
    <button
      type="button"
      aria-label={
        isFav ? `Remove ${track.title} from favorites` : `Add ${track.title} to favorites`
      }
      aria-pressed={isFav}
      disabled={busy}
      onClick={(e) => {
        // Critical: the row's onClick plays the track. The heart must NOT trigger
        // playback, so stop the event from bubbling, exactly like the play button.
        e.stopPropagation();
        void handleClick();
      }}
      // Enter/Space on a <button> also fire a click, and that synthetic click
      // bubbles like a mouse one. Any ancestor with its own Enter/Space handler
      // (the row is click-to-play) would then start playback underneath the
      // heart, so swallow the KEY event here — its click is still produced and
      // still stopped by onClick above.
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") e.stopPropagation();
      }}
      className={cn(
        "relative grid h-11 w-11 shrink-0 place-items-center rounded-full",
        "transition-colors duration-[var(--dur-micro)] active:scale-[0.96]",
        "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1",
        isFav ? "text-accent hover:bg-surface-2" : "text-muted hover:text-text hover:bg-surface-2",
        { "opacity-50": busy }
      )}
    >
      {/* Like burst (keyed so it replays per like). Pure transform/opacity, all
          finishing inside DUR.deliberate. Rendered only when motion is allowed —
          that absence IS the reduced-motion static fallback. */}
      <AnimatePresence>
        {burstKey > 0 && (
          <span
            key={burstKey}
            aria-hidden
            className="pointer-events-none absolute inset-0 grid place-items-center"
          >
            {Array.from({ length: BURST_PARTICLES }, (_, i) => {
              const angle = (i / BURST_PARTICLES) * Math.PI * 2;
              const dx = Math.cos(angle) * BURST_RADIUS;
              const dy = Math.sin(angle) * BURST_RADIUS;
              return (
                <motion.span
                  key={i}
                  className="absolute h-1 w-1 rounded-full bg-accent"
                  style={heartColor ? { backgroundColor: heartColor } : undefined}
                  initial={{ opacity: 0.9, scale: 1, x: 0, y: 0 }}
                  animate={{ opacity: 0, scale: 0.4, x: dx, y: dy }}
                  transition={{ duration: DUR.deliberate, ease: "easeOut" }}
                />
              );
            })}
          </span>
        )}
      </AnimatePresence>

      {/* Heart glyph. Keyed by `isFav` so a completed toggle remounts it and
          replays the spring pop (scale 1 → 1.3 → 1). Keyed on isFav, not on the
          optimistic click, because isFav is what the db settled on: the pop is
          a confirmation of stored state, not of an intent that might have been
          refused. Transform only; the spring comes from the shared token. */}
      <motion.span
        key={isFav ? "fav" : "not"}
        initial={{ scale: 1 }}
        animate={{ scale: [1, 1.3, 1] }}
        transition={SPRING.snappy}
        style={isFav && heartColor ? { color: heartColor } : undefined}
        className={isFav ? "[filter:drop-shadow(0_0_6px_var(--accent-2))]" : undefined}
      >
        <HeartIcon />
      </motion.span>
    </button>
  );
}

/**
 * ONE short haptic tap when favoriting on a touch device.
 *
 * WHY the guards: `navigator.vibrate` is missing on iOS Safari and desktop
 * browsers, and calling it can throw in a sandboxed/embedded context. We only
 * fire it where hover is unavailable (i.e. an actual touch surface) so a mouse
 * click never buzzes, and we swallow any failure — a haptic is a nicety, never
 * a reason for the heart to fail.
 */
function vibrateOnLike(canHover: boolean): void {
  if (canHover) return; // desktop/pointer-fine: no haptic
  try {
    if (typeof navigator !== "undefined" && typeof navigator.vibrate === "function") {
      navigator.vibrate(8);
    }
  } catch {
    // Vibration is best-effort; ignore refusals.
  }
}
