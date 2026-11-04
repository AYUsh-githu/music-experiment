"use client";

/**
 * Global player: Context + reducer over a single shared <audio> element.
 *
 * WHY the audio lives here (not scattered per page): every route renders the
 * same provider in the root layout, so one <audio> element survives route
 * changes and playback continues uninterrupted while navigating.
 *
 * WHY a useReducer instead of several useState hooks: the player's state
 * transitions (queue, index, repeat, shuffle) have real interdependencies
 * (e.g. NEXT must wrap around the queue respecting repeat, and removing the
 * current track must re-point the index), and a reducer keeps all of that
 * logic in one pure, testable place.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import type { RepeatMode, Track, TrackId } from "@/lib/types";
import {
  bindPlayHandler,
  unbindPlayHandler,
  bindQueueHandler,
  unbindQueueHandler,
} from "./playerBridge";
import { recordPlay, getHistory } from "./db";
import { useAppSettings } from "./settings";
import { toast } from "./toast";

/* -------------------------------------------------------------------------- */
/* State & actions                                                            */
/* -------------------------------------------------------------------------- */

interface PlayerState {
  queue: Track[];
  currentIndex: number; // -1 when nothing loaded
  repeat: RepeatMode;
  shuffle: boolean;
  ready: boolean; // true once audio has started playing
  playing: boolean;
  duration: number; // seconds
  progress: number; // seconds
  error: string | null;
  loadedTrack: Track | null; // the track currently bound to <audio> src
  /** Retry nonce: bumping it re-fires the stream-resolution effect after an
   *  error, so a failed stream can be retried by the user (see togglePlay). */
  streamAttempt: number;
  /** Whether the FullPlayer view is open. Session-only (never persisted). */
  nowPlayingOpen: boolean;
  /** true when the CURRENTLY-bound stream is a ~30s preview (iTunes fallback),
   *  not the full song. Derived from the LAST /api/stream response so it stays
   *  honest as tracks change — see SET_PREVIEW. Transient, never persisted. */
  isPreview: boolean;
  /** Output gain 0..1 for the shared <audio> element. Persisted so a user's
   *  preferred loudness survives reloads (see VOLUME_STORAGE_KEY). */
  volume: number;
  /** Mute flag for the shared <audio> element. Persisted alongside volume. */
  muted: boolean;
}

type PlayerAction =
  | { type: "PLAY_TRACK"; track: Track }
  | { type: "PLAY_QUEUE"; tracks: Track[]; index: number }
  | { type: "SET_QUEUE"; queue: Track[]; currentIndex: number }
  | { type: "ADD_TO_QUEUE"; track: Track }
  | { type: "PLAY_NEXT"; track: Track }
  | { type: "REMOVE_FROM_QUEUE"; index: number }
  | { type: "MOVE_IN_QUEUE"; from: number; to: number }
  | { type: "SET_REPEAT"; repeat: RepeatMode }
  | { type: "CYCLE_REPEAT" }
  | { type: "TOGGLE_SHUFFLE" }
  | { type: "TOGGLE_PLAY" }
  | { type: "SEEK"; seconds: number }
  | { type: "NEXT" }
  | { type: "PREV" }
  | { type: "RADIO_SEEDS"; seeds: Track[] }
  | { type: "SET_PROGRESS"; progress: number }
  | { type: "SET_DURATION"; duration: number }
  | { type: "SET_READY" }
  | { type: "SET_ERROR"; message: string }
  | { type: "RETRY_STREAM" }
  | { type: "OPEN_PLAYER" }
  | { type: "CLOSE_PLAYER" }
  | { type: "SET_PREVIEW"; isPreview: boolean }
  | { type: "SET_VOLUME"; volume: number }
  | { type: "TOGGLE_MUTE" }
  | { type: "RESTORE_VOLUME"; volume: number; muted: boolean };

/** Initial state — nothing loaded until the persisted snapshot is restored. */
const initialState: PlayerState = {
  queue: [],
  currentIndex: -1,
  repeat: "off",
  shuffle: false,
  ready: false,
  playing: false,
  duration: 0,
  progress: 0,
  error: null,
  loadedTrack: null,
  streamAttempt: 0,
  nowPlayingOpen: false,
  isPreview: false,
  volume: 1,
  muted: false,
};

/** Persisted slice; derived from QueueState so it matches what we save. */
interface PersistedSnapshot {
  queue: Track[];
  currentIndex: number;
  repeat: RepeatMode;
  shuffle: boolean;
}

const STORAGE_KEY = "sonic.player.v1";
/** Persisted loudness preference key. The spec (§ WS1 / F10) mandates `sonic.volume`;
 *  the previous key `sonic.player.volume.v1` is still read as a migration
 *  fallback so an existing user keeps their saved volume, but only the new key
 *  is written. */
const VOLUME_STORAGE_KEY = "sonic.volume";
/** Legacy key retained purely for a one-time read fallback. */
const LEGACY_VOLUME_STORAGE_KEY = "sonic.player.volume.v1";
/** Fired on the window after a play is recorded to history, so surfaces that
 *  render "recently played" (HomeView) can refresh without polling (defect 9). */
export const LIBRARY_UPDATED_EVENT = "sonic:library-updated";

/** Load {volume,muted} from localStorage, clamping to valid ranges. Best-effort:
 *  any failure (blocked storage, corrupt JSON) falls back to the defaults.
 *  Reads the new `sonic.volume` key first, then falls back to the legacy
 *  `sonic.player.volume.v1` key so a pre-upgrade user keeps their volume. */
function loadVolumePref(): { volume: number; muted: boolean } {
  try {
    const raw =
      window.localStorage.getItem(VOLUME_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_VOLUME_STORAGE_KEY);
    if (!raw) return { volume: 1, muted: false };
    const parsed = JSON.parse(raw) as { volume?: unknown; muted?: unknown };
    const volume =
      typeof parsed.volume === "number"
        ? Math.min(1, Math.max(0, parsed.volume))
        : 1;
    const muted = parsed.muted === true;
    return { volume, muted };
  } catch {
    return { volume: 1, muted: false };
  }
}

/** Wrap IndexedDB/localStorage access so a blocked/quirked browser can't crash the player. */
function loadPersistedSnapshot(): PersistedSnapshot | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      Array.isArray((parsed as PersistedSnapshot).queue)
    ) {
      return parsed as PersistedSnapshot;
    }
    return null;
  } catch {
    return null;
  }
}

const REPEAT_CYCLE: RepeatMode[] = ["off", "all", "one"];

/** Upper bound for the stream-prefetch cache so it cannot grow unbounded (plan §5.2). */
const PREFETCH_CACHE_MAX = 8;

/** Max seeds radio appends per queue fill (plan §4.1). */
const RADIO_SEED_CAP = 15;

