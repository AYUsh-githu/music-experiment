"use client";

/**
 * Global keyboard shortcuts for the player (phase 5, task 4; Wave 2 map).
 *
 * WHY this lives in a top-level component (not inside each page): the shortcuts
 * should work identically everywhere in the app — search, library, settings,
 * and over the FullPlayer modal / queue drawer. Because it reads the shared
 * player via usePlayer(), it must be mounted inside PlayerProvider; the main
 * agent wires that up in AppProviders.
 *
 * Final shortcut map:
 *   Space / K      -> play / pause
 *   ArrowLeft / J  -> seek back 10s
 *   ArrowRight / L -> seek forward 10s
 *   ArrowUp        -> volume +5%
 *   ArrowDown      -> volume -5%
 *   M              -> mute / unmute
 *   S              -> shuffle on / off
 *   R              -> cycle repeat (off -> all -> one)
 *
 * IMPORTANT: we must never steal keys while the user is typing in a form
 * control (input / textarea / select / contenteditable), so we bail early when
 * the event target is one of those. We also ignore held-key repeat (e.repeat)
 * so a finger on Space doesn't spaz playback.
 *
 * DOUBLE-FIRE FIXES:
 *   - Space is the native activation key of whatever button or link has focus.
 *     The F2 compromise stood down only for the player's own play/pause button,
 *     which meant Space on a favorite / mute / nav button activated the button
 *     AND toggled playback. A global Space toggle therefore now stands down for
 *     ANY focused button/link (their native key wins) while K stays the
 *     unconditional alias for the global action.
 *   - The seek and volume sliders are role="slider" divs, not <input>s, so they
 *     are invisible to isEditableTarget(); they used to survive only because
 *     their stopPropagation() ran first. They now opt out for every key via
 *     OWNED_KEYS_ATTR, which does not depend on propagation order.
 *   - A key something upstream already handled (a menu consuming Escape/arrows)
 *     is skipped via defaultPrevented.
 */

import { useEffect, useRef } from "react";
import { usePlayer } from "./PlayerContext";

/** Seconds jumped per arrow / J / L press. */
const SEEK_STEP = 10;
/** Volume delta per ArrowUp/ArrowDown press, as a fraction of full (0.05 = 5%). */
const VOLUME_STEP = 0.05;

/**
 * Attribute a control sets when it fully owns keyboard input while focused
 * (seek bar, volume slider). The global handler then stands down for ALL keys.
 */
export const OWNED_KEYS_ATTR = "data-sonic-keys";

/**
 * Containers that manage their own keyboard interaction (roving focus, Escape
 * to close). One pre-built selector string rather than an inline literal, so the
 * attribute quoting stays readable.
 */
const MENU_ROLES = '[role="dialog"], [role="menu"]';

/**
 * Returns true when the key event originated from a place whose keys belong to
 * the user: a text control, a contenteditable region, or a dialog/menu that
 * runs its own roving focus.
 */
function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target.isContentEditable) return true;
  // An open dialog/menu owns arrow keys and Escape; playback keys would fight
  // its focus management.
  return target.closest(MENU_ROLES) !== null;
}

/** True when the focused control declared that it owns its keyboard input. */
function ownsKeyboard(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest(`[${OWNED_KEYS_ATTR}]`) !== null;
}

/**
 * Marker attribute for the player's play/pause control.
 *
 * WHY an attribute and not a label/tag match: the transport button's accessible
 * name flips between "Play" and "Pause" per track and per state, so matching on
 * text is fragile and would break the moment the copy changes. A data attribute
 * is a stable, explicit contract between this module and the control.
 */
export const PLAY_PAUSE_ATTR = "data-sonic-playpause";

/**
 * True when a Space keydown must be left to the focused element.
 *
 * WHY any button/link and not just the play button: Space activates EVERY
 * native button and link. Handling it globally as well activated both the
 * focused control and the transport — the same double-fire the original guard
 * was written for, just with a different victim.
 */
function spaceBelongsToTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.closest("button, a[href], [role='button'], summary") !== null;
}

