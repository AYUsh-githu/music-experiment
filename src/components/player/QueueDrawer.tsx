"use client";

/**
 * Slide-over queue drawer: browse, reorder, and remove from the playback queue.
 *
 * WHY a separate drawer rather than inline on the MiniPlayer: the queue can be
 * arbitrarily long and needs its own scroll surface; overlaying it keeps the
 * now-playing strip uncluttered (plan § Phase 2 "Queue drawer", v1 uses
 * button-based reorder — no drag-and-drop).
 *
 * Layout mirrors MiniPlayer's fixed positioning so the drawer never covers the
 * bottom tab bar on mobile: full-width bottom sheet becomes a right-edge w-96
 * panel on md+.
 *
 * Enter/exit (Wave 2 / F12): wrapped in AnimatePresence so the panel actually
 * mounts and unmounts with a motion transition rather than popping:
 *   - desktop right rail: x 100% -> 0, 320 ms ease-out (DUR.standard + EASE.out)
 *   - mobile bottom sheet: y 100% -> 0, with drag-to-dismiss (drag="y",
 *     dragConstraints top:0, dismiss when offsetY > 120 or release velocity > 500)
 *     using SPRING.soft.
 *   - backdrop: opacity fade 200 ms (DUR.quick).
 * Static fallbacks under reduced motion: AnimatePresence still mounts/unmounts,
 * but framer collapses the transform/opacity transitions (MotionConfig
 * reducedMotion="user" is mounted at the provider root), so the drawer appears
 * instantly with no slide/drag animation.
 *
 * Modal a11y: role="dialog" aria-modal="true", focus trap, focuses the dialog on
 * open, closes on Esc, restores focus to the invoking button on close
 * (useFocusTrap, unchanged). Background scroll is LOCKED while open (F12) — the
 * real scroll container is Shell's <main> (overflow-y-auto), so we toggle a
 * documentElement data attribute and a matching globals.css rule rather than
 * touching Shell.tsx (which this agent does not own).
 *
 * Footer: Repeat + Shuffle controls live in a sticky footer so the user can
 * shape playback without leaving the queue.
 *
 * Row overflow menu (WS2 F8 / "queue rows get a reduced menu: remove +
 * play-next"): each row carries a ⋯ trigger that opens a COMPACT two-item
 * popover — "Play next" and "Remove from queue". WHY a local popover rather
 * than the shared TrackContextMenu: that component's item set (Add to playlist
 * ▸, Add to queue, Favorite, Go to album/artist) is fixed — it supports
 * optional EXTRA items but has no prop to SUPPRESS the browsing-surface items,
 * and §5 makes it read-only for this agent. A five-item menu on a queue row
 * would also be wrong: "Add to queue" is meaningless here, and a nested
 * playlist flyout inside a modal drawer (its own portal + focus trap) would
 * contend with the drawer's trap. The popover below reuses the SAME dismissal
 * / keyboard / placement recipes (Escape, outside pointerdown, roving
 * ArrowUp/Down/Home/End, focus return to the trigger, measured edge flip) so
 * the two menus cannot drift behaviourally, and it is not a second implementation
 * of any shared primitive (§4 forbids forking those): it is a local, frozen,
 * two-action menu. Revisit only if the shared component grows a
 * `items`/`variant` prop.
 *
 * The ⋯ trigger is a real 44px <button> that stopPropagation()s its pointerdown
 * so a press on it can never start the mobile drag-to-dismiss gesture (framer
 * attaches drag listeners on the panel and begins a drag on pointerdown).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { usePlayer } from "@/lib/client/PlayerContext";
import { useFocusTrap } from "@/lib/client/useFocusTrap";
import EqualizerBars from "@/components/ui/EqualizerBars";
import { useScrollLock } from "./useScrollLock";
import { DUR, EASE, SPRING } from "@/lib/client/motion";
import { useArtworkThemeColor } from "@/lib/client/ArtworkTheme";
import { cn } from "@/components/track/cn";
// Shared icon set — the queue's close button and empty state use SVGs rather
// than the text glyph / emoji they previously rendered (whose metrics vary by OS
// and which cannot take currentColor).
import { X, Queue } from "@/components/ui/icons";
import type { Track } from "@/lib/types";

/** Gap between the ⋯ trigger and the popover edge (px). */
const MENU_GAP = 6;
/** Viewport inset kept clear when flipping/clamping the popover (px). */
const VIEWPORT_INSET = 8;
/** Fallback popover size for the first (unmeasured) frame only. */
const MENU_FALLBACK = { width: 208, height: 88 } as const;

