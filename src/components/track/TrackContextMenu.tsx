"use client";

/**
 * Reusable per-track overflow context menu (Wave 1 defect 7 → WS2 F8 completion).
 *
 * A positioned dropdown of track actions, shared by TrackRow, TrackCard and the
 * FullPlayer header so "Add to playlist / Add to queue / Play next / Favorite"
 * behave the same everywhere. It renders its own "…" trigger and, when open, a
 * portal popover anchored to the trigger's rect — portaling keeps the menu from
 * being clipped by an ancestor's overflow (a horizontal home shelf, a rounded
 * playlist card, etc.).
 *
 * Structure per §6 F8:
 *   - Add to playlist ▸ (submenu of existing playlists + "New playlist…")
 *   - Add to queue
 *   - Play next
 *   - Favorite toggle (aria-pressed, filled/pressed state)
 *   - Go to album / artist — only when the consumer passes the callbacks. The
 *     Track data shape (src/lib/types.ts) carries no album/artist IDS, so no
 *     caller can provide them; per the spec ("drop the item if not") the rows
 *     simply never render. Documented, not deleted silently.
 *
 * Openers (all reach the SAME menu):
 *   - the "…" button (click)
 *   - long-press on a row/card (500 ms pointerdown timer; cancelled when the
 *     pointer moves > 8 px or lifts early; suppresses the click that follows)
 *   - `contextmenu` on a row/card (opened at the cursor). The consumer's rows
 *     call `preventDefault` only in their own handler, never globally.
 *
 * Dismissal: outside click, Escape, and route change (usePathname).
 *
 * Keyboard: focus trap (reuses src/lib/client/useFocusTrap.ts), ArrowUp/Down +
 * Home/End roving between items, initial focus on the first item, and focus
 * return to the "…" trigger on close.
 *
 * Edge flip: the menu's measured rect is compared against the viewport and it
 * flips above the trigger when there is not enough room below, and left/right
 * when it would overflow the side.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import type { Track } from "@/lib/types";
import { usePlayer } from "@/lib/client/PlayerContext";
import {
  getPlaylists,
  addToPlaylist,
  createPlaylist,
  isFavorite,
  toggleFavorite,
  type Playlist,
} from "@/lib/client/db";
import { DUR } from "@/lib/client/motion";
import { useFocusTrap } from "@/lib/client/useFocusTrap";
import { MoreHorizontal } from "@/components/ui/icons";
import { cn } from "@/components/track/cn";

/** Gap between the trigger/cursor and the menu edge (px). */
const MENU_GAP = 6;
/** Viewport inset kept clear when flipping/clamping (px). */
const VIEWPORT_INSET = 8;
/** Long-press duration before the menu opens on a coarse pointer (ms). */
const LONG_PRESS_MS = 500;
/** Pointer travel that cancels an in-progress long-press (px). */
const LONG_PRESS_SLOP = 8;
/** Fallback menu size used only for the pre-measure open frame. */
const MENU_FALLBACK = { width: 224, height: 200 } as const;

interface TrackContextMenuProps {
  track: Track;
  /** Fired after "Add to queue". Optional — falls back to the player's action. */
  onAddToQueue?: () => void;
  /** Fired after "Play next". Optional — falls back to the player's action. */
  onPlayNext?: () => void;
  /** Optional "Go to album" row (renders only when provided). */
  onGoToAlbum?: () => void;
  /** Optional "Go to artist" row (renders only when provided). */
  onGoToArtist?: () => void;
  /** aria-label for the "…" trigger, e.g. "More options for {track}". */
  label?: string;
  /** Extra classes for the trigger button (sizing/colors). */
  triggerClassName?: string;
  /**
   * tabIndex for the "…" trigger. Consumers whose trigger is REVEALED by hover
   * (never by focus) pass -1 so it does not become a ghosted tab stop in front
   * of the real action on every row. Omit to keep the natural order.
   */
  triggerTabIndex?: number;
  /** Close immediately after picking an item (default true). */
  closeOnSelect?: boolean;
  /**
   * When true the "…" trigger button renders its own `<button>`. When false the
   * consumer supplies its own opener element/long-press surface and merely wants
   * this component's menu + imperative methods — used by TrackRow/TrackCard,
   * which wrap the row/card in a long-press + contextmenu surface themselves.
   */
  showTrigger?: boolean;
  /**
   * Long-press surface. The consumer passes the row/card element's ref so this
   * component can bind pointerdown/pointermove/pointerup + contextmenu on it and
   * open the menu at the finger/cursor. Optional; when omitted the trigger (or
   * `externalTrigger`) is the only opener.
   */
  pressSurfaceRef?: React.RefObject<HTMLElement | null>;
}

