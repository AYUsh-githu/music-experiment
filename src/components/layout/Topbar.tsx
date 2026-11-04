"use client";

/**
 * Topbar — the WS7 glass-on-scroll header.
 *
 * WHY it listens to an element and not `window`: this app's scroll container is
 * Shell's <main> (`overflow-y-auto`), NOT the document. A window scroll
 * listener would never fire. The parent owns the container ref and passes it in.
 *
 * Glass with HYSTERESIS: a single threshold makes an 8px-scrolled header
 * flicker on/off when the user jitters around the boundary. Two thresholds fix
 * it — the glass turns on once you are past `enterAt` and only turns back off
 * below `exitAt` (exitAt < enterAt). The state machine therefore needs two
 * distinct crossings to toggle.
 *
 * Animated property: a dedicated absolutely-positioned opacity LAYER behind the
 * content. Toasting `backdrop-filter` itself (or `bg-*`) would animate a
 * paint-heavy property every frame; animating only the layer's opacity keeps
 * the work on the compositor. `backdrop-filter` on the layer is static.
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "framer-motion";
import { usePathname } from "next/navigation";
import { DUR } from "@/lib/client/motion";
// Phase 1.1: the settings entry gets a real SVG icon instead of an emoji.
import { Settings as SettingsIcon } from "@/components/ui/icons";
import { cn } from "@/components/track/cn";

const TITLES: Record<string, string> = {
  "/": "Home",
  "/search": "Search",
  "/library": "Library",
  "/settings": "Settings",
};

/** Route-level document titles, mirroring RouteTitle (one source per concern). */
const DOC_TITLES = TITLES;

interface TopbarProps {
  /** The real scroll container (Shell's <main>), or null before mount. */
  scrollRef: React.RefObject<HTMLElement | null>;
  /** Scroll offset (px) at which the glass turns ON. */
  enterAt?: number;
  /** Scroll offset (px) below which the glass turns OFF again (hysteresis). */
  exitAt?: number;
}

export default function Topbar({ scrollRef, enterAt = 8, exitAt = 2 }: TopbarProps) {
  const path = usePathname();
  const [glassy, setGlassy] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    // The container is Shell's <main>, which mounts in the same commit as this
    // header, so a null ref here means the shell is not up yet — nothing to
    // observe. The effect re-runs when the ref identity changes.
    if (!el) return;
    const onScroll = () => {
      const y = el.scrollTop;
      // Hysteresis: only flip when the opposite threshold is crossed.
      setGlassy((prev) => (prev ? y > exitAt : y >= enterAt));
    };
    // Sync once on attach so a restored scroll position paints the glass.
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef, enterAt, exitAt]);

  // Longest-prefix match (same rule as RouteTitle) so a nested route still shows
  // its section name rather than the bare brand.
  const key = Object.keys(TITLES)
    .filter((k) => (k === "/" ? path === "/" : path.startsWith(k)))
    .sort((a, b) => b.length - a.length)[0];
  const title = key ? DOC_TITLES[key] : "Sonic";

  return (
    <header className="sticky top-0 z-20 h-12 shrink-0">
      {/* Glass background layer — opacity-only animation. backdrop-blur and the
          wash live on this STATIC layer so the filter is never animated; §3.3
          era polish adds a hairline gradient that resolves the bar against
          artwork-tinted pages. */}
      <motion.div
        aria-hidden
        initial={false}
        animate={{ opacity: glassy ? 1 : 0 }}
        transition={{ duration: DUR.quick }}
        className="pointer-events-none absolute inset-0 border-b border-border bg-surface/80 backdrop-blur"
      />
      {/* Hairline gradient that only exists once the bar is over content: it
          resolves the glass against the artwork-tinted pages. Static paint on a
          static layer (the glass layer above carries the animation), and it is
          inert to the pointer. */}
      <span
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-accent/40 to-transparent",
          "transition-opacity duration-[var(--dur-standard)] ease-out",
          { "opacity-100": glassy, "opacity-0": !glassy },
        )}
      />
      <div className="relative flex h-full items-center gap-3 px-4">
        <span className="truncate text-sm font-semibold tracking-tight text-text">{title}</span>
        {/* Settings icon-button, pushed to the trailing edge. Same route as the
            sidebar/tab nav entry; hidden on md+ where the sidebar already shows
            a labeled Settings link (avoids duplicate affordances on desktop).
            44px hit area (rule 3) even though the glyph is 20px. */}
        <Link
          href="/settings"
          aria-label="Settings"
          className="ml-auto grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition-colors duration-[var(--dur-micro)] hover:bg-surface-2 hover:text-text md:hidden"
        >
          <SettingsIcon className="h-5 w-5" aria-hidden />
        </Link>
      </div>
    </header>
  );
}
