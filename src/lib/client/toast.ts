/**
 * Global toast/notification store (Phase 5 §5.2).
 *
 * A tiny, SSR-safe, synchronous toast store modelled on src/lib/client/settings.ts:
 * a module-level array of active toasts + a subscriber set, consumed by a
 * `useSyncExternalStore` hook so <Toaster/> re-renders when a toast is added or
 * dismissed.
 *
 * WHY not React state: toasts are fired from anywhere (effects, non-component
 * code paths like audio event listeners and stream-resolution async), so they
 * need a store that lives outside the React tree. `useSyncExternalStore` then
 * bridges that store into the component that renders them.
 *
 * WHY SSR-safe: `window` doesn't exist during a server render, so every side
 * effect (schedule-a-timeout) is guarded; the store itself is plain data.
 *
 * Contract:
 *   toast.info(msg) / toast.success(msg) / toast.error(msg)  — one-shot helpers
 *   useToasts()  — returns active {id,type,message}[] for <Toaster/>
 *   toastStore.dismiss(id) — explicit close (manual button, programmatic)
 */

import { useMemo, useSyncExternalStore } from "react";

/** Toast visual variant. "error" maps to an assertive live region (role="alert");
 *  the rest are polite (role="status"). */
export type ToastType = "info" | "success" | "error";

/** A single active toast as rendered by <Toaster/>. */
export interface Toast {
  /** Stable id so dismiss targets the right toast and React keys it. */
  id: number;
  type: ToastType;
  message: string;
}

/** How many toasts may coexist; oldest are dropped first when over the cap. */
const MAX_TOASTS = 4;

/** Default auto-dismiss delay; errors linger a little longer so they're read. */
const DEFAULT_DURATION = 4000;
const ERROR_DURATION = 6000;

/** Module-level monotonic id counter — stable across renders, never duplicated. */
let nextId = 1;

/** Stable empty snapshot for the server render — a fresh [] each call would give
 *  useSyncExternalStore a new reference every acquisition and trigger a hydration
 *  mismatch on the server snapshot. */
const EMPTY_TOASTS: Toast[] = [];

/** Current snapshot of active toasts (source of truth for SSR & first paint). */
let current: Toast[] = [];

/** Subscribers re-render via useSyncExternalStore when the list changes. */
const listeners = new Set<() => void>();

/** Timers keyed by toast id so a manual dismiss can cancel its auto-dismiss. */
const timers = new Map<number, ReturnType<typeof setTimeout>>();

/**
 * Remaining lifetime (ms) for a toast whose auto-dismiss is currently paused,
 * plus the wall-clock instant it was paused. A paused toast has no setTimeout
 * pending (we cleared it), so we remember how much of its life was left and
 * re-arm a fresh timer on resume. Kept per id so several toasts can be paused
 * independently (each held hover only pauses its own toast).
 */
const paused = new Map<number, { remaining: number; pausedAt: number }>();

/** The lifespan a given toast type gets, mirroring push()'s choice so a paused
 *  toast resumes with its ORIGINAL budget, not a defaulted one. */
const lifetimes = new Map<number, number>();

/**
 * Wall-clock instant each live timer was armed (and re-armed on resume).
 *
 * WHY this exists: `pauseToast` needs "how much of the life is left", which is
 * lifetime minus elapsed. Without a start instant it could only GUESS, and the
 * old guess (`lifetime / 2`) meant hovering a toast for a moment restored a
 * fixed half-budget instead of the true remainder — a 1s-hovered 4s toast was
 * given 2s, and a toast hovered at 3.9s was resurrected with 2s. Tracking the
 * start instant makes the pause/resume cycle lossless.
 */
const startedAt = new Map<number, number>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Always return a fresh array so useSyncExternalStore sees a changed snapshot
 *  and re-renders — a hidden trap is returning the same array reference. */
function getSnapshot(): Toast[] {
  return current;
}

/* -------------------------------------------------------------------------- */
/* Store API                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Notify subscribers after any mutation. Must be called with the NEW snapshot
 * already assigned to `current`.
 */
function emit(): void {
  for (const fn of listeners) fn();
}

/**
 * Remove a toast by id if present, cancelling its pending auto-dismiss. Safe to
 * call for an already-removed id (no-op). Never throws.
 */
export function dismiss(id: number): void {
  const timer = timers.get(id);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(id);
  }
  // Clear any pause bookkeeping so a dismissed id can't leak entries.
  paused.delete(id);
  lifetimes.delete(id);
  startedAt.delete(id);
  if (!current.some((t) => t.id === id)) return; // already gone
  current = current.filter((t) => t.id !== id);
  emit();
}

/**
 * Add a toast and schedule its auto-dismissal.
 *
 * WHY drop oldest when over the cap: a burst of errors (e.g. several tracks
 * failing source-failover at once) must not flood the screen; keeping the cap
 * low keeps the stack readable and the live region from spewing indefinitely.
 */
