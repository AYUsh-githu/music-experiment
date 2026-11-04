"use client";

import { useEffect } from "react";
import { toast } from "@/lib/client/toast";
import { useSyncExternalStore } from "react";

/* -------------------------------------------------------------------------- */
/* useOnlineStatus — navigator.onLine as an SSR-safe external store (§4.5).    */
/* -------------------------------------------------------------------------- */

const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Server snapshot: assume online (never render an "offline" banner during SSR).
const getServerSnapshot = () => true;
const getSnapshot = () => navigator.onLine;

/** Reactive `navigator.onLine` — flips when the browser gains/loses network. */
export function useOnlineStatus(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/**
 * OfflineWatches — global side-effect component (mounted once in AppProviders):
 * pushes a single toast on each online/offline flip via the existing Toaster
 * store. No API, playback, or fetch logic is touched — this only surfaces what
 * a wifi hiccup otherwise silently does to the progress bar.
 */
export function OfflineAlerter(): null {
  useEffect(() => {
    // Subscribe at the store level so we see the actual flip EVENTS (not the
    // initial mount value — never toast "back online" on page load).
    let wasOnline = navigator.onLine;
    const onChange = () => {
      const now = navigator.onLine;
      if (now === wasOnline) return;
      wasOnline = now;
      if (now) {
        toast.success("Back online");
      } else {
        toast.error("You're offline — check your connection");
      }
    };
    window.addEventListener("online", onChange);
    window.addEventListener("offline", onChange);
    return () => {
      window.removeEventListener("online", onChange);
      window.removeEventListener("offline", onChange);
    };
  }, []);

  return null;
}
