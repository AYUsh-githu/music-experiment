"use client";

/**
 * App shell: responsive navigation + the persistent chrome (WS7).
 *
 * WHY a client component: it uses `usePathname` to highlight the active route
 * and owns the real scroll container's ref, so it must opt into the client
 * bundle.
 *
 * Layout: a persistent left rail on desktop, a bottom tab bar on mobile. THIS
 * component owns the app's scroll container — <main> is `overflow-y-auto`, so
 * the document itself never scrolls. Everything scroll-linked (topbar glass,
 * back-to-top, route-change reset) therefore attaches HERE, to <main>, and not
 * to `window` (a window listener would never fire).
 *
 * WS7 additions:
 *  - Active nav pill using framer `layoutId` — one shared element that morphs
 *    between sidebar items and between bottom-tab items (transform-only). Two
 *    ids because the desktop rail and the mobile tab bar cross-fade rather than
 *    coexist, so a single id would try to morph across the viewport.
 *  - Topbar (glass-on-scroll, hysteresis) — see components/layout/Topbar.tsx.
 *  - Per-route document.title and scroll-to-top-on-navigation.
 *
 * Player spacing (WS7 / F4 dependency note): the fixed player surfaces are
 * measured from the DOM, not guessed:
 *   - mobile bottom tab bar:  ~52px (py-2.5 + text-lg glyph + 11px label + 0.5 gap)
 *   - mobile mini-player:     ~64px (Artwork h-11=44px + container py-2=16px +
 *                                   1px border), lifted to bottom-[52px]
 *   - desktop mini-player:    ~93px (h-11 art + py-2 + border + the ProgressBar
 *                                   row it carries: ~20px) — floored at 96px
 * so `pb-24` (96px) covers mobile exactly and `md:pb-32` (128px) leaves ~35px
 * of breathing room under the desktop bar. `md:pb-36` was NOT needed: it would
 * add 16px of dead space the bar never fills.
 */
import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { useEffect, useRef } from "react";
import { DUR, EASE } from "@/lib/client/motion";
import { useIsPlaying } from "@/lib/client/playState";
import BackToTop from "@/components/ui/BackToTop";
// Phase 1.1: real SVG icons replace emoji glyphs (inconsistent metrics per OS).
import { Home, Search as SearchIcon, Library, Settings } from "@/components/ui/icons";
import Topbar from "./Topbar";
import RouteTitle from "./RouteTitle";

// Icons are components now, not emoji strings — so NAV stores the component and
// the render site mounts it. Type kept loose (a ComponentType union would work
// but gains nothing here).
const NAV = [
  { href: "/", label: "Home", Icon: Home },
  { href: "/search", label: "Search", Icon: SearchIcon },
  { href: "/library", label: "Library", Icon: Library },
  { href: "/settings", label: "Settings", Icon: Settings },
];

/**
 * Tiny static 5-bar waveform brand mark (Phase 1.2).
 *
 * WHY a separate tiny component: it needs `playing` from the player context,
 * and the shell body does not — keeping the hook use here (rather than in
 * Shell) means the shell re-renders on play state only through this subtree
 * boundary, not for the whole chrome.
 *
 * Animation: `.eq-anim` CSS keyframes (transform-only), applied only when
 * `playing` is true; the global prefers-reduced-motion guard in globals.css
 * collapses the keyframes to a static squashed pose.
 */
function BrandMark({ playing }: { playing: boolean }) {
  return (
    <svg
      viewBox="0 0 22 18"
      width="22"
      height="18"
      aria-hidden="true"
      className="text-accent"
      fill="currentColor"
    >
      {[0, 1, 2, 3, 4].map((i) => (
        <rect
          key={i}
          x={i * 4.4}
          y={2}
          width={2.4}
          height={14}
          rx={1.2}
          className={playing ? "eq-anim" : "eq-paused"}
          style={playing ? { animationDelay: `${i * 0.12}s` } : undefined}
        />
      ))}
    </svg>
  );
}