/** Where an open menu should sit, resolved from the measured rects. */
interface MenuPlacement {
  top: number;
  left: number;
}

export default function TrackContextMenu({
  track,
  onAddToQueue,
  onPlayNext,
  onGoToAlbum,
  onGoToArtist,
  label,
  triggerClassName,
  triggerTabIndex,
  closeOnSelect = true,
  showTrigger = true,
  pressSurfaceRef,
}: TrackContextMenuProps) {
  const { addToQueue, playNext } = usePlayer();
  const pathname = usePathname();

  const [open, setOpen] = useState(false);
  // The pathname the menu was opened at. Route-change dismissal is DERIVED from
  // this rather than done in an effect: if the app navigates while the menu is
  // open, the stored path no longer matches the live one and the menu renders
  // closed — no setState-in-effect cascade, and the menu can never survive a
  // navigation (the portal is outside the route tree, so nothing else would
  // unmount it). This mirrors React's "adjust state when a prop changes" pattern.
  const [openedAtPath, setOpenedAtPath] = useState(pathname);
  const menuOpen = open && openedAtPath === pathname;
  // Which group is currently expanded inside the open menu: null = root,
  // "playlists" = the "Add to playlist" flyout (shown as a stacked sub-menu).
  const [submenu, setSubmenu] = useState<"playlists" | null>(null);
  // Playlists fetched from IndexedDB when the playlist submenu is first opened.
  const [playlists, setPlaylists] = useState<Playlist[]>([]);
  // True while the "New playlist…" input is shown inside the submenu.
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  // Favorite state for this track (loaded lazily on first open to avoid a db
  // read per row on every list render — rows can number in the hundreds).
  const [isFav, setIsFav] = useState(false);
  // True once the favorite flag has been read, so the row does not flash.
  const [favLoaded, setFavLoaded] = useState(false);

  // The anchor rect the menu is positioned against. Set at open time from the
  // trigger, the long-press finger, or the contextmenu cursor.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  // The resolved placement, computed after the menu renders and measures.
  const [placement, setPlacement] = useState<MenuPlacement | null>(null);

  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Load playlists lazily when the playlist submenu is about to show.
  const loadPlaylists = useCallback(async () => {
    setPlaylists(await getPlaylists());
  }, []);

  const openAt = useCallback(
    (x: number, y: number) => {
      setSubmenu(null);
      setCreating(false);
      setNewName("");
      setPlacement(null); // re-measured in the placement effect below
      setAnchor({ x, y });
      setOpenedAtPath(pathname); // remember where we opened, for route dismissal
      setOpen(true);
    },
    [pathname]
  );

  const openFromTrigger = useCallback(() => {
    const el = triggerRef.current ?? pressSurfaceRef?.current ?? null;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Anchor just under the trigger's leading edge, per the "…" click opener.
    openAt(r.left, r.bottom);
  }, [openAt, pressSurfaceRef]);

  const closeMenu = useCallback(() => {
    setOpen(false);
    setSubmenu(null);
    setCreating(false);
    setNewName("");
  }, []);

  /* ------------------------------ openers ------------------------------ */

  // Long-press + contextmenu on the consumer-supplied surface. Registered on the
  // surface element itself (not document) so it participates in the normal event
  // flow and unmounts with the row.
  useEffect(() => {
    const el = pressSurfaceRef?.current;
    if (!el) return;

    let timer: number | null = null;
    let startX = 0;
    let startY = 0;
    let fired = false;

    const clear = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      // Only primary/left/pen/touch presses open the long-press menu.
      if (e.button !== 0) return;
      fired = false;
      startX = e.clientX;
      startY = e.clientY;
      clear();
      timer = window.setTimeout(() => {
        fired = true;
        openAt(startX, startY);
      }, LONG_PRESS_MS);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (timer === null) return;
      const dx = Math.abs(e.clientX - startX);
      const dy = Math.abs(e.clientY - startY);
      // Travelling further than the slop means the user is scrolling/swiping,
      // not long-pressing — cancel so the menu doesn't ambush a scroll.
      if (dx > LONG_PRESS_SLOP || dy > LONG_PRESS_SLOP) clear();
    };

    const onPointerUp = () => clear();

    const onClickCapture = (e: MouseEvent) => {
      // Suppress the click that naturally follows a completed long-press, so the
      // row does not also start playback underneath the freshly opened menu.
      if (!fired) return;
      fired = false;
      e.preventDefault();
      e.stopPropagation();
    };

    const onContextMenu = (e: MouseEvent) => {
      // preventDefault ONLY on the row/card that owns a custom menu, so a
      // right-click anywhere else keeps the browser's own menu (§9 WS2 accept).
      e.preventDefault();
      openAt(e.clientX, e.clientY);
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
    el.addEventListener("click", onClickCapture, true);
    el.addEventListener("contextmenu", onContextMenu);
    return () => {
      clear();
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerUp);
      el.removeEventListener("click", onClickCapture, true);
      el.removeEventListener("contextmenu", onContextMenu);
    };
  }, [pressSurfaceRef, openAt]);

  // Outside-click + Escape dismissal. Escape is also handled by the focus trap,
  // but this covers the case where the trap has not yet attached.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (triggerRef.current && triggerRef.current.contains(t)) return;
      const surface = pressSurfaceRef?.current;
      if (surface && surface.contains(t)) return;
      const menuEl = menuRef.current;
      if (menuEl && menuEl.contains(t)) return;
      closeMenu();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [menuOpen, closeMenu, pressSurfaceRef]);

  // Focus trap: confines Tab to the menu, focuses the shell on open, restores
  // focus to the "…" trigger on close. Reuses the shared modal trap (§4 forbids
  // a bespoke one).
  useFocusTrap(menuRef, menuOpen, closeMenu, triggerRef);

  // Load the favorite flag the first time the menu opens (one db read per row,
  // not per render).
  useEffect(() => {
    if (!menuOpen || favLoaded) return;
    let cancelled = false;
    isFavorite(track)
      .then((fav) => {
        if (!cancelled) {
          setIsFav(fav);
          setFavLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFavLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [menuOpen, favLoaded, track]);

  /* --------------------------- measurement ---------------------------- */

  // Measure the rendered menu and resolve a placement that flips above/below and
  // left/right of the anchor when the preferred spot has no room. The menu is
  // parked offscreen until this runs, so there is no visible jump. Uses a plain
  // effect rather than useLayoutEffect to avoid React's SSR warning (this
  // component is server-rendered as part of a list, even though the menu itself
  // only ever exists after a client interaction).
  useEffect(() => {
    if (!menuOpen || !anchor) return;
    const menuEl = menuRef.current;
    const w = menuEl?.offsetWidth || MENU_FALLBACK.width;
    const h = menuEl?.offsetHeight || MENU_FALLBACK.height;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Preferred: below the anchor, left-aligned to it.
    let top = anchor.y + MENU_GAP;
    if (top + h > vh - VIEWPORT_INSET) {
      // Not enough room below → flip above the anchor.
      const above = anchor.y - MENU_GAP - h;
      if (above >= VIEWPORT_INSET) {
        top = above;
      } else {
        // Fits neither way (very short viewport): clamp into the viewport.
        top = Math.max(VIEWPORT_INSET, vh - VIEWPORT_INSET - h);
      }
    }

    let left = anchor.x;
    if (left + w > vw - VIEWPORT_INSET) left = vw - VIEWPORT_INSET - w; // flip right→left
    if (left < VIEWPORT_INSET) left = VIEWPORT_INSET;

    setPlacement({ top, left });
  }, [menuOpen, anchor, submenu, creating]);

  /* ------------------------------ focus ------------------------------- */

  // Initial focus: the first menu item, once the placement effect has run so the
  // menu is on-screen. The focus trap focuses the shell; this refines to the
  // first item so ArrowDown begins from a real item.
  useEffect(() => {
    if (!menuOpen || !placement) return;
    // Include menuitemcheckbox (the Favorite row) so keyboard navigation never
    // skips it.
    const first = menuRef.current?.querySelector<HTMLElement>(
      '[role="menuitem"], [role="menuitemcheckbox"]'
    );
    first?.focus();
  }, [menuOpen, placement]);

  /** Roving ArrowUp/Down/Home/End navigation between menu items. */
  const onMenuKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!(e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Home" || e.key === "End")) {
      return;
    }
    const items = Array.from(
      menuRef.current?.querySelectorAll<HTMLElement>(
        '[role="menuitem"], [role="menuitemcheckbox"]'
      ) ?? []
    );
    if (items.length === 0) return;
    e.preventDefault();
    const active = document.activeElement as HTMLElement | null;
    const idx = active ? items.indexOf(active) : -1;
    let next = idx;
    if (e.key === "ArrowDown") next = idx < 0 ? 0 : (idx + 1) % items.length;
    else if (e.key === "ArrowUp") next = idx < 0 ? items.length - 1 : (idx - 1 + items.length) % items.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = items.length - 1;
    items[next]?.focus();
  }, []);

  /* ------------------------------ actions ----------------------------- */

  /** Run a payload action, then close (unless the consumer opted to stay open). */
  const run = (fn: () => void) => {
    fn();
    if (closeOnSelect) closeMenu();
    // Reset submenu for the next open.
    setSubmenu(null);
    setCreating(false);
    setNewName("");
  };

  /** Toggle favorite; keeps the menu open so the pressed state is visible. */
  const handleToggleFavorite = async () => {
    try {
      const next = await toggleFavorite(track); // contract: returns NEW state
      setIsFav(next);
      setFavLoaded(true);
    } catch {
      // Storage failures must never break the menu; leave state as-is.
    }
  };

  /** Add the track to a playlist, then close. */
  const handleAddToPlaylist = async (playlist: Playlist) => {
    await addToPlaylist(playlist.id, track);
    if (closeOnSelect) closeMenu();
  };

  /** Create a fresh playlist and add the track to it. */
  const handleCreateAndAdd = async () => {
    const name = newName.trim();
    if (!name) return;
    const pl = await createPlaylist(name);
    await addToPlaylist(pl.id, track);
    setCreating(false);
    setNewName("");
    if (closeOnSelect) closeMenu();
  };

  const triggerLabel = label ?? `More options for ${track.title}`;

  return (
    <>
      {showTrigger && (
        <button
          ref={triggerRef}
          type="button"
          tabIndex={triggerTabIndex}
          aria-label={triggerLabel}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            // The row/card underneath plays on click; the trigger must not.
            e.stopPropagation();
            if (menuOpen) closeMenu();
            else openFromTrigger();
          }}
          onKeyDown={(e) => {
            // Keyboard path for the whole menu. Shift+F10 (and the dedicated
            // context-menu key, where a keyboard has one) is the platform
            // convention for "open this item's context menu" — a keyboard user
            // cannot long-press, so without this opener the menu would be
            // pointer-only. Stop propagation so no ancestor also treats the
            // keystroke as an action.
            if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return;
            e.preventDefault();
            e.stopPropagation();
            closeMenu();
            openFromTrigger();
          }}
          className={cn(
            "touch-visible grid h-11 w-11 shrink-0 place-items-center rounded-full text-muted",
            "transition-[color,background-color,opacity] duration-[var(--dur-micro)]",
            "hover:bg-surface-2 hover:text-text",
            "focus-visible:outline-2 focus-visible:outline-accent",
            // The consumer owns the reveal strategy and passes capability-gated
            // opacity classes (or none). No base opacity utility is set here on
            // purpose: emitting both `opacity-100` and a caller's `opacity-0`
            // would make Tailwind's output order — not intent — decide which
            // wins. `.touch-visible` still pins the button visible whenever the
            // device cannot hover, so an omitted triggerClassName is safe.
            triggerClassName
          )}
        >
          <MoreHorizontal className="h-5 w-5" />
        </button>
      )}

      {menuOpen && anchor && typeof document !== "undefined" &&
        createPortal(
          <motion.div
            ref={menuRef}
            role="menu"
            aria-label={triggerLabel}
            tabIndex={-1}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ duration: DUR.instant }}
            onKeyDown={onMenuKeyDown}
            onMouseDown={(e) => e.stopPropagation()}
            className="fixed z-[60] min-w-56 rounded-xl border border-border bg-surface py-1.5 shadow-2xl shadow-black/50"
            style={{
              // Placement is resolved by the layout effect above; until it runs
              // the menu is parked offscreen so the un-measured frame never
              // flashes in the wrong spot.
              top: placement ? placement.top : -9999,
              left: placement ? placement.left : -9999,
            }}
          >
            {submenu === "playlists" ? (
              <PlaylistSubmenu
                playlists={playlists}
                creating={creating}
                newName={newName}
                setNewName={setNewName}
                onBack={() => setSubmenu(null)}
                onNew={() => {
                  setCreating(true);
                  void loadPlaylists();
                }}
                onPick={(pl) => void handleAddToPlaylist(pl)}
                onCreate={() => void handleCreateAndAdd()}
                onTrackName={track.title}
              />
            ) : (
              <>
                <MenuItem withChevron onClick={() => { setSubmenu("playlists"); void loadPlaylists(); }}>
                  Add to playlist
                </MenuItem>
                <MenuItem onClick={() => run(() => (onAddToQueue ? onAddToQueue() : addToQueue(track)))}>
                  Add to queue
                </MenuItem>
                <MenuItem onClick={() => run(() => (onPlayNext ? onPlayNext() : playNext(track)))}>
                  Play next
                </MenuItem>
                {/* Favorite toggle — stays open so the pressed state is visible. */}
                <MenuItem
                  pressed={isFav}
                  onClick={() => void handleToggleFavorite()}
                >
                  {isFav ? "Favorited" : "Favorite"}
                </MenuItem>
                {onGoToAlbum && <MenuItem onClick={() => run(onGoToAlbum)}>Go to album</MenuItem>}
                {onGoToArtist && <MenuItem onClick={() => run(onGoToArtist)}>Go to artist</MenuItem>}
              </>
            )}
          </motion.div>,
          document.body
        )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Sub-pieces                                                                  */
