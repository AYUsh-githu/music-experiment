"use client";

/**
 * RouteTitle — per-route `document.title` (WS7).
 *
 * WHY an effect and not `metadata`: the root layout is a server component and
 * already exports the site metadata, but every route page is a "use client"
 * component and CANNOT export `metadata`. Rather than restructure four working
 * client pages into server wrappers (which §4's "no layout rewrites" pushes
 * against), a tiny client effect sets the title on navigation. It only touches
 * `document.title`, which plays no part in hydration, so it is hydration-safe
 * by construction: the server never renders a title node.
 *
 * Mounted once at the Shell level (not per page) so navigation is covered by a
 * single listener-free effect keyed on the pathname.
 */
import { useEffect } from "react";
import { usePathname } from "next/navigation";

const SUFFIX = "Sonic — Free Music Streaming";

const TITLES: Record<string, string> = {
  "/": "Home",
  "/search": "Search",
  "/library": "Library",
  "/settings": "Settings",
};

export default function RouteTitle() {
  const path = usePathname();

  useEffect(() => {
    // Longest-prefix match so a future nested route still gets its section title.
    const key = Object.keys(TITLES)
      .filter((k) => (k === "/" ? path === "/" : path.startsWith(k)))
      .sort((a, b) => b.length - a.length)[0];
    const section = key ? TITLES[key] : undefined;
    document.title = section ? `${section} · ${SUFFIX}` : SUFFIX;
  }, [path]);

  return null;
}
