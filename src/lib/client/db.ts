/**
 * Client-side IndexedDB library for the Sonic app (TASK 3 foundation).
 *
 * Browser-only persistence layer storing user library state:
 *   - favorites: tracks the user has liked
 *   - history:   play history (deduped, capped)
 *   - playlists: user-created named collections of tracks
 *
 * WHY this lives on the client and not the server: each browser keeps its own
 * library (no accounts), so IndexedDB is the right store. All functions are
 * plain-value, non-throwing, and safe to import during server rendering.
 *
 * IMPORTANT persistence rule: Tracks are stored WITHOUT `streamUrl`. That field
 * is ephemeral (per src/lib/types.ts) and must never be persisted. We strip it
 * before every write and never re-add it on read.
 */

import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { Track } from "../types";

/* -------------------------------------------------------------------------- */
/* Schema                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * A user-created playlist. Public contract — other consumers (UI, player) rely
 * on this exact shape. `tracks` are persisted WITHOUT streamUrl (ephemeral).
 */
export interface Playlist {
  id: string;
  name: string;
  createdAt: number;
  tracks: Track[];
}

/** Shape of a raw history row — we annotate with a monotonic `at` tick for chronological ordering. */
interface HistoryRow {
  id: string; // same as track.id
  at: number; // insertion tick; higher = more recent
  track: PersistedTrack;
}

/** The subset of Track that is safe to persist (no ephemeral streamUrl). */
type PersistedTrack = Omit<Track, "streamUrl">;

/**
 * Canonical schema for the single 'sonic-library' database.
 *
 * `DBSchema` gives us fully-typed stores, keys and indexes, so every `tx.store`
 * call below is checked against this shape at compile time.
 */
interface SonicDBSchema extends DBSchema {
  favorites: {
    key: string; // track.id -> TrackId but stored as string for simplicity
    value: PersistedTrack;
  };
  history: {
    key: string; // track.id
    value: HistoryRow;
    indexes: { "by-at": number };
  };
  playlists: {
    key: string; // playlist.id
    value: {
      id: string;
      name: string;
      createdAt: number;
      tracks: PersistedTrack[];
    };
  };
}

const DB_NAME = "sonic-library";
const DB_VERSION = 1;

/** Trim history to at most this many entries on each write. */
const HISTORY_CAP = 100;

/**
 * Singleton database promise.
 *
 * WHY lazily initialized at call time (not module load): opening a DB touches
 * `indexedDB`, which does not exist during a server render. By deferring the
 * open until the first real call and guarding with `getDb()`, importing this
 * module never crashes SSR. All API functions call `getDb()` only when they run,
 * and `getDb()` short-circuits to `null` in non-browser environments.
 */
let dbPromise: Promise<IDBPDatabase<SonicDBSchema>> | null = null;

