"use client";

/**
 * Full-screen "Now Playing" view with a synced-lyrics pane (Phase 3, task 2).
 *
 * WHY a full overlay rather than an inline expanded player: the plan's Now
 * Playing view is a distraction-free, immersive surface for the current track
 * (large artwork, big transport controls, and a scrolling lyrics pane), which
 * would crowd the route beneath it. Rendering it as a fixed inset-0 overlay
 * (z-40, same layer as the queue drawer) lets any route open it without owning
 * layout, and mirrors the visual language of MiniPlayer + QueueDrawer.
 *
 * Visibility is driven entirely by the player context: we render nothing until
 * `nowPlayingOpen` is true AND a track is actually loaded, and close via the
 * context's `closePlayer()`. This keeps the caller as thin as possible — it
 * only ever flips that one flag.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { usePlayer } from "@/lib/client/PlayerContext";
import { useFocusTrap } from "@/lib/client/useFocusTrap";
import { isFavorite, toggleFavorite } from "@/lib/client/db";
import type { LyricLine } from "@/lib/client/lyricsParser";
import { AnimatePresence, motion, MotionConfig } from "framer-motion";
import AmbientNowPlaying from "@/components/ui/AmbientBackdrop";
import ProgressBar from "./ProgressBar";
import VolumeSlider from "./VolumeSlider";
import { useScrollLock } from "./useScrollLock";
import { DUR, EASE, SPRING, STAGGER } from "@/lib/client/motion";
import { useArtworkThemeColor } from "@/lib/client/ArtworkTheme";
import { useCanHover } from "@/hooks/useCanHover";
import { cn } from "@/components/track/cn";
import Artwork from "@/components/track/Artwork";
import Marquee from "@/components/ui/Marquee";
import TrackContextMenu from "@/components/track/TrackContextMenu";
import LyricsPanel, { LyricsSkeleton } from "@/components/lyrics/LyricsPanel";
import {
  SkipBack,
  SkipForward,
  Play,
  Pause,
  X,
  Shuffle,
  Repeat,
  RepeatOne,
  VolumeHigh,
  VolumeLow,
  VolumeMute,
  Heart,
} from "@/components/ui/icons";

/** Success envelope of GET /api/lyrics — mirrors the route's LyricsResponse. */
interface LyricsResponse {
  ok: boolean;
  plain?: string;
  synced?: LyricLine[];
  code?: string;
  message?: string;
}

/** Joined key for a lyric request, so we can dedupe by the exact request params. */
function lyricKey(title: string, artist: string, album: string | undefined, duration: number): string {
  return `${title}\u0001${artist}\u0001${album ?? ""}\u0001${duration}`;
}

/**
 * Downward pull (in px) that commits the swipe-to-close on mobile. Kept within
 * the 80–120px window the task asks for so a deliberate drag feels decisive
 * while a casual fling isn't enough to dismiss the Now Playing view.
 */
const DRAG_THRESHOLD = 96;

