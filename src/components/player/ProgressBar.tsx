"use client";

/**
 * Accessible seek bar with pointer-drag scrubbing (Wave 1 defect 5, Wave 2 polish).
 *
 * WHY a role="slider" div rather than <input type="range">: it keeps the fill on
 * the accent token with Tailwind while preserving full keyboard + screen-reader
 * slider semantics. Click/tap anywhere computes the sought position as a
 * percentage of the track.
 *
 * Scrubbing model:
 *  - pointerdown on the track starts a drag with setPointerCapture, freezes the
 *    displayed time (audio keeps playing, but the thumb + readout reflect the
 *    scrub position), grows the thumb, and shows a floating time bubble above it.
 *  - pointermove updates the scrub position live.
 *  - pointerup COMMITS exactly once (calls onSeek) and releases the pointer.
 *  Tap without drag = a normal click seek (same commit path).
 *
 * Committed-seeking: during a drag the position lives in React state. React does
 * NOT re-render synchronously on every pointermove — updates are batched and can
 * be deferred — so the commit on release reads the position from a ref, never the
 * render-time `scrubSec` value (which may lag behind the last move and seek the
 * track backwards). A ref (not state) also keeps every pointermove from paying a
 * state write just to remember the latest value.
 *
 * TRACK vs COMPACT (why one component instead of two):
 *  - One <audio> element is shared app-wide, so four live sliders (mini + full,
 *    each mounting both a TRACK controls row and a COMPACT transport-row bar)
 *    all announce their value changes at ~4 Hz. The mini player's controls-row
 *    bar is presentation-only: it renders a grid of short SEGMENTS instead of a
 *    slider, which reads better at 300px and keeps a11y on the labelled bar.
 *  - COMPACT is the slim seek affordance carriers use inside a transport row. It
 *    has a 44px hit area but a 4px rail and NO floating bubble, so it cannot
 *    overlap the transport buttons or the title beside it.
 *
 * Motion rules (§4): the accent fill is drawn with `transform: scaleX(p)` +
 * `transform-origin: left` — NEVER `style.width`, because width animation
 * triggers layout. The thumb grows with a `scale` transform (1 -> 1.25) on
 * hover / focus / drag. The bubble is positioned with percentage `left` on a
 * STATIC element plus `translateX(-50%)`; it fades in over the instant token.
 *
 * ARIA / a11y model:
 *  - ONE element is both the focusable node AND the slider: the outer element
 *    carries role="slider", tabIndex={0}, every aria-valuemin/max/now/text and
 *    aria-orientation, plus the interactive onClick/onKeyDown.
 *  - The keyboard handler ALSO calls e.stopPropagation() so Arrow keys pressed
 *    while this slider is focused never bubble up to the window-level global
 *    shortcut handler — otherwise one press would fire BOTH this 5s step and the
 *    global 10s seek. React attaches its listeners on the root container and the
 *    global handler is bound on `window`, so stopping the synthetic event (which
 *    propagates on the native event) is what prevents the double-seek.
 *  - Home / End jump to 0s / duration (§ spec F5).
 *  - The interactive hit area is 44px tall (h-11, the WCAG touch minimum) while
 *    the visually-drawn track stays a thin bar.
 */

import { useRef, useState } from "react";
import { DUR } from "@/lib/client/motion";
import { useArtworkThemeColor } from "@/lib/client/ArtworkTheme";
import { usePrefersReducedMotion } from "@/hooks/usePrefersReducedMotion";
import { OWNED_KEYS_ATTR } from "@/lib/client/useGlobalKeyboardShortcuts";
import { cn } from "@/components/track/cn";

type ProgressBarVariant = "full" | "compact";

interface ProgressBarProps {
  progress: number; // seconds into the track
  duration: number; // total seconds; 0 when unknown
  onSeek: (seconds: number) => void;
  /**
   * "full" (default) = thumb + time labels + scrub bubble.
   * "compact" = bare rail for a transport row (no labels, no bubble).
   */
  variant?: ProgressBarVariant;
  /** Extra wrapper classes (sizing). Only applied by the "full" variant. */
  className?: string;
}

/** Rail height for the "full" variant. */
const RAIL_HEIGHT = "h-1.5";
/** COMPACT rail: the slimmer height used when the bar sits in a transport row. */
const COMPACT_RAIL_HEIGHT = "h-1";

