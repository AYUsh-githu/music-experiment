/**
 * Route-level loading UI for `/` (WS6).
 *
 * WHY it exists even though Home's data is fetched client-side: the pages are
 * static-prerendered, so this streamed fallback only shows on a cold navigation
 * with a slow first byte. It is cheap insurance and it reuses the exact same
 * measured primitives the page itself renders, so the swap is invisible.
 *
 * Layout mirrors HomeView box-for-box: the shared page-title scale + one-line
 * subtitle, then Home's shelves. The card skeletons are the real TrackCard size
 * (h-32 w-32 + text) inside TrackCardRowSkeleton, which carries the live row's
 * padding so nothing shifts when the real shelf arrives.
 */
import { PageTitleSkeleton, SkeletonBlock, TrackCardRowSkeleton } from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <section className="mx-auto max-w-5xl" aria-busy="true" aria-label="Loading home">
      <PageTitleSkeleton />
      <SkeletonBlock className="mt-2 h-4 w-64 max-w-full" />

      <div className="mt-6 flex flex-col gap-8">
        {/* The shelf headings are real text (not blocks): they are static and
            known ahead of time, so a shimmer there would be pure noise. Their
            class matches TrackCardRow's own heading row, `mb-3` included. */}
        {["Trending", "Recently played"].map((heading) => (
          <section key={heading} aria-label={heading}>
            <div className="mb-3">
              <h2 className="text-lg font-semibold tracking-tight text-text">{heading}</h2>
            </div>
            <TrackCardRowSkeleton />
          </section>
        ))}
      </div>
    </section>
  );
}
