"use client";

/**
 * Focus trap for modal dialogs (Final-audit fix).
 *
 * WHY: FullPlayer and QueueDrawer both declare role="dialog" aria-modal="true"
 * but previously had no Tab confinement, no focus restoration, and no Esc-to-close
 * — so a keyboard/screen-reader user could Tab out of the modal into the page
 * behind it, and closing dropped focus to <body>. This hook gives both modals the
 * missing modal semantics from one place so they can't drift apart.
 *
 * Contract:
 *   useFocusTrap(ref, active, onClose, restoreTo?)
 *   - while `active`, confines Tab/Shift+Tab to the dialog, puts initial focus on
 *     the dialog (or the supplied restoreTo ref's active element), and binds Esc.
 *   - on deactivate, restores focus to the element that had focus before the
 *     dialog opened (the trigger), unless `restoreTo` is given.
 *
 * Focus restoration requires remembering what was focused before the trap went
 * active, so the hook records `document.activeElement` on activation and returns
 * focus there on cleanup.
 *
 * STACKING (rewrite): modals nest in this app — the FullPlayer (now playing) and
 * the QueueDrawer (queue) are sibling portals that can be open at the same time,
 * and a track context menu / useDialog Modal can open ON TOP of either. With one
 * independent keydown listener per trap, EVERY open trap answered the same Tab
 * and Escape: Tab was wrapped by two traps fighting over focus, and one Esc
 * closed every layered surface at once. Traps now form a registry stack and only
 * the TOP entry handles Tab/Escape, so Escape closes exactly one layer.
 *
 * "Top" is stack order (most recently opened wins) rather than DOM containment,
 * because a popover portal is a SIBLING of the dialog it visually sits inside.
 *
 * Everything listener-bound uses `document` in the CAPTURE phase: React's
 * synthetic stopPropagation() (how ProgressBar/VolumeSlider keep their Arrow
 * keys away from the global shortcuts) only stops the bubble phase, so a
 * capture listener still sees Escape typed inside a nested input.
 */

import { useEffect, useRef } from "react";

/** The subset of an HTMLElement we actually ref-ify for the dialog. */
type FocusableRef = React.RefObject<HTMLElement | null>;

/**
 * Returns every focusable element reachable within a dialog, in DOM order, so
 * Tab wrapping can cycle through exactly those. Matches all standard native
 * focusable tags plus [tabindex]. Inputs that are disabled or hidden are dropped.
 */
function focusableWithin(root: HTMLElement): HTMLElement[] {
  const nodes = root.querySelectorAll<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), ' +
      'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), ' +
      '[contenteditable]:not([contenteditable="false"])'
  );
  const list: HTMLElement[] = [];
  nodes.forEach((n) => {
    // `getClientRects().length === 0` drops display:none / detached nodes, but
    // svg descendants legitimately report no rects and stay focusable, so they
    // are exempt (unchanged from the original).
    if (n.getClientRects().length === 0 && !n.matches("svg, svg *")) return; // visually hidden
    // `visibility: hidden` elements are unfocusable — including them would make
    // Tab "wrap" onto a node the browser refuses to focus, silently dropping
    // focus to <body>. (`aria-hidden`/`inert` subtrees are NOT skipped: the
    // focusable list is also the caller's own fallback, and the real modals use
    // aria-hidden decoratively on siblings, not on their controls.)
    if (getComputedStyle(n).visibility === "hidden") return;
    list.push(n);
  });
  return list;
}

/* -------------------------------------------------------------------------- */
/* Trap stack                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Ids of currently active traps, in activation order (last = top-most modal).
 * Module-level because the traps live in unrelated component subtrees and must
 * agree on exactly one "top" — context would require a provider change to the
 * frozen AppProviders.
 */
const trapStack: number[] = [];
/** Monotonic id source; only ordering matters, never value reuse. */
let nextTrapId = 1;

/**
 * Run `fn` only when `id` owns the top of the stack. A trap that is not on top
 * is underneath another modal and must stay inert (the top one owns the keys).
 */
function withTopTrap(id: number, fn: () => void): void {
  if (trapStack[trapStack.length - 1] !== id) return;
  fn();
}

/**
 * The element that should receive focus when a dialog opens: the dialog shell
 * itself, or — when the shell is not focusable — its first real control, so a
 * dialog always starts inside itself.
 */