interface QueueDrawerProps {
  open: boolean;
  /** Called whenever the user dismisses the drawer (backdrop click or Close). */
  onClose: () => void;
}

export default function QueueDrawer({ open, onClose }: QueueDrawerProps) {
  const {
    queue,
    currentIndex,
    playing,
    repeat,
    shuffle,
    removeFromQueue,
    moveInQueue,
    togglePlay,
    playQueue,
    playNext,
    toggleRepeat,
    toggleShuffle,
  } = usePlayer();

  // The dialog root. useFocusTrap confines Tab, focuses the dialog on open,
  // closes on Esc (via onClose) and restores focus to the trigger on close.
  const dialogRef = useRef<HTMLDivElement | null>(null);
  // Unconditional (before any early return) so the hook order never varies.
  useFocusTrap(dialogRef, open, onClose);
  // Lock the Shell <main> scroller while the drawer is open (F12).
  useScrollLock(open);

  // Which layout is active drives BOTH the slide axis and its transition:
  // desktop right rail slides on x with a 320 ms ease-out; the mobile bottom
  // sheet slides on y with SPRING.soft. We read the md breakpoint directly so
  // the motion style matches the rendered layout.
  const isDesktop = useIsDesktop();

  const isCurrentPlaying = (i: number) => i === currentIndex && playing;

  // Enter/exit targets + transition per layout. `x` is only used on desktop,
  // `y` only on mobile; the unused axis is held at 0.
  const initial = isDesktop ? { x: "100%", y: 0 } : { x: 0, y: "100%" };
  const animateTo = { x: 0, y: 0 };
  const exit = isDesktop ? { x: "100%", y: 0 } : { x: 0, y: "100%" };
  const panelTransition = isDesktop
    ? { duration: DUR.standard, ease: EASE.out }
    : SPRING.soft;

  return (
    <AnimatePresence>
      {open && (
        /* z-50, one step above FullPlayer's z-40. WHY: both are aria-modal
           overlays and the queue can be opened FROM the now-playing view. On the
           same layer the stack order was ambiguous, and screen readers still
           reached the covered dialog as if it were live. Being strictly above
           makes the correct dialog the active one. */
        <div ref={dialogRef} className="fixed inset-0 z-50">
          {/* Backdrop — click anywhere outside the panel to dismiss. Fades over
              the quick token; the button itself never moves. */}
          <motion.button
            type="button"
            aria-label="Close queue"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: DUR.quick, ease: EASE.out }}
            className="absolute inset-0 h-full w-full cursor-default bg-black/60"
          />
          {/* Panel: bottom sheet on mobile (y, drag-to-dismiss), right rail on
              md+ (x). Sits above the tab bar via bottom-[52px]; desktop has no
              tab bar so it runs full height. Enter/exit is transform-only. */}
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-label="Queue"
            initial={initial}
            animate={animateTo}
            exit={exit}
            transition={panelTransition}
            // Mobile drag-to-dismiss: down only, dismiss on distance or velocity.
            // Disabled on desktop so the rail never follows the pointer.
            drag={isDesktop ? false : "y"}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={isDesktop ? 0 : { top: 0, bottom: 0.4 }}
            onDragEnd={(_, info) => {
              if (isDesktop) return;
              if (info.offset.y > 120 || info.velocity.y > 500) onClose();
            }}
            className="absolute inset-x-0 bottom-[52px] top-0 flex flex-col overflow-hidden border-t border-border bg-surface shadow-2xl md:right-0 md:left-auto md:bottom-0 md:top-0 md:w-96 md:max-w-[90vw] md:border-l md:border-t-0"
          >
            {/* Header */}
            <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
              <h2 className="text-base font-semibold text-text">
                Queue
                <span className="ml-2 text-sm font-normal text-muted">
                  {queue.length} {queue.length === 1 ? "track" : "tracks"}
                </span>
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close queue"
                className="grid h-11 w-11 place-items-center rounded-full text-muted transition-colors hover:bg-surface-2 hover:text-text"
              >
                {/* Shared icon, not a text glyph: ✕ rendered with different
                    metrics/weight per OS next to 1.8px SVG icons everywhere else. */}
                <X className="h-5 w-5" aria-hidden />
              </button>
            </header>

            {/* Scrollable list or empty state */}
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {queue.length === 0 ? (
                <div className="flex flex-col items-center gap-2 rounded-xl border border-border bg-surface-2 px-6 py-12 text-center">
                  {/* SVG rather than the 🎧 emoji that was here: emoji
                      metrics vary by OS and cannot take currentColor. */}
                  <Queue className="h-10 w-10 text-muted opacity-40" aria-hidden />
                  <p className="text-base font-semibold text-text">Queue is empty</p>
                  <p className="max-w-sm text-sm text-muted">
                    Add songs from search and they will appear here.
                  </p>
                </div>
              ) : (
                <ul className="flex flex-col gap-1">
                  {queue.map((track, index) => (
                    <QueueRow
                      key={track.id + ":" + index}
                      index={index}
                      track={track}
                      isCurrent={index === currentIndex}
                      isPlaying={isCurrentPlaying(index)}
                      queueLength={queue.length}
                      onMoveUp={() => moveInQueue(index, index - 1)}
                      onMoveDown={() => moveInQueue(index, index + 1)}
                      onRemove={() => removeFromQueue(index)}
                      // "Play next" is the additive playNext action: it inserts a
                      // COPY of this track immediately after the current one, so the
                      // row stays where it is (it is a "promote", not a move).
                      onPlayNext={() => playNext(track)}
                      onTogglePlay={togglePlay}
                      onPlay={(i) => playQueue(queue, i)}
                    />
                  ))}
                </ul>
              )}
            </div>

            {/* Footer: repeat + shuffle. */}
            <footer className="flex shrink-0 items-center justify-around border-t border-border px-4 py-2">
              <button
                type="button"
                onClick={toggleRepeat}
                aria-pressed={repeat !== "off"}
                aria-label={repeatLabel(repeat)}
                title={repeatLabel(repeat)}
                className={`relative grid h-11 w-11 place-items-center rounded-full transition-colors hover:bg-surface-2 ${
                  repeat !== "off" ? "text-accent" : "text-muted hover:text-text"
                }`}
              >
                <RepeatGlyph mode={repeat} />
                {/* Active dot for repeat-all (repeat-one keeps its "1" badge). */}
                {repeat === "all" && (
                  <span
                    className="absolute bottom-1.5 h-1 w-1 rounded-full bg-accent"
                    aria-hidden
                  />
                )}
                <span className="sr-only">Repeat</span>
              </button>
              <button
                type="button"
                onClick={toggleShuffle}
                aria-pressed={shuffle}
                aria-label={shuffle ? "Shuffle on" : "Shuffle off"}
                title={shuffle ? "Shuffle on" : "Shuffle off"}
                className={`relative grid h-11 w-11 place-items-center rounded-full transition-colors hover:bg-surface-2 ${
                  shuffle ? "text-accent" : "text-muted hover:text-text"
                }`}
              >
                <ShuffleIcon />
                {/* Active dot for shuffle. */}
                {shuffle && (
                  <span
                    className="absolute bottom-1.5 h-1 w-1 rounded-full bg-accent"
                    aria-hidden
                  />
                )}
                <span className="sr-only">Shuffle</span>
              </button>
            </footer>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}

/* -------------------------------------------------------------------------- */
/* Row                                                                        */
/* -------------------------------------------------------------------------- */

interface QueueRowProps {
  index: number;
  track: Track;
  queueLength: number;
  /** True when this row holds the currently-playing track. */
  isCurrent: boolean;
  /** True when this row is current AND audio is playing (drives the toggle glyph). */
  isPlaying: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  /** Queue-local "play this next" (inserts a copy after the current track). */
  onPlayNext: () => void;
  onTogglePlay: () => void;
  /** Jump to a specific queue index and start playing it (bug L16 fix). */
  onPlay: (index: number) => void;
}
function QueueRow({
  index,
  track,
  queueLength,
  isCurrent,
  isPlaying,
  onMoveUp,
  onMoveDown,
  onRemove,
  onPlayNext,
  onTogglePlay,
  onPlay,
}: QueueRowProps) {
  // The ⋯ popover's open state lives on the row: each row owns exactly one
  // menu, and it unmounts with the row (the queue re-keys rows by index), so
  // no menu can ever outlive its trigger.
  const [menuOpen, setMenuOpen] = useState(false);
  // Artwork tint for the current row's edge (§3.4); null falls back to accent.
  const artworkColor = useArtworkThemeColor();
  // The ⋯ button — the popover's anchor AND the element focus returns to.
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  // The portaled popover. Also the focus-trap root.
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Anchor point (viewport coords) the popover is positioned against, captured
  // from the trigger's rect at open time.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  // Resolved placement, computed after the popover renders and measures. Until
  // then the popover is parked offscreen so the unmeasured frame never flashes.
  const [placement, setPlacement] = useState<{ top: number; left: number } | null>(
    null
  );

  /* ------------------------------ openers ------------------------------ */

  const openMenu = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setPlacement(null); // re-measured in the placement effect below
    setAnchor({ x: r.left, y: r.bottom });
    setMenuOpen(true);
  }, []);

  const closeMenu = useCallback(() => {
    setMenuOpen(false);
    setAnchor(null);
    setPlacement(null);
  }, []);

  /* ------------------------------ dismissal ---------------------------- */

  // Outside-click + Escape. Escape is ALSO handled by the focus trap below, but
  // this covers the window before the trap's effect has attached. Both close the
  // POPOVER first — the trap owns the pointer and calls `closeMenu`, so the
  // drawer itself stays open, which is the correct "close one layer" behaviour.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (menuRef.current?.contains(t)) return;
      closeMenu();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // The focus trap's listener is also on `window`; whichever runs first, the
      // popover closes and neither handler lets the key reach the drawer.
      e.preventDefault();
      e.stopPropagation();
      closeMenu();
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menuOpen, closeMenu]);

  // Focus trap scoped to the popover: focuses the menu on open, confines Tab to
  // its two items, and restores focus to the ⋯ trigger on close. The trap's own
  // Escape handler calls `closeMenu` (NOT the drawer's onClose), and because the
  // trap listener is registered AFTER the drawer's, the drawer's handler runs
  // first — but it was added with the same target/phase, so the capture-phase
  // handler above has already stopped propagation by then.
  useFocusTrap(menuRef, menuOpen, closeMenu, triggerRef);

  /* --------------------------- measurement ---------------------------- */

  // Measure the rendered popover and resolve a placement that flips above the
  // trigger when there is no room below (the common case for the LAST queue
  // rows, which sit near the drawer's bottom edge) and clamps left/right inside
  // the viewport. Same recipe as the shared track menu.
  useEffect(() => {
    if (!menuOpen || !anchor) return;
    const el = menuRef.current;
    const w = el?.offsetWidth || MENU_FALLBACK.width;
    const h = el?.offsetHeight || MENU_FALLBACK.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let top = anchor.y + MENU_GAP; // preferred: below the ⋯ trigger
    if (top + h > vh - VIEWPORT_INSET) {
      const above = anchor.y - MENU_GAP - h - 44; // 44px ≈ the trigger's height
      top = above >= VIEWPORT_INSET ? above : Math.max(VIEWPORT_INSET, vh - VIEWPORT_INSET - h);
    }

    // Prefer left-aligning to the trigger's left edge; flip/clamp when the panel
    // (desktop right rail sits flush against the right edge) would overflow.
    let left = anchor.x;
    if (left + w > vw - VIEWPORT_INSET) left = vw - VIEWPORT_INSET - w;
    if (left < VIEWPORT_INSET) left = VIEWPORT_INSET;

    setPlacement({ top, left });
  }, [menuOpen, anchor]);

  // Initial focus: the first item, once the placement has landed so the menu is
  // on-screen (the trap focuses the shell; this refines to a real item so
  // ArrowDown starts from item 1).
  useEffect(() => {
    if (!menuOpen || !placement) return;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [menuOpen, placement]);

  /** Roving ArrowUp/Down/Home/End navigation between the two menu items. */
  const onMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []
    );
    if (items.length === 0) return;
    e.preventDefault();
    const idx = items.indexOf(document.activeElement as HTMLElement);
    let next = idx;
    if (e.key === "ArrowDown") next = idx < 0 ? 0 : (idx + 1) % items.length;
    else if (e.key === "ArrowUp") next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    items[next]?.focus();
  };

  /** Run a menu action and close, returning focus to the ⋯ trigger. */
  const runAndClose = (action: () => void) => {
    action();
    closeMenu();
  };

  const triggerLabel = `More options for ${track.title}`;

  return (
    <li
      data-current={isCurrent ? "true" : undefined}
      aria-current={isCurrent ? "true" : undefined}
      className={cn(
        "group flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm",
        { "bg-surface-2": isCurrent, "hover:bg-surface-2": !isCurrent }
      )}
      // §3.4: the playing row gets a 2px artwork-tinted edge (falls back to the
      // brand accent when the cover color is unknown). A static border — nothing
      // here animates, so no reduced-motion concern.
      style={
        isCurrent
          ? { borderLeft: `2px solid ${artworkColor ?? "var(--accent)"}` }
          : undefined
      }
    >
      {/* Play target. WHY a real <button> wrapping only the non-interactive
          content, and NOT `role="button"` on the <li>: this row also contains
          genuine controls (play/pause, move up/down, ⋯ menu). ARIA forbids
          interactive descendants inside a button — screen readers flatten them —
          so the row is a listitem holding siblings: these pieces, then the
          controls. Space/Enter come free from the element instead of a
          hand-rolled onKeyDown.

          The row's play affordance is split across the toggle below, which
          cannot live inside this button, so the index/indicator is presented
          purely as decoration (aria-hidden) and the title block carries the
          real, labelled control. */}
      <div className="w-6 shrink-0 text-center" aria-hidden>
        {isCurrent ? (
          <EqualizerBars playing={isPlaying} className="h-4 w-4" />
        ) : (
          <span className="text-xs tabular-nums text-muted">{index + 1}</span>
        )}
      </div>

      {/* Now-playing rows swap the index number for a miniature toggle. A
          SIBLING of the play button, not a descendant: nesting it inside would
          put a button inside a button. */}
      {isCurrent ? (
        <button
          type="button"
          onClick={onTogglePlay}
          // See PLAY_PAUSE_ATTR in useGlobalKeyboardShortcuts: the global Space
          // shortcut yields to this control specifically, so a focused row
          // toggle doesn't double-fire.
          data-sonic-playpause=""
          aria-label={isPlaying ? `Pause ${track.title}` : `Play ${track.title}`}
          className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent text-white transition-transform hover:scale-105"
        >
          <span aria-hidden>{isPlaying ? "⏸" : "▶"}</span>
        </button>
      ) : (
        <span className="w-8 shrink-0" aria-hidden />
      )}

      {/* Title + artist — the rest of the play target, so it rejoins the button.
          Split from the index block above only because the toggle sits between
          them in the visual order. */}
      <button
        type="button"
        onClick={() => onPlay(index)}
        aria-label={`Play ${track.title} by ${track.artist}`}
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        <span className="min-w-0 flex-1">
          <span
            className={cn("block truncate font-medium", {
              "text-accent": isCurrent,
              "text-text": !isCurrent,
            })}
            title={track.title}
          >
            {track.title}
          </span>
          <span className="block truncate text-xs text-muted" title={track.artist}>
            {track.artist}
          </span>
        </span>

        <span className="shrink-0 text-xs tabular-nums text-muted">
          {formatDuration(track.duration)}
        </span>
      </button>

      {/* Reorder controls — 44px touch targets, ALWAYS visible (keyboard users
          rely on them; they are not hidden behind the menu). */}
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMoveUp();
          }}
          disabled={index === 0}
          aria-label="Move up"
          className="grid h-11 w-11 place-items-center rounded-full text-muted transition-colors hover:bg-bg hover:text-text disabled:opacity-30"
        >
          <span aria-hidden>↑</span>
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onMoveDown();
          }}
          disabled={index === queueLength - 1}
          aria-label="Move down"
          className="grid h-11 w-11 place-items-center rounded-full text-muted transition-colors hover:bg-bg hover:text-text disabled:opacity-30"
        >
          <span aria-hidden>↓</span>
        </button>
      </div>

      {/* Reduced row menu (WS2 F8): "Play next" + "Remove from queue". */}
      <button
        ref={triggerRef}
        type="button"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        // CRITICAL: frame the drag-to-dismiss gesture away from this control.
        // framer's drag starts on the panel's pointerdown; the row would
        // otherwise forward it and the sheet would slide as the user tapped ⋯.
        // Stopping the native event (React's synthetic stopPropagation runs at
        // the root, AFTER framer's native listeners) is what actually blocks it.
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation(); // never start playback from the menu trigger
          if (menuOpen) closeMenu();
          else openMenu();
        }}
        className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted transition-colors hover:bg-bg hover:text-text"
      >
        <span aria-hidden>⋯</span>
      </button>

      {/* The menu itself. Portaled to <body> so the drawer's scroll container
          (overflow-y-auto) can never clip it, and so it stacks above the panel. */}
      {menuOpen && anchor && typeof document !== "undefined" &&
        createPortal(
          <motion.div
            ref={menuRef}
            role="menu"
            aria-label={triggerLabel}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: DUR.instant, ease: EASE.out }}
            onKeyDown={onMenuKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
            className="fixed z-[60] min-w-52 rounded-xl border border-border bg-surface py-1.5 shadow-2xl shadow-black/50"
            style={{ top: placement?.top ?? -9999, left: placement?.left ?? -9999 }}
          >
            <QueueMenuItem onClick={() => runAndClose(onPlayNext)}>
              Play next
            </QueueMenuItem>
            <QueueMenuItem accent onClick={() => runAndClose(onRemove)}>
              Remove from queue
            </QueueMenuItem>
          </motion.div>,
          document.body
        )}
    </li>
  );
}

