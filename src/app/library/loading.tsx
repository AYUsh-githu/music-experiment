/**
 * Route-level loading UI for `/library` (WS6).
 *
 * Mirrors the library page's real skeleton state, box-for-box, so the streamed
 * fallback reserves exactly the space the page then fills:
 *   h1 (h-8) + one-line subtitle
 *   -> mt-4 the three-tab bar (real `<span>`s with the live tab metrics, so the
 *      accent underline lands in place)
 *   -> mt-6 the active tab's row placeholders (6 rows ≈ the page's own list)
 * The tab labels are inert text here (a skeleton must never steal focus or look
 * clickable), which is why they are not buttons.
 */
import { PageTitleSkeleton, SkeletonBlock, TrackRowSkeleton } from "@/components/ui/Skeleton";

const TABS = ["Favorites", "Playlists", "History"];

export default function Loading() {
  return (
    <section className="mx-auto max-w-5xl" aria-busy="true" aria-label="Loading library">
      <PageTitleSkeleton />
      <SkeletonBlock className="mt-2 h-4 w-64 max-w-full" />

      {/* Tab bar — same borders/heights so the underline lands in place. */}
      <div className="mt-4 flex gap-1 overflow-x-auto border-b border-border">
        {TABS.map((label) => (
          <span
            key={label}
            className="shrink-0 border-b-2 border-transparent px-4 py-2 text-sm font-medium text-muted"
          >
            {label}
          </span>
        ))}
      </div>

      <div className="mt-6 flex flex-col gap-1">
        {Array.from({ length: 6 }, (_, i) => (
          <TrackRowSkeleton key={i} />
        ))}
      </div>
    </section>
  );
}
