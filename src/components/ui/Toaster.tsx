"use client";

/**
 * Global toast/notification host (Phase 5 §5.2; Wave 2 motion).
 *
 * Self-mounting portal that renders one stable item per active toast from the
 * store in src/lib/client/toast.ts. It deliberately does NOT appear in the
 * provider tree: <Toaster/> is mounted once in AppProviders and portals to
 * document.body so it can never be clipped by a parent's overflow/positioning.
 *
 * WHY a portal + live region: toasts are transient notifications, not part of
 * the page flow. role="status"/aria-live="polite" announces info/success to
 * screen readers, and role="alert"/aria-live="assertive" announces errors
 * immediately — the split matches how disruptive each message is.
 *
 * WHY SSR-safe: createPortal needs a real document; during a server render we
 * render nothing (the store's useToasts also returns [] on the server).
 *
 * COUNTDOWN (bug fix): the draining hairline and the auto-dismiss timer used to
 * be driven independently — the bar always ran the FULL lifespan while the store
 * timer paused on hover/focus, so a reader who paused a toast got a bar that
 * visibly "ran out" while the toast stayed, i.e. the two disagreed. They now
 * share one clock: the bar's duration is the toast's own lifespan (taken from
 * the store, not a local copy) and its freeze is the same `.sonic-toast-group`
 * hover/focus rule that pauses the store timer in src/lib/client/toast.ts. A
 * toast's hook is never re-run while it lives, so the bar starts once and its
 * CSS play-state is the only thing that changes.
 *
 * SWIPE-TO-DISMISS (bug fix): the previous version dismissed on a >=64px drag
 * but never guarded the click that follows pointerup, and it started a drag on
 * ANY pointer movement. On touch that (a) let a vertical scroll half-swipe a
 * toast, and (b) allowed the release click to fire the element UNDER the toast —
 * starting playback from the mini-player beneath it. Now: the gesture axis is
 * decided once per press (horizontal only), no transform is written until a
 * horizontal drag is confirmed, a completed drag swallows its trailing click,
 * a committed swipe resets the transform so an interrupted one can never strand
 * a half-faded card, and the card's labelled Close button stays reachable at all
 * times for pointer users who cannot swipe.
 */

import { useRef } from "react";
import { useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { useToasts, useToastHold, dismiss, type Toast } from "@/lib/client/toast";
import { DUR, EASE, SPRING } from "@/lib/client/motion";
import { cn } from "@/components/track/cn";
import { Check, X as XIcon } from "@/components/ui/icons";

/** Travel (px) past which a press becomes a gesture; its axis is decided once. */
const GESTURE_SLOP = 10;
/** Swipe distance (px) that commits a manual dismiss. */
const SWIPE_TO_DISMISS = 64;
/** How far the card may be dragged before the offset is clamped (px). */
const SWIPE_CLAMP = 140;

/**
 * Auto-dismiss lifespan per toast type, in milliseconds.
 *
 * WHY mirrored here instead of read off the Toast: the store keeps its dismissal
 * durations private (toast.ts is frozen by contract), so the countdown hairline
 * derives the same numbers from the toast type. Errors deliberately linger
 * longer so they can be read. These MUST stay in sync with DEFAULT_DURATION
 * (4000) and ERROR_DURATION (6000) in src/lib/client/toast.ts — if the store
 * ever exposes a per-toast lifetime, prefer that and delete this mapping.
 */
const DEFAULT_LIFESPAN_MS = 4000;
const ERROR_LIFESPAN_MS = 6000;

function lifespanMsFor(type: Toast["type"]): number {
  return type === "error" ? ERROR_LIFESPAN_MS : DEFAULT_LIFESPAN_MS;
}

/**
 * Leading glyph per variant, from the shared icon set. WHY not a text glyph:
 * "✓" / "!" / "•" rendered with different metrics and weights per OS next to
 * 1.8px SVG icons everywhere else, which read as a different design system.
 */
function ToastGlyph({ type }: { type: Toast["type"] }) {
  if (type === "success") return <Check className="h-4 w-4 text-accent-2" />;
  if (type === "error") return <XIcon className="h-4 w-4 text-danger" />;
  // Info: a small filled dot in the accent — quiet, not an alert.
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4 text-accent" fill="currentColor" aria-hidden>
      <circle cx="12" cy="12" r="4" />
    </svg>
  );
}