export function push(type: ToastType, message: string): void {
  if (!message) return; // never show an empty toast
  const id = nextId++;
  current = [...current, { id, type, message }];
  if (current.length > MAX_TOASTS) {
    // Drop the oldest by canceling its timer and removing it.
    const dropped = current[0];
    if (dropped) dismiss(dropped.id);
  }
  emit();

  // Auto-dismiss after a short delay. Guarded so an SSR caller (no timers
  // guaranteed) can't throw — the setTimeout simply may not run, which is fine;
  // the toast stays until manually dismissed or overridden by the cap.
  try {
    const duration = type === "error" ? ERROR_DURATION : DEFAULT_DURATION;
    lifetimes.set(id, duration);
    startedAt.set(id, Date.now());
    const timer = setTimeout(() => {
      dismiss(id);
    }, duration);
    timers.set(id, timer);
  } catch {
    // No timer available (unusual environment): nothing throws, no auto-dismiss.
  }
}

/**
 * Freeze a toast's auto-dismiss countdown (F14 sub-item).
 *
 * WHY at the store and not just CSS: the hairline is only a VISUAL of a real
 * setTimeout. Pausing the CSS alone would let the store dismiss the toast while
 * the bar still looked half-full, which reads as a bug. So we cancel the live
 * timer and remember what was left; `resumeToast` re-arms the remainder.
 *
 * Idempotent: pausing an already-paused (or unknown) id is a no-op.
 */
export function pauseToast(id: number): void {
  if (paused.has(id)) return; // already frozen
  const timer = timers.get(id);
  const lifetime = lifetimes.get(id);
  if (timer === undefined || lifetime === undefined) return; // nothing to pause
  clearTimeout(timer);
  timers.delete(id);
  // Remaining = full lifetime minus however long it had already been running,
  // measured from the instant the timer was armed. The 600ms floor only guards
  // against a resume landing on a near-zero remainder (which would look like an
  // instant dismissal the user did not ask for); it is no longer a stand-in for
  // real elapsed time.
  const started = startedAt.get(id);
  const elapsed = started === undefined ? 0 : Date.now() - started;
  const remaining = Math.max(600, lifetime - elapsed);
  paused.set(id, { remaining, pausedAt: Date.now() });
}

/**
 * Un-freeze a paused toast's countdown. Re-arms a fresh timer for the remaining
 * life recorded by `pauseToast`. Idempotent for ids that are not paused.
 */
export function resumeToast(id: number): void {
  const entry = paused.get(id);
  if (!entry) return;
  paused.delete(id);
  try {
    const timer = setTimeout(() => {
      dismiss(id);
    }, entry.remaining);
    timers.set(id, timer);
    // Re-arm the elapsed clock too: the new timer starts its countdown NOW, so
    // a later pause must measure from here. Without this a second hover would
    // subtract the time since the toast was first created (including the paused
    // span) and collapse the remainder to the 600ms floor.
    startedAt.set(id, Date.now());
  } catch {
    // No timer available: leave the toast up rather than throw.
  }
}

/* -------------------------------------------------------------------------- */
/* Convenience helpers                                                        */
/* -------------------------------------------------------------------------- */

/** Named variants so call sites read as intent rather than a bare type string. */
export const toast = {
  info(msg: string) {
    push("info", msg);
  },
  success(msg: string) {
    push("success", msg);
  },
  error(msg: string) {
    push("error", msg);
  },
};

/**
 * Reactive toast hook for <Toaster/>. Returns the list of active toasts and
 * re-renders the component whenever it changes. SSR returns a stable empty
 * array so the portal mounts nothing on the server.
 */
export function useToasts(): Toast[] {
  return useSyncExternalStore(
    subscribe,
    getSnapshot,
    () => EMPTY_TOASTS // SSR snapshot: stable reference, render no toasts on the server
  );
}

/**
 * Convenience wrapper so a caller (the toast card) can hold a countdown with a
 * single pair of handlers, rather than importing pause/resume and wiring the id
 * in two places. Returns props to spread onto the toast's root element.
 *
 * WHY a hook for two functions: it keeps `aria`-free, plain-object handlers
 * stable across renders, and documents the intent ("this surface holds its own
 * countdown") at the one call site that needs it.
 */
export function useToastHold(id: number): {
  onPointerEnter: () => void;
  onPointerLeave: () => void;
  onFocus: () => void;
  onBlur: () => void;
} {
  return useMemo(
    () => ({
      onPointerEnter: () => pauseToast(id),
      onPointerLeave: () => resumeToast(id),
      onFocus: () => pauseToast(id),
      onBlur: () => resumeToast(id),
    }),
    [id]
  );
}
