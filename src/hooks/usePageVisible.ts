"use client";

import { useEffect, useState } from "react";

/**
 * Current document visibility state (`document.visibilityState === "visible"`),
 * listener-backed so it stays correct when the tab is backgrounded.
 *
 * WHY: animations and background work should stop (or skip) when the page is
 * not visible — e.g. lyrics auto-scroll, marquees, live revalidation. Starting
 * `true` matches the common case (a visible first paint) and only changes on
 * an actual visibility toggle.
 */
export function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const update = () => setVisible(document.visibilityState === "visible");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, []);

  return visible;
}