/* -------------------------------------------------------------------------- */

function MenuItem({
  children,
  onClick,
  withChevron,
  accent,
  pressed,
}: {
  children: React.ReactNode;
  onClick: () => void;
  withChevron?: boolean;
  accent?: boolean;
  /**
   * When provided the item becomes a CHECKABLE menu item and exposes that state
   * to assistive tech. `role="menuitemcheckbox"` + `aria-checked` is the
   * ARIA-correct way to express a toggled menu row (the equivalent of the
   * `aria-pressed` the spec asks for); `aria-pressed` is not a permitted
   * attribute on `role="menuitem"` (jsx-a11y/role-supports-aria-props).
   */
  pressed?: boolean;
}) {
  const checkable = pressed !== undefined;
  return (
    <button
      type="button"
      role={checkable ? "menuitemcheckbox" : "menuitem"}
      aria-checked={pressed}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      className={cn(
        "flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm",
        "transition-colors duration-[var(--dur-micro)] hover:bg-surface-2",
        "focus-visible:bg-surface-2 focus-visible:outline-none",
        { "text-danger": accent === true, "text-text": accent !== true },
        { "text-accent": pressed === true }
      )}
    >
      <span className="truncate">{children}</span>
      {withChevron && (
        // §1.1: SVG chevron instead of the "▸" text glyph (consistent metrics
        // across OSes, colorable via currentColor).
        <svg
          viewBox="0 0 24 24"
          className="h-3.5 w-3.5 shrink-0 text-muted"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden
        >
          <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
        </svg>
      )}
    </button>
  );
}