/** Lazily open (once) and return the database, or null when unavailable (SSR / non-browser). */
function getDb(): Promise<IDBPDatabase<SonicDBSchema>> | null {
  // Guard: no IndexedDB (server render, some privacy modes) -> callers handle null.
  if (typeof indexedDB === "undefined") {
    return null;
  }
  if (!dbPromise) {
    // On a failed open, clear the cached promise so the next getDb() retries instead
    // of reusing a forever-rejected promise for the rest of the session (quota /
    // private-mode failures would otherwise never recover). Re-throw so the caller
    // still sees the rejection and run() degrades to its fallback value.
    dbPromise = openDB<SonicDBSchema>(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // favorites: dedupe by track id.
        if (!db.objectStoreNames.contains("favorites")) {
          db.createObjectStore("favorites", { keyPath: "id" });
        }
        // history: dedupe by track id + chronological index on the `at` tick.
        if (!db.objectStoreNames.contains("history")) {
          const store = db.createObjectStore("history", { keyPath: "id" });
          store.createIndex("by-at", "at");
        }
        // playlists: dedupe by playlist id; tracks live inside each row.
        if (!db.objectStoreNames.contains("playlists")) {
          db.createObjectStore("playlists", { keyPath: "id" });
        }
      },
    }).catch((err) => {
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

/**
 * Wrap an IndexedDB operation so it degrades gracefully.
 *
 * - In a non-browser environment (SSR) getDb() is null -> resolve to a safe empty value.
 * - IndexedDB access can throw for reasons outside our control (quota, locked
 *   tabs); those are surfaced via the caller's `empty` fallback rather than
 *   crashing the render.
 */
async function run<T>(empty: T, fn: (db: IDBPDatabase<SonicDBSchema>) => Promise<T>): Promise<T> {
  const db = getDb();
  if (!db) return empty;
  try {
    return await fn(await db);
  } catch (err) {
    // Never throw for "not found"; log and fall back to the empty value.
    console.warn("[db] operation failed, returning fallback:", err);
    return empty;
  }
}

/* -------------------------------------------------------------------------- */
/* Persistence helpers (strip ephemeral streamUrl)                             */
/* -------------------------------------------------------------------------- */

/** Strip ephemeral fields before persisting a Track. */
function toPersisted(track: Track): PersistedTrack {
  const { streamUrl: _drop, ...rest } = track;
  void _drop; // streamUrl is intentionally discarded (ephemeral contract)
  return rest;
}

/* -------------------------------------------------------------------------- */
/* Favorites                                                                   */
/* -------------------------------------------------------------------------- */

/** True when this exact track id is a favorite. */
export async function isFavorite(track: Track): Promise<boolean> {
  return run(false, async (db) => {
    const existing = await db.get("favorites", track.id);
    return existing !== undefined;
  });
}

/** Toggle a favorite. Returns the NEW state (true when now favorited). */
export async function toggleFavorite(track: Track): Promise<boolean> {
  return run(false, async (db) => {
    // Read + write atomically inside ONE readwrite transaction, so a rapid
    // double-click on the heart can't race (two separate auto-committed
    // transactions would both read `exists === undefined` and both put).
    const tx = db.transaction("favorites", "readwrite");
    const store = tx.store;
    const exists = await store.get(track.id);
    if (exists) {
      await store.delete(track.id);
      await tx.done;
      return false;
    }
    await store.put(toPersisted(track));
    await tx.done;
    return true;
  });
}

/** All favorited tracks, newest-first (reverse insertion — favorites are most recently added on top). */
export async function getFavorites(): Promise<Track[]> {
  return run([], async (db) => {
    const all = await db.getAll("favorites");
    return all.reverse();
  });
}

/* -------------------------------------------------------------------------- */
/* History                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Record a play.
 *
 * Dedup rule: if the most recent history entry (chronologically last) has the
 * same track id, do NOT push a duplicate. This covers consecutive plays and
 * resume (unpausing re-fires a play event). Afterwards cap the list to the last
 * HISTORY_CAP entries by trimming the oldest, and bump the play's `at` tick so
 * it reads as the newest item.
 */
export async function recordPlay(track: Track): Promise<void> {
  await run(undefined as unknown as void, async (db) => {
    // Monotonic tick for the `by-at` index: the key must be STRICTLY increasing or
    // two plays in the same millisecond would collide on the index key, breaking
    // most-recent ordering and making the HISTORY_CAP trim drop an arbitrary row.
    // Bump past the previous newest tick if Date.now() hasn't advanced yet.
    let now = Date.now();

    const tx = db.transaction("history", "readwrite");
    const store = tx.store;
    const index = store.index("by-at");

    // Read entries via the chronological index (ascending -> last = most recent).
    const all = await index.getAll();
    const lastRow = all.length > 0 ? all[all.length - 1] : undefined;
    // Guarantee strict ordering against the previous most-recent tick.
    if (lastRow && typeof lastRow.at === "number" && now <= lastRow.at) {
      now = lastRow.at + 1;
    }

    // If the last played track is this same track, skip the duplicate write but
    // still make it the newest (bump its tick). This covers consecutive plays and resume.
    if (lastRow && lastRow.id === track.id) {
      await store.put({ ...lastRow, at: now });
    } else {
      await store.put({ id: track.id, at: now, track: toPersisted(track) });
    }
    await tx.done;

    // Enforce the cap: drop the oldest entries beyond HISTORY_CAP.
    const full = await db.getAllFromIndex("history", "by-at");
    if (full.length > HISTORY_CAP) {
      const overflowCount = full.length - HISTORY_CAP;
      const toTrim = full.slice(0, overflowCount); // ascending -> oldest first
      const tx2 = db.transaction("history", "readwrite");
      await Promise.all(toTrim.map((row) => tx2.store.delete(row.id)));
      await tx2.done;
    }
  });
}

/** Play history, most-recently-played first (chronologically descending). */
export async function getHistory(): Promise<Track[]> {
  return run([], async (db) => {
    const all = await db.getAllFromIndex("history", "by-at");
    return all.reverse().map((row) => row.track);
  });
}

/**
 * Play history WITH each row's stored `at` tick, most-recently-played first.
 *
 * WHY an additive sibling of getHistory() instead of widening its return type
 * (F9 residual): getHistory() has six call sites — including the frozen-adjacent
 * PlayerContext radio dedupe (PlayerContext.tsx:703) — that only want the plain
 * Track[]. Changing its shape would ripple into code this workstream must not
 * touch, so the timestamp-exposing read is a NEW function and getHistory() stays
 * byte-for-byte what it was.
 *
 * The rows are the same newest-first, capped (HISTORY_CAP) rows getHistory()
 * returns, read through the SAME `history` store and its `by-at` index — no
 * schema change and no migration (the spec forbids migrating IndexedDB here; the
 * `at` tick has been written since the store was created). `at` is the monotonic
 * insertion tick from recordPlay, so it is a reliable "when was this played"
 * marker, but consumers must still treat it as possibly absent and degrade.
 *
 * Contract matches getHistory(): plain values, never throws — a non-browser or
 * failing read resolves to an empty array through run().
 */
export async function getHistoryWithTimestamps(): Promise<Array<{ track: Track; at: number }>> {
  return run([], async (db) => {
    const all = await db.getAllFromIndex("history", "by-at");
    // reverse(): the index reads ascending, so reversing yields newest-first —
    // the same ordering getHistory() produces.
    return all.reverse().map((row) => ({ track: row.track, at: row.at }));
  });
}

/* -------------------------------------------------------------------------- */
/* Playlists                                                                   */
/* -------------------------------------------------------------------------- */

/** All playlists. */
export async function getPlaylists(): Promise<Playlist[]> {
  return run([], async (db) => {
    return (await db.getAll("playlists")) as Playlist[];
  });
}

/** Create a named playlist (empty). */
export async function createPlaylist(name: string): Promise<Playlist> {
  const playlist: Playlist = {
    id: `pl_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    name,
    createdAt: Date.now(),
    tracks: [],
  };
  await run(undefined as unknown as void, async (db) => {
    await db.put("playlists", playlist);
  });
  return playlist;
}

/** Rename a playlist; no-op when the id does not exist. */
export async function renamePlaylist(id: string, name: string): Promise<void> {
  await run(undefined as unknown as void, async (db) => {
    const existing = await db.get("playlists", id);
    if (!existing) return; // not found -> do nothing, never throw
    await db.put("playlists", { ...existing, name });
  });
}

/** Delete a playlist by id (no-op when missing). */
export async function deletePlaylist(id: string): Promise<void> {
  await run(undefined as unknown as void, async (db) => {
    await db.delete("playlists", id);
  });
}

/** Add a track to a playlist; creates the playlist's array if absent. */
export async function addToPlaylist(playlistId: string, track: Track): Promise<void> {
  await run(undefined as unknown as void, async (db) => {
    const existing = await db.get("playlists", playlistId);
    if (!existing) return; // playlist must exist to add to it
    const already = existing.tracks.some((t) => t.id === track.id);
    if (already) return; // avoid duplicates within a playlist
    await db.put("playlists", {
      ...existing,
      tracks: [...existing.tracks, toPersisted(track)],
    });
  });
}

/** Remove a track from a playlist by track id; no-op when either is missing. */
export async function removeFromPlaylist(playlistId: string, trackId: string): Promise<void> {
  await run(undefined as unknown as void, async (db) => {
    const existing = await db.get("playlists", playlistId);
    if (!existing) return; // not found -> do nothing
    const next = existing.tracks.filter((t) => t.id !== trackId);
    if (next.length === existing.tracks.length) return; // track not present
    await db.put("playlists", { ...existing, tracks: next });
  });
}

/* -------------------------------------------------------------------------- */
/* Clear / library-wipe operations                                             */
/* -------------------------------------------------------------------------- */

/**
 * Empty the favorites store (all liked tracks).
 *
 * WHY this is a distinct operation from toggling favorites: the Settings
 * page's "Clear favorites" danger action wipes the whole store in one shot,
 * and it must degrade to a no-op (never throw) when IndexedDB is unavailable —
 * matching the run() contract used everywhere else here.
 */
export async function clearFavorites(): Promise<void> {
  await run(undefined as unknown as void, async (db) => {
    await db.clear("favorites");
  });
}

/** Empty the play-history store (all recorded plays). No-op when unavailable. */
export async function clearHistory(): Promise<void> {
  await run(undefined as unknown as void, async (db) => {
    await db.clear("history");
  });
}

/** Empty the playlists store (all user-created playlists). No-op when unavailable. */
export async function clearPlaylists(): Promise<void> {
  await run(undefined as unknown as void, async (db) => {
    await db.clear("playlists");
  });
}

/**
 * Wipe every store in the library (favorites, history, playlists) at once.
 *
 * Used by the Settings danger zone's "Clear all library data" action. A single
 * transaction over all three stores keeps the wipe atomic so a partial failure
 * can't leave the library in a half-cleared state.
 */
export async function clearLibrary(): Promise<void> {
  await run(undefined as unknown as void, async (db) => {
    const tx = db.transaction(["favorites", "history", "playlists"], "readwrite");
    await Promise.all([tx.objectStore("favorites").clear(), tx.objectStore("history").clear(), tx.objectStore("playlists").clear()]);
    await tx.done;
  });
}