export default function FullPlayer() {
  const {
    currentTrack,
    progress,
    duration,
    playing,
    nowPlayingOpen,
    closePlayer,
    togglePlay,
    seek,
    prev,
    next,
    isPreview,
    repeat,
    shuffle,
    volume,
    muted,
    toggleRepeat,
    toggleShuffle,
    setVolume,
    toggleMute,
  } = usePlayer();

  /* --------------------- artwork expression (§3.2) --------------------- */

  // Artwork-derived tint for the shadow + breathing ring. Null whenever the
  // cover's color is unknown (no track, extraction failed, CDN refused CORS) —
  // every consumer below then falls back to the brand accent.
  const artworkColor = useArtworkThemeColor();
  // Hover-only affordances are gated on pointer CAPABILITY, so a touch device
  // never gets a tilt it cannot undo (there is no hover-out on touch).
  const canHover = useCanHover();
  // Pointer position over the artwork, normalized to -1..1 on each axis; drives
  // the 3D tilt. Reset to null on leave so the tile springs back flat.
  const [tilt, setTilt] = useState<{ x: number; y: number } | null>(null);

  /* ----------------------------- favorite ----------------------------- */

  const [favorite, setFavorite] = useState(false);
  const [favoritePending, setFavoritePending] = useState(false);

  // Seed the heart from IndexedDB whenever the loaded track changes.
  useEffect(() => {
    if (!currentTrack || !nowPlayingOpen) return;
    let cancelled = false;
    // Wrapped: isFavorite resolves to a safe false in SSR / blocked environments.
    isFavorite(currentTrack).then((val) => {
      if (!cancelled) setFavorite(val);
    });
    return () => {
      cancelled = true;
    };
  }, [currentTrack, nowPlayingOpen]);

  const onToggleFavorite = useCallback(async () => {
    if (!currentTrack || favoritePending) return;
    setFavoritePending(true);
    try {
      const nextVal = await toggleFavorite(currentTrack);
      setFavorite(nextVal);
    } catch {
      // toggleFavorite never throws (db.ts run() falls back), but keep the
      // guard so a future contract drift can't leave the heart permanently locked.
    } finally {
      setFavoritePending(false);
    }
  }, [currentTrack, favoritePending]);

  /* ------------------------------ lyrics ------------------------------ */

  const [lyrics, setLyrics] = useState<LyricsResponse | null>(null);
  const [lyricsLoading, setLyricsLoading] = useState(false);
  // Cache the last successful fetch keyed by request signature, so reselecting
  // the same track doesn't refetch. Stored in a ref (never triggers a render).
  const lyricsCache = useRef<Map<string, LyricsResponse>>(new Map());
  // Generational token so an in-flight fetch for an old track is ignored.
  const lyricsAbort = useRef<number>(0);

  // Fresh track, fresh overlay, fresh fetch (unless already cached).
  useEffect(() => {
    if (!currentTrack || !nowPlayingOpen) return;
    const key = lyricKey(currentTrack.title, currentTrack.artist, currentTrack.album, currentTrack.duration);

    const cached = lyricsCache.current.get(key);
    if (cached) {
      setLyrics(cached);
      setLyricsLoading(false);
      return;
    }

    // Bump the generation to invalidate any fetch for a previous track.
    const gen = ++lyricsAbort.current;
    setLyrics(null);
    setLyricsLoading(true);

    const params = new URLSearchParams({
      title: currentTrack.title,
      artist: currentTrack.artist,
    });
    if (currentTrack.album) params.set("album", currentTrack.album);
    if (Number.isFinite(currentTrack.duration)) {
      params.set("duration", String(Math.round(currentTrack.duration)));
    }

    (async () => {
      try {
        const res = await fetch(`/api/lyrics?${params.toString()}`);
        const data: LyricsResponse = await res.json();
        if (gen !== lyricsAbort.current) return; // superseded by a newer track
        const norm = data && data.ok ? data : { ok: false, code: data?.code, message: data?.message };
        lyricsCache.current.set(key, norm);
        setLyrics(norm);
      } catch {
        if (gen !== lyricsAbort.current) return;
      } finally {
        if (gen === lyricsAbort.current) setLyricsLoading(false);
      }
    })();

    return () => {
      setLyricsLoading(false);
    };
  }, [currentTrack, nowPlayingOpen]);

  /* ------------------------- synced lines (F15) ------------------------ */
  // The Panel owns active-line highlighting + follow mode; FullPlayer only
  // forwards the sorted synced lines it fetched.
  const synced = lyrics?.ok ? lyrics.synced : undefined;
  // The scrollable lyrics pane element (kept as the drag-suppression anchor for
  // the pull-to-close gesture, which must ignore drags that start in lyrics).
  const lyricsPaneRef = useRef<HTMLDivElement | null>(null);

  /* --------------------- pull-to-close gesture (mobile) ---------------- */
  // Mobile "swipe down to close": dragging the artwork/header/transport region
  // downward translates the content with the finger and commits closePlayer()
  // once the pull passes ~96px, snapping back otherwise. Desktop (fine pointer)
  // and the lyrics pane (which needs its own scroll) are excluded:
  //  - pointermove only fires for `touch` pointerType, so mice never trigger it.
  //  - a drag that starts inside the lyrics <section> is ignored so scrolling
  //    the lyrics never throws the overlay away.
  // WHY no dragY state: the pull offset is written straight to the content
  // element's inline style in the pointer handler. A gesture fires pointermove
  // many times per second; routing that through React state would re-render the
  // whole overlay each move, and syncing a state value to a ref/style inside an
  // effect is exactly what the react-hooks lint rules forbid. Direct DOM writes
  // are the idiomatic gesture approach here — and because closing the overlay
  // unmounts the content node (this component returns null), a reopened overlay
  // starts from a clean, untranslated element with no reset effect required.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null); // element being translated
  const dragOriginRef = useRef<number>(0); // pointerdown clientY
  const dragActiveRef = useRef(false); // true once past the initial slop
  const dragSuppressedRef = useRef(false); // set when the pointer went down in lyrics

  useEffect(() => {
    const el = dialogRef.current;
    const content = contentRef.current;
    if (!nowPlayingOpen || !el || !content) return;

    const onPointerDown = (e: PointerEvent) => {
      // Touch-only gesture; coarse is a good approximation but trust pointerType.
      if (e.pointerType !== "touch") return;
      // Never hijack a drag that begins inside the lyrics pane — let it scroll.
      const target = e.target as Element;
      if (target.closest("[data-lyric-pane]")) {
        dragSuppressedRef.current = true;
        return;
      }
      dragSuppressedRef.current = false;
      dragOriginRef.current = e.clientY;
      dragActiveRef.current = false;
      el.setPointerCapture(e.pointerId); // keep receiving moves off-element
    };

    const onPointerMove = (e: PointerEvent) => {
      if (e.pointerType !== "touch" || dragSuppressedRef.current) return;
      const delta = e.clientY - dragOriginRef.current;
      // Small slop so taps and tiny wiggles don't nudge the overlay.
      if (!dragActiveRef.current && delta > 6) dragActiveRef.current = true;
      if (!dragActiveRef.current) return;
      // Resist the pull as it grows so it doesn't fly away at the threshold.
      const eased = Math.max(0, Math.min(delta * 0.5, window.innerHeight * 0.45));
      // Direct DOM write (no re-render per move); snap mid-drag by killing the
      // transition so the sheet tracks the finger exactly.
      content.style.transition = "none";
      content.style.transform = delta > 0 ? `translateY(${eased}px)` : "translateY(0)";
    };

    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType !== "touch") return;
      const delta = e.clientY - dragOriginRef.current;
      try {
        el.releasePointerCapture(e.pointerId);
      } catch {
        // releasePointerCapture can throw if the pointer is gone; ignoring is fine.
      }
      if (dragActiveRef.current && delta >= DRAG_THRESHOLD) {
        // Past the threshold → dismiss. Unmounting the overlay discards the
        // inline transform, so nothing needs resetting here.
        closePlayer();
        return;
      }
      // Below the threshold (or a tap) → animate back to the resting position
      // using the standard duration token (DUR.standard = 0.32 s) + EASE.out.
      content.style.transition = `transform ${DUR.standard}s cubic-bezier(${EASE.out.join(",")})`;
      content.style.transform = "translateY(0)";
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    return () => {
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
    };
  }, [nowPlayingOpen, closePlayer]);

  /* ------------------------- focus trap / Esc ------------------------- */

  // Modal semantics in one place (useFocusTrap — do not edit it): while the
  // overlay is open it confines Tab/Shift+Tab to the dialog, puts initial focus
  // on the dialog shell (tabIndex=-1), binds Esc -> closePlayer, and on close
  // restores focus to the element that opened the overlay. This replaces the
  // former inline focus + Esc effect with identical observable behavior. Called
  // unconditionally (before the early return) so the hook's ordering stays valid.
  useFocusTrap(dialogRef, nowPlayingOpen, closePlayer);

  // Lock the Shell <main> scroller while the overlay is open (F12/WS3) so the
  // route beneath cannot scroll behind it. The overlay has its OWN
  // overflow-y-auto root, which stays scrollable.
  useScrollLock(nowPlayingOpen);

  /* ------------------------------ render ------------------------------ */
  if (!nowPlayingOpen || !currentTrack) return null;

  // Only the loading gate is computed here — the Panel renders its own empty
  // ("No lyrics found") and plain-lyrics states from the props we pass it.
  const showLoading = lyricsLoading && !lyrics;

  const isMuted = muted || volume === 0;

  // The entrance stagger was a hand-rolled array here — which silently shadowed
  // the shared STAGGER token from motion.ts inside this scope. It now derives
  // from that token (same 25 ms step, capped at maxItems) so the column can
  // never drift from the app-wide rhythm.
  const entranceDelays = [0, 1, 2, 3, 4, 5].map(
    (i) => Math.min(i, STAGGER.maxItems - 1) * STAGGER.step
  );

  return (
    <MotionConfig reducedMotion="user">
      {/* The pull-to-close gesture (defined earlier) is anchored to dialogRef and
          mutates contentRef's inline transform directly. contentRef therefore
          stays a PLAIN div — a motion.div would fight those imperative writes.
          The ambient backdrop is a separate, non-dragged layer. */}
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Now playing"
        tabIndex={-1}
        className="fixed inset-0 z-40 overflow-y-auto bg-bg relative"
      >
        {/* Ambient now-playing backdrop: blurred art (40px, scale 1.2, ~0.3
            opacity) + slow breathing gradient, crossfading on track change.
            Fixed behind the scrolling content. */}
        <AmbientNowPlaying
          artwork={currentTrack.artwork}
          trackKey={currentTrack.id}
        />

        {/* contentRef is translated directly by the pull-to-close gesture. The
            resting transform is 0 with a short ease-out so a released-but-under-
            threshold pull glides back instead of snapping. `pb-24 md:pb-8` keeps
            the last control clear of the fixed MiniPlayer + tab bar beneath the
            overlay, so the heart can always be scrolled fully into view. */}
        <div
          ref={contentRef}
          className="relative z-10 mx-auto flex min-h-full w-full max-w-6xl flex-col px-4 pb-24 pt-4 transition-transform duration-200 ease-out md:px-6 md:pb-28 md:pt-6"
        >
          {/* Drag handle: a rounded surface-2 pill only on touch/coarse pointers
              (md: plumb vanishes for mice) as an affordance to pull the sheet
              down. Acts as an extra drag surface too. */}
          <div
            className="mb-2 flex justify-center md:hidden"
            aria-hidden
          >
            <div className="h-1.5 w-12 rounded-full bg-surface-2" />
          </div>

          {/* Header — stagger in first (fade + 8px rise). */}
          <motion.header
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: DUR.quick, ease: EASE.out, delay: entranceDelays[0] }}
            className="flex items-center justify-between"
          >
            <h1 className="text-base font-semibold text-text">Now playing</h1>
            <div className="flex items-center gap-1">
              {/* "…" overflow menu — Add to playlist / Add to queue / Play next. */}
              <TrackContextMenu
                track={currentTrack}
                label={`More options for ${currentTrack.title}`}
              />
              <button
                type="button"
                onClick={closePlayer}
                aria-label="Close now playing"
                className="grid h-11 w-11 place-items-center rounded-full text-muted transition-[color,transform] active:scale-[0.96] hover:bg-surface-2 hover:text-text"
              >
                <X className="h-5 w-5" />
              </button>
            </div>
          </motion.header>

          {/* Two-column on md+ (artwork/controls | lyrics), stacked on mobile. */}
          <div className="mt-4 grid flex-1 gap-6 md:grid-cols-2 md:gap-8">
            {/* Left: artwork, metadata, transport, seek, heart. */}
            <section className="flex flex-col items-center justify-center text-center">
              {/* Artwork — shares `layoutId` with MiniPlayer's art (Wave 2), so
                  opening the full player MORPHS the mini bar's small art up to
                  this hero size with a spring; closing animates it back. The
                  layoutId crossfade is handled by framer-motion's layout
                  projection (GPU transform/opacity only — no layout thrash). */}
              <motion.div
                layoutId="sonic-np-art"
                transition={SPRING.soft}
                className="relative"
                onPointerMove={
                  canHover
                    ? (e) => {
                        // Normalize the pointer inside the artwork box into
                        // -1..1 on each axis. Reads layout, but only on a
                        // pointer MOVE (never during scroll or animation).
                        const r = e.currentTarget.getBoundingClientRect();
                        if (r.width === 0 || r.height === 0) return;
                        setTilt({
                          x: ((e.clientX - r.left) / r.width) * 2 - 1,
                          y: ((e.clientY - r.top) / r.height) * 2 - 1,
                        });
                      }
                    : undefined
                }
                onPointerLeave={canHover ? () => setTilt(null) : undefined}
                style={{ transformStyle: "preserve-3d" }}
              >
                {/* 3D tilt wrapper: rotateX/rotateY only (transform), capped at
                    ±6° so it reads as depth rather than a broken layout. Kept
                    NESTED INSIDE the layoutId element (not on it) so framer's
                    layout projection — which drives the mini→full morph — never
                    has to reconcile a competing rotation on the same node.
                    WHY the perspective lives here and NOT on the layoutId
                    element: a perspective on the projected node would land in
                    framer's "latest transform" channel and be rebuilt on every
                    projection frame, and any `transform` on the layoutId element
                    itself would fight the morph during the shared layout
                    animation. This static wrapper is untracked by framer, so the
                    morph operates on a plain, un-transformed node.
                    `w-fit` + the fixed-width <Artwork> keep the wrapper exactly
                    the art's size: it has NO padding, so the artwork's shadow
                    ring is never clipped (an overflow-hidden ancestor would). */}
                <div className="sonic-tilt-scene w-fit">
                  <motion.div
                    className="relative overflow-hidden rounded-xl transition-shadow duration-[var(--dur-standard)]"
                    animate={
                      tilt
                        ? {
                            rotateY: tilt.x * 6,
                            rotateX: -tilt.y * 6,
                            scale: 1.02,
                          }
                        : { rotateY: 0, rotateX: 0, scale: 1 }
                    }
                    // DUR.standard (320 ms) is the closest allowed token to the
                    // old 0.3 s tween — no new duration may be introduced.
                    transition={{ type: "tween", duration: DUR.standard, ease: EASE.out }}
                    style={{
                      // Artwork tint on the SHADOW only (never on text): one
                      // accent per viewport is preserved because artworkColor
                      // already falls back to the brand accent when unknown.
                      boxShadow: `0 10px 30px -6px ${artworkColor ?? "rgba(124, 92, 255, 0.35)"}`,
                      // Declare the 3D context so the rotateX/Y read as depth
                      // even before the first tilt.
                      transformStyle: "preserve-3d",
                    }}
                  >
                  <div
                    // Breathing artwork (§ Phase 5): a slow 1.5% inhale/exhale.
                    // WHY its own div and not a class on the motion.div above:
                    // that node's `transform` is owned by framer for the tilt
                    // (rotateX/rotateY/scale). CSS keyframes writing `transform`
                    // on the same element would be overwritten by framer's
                    // inline style every frame and the breathing would never
                    // show. A child wrapper gets its own transform origin and
                    // composes cleanly under the tilt. PAUSED when not playing
                    // so a paused track is visually still, and the animation is
                    // `animation-play-state`, not an unmount, so resuming does
                    // not restart the cycle from zero.
                    className="sonic-breathe rounded-xl"
                    style={{ animationPlayState: playing ? "running" : "paused" }}
                  >
                    <Artwork
                      track={currentTrack}
                      size="w-56 h-56 md:w-72 md:h-72 rounded-xl"
                      eager
                    />
                    {/* Breathing ring (§3.2): a 2px accent→artwork-color ring at
                        low opacity, only while playing. The keyframe is opacity-
                        only on a STATIC element; the global reduced-motion guard
                        in globals.css collapses it to a steady ring. aria-hidden —
                        it conveys nothing the transport controls don't already. */}
                    {playing && (
                      <span
                        aria-hidden
                        className="sonic-ring-pulse pointer-events-none absolute inset-0 rounded-xl"
                        style={{
                          border: `2px solid ${artworkColor ?? "var(--accent)"}`,
                        }}
                      />
                    )}
                  </div>
                  </motion.div>
                </div>
              </motion.div>
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: DUR.quick, ease: EASE.out, delay: entranceDelays[1] }}
                className="mt-5 w-full max-w-full"
              >
                {/* Title + artist slide-up swap on track change (§ WS3): a keyed
                    AnimatePresence remounts the block per track and animates
                    y+opacity out (120ms) then in (120ms). Reduced motion:
                    framer's root MotionConfig collapses these to an instant swap. */}
                <AnimatePresence mode="wait" initial={false}>
                  <motion.div
                    key={currentTrack.id}
                    initial={{ opacity: 0, y: 12 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -12 }}
                    transition={{ duration: DUR.instant, ease: EASE.out }}
                  >
                    <div className="flex items-center justify-center gap-2">
                      {/* Long titles scroll via the shared Marquee when they
                          overflow, mirroring the MiniPlayer treatment. */}
                      <Marquee
                        text={currentTrack.title}
                        className="mx-auto max-w-full text-xl font-semibold text-text md:text-2xl"
                      />
                      {isPreview && (
                        <span className="shrink-0 rounded bg-surface-2 px-2 py-0.5 text-[11px] leading-none text-muted">
                          Preview 30s
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate text-sm text-muted" title={currentTrack.artist}>
                      {currentTrack.artist}
                    </p>
                  </motion.div>
                </AnimatePresence>
              </motion.div>

              {/* Transport — shuffle + repeat sit to the LEFT of play (defect 1).
                  The play/pause button is ALWAYS mounted with a fixed box that
                  hosts an AnimatePresence glyph swap, so toggling never remounts
                  the control (which used to drop keyboard focus) and never
                  changes the button's size. */}
              <motion.div
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: DUR.quick, ease: EASE.out, delay: entranceDelays[2] }}
                className="mt-5 flex items-center gap-1.5"
              >
                <button
                  type="button"
                  onClick={toggleShuffle}
                  aria-pressed={shuffle}
                  aria-label={shuffle ? "Shuffle on" : "Shuffle off"}
                  title={shuffle ? "Shuffle on" : "Shuffle off"}
                  className={cn(
                    "relative grid h-11 w-11 place-items-center rounded-full transition-[color,transform] active:scale-[0.96] hover:bg-surface-2",
                    shuffle ? "text-accent" : "text-muted hover:text-text"
                  )}
                >
                  <ShuffleIcon />
                  {/* Active-state dot (transform/opacity only). */}
                  <AnimatePresence initial={false}>
                    {shuffle && (
                      <motion.span
                        key="shuffle-dot"
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
                  className={cn(
                    "relative grid h-11 w-11 place-items-center rounded-full transition-[color,transform] active:scale-[0.96] hover:bg-surface-2",
                    repeat !== "off" ? "text-accent" : "text-muted hover:text-text"
                  )}
                >
                  {/* 120ms cross-fade between Repeat and Repeat-one glyphs. */}
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
                  {/* Active-state dot for repeat-all. Repeat-one keeps its "1"
                      badge instead so "one" and "all" read differently. */}
                  {repeat === "all" && (
                    <span
                      className="absolute bottom-1 h-1 w-1 rounded-full bg-accent"
                      aria-hidden
                    />
                  )}
                  {repeat === "one" && (
                    <span
                      aria-hidden
                      className="absolute right-0.5 top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-accent px-1 text-[9px] font-bold leading-none text-white"
                    >
                      1
                    </span>
                  )}
                </button>
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
                  // Marks this as the player's play/pause control so the global
                  // Space shortcut stands down here only (see PLAY_PAUSE_ATTR).
                  data-sonic-playpause=""
                  aria-label={playing ? "Pause" : "Play"}
                  className="grid h-14 w-14 place-items-center overflow-hidden rounded-full bg-accent text-white shadow-lg shadow-accent/25 transition-transform active:scale-[0.96] hover:scale-105"
                >
                  {/* Same cross-fade the MiniPlayer uses: the glyphs swap INSIDE
                      a fixed 56px box, so the control never shifts the row. */}
                  <AnimatePresence mode="wait" initial={false}>
                    <motion.span
                      key={playing ? "pause" : "play"}
                      initial={{ opacity: 0, scale: 0.75 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.75 }}
                      transition={{ duration: DUR.instant, ease: EASE.out }}
                      className="grid place-items-center"
                    >
                      {playing ? <Pause className="h-7 w-7" /> : <Play className="h-7 w-7" />}
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
              </motion.div>

            {/* Seek bar */}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: DUR.quick, ease: EASE.out, delay: entranceDelays[3] }}
              className="mt-4 w-full max-w-sm"
            >
              <ProgressBar progress={progress} duration={duration} onSeek={seek} />
            </motion.div>

            {/* Volume (defect 10): mute toggle + slider. Mute stays visible at all
                sizes; the slider is hidden under `sm` (mobile uses hardware
                volume) per spec. */}
            <motion.div
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: DUR.quick, ease: EASE.out, delay: entranceDelays[4] }}
              className="mt-3 flex w-full max-w-sm items-center gap-2"
            >
              <button
                type="button"
                onClick={toggleMute}
                aria-label={isMuted ? "Unmute" : "Mute"}
                aria-pressed={isMuted}
                className={cn(
                  "grid h-11 w-11 shrink-0 place-items-center rounded-full transition-[color,transform] active:scale-[0.96] hover:bg-surface-2",
                  isMuted ? "text-accent" : "text-muted hover:text-text"
                )}
              >
                {/* 120ms cross-fade between the muted / unmuted glyphs. */}
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
                className="hidden sm:flex"
              />
              {/* Mobile has no rail in this row (hardware volume), so the slider's
                  absence left a bare icon. Show the percentage instead — it is the
                  only read-out of the current level on a phone. aria-hidden: the
                  mute button already announces Mute/Unmute + pressed state. */}
              <span
                aria-hidden
                className="w-9 shrink-0 text-right text-[11px] tabular-nums text-muted sm:hidden"
              >
                {isMuted ? "0%" : `${Math.round(volume * 100)}%`}
              </span>
            </motion.div>

            {/* Heart (favorite) — disabled while a toggle is in flight. The glyph
                POPS (scale 1 → 1.3 → 1 spring) whenever the favorite state flips,
                keyed by `favorite` so only the glyph re-mounts and re-pops. */}
            <motion.button
              type="button"
              onClick={onToggleFavorite}
              disabled={favoritePending}
              aria-label={favorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={favorite}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: DUR.quick, ease: EASE.out, delay: entranceDelays[5] }}
              className={cn(
                "mt-4 grid h-11 w-11 place-items-center rounded-full transition-colors disabled:opacity-50",
                favorite
                  ? "bg-danger/20 text-danger hover:bg-danger/30"
                  : "bg-surface-2 text-muted hover:bg-danger/10 hover:text-danger"
              )}
            >
              {/* Keyed by state so toggling remounts this span and replays the
                  pop (opacity/transform only). */}
              <motion.span
                key={favorite ? "on" : "off"}
                initial={{ scale: 1 }}
                animate={{ scale: [1, 1.3, 1] }}
                transition={SPRING.snappy}
                aria-hidden
              >
                <Heart filled={favorite} className="h-5 w-5" />
              </motion.span>
            </motion.button>
          </section>

          {/* Right: lyrics pane — the WS4 LyricsPanel (frozen contract, §8).
              FullPlayer owns the /api/lyrics fetch + preview affordance; the
              panel owns follow-mode, active-line emphasis, and line-seek. It is
              keyed by track id so a track change resets its internal state and
              it re-mounts cleanly. */}
          <motion.section
            ref={lyricsPaneRef}
            key={currentTrack.id}
            data-lyric-pane
            // NOT aria-live: the pane holds one focusable button PER LYRIC LINE
            // and changes ~4x/second, so a polite live region would queue the
            // whole song into the screen reader's announcement backlog. Line
            // seeking is still fully operable — each line is a real button.
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: DUR.quick, ease: EASE.out, delay: entranceDelays[4] }}
            className="relative flex min-h-0 flex-col rounded-2xl border border-border bg-surface/60 p-4 md:max-h-[calc(100vh-7rem)] md:p-5"
          >
            {isPreview && (
              <p className="mb-2 shrink-0 text-xs text-muted">
                Preview — showing first 30s
              </p>
            )}
            {showLoading ? (
              <LyricsSkeleton />
            ) : (
              <LyricsPanel
                trackId={currentTrack.id}
                lines={synced ?? []}
                plainLyrics={lyrics?.ok && lyrics.plain ? lyrics.plain : null}
                currentTime={progress}
                isPlaying={playing}
                onSeek={seek}
              />
            )}
          </motion.section>
        </div>
      </div>
    </div>
    </MotionConfig>
  );
}

/** Human-readable current repeat mode for aria-labels/tooltips. */
function repeatLabel(mode: string): string {
  if (mode === "one") return "Repeat one";
  if (mode === "all") return "Repeat all";
  return "Repeat off";
}

/* -------------------------------------------------------------------------- */
/* Transport glyphs (repeat / shuffle / volume)                                */
/* -------------------------------------------------------------------------- */

/* Shared icon set (icons.tsx) is the single source (frontend.md §1.1); the
   wrappers pin the full player's glyph size. */
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
  return volume < 0.5 ? <VolumeLow className="h-5 w-5" /> : <VolumeHigh className="h-5 w-5" />;
}