/**
 * One popover item. role="menuitem" + the shared focus/hover treatment so the
 * reduced queue menu reads identically to the full track menu.
 */
function QueueMenuItem({
  children,
  onClick,
  accent,
}: {
  children: React.ReactNode;
  onClick: () => void;
  /** Destructive styling (Remove). */
  accent?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex w-full items-center px-3 py-2 text-left text-sm text-text",
        "transition-colors duration-[var(--dur-micro)] hover:bg-surface-2",
        "focus-visible:bg-surface-2 focus-visible:outline-none",
        { "text-danger": accent === true }
      )}
    >
      <span className="truncate">{children}</span>
    </button>
  );
}

/** Seconds -> "m:ss" (273 -> "4:33"). Tolerates missing/bad data. */
function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

/** Human-readable current repeat mode for aria-labels/tooltips. */
function repeatLabel(mode: string): string {
  if (mode === "one") return "Repeat one";
  if (mode === "all") return "Repeat all";
  return "Repeat off";
}

/* ------------------------------ glyphs ------------------------------ */

/** Repeat glyph that morphs (cross-fades) between Repeat and Repeat-one. */
function RepeatGlyph({ mode }: { mode: string }) {
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.span
        key={mode === "one" ? "one" : "all"}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: DUR.instant, ease: EASE.out }}
        className="grid place-items-center"
      >
        {mode === "one" ? <RepeatOneIcon /> : <RepeatIcon />}
      </motion.span>
    </AnimatePresence>
  );
}

function RepeatIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden>
      <path d="M7 7h10v3l4-4-4-4v3H5v4h2V7Zm10 10H7v-3l-4 4 4 4v-3h12v-4h-2v4Z" />
    </svg>
  );
}
function RepeatOneIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden>
      <path d="M7 7h10v3l4-4-4-4v3H5v5h2V7Zm10 10H7v-3l-4 4 4 4v-3h12v-5h-2v4Zm-5.5-8h.5v5H13V9.5h-1l-.5 1v1h1V9Z" />
    </svg>
  );
}
function ShuffleIcon() {
  return (
    <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden>
      <path d="M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41ZM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5Zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13Z" />
    </svg>
  );
}

/**
 * Whether the md+ layout is active (Tailwind's `md` breakpoint = 768px). Drives
 * which axis the drawer slides on and its transition (desktop ease-out vs mobile
 * spring). matchMedia is listener-backed so a resize/orientation change updates
 * the motion style without a remount.
 */
function useIsDesktop(): boolean {
  const [isDesktop, setIsDesktop] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(min-width: 768px)");
    const update = () => setIsDesktop(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return isDesktop;
}