/** Binds window-level keydown handlers to the global player. Renders nothing. */
export function useGlobalKeyboardShortcuts(): void {
  const {
    progress,
    duration,
    volume,
    togglePlay,
    seek,
    setVolume,
    toggleMute,
    toggleShuffle,
    toggleRepeat,
  } = usePlayer();

  // Mirror the fast-changing playback values into refs so the window listener
  // can be bound ONCE. progress/duration update on every audio timeupdate
  // (~4x/sec); putting them in the deps would tear the listener down and
  // re-add it continuously, leaving a momentary window where a keystroke could
  // be missed.
  //
  // WHY an effect (not a render-time write): React forbids mutating a ref during
  // render (react-hooks/refs). Updating it after every render keeps the keydown
  // listener — which only ever fires post-effect — reading the latest value.
  const progressRef = useRef(progress);
  const durationRef = useRef(duration);
  const volumeRef = useRef(volume);
  useEffect(() => {
    progressRef.current = progress;
    durationRef.current = duration;
    volumeRef.current = volume;
  });

  useEffect(() => {
    // Shared forward/backward seek helpers (clamped to [0, duration]).
    const seekBack = () => seek(Math.max(0, progressRef.current - SEEK_STEP));
    const seekForward = () => {
      const upper = durationRef.current > 0 ? durationRef.current : Number.POSITIVE_INFINITY;
      seek(Math.min(progressRef.current + SEEK_STEP, upper));
    };
    const volumeUp = () => setVolume(Math.min(1, volumeRef.current + VOLUME_STEP));
    const volumeDown = () => setVolume(Math.max(0, volumeRef.current - VOLUME_STEP));

    const onKeyDown = (e: KeyboardEvent) => {
      // Never steal keys the user is typing / editing with, or that an open
      // dialog or menu is steering.
      if (isEditableTarget(e.target)) return;
      // A control that owns its keys (seek bar, volume slider) keeps them.
      if (ownsKeyboard(e.target)) return;
      // Something already handled this key (e.g. a menu consuming Escape).
      if (e.defaultPrevented) return;
      // Ignore held-key auto-repeat so one press never fires repeatedly.
      if (e.repeat) return;
      // (2) MODIFIER HIJACK: only act on "bare" presses. If Alt / Ctrl / Meta is
      // held, this is almost certainly an OS, browser, or edge shortcut (Alt+Left
      // = back, Ctrl+Space = language toggle, Meta+combos, etc.), so step aside.
      if (e.altKey || e.ctrlKey || e.metaKey) return;

      // Keyed off e.code so the letters are layout-independent (S/K/J/L/R/M).
      switch (e.code) {
        case "Space": {
          // Space is the native activation key of whatever button/link has
          // focus; handling it here too would double-fire. K is the alias.
          if (spaceBelongsToTarget(e.target)) return;
          // A bare Space scrolls by default — suppress that: it means play/pause.
          e.preventDefault();
          togglePlay();
          break;
        }
        case "KeyK": {
          e.preventDefault();
          togglePlay();
          break;
        }
        case "ArrowLeft":
        case "KeyJ": {
          // Seek backwards 10s.
          e.preventDefault();
          seekBack();
          break;
        }
        case "ArrowRight":
        case "KeyL": {
          // Seek forwards 10s.
          e.preventDefault();
          seekForward();
          break;
        }
        case "ArrowUp": {
          // Volume up 5%, clamped to 1.0. Raising past 0 also unmutes (the
          // reducer's SET_VOLUME handles that).
          e.preventDefault();
          volumeUp();
          break;
        }
        case "ArrowDown": {
          // Volume down 5%, clamped to 0.
          e.preventDefault();
          volumeDown();
          break;
        }
        case "KeyM": {
          e.preventDefault();
          toggleMute();
          break;
        }
        case "KeyS": {
          e.preventDefault();
          toggleShuffle();
          break;
        }
        case "KeyR": {
          // Cycle repeat off -> all -> one.
          e.preventDefault();
          toggleRepeat();
          break;
        }
        default:
          return;
      }
    };

    window.addEventListener("keydown", onKeyDown);
    // Clean up on unmount so a route change or provider teardown never leaks.
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [togglePlay, seek, setVolume, toggleMute, toggleShuffle, toggleRepeat]);
}

/**
 * Mount this inside PlayerProvider (e.g. in AppProviders, next to the player
 * provider). It renders nothing but keeps the player keyboard-operable app-wide,
 * including while the FullPlayer overlay or queue drawer is open.
 */
export function GlobalKeyboardShortcuts(): null {
  useGlobalKeyboardShortcuts();
  return null;
}
