"use client";

/**
 * Skeleton primitives — the shimmer placeholder system (WS6).
 *
 * WHY measured variants: a skeleton only prevents layout shift if its box is
 * the SAME size as the content that replaces it (spec §1: skeleton→content
 * layout-box delta ≤ 2px). Every variant below is therefore built from the
 * real component's classes, read straight out of the DOM it stands in for:
 *
 *   TrackRowSkeleton    <- src/components/track/TrackRow.tsx
 *                          `flex min-h-12 items-center gap-3 rounded-lg px-2 py-1.5`
 *                          + Artwork default `w-12 h-12` + the trailing cluster
 *                          (duration ~ w-9, heart 44px, overflow 44px, play 44px)
 *                          -> 60px tall (min-h-12 = 48px + py-1.5*2 = 12px), which
 *                          is exactly the real row's box: the min-height beats the
 *                          44px play button, so both resolve to 60px and the
 *                          skeleton->content delta is 0px, not "56px" as an
 *                          earlier comment claimed. Verified 2026-10-28.
 *   TrackCardSkeleton   <- src/components/home/TrackCard.tsx
 *                          `h-32 w-32` art + `mt-2` + title/artist lines -> 128px
 *                          art box (the row's height driver) in a `w-32` column.
 *   HistoryShelfSkeleton<- list of TrackRowSkeleton (library History tab).
 *   ProfileHeaderSkeleton
 *                       <- the header block every content route renders (h1 +
 *                          a one-line subtitle) so a route-level loading.tsx
 *                          reserves the exact same space as the real page.
 *   SettingsSectionSkeleton
 *                       <- src/app/settings/page.tsx control rows: each control
 *                          is an `h-11` child inside a `p-4 sm:p-5` cell.
 *   QueueSkeleton       <- QueueDrawer rows (`flex items-center gap-3 px-4 py-2.5`,
 *                          artwork w-10 h-10, title+artist, ~40px play button).
 *
 * All shimmer is `transform`-only: a `::after`-style gloss span driven by the
 * shared `sonic-shimmer` keyframe (globals.css), clipped by an overflow-hidden
 * parent. Nothing here animates width/height/inset. The whole sheet is
 * aria-hidden; the live region / aria-busy belongs on the consumer.
 */

/** The gloss overlay used by every placeholder block. */
function Shimmer() {
  return (
    <span
      className="sonic-shimmer pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent"
      aria-hidden
    />
  );
}

/**
 * One grey block with the shimmer sweep. `className` carries size + radius.
 * `className` is a full Tailwind literal at every call site, so this is NOT the
 * repo's dynamic-className case (`cn()` exists for conditional classes).
 */
function Block({ className }: { className: string }) {
  return (
    <span className={`relative block overflow-hidden rounded bg-surface-2 ${className}`}>
      <Shimmer />
    </span>
  );
}

/** A standalone shimmering block for headings/dividers in route loading UIs. */
export function SkeletonBlock({ className }: { className: string }) {
  return <Block className={className} />;
}

/**
 * The default export stays a generic single-row sheet so any pre-existing
 * `<Skeleton />` call site keeps a sensible placeholder (library/tab loads).
 * It IS TrackRowSkeleton — the most common shape in the app.
 */
export default function Skeleton() {
  return <TrackRowSkeleton />;
}

/**
 * One search/library row. Mirrors TrackRow's real box: min-h-12 + py-1.5 gives
 * a 60px row height (48 + 12) — the same box the real row resolves to, so the
 * swap is shift-free; the action cluster reserves the same trailing width so
 * text truncation lands in the same place before and after content arrives.
 *
 * Trailing cluster matches the CURRENT TrackRow: a `w-9` duration slot, the
 * favorite button and the ⋯ menu (both 44px), then the 44px play button. The
 * earlier `sm:` gating on two of those slots made the placeholder SHORTER than
 * the real row on desktop (a CLS jump at 640px+); every slot now renders at
 * every width, exactly like the live row.
 */
export function TrackRowSkeleton() {
  return (
    <div className="flex min-h-12 items-center gap-3 rounded-lg px-2 py-1.5" aria-hidden>
      {/* Index slot — TrackRow reserves `w-6` even for the number/bars. */}
      <div className="flex w-6 shrink-0 justify-center">
        <Block className="h-3 w-3.5" />
      </div>
      {/* Artwork — Artwork's default is a 48px (w-12 h-12) rounded tile. */}
      <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded-lg bg-surface-2">
        <Shimmer />
      </div>
      {/* Title + artist */}
      <div className="min-w-0 flex-1 space-y-2">
        <Block className="h-3.5 w-2/3" />
        <Block className="h-3 w-1/3" />
      </div>
      {/* Trailing cluster: duration slot + favorite + ⋯ menu + play. */}
      <Block className="h-3 w-9 shrink-0" />
      <span className="h-11 w-11 shrink-0 rounded-full bg-surface-2" />
      <span className="h-11 w-11 shrink-0 rounded-full bg-surface-2" />
      <span className="h-11 w-11 shrink-0 rounded-full bg-surface-2" />
    </div>
  );
}