/** Format seconds as m:ss (e.g. 3:07). Clamps negatives to 0. */
function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export default function ProgressBar({
  progress,
  duration,
  onSeek,
  variant = "full",
  className = "",
}: ProgressBarProps) {
  const max = duration > 0 ? duration : 0;
  const compact = variant === "compact";
  // Artwork-driven tint (§2.2/§3.1): the played portion runs accent → the
  // current cover's color. `null` (no track / extraction failed / CDN refused
  // CORS) leaves the original flat accent untouched — never a broken-looking bar.
  const artworkColor = useArtworkThemeColor();

  // Scrub state: while the user drags, the readout + thumb reflect this live
  // position instead of the still-playing `progress`. `null` = not scrubbing.
  const [scrubbing, setScrubbing] = useState(false);
  // Live seconds while dragging (null until the first move after down).
  const [scrubSec, setScrubSec] = useState<number | null>(null);
  // Bubble horizontal position as a percentage, so the bubble can be positioned
  // with a static `left: <pct>%` (a layout value set once per move, not an
  // animated property) while the bubble itself only animates opacity.
  const [bubblePct, setBubblePct] = useState(0);
  // Thumb growth (hover / focus / drag) — the finger-lift case is separate from
  // `scrubbing` because dragging stays true via pointer capture even when the
  // pointer leaves the bar, which used to leave the rail inflated.
  const [pressed, setPressed] = useState(false);
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  // Bumped when a seek is attempted on a track with no known duration, which
  // re-keys the slider and replays the shake keyframe exactly once. Set only
  // from the event handler (never an effect), and only when motion is allowed —
  // for reduced-motion users the affordance is the aria-disabled state instead.
  const [shakeKey, setShakeKey] = useState(0);
  const reducedMotion = usePrefersReducedMotion();
  // Focus-VISIBLE (keyboard only) so a pointer click never leaves a focus ring.
  // :focus-visible alone does not win against the global `outline-none` on the
  // slider element, so the state is tracked explicitly in React.
  const [focusVisible, setFocusVisible] = useState(false);

  // Committed pointer id so move/up only act on OUR drag, plus a flag so the
  // post-drag synthetic click (fired by the browser after pointerup) doesn't
  // double-seek.
  const pointerIdRef = useRef<number | null>(null);
  // Live scrub position for the COMMIT path (state may lag: see file header).
  const scrubSecRef = useRef<number | null>(null);
  // Read inside the click handler, which may run one task after pointerup.
  const didDragRef = useRef(false);

  // Convert a pointer's clientX (relative to the track element) into seconds.
  function clientXToSec(el: HTMLElement, clientX: number): number {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    const ratio = (clientX - rect.left) / rect.width;
    return Math.max(0, Math.min(max, ratio * max));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (max <= 0) {
      // Rejected press (§ Phase 5): the track's duration is unknown, so there
      // is nothing to seek to. Silence here reads as a broken control, so the
      // bar gives a short shake — a gesture that says "no" without a dialog.
      // `aria-disabled` already announces the state to assistive tech, so this
      // is purely a sighted-affordance; it is skipped under reduced motion
      // rather than being collapsed to a 0ms flash.
      if (!reducedMotion) setShakeKey((k) => k + 1);
      return;
    }
    // Freeze the readout at the tap position and enlarge the thumb + show the
    // bubble. We don't seek yet — the commit happens on pointerup so a single
    // deliberate drag seeks exactly once.
    const sec = clientXToSec(e.currentTarget, e.clientX);
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture can be refused (pointer already gone); the drag then simply
      // stops updating off-element — the tap-click path still seeks.
    }
    pointerIdRef.current = e.pointerId;
    didDragRef.current = false;
    scrubSecRef.current = sec;
    setPressed(true);
    setScrubbing(true);
    setScrubSec(sec);
    setBubblePct(max > 0 ? (sec / max) * 100 : 0);
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!scrubbing || pointerIdRef.current !== e.pointerId) return;
    const sec = clientXToSec(e.currentTarget, e.clientX);
    // A pointermove that follows a pointerdown is a drag even if it lands on the
    // same pixel (a stationary drag still commits where it started).
    didDragRef.current = true;
    scrubSecRef.current = sec;
    setScrubSec(sec);
    setBubblePct(max > 0 ? (sec / max) * 100 : 0);
  }

  /** Commit + tear down a drag. Shared by pointerup / pointercancel / lost capture. */
  function endDrag(e: React.PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // releasePointerCapture can throw if the pointer is already gone; ignore.
    }
    const committed = scrubSecRef.current;
    setPressed(false);
    setScrubbing(false);
    // Commit the final scrub position exactly once on release — but skip a
    // finger that never actually moved (that path is a plain tap seeked via
    // onClick). Never live-scrub audio.currentTime while dragging.
    if (didDragRef.current && committed !== null) onSeek(committed);
    didDragRef.current = false;
    scrubSecRef.current = null;
    setScrubSec(null);
  }

  /**
   * Capture loss (Esc during a drag, the window losing the pointer, a browser
   * gesture steal) fires neither pointerup nor pointercancel on some engines.
   * Treat it as a cancelled drag: drop the scrub WITHOUT seeking, so the bar
   * cannot stay stuck in its frozen scrub state showing a stale time.
   */
  function onLostPointerCapture(e: React.PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    didDragRef.current = false;
    scrubSecRef.current = null;
    setPressed(false);
    setScrubbing(false);
    setScrubSec(null);
  }

  // Keyboard: ←/→ ±5s (±10s with Shift), Home = 0, End = duration.
  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (max <= 0) return;
    const step = e.shiftKey ? 10 : 5;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") next = progress + step;
    else if (e.key === "ArrowLeft" || e.key === "ArrowDown") next = progress - step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = max;
    if (next !== null) {
      e.preventDefault();
      // STOP the keydown from bubbling to window: the global shortcut handler
      // (useGlobalKeyboardShortcuts) listens on window and would ALSO seek 10s,
      // producing a double-seek. React's synthetic stopPropagation() also stops
      // the underlying native event from reaching the window listener.
      e.stopPropagation();
      onSeek(Math.max(0, Math.min(max, next)));
    }
  }

  // Which value drives the fill + thumb: the live scrub position while dragging,
  // else the real playback progress.
  const displaySec = scrubbing && scrubSec !== null ? scrubSec : progress;
  const fillRatio = max > 0 ? Math.min(1, displaySec / max) : 0;
  const timeText = scrubbing ? formatTime(scrubSec ?? 0) : formatTime(progress);
  // The thumb grows while hovering, focused, or while a press is held.
  const thumbBig = pressed || hovering || focused;
  // An unknown duration cannot be seeked, so the bar must not pretend it can.
  const disabled = max <= 0;

  // Shared rail + thumb markup for both variants (COMPACT just draws them
  // thinner). The fill is the SAME gradient either way.
  const fillStyle = {
    transform: `scaleX(${fillRatio})`,
    background: artworkColor
      ? `linear-gradient(90deg, var(--accent) 0%, ${artworkColor} 100%)`
      : "var(--accent)",
  } as const;

  return (
    <div
      className={cn(
        "flex w-full items-center gap-2 text-[11px] tabular-nums text-muted",
        { "gap-2": !compact, "gap-0": compact },
        className
      )}
    >
      {!compact && (
        <span className="w-9 shrink-0 text-right" aria-hidden>
          {timeText}
        </span>
      )}

      {/* ONE element = the focusable, interactive slider. h-11 gives a >=44px
          touch hit target; the visible thin track + fill are drawn inside it,
          vertically centred, so the tall hit region doesn't change the look. */}
      <div
        role="slider"
        aria-label="Seek"
        // Declare to the global shortcut handler that this slider owns every key
        // while focused. WHY an attribute and not just stopPropagation: the
        // window listener's order relative to React's synthetic bubbling is not
        // guaranteed, so an Arrow press used to occasionally seek BOTH locally
        // (5s) and globally (10s). This makes the opt-out propagation-independent.
        {...{ [OWNED_KEYS_ATTR]: "" }}
        aria-valuemin={0}
        aria-valuemax={Math.round(max)}
        aria-valuenow={Math.round(displaySec)}
        aria-valuetext={`${formatTime(displaySec)} of ${formatTime(max)}`}
        aria-orientation="horizontal"
        aria-disabled={disabled || undefined}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onLostPointerCapture={onLostPointerCapture}
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => setHovering(false)}
        onFocus={(e) => {
          setFocused(true);
          // jsdom and old engines lack matches(); fall back to "keyboard-ish"
          // (show the ring) rather than silently hiding every focus indicator.
          setFocusVisible(
            typeof e.currentTarget.matches === "function"
              ? e.currentTarget.matches(":focus-visible")
              : true
          );
        }}
        onBlur={() => {
          setFocused(false);
          setFocusVisible(false);
        }}
        onClick={
          scrubbing
            ? undefined
            : (e) => {
                // Plain tap (no drag) still seeks immediately. A post-drag
                // synthetic click is skipped (the drag's pointerup already
                // committed the seek).
                if (didDragRef.current) return;
                if (max <= 0) return;
                const rect = e.currentTarget.getBoundingClientRect();
                if (rect.width <= 0) return;
                const ratio = (e.clientX - rect.left) / rect.width;
                onSeek(Math.max(0, Math.min(max, ratio * max)));
              }
        }
        onKeyDown={handleKeyDown}
        className={cn(
          "relative h-11 flex-1 touch-none select-none outline-none",
          { "cursor-pointer": !disabled, "cursor-default opacity-60": disabled },
          { "ring-2 ring-accent ring-offset-2 ring-offset-bg": focusVisible }
        )}
      >
        {/* Floating time bubble above the thumb, shown only while scrubbing. The
            container fades with the instant token; the bubble tracks the pointer
            by a static `left` percentage (not an animated property) and is
            centred with translateX(-50%). COMPACT omits it: it would overlap the
            transport controls and the title sitting beside the rail. */}
        {!compact && (
          <div
            aria-hidden
            className="pointer-events-none absolute -top-5 z-10 -translate-x-1/2 rounded-md bg-accent px-1.5 py-0.5 text-[10px] font-semibold leading-none text-white"
            style={{
              left: `${bubblePct}%`,
              opacity: scrubbing ? 1 : 0,
              transition: `opacity ${DUR.instant * 1000}ms linear`,
            }}
          >
            {formatTime(scrubSec ?? 0)}
          </div>
        )}

        {/* Thin visible track, centred inside the 44px hit region. On
            hover/drag the rail INFLATES via scaleY on this wrapper — a
            compositor-only transform, never a height change (§3.1's documented
            exception). The 44px hit target above is unaffected. */}
        <div
          className={cn(
            "pointer-events-none absolute inset-x-0 top-1/2 -translate-y-1/2 overflow-hidden rounded-full bg-surface-2",
            "transition-transform duration-[var(--dur-micro)] ease-out",
            compact ? COMPACT_RAIL_HEIGHT : RAIL_HEIGHT
          )}
          style={{ transform: `translateY(-50%) scaleY(${thumbBig ? 1.5 : 1})` }}
        >
          {/* Accent fill: scaleX (never width) from the left edge, so progress
              costs a compositor transform with zero layout. Tinted toward the
              artwork color once one is known. */}
          <div
            className="h-full w-full origin-left rounded-full will-change-transform"
            style={fillStyle}
          />
        </div>

        {/* Thumb — grows while hovering/focused/pressed for a clear affordance.
            Grown with a `scale` transform only (never width/height). Centred on
            the position via a static `left` percentage + translateX(-50%).
            pointer-events-none so the slider element captures the drag above it.
            COMPACT hides it (a 4px rail with a knob reads as a defect, and the
            bar is a secondary affordance there). */}
        {!compact && (
          <div
            aria-hidden
            key={shakeKey}
            className={cn(
              "pointer-events-none absolute top-1/2 h-3 w-3 rounded-full",
              shakeKey > 0 && "sonic-shake"
            )}
            style={{
              left: `${fillRatio * 100}%`,
              background: artworkColor ?? "var(--accent)",
              transform: `translate(-50%, -50%) scale(${thumbBig ? 1.25 : 1})`,
              transition: `transform ${DUR.instant * 1000}ms cubic-bezier(0.22, 1, 0.36, 1)`,
              // Progress-edge halo boost: 0 for most of the track, ramping to 1
              // over the last ~8%. The outer .sonic-thumb-halo layer reads this
              // var to widen and brighten, so the thumb visibly "charges" as
              // the track nears its end — no animated box-shadow, just two
              // compositor properties on a pre-rendered gradient.
              ["--halo-boost" as string]: String(
                fillRatio > 0.92 ? 1 : Math.max(0, (fillRatio - 0.84) / 0.08)
              ),
              ["--halo-color" as string]: artworkColor ?? "var(--accent)",
            }}
          >
            <span className="sonic-thumb-halo" />
          </div>
        )}
      </div>

      {!compact && (
        <span className="w-9 shrink-0" aria-hidden>
          {formatTime(max)}
        </span>
      )}
    </div>
  );
}
