"use client";

/**
 * LyricsPanel — WS4 (finding F11) implementation of the WS0 frozen contract.
 *
 * WHY this component owns follow-mode rather than the parent: the old model in
 * FullPlayer used a 4s "pause window" — a manual scroll *temporarily* froze
 * auto-follow and then snap-backs resumed silently, so the pane kept fighting
 * the reader. §7/F11 specify the opposite: ANY user gesture turns follow OFF
 * until the reader explicitly asks for it again via the "Resume sync" pill.
 * That state lives HERE so the behaviour is identical wherever the panel mounts.
 *
 * The panel is SELF-CONTAINED for rendering + interaction: it receives the
 * sorted lines, plain lyrics and playback clock as props and never fetches.
 * The parent (FullPlayer) owns the /api/lyrics request; this component only
 * renders and interacts, which keeps the frozen props interface honest.
 *
 * Motion (§4): only `transform` + `opacity` animate — the active line scales
 * (never font-size/padding, which would reflow the whole list every line) and
 * the pill slides/fades. Timings come from the shared motion tokens; nothing
 * hardcodes 0.12/0.2/0.32. Reduced motion collapses both (framer honours the
 * root MotionConfig, and the transform emphasis is derived from a matchMedia
 * check so it becomes a static colour-only highlight).
 */

import {
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { motion } from "framer-motion";
import { usePageVisible } from "@/hooks/usePageVisible";
import { DUR, EASE } from "@/lib/client/motion";
import type { LyricLine } from "@/lib/client/lyricsParser";
import { cn } from "@/components/track/cn";

/**
 * Props are frozen in WS0 (§8) — the Player agent mounts this exact shape.
 * Do not add/remove/rename fields without a cross-workstream agreement.
 */
export interface LyricsPanelProps {
  /** Track id (lyrics are keyed by it for loading/caching). */
  trackId: string;
  /** Sorted synced lines from lyricsParser.parseLRC (F15 guarantees order). */
  lines: LyricLine[];
  /** Plain non-synced lyrics, or null when the track has none. */
  plainLyrics: string | null;
  /** Current playback time in seconds (~4 Hz; must be leaf-subscribed). */
  currentTime: number;
  /** Whether audio is currently playing. */
  isPlaying: boolean;
  /** Seek the player to a time in seconds (additive PlayerContext `seek`). */
  onSeek: (t: number) => void;
}

/** `true` when the user has asked the OS to reduce motion. Guarded for SSR. */
function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true;
}

/**
 * Subscribe to the OS reduced-motion preference via `useSyncExternalStore`.
 *
 * WHY not a `useEffect` + `setState`: that pattern triggers the repo's
 * `react-hooks/set-state-in-effect` lint (cascading render on mount) and briefly
 * renders the animated branch before flipping. `useSyncExternalStore` reads the
 * live media query on the client and returns a STABLE `false` server snapshot,
 * so hydration matches and there is no setState in an effect body.
 */
function subscribeReducedMotion(onChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  const mq = window.matchMedia?.("(prefers-reduced-motion: reduce)");
  if (!mq) return () => {};
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeReducedMotion,
    prefersReducedMotion,
    () => false, // server snapshot: never reduced during SSR
  );
}

/**
 * Index of the active line for `timeSec` — the last line at or before the
 * clock, or -1 before the first line. Lines arrive sorted (F15), so we can
 * break on the first future line instead of scanning the whole array.
 *
 * WHY a plain function (not `use*`): it is called unconditionally during render
 * and holds no state; a `use` prefix would invite a conditional-hook mistake.
 */
function activeIndexFor(lines: LyricLine[], timeSec: number): number {
  if (lines.length === 0) return -1;
  const t = timeSec * 1000;
  let idx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].timeMs <= t) idx = i;
    else break;
  }
  return idx;
}

/**
 * Loading placeholder for the lyrics pane (WS5 skeleton variant).
 *
 * WHY local rather than in src/components/ui/Skeleton.tsx: that file is owned
 * by the Surfaces agent (S), and §10's ownership is exclusive. A small local
 * block reusing the shared `sonic-shimmer` utility gets the identical visual
 * language without a cross-agent write. Reported to the orchestrator.
 */
