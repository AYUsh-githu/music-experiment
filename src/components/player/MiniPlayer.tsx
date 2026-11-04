"use client";

/**
 * Bottom mini-player bar.
 *
 * WHY it renders only here (after children inside the provider): it always has
 * live access to the shared player context via usePlayer, and it mounts at the
 * bottom of the viewport regardless of the current route.
 *
 * Layout: fixed to the bottom, offset left 14rem on md+ to clear the desktop
 * sidebar (Shell's left rail is w-56). On mobile it sits above the bottom tab
 * bar, which Shell reserves space for via its pb-28 on <main>.
 *
 * Wave 1 additions:
 *  - Repeat/Shuffle live in an overflow "more" menu (per the audit placement).
 *  - Volume (mute + slider) lives on the desktop rail (md+) — a compact slider
 *    styled like the ProgressBar so the two controls feel like one system.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import { usePlayer } from "@/lib/client/PlayerContext";
import Artwork from "@/components/track/Artwork";
import Marquee from "@/components/ui/Marquee";
import ProgressBar from "./ProgressBar";
import VolumeSlider from "./VolumeSlider";
import { DUR, EASE, SPRING } from "@/lib/client/motion";
import { cn } from "@/components/track/cn";
import {
  SkipBack,
  SkipForward,
  Play,
  Pause,
  Expand,
  Queue,
  MoreHorizontal,
  Shuffle,
  Repeat,
  RepeatOne,
  VolumeHigh,
  VolumeLow,
  VolumeMute,
} from "@/components/ui/icons";

interface MiniPlayerProps {
  /** Called by the queue button to lift the queue drawer open. */
  onOpenQueue: () => void;
  /** Whether the queue drawer is currently open — drives the button's aria-expanded. */
  drawerOpen: boolean;
}

/* ------------------------------ glyphs ------------------------------ */

/* All transport glyphs now come from the shared icon set (icons.tsx — the
   single source per frontend.md §1.1). Each wrapper just pins the size the
   mini bar expects; stroke geometry differs slightly from the old hand-written
   fill icons (visual change is accepted — that's the point of the swap). */
function RepeatIcon() {
  return <Repeat className="h-5 w-5" />;
}
function RepeatOneIcon() {
  return <RepeatOne className="h-5 w-5" />;
}
function ShuffleIcon() {
  return <Shuffle className="h-5 w-5" />;
}
function VolumeIcon({ muted, volume }: { muted: boolean; volume: number }) {
  if (muted || volume === 0) return <VolumeMute className="h-5 w-5" />;
  // Below the slider's audible low threshold the single-arc icon reads better.
  return volume < 0.5 ? <VolumeLow className="h-5 w-5" /> : <VolumeHigh className="h-5 w-5" />;
}

/** Label describing the current repeat mode, for aria + tooltips. */
function repeatLabel(mode: string): string {
  if (mode === "one") return "Repeat one";
  if (mode === "all") return "Repeat all";
  return "Repeat off";
}

