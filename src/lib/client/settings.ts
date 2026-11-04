/**
 * Client-side app settings store (Phase 4 §4.3).
 *
 * A tiny synchronous, localStorage-backed store for non-library user
 * preferences (playback quality, artwork size, radio). Unlike the library
 * (which lives in IndexedDB), these are flat values that benefit from a
 * synchronous read at module-charge time, so localStorage is the right store.
 *
 * WHY SSR-safe: `window` / `localStorage` do not exist during a server render.
 * Every access is guarded; on any failure we fall back to DEFAULT_SETTINGS and
 * re-merge writes against the defaults so a partial/corrupt payload never
 * yields an AppSettings that violates the shape contract.
 *
 * Subscribing: components use `useAppSettings()` (a `useSyncExternalStore`
 * hook) so they re-render whenever `setSettings` fires. The subscriber set is
 * intentionally tiny (a plain Set) — there is at most one live consumer (the
 * Settings page) today.
 */

import { useSyncExternalStore } from "react";

/** User-controllable app preferences. Shape is the public contract. */
export interface AppSettings {
  /** Stream quality for playback. */
  quality: "best" | "low";
  /** Preferred artwork tile size in lists. */
  artworkSize: "small" | "large";
  /** Auto-play the next track when the current one ends. */
  radio: boolean;
}

/** Safe starting point used whenever stored JSON is missing or corrupt. */
export const DEFAULT_SETTINGS: AppSettings = {
  quality: "best",
  artworkSize: "large",
  radio: true,
};

/** Fixed storage key so multiple sessions read/write the same slot. */
const STORAGE_KEY = "sonic:app-settings";

/* -------------------------------------------------------------------------- */
/* Storage primitives (guarded for SSR / blocked storage)                      */
/* -------------------------------------------------------------------------- */

/**
 * Read the stored settings and merge onto the defaults.
 *
 * Ordering: defaults <- stored parsed object. Merge-first also means an older
 * stored payload missing a newer field falls back to that field's default —
 * `radio`, added later, never ends up `undefined`.
 *
 * Returns DEFAULT_SETTINGS (a copy) on any failure. Never throws.
 */
function readFromStorage(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    // Merge stored over defaults so unknown/missing keys are dropped to safe values.
    return { ...DEFAULT_SETTINGS, ...(parsed ?? {}) };
  } catch {
    // Corrupt JSON, blocked storage, SSR: fall back to defaults without throwing.
    return { ...DEFAULT_SETTINGS };
  }
}

/** True only when the environment actually has localStorage to read (browser). */
function hasStorage(): boolean {
  try {
    return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
  } catch {
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Store (module-level singleton)                                              */
/* -------------------------------------------------------------------------- */

/** Current in-memory snapshot; the source of truth for SSR & first paint. */
let current = hasStorage() ? readFromStorage() : { ...DEFAULT_SETTINGS };

/** Stable server snapshot (referentially constant) for useSyncExternalStore's
 *  getServerSnapshot. A fresh object-per-call here would violate the referential
 *  stability contract and force a hydration-repair re-render on every initial
 *  load (final audit finding). */
const SSR_SNAPSHOT: AppSettings = { ...DEFAULT_SETTINGS };

/** Subscribers re-render via useSyncExternalStore when settings change. */
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * When settings change in ANOTHER tab, the browser fires a `storage` event on
 * this tab; re-reading the persisted value keeps multiple open tabs in sync
 * instead of letting a stale tab's next write silently clobber the update
 * (last-writer-wins). Guarded for SSR where window may not exist. Nested in a
 * try so any environment without a real listener can never throw.
 */
function initCrossTabSync(): void {
  try {
    if (typeof window === "undefined") return;
    window.addEventListener("storage", (e) => {
      // Only our key matters — ignore every other storage slot.
      if (e.key !== null && e.key !== STORAGE_KEY) return;
      const fresh = readFromStorage();
      current = fresh;
      for (const fn of listeners) fn();
    }, false);
  } catch {
    // No window/listener support in this environment: cross-tab sync is skipped.
  }
}
initCrossTabSync();

/** Recreate the page-visible snapshot to signal a change to useSyncExternalStore. */
function getSnapshot(): AppSettings {
  return current;
}

/**
 * Sync read of the current settings. Safe anywhere (SSR included, where it
 * returns the defaults). Reflects the latest persisted value once hydrated.
 */
export function getSettings(): AppSettings {
  return current;
}

/**
 * Merge a partial update into the settings, persist it, and notify subscribers.
 *
 * Only known keys are written — unknown fields in the patch are ignored so the
 * stored shape never drifts from AppSettings. Persistence is best-effort: if
 * storage is unavailable the in-memory value still updates (and subscribers
 * still re-render) for the lifetime of the tab.
 */
export function setSettings(patch: Partial<AppSettings>): void {
  const next = { ...current, ...patch };
  // Drop any keys that aren't part of AppSettings.
  current = {
    quality: next.quality,
    artworkSize: next.artworkSize,
    radio: next.radio,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(current));
  } catch {
    // Non-persistent (SSR hydrate, blocked quota): in-memory value still wins.
  }
  for (const fn of listeners) fn();
}

/**
 * Reactive settings hook. Returns a [settings, setter] pair like useState, but
 * backed by the global store so the Settings page and (future) the player can
 * observe the same values and re-render on change.
 */
export function useAppSettings(): [AppSettings, (patch: Partial<AppSettings>) => void] {
  // getServerSnapshot must return a STABLE reference — a fresh object per call
  // breaks React hydration reconciliation (referential-instability churn).
  const settings = useSyncExternalStore(subscribe, getSnapshot, () => SSR_SNAPSHOT);
  return [settings, setSettings];
}
