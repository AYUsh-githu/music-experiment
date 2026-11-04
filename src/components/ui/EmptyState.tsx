"use client";

/**
 * Friendly empty / "nothing here" state (WS6 polished).
 *
 * WHY a component: the idle prompt, the no-results case, the empty shelf and
 * the offline/error case all share one centered layout, so extracting it keeps
 * every call site consistent and stops spacing/typography from drifting apart.
 *
 * WS6 additions (both optional, so all existing call sites keep compiling):
 *  - `icon` — a themed glyph. Phase 1.6: pass a real `Icon` component from
 *    ui/icons.tsx (call sites migrate gradually); string emoji call sites still
 *    compile but render as a plain glyph. Default is the headphones-less ghost:
 *    the disc-style Library icon, oversized + low-opacity (YouTube Music's
 *    "ghost illustration" pattern).
 *  - `action` — a CTA slot (e.g. "New playlist", "Try again"). Rendered as a
 *    real focusable node supplied by the caller so the copy/label stays with
 *    the page, not the primitive.
 *
 * Motion: a gentle fade + 4px rise on mount via the shared motion tokens
 * (DUR.quick, EASE.out). Reduced motion collapses it through the root
 * MotionConfig reducedMotion="user" + the global CSS guard.
 */
import { motion } from "framer-motion";
import type { ReactNode, SVGProps } from "react";
import { DUR, EASE } from "@/lib/client/motion";
// Conditional-class helper (no template string assembly — see its docs).
import { cn } from "@/components/track/cn";
import { Library } from "@/components/ui/icons";

interface EmptyStateProps {
  title: string;
  description?: string;
  /** Icon component from ui/icons.tsx (preferred), an emoji string, or any node. */
  icon?: ReactNode;
  /** Optional CTA slot — a real button/link supplied by the caller. */
  action?: ReactNode;
  /**
   * Heading level for `title`. Defaults to 3, which keeps the state nested
   * inside whatever section renders it (Home's shelves own their h2). Routes
   * whose empty state IS the page content pass 2.
   */
  headingLevel?: 2 | 3;
}

/**
 * Alert glyph for error/failure states.
 *
 * WHY it lives here and not in ui/icons.tsx: that module is another
 * workstream's file, and its set has no alert/warning symbol — every consumer
 * had fallen back to the "⚠️" emoji, which renders at wildly different sizes
 * per OS and sits off-baseline in the ghost tile. This is the same 24px /
 * currentColor geometry as ui/icons, declared next to the one component that
 * needs it.
 */
export function AlertIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      <path d="M12 4.6 21 19.4H3L12 4.6Z" />
      <path d="M12 10v3.6" />
      <circle cx="12" cy="16.4" r="0.9" fill="currentColor" stroke="none" />
    </svg>
  );
}

export default function EmptyState({
  title,
  description,
  icon,
  action,
  headingLevel = 3,
}: EmptyStateProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DUR.quick, ease: EASE.out }}
      className="flex flex-col items-center gap-2 rounded-xl border border-border bg-surface px-6 py-12 text-center"
    >
      {/* Phase 1.6 ghost style: oversized, faded to 40% — an illustration-like
          watermark, not a button-sized glyph (YouTube Music pattern). Any node
          renders at the full ghost size via the arbitrary-variant child rule,
          which also covers plain <svg> nodes (h-24), icon components, and —
          with the sibling rule — two-glyph stacks. Emoji strings still render
          (their own metrics), but every in-repo call site now passes an SVG.
          aria-hidden either way. */}
      <span
        className={cn(
          "opacity-40 text-text",
          typeof icon === "string"
            ? "text-3xl"
            : "[&>svg]:h-24 [&>svg]:w-24 [&>svg]:mx-auto [&_svg]:text-current"
        )}
        aria-hidden
      >
        {icon ?? <Library />}
      </span>
      {/* A real heading so the state is navigable by heading list, at the same
          scale as the app's section headings. */}
      <Heading className="text-base font-semibold tracking-tight text-text">{title}</Heading>
      {description && <p className="max-w-sm text-sm text-muted">{description}</p>}
      {action && <div className="mt-3">{action}</div>}
    </motion.div>
  );
}