/**
 * Pick a random queue index that is not `current`, if one is available.
 *
 * WHY this helper exists apart from sequential advance: shuffle's contract is
 * "never immediately repeat the same track", so it needs its own draw. A queue
 * of length 1 has no alternative, so it falls back to `current` (replay).
 */
function pickRandomIndex(current: number, length: number): number {
  if (length <= 0) return -1;
  if (length === 1) return 0;
  let idx = current;
  while (idx === current) idx = Math.floor(Math.random() * length);
  return idx;
}

/**
 * Resolve where a forward advance (user NEXT or auto-advance) should land.
 * Returns the target index, or -1 to signal "stop" (repeat off, past the end).
 *
 * - shuffle ON: random index != current (no immediate repeat), looping forever.
 * - shuffle OFF: sequential; wrap to 0 when repeat is 'all', stay put for 'one',
 *   and stop (-1) when repeat is 'off' and we've passed the end.
 */
function computeForwardIndex(
  current: number,
  length: number,
  repeat: RepeatMode,
  shuffle: boolean
): number {
  if (length === 0) return -1;
  if (shuffle) return pickRandomIndex(current, length);
  const next = current + 1;
  if (next < length) return next;
  // Wrapped past the end.
  if (repeat === "all") return 0;
  if (repeat === "one") return current; // replay same track
  return -1; // repeat "off" → stop
}

function reducer(state: PlayerState, action: PlayerAction): PlayerState {
  switch (action.type) {
    case "PLAY_TRACK": {
      // Replace the queue with a single-track queue on a fresh manual play.
      // WHY: a search-result click is a brand-new listening session.
      return {
        ...state,
        queue: [action.track],
        currentIndex: 0,
        loadedTrack: action.track,
        progress: 0,
        duration: action.track.duration || 0,
        playing: true,
        ready: false,
        error: null,
      };
    }

    case "PLAY_QUEUE": {
      // Adopt a whole queue and start at `index`. We set loadedTrack explicitly
      // so the existing stream-resolution effect re-fires for the new track.
      const inRange =
        action.index >= 0 && action.index < action.tracks.length;
      const track = inRange ? action.tracks[action.index] : null;
      return {
        ...state,
        queue: action.tracks,
        currentIndex: action.index,
        loadedTrack: track,
        progress: 0,
        duration: track ? track.duration || 0 : 0,
        playing: !!track,
        ready: false,
        error: null,
      };
    }

    case "SET_QUEUE": {
      // Adopt an externally-provided queue (e.g. restored from storage).
      // playing:false — a reload happens outside a user gesture, so the browser
      // blocks autoplay here. We leave the mini-player paused and let the user's
      // first play tap (a gesture) trigger audio.play() via the play/pause effect.
      return {
        ...state,
        queue: action.queue,
        currentIndex: action.currentIndex,
        loadedTrack:
          action.currentIndex >= 0 && action.currentIndex < action.queue.length
            ? action.queue[action.currentIndex]
            : null,
        progress: 0,
        playing: false,
        ready: false,
        error: null,
      };
    }

    case "ADD_TO_QUEUE": {
      // Append to the end. Duplicates are allowed (a user may want the same
      // song twice in a playlist); dedupe is intentionally not required.
      return { ...state, queue: [...state.queue, action.track] };
    }

    case "PLAY_NEXT": {
      // Insert the track right after the current one so it plays next.
      // With nothing loaded (currentIndex -1), it lands at the front.
      const insertAt = state.currentIndex < 0 ? 0 : state.currentIndex + 1;
      const q = [...state.queue];
      q.splice(insertAt, 0, action.track);
      return { ...state, queue: q };
    }

    case "REMOVE_FROM_QUEUE": {
      const idx = action.index;
      if (idx < 0 || idx >= state.queue.length) return state;
      const q = state.queue.filter((_, i) => i !== idx);
      if (idx < state.currentIndex) {
        // Removing a track before the current one shifts the current index left.
        return { ...state, queue: q, currentIndex: state.currentIndex - 1 };
      }
      if (idx > state.currentIndex) {
        // Removing a track after the current one leaves the index untouched.
        return { ...state, queue: q };
      }
      // Removed the track that is currently playing: empty queue → stop cleanly;
      // otherwise auto-advance to the track now sitting at this index.
      if (q.length === 0) {
        return {
          ...state,
          queue: q,
          currentIndex: -1,
          loadedTrack: null,
          playing: false,
          ready: false,
          progress: 0,
        };
      }
      const ci = Math.min(state.currentIndex, q.length - 1);
      return {
        ...state,
        queue: q,
        currentIndex: ci,
        loadedTrack: q[ci],
        progress: 0,
        ready: false,
        playing: state.playing, // preserve play intent — removing the current track
        // must not force playback while paused (Bug #12).
      };
    }

    case "MOVE_IN_QUEUE": {
      const from = action.from;
      const to = action.to;
      const q = [...state.queue];
      if (from < 0 || from >= q.length || to < 0 || to >= q.length || from === to) {
        return state;
      }
      const [item] = q.splice(from, 1);
      q.splice(to, 0, item);
      // Re-point currentIndex so it keeps tracking the SAME track after reorder.
      let ci = state.currentIndex;
      if (ci === from) ci = to;
      else if (from < ci && to >= ci) ci = ci - 1;
      else if (from > ci && to <= ci) ci = ci + 1;
      return { ...state, queue: q, currentIndex: ci };
    }

    case "SET_REPEAT":
      return { ...state, repeat: action.repeat };

    case "CYCLE_REPEAT": {
      // off → all → one → off. Next mode is index of current + 1, wrapped.
      const cur = REPEAT_CYCLE.indexOf(state.repeat);
      const nextMode = REPEAT_CYCLE[(cur + 1) % REPEAT_CYCLE.length];
      return { ...state, repeat: nextMode };
    }

    case "TOGGLE_SHUFFLE":
      return { ...state, shuffle: !state.shuffle };

    case "TOGGLE_PLAY": {
      return { ...state, playing: !state.playing };
    }

    case "SEEK": {
      const clamped = Math.min(Math.max(action.seconds, 0), state.duration || 0);
      return { ...state, progress: clamped };
    }

    case "NEXT": {
      const nextIndex = computeForwardIndex(
        state.currentIndex,
        state.queue.length,
        state.repeat,
        state.shuffle
      );
      if (nextIndex === -1) {
        // Nothing after the end → stop, but keep the current track so the
        // MiniPlayer still has something to show.
        return { ...state, playing: false, progress: 0 };
      }
      const nextTrack = state.queue[nextIndex];
      return {
        ...state,
        currentIndex: nextIndex,
        loadedTrack: nextTrack,
        progress: 0,
        duration: nextTrack.duration || 0,
        ready: false,
        playing: true,
        error: null,
      };
    }

    case "PREV": {
      if (state.queue.length === 0 || state.currentIndex < 0) return state;
      // If we're past the first 3s, "previous" restarts the current track.
      if (state.progress > 3) {
        return { ...state, progress: 0 };
      }
      let targetIdx: number;
      if (state.shuffle) {
        targetIdx = pickRandomIndex(state.currentIndex, state.queue.length);
      } else {
        // Sequential: one step back. Wrap to the last track ONLY when repeat is
        // on ('all'/'one'); with repeat 'off' at the start of the queue, clamp to
        // index 0 instead so the current track reloads (restarts) rather than
        // jumping to the queue's end (Bug #13).
        targetIdx = state.currentIndex - 1;
        if (targetIdx < 0) targetIdx = state.repeat !== "off" ? state.queue.length - 1 : 0;
      }
      const track = state.queue[targetIdx];
      return {
        ...state,
        currentIndex: targetIdx,
        loadedTrack: track,
        progress: 0,
        duration: track.duration || 0,
        ready: false,
        playing: true,
        error: null,
      };
    }

    case "RADIO_SEEDS": {
      // Radio autoplay (plan §4.1): append fetched seeds to the queue and start
      // playing the first new one. Seeding is already deduped client-side before
      // dispatch; the reducer RE-dedupes against the current queue too so a stale
      // or near-concurrent dispatch (the 'ended' listener + a manual NEXT both
      // triggering radio) can never append the same track twice.
      if (action.seeds.length === 0) return state;
      const known = new Set(state.queue.map((t) => t.id));
      const freshSeeds = action.seeds.filter((t) => t && t.id && !known.has(t.id));
      if (freshSeeds.length === 0) return state; // everything already queued
      const q = [...state.queue, ...freshSeeds];
      const firstSeedIndex = state.queue.length; // index of the first appended seed
      const firstSeed = q[firstSeedIndex];
      if (!firstSeed) return state;
      return {
        ...state,
        queue: q,
        currentIndex: firstSeedIndex,
        loadedTrack: firstSeed,
        progress: 0,
        duration: firstSeed.duration || 0,
        ready: false,
        playing: true,
        error: null,
      };
    }

    case "SET_PROGRESS":
      return { ...state, progress: action.progress };

    case "SET_DURATION":
      return { ...state, duration: action.duration };

    case "SET_READY":
      return { ...state, ready: true, error: null };

    case "SET_ERROR":
      return { ...state, error: action.message, playing: false, ready: false };

    case "RETRY_STREAM":
      // Bump the retry nonce so the stream-resolution effect re-fires for the
      // SAME loadedTrack after it failed. WITHOUT this, a SET_ERROR track would
      // be stuck forever: the effect only depends on loadedTrack, which hasn't
      // changed. Clearing `error` + `playing:true` makes the tap that triggers
      // it (a user gesture) also request playback of the re-resolved URL.
      return { ...state, streamAttempt: state.streamAttempt + 1, error: null, playing: true };

    case "OPEN_PLAYER":
      // Open the FullPlayer view. Deliberately session-only: never persisted,
      // so a reload restores the compact mini-player rather than a modal.
      return { ...state, nowPlayingOpen: true };

    case "CLOSE_PLAYER":
      return { ...state, nowPlayingOpen: false };

    case "SET_PREVIEW":
      // Record whether the last-resolved /api/stream for the CURRENT track is a
      // ~30s preview. Derived from the stream response (not per-reducer) so it
      // stays in sync with whichever stream is actually bound to <audio>.
      return { ...state, isPreview: action.isPreview };

    case "SET_VOLUME":
      // Clamp 0..1 and allow muted->unmuted when the user raises volume above
      // zero (a natural expectation: dragging the slider up audibly unmutes).
      return {
        ...state,
        volume: Math.min(1, Math.max(0, action.volume)),
        muted: action.volume > 0 ? false : state.muted,
      };

    case "TOGGLE_MUTE":
      return { ...state, muted: !state.muted };

    case "RESTORE_VOLUME":
      // Rehydrate the persisted loudness on mount (SET_VOLUME and TOGGLE_MUTE
      // are separate because the slider and mute toggle are independent user
      // actions; this one restores BOTH at once from storage). Clamped to keep
      // a corrupt stored value from ever escaping 0..1.
      return {
        ...state,
        volume: Math.min(1, Math.max(0, action.volume)),
        muted: action.muted,
      };

    default:
      return state;
  }
}