function PlaylistSubmenu({
  playlists,
  creating,
  newName,
  setNewName,
  onBack,
  onNew,
  onPick,
  onCreate,
  onTrackName,
}: {
  playlists: Playlist[];
  creating: boolean;
  newName: string;
  setNewName: (v: string) => void;
  onBack: () => void;
  onNew: () => void;
  onPick: (pl: Playlist) => void;
  onCreate: () => void;
  onTrackName: string;
}) {
  return (
    <div>
      <button
        type="button"
        role="menuitem"
        onClick={(e) => {
          e.stopPropagation();
          onBack();
        }}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-muted transition-colors duration-[var(--dur-micro)] hover:bg-surface-2 hover:text-text"
      >
        <span aria-hidden>
          <svg
            viewBox="0 0 24 24"
            className="h-3.5 w-3.5"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m14.5 5.5-6.5 6.5 6.5 6.5" />
          </svg>
        </span>{" "}
        Add to playlist
      </button>
      <div className="mx-3 border-t border-border" />

      {!creating && (
        <button
          type="button"
          role="menuitem"
          onClick={(e) => {
            e.stopPropagation();
            onNew();
          }}
          className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-accent-2 transition-colors duration-[var(--dur-micro)] hover:bg-surface-2"
        >
          <span aria-hidden className="font-semibold leading-none">+</span> New playlist…
        </button>
      )}

      {creating && (
        <form
          className="px-3 py-2"
          onSubmit={(e) => {
            e.preventDefault();
            onCreate();
          }}
        >
          <label htmlFor="ctx-new-playlist" className="block text-xs text-muted">
            New playlist for “{onTrackName}”
          </label>
          <input
            id="ctx-new-playlist"
            type="text"
            autoFocus
            autoComplete="off"
            placeholder="Playlist name"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            // NOTE: no Escape handler here on purpose. The menu's focus trap
            // listens on document in the CAPTURE phase (useFocusTrap.ts:196), so
            // it sees Escape before anything in the bubble path and closes the
            // menu regardless. A local stopPropagation() here would be dead code
            // that falsely implies Escape is handled at the input.
            className="mt-1.5 h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm text-text placeholder:text-muted focus:border-accent focus:outline-none"
          />
          <div className="mt-2 flex justify-end gap-1.5">
            {/* Both buttons use min-h-11 (44px) so they meet the WCAG touch
                target minimum. They previously sat at ~26px (py-1 + text-xs),
                which is hard to hit on a phone with the on-screen keyboard up.
                The compact look is preserved via item alignment rather than by
                shrinking the hit area. */}
            <button
              type="button"
              onClick={() => setNewName("")}
              className="inline-flex min-h-11 items-center rounded-md px-3 text-xs text-muted transition-colors hover:text-text"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!newName.trim()}
              className="inline-flex min-h-11 items-center rounded-md bg-accent px-3 text-xs font-semibold text-white transition-opacity disabled:opacity-40"
            >
              Create
            </button>
          </div>
        </form>
      )}

      {playlists.length === 0 && !creating ? (
        <p className="px-3 py-2 text-xs text-muted">No playlists yet.</p>
      ) : (
        <div className="max-h-56 overflow-y-auto">
          {playlists.map((pl) => (
            <button
              key={pl.id}
              type="button"
              role="menuitem"
              onClick={(e) => {
                e.stopPropagation();
                onPick(pl);
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm text-text transition-colors duration-[var(--dur-micro)] hover:bg-surface-2"
            >
              {/* §1.1: music-note glyph as a small SVG (was the "♪" text
                  glyph, whose metrics varied per OS). */}
              <svg
                viewBox="0 0 24 24"
                className="h-4 w-4 shrink-0 text-muted"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.8}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M9 18.5V6.2l9-2v12.3" />
                <circle cx="6.5" cy="18.5" r="2.5" />
                <circle cx="15.5" cy="16.5" r="2.5" />
              </svg>
              <span className="truncate">{pl.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