/**
 * One shelf card. Mirrors TrackCard: the `h-32 w-32` (featured: h-44) art tile
 * is the row's height driver, followed by the `mt-2` title/artist block.
 */
export function TrackCardSkeleton({ featured = false }: { featured?: boolean }) {
  const art = featured ? "h-44 w-44" : "h-32 w-32";
  const column = featured ? "w-44" : "w-32";
  return (
    <div className={`flex shrink-0 flex-col ${column}`} aria-hidden>
      <div className={`relative overflow-hidden rounded-xl bg-surface-2 ${art}`}>
        <Shimmer />
      </div>
      <div className="mt-2 space-y-1.5">
        <Block className="h-3.5 w-24" />
        <Block className="h-3 w-16" />
      </div>
    </div>
  );
}

/**
 * A horizontal shelf of card skeletons, matching TrackCardRow's scroll layout
 * (`-mx-4 flex gap-4 overflow-x-auto px-4 pb-2 pt-1`) box-for-box — including
 * the top padding and negative gutter, which is what keeps the shelf's height
 * and inner alignment identical to the real row.
 */
export function TrackCardRowSkeleton({ cards = 4 }: { cards?: number }) {
  return (
    <div className="-mx-4 flex gap-4 overflow-x-auto px-4 pb-2 pt-1" aria-hidden>
      {Array.from({ length: cards }, (_, i) => (
        <TrackCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** History shelf — a vertical list of real-size rows (library History tab). */
export function HistoryShelfSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-1" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <TrackRowSkeleton key={i} />
      ))}
    </div>
  );
}

/**
 * Page header placeholder (h1 + one-line subtitle). Route-level loading.tsx
 * files use this so the title block occupies its final space before the page
 * streams in — the single largest CLS source on a cold navigation.
 *
 * The h1 box is 36px, not 32px: the shared page-title scale is
 * `text-3xl ... sm:text-4xl` (36px → 40px line box), so this reserves the
 * LARGER of the two — under-reserving would push the whole page down the moment
 * the real heading streams in. `withSubtitle` must mirror whether the real route
 * renders one: the three content routes do (a `mt-1` one-liner), Home has its own
 * header, so passing the default there would reserve a line that never fills.
 */
export function ProfileHeaderSkeleton({ withSubtitle = true }: { withSubtitle?: boolean }) {
  return (
    <div className="space-y-2" aria-hidden>
      <Block className="h-10 w-40" />
      {withSubtitle && <Block className="h-4 w-64 max-w-full" />}
    </div>
  );
}

/**
 * H1 box for the three content routes. h-10 (40px) matches the resolved line box
 * of the shared `text-3xl sm:text-4xl` page-title scale, so the skeleton and the
 * real heading occupy identical space at every width.
 */
export function PageTitleSkeleton() {
  return <SkeletonBlock className="h-10 w-40" />;
}

/**
 * One settings row. Mirrors the live Settings row shell: a leading 36px icon
 * tile, the two-line label column, then an `h-11` control — inside the same
 * `px-4 py-3.5 sm:px-5` cells separated by 1px dividers.
 */
export function SettingsRowSkeleton({ controlWidth = "w-32" }: { controlWidth?: string }) {
  return (
    <div className="flex items-center gap-4 px-4 py-3.5 sm:px-5" aria-hidden>
      <span className="h-9 w-9 shrink-0 rounded-lg bg-surface-2" />
      <div className="min-w-0 flex-1 space-y-1.5">
        <Block className="h-3.5 w-32" />
        <Block className="h-3 w-56 max-w-full" />
      </div>
      <Block className={`h-11 shrink-0 ${controlWidth}`} />
    </div>
  );
}

/** A full settings card (rows + dividers) in the page's real container box. */
export function SettingsSectionSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface">
      {Array.from({ length: rows }, (_, i) => (
        <SettingsRowSkeleton
          key={i}
          // The third preference row is a checkbox, not a segmented control: a
          // 20px square where the other two carry an 11-unit (44px) pill.
          controlWidth={i === rows - 1 ? "w-5" : "w-32"}
        />
      ))}
    </div>
  );
}

/**
 * Queue drawer rows. Mirrors QueueDrawer's `flex items-center gap-3 px-4 py-2.5`
 * row with a 40px artwork tile and a trailing 40px play button.
 */
export function QueueSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-1 px-2 py-1" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg px-2 py-2.5">
          <span className="h-10 w-10 shrink-0 rounded-md bg-surface-2" />
          <div className="min-w-0 flex-1 space-y-2">
            <Block className="h-3.5 w-3/5" />
            <Block className="h-3 w-2/5" />
          </div>
          <span className="h-10 w-10 shrink-0 rounded-full bg-surface-2" />
        </div>
      ))}
    </div>
  );
}

/** Lyrics panel placeholder (used while /api/lyrics resolves). */
export function LyricsSkeleton({ lines = 6 }: { lines?: number }) {
  const widths = ["w-4/5", "w-3/5", "w-2/3", "w-1/2", "w-3/4", "w-2/5"];
  return (
    <div className="flex flex-col gap-3 py-6" aria-hidden>
      {Array.from({ length: lines }, (_, i) => (
        <Block key={i} className={`h-4 ${widths[i % widths.length]}`} />
      ))}
    </div>
  );
}
