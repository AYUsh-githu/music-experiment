"use client";

/**
 * Page-transition wrapper (WS7 · SONIC Motion Language).
 *
 * Next.js <template> re-mounts on every route change while the <layout> (and
 * everything mounted there — the shared <audio> player in AppProviders) survives.
 * This is the crucial distinction that makes the page transition safe:
 *
 *   - The ROOT layout holds PlayerProvider / <audio> / MiniPlayer / FullPlayer /
 *     QueueDrawer. Because it is the layout and NOT the template, it NEVER
 *     remounts when you navigate — playback and the player context survive
 *     untouched.
 *   - THIS template wraps only each route's page children, so it remounts on
 *     navigation and can animate the incoming page in.
 *
 * Motion (§7 ADOPT / WS7): fade + 8px rise at DUR.quick (200ms) on EASE.out,
 * both pulled from the shared motion tokens so the curve can never drift from
 * the rest of the app. Total is well inside the ≤320ms route-transition budget.
 * Nothing animates on the initial server render; the browser only runs this on
 * client-side navigations. Reduced-motion users get zero movement via the root
 * MotionConfig reducedMotion="user" (mounted once in AppProviders, not repeated
 * here — a nested MotionConfig with a different value would silently override
 * the global opt-in).
 */

import { motion } from "framer-motion";
import { DUR, EASE } from "@/lib/client/motion";

export default function Template({ children }: { children: React.ReactNode }) {
  // The framer mount-entrance is the ONLY route transition. An earlier attempt
  // suppressed it on View-Transitions-capable browsers so the VT pseudo-elements
  // (styled in globals.css) could take over — but nothing ever CALLED
  // document.startViewTransition: <template> cannot wrap the App Router's own
  // navigation, so that path produced NO animation at all on Chrome/Edge/Safari.
  // Until VT is wired into real navigation (a §12 proposal — it needs the
  // experimental Next flag or Link/router plumbing, which this workstream must
  // not touch), the framer entrance is kept for every browser. It already animates
  // transform/opacity only, totals 200ms (inside the ≤320ms route budget), and is
  // collapsed globally by MotionConfig reducedMotion="user".
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      // Exit is skipped: keep it a lightweight one-way fade-in so the outgoing
      // page vanishes instantly and the incoming page slides in beneath it.
      transition={{ duration: DUR.quick, ease: EASE.out }}
    >
      {children}
    </motion.div>
  );
}