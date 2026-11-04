/**
 * Hand-authored inline SVG icon set (Phase 1.1).
 *
 * WHY hand-authored rather than a dependency: the plan (frontend.md §1.1) forbids
 * new dependencies and emoji glyphs render with inconsistent metrics per OS.
 * These share one geometry language — 24px viewBox, 1.8 stroke, currentColor —
 * so sizing and color come purely from the consumer: `className` sets size
 * (e.g. h-5 w-5), and text color drives stroke/fill via currentColor.
 *
 * Stroke-based icons use stroke="currentColor" fill="none"; a few glyphs
 * (Play, Pause, Heart-filled) read better solid and are fill-based. Every
 * component is a plain function component taking SVGProps, so callers can pass
 */
import type { SVGProps, ReactNode } from "react";

/** Shared props every stroke icon passes through. */
type IconProps = SVGProps<SVGSVGElement>;

/** Base SVG wrapper: 24px grid, currentColor, no auto-sizing so className rules. */
function Svg({ children, ...props }: IconProps & { children: ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="1em"
      height="1em"
      fill="none"
      stroke="currentColor"
      // ONE geometry language: every glyph is drawn on the same 24px grid with
      // the same 1.8px optical weight and the same round caps/joins, so a row of
      // mixed icons reads as one set. See the fill-only glyphs in this file
      // (Play, Pause) for why they are the deliberate exception.
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

/* ---------------- Transport ---------------- */

/** Play — solid triangle variant (reads better small than an outline). */
export function Play(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M8 5.5v13a1 1 0 0 0 1.54.84l10-6.5a1 1 0 0 0 0-1.68l-10-6.5A1 1 0 0 0 8 5.5Z" />
    </svg>
  );
}

/** Pause — two solid bars. */
export function Pause(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor" aria-hidden="true" {...props}>
      <rect x="6" y="4.5" width="4" height="15" rx="1.2" />
      <rect x="14" y="4.5" width="4" height="15" rx="1.2" />
    </svg>
  );
}

export function SkipBack(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 5v14" />
      <path d="M17.3 5.9 9.9 11.2a1 1 0 0 0 0 1.6l7.4 5.3a1 1 0 0 0 1.6-.8V6.7a1 1 0 0 0-1.6-.8Z" />
    </Svg>
  );
}

export function SkipForward(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M18 5v14" />
      <path d="M6.7 5.9 14.1 11.2a1 1 0 0 1 0 1.6l-7.4 5.3a1 1 0 0 1-1.6-.8V6.7a1 1 0 0 1 1.6-.8Z" />
    </Svg>
  );
}

export function Shuffle(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 6h3.5c1.4 0 2.7.7 3.4 1.9l3.7 6.2A4 4 0 0 0 17.1 16H21" />
      <path d="m18.5 13.5 2.5 2.5-2.5 2.5" />
      <path d="M3 18h3.5c1.4 0 2.7-.7 3.4-1.9l.5-.8" />
      <path d="M14.2 8.8A4 4 0 0 1 17.1 8H21" />
      <path d="m18.5 5.5 2.5 2.5-2.5 2.5" />
    </Svg>
  );
}

export function Repeat(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17 3.5 19.5 6 17 8.5" />
      <path d="M19.5 6H7a3 3 0 0 0-3 3v1.5" />
      <path d="M7 20.5 4.5 18 7 15.5" />
      <path d="M4.5 18H17a3 3 0 0 0 3-3v-1.5" />
    </Svg>
  );
}

export function RepeatOne(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M17 3.5 19.5 6 17 8.5" />
      <path d="M19.5 6H7a3 3 0 0 0-3 3v1.5" />
      <path d="M7 20.5 4.5 18 7 15.5" />
      <path d="M4.5 18H17a3 3 0 0 0 3-3v-1.5" />
      <path d="M11.5 10.5 13 9.8v4.7" />
    </Svg>
  );
}

export function Queue(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h12" />
      <path d="M4 11h12" />
      <path d="M4 16h7" />
      <path d="M18 11v7.5" />
      <path d="m15.5 16.7 2.5 1.8 2.5-1.8" />
    </Svg>
  );
}

/** Lyrics — text lines over a mic-less "note" accent: 3 lines of words. */
export function Lyrics(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 6h13" />
      <path d="M4 11h16" />
      <path d="M4 16h9" />
      <path d="M17 13.8v4.4" />
      <circle cx="16" cy="18.8" r="1.4" />
    </Svg>
  );
}

/**
 * Heart — outline by default. Pass `filled` to render the solid variant
 * (FavoriteButton's active state) without a second icon name.
 */
export function Heart({ filled = false, ...props }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...props} fill={filled ? "currentColor" : "none"}>
      <path d="M12 20.3S3.5 15.5 3.5 9.6C3.5 6.9 5.6 5 8.1 5c1.6 0 3.1.8 3.9 2.1A4.6 4.6 0 0 1 15.9 5c2.5 0 4.6 1.9 4.6 4.6 0 5.9-8.5 10.7-8.5 10.7Z" />
    </Svg>
  );
}

/* ---------------- Volume ---------------- */