export default function MiniPlayer({ onOpenQueue, drawerOpen }: MiniPlayerProps) {
  const {
    queue,
    currentTrack,
    playing,
    progress,
    duration,
    error,
    isPreview,
    repeat,
    shuffle,
    volume,
    muted,
    togglePlay,
    seek,
    prev,
    next,
    nowPlayingOpen,
    openPlayer,
    toggleRepeat,
    toggleShuffle,
    setVolume,
    toggleMute,
  } = usePlayer();

  // Overflow "more" menu open state (repeat + shuffle live here).
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement | null>(null);
  // The ⋯ trigger — the element focus returns to when the menu closes.
  const moreTriggerRef = useRef<HTMLButtonElement | null>(null);

  // Close the overflow menu on outside click / Esc while open.
  useEffect(() => {
    if (!moreOpen) return;
    const onDown = (e: PointerEvent) => {
      if (moreRef.current && moreRef.current.contains(e.target as Node)) return;
      setMoreOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      // Esc dismisses ONLY the menu: stop it here so it cannot also bubble to
      // the FullPlayer / queue focus trap and close the surface underneath.
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      setMoreOpen(false);
      // Return focus to the trigger: the menu's own controls just unmounted, so
      // focus would otherwise fall to <body> and the next Tab would restart the
      // page. Also keeps this menu parity with the shared track menu.
      moreTriggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    // Capture phase, so this runs before every window-level (bubble-phase)
    // Esc handler — the focus traps — and can stop the event reaching them.
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [moreOpen]);

  // Nothing loaded yet → render nothing.
  if (!currentTrack) return null;

  const isMuted = muted || volume === 0;

  return (
    <MotionConfig reducedMotion="user">
    {/* Mobile: 52px (Shell's tab bar) + the iOS home-indicator safe-area inset
        (frontend.md §1.4), so the player never sits in the gesture zone.
        Desktop has no tab bar, so bottom-0. */}
    <div className="fixed inset-x-0 bottom-[calc(52px+env(safe-area-inset-bottom))] z-30 border-t border-border bg-surface/95 backdrop-blur md:bottom-0 md:left-56">
      {/* THREE bands, not one row sized by its tallest child. The bar used to be
          a single flex row carrying the FULL ProgressBar (44px hit area + time
          labels), which stretched the strip to ~62px and left the 44px artwork
          floating in dead space. Now:
            - band 1: art + title/artist, vertically centred;
            - band 2: the transport row (and the volume rail beside the title);
            - band 3: ONE slim seek line across the bar's full width, which is a
              better drag target than a 320px-locked rail and keeps the shared
              <audio> exposing only one labelled seek slider.
          Every interactive target stays >=44px tall. */}
      <div className="mx-auto flex max-w-5xl items-center gap-3 px-3 pt-1 md:pl-6">
        {/* Artwork — shares `layoutId` with FullPlayer's hero art (Wave 2), so
            opening now-playing MORPHS this small tile up to hero size with a
            spring, and closing morphs it back down. The shared Artwork component
            gives the gradient-with-initials placeholder on missing/broken art. */}
        <motion.div layoutId="sonic-np-art" transition={SPRING.soft} className="relative shrink-0">
          <Artwork track={currentTrack} size="h-11 w-11 rounded-md" eager />
        </motion.div>

        {/* Title + artist */}
        <div className="min-w-0 flex-1">
          <div className="flex max-w-full items-center gap-1.5">
            {/* Long titles scroll in a marquee (Wave 2) when they overflow the
                mini bar; short titles render static. The marquee measures its
                own container overflow, so no external width plumbing needed.
                The marquee keeps the full title in an sr-only copy plus a
                `title` tooltip, so a truncated title is never unreachable. */}
            <Marquee
              text={currentTrack.title}
              className="min-w-0 flex-1 text-sm font-medium text-text"
            />
            <span className="sr-only" title={currentTrack.title}>
              {currentTrack.title}
            </span>
            {isPreview && (
              <span className="shrink-0 rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-semibold lowercase leading-none text-muted">
                Preview&nbsp;(30s)
              </span>
            )}
          </div>
          <p className="truncate text-xs text-muted" title={currentTrack.artist}>
            {currentTrack.artist}
          </p>
        </div>

        {/* Volume rail: the mute toggle is visible at ALL sizes (spec F10); the
            slider stays md+ only (mobile uses hardware volume). It lives outside
            the transport row so the two bands size independently. */}
        <div className="flex shrink-0 items-center gap-1 md:w-28">
          <button
            type="button"
            onClick={toggleMute}
            aria-label={isMuted ? "Unmute" : "Mute"}
            aria-pressed={isMuted}
            className={cn(
              "grid h-11 w-11 shrink-0 place-items-center rounded-full",
              "transition-[color,transform] active:scale-[0.96] hover:bg-surface-2",
              isMuted ? "text-accent" : "text-muted hover:text-text"
            )}
          >
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={isMuted ? "muted" : "unmuted"}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: DUR.instant, ease: EASE.out }}
                className="grid place-items-center"
              >
                <VolumeIcon muted={isMuted} volume={volume} />
              </motion.span>
            </AnimatePresence>
          </button>
          <VolumeSlider
            volume={isMuted ? 0 : volume}
            onChange={setVolume}
            className="hidden md:flex"
          />
        </div>
      </div>

      {/* Transport band — every target is >=44px (h-11) for touch; the row is
          shrink-0 and lets the overflow menu absorb narrow widths rather than
          scrolling horizontally. */}
      <div className="mx-auto flex max-w-5xl items-center gap-0.5 px-3 md:justify-center md:pl-6">
          <button
            type="button"
            onClick={prev}
            aria-label="Previous track"
            className="grid h-11 w-11 place-items-center rounded-full text-muted transition-[color,transform] active:scale-[0.96] hover:bg-surface-2 hover:text-text"
          >
            <SkipBack className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={togglePlay}
            // See PLAY_PAUSE_ATTR in useGlobalKeyboardShortcuts: this is the
            // player's play/pause control, so the global Space shortcut yields
            // to it (and only to it) to avoid a double-toggle.
            data-sonic-playpause=""
            aria-label={playing ? "Pause" : "Play"}
            className="grid h-12 w-12 place-items-center rounded-full bg-accent text-white transition-transform active:scale-[0.96] hover:scale-105"
          >
            {/* Play/pause morph (§3.1): the two glyphs cross-fade with a small
                scale pop instead of hard-cutting. mode="wait" keeps the box the
                same size so nothing shifts; 120ms each side stays inside the
                instant token, and framer's root MotionConfig collapses it to an
                instant swap for reduced-motion users. */}
            <AnimatePresence mode="wait" initial={false}>
              <motion.span
                key={playing ? "pause" : "play"}
                initial={{ opacity: 0, scale: 0.75 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.75 }}
                transition={{ duration: DUR.instant, ease: EASE.out }}
                className="grid place-items-center"
              >
                {playing ? <Pause className="h-6 w-6" /> : <Play className="h-6 w-6" />}
              </motion.span>
            </AnimatePresence>
          </button>
          <button
            type="button"
            onClick={next}
            aria-label="Next track"
            className="grid h-11 w-11 place-items-center rounded-full text-muted transition-[color,transform] active:scale-[0.96] hover:bg-surface-2 hover:text-text"
          >
            <SkipForward className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={openPlayer}
            aria-label="Open now playing"
            aria-expanded={nowPlayingOpen}
            className="grid h-11 w-11 place-items-center rounded-full text-muted transition-[color,transform] active:scale-[0.96] hover:bg-surface-2 hover:text-text"
          >
            <Expand className="h-5 w-5" />
          </button>
          <button
            type="button"
            onClick={onOpenQueue}
            aria-label="Open queue"
            aria-expanded={drawerOpen}
            className="relative grid h-11 w-11 place-items-center rounded-full text-muted transition-[color,transform] active:scale-[0.96] hover:bg-surface-2 hover:text-text"
          >
            <Queue className="h-5 w-5" />
            {queue.length > 1 && (
              <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[10px] font-semibold leading-none text-white">
                {queue.length}
              </span>
            )}
          </button>

          {/* Desktop shuffle + repeat — exposed directly in the transport row on
              wide (lg+) layouts where space allows; a 120ms cross-fade morphs the
              repeat glyph and an active dot marks each toggle (F1). On narrower
              layouts these stay reachable through the overflow menu below. */}
          <div className="hidden items-center gap-0.5 lg:flex">
            <button
              type="button"
              onClick={toggleShuffle}
              aria-pressed={shuffle}
              aria-label={shuffle ? "Shuffle on" : "Shuffle off"}
              title={shuffle ? "Shuffle on" : "Shuffle off"}
              className={`relative grid h-11 w-11 place-items-center rounded-full transition-[color,transform] active:scale-[0.96] hover:bg-surface-2 ${
                shuffle ? "text-accent" : "text-muted hover:text-text"
              }`}
            >
              <ShuffleIcon />
              <AnimatePresence initial={false}>
                {shuffle && (
                  <motion.span
                    key="mini-shuffle-dot"
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                    transition={{ duration: DUR.instant, ease: EASE.out }}
                    className="absolute bottom-1 h-1 w-1 rounded-full bg-accent"
                    aria-hidden
                  />
                )}
              </AnimatePresence>
            </button>
            <button
              type="button"
              onClick={toggleRepeat}
              aria-pressed={repeat !== "off"}
              aria-label={repeatLabel(repeat)}
              title={repeatLabel(repeat)}
              className={`relative grid h-11 w-11 place-items-center rounded-full transition-[color,transform] active:scale-[0.96] hover:bg-surface-2 ${
                repeat !== "off" ? "text-accent" : "text-muted hover:text-text"
              }`}
            >
              <AnimatePresence mode="wait" initial={false}>
                <motion.span
                  key={repeat === "one" ? "one" : "all"}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: DUR.instant, ease: EASE.out }}
                  className="grid place-items-center"
                >
                  {repeat === "one" ? <RepeatOneIcon /> : <RepeatIcon />}
                </motion.span>
              </AnimatePresence>
              {repeat === "all" && (
                <span className="absolute bottom-1 h-1 w-1 rounded-full bg-accent" aria-hidden />
              )}
              {repeat === "one" && (
                <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[9px] font-bold leading-none text-white">
                  1
                </span>
              )}
            </button>
          </div>

          {/* Overflow "more" menu — repeat + shuffle for the widths where the
              direct controls above are hidden. role=menuitemcheckbox semantics
              are preserved. */}
          <div ref={moreRef} className="relative ml-auto lg:hidden">
            <button
              ref={moreTriggerRef}
              type="button"
              onClick={() => setMoreOpen((o) => !o)}
              aria-label="More playback options"
              aria-haspopup="menu"
              aria-expanded={moreOpen}
              className="grid h-11 w-11 place-items-center rounded-full text-muted transition-[color,transform] active:scale-[0.96] hover:bg-surface-2 hover:text-text"
            >
              <MoreHorizontal className="h-5 w-5" />
            </button>

            {moreOpen && (
              <div
                role="menu"
                aria-label="Playback options"
                className="absolute bottom-full right-0 z-40 mb-2 w-52 rounded-xl border border-border bg-surface py-1.5 shadow-2xl shadow-black/50"
              >
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={repeat !== "off"}
                  // The name carries the CURRENT mode ("Repeat all", "Repeat
                  // one", "Repeat off"), so a screen reader can tell repeat-one
                  // from repeat-all — previously only the visual "one" suffix did.
                  aria-label={repeatLabel(repeat)}
                  title={repeatLabel(repeat)}
                  onClick={toggleRepeat}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2",
                    repeat !== "off" ? "text-accent" : "text-text"
                  )}
                >
                  <span className="relative">
                    {repeat === "one" ? <RepeatOneIcon /> : <RepeatIcon />}
                    {repeat === "one" && (
                      <span
                        aria-hidden
                        className="absolute -right-1.5 -top-1.5 grid h-3.5 min-w-3.5 place-items-center rounded-full bg-accent px-0.5 text-[8px] font-bold leading-none text-white"
                      >
                        1
                      </span>
                    )}
                  </span>
                  Repeat
                  {repeat === "one" && (
                    <span className="ml-auto text-[10px] text-muted" aria-hidden>
                      one
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={shuffle}
                  aria-label={shuffle ? "Shuffle on" : "Shuffle off"}
                  title={shuffle ? "Shuffle on" : "Shuffle off"}
                  onClick={toggleShuffle}
                  className={cn(
                    "flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm transition-colors hover:bg-surface-2",
                    shuffle ? "text-accent" : "text-text"
                  )}
                >
                  <ShuffleIcon /> Shuffle
                  {shuffle && (
                    <span className="ml-auto text-accent-2" aria-hidden>
                      ●
                    </span>
                  )}
                </button>
              </div>
            )}
          </div>
      </div>

      {/* Slim seek line: full-width, so dragging anywhere along the bar seeks.
          The COMPACT variant keeps the 44px hit area but drops the time labels
          and the floating bubble (they would overlap the controls above); the
          FullPlayer keeps the labelled slider, so the shared <audio> only ever
          exposes ONE labelled slider plus this secondary affordance. */}
      <div className="mx-auto max-w-5xl px-3 pb-1 md:pl-6">
        <ProgressBar progress={progress} duration={duration} onSeek={seek} variant="compact" />
      </div>

      {/* Transient error banner (e.g. stream unavailable, retrying another source). */}
      {error && (
        <div
          role="status"
          className="border-t border-border bg-surface-2 px-4 py-1.5 text-center text-xs text-accent-2"
        >
          {error}
        </div>
      )}
    </div>
    </MotionConfig>
  );
}
