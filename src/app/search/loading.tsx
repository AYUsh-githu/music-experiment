/**
 * Route-level loading UI for `/search` (WS6).
 *
 * Mirrors the search page's real skeleton state box-for-box so the streamed
 * fallback and the page that replaces it are pixel-identical:
 *   h1 (h-8 == text-2xl/4xl line box) + one-line subtitle
 *   -> mt-4 56px (h-14) pill field, rounded-full
 *   -> mt-3 44px recent-chips slot (reserved at all times on the page too)
 *   -> mt-5 result rows
 * Nothing here is interactive, so there is no focusable decoy to Tab into.
 */
import { PageTitleSkeleton, SkeletonBlock, TrackRowSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <section className="mx-auto max-w-5xl" aria-busy="true" aria-label="Loading search">
      <PageTitleSkeleton />
      <SkeletonBlock className="mt-2 h-4 w-64 max-w-full" />

      {/* Search field occupies its final 56px pill box before hydration. */}
      <SkeletonBlock className="mt-4 h-14 w-full rounded-full border border-border bg-surface" />

      {/* Recent-search slot — the page reserves this height unconditionally. */}
      <div className="mt-3 h-11" aria-hidden />

      <div className="mt-5 flex flex-col gap-1">
        {Array.from({ length: 6 }, (_, i) => (
          <TrackRowSkeleton key={i} />
        ))}
      </div>
    </section>
  );
}