export function VolumeHigh(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 10v4h3l4.5 3.5v-15L7 10H4Z" transform="translate(0 .5)" />
      <path d="M15 9.2a4 4 0 0 1 0 5.6" />
      <path d="M17.6 6.8a7.5 7.5 0 0 1 0 10.4" />
    </Svg>
  );
}

export function VolumeLow(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 10v4h3l4.5 3.5v-15L7 10H4Z" transform="translate(0 .5)" />
      <path d="M15 9.2a4 4 0 0 1 0 5.6" />
    </Svg>
  );
}

export function VolumeMute(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 10v4h3l4.5 3.5v-15L7 10H4Z" transform="translate(0 .5)" />
      <path d="m15.5 9.5 5 5" />
      <path d="m20.5 9.5-5 5" />
    </Svg>
  );
}

/* ---------------- Chrome / window ---------------- */

export function Expand(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M14 4h6v6" />
      <path d="m20 4-6.5 6.5" />
      <path d="M10 20H4v-6" />
      <path d="m4 20 6.5-6.5" />
    </Svg>
  );
}

export function Collapse(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M20 10h-6V4" />
      <path d="m14 4-6.5 6.5" />
      <path d="M4 14h6v6" />
      <path d="m10 14 6.5 6.5" />
    </Svg>
  );
}

export function MoreHorizontal(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="5" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="19" cy="12" r="1.1" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function ChevronLeft(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m14.5 5.5-6.5 6.5 6.5 6.5" />
    </Svg>
  );
}

export function ChevronRight(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
    </Svg>
  );
}

export function X(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m6 6 12 12" />
      <path d="m18 6-12 12" />
    </Svg>
  );
}

/* ---------------- Status ---------------- */

/**
 * Plus — the "add / create" glyph. A single 1.8px cross on the 24px grid.
 * WHY it exists: call sites built "+" out of text glyphs or hand-rolled SVGs at
 * a different stroke weight, which read as a different icon family next to the
 * rest of the set.
 */
export function Plus(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </Svg>
  );
}

/**
 * Trash — delete/destructive row glyph. Lid, body and two inner ribs, drawn at
 * the shared 1.8px weight.
 */
export function Trash(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4.5 7h15" />
      <path d="M9.5 7V5.2A1.2 1.2 0 0 1 10.7 4h2.6a1.2 1.2 0 0 1 1.2 1.2V7" />
      <path d="M6.5 7 7.4 19a1.4 1.4 0 0 0 1.4 1.3h6.4A1.4 1.4 0 0 0 16.6 19L17.5 7" />
      <path d="M10.4 10.8v6" />
      <path d="M13.6 10.8v6" />
    </Svg>
  );
}

/**
 * Waveform — the brand/equalizer mark: three bars of unequal height on the same
 * baseline. Static; callers that need motion use EqualizerBars.
 */
export function Waveform(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 9.5v5" />
      <path d="M12 5v14" />
      <path d="M18 8v8" />
    </Svg>
  );
}

/* ---------------- Nav / pages ---------------- */

export function Clock(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </Svg>
  );
}

export function Home(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m4 10.8 8-6.6 8 6.6V19a1.2 1.2 0 0 1-1.2 1.2h-4v-6h-5.6v6h-4A1.2 1.2 0 0 1 4 19v-8.2Z" />
    </Svg>
  );
}

export function Search(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="m15.2 15.2 4.8 4.8" />
    </Svg>
  );
}

/** Library — a disc (circle + center hole) over a note stack hint. */
export function Library(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="10" cy="12" r="6.5" />
      <circle cx="10" cy="12" r="1.4" fill="currentColor" stroke="none" />
      <path d="M17.5 5.5a8.3 8.3 0 0 1 0 13" />
    </Svg>
  );
}

export function Settings(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 3.8v2.2M12 18v2.2M5.6 5.6l1.6 1.6M16.8 16.8l1.6 1.6M3.8 12H6M18 12h2.2M5.6 18.4l1.6-1.6M16.8 7.2l1.6-1.6" />
    </Svg>
  );
}

export function Check(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </Svg>
  );
}

/* ---------------- Discovery & milestones ---------------- */

/** Sparkle — a four-point star. Used for the discovery wheel and for the
 *  "new" affordance. Drawn on the same 24px grid as the rest of the set. */
export function Sparkle(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12 3.5c.6 3.6 2.4 5.4 6 6-3.6.6-5.4 2.4-6 6-.6-3.6-2.4-5.4-6-6 3.6-.6 5.4-2.4 6-6Z" />
      {/* The little satellite spark keeps it from reading as a plain diamond
          at small sizes, where the main star's points collapse. */}
      <path d="M18 16.5c.25 1.4.95 2.1 2.35 2.35-1.4.25-2.1.95-2.35 2.35-.25-1.4-.95-2.1-2.35-2.35 1.4-.25 2.1-.95 2.35-2.35Z" />
    </Svg>
  );
}

/** Trophy — a milestone/badge glyph. Cup body, handles, and a base plinth. */
export function Trophy(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M7.5 4.5h9v4.2a4.5 4.5 0 0 1-9 0V4.5Z" />
      <path d="M7.5 6H5.4a2.4 2.4 0 0 0 2.1 3.4M16.5 6h2.1a2.4 2.4 0 0 1-2.1 3.4" />
      <path d="M12 13.2V16M8.8 19.5h6.4M10 16h4" />
    </Svg>
  );
}
