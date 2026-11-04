"use client";

/**
 * Milestone badges for the Library page.
 *
 * WHY badges at all: the Library is the one surface that is otherwise a set of
 * flat lists. A user who has been using SONIC for a while gets no acknowledgement
 * of that anywhere in the app, and there is no reason to make them visit a
 * separate profile page to see it — three small chips above the tabs carry it.
 *
 * WHY every badge is DERIVED from data the app already stores and never
 * persisted: a stored "achievements" list is a second source of truth that can
 * drift from the favourites/history/playlists it describes (cleared library,
 * a sync bug, a user clearing site data mid-way). Computing eligibility from
 * `getFavorites` / `getHistory` / `getPlaylists` on every render means a badge
 * can never claim something the library contradicts, and it needs no schema
 * change to the FROZEN db layer. The cost is three IndexedDB reads on a page
 * that already performs them for its own tabs.
 *
 * WHY thresholds rather than percentages: a "you're 63% to the next tier"
 * progress bar invites grinding for a music app, which is the wrong incentive.
 * Discrete milestones ("first song", "10 favourites") are quietly rewarding and
 * need no explanation.
 *
 * A11y: each badge is a static chip with an icon AND a text label — never an
 * icon alone, so the meaning survives a screen reader and a colourblind user
 * alike. Locked badges are present in the DOM (so the set is discoverable and
 * the grid does not jump as they unlock) but rendered at reduced contrast with
 * an explicit "locked" suffix for assistive tech.
 */

import { useEffect, useState } from "react";
import {
  getFavorites,
  getHistory,
  getPlaylists,
} from "@/lib/client/db";
import { LIBRARY_UPDATED_EVENT } from "@/lib/client/PlayerContext";
import { Trophy } from "@/components/ui/icons";
import { cn } from "@/components/track/cn";

/** Counts the badge rules read. Every field is a plain length. */
interface LibraryCounts {
  favorites: number;
  plays: number;
  playlists: number;
}

interface BadgeRule {
  id: string;
  /** Short label shown in the chip. */
  label: string;
  /** What the user did to earn it — also the chip's title/tooltip text. */
  description: string;
  earned: (c: LibraryCounts) => boolean;
}

/**
 * The rule table. Kept as data so adding a milestone is one entry and cannot
 * accidentally introduce a new render path or a new fetch.
 */
const BADGES: BadgeRule[] = [
  {
    id: "first-song",
    label: "First spin",
    description: "Play your first track",
    earned: (c) => c.plays >= 1,
  },
  {
    id: "ten-plays",
    label: "Regular",
    description: "Play 10 tracks",
    earned: (c) => c.plays >= 10,
  },
  {
    id: "first-favorite",
    label: "Heart it",
    description: "Save your first favorite",
    earned: (c) => c.favorites >= 1,
  },
  {
    id: "ten-favorites",
    label: "Curator",
    description: "Save 10 favorites",
    earned: (c) => c.favorites >= 10,
  },
  {
    id: "first-playlist",
    label: "Host",
    description: "Create a playlist",
    earned: (c) => c.playlists >= 1,
  },
];

const EMPTY_COUNTS: LibraryCounts = { favorites: 0, plays: 0, playlists: 0 };

export default function LibraryBadges() {
  const [counts, setCounts] = useState<LibraryCounts>(EMPTY_COUNTS);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      // All three reads are non-throwing by contract (the db layer resolves its
      // fallback), but the Promise.all is still guarded so one surprising
      // rejection cannot blank the whole chip row.
      try {
        const [favorites, history, playlists] = await Promise.all([
          getFavorites(),
          getHistory(),
          getPlaylists(),
        ]);
        if (cancelled) return;
        setCounts({
          favorites: favorites.length,
          plays: history.length,
          playlists: playlists.length,
        });
      } catch {
        if (!cancelled) setCounts(EMPTY_COUNTS);
      }
    };

    void load();
    // Re-derive on any library mutation (favorite, playlist create, a play
    // being recorded) and on the cross-tab storage signal, so a badge earned in
    // another tab appears here without a reload. Both are the same events the
    // library tabs already listen to — no new subscription surface.
    window.addEventListener(LIBRARY_UPDATED_EVENT, load);
    const onStorage = (e: StorageEvent) => {
      if (e.key !== null && !e.key.startsWith("sonic.")) return;
      void load();
    };
    window.addEventListener("storage", onStorage);
    return () => {
      cancelled = true;
      window.removeEventListener(LIBRARY_UPDATED_EVENT, load);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  const earnedCount = BADGES.filter((b) => b.earned(counts)).length;

  return (
    <section aria-labelledby="badges-heading" className="mb-6">
      {/* The heading carries the tally so the progress is understandable without
          seeing which individual chips are lit. */}
      <h2 id="badges-heading" className="text-xs font-semibold uppercase tracking-wide text-muted">
        Milestones · {earnedCount}/{BADGES.length}
      </h2>

      <ul className="mt-2 flex flex-wrap gap-2">
        {BADGES.map((badge) => {
          const earned = badge.earned(counts);
          return (
            <li key={badge.id}>
              <span
                title={earned ? badge.description : `Locked — ${badge.description}`}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs",
                  earned
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-border bg-surface text-muted opacity-50"
                )}
              >
                {/* Icon is decorative: the label beside it carries the meaning,
                    and the status is spoken by the text below. */}
                <Trophy className="h-3.5 w-3.5 shrink-0" aria-hidden />
                {badge.label}
                {/* Status is in the DOM, not only implied by colour. */}
                <span className="sr-only">{earned ? "— earned" : "— locked"}</span>
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
