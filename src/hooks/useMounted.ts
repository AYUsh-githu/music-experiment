"use client";

import { useSyncExternalStore } from "react";

/** Nothing to subscribe to — the client snapshot never changes after mount. */
const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * SSR-safe hydration gate.
 *
 * Returns `false` during the server render and the first client render (when
 * the SSR HTML is being hydrated), then `true` afterward. Use it to avoid
 * hydration mismatches for anything that reads `window`/`localStorage`, or
 * that must render a different subtree client-side than server-side.
 *
 * WHY useSyncExternalStore rather than `useState` + `useEffect`: React expects
 * the server HTML and the first client render to match. A `setState` inside an
 * effect triggers a second, cascading render (and is flagged by
 * react-hooks/set-state-in-effect). useSyncExternalStore gives us the same
 * guarantee — `getServerSnapshot` returns `false` for SSR + hydration, and the
 * client snapshot is `true` — with no extra render pass. This is the pattern
 * the spec recommends for store-driven client-only values.
 */
export function useMounted(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