/** Left rail on desktop / bottom tabs on mobile, with a brand header. */
export default function Shell({ children }: { children: React.ReactNode }) {
  // Compute the active path exactly once. Calling usePathname/useIsActive inside
  // the map callbacks below would violate the rules of hooks (a hook call inside
  // a callback), so we derive `isActive` per entry up here instead.
  const path = usePathname();
  // Play state drives only the tiny brand mark (see BrandMark). Read through a
  // one-way external store rather than useContext: Shell wraps AppProviders, so
  // it sits ABOVE the provider and must never require it (doing so broke the
  // static /_not-found prerender). PlayStateSync publishes from inside.
  const playing = useIsPlaying();

  /**
   * The app's real scroll container. <main> is `overflow-y-auto`, so this ref —
   * not `window` — is what the topbar, back-to-top and route-reset watch.
   */
  const mainRef = useRef<HTMLElement | null>(null);

  // App Router does not restore an inner scroll container on navigation, so a
  // user scrolled halfway down Search would land mid-page on Library. Reset it
  // here on every pathname change (the container is ours, so this is the only
  // place it can be done).
  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [path]);

  const isActive = (href: string) =>
    href === "/" ? path === "/" : path.startsWith(href);

  return (
    <div className="flex h-full">
      <RouteTitle />
      {/* Skip-to-content link: visually hidden until focused, so keyboard and
          screen-reader users can jump straight past the left rail on any nav. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only fixed left-2 top-2 z-[70] rounded-lg bg-surface px-4 py-2 text-sm font-medium text-text shadow-md focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        Skip to content
      </a>
      {/* Desktop sidebar */}
      <aside className="hidden w-56 shrink-0 flex-col border-r border-border bg-surface md:flex">
        <div className="flex items-center gap-2 px-5 py-5">
          {/* Phase 1.2 brand block: gradient wordmark + a small 5-bar waveform
              mark. The wordmark is the accessible name; the mark is aria-hidden
              decoration that animates (.eq-anim) only while playing — the global
              prefers-reduced-motion guard in globals.css kills the keyframes. */}
          <span className="text-gradient-accent text-lg font-bold tracking-tight">
            Sonic
          </span>
          <BrandMark playing={playing} />
        </div>
        <nav className="flex flex-col gap-1 px-3" aria-label="Primary navigation">
          {NAV.map((n) => {
            const active = isActive(n.href);
            return (
              <Link
                key={n.href}
                href={n.href}
                aria-current={active ? "page" : undefined}
                className="relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium text-muted transition-colors hover:text-text"
              >
                {/* Shared-element pill: one node morphs between active items.
                    `layoutId` is transform-based and scoped to this small nav
                    subtree, so it stays inside the §4 motion budget. */}
                {active && (
                  <motion.span
                    layoutId="nav-pill-desktop"
                    aria-hidden
                    className="absolute inset-0 -z-10 rounded-lg bg-surface-2"
                    transition={{ duration: DUR.quick, ease: EASE.out }}
                  />
                )}
                <span className="relative text-text" aria-hidden>
                  <n.Icon className="h-5 w-5" />
                </span>
                <span className={active ? "relative text-text" : "relative"}>{n.label}</span>
              </Link>
            );
          })}
        </nav>
        <p className="mt-auto px-5 pb-4 text-[11px] leading-relaxed text-muted">
          For personal testing/education only.
        </p>
      </aside>

      {/* Main column */}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <Topbar scrollRef={mainRef} />
        <main
          id="main"
          ref={mainRef}
          tabIndex={-1}
          className="min-h-0 flex-1 overflow-y-auto px-4 pt-4 [padding-bottom:calc(6rem+env(safe-area-inset-bottom))] md:[padding-bottom:8rem]"
        >
          {children}
        </main>
      </div>

      {/* Back-to-top for long lists — watches the same real scroll container. */}
      <BackToTop scrollRef={mainRef} />

      {/* Mobile bottom tab bar */}
      <nav
        aria-label="Quick navigation"
        className="fixed inset-x-0 bottom-0 z-20 flex border-t border-border bg-surface/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden"
      >
        {NAV.map((n) => {
          const active = isActive(n.href);
          return (
            <Link
              key={n.href}
              href={n.href}
              aria-current={active ? "page" : undefined}
              className={`relative flex flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] transition-colors ${
                active ? "text-accent-2" : "text-muted hover:text-text"
              }`}
            >
              {active && (
                <motion.span
                  layoutId="nav-pill-mobile"
                  aria-hidden
                  className="absolute inset-x-2 top-0 h-0.5 rounded-full bg-accent-2"
                  transition={{ duration: DUR.quick, ease: EASE.out }}
                />
              )}
              <span aria-hidden>
                <n.Icon className="h-5 w-5" />
              </span>
              {n.label}
            </Link>
          );
        })}
      </nav>
    </div>
  );
}
