/**
 * Route-level loading UI for `/settings` (WS6).
 *
 * Mirrors the settings page section-for-section:
 *   h1 (h-8) + one-line subtitle
 *   -> "Playback & interface" heading + a 3-row card (icon tile, two-line label,
 *      h-11 control — the last row's control is the 20px checkbox)
 *   -> "Danger zone" heading + its explanatory row + the 1/2-column action grid
 * Row metrics come from the shared SettingsSectionSkeleton so this fallback can
 * never drift from the real rows.
 */
import {
  PageTitleSkeleton,
  SettingsRowSkeleton,
  SettingsSectionSkeleton,
  SkeletonBlock,
} from "@/components/ui/Skeleton";

export default function Loading() {
  return (
    <section className="mx-auto max-w-5xl" aria-busy="true" aria-label="Loading settings">
      <PageTitleSkeleton />
      <SkeletonBlock className="mt-2 h-4 w-64 max-w-full" />

      {/* Section heading placeholder at the real h-5 (20px) text box. */}
      <SkeletonBlock className="mt-6 h-5 w-40" />
      <div className="mt-3">
        <SettingsSectionSkeleton rows={3} />
      </div>

      <SkeletonBlock className="mt-8 h-5 w-28" />
      <div className="mt-3 overflow-hidden rounded-xl border border-border bg-surface">
        <SettingsRowSkeleton controlWidth="w-0" />
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {Array.from({ length: 4 }, (_, i) => (
          <SkeletonBlock
            key={i}
            className="h-11 w-full rounded-lg border border-border bg-surface"
          />
        ))}
      </div>
    </section>
  );
}