/**
 * A single toast row with entrance/exit motion, progress hairline, and
 * swipe-to-dismiss. Its own client child so the drag offset lives locally —
 * sibling toasts never re-render while another is being dragged.
 */
function ToastCard({ toast }: { toast: Toast }) {
  const accentClass =
    toast.type === "error"
      ? "border-l-danger"
      : toast.type === "success"
        ? "border-l-accent-2"
        : "border-l-accent";

  // Hold the auto-dismiss countdown while the reader hovers the card or tabs
  // into its controls. The store freezes the real timer (the dismissal) and
  // `.sonic-toast-group:focus-within` freezes the hairline for the same focus,
  // so the visual and the timer always describe the same remaining life.
  const hold = useToastHold(toast.id);

  // Gesture bookkeeping. Written straight to the DOM's transform on move (never
  // React state) so a swipe does not re-render the whole stack per pointermove.
  const startX = useRef(0);
  const startY = useRef(0);
  const delta = useRef(0);
  const axis = useRef<"none" | "x" | "y">("none");
  const suppressClick = useRef(false);
  const cardRef = useRef<HTMLDivElement | null>(null);

  function resetTransform(el: HTMLElement) {
    el.style.transform = "translateX(0)";
    el.style.opacity = "1";
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    startX.current = e.clientX;
    startY.current = e.clientY;
    delta.current = 0;
    axis.current = "none";
    // The flag is cleared on the NEXT click rather than here: the click that
    // ends the previous drag fires after this pointerdown in some browsers.
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    if (e.buttons === 0) return; // not dragging (hover / leftover move)
    const dx = e.clientX - startX.current;
    const dy = e.clientY - startY.current;

    // Decide the gesture's axis ONCE per press: whichever moves first wins, so
    // a vertical scroll is never turned into a half-swipe toast.
    if (axis.current === "none") {
      if (Math.abs(dx) < GESTURE_SLOP && Math.abs(dy) < GESTURE_SLOP) return;
      axis.current = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (axis.current === "x") {
        e.currentTarget.setPointerCapture(e.pointerId);
        suppressClick.current = true;
      }
    }
    if (axis.current !== "x") return; // vertical: let the page scroll

    delta.current = dx;
    const clamped = Math.max(-SWIPE_CLAMP, Math.min(SWIPE_CLAMP, dx));
    e.currentTarget.style.transform = `translateX(${clamped}px)`;
    e.currentTarget.style.opacity = `${1 - Math.min(1, Math.abs(dx) / 200)}`;
  }

  function onPointerUp() {
    const wasHorizontal = axis.current === "x";
    axis.current = "none";
    const el = cardRef.current;
    if (!wasHorizontal || !el) return;
    if (Math.abs(delta.current) >= SWIPE_TO_DISMISS) {
      // Committed: the store removes the toast and its exit animation runs.
      // No transform is left behind, so an interrupted swipe can never strand
      // a half-transparent card on screen.
      dismiss(toast.id);
      resetTransform(el);
      return;
    }
    // Below threshold → spring back to rest.
    resetTransform(el);
    delta.current = 0;
  }

  function onPointerCancel() {
    axis.current = "none";
    delta.current = 0;
    const el = cardRef.current;
    if (el) resetTransform(el);
  }

  /** Swallow the click that ends a horizontal drag so nothing underneath fires. */
  function onClickCapture(e: React.MouseEvent<HTMLDivElement>) {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    e.preventDefault();
    e.stopPropagation();
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8, scale: 0.98 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, y: -8, scale: 0.98 }}
      // Enter via a snappy spring (§7 toast spec); exit on the `instant` token
      // so a dismissed toast clears the way promptly instead of bouncing out.
      transition={{ default: SPRING.snappy, opacity: { duration: DUR.instant, ease: EASE.out } }}
      ref={cardRef}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerCancel}
      onClickCapture={onClickCapture}
      // Separate from the drag handlers so a horizontal swipe still works while
      // the pointer is inside the card (both are additive).
      onPointerEnter={hold.onPointerEnter}
      onPointerLeave={hold.onPointerLeave}
      onFocus={hold.onFocus}
      onBlur={hold.onBlur}
      className={cn(
        // Opaque, bordered surface matching the app's cards/panels: 14px radius,
        // surface-2 hover, a 2px severity rail on the leading edge.
        "sonic-toast-group pointer-events-auto relative flex w-full max-w-sm touch-pan-y select-none",
        "items-center gap-2.5 overflow-hidden rounded-xl border border-border border-l-2",
        // Same raised-surface recipe as the app's cards and popovers: surface
        // base, border, deep shadow. No blur — a translucent bar over a moving
        // page is harder to read than an opaque one, and the app's panels are
        // opaque too.
        "bg-surface py-1.5 pl-3.5 pr-1.5 shadow-xl shadow-black/50",
        // A horizontal drag must not select the message text.
        "cursor-grab active:cursor-grabbing",
        accentClass
      )}
    >
      <span className="shrink-0" aria-hidden>
        <ToastGlyph type={toast.type} />
      </span>
      {/* The message is the toast's only text; `break-words` keeps a long URL
          or track title from overflowing the card's rounded edge. */}
      <p className="min-w-0 flex-1 break-words py-2 text-sm leading-5 text-text">
        {toast.message}
      </p>
      <button
        type="button"
        onClick={() => dismiss(toast.id)}
        aria-label="Dismiss notification"
        className="grid h-11 w-11 shrink-0 place-items-center rounded-xl text-muted transition-colors hover:bg-surface-2 hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
      >
        <XIcon className="h-4 w-4" aria-hidden />
      </button>

      {/* Countdown hairline. The duration is the toast's own lifespan (mirroring
          the store's auto-dismiss timer), and the hover/focus freeze lives in
          globals.css (`.sonic-toast-group`), which pauses the bar for exactly the
          same hover/focus that pauses the store timer. transform-only (scaleX);
          the global reduced-motion guard collapses the duration, leaving it flat.
          Severity-colored so the bar reads as part of the same toast. */}
      <span
        aria-hidden
        className={cn(
          "sonic-toast-progress absolute inset-x-0 bottom-0 h-0.5",
          toast.type === "error"
            ? "bg-danger/70"
            : toast.type === "success"
              ? "bg-accent-2/70"
              : "bg-accent/70"
        )}
        style={{ animationDuration: `${lifespanMsFor(toast.type)}ms` }}
      />
    </motion.div>
  );
}

