/**
 * View Transitions API helper (frontend.md §3.3) — feature-guarded.
 *
 * Wraps a navigation callback in `document.startViewTransition` when the
 * browser supports it (Chrome 111+, Edge 111+, Safari 18+, Firefox 141+); on
 * older browsers the callback runs directly and the existing template.tsx
 * framer fade stays the only transition, so behavior is unchanged there.
 *
 * WHY a helper and not inline: the only route-change seam this workstream owns
 * is template.tsx (pages re-mount on navigation, so the incoming page can FADE
 * IN on mount). Wiring VT into every <Link> click would require editing
 * navigation plumbing (Shell's Link elements / router calls) — outside this
 * agent's file list — so per §3.3's instruction the helper + template
 * integration is what ships; the globals.css ::view-transition rules style the
 * browser-generated crossfade whenever one does run.
 *
 * Escape hatch handled here: starting a VT while one is already running is
 * skipped (the spec auto-skips but logging-free no-op keeps devtools clean).
 * SSR safety: `document` does not exist during a server render — the typeof
 * guard makes the module importable anywhere.
 */

/** Whether the current browser supports same-document view transitions. */
export function supportsViewTransitions(): boolean {
  return typeof document !== "undefined" && "startViewTransition" in document;
}

/**
 * Run `cb` inside a view transition when supported; otherwise run it directly.
 * `cb` must perform the DOM/navigation update (the VT snapshot pauses paint
 * until the callback completes).
 */
export function navigateWithTransition(cb: () => void): void {
  // Non-browser or unsupported browser: existing behavior, zero risk.
  if (!supportsViewTransitions()) {
    cb();
    return;
  }
  // Feature-present: let the browser crossfade old/new states. An in-flight
  // transition auto-skips the new one per spec; we don't queue.
  document.startViewTransition(() => cb());
}