/* -------------------------------------------------------------------------- */
/* Context & hook                                                             */
/* -------------------------------------------------------------------------- */

interface PlayerApi {
  // state
  queue: Track[];
  currentTrack: Track | null;
  currentIndex: number;
  repeat: RepeatMode;
  shuffle: boolean;
  ready: boolean;
  playing: boolean;
  duration: number;
  progress: number;
  error: string | null;
  nowPlayingOpen: boolean;
  isPreview: boolean;
  volume: number;
  muted: boolean;
  // actions
  playTrack: (t: Track) => void;
  playQueue: (tracks: Track[], index: number) => void;
  addToQueue: (t: Track) => void;
  playNext: (t: Track) => void;
  removeFromQueue: (index: number) => void;
  moveInQueue: (from: number, to: number) => void;
  toggleRepeat: () => void;
  toggleShuffle: () => void;
  togglePlay: () => void;
  seek: (seconds: number) => void;
  next: () => void;
  prev: () => void;
  nextTrack: () => Track | null;
  openPlayer: () => void;
  closePlayer: () => void;
  /** Set the output gain (0..1). Raising it above 0 also unmutes. */
  setVolume: (volume: number) => void;
  /** Mute/unmute the shared <audio> element. */
  toggleMute: () => void;
}

const PlayerContext = createContext<PlayerApi | null>(null);

interface PlayerProviderProps {
  children: ReactNode;
}

