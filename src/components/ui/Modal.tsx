"use client";

/**
 * Accessible modal dialog (Wave 1, defect 8).
 *
 * Replaces the library/settings pages' native window.prompt / window.confirm
 * with a styled, accessible, dark-themed dialog. A modal is a heavy, focus-
 * stealing surface, so it is intentionally NOT animated in/out (an entrance
 * animation can pull focus mid-gesture); its presence/absence is what matters.
 *
 * Contract:
 *   - <Modal open onClose title ...> — renders nothing (and NOTHING to the DOM,
 *     via a portal) unless `open` is true.
 *   - Focus is trapped INSIDE the dialog while open (useFocusTrap), initial
 *     focus lands on the dialog shell (or the optional `initialRef` / first
 *     focusable), and Esc or a backdrop click dismisses via `onClose`.
 *   - Content is supplied inline; actions are the caller's responsibility so
 *     this stays a presentational shell.
 *
 * WHY a portal: the dialog must layer above every route (and above the fixed
 * bottom player / tab bar), which is impossible from a nested position under
 * a CSS transform/overflow ancestor. createPortal to document.body guarantees
 * a top-level stacking context (z-[70], above the player's z-40/z-30). The
 * mounted gate mirrors Toaster's hydration-safe pattern so the portal never
 * participates in SSR/hydration output.
 */

import { useEffect, useRef, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { motion } from "framer-motion";
import { useFocusTrap } from "@/lib/client/useFocusTrap";
import { DUR, EASE } from "@/lib/client/motion";
// Phase 1.1/1.5: real icon for the close button + the subtle scale entrance the
// original "no-animation" choice deliberately skipped (now imperceptible-short,
// 120ms, and reduced-motion-safe via MotionConfig reducedMotion="user" + the
// global CSS guard, so both are effectively instant to those users).
import { X as XIcon } from "@/components/ui/icons";

/** No-op subscribe for the pure mount-detector hook below. */
function noop(): () => void {
  return () => {};
}

interface ModalProps {
  open: boolean;
  onClose: () => void;
  /** Screen-reader title, e.g. "New playlist". Also the visual heading when
   *  `title` is not supplied. */
  "aria-label": string;
  /** Optional visible heading above the content. */
  title?: string;
  children: React.ReactNode;
  /** Optional element to give initial focus inside the dialog (array of one),
   *  e.g. the text input in a rename dialog. */
  initialFocus?: React.RefObject<HTMLElement | null> | null;
}

export default function Modal({
  open,
  onClose,
  "aria-label": ariaLabel,
  title,
  children,
  initialFocus,
}: ModalProps) {
  // Hydration gate: `true` only after mount, so the portal never appears in
  // SSR/hydration output (clean match guarantee).
  const mounted = useSyncExternalStore(noop, () => true, () => false);

  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Trap focus + bind Esc while open. Called unconditionally (before the early
  // return) so the hook's ordering stays valid across open/close cycles.
  useFocusTrap(dialogRef, open, onClose);

  // Give initial focus to the requested control (or the dialog shell) once the
  // dialog is open, AFTER the focus trap has run. Priority: explicit ref > first
  // focusable input > the dialog itself (which the trap already focuses).
  useEffect(() => {
    if (!open) return;
    const node = initialFocus?.current;
    if (node && typeof node.focus === "function") {
      // Defer a tick so the trap's own shell focus doesn't race it.
      const id = window.setTimeout(() => node.focus(), 0);
      return () => window.clearTimeout(id);
    }
  }, [open, initialFocus]);

  if (!mounted || typeof document === "undefined") return null;
  if (!open) return null;

  return createPortal(
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={ariaLabel}
      tabIndex={-1}
      className="fixed inset-0 z-[70] flex items-center justify-center p-4"
    >
      {/* Backdrop — click outside the dialog to dismiss. Fades in (opacity-only,
          Wave 2). WHY aria-hidden + tabIndex={-1}: this is a mouse convenience,
          and it carried the SAME accessible name as the header close button
          below, so a screen-reader user heard two identically-named "Close
          dialog" buttons. Escape (handled by the focus trap) and the labelled
          header button are the real, keyboard-reachable ways out; this stays a
          pointer-only affordance and is removed from the a11y tree. */}
      <motion.button
        type="button"
        aria-hidden="true"
        tabIndex={-1}
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: DUR.quick }}
        className="absolute inset-0 h-full w-full cursor-default bg-black/70"
      />
      {/* Dialog panel (dark theme tokens). Phase 1.5: subtle scale 0.98→1 +
          fade entrance (120ms — quick token), replacing the original literal
          "no entrance animation" stance. Focus still lands immediately (the
          trap focuses before the animation visually completes), and reduced-
          motion users see a near-instant appearance via the global guard. */}
      <motion.div
        initial={{ opacity: 0, scale: 0.98 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ duration: DUR.instant, ease: EASE.out }}
        className="relative w-full max-w-md rounded-xl border border-border bg-surface shadow-2xl shadow-black/50"
      >
        {title && (
          <header className="flex items-center justify-between border-b border-border px-5 py-3">
            <h2 className="text-base font-semibold text-text">{title}</h2>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close dialog"
              className="grid h-11 w-11 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-text"
            >
              <XIcon className="h-5 w-5" aria-hidden />
            </button>
          </header>
        )}
        <div className="px-5 py-4">{children}</div>
      </motion.div>
    </div>,
    document.body
  );
}