function LyricsSkeleton() {
  // Varied widths read as "lines of text" rather than a uniform block.
  const widths = ["72%", "92%", "58%", "84%", "66%", "78%"];
  return (
    <div className="flex flex-col gap-3" aria-hidden>
      {widths.map((w, i) => (
        <div
          key={i}
          className="relative h-4 overflow-hidden rounded bg-surface-2"
          style={{ width: w }}
        >
          <span className="sonic-shimmer pointer-events-none absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent" />
        </div>
      ))}
    </div>
  );
}

export default function LyricsPanel({
  trackId,
  lines,
  plainLyrics,
  currentTime,
  isPlaying,
  onSeek,
}: LyricsPanelProps) {
  /** Read-only tab-visibility gate — auto-scroll must not run on a hidden tab. */
  const pageVisible = usePageVisible();

  /** OS reduced-motion preference (subscription, not an effect+setState). */
  const reduceMotion = useReducedMotion();

  /**
   * Follow mode. Starts ON for a fresh track (the reader expects the current
   * line centred) and is turned OFF permanently by the first user gesture until
   * the pill is pressed.
   *
   * The track reset is done WITHOUT an effect: we remember which track the
   * current `follow` belongs to and, when `trackId` changes, adopt the default
   * (true) again during render. Setting state during render for a prop change is
   * React's documented "adjust state when a prop changes" pattern and avoids
   * both the extra render pass and the repo's set-state-in-effect lint.
   */
  const [followState, setFollowState] = useState<{ trackId: string; follow: boolean }>({
    trackId,
    follow: true,
  });
  const follow = followState.trackId === trackId ? followState.follow : true;
  const setFollow = useCallback(
    (next: boolean) => setFollowState({ trackId, follow: next }),
    [trackId],
  );

  /** The active line element, for scrollIntoView. */
  const activeLineRef = useRef<HTMLButtonElement | null>(null);

  /**
   * True once the reader has broken follow by hand — gates the "Resume sync"
   * pill. Derived from the same track-scoped state so a new track can never
   * inherit the previous track's "I scrolled away" intent.
   */
  const [pillState, setPillState] = useState<{ trackId: string; visible: boolean }>({
    trackId,
    visible: false,
  });
  const pillVisible = pillState.trackId === trackId ? pillState.visible : false;
  const setPillVisible = useCallback(
    (next: boolean) => setPillState({ trackId, visible: next }),
    [trackId],
  );

  const activeIndex = activeIndexFor(lines, currentTime);
  const hasSynced = lines.length > 0;
  const showPlain = !hasSynced && !!plainLyrics && plainLyrics.trim().length > 0;
  const isEmpty = !hasSynced && !showPlain;

  /** Any user gesture on the pane stops following and offers the pill back. */
  const stopFollowing = useCallback(() => {
    setFollow(false);
    setPillVisible(true);
  }, [setFollow, setPillVisible]);

  /**
   * Centre the active line. `useLayoutEffect` so the scroll happens in the same
   * frame the line changed, avoiding a visible one-frame lag behind the audio.
   *
   * Gated by `pageVisible`: scrolling a backgrounded tab is wasted work and can
   * fight the browser's own restore-on-return behaviour.
   */
  const centerActiveLine = useCallback(
    (behavior: ScrollBehavior) => {
      activeLineRef.current?.scrollIntoView({ block: "center", behavior });
    },
    []
  );

  // Auto-scroll only while following, on a real line change, on a visible tab.
  useLayoutEffect(() => {
    if (!follow || !pageVisible || activeIndex < 0) return;
    centerActiveLine(reduceMotion ? "auto" : "smooth");
  }, [follow, pageVisible, activeIndex, reduceMotion, centerActiveLine]);

  /** Pill click: resume following and re-centre immediately (instant, not smooth,
   *  so the jump is unmistakably the user's own action). */
  const resumeFollow = useCallback(() => {
    setFollow(true);
    setPillVisible(false);
    centerActiveLine(reduceMotion ? "auto" : "smooth");
  }, [setFollow, setPillVisible, centerActiveLine, reduceMotion]);

  /** Seek to a line. Keyboard (Enter/Space) is wired on the real <button>, so
   *  this is the single activation path for pointer + keyboard + AT. */
  const seekTo = useCallback(
    (timeMs: number) => {
      onSeek(timeMs / 1000);
    },
    [onSeek]
  );

  /** Pointer-down / wheel / touch on the pane means the reader is driving. */
  const gestureProps = {
    onPointerDown: stopFollowing,
    onWheel: stopFollowing,
    onTouchMove: stopFollowing,
  };

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <h3 className="mb-3 shrink-0 text-sm font-semibold uppercase tracking-wide text-muted">
        Lyrics
      </h3>

      {/* Scroll viewport. `overscroll-contain` stops the pane's scroll from
          chaining to the page (or the player's swipe-to-close) at the ends. */}
      <div
        {...gestureProps}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain pr-1"
      >
        {isEmpty && (
          <div className="flex flex-col items-center gap-2 rounded-xl bg-surface-2 px-6 py-12 text-center">
            <span className="text-3xl" aria-hidden>
              ♪
            </span>
            <p className="text-base font-semibold text-text">No lyrics found</p>
            <p className="max-w-xs text-sm text-muted">
              We couldn&apos;t find lyrics for this track.
            </p>
          </div>
        )}

        {showPlain && (
          /* Plain (unsynced) lyrics: a readable centred measure and NO fake
             sync — no active line, no auto-scroll, nothing to click. */
          <div className="mx-auto max-w-prose px-1">
            <div className="space-y-3 text-center text-base leading-relaxed text-text/90">
              {plainLyrics
                .split(/\r?\n/)
                .filter((line) => line.trim().length > 0)
                .map((line, i) => (
                  <p key={i}>{line}</p>
                ))}
            </div>
          </div>
        )}

        {hasSynced && (
          <ol className="space-y-1 pb-24">
            {lines.map((line, i) => {
              const isActive = i === activeIndex;
              // Emphasis only while playing: a paused track keeps the accent
              // colour on the current line but drops the scale, so a frozen
              // player reads as "here is where you are", not "still moving".
              const emphasized = isActive && isPlaying && !reduceMotion;
              return (
                <li key={`${line.timeMs}-${i}`}>
                  <button
                    type="button"
                    ref={isActive ? activeLineRef : undefined}
                    onClick={() => seekTo(line.timeMs)}
                    aria-current={isActive ? "true" : undefined}
                    className={cn(
                      // 44px min height per §4 touch-target rule; text left so
                      // the reading column stays stable as lines activate.
                      "block min-h-11 w-full origin-left cursor-pointer rounded-lg px-2 py-1.5 text-left transition-[transform,color]",
                      isActive ? "bg-accent/15 text-accent" : "text-muted hover:text-text",
                    )}
                    // Transform-only emphasis. Reduced motion (and a paused
                    // player) keep the colour change but drop the scale entirely.
                    style={
                      emphasized
                        ? {
                            transform: "scale(1.02)",
                            transitionDuration: `${DUR.quick * 1000}ms`,
                            transitionTimingFunction: `cubic-bezier(${EASE.out.join(",")})`,
                          }
                        : undefined
                    }
                  >
                    <span className={cn("block text-base leading-relaxed", isActive && "font-semibold")}>
                      {line.text || " "}
                    </span>
                  </button>
                </li>
              );
            })}
          </ol>
        )}
      </div>

      {/* "Resume sync" pill — bottom-centre of the scroll area, above the list.
          Slides up + fades in over DUR.instant; only rendered once the reader
          has actually broken follow. */}
      {hasSynced && !follow && pillVisible && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DUR.instant, ease: EASE.out }}
          className="pointer-events-none absolute inset-x-0 bottom-2 flex justify-center"
        >
          <button
            type="button"
            onClick={resumeFollow}
            className="pointer-events-auto flex h-11 items-center gap-2 rounded-full border border-border bg-surface px-4 text-xs font-semibold text-text shadow-lg shadow-black/40 transition-colors hover:bg-surface-2"
          >
            <span aria-hidden>⤓</span>
            Resume sync
          </button>
        </motion.div>
      )}
    </div>
  );
}

/**
 * Named skeleton export so a parent can render the loading state without
 * importing the panel's default (keeps the frozen default export untouched).
 */
export { LyricsSkeleton };