/** Mounts the shared <audio>, wires bridge + persistence, and exposes the player API. */
export function PlayerProvider({ children }: PlayerProviderProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [state, dispatch] = useReducer(reducer, initialState);

  // Live mirror of reducer state for use inside stable event listeners (which
  // otherwise capture a stale closure from their registration render).
  // WHY a ref: the <audio> 'ended'/'timeupdate' handlers are registered once,
  // but must read the current repeat/shuffle/duration at fire time.
  // WHY an effect (not a render-time write): React forbids mutating a ref during
  // render (react-hooks/refs). Updating it after every render keeps listeners
  // that fire later (post-effects) on the latest state.
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  });

  // Live mirror of app settings for use inside stable event listeners, same
  // reasoning as stateRef: the <audio> 'ended' handler is registered once but
  // must read the CURRENT radio/quality preference at fire time.
  const [settings] = useAppSettings();
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  // Client-side cache of resolved stream URLs for tracks we expect to play next
  // (plan §5.2). Keyed by track id -> resolved streamUrl from /api/stream, so an
  // auto-advance or manual NEXT can start instantly instead of waiting on a fetch.
  // WHY a ref: it must be read/written from effects and must never trigger
  // re-renders; the map lives for the lifetime of the provider.
  const prefetchCacheRef = useRef<Map<string, string>>(new Map());

  // Track ids for which a prefetch fetch is CURRENTLY in flight. Guards the
  // 70% prefetch effect (which re-runs ~4x/sec on timeupdate) so it can't
  // launch a duplicate /api/stream request for the same track while one is
  // already resolving — without this the async window floods the server with
  // 4-8 identical requests (fix: prefetch request flood).
  // WHY a ref: read/written synchronously inside the effect, never renders.
  const inFlightPrefetchRef = useRef<Set<TrackId>>(new Set());

  // Track ids already attempted by the prefetch effect this queue session,
  // regardless of outcome. A track that is permanently unavailable would
  // otherwise be re-fetched on every 70% tick forever; this makes each track
  // attempted at most once per queue (fix: retry-loop prevention).
  // WHY a ref: must not trigger re-renders when it changes.
  const prefetchDoneRef = useRef<Set<TrackId>>(new Set());

  // True while the stream-resolution effect is asynchronously fetching/setting
  // a stream for the currently-loaded track. The play/pause effect checks it so
  // a NEXT/PLAY (which flips `playing:true` with a STALE src still bound) never
  // calls audio.play() on the old track — the stream effect owns playback start
  // for a fresh track and plays only after the new src is bound (fix: the
  // previous behavior audibly played the previous track during the load gap).
  // WHY a ref (not state): it must be set/read synchronously across two effects
  // in the same commit without triggering a re-render.
  const streamLoadingRef = useRef(false);

  // True while a radio fetch (radioContinue's /api/related) is in flight.
  // WHY: the queue can reach its end via BOTH the 'ended' listener and a manual
  // NEXT in the same instant; both route through forwardOrRadio -> radioContinue.
  // Without a gate, two concurrent fetches each compute the SAME dedupe set against
  // the pre-dispatch queue and both dispatch RADIO_SEEDS, doubling every seed.
  // The ref re-entrancy guard lets only the first run through to dispatch.
  const radioInFlightRef = useRef(false);

  // Guards against double-recording a single playback start. BOTH the stream
  // effect's play() and the 'playing' DOM event fire around the same start;
  // recordPlay dedupes consecutive entries internally, but this ref makes sure
  // the same track id isn't handed to it twice for one start. It is reset
  // whenever the target track changes so a genuinely new track records again.
  // WHY a ref (not state): it must be read/written from a stable DOM listener
  // without triggering re-renders, and it never needs to drive the UI.
  const recordedPlayIdRef = useRef<string | null>(null);

  // Keep it in sync with the currently-bound track, so a resume of a NEW track
  // (or a replay via repeat) is eligible for recording.
  useEffect(() => {
    if (state.loadedTrack && recordedPlayIdRef.current !== state.loadedTrack.id) {
      recordedPlayIdRef.current = null;
    }
  }, [state.loadedTrack]);

  /* ------------------------- toast dedupe refs (Phase 5 §5.2) ------------------------- */

  // Last error string announced via toast. Streaming failures all reuse the SAME
  // constant message, so we announce only when it actually (re)appears after
  // being cleared — otherwise one error would spam the stack on every re-render.
  const lastErrorToastRef = useRef<string | null>(null);

  // Last track id announced as "now playing", so an unchanged/replayed track
  // never re-fires the confirmation toast.
  const lastNowPlayingIdRef = useRef<string | null>(null);

  // Whether the provider has finished its first render. Blocks toasts on the
  // initial mount (where nothing is purposely "new") per Phase 5 §5.2.
  const initializedRef = useRef(false);
  useEffect(() => {
    initializedRef.current = true;
  }, []);

  // When a saved session is restored on reload, the track appears WITHOUT a user
  // gesture intending something new; per §5.2 we don't announce that track. Set
  // by the restore effect so the now-playing toast skips its first resume.
  const restoredPlayingIdRef = useRef<string | null>(null);

  /* ---------------------- radio autoplay (plan §4.1) ---------------------- */

  /**
   * When the queue would otherwise end (repeat off, past the last track) and the
   * user has radio enabled, fetch similar tracks for the just-ended track, dedupe
   * against the current queue + history + the ended track itself, append fresh
   * seeds, and start playing the first one. Returns true when it picked up playback.
   *
   * WHY reads from refs at call time: invoked from a once-registered listener and
   * after async scheduling, so it needs the CURRENT queue/settings — not a stale
   * render closure. PlayerApi-consistent quality is threaded to /api/stream via
   * the prefetch path; this /api/related call uses the current settings.radio gate.
   */
  const radioContinue = useCallback(async (ended: Track): Promise<boolean> => {
    if (!settingsRef.current.radio) return false;
    // Re-entrancy gate: if a radio fetch is already in flight (e.g. the 'ended'
    // listener and a simultaneous manual NEXT both reached here), let the first
    // one own the dispatch to avoid double-seeding the same block.
    if (radioInFlightRef.current) return true; // already being handled
    radioInFlightRef.current = true;

    // Record the queue position this radio fill is anchored to. If the user
    // navigates the queue while the fetch is in flight, we must NOT yank them
    // back to the seeded block — a late dispatch would hijack their position.
    const anchorIndex = stateRef.current.currentIndex;

    // Dedupe: ignore tracks already in the queue, the ended track itself, and
    // anything in play history so radio doesn't immediately repeat something heard.
    try {
      const seen = new Set<string>();
      for (const t of stateRef.current.queue) seen.add(t.id);
      seen.add(ended.id);
      const history = await getHistory().catch(() => [] as Track[]);
      for (const h of history) if (h?.id) seen.add(h.id);

      try {
        const url =
          `/api/related?videoId=${encodeURIComponent(ended.videoId)}` +
          `&title=${encodeURIComponent(ended.title)}` +
          `&artist=${encodeURIComponent(ended.artist)}`;
        const res = await fetch(url);
        const data: unknown = await res.json();
        if (!res.ok || (data as { ok?: boolean })?.ok !== true) return false;

        // Freshness guard: only dispatch (which repositions to the seeded block)
        // if the user is STILL at the anchor — i.e. hasn't manually advanced or
        // played something else while /api/related was resolving. Otherwise drop
        // the seeds entirely; the next queue end re-triggers radio cleanly.
        const s = stateRef.current;
        if (s.currentIndex !== anchorIndex) return false;

        const results = ((data as { results?: Track[] }).results) ?? [];
        const seeds = results
          .filter((t) => t && t.id && !seen.has(t.id))
          .slice(0, RADIO_SEED_CAP);
        // Guard infinite loop: with zero usable seeds, stop cleanly rather than
        // re-triggering radio for the same end.
        if (seeds.length === 0) return false;
        dispatch({ type: "RADIO_SEEDS", seeds });
        return true;
      } catch {
        // A network/server failure must never loop; fall back to a clean stop.
        return false;
      }
    } finally {
      radioInFlightRef.current = false;
    }
  }, []);

  /**
   * Core forward decision shared by manual NEXT and auto-advance-on-end. Advances
   * normally when a next index exists; at a true queue end (repeat off) it falls
   * back to radio when enabled, otherwise dispatches NEXT to stop — the existing
   * default-compatible behavior when radio is off.
   */
  const forwardOrRadio = useCallback(() => {
    const s = stateRef.current;
    const idx = computeForwardIndex(s.currentIndex, s.queue.length, s.repeat, s.shuffle);
    if (idx !== -1) {
      dispatch({ type: "NEXT" });
      return;
    }
    const ended =
      s.currentIndex >= 0 && s.currentIndex < s.queue.length
        ? s.queue[s.currentIndex]
        : null;
    if (!settingsRef.current.radio || !ended) {
      dispatch({ type: "NEXT" }); // repeat off + radio off -> stop (existing path)
      return;
    }
    void radioContinue(ended);
  }, [radioContinue]);

  // Holds the latest auto-advance behavior for the once-registered 'ended'
  // listener (registered with deps []). Replays on repeat 'one'; otherwise the
  // shared forward/radio path. Updated each render so the listener is current.
  const endedForwardRef = useRef<() => void>(() => {});
  useEffect(() => {
    endedForwardRef.current = () => {
      const s = stateRef.current;
      // Repeat 'one' replays the SAME track: seek back to 0 and resume rather
      // than advancing (advancing would re-fetch the stream unnecessarily).
      if (s.repeat === "one") {
        const a = audioRef.current;
        if (a) {
          a.currentTime = 0;
          void a.play().catch(() => undefined);
        }
        dispatch({ type: "SEEK", seconds: 0 });
        return;
      }
      forwardOrRadio();
    };
  }, [forwardOrRadio]);

  /* ------------------------- <audio> wiring ------------------------- */

  // Stream the current track's URL into <audio> whenever it changes.
  // WHY separate effect: the <audio> never remounts; we push new sources into it.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !state.loadedTrack) return;

    const t = state.loadedTrack;
    // Prefetched stream for this exact track (plan §5.2): start instantly and
    // clear the entry so a later retry/normal play re-resolves fresh.
    const cached = prefetchCacheRef.current.get(t.id);
    if (cached) {
      prefetchCacheRef.current.delete(t.id);
      audio.src = cached;
      // A cached entry is a bare URL string — we have no source metadata for it,
      // so we cannot know whether it is an iTunes preview. Reset to false (the
      // badge just won't show for a prefetched preview, which is honest).
      dispatch({ type: "SET_PREVIEW", isPreview: false });
      // This track loaded from cache, so there is no in-flight fetch owning the
      // "loading" window. Clear the flag so the play/pause effect can start
      // playback — otherwise a superseded slow fetch (which skipped clearing it
      // because `cancelled` was true) would leave streamLoadingRef stuck true
      // forever and audio.play() would never run (fix: prefetch deadlock).
      streamLoadingRef.current = false;
      // Only begin audible playback if the user is in a playing intent. On a
      // restore (playing:false) the src is bound now and playback waits for the
      // user's first play tap (gesture), which the play/pause effect then starts.
      if (stateRef.current.playing) void audio.play().catch(() => undefined);
      return;
    }

    // Mark a stream resolution in-flight so the play/pause effect doesn't start
    // the STALE currently-bound src during the load gap (see streamLoadingRef).
    streamLoadingRef.current = true;
    let cancelled = false;
    (async () => {
      // The SAME quality the prefetch path uses (settingsRef, read at fetch
      // time) so a loaded track and its prefetched successor never diverge —
      // otherwise a 'low' setting would only ever apply to the NEXT track.
      const url =
        `/api/stream?videoId=${encodeURIComponent(t.videoId)}` +
        `&title=${encodeURIComponent(t.title)}` +
        `&artist=${encodeURIComponent(t.artist)}` +
        `&quality=${encodeURIComponent(settingsRef.current.quality)}`;
      try {
        const res = await fetch(url);
        const data: unknown = await res.json();
        if (cancelled) return;
        if (!res.ok || (data as { ok?: boolean })?.ok !== true) {
          dispatch({ type: "SET_ERROR", message: "Track unavailable — trying another source…" });
          return;
        }
        const streamUrl = (data as { track: Track }).track.streamUrl;
        if (!streamUrl) {
          dispatch({ type: "SET_ERROR", message: "Track unavailable — trying another source…" });
          return;
        }
        audio.src = streamUrl;
        // Record whether this resolved stream is a ~30s preview (iTunes fallback)
        // so the UI can show an honest badge + dim out beyond-30s lyrics and the
        // seek bar matches the real (short) duration. Derived here — from the
        // response metadata — because the loadedTrack itself can't carry it.
        dispatch({
          type: "SET_PREVIEW",
          isPreview: (data as { track: Track }).track.isPreview ?? false,
        });
        // Play ONLY when the user is in a playing intent: an unconditional
        // play() here would override a pause issued while this stream was still
        // buffering and leave `playing:false` desynced from real audio (final
        // audit finding). Real load failures surface via the audio 'error'
        // event; an autoplay-block rejection on reload restore is expected.
        if (stateRef.current.playing) void audio.play().catch(() => undefined);
      } catch {
        if (!cancelled) {
          dispatch({ type: "SET_ERROR", message: "Track unavailable — trying another source…" });
        }
      } finally {
        if (!cancelled) streamLoadingRef.current = false;
      }
    })();

    return () => {
      cancelled = true;
      // Always release the loading flag. The old effect's cleanup runs BEFORE
      // the new effect body, which re-sets it to true if the new run starts a
      // non-cached fetch — so resetting unconditionally here is safe and cannot
      // deadlock playback (fix: a superseded fetch's finally skipped it because
      // `cancelled` was true, freezing the play/pause effect).
      streamLoadingRef.current = false;
    };
    // Re-run when the target track changes OR a retry bumps streamAttempt —
    // not on every progress tick.
  }, [state.loadedTrack, state.streamAttempt]);

  // 70% stream PREFETCH (plan §5.2): once the current track passes ~70% of its
  // duration, resolve the NEXT track's stream URL into a bounded cache so an
  // auto-advance or manual NEXT starts instantly. Best-effort: a failed prefetch
  // just means the normal /api/stream path resolves it later.
  useEffect(() => {
    const s = stateRef.current;
    const { duration, progress, currentIndex, queue, repeat, shuffle } = s;
    if (duration <= 0 || progress < 0.7 * duration) return;
    // Under shuffle the "next" pick is random on every draw, so prefetching one
    // candidate is near-certainly wrong AND re-fetches a different track on every
    // progress tick (the effect re-runs ~4x/sec via state.progress), churning the
    // cache. With shuffle on, skip prefetch — the advance-time /api/stream path
    // (and radio) resolve the next track then. (Final audit perf fix.)
    if (shuffle) return;
    const nextIdx = computeForwardIndex(currentIndex, queue.length, repeat, shuffle);
    if (nextIdx === -1) return;
    const nextTrack = queue[nextIdx];
    if (!nextTrack) return;
    if (prefetchCacheRef.current.has(nextTrack.id)) return;
    // This track was already attempted this session (cached, in flight, or
    // failed) — never re-launch its prefetch on a later progress tick. The
    // normal /api/stream path still resolves it at playback time if needed.
    if (prefetchDoneRef.current.has(nextTrack.id)) return;
    // A fetch for this track is already in flight; a sibling 70% tick must not
    // duplicate it, or we flood the server with identical same-track requests.
    if (inFlightPrefetchRef.current.has(nextTrack.id)) return;

    let cancelled = false;
    // Claim the track synchronously BEFORE the async fetch so every tick that
    // runs while it resolves is gated out of launching a duplicate.
    inFlightPrefetchRef.current.add(nextTrack.id);
    (async () => {
      const url =
        `/api/stream?videoId=${encodeURIComponent(nextTrack.videoId)}` +
        `&title=${encodeURIComponent(nextTrack.title)}` +
        `&artist=${encodeURIComponent(nextTrack.artist)}` +
        `&quality=${encodeURIComponent(settingsRef.current.quality)}`;
      try {
        const res = await fetch(url);
        const data: unknown = await res.json();
        if (cancelled) return;
        if (!res.ok || (data as { ok?: boolean })?.ok !== true) return;
        const streamUrl = (data as { track: Track }).track.streamUrl;
        if (!streamUrl) return;
        // Evict the oldest entry when over the cap so the cache stays bounded.
        if (prefetchCacheRef.current.size >= PREFETCH_CACHE_MAX) {
          const oldest = prefetchCacheRef.current.keys().next().value;
          if (oldest !== undefined) prefetchCacheRef.current.delete(oldest);
        }
        prefetchCacheRef.current.set(nextTrack.id, streamUrl);
      } catch {
        // Prefetch is optional; fall through to the normal fetch on playback.
      } finally {
        // The fetch (success or failure) owns removing its own in-flight id.
        inFlightPrefetchRef.current.delete(nextTrack.id);
        // Mark attempted so a permanently-unavailable track is not re-fetched
        // on every subsequent 70% tick for the rest of this session.
        prefetchDoneRef.current.add(nextTrack.id);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    state.progress,
    state.duration,
    state.currentIndex,
    state.queue,
    state.repeat,
    state.shuffle,
  ]);

  // Reset prefetch-attempt bookkeeping when the queue/track changes so stale
  // ids can't leak across sessions. WHY refs and not state: these must never
  // trigger a re-render themselves.
  // - prefetchDoneRef: cleared wholesale so returning to an OLD track can
  //   legitimately attempt its prefetch again (its entry was tied to the prior
  //   queue context). Additions are the fetch's own `finally`'s business.
  // - inFlightPrefetchRef: prune only ids that are no longer in the CURRENT
  //   queue (stale) — an id still in the queue and genuinely in flight stays so
  //   its own `finally` can delete it; pruning it early would re-enable the
  //   duplicate-request flood the field owner set is meant to stop.
  useEffect(() => {
    if (prefetchDoneRef.current.size > 0) prefetchDoneRef.current.clear();
    const ids = new Set(state.queue.map((t) => t.id));
    for (const id of inFlightPrefetchRef.current) {
      if (!ids.has(id)) inFlightPrefetchRef.current.delete(id);
    }
    // Deps: re-run when the queue identity or the newly-loaded track changes.
    // state.progress ticks (which drive the 70% prefetch effect) do NOT re-run
    // this — so pruning never races an in-flight fetch during heavy ticking.
  }, [state.queue, state.loadedTrack]);

  /* ------------------------- toast wiring (Phase 5 §5.2) ------------------------- */

  // Announce stream/playback failures the moment a NEW error appears. All
  // stream failures reuse one constant message, so dedupe by the message string
  // and only fire when it (re)appears after being cleared — never on re-render.
  useEffect(() => {
    if (!state.error) {
      lastErrorToastRef.current = null; // cleared → a future error is "new" again
      return;
    }
    if (lastErrorToastRef.current === state.error) return; // same error, already shown
    lastErrorToastRef.current = state.error;
    toast.error(state.error);
  }, [state.error]);

  // Confirm a genuinely NEW now-playing track with a short-lived toast. Lights-out
  // by design (the mini player already shows now-playing), so it only fires when:
  //   - the provider has passed initial mount (initializedRef),
  //   - audio is actually playing (respect `playing`, so a loaded-but-paused track
  //     or a restored session awaiting a gesture never announces),
  //   - the track id actually changed (dedupe by lastNowPlayingIdRef), and
  //   - the track was not the one silently restored on reload (restoredPlayingIdRef).
  useEffect(() => {
    if (!initializedRef.current) return; // not the "very first empty load"
    const t = state.loadedTrack;
    if (!state.playing || !t) return;
    if (t.id === lastNowPlayingIdRef.current) return; // same track unchanged
    if (t.id === restoredPlayingIdRef.current) return; // reload-restore, not a fresh play
    lastNowPlayingIdRef.current = t.id;
    toast.info(`Now playing: ${t.title}`);
  }, [state.loadedTrack, state.playing]);

  // Play/pause the underlying element when `playing` flips, except while a NEW
  // stream is still being resolved/set (streamLoadingRef) — there the
  // stream-resolution effect above owns playback start once the fresh src is
  // bound. This prevents a NEXT/PLAY (which flips playing:true while the OLD src
  // is still bound) from audibly starting the previous track during the load gap.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (state.playing) {
      if (!streamLoadingRef.current && audio.paused) {
        void audio.play().catch(() => undefined);
      }
    } else if (!audio.paused) {
      audio.pause();
    }
  }, [state.playing]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const onTimeUpdate = () => {
      dispatch({ type: "SET_PROGRESS", progress: audio.currentTime });
      // Keep the OS lock-screen / hardware-control position in sync while playing.
      try {
        const s = stateRef.current;
        if (s.playing) {
          navigator.mediaSession.setPositionState?.({
            duration: s.duration || audio.duration || 0,
            playbackRate: audio.playbackRate || 1,
            position: audio.currentTime,
          });
        }
      } catch {
        // setPositionState can throw on unsupported platforms; position sync is best-effort.
      }
    };
    const onDurationChange = () => {
      if (Number.isFinite(audio.duration)) dispatch({ type: "SET_DURATION", duration: audio.duration });
    };
    const onPlaying = () => {
      dispatch({ type: "SET_READY" });
      // A real playback start just occurred — record it in history. This is the
      // one reliable point where the track has an id AND is audibly playing.
      // The ref guard prevents it firing for the same start more than once
      // (e.g. resume or a re-fired event). recordPlay is async + internally
      // guarded, and wrapped in try/catch so a history write can NEVER break
      // playback (worst case the play simply isn't logged).
      const s = stateRef.current;
      if (s.loadedTrack && recordedPlayIdRef.current !== s.loadedTrack.id) {
        recordedPlayIdRef.current = s.loadedTrack.id;
        // A genuine user-initiated play just happened, so the reload-restore
        // "now playing" suppression (restoredPlayingIdRef) no longer applies — the
        // same track re-arriving later should announce normally again. Clearing
        // it here means only the very first silent resume is suppressed.
        restoredPlayingIdRef.current = null;
        void recordPlay(s.loadedTrack).catch(() => undefined);
        // Broadcast so "recently played" surfaces refresh immediately (defect 9).
        // A play just entered history — the Home shelf should re-read from
        // IndexedDB rather than wait for the next mount.
        try {
          window.dispatchEvent(new Event(LIBRARY_UPDATED_EVENT));
        } catch {
          // Custom events are universally supported; this is belt-and-braces.
        }
      }
    };
    const onError = () => {
      dispatch({ type: "SET_ERROR", message: "Track unavailable — trying another source…" });
    };
    const onEnded = () => {
      // Delegate to the live forward/radio logic held in endedForwardRef: repeat
      // 'one' replays, advance normally, or radio/stop at queue end. The ref is
      // updated each render so this once-registered listener stays current.
      endedForwardRef.current();
    };

    audio.addEventListener("timeupdate", onTimeUpdate);
    audio.addEventListener("durationchange", onDurationChange);
    audio.addEventListener("playing", onPlaying);
    audio.addEventListener("error", onError);
    audio.addEventListener("ended", onEnded);
    return () => {
      audio.removeEventListener("timeupdate", onTimeUpdate);
      audio.removeEventListener("durationchange", onDurationChange);
      audio.removeEventListener("playing", onPlaying);
      audio.removeEventListener("error", onError);
      audio.removeEventListener("ended", onEnded);
    };
  }, []);

  /* ----------------------- bridge + persistence ---------------------- */

  const playTrack = useCallback((track: Track) => {
    dispatch({ type: "PLAY_TRACK", track });
  }, []);

  const playQueue = useCallback((tracks: Track[], index: number) => {
    dispatch({ type: "PLAY_QUEUE", tracks, index });
  }, []);

  // Route both single-track and queue playback into this player via the bridge.
  useEffect(() => {
    bindPlayHandler(playTrack);
    bindQueueHandler(playQueue);
    return () => {
      unbindPlayHandler();
      unbindQueueHandler();
    };
  }, [playTrack, playQueue]);

  // Persist queue/index/repeat/shuffle. Destructive ops wrapped so storage
  // failures never crash playback.
  useEffect(() => {
    try {
      const snapshot: PersistedSnapshot = {
        queue: state.queue,
        currentIndex: state.currentIndex,
        repeat: state.repeat,
        shuffle: state.shuffle,
      };
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(snapshot));
    } catch {
      // Quota/private-mode failures are non-fatal.
    }
  }, [state.queue, state.currentIndex, state.repeat, state.shuffle]);

  // Restore persisted snapshot once on mount, re-verifying the index is valid
  // (a stored index can become stale if the queue changed between sessions).
  useEffect(() => {
    const snap = loadPersistedSnapshot();
    if (snap && snap.currentIndex >= 0 && snap.currentIndex < snap.queue.length) {
      // Remember the restored track so the "now playing" toast skips announcing
      // it on its first resume (reload-restore is not a fresh play intent).
      const restored = snap.queue[snap.currentIndex];
      if (restored) restoredPlayingIdRef.current = restored.id;
      dispatch({ type: "SET_QUEUE", queue: snap.queue, currentIndex: snap.currentIndex });
    }
  }, []);

  /* ---------------------------- actions ------------------------------ */

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    // If nothing is loaded but a track is in state, let the effect stream it.
    // WHY RETRY_STREAM (not PLAY_TRACK): on a fast play tap the stream for the
    // restored/queued track may still be resolving (audio.src empty). PLAY_TRACK
    // would REPLACE the whole (possibly multi-track) restored queue with a single
    // track, wiping its contents. RETRY_STREAM keeps the queue, sets playing:true
    // so the (gesture-driven) play() in the stream effect actually starts audio,
    // and bumps streamAttempt to re-resolve the stream.
    if (state.loadedTrack && audio && audio.src === "") {
      dispatch({ type: "RETRY_STREAM" });
      return;
    }
    // A previous stream attempt failed (SET_ERROR) — the loadedTrack is the
    // SAME so `loadedTrack` in the effect deps won't change. Bump the retry
    // nonce to force the effect to re-resolve the stream, and mark playing so
    // the gesture-driven play() in the effect actually starts audio.
    if (state.error && state.loadedTrack) {
      dispatch({ type: "RETRY_STREAM" });
      return;
    }
    dispatch({ type: "TOGGLE_PLAY" });
  }, [state.loadedTrack, state.error]);

  const seek = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = seconds;
    dispatch({ type: "SEEK", seconds });
  }, []);

  /**
   * Manual "Next" tap. With repeat 'one' a plain NEXT would return the SAME
   * index (computeForwardIndex keeps the current track), so the loadedTrack
   * wouldn't change and the stream effect would never re-fire — a silent
   * no-op. Mirror the repeat-one replay used in endedForwardRef/prev instead:
   * reset the REAL audio cursor and the UI progress, then resume if we were
   * playing. Do NOT dispatch NEXT in that branch. Otherwise fall through to
   * the normal forward/radio path.
   */
  const next = useCallback(() => {
    const s = stateRef.current;
    if (s.repeat === "one" && s.currentIndex >= 0) {
      const audio = audioRef.current;
      if (audio) {
        audio.currentTime = 0;
        if (s.playing && !audio.paused) void audio.play().catch(() => undefined);
      }
      dispatch({ type: "SEEK", seconds: 0 });
      return;
    }
    forwardOrRadio();
  }, [forwardOrRadio]);

  /**
   * Go to the previous track — or, if we're more than 3s into the current one,
   * RESTART it from the beginning. The restart must reset the REAL audio cursor
   * too: dispatching only SEEK would move the UI progress while <audio> kept
   * playing from its existing position (final audit fix — the reducer's PREV
   * restart branch is pure and can't touch audio, so the reset happens here).
   */
  const prev = useCallback(() => {
    const s = stateRef.current;
    const audio = audioRef.current;
    if (s.currentIndex >= 0 && s.progress > 3) {
      if (audio) {
        audio.currentTime = 0;
        if (s.playing && !audio.paused) void audio.play().catch(() => undefined);
      }
      dispatch({ type: "SEEK", seconds: 0 });
      return;
    }
    dispatch({ type: "PREV" });
  }, []);

  const openPlayer = useCallback(() => dispatch({ type: "OPEN_PLAYER" }), []);
  const closePlayer = useCallback(() => dispatch({ type: "CLOSE_PLAYER" }), []);

  const addToQueue = useCallback((track: Track) => {
    dispatch({ type: "ADD_TO_QUEUE", track });
  }, []);

  const playNext = useCallback((track: Track) => {
    dispatch({ type: "PLAY_NEXT", track });
  }, []);

  const removeFromQueue = useCallback((index: number) => {
    dispatch({ type: "REMOVE_FROM_QUEUE", index });
  }, []);

  const moveInQueue = useCallback((from: number, to: number) => {
    dispatch({ type: "MOVE_IN_QUEUE", from, to });
  }, []);

  const toggleRepeat = useCallback(() => dispatch({ type: "CYCLE_REPEAT" }), []);
  const toggleShuffle = useCallback(() => dispatch({ type: "TOGGLE_SHUFFLE" }), []);

  const setVolume = useCallback((volume: number) => {
    dispatch({ type: "SET_VOLUME", volume });
  }, []);

  const toggleMute = useCallback(() => dispatch({ type: "TOGGLE_MUTE" }), []);

  /**
   * Pure-ish helper returning the track that the NEXT control would land on,
   * honoring repeat + shuffle — used by the queue drawer to preview the next
   * track without actually advancing.
   */
  const nextTrack = useCallback((): Track | null => {
    const s = stateRef.current;
    const idx = computeForwardIndex(s.currentIndex, s.queue.length, s.repeat, s.shuffle);
    if (idx === -1) return null;
    return s.queue[idx];
  }, []);

  /* ------------------------- MediaSession ---------------------------- */

  // The currently-bound track, derived for the MiniPlayer + metadata effect.
  const currentTrack =
    state.currentIndex >= 0 && state.currentIndex < state.queue.length
      ? state.queue[state.currentIndex]
      : null;

  // Push Now-Playing metadata to the OS lock screen / hardware controls.
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!currentTrack) return;
    try {
      if ("mediaSession" in navigator && "MediaMetadata" in window) {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: currentTrack.title,
          artist: currentTrack.artist,
          album: currentTrack.album || currentTrack.artist,
          artwork: currentTrack.artwork
            ? [{ src: currentTrack.artwork, sizes: "512x512", type: "image/jpeg" }]
            : [],
        });
      }
    } catch {
      // MediaMetadata can be missing on older/embedded browsers; ignore.
    }
  }, [currentTrack]);

  // Wire MediaSession transport-control handlers to the player actions.
  // WHY re-registered on each action identity change: the handlers must call
  // the CURRENT callbacks; MediaSession intentionally has no way to read ours.
  useEffect(() => {
    try {
      const ms = navigator.mediaSession;
      if (!ms) return;
      ms.setActionHandler("play", () => togglePlay());
      ms.setActionHandler("pause", () => togglePlay());
      ms.setActionHandler("previoustrack", () => prev());
      ms.setActionHandler("nexttrack", () => next());
      ms.setActionHandler("seekto", (details) => {
        if (details.seekTime != null) seek(details.seekTime);
      });
    } catch {
      // setActionHandler throws on unsupported platforms; skip quietly.
    }
  }, [togglePlay, prev, next, seek]);

  /* ------------------------- volume / mute ------------------------- */

  // Rehydrate the persisted volume/mute ONCE on mount (after first paint).
  // Guarded for SSR where window.localStorage does not exist — loadVolumePref
  // already returns defaults there, and this effect only runs client-side.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const pref = loadVolumePref();
    dispatch({ type: "RESTORE_VOLUME", volume: pref.volume, muted: pref.muted });
    // Intentionally run once on mount; re-running would clobber live slider
    // changes with the stored value on every future re-render.
  }, []);

  // Push the loudness preference into the shared <audio> element whenever it
  // changes. muted rides as `audio.muted` (independent of volume), so muting
  // never loses the user's chosen gain.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    try {
      audio.volume = state.volume;
      audio.muted = state.muted;
    } catch {
      // Refused/unsupported assignment (odd embeds) should never crash the app.
    }
  }, [state.volume, state.muted]);

  // Persist volume/muted to localStorage. Wrapped so a blocked-storage browser
  // never crashes the app over a non-essential preference.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        VOLUME_STORAGE_KEY,
        JSON.stringify({ volume: state.volume, muted: state.muted })
      );
    } catch {
      // Non-persistent (private mode / quota): live value still applies in-memory.
    }
  }, [state.volume, state.muted]);

  const api = useMemo<PlayerApi>(() => {
    return {
      queue: state.queue,
      currentTrack,
      currentIndex: state.currentIndex,
      repeat: state.repeat,
      shuffle: state.shuffle,
      ready: state.ready,
      playing: state.playing,
      duration: state.duration,
      progress: state.progress,
      error: state.error,
      nowPlayingOpen: state.nowPlayingOpen,
      isPreview: state.isPreview,
      volume: state.volume,
      muted: state.muted,
      playTrack,
      playQueue,
      addToQueue,
      playNext,
      removeFromQueue,
      moveInQueue,
      toggleRepeat,
      toggleShuffle,
      togglePlay,
      seek,
      next,
      prev,
      nextTrack,
      openPlayer,
      closePlayer,
      setVolume,
      toggleMute,
    };
  }, [
    state,
    currentTrack,
    playTrack,
    playQueue,
    addToQueue,
    playNext,
    removeFromQueue,
    moveInQueue,
    toggleRepeat,
    toggleShuffle,
    togglePlay,
    seek,
    next,
    prev,
    nextTrack,
    openPlayer,
    closePlayer,
    setVolume,
    toggleMute,
  ]);

  return (
    <PlayerContext.Provider value={api}>
      {children}
      {/* One shared element; all playback flows through it. */}
      <audio ref={audioRef} preload="auto" className="hidden" />
    </PlayerContext.Provider>
  );
}

/** Access the global player state + controls. Throws if used outside the provider. */
export function usePlayer(): PlayerApi {
  const ctx = useContext(PlayerContext);
  if (!ctx) {
    throw new Error("usePlayer must be used within a PlayerProvider");
  }
  return ctx;
}