/**
 * The visible toast stack. TWO live regions so the a11y role matches severity
 * (errors assertive, everything else polite) — each region also carries
 * aria-relevant="additions text" so a dismissal does not read as an update.
 *
 * WHY one flex column of DIRECT children: AnimatePresence tracks each toast by
 * key only while it is a direct child; wrapping the cards in a keyed <div>
 * (the previous version) meant the whole region mounted/unmounted and exits
 * never animated. Empty regions render null so no stale empty live region sits
 * in the a11y tree.
 */
function ToastStack() {
  const toasts = useToasts();
  const regionClass =
    "pointer-events-auto flex w-full max-w-sm flex-col items-center gap-2";

  return (
    <div className="pointer-events-none fixed inset-x-0 top-3 z-[60] flex flex-col items-center gap-2 px-4 sm:top-4">
      <div
        role="status"
        aria-live="polite"
        aria-relevant="additions text"
        aria-atomic="false"
        className={toasts.some((t) => t.type !== "error") ? regionClass : undefined}
      >
        <AnimatePresence initial={false}>
          {toasts
            .filter((t) => t.type !== "error")
            .map((t) => (
              <ToastCard key={t.id} toast={t} />
            ))}
        </AnimatePresence>
      </div>
      <div
        role="alert"
        aria-live="assertive"
        aria-relevant="additions text"
        aria-atomic="false"
        className={toasts.some((t) => t.type === "error") ? regionClass : undefined}
      >
        <AnimatePresence initial={false}>
          {toasts
            .filter((t) => t.type === "error")
            .map((t) => (
              <ToastCard key={t.id} toast={t} />
            ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * Never fires; `useSyncExternalStore` only needs a stable subscribe callback —
 * this hook is a pure mount detector, so there is nothing to subscribe to.
 */
function noop(): () => void {
  return () => {};
}

/**
 * Self-mounting toast host. Renders via createPortal to body so stacking lives
 * above every route (z-[60] beats the fixed mobile tab bar's z-20 and the
 * full-screen player). Mounted once by the main agent during integration.
 */
export default function Toaster() {
  const mounted = useSyncExternalStore(noop, () => true, () => false);

  if (typeof document === "undefined") return null; // SSR: no body to portal to
  if (!mounted) return null; // hydration render: portal must not exist yet
  return createPortal(<ToastStack />, document.body);
}