function focusInitial(container: HTMLElement): void {
  container.focus();
  if (document.activeElement !== container) {
    const first = focusableWithin(container)[0];
    first?.focus();
  }
}

export function useFocusTrap(
  ref: FocusableRef,
  active: boolean,
  onClose: () => void,
  restoreTo?: FocusableRef | null
): void {
  /** Element focused before this dialog opened — where close returns focus. */
  const returnToRef = useRef<HTMLElement | null>(null);

  /**
   * Keep the latest `onClose` in a ref. Consumers pass inline arrows
   * (`Modal` does), and putting that callback in the effect deps would tear the
   * trap down and re-create it on every render — releasing and re-grabbing
   * focus mid-dialog, which visibly yanks focus off the button the user is on.
   */
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!active) return;
    const dialog = ref.current;

    // Pin the focus-return target NOW (before we move focus ourselves). The ref
    // holds it across renders without being a dep, so the drawers (which
    // re-render on every progress tick) never re-run this effect and never
    // re-grab focus mid-dialog.
    const explicit = restoreTo?.current ?? null;
    const entry = document.activeElement;
    let target: HTMLElement | null = explicit;
    if (!target && entry instanceof HTMLElement && entry !== document.body) {
      target = entry;
    }
    returnToRef.current = target;

    if (dialog) focusInitial(dialog);

    const id = nextTrapId++;
    trapStack.push(id);

    const onKeyDown = (e: KeyboardEvent) => {
      withTopTrap(id, () => {
        if (e.key === "Escape") {
          e.preventDefault();
          // A SECOND Escape arriving in the same keystroke path (a nested input's
          // own handler) must not close the layer underneath too.
          e.stopPropagation();
          onCloseRef.current();
          return;
        }
        if (!dialog || e.key !== "Tab") return;

        // Trap Tab within the dialog: wrap between the first and last focusable
        // element so focus can never escape into the page behind the modal.
        const tabbables = focusableWithin(dialog);
        if (tabbables.length === 0) {
          // Nothing focusable inside: keep focus on the shell instead of letting
          // the browser move it out of the dialog into the page behind it.
          e.preventDefault();
          dialog.focus();
          return;
        }
        const first = tabbables[0];
        const last = tabbables[tabbables.length - 1];
        const current = document.activeElement as HTMLElement | null;

        if (e.shiftKey) {
          // Shift+Tab off the first element (or from the shell/outside) wraps to
          // the last. The shell is the natural start position after opening, so
          // wrapping from it keeps Shift+Tab inside instead of escaping backwards.
          if (current === first || current === dialog || !dialog.contains(current)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          // Tab off the last element (or from the shell/outside) wraps to first.
          if (current === last || current === dialog || !dialog.contains(current)) {
            e.preventDefault();
            first.focus();
          }
        }
      });
    };

    // Capture phase on document: sees the key before any React handler can
    // swallow it (see the module header), and works for portals.
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Drop this trap from the stack so the layer underneath becomes top-most.
      const at = trapStack.lastIndexOf(id);
      if (at !== -1) trapStack.splice(at, 1);

      // Restore focus to the element that opened the dialog (or the supplied
      // target) so the next Tab press continues where the user left off, instead
      // of dropping to <body>/document-top.
      const returnTo = returnToRef.current;
      returnToRef.current = null;
      if (!returnTo || typeof returnTo.focus !== "function") return;
      // Only restore when focus is still inside this dialog (or nowhere). If the
      // user has since focused something else — a nested menu that handed focus
      // onward, or the modal that just opened above us — leave it alone.
      const current = document.activeElement;
      const stillOurs =
        current === null ||
        current === document.body ||
        current === document.documentElement ||
        (dialog !== null && (current === dialog || dialog.contains(current)));
      if (!stillOurs) return;
      // A return target still sitting under an aria-modal layer (the queue
      // drawer over the app, say) would move focus into an inert surface from
      // the AT's point of view — skip rather than fight the layer above.
      if (returnTo.closest('[aria-modal="true"]') !== null) return;
      try {
        returnTo.focus();
      } catch {
        // A focus target can vanish (e.g. unmounted); skipping is safe.
      }
    };
    // `onClose` deliberately omitted (kept in a ref above); `ref` and
    // `restoreTo` are stable ref objects owned by the consumer.
  }, [active, ref, restoreTo]);
}
