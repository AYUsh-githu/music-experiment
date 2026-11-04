"use client";

/**
 * Lazy cover-art image with a graceful gradient fallback.
 *
 * WHY a client component: artwork URLs (from YouTube / iTunes enrichment) can
 * 404 for placeholder or deleted tracks, and swapping to a fallback after a
 * failed load needs React state. Instead of a broken-image icon we show a
 * gradient tile carrying the track's initials — matching the plan's
 * "artwork placeholder gradient with initials" goal (plan §5.2 / Phase 5).
 */
import { useMemo, useState } from "react";
import type { Track } from "@/lib/types";
import { useAppSettings } from "@/lib/client/settings";

interface ArtworkProps {
  track: Pick<Track, "artwork" | "title" | "artist">;
  /** Tailwind sizing for BOTH width and height, e.g. "w-12 h-12". Default 48px. */
  size?: string;
  /**
   * Load immediately instead of deferring.
   *
   * WHY opt-in rather than the default (§4 Data & media): `loading="lazy"` is
   * right for the long shelves of cards, where deferring off-screen art saves
   * real bytes. It is WRONG for the player chrome — the mini-player thumbnail
   * and the full-player hero are above the fold and on screen at the moment the
   * track changes, so deferring them shows an empty tile for the art the user is
   * actively looking at. Only those call sites pass `eager`.
   */
  eager?: boolean;
}

/** "Shape of You" + "Ed Sheeran" -> "SE"; falls back to a note glyph. */
function initialsOf(title: string, artist: string): string {
  const first = (s?: string) => (s ? s.trim().charAt(0) : "");
  return `${first(artist)}${first(title)}`.toUpperCase() || "♪";
}

/**
 * Rewrite an artwork URL's embedded size segment so the browser requests a
 * smaller image when the setting asks for one (phase 4 §4.3).
 *
 * Convention: we never throw and never emit a malformed URL — on any shape we
 * don't confidently recognize we return the input unchanged.
 *
 * iTunes / Apple Music (mzstatic.com) URLs embed the size as a marker like
 * "600x600bb" or a segment like "/100x100bb/" — we swap those to 100x100bb,
 * the smallest standard thumbnail. YouTube thumbnails carry a size-segment
 * path such as "/hqdefault.jpg" when already small, so those pass through
 * untouched. Anything else is left as-is.
 */
function smarterArtworkUrl(url: string, size: "small" | "large"): string {
  if (size !== "small") return url;

  // mzstatic thumbnail marker, e.g. "600x600bb" (or any NxNbb), which sits
  // between URL path segments. Swap it for the smallest standard thumbnail.
  // The slash-separated form "/100x100bb/" is already that size, and the
  // regex below won't match it empty-to-empty nor disturb its slashes.
  const marker = url.match(/\d+x\d+bb/);
  if (marker && marker[0] !== "100x100bb") {
    return url.replace(marker[0], "100x100bb");
  }

  return url;
}

export default function Artwork({ track, size = "w-12 h-12", eager = false }: ArtworkProps) {
  // Plan 1.6: art fades in once loaded (opacity only, ~200ms — DUR.quick). No
  // layout shift: the fixed box already reserves the slot, so nothing reflows.
  //
  // WHY the source is tracked alongside the flag: these instances are REUSED
  // across tracks (the mini-player and the full-player hero keep one Artwork
  // mounted while the track changes under them). React does not remount them on
  // a `src` swap, so a plain `hasLoaded` boolean would carry over from the
  // previous cover — the new image would render at opacity-100 before a single
  // byte arrived (a hard pop), and if the browser then served a CACHED image
  // without firing `load`, the reset would never happen at all. Storing the
  // source the flag belongs to makes "already loaded" a fact about THIS url:
  // a swap is un-loaded by construction (derived during render, no
  // set-state-in-effect), and a cached image's onLoad merely re-confirms it.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);
  // `failed` is per-instance: once a URL errors we swap to the gradient tile.
  // It is tracked per source too — a broken cover must not poison the NEXT
  // track shown in the same slot (which would leave it on the gradient tile
  // even though its own URL is fine).
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  // Reactive settings: toggling artworkSize re-renders this component.
  const [{ artworkSize }] = useAppSettings();

  // Memoize the rewrite so it only reapplies when the URL or the setting
  // changes, not on every render (e.g. on every lazy-load / error tick).
  const src = useMemo(
    () => (track.artwork ? smarterArtworkUrl(track.artwork, artworkSize) : ""),
    [track.artwork, artworkSize],
  );

  const failed = failedSrc !== null && failedSrc === src;
  const hasLoaded = loadedSrc !== null && loadedSrc === src;

  if (failed || !track.artwork) {
    return (
      <div
        aria-hidden
        className={`${size} grid shrink-0 place-items-center rounded-lg bg-gradient-to-br from-accent to-accent-2 text-sm font-bold text-white`}
      >
        {initialsOf(track.title, track.artist)}
      </div>
    );
  }

  return (
    // Fixed box so layout never shifts while the image streams in. The fixed
    // box matters MORE when eager: the fetch starts at mount, but the box still
    // reserves the slot so the arriving art cannot reflow the row around it.
    <span className={`${size} relative shrink-0 overflow-hidden rounded-lg bg-surface-2`}>
      {/* eslint-disable-next-line @next/next/no-img-element -- plain img keeps bundle small for a thumbs-only widget. */}
      <img
        src={src}
        alt={`${track.title} album art`}
        loading={eager ? "eager" : "lazy"}
        width={48}
        height={48}
        className={`h-full w-full object-cover transition-opacity duration-[var(--dur-standard)] ease-out ${
          hasLoaded ? "opacity-100" : "opacity-0"
        }`}
        onLoad={() => setLoadedSrc(src)}
        onError={() => setFailedSrc(src)}
      />
    </span>
  );
}
