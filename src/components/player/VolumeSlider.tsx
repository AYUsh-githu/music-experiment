"use client";

/**
 * VolumeSlider — pointer-drag volume rail (WS1 / defect F10).
 *
 * Reuses the ProgressBar interaction pattern so seek and volume feel like one
 * system:
 *  - pointerdown captures the pointer and sets the volume immediately,
 *  - pointermove (while captured) keeps setting volume live (cheap here — no
 *    audio re-fetch is triggered by a gain change),
 *  - keyboard ←/→ and ↑/↓ step by 5%, Home/End jump to 0%/100%.
 *
 * Motion rules (§4): the fill is `transform: scaleX(v)` with
 * `transform-origin: left` (never `style.width`), the thumb grows with a
 * `scale` transform, and the whole rail only ever animates transform/opacity.
 * The volume slider is a low-frequency surface so live updates are fine.
 *
 * Pointer capture is released on EVERY exit path: pointerup, pointercancel, and
 * a `lostpointercapture` the browser fired on its own (the pointer leaving the
 * window, a drag cancelled by the OS, Esc mid-drag). Without the last one the
 * rail stays in its "dragging" pose (inflated thumb) forever and a later
 * pointermove on that id would keep setting the volume.
 *
 * Reduced motion: the thumb's grow transition is a transform-only 120 ms; under
 * prefers-reduced-motion the global CSS guard collapses the transition, leaving
 * an instant (still fully usable) resize.
 */

import { useId, useRef, useState } from "react";
import { DUR } from "@/lib/client/motion";
import { useArtworkThemeColor } from "@/lib/client/ArtworkTheme";
import { OWNED_KEYS_ATTR } from "@/lib/client/useGlobalKeyboardShortcuts";
import { cn } from "@/components/track/cn";

interface VolumeSliderProps {
  /** Current volume in 0..1. */
  volume: number;
  /** Called with a new volume in 0..1. */
  onChange: (v: number) => void;
  /** Extra wrapper classes (sizing). */
  className?: string;
}

export default function VolumeSlider({ volume, onChange, className = "" }: VolumeSliderProps) {
  const [hovering, setHovering] = useState(false);
  const [focused, setFocused] = useState(false);
  // Focus-VISIBLE (keyboard only). `:focus-visible` loses against the slider's
  // own `outline-none`, so the ring is driven by explicit state instead.
  const [focusVisible, setFocusVisible] = useState(false);
  // Mirror of "a drag is active" for RENDER (rocking the thumb). The ref below
  // still drives move/up gating; this boolean exists so render never reads a ref.
  const [dragging, setDragging] = useState(false);
  // Track the active pointer so move/up only react to OUR drag.
  const pointerIdRef = useRef<number | null>(null);
  const labelId = useId();
  // Artwork tint (§3.1): volume rail picks up the current cover's color.
  const artworkColor = useArtworkThemeColor();

  const clamped = Math.min(1, Math.max(0, volume));

  function ratioFromEvent(el: HTMLElement, clientX: number): number {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0) return 0;
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    // Only a primary press starts a drag; a right-click must not scrub.
    if (e.pointerType === "mouse" && e.button !== 0) return;
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // Capture can be refused (pointer already released); the initial value is
      // still applied below, so a tap remains usable.
    }
    pointerIdRef.current = e.pointerId;
    setDragging(true);
    onChange(ratioFromEvent(e.currentTarget, e.clientX));
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    onChange(ratioFromEvent(e.currentTarget, e.clientX));
  }

  /** Release capture + clear the drag pose. Shared by every exit path. */
  function releasePointer(e: React.PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    setDragging(false);
    try {
      e.currentTarget.releasePointerCapture?.(e.pointerId);
    } catch {
      // Pointer already gone — nothing to release.
    }
  }

  /**
   * `lostpointercapture` fires whenever capture ends, including when the browser
   * revokes it itself (the pointer left the window, an OS gesture, Esc). The id
   * is usually already cleared by releasePointer above; the guard keeps this
   * idempotent while still catching a capture lost from under us.
   */
  function onLostPointerCapture(e: React.PointerEvent<HTMLDivElement>) {
    if (pointerIdRef.current !== e.pointerId) return;
    pointerIdRef.current = null;
    setDragging(false);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const step = 0.05;
    let next: number | null = null;
    if (e.key === "ArrowUp" || e.key === "ArrowRight") next = clamped + step;
    else if (e.key === "ArrowDown" || e.key === "ArrowLeft") next = clamped - step;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = 1;
    if (next !== null) {
      // Stop the global arrow-key shortcut handler from double-applying volume.
      e.preventDefault();
      e.stopPropagation();
      onChange(Math.min(1, Math.max(0, next)));
    }
  }

  const thumbBig = hovering || focused || dragging;
  const percent = Math.round(clamped * 100);

  return (
    <div className={cn("relative h-11 flex-1 touch-none select-none", className)}>
      <p id={labelId} className="sr-only">
        Volume
      </p>
      {/* Visual track (thin) — decorative, sits under the interactive layer. */}
      <div className="pointer-events-none absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-surface-2">
        {/* Fill: scaleX from the left, never width. Tinted accent → artwork. */}
        <div
          className="h-full w-full origin-left rounded-full will-change-transform"
          style={{
            transform: `scaleX(${clamped})`,
            background: artworkColor
              ? `linear-gradient(90deg, var(--accent) 0%, ${artworkColor} 100%)`
              : "var(--accent)",
          }}
        />
      </div>

      {/* Interactive layer = the slider. Full-height (h-11) hit area. */}
      <div
        role="slider"
        aria-labelledby={labelId}
        // Same opt-out as ProgressBar: this slider owns ArrowUp/Down while
        // focused, so the global handler must stand down. Without it a single
        // Arrow press steps the volume twice (local + global) non-deterministically.
        {...{ [OWNED_KEYS_ATTR]: "" }}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}%`}
        aria-orientation="horizontal"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={releasePointer}
        onPointerCancel={releasePointer}
        onLostPointerCapture={onLostPointerCapture}
        onPointerEnter={() => setHovering(true)}
        onPointerLeave={() => setHovering(false)}
        onFocus={(e) => {
          setFocused(true);
          // Older engines/jsdom lack matches(); show the ring rather than hide it.
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
        onKeyDown={handleKeyDown}
        className={cn(
          "absolute inset-0 cursor-pointer outline-none",
          { "ring-2 ring-accent ring-offset-2 ring-offset-bg": focusVisible }
        )}
      />

      {/* Thumb — transform-only grow, static `left` percentage. */}
      <div
        aria-hidden
        className="pointer-events-none absolute top-1/2 h-3 w-3 rounded-full"
        style={{
          left: `${clamped * 100}%`,
          background: artworkColor ?? "var(--accent)",
          transform: `translate(-50%, -50%) scale(${thumbBig ? 1.25 : 1})`,
          transition: `transform ${DUR.instant * 1000}ms cubic-bezier(0.22, 1, 0.36, 1)`,
        }}
      />
    </div>
  );
}
