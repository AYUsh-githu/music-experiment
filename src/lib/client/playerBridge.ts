import type { Track } from "@/lib/types";

/**
 * Player bridge.
 *
 * WHY this module exists: the search UI lives in a different part of the tree
 * from the player provider, and we don't want every component that triggers
 * playback to import (and therefore couple to) the provider. Instead, the
 * provider registers a single play handler here on mount; any UI can call
 * `requestPlay(track)` to route playback through the one shared <audio>.
 */

/** Registered by <PlayerProvider> on mount so UI can trigger playback. */
export let playHandler: ((t: Track) => void) | null = null;

/** Called by the provider once it is mounted and ready to receive play requests. */
export function bindPlayHandler(fn: (t: Track) => void) {
  playHandler = fn;
}

/** Called by the provider on unmount so stale handlers never fire. */
export function unbindPlayHandler() {
  playHandler = null;
}

/**
 * Ask the player to start playing a track. Safe to call from anywhere; no-ops
 * (with a warning) if the provider has not yet registered a handler.
 *
 * WHY a warning instead of throwing: a click that races provider mount should
 * degrade silently in production rather than crash the page, while still
 * surfacing the miss in the console during development.
 */
export function requestPlay(track: Track) {
  if (playHandler) {
    playHandler(track);
  } else {
    console.warn("player not ready", track?.title ?? "unknown");
  }
}

/* -------------------------------------------------------------------------- */
/* Queue bridge                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Registered by <PlayerProvider> on mount so UI (e.g. a "play all" row, the
 * queue drawer) can start an entire queue in one call instead of playing a
 * single track.
 *
 * WHY a queue handler is separate from `playHandler`: a queue push carries two
 * pieces of data (the ordered tracks + where to start), which doesn't fit the
 * single-track play function's signature. Requesting a queue with no registered
 * handler falls back to playing just the requested index track, so consumers
 * don't need to special-case "is the provider mounted."
 */
export let queueHandler: ((tracks: Track[], index: number) => void) | null = null;

/** Called by the provider once it is mounted and ready to accept queue pushes. */
export function bindQueueHandler(fn: (tracks: Track[], index: number) => void) {
  queueHandler = fn;
}

/** Called by the provider on unmount so stale handlers never fire. */
export function unbindQueueHandler() {
  queueHandler = null;
}

/**
 * Ask the player to adopt a queue starting at `index`. Safe to call from
 * anywhere. Falls back to single-track playback of `tracks[index]` when the
 * provider has not registered a queue handler — the least-surprising behavior
 * for "play this list" racing provider mount.
 */
export function requestPlayQueue(tracks: Track[], index: number) {
  if (queueHandler) {
    queueHandler(tracks, index);
  } else {
    const t = tracks[index];
    if (t) requestPlay(t);
  }
}
