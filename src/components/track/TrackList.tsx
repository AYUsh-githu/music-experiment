"use client";

/**
 * Ordered list of search-result rows (Wave 2).
 *
 * WHY a separate component: the search page keeps track of its request state
 * while this list owns purely presentational mapping, so the page can swap
 * between skeletons, empty state and this list without redundant markup.
 *
 * Wave 2 motion: a gentle stagger on mount — each row fades in and rises 8px,
 * offset by 30ms per row. The stagger is capped at the first 12 rows so a long
 * result set never drags: rows beyond #12 appear instantly. Only `opacity` and
 * `transform` animate (no layout thrash), and reduced-motion users get none via
 * MotionConfig reducedMotion="user".
 */
import { motion, MotionConfig } from "framer-motion";
import type { Track } from "@/lib/types";
import TrackRow from "@/components/track/TrackRow";
import EmptyState from "@/components/ui/EmptyState";
import { revealTransition } from "@/lib/client/motion";

/**
 * The stagger comes straight from the shared revealTransition() token builder
 * (same builder as the home shelves, §4 cross-page consistency) — its own cap
 * at STAGGER.maxItems means rows past #8 get zero extra delay automatically
 * (aligned, not duplicated).
 */
interface TrackListProps {
  tracks: Track[];
  /** Fired per row with the row's track and its index in `tracks`. The index
      lets the consumer seed a playback queue starting at that position. */
  onPlay: (track: Track, index: number) => void;
}

export default function TrackList({ tracks, onPlay }: TrackListProps) {
  if (tracks.length === 0) {
    // EmptyState requires `title` (description is optional). Kept a single
    // labelled component so every empty search/collection reads the same.
    return <EmptyState title="No results" description="Try a different song or artist." />;
  }
  return (
    <MotionConfig reducedMotion="user">
      <ul className="flex flex-col gap-1" aria-label="Search results">
        {tracks.map((track, index) => (
          <motion.li
            key={track.id}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={revealTransition(index)}
          >
            <TrackRow track={track} index={index} onPlay={onPlay} />
          </motion.li>
        ))}
      </ul>
    </MotionConfig>
  );
}
