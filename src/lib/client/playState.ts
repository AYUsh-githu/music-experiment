"use client";

import { useSyncExternalStore } from "react";

/**
 * playState — a tiny external store for "is audio currently playing?".
 *
 * WHY this exists: `Shell` is the server-side app frame that RENDERS
 * `AppProviders` as a child, so `Shell` sits ABOVE the PlayerProvider and
 * cannot call `usePlayer()` (that throws by design, and it made every route —
 * including the static `/_not-found` — fail to prerender). But the Shell's
 * brand mark still wants to animate its waveform while music plays.
 *
 * So the provider-side `PlayStateSync` publishes the flag here and the Shell
 * subscribes with `useSyncExternalStore` — a one-way, render-safe channel with
 * no context dependency and no server snapshot hazard (the server always sees
 * `false`, which is exactly what the SSR markup renders).
 *
 * This never touches playback logic; it only mirrors a boolean outward.
 */

let playing = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

/** Provider-side publish (called by PlayStateSync inside PlayerProvider). */
export function setPlayState(next: boolean): void {
  if (next === playing) return;
  playing = next;
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => playing;
/** SSR + first client render: never animating (matches the static markup). */
const getServerSnapshot = () => false;

/** Shell-side read: true while audio is playing anywhere in the app. */
export function useIsPlaying(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
