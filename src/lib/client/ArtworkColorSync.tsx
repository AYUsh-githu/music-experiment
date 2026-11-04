"use client";

/**
 * ArtworkColorSync — single producer of the artwork theme color.
 *
 * Mounted ONCE (in AppProviders, inside PlayerProvider so it can read the
 * player context). Subscribes to the now-playing track, runs the §2.1
 * extraction on the artwork, and publishes the color into ArtworkTheme
 * context. Every consumer (FullPlayer tint, page ambience, hero card) reads
 * through useArtworkThemeColor() — no per-consumer canvases, no duplicate
 * extraction.
 *
 * WHY a producer component rather than a hook the consumers run: extraction
 * must happen exactly once per track change regardless of which surfaces are
 * open. A consumer-side hook would re-run when FullPlayer mounts/unmounts and
 * race the crossfade.
 */

import { useEffect } from "react";
import { useCallback } from "react";
import { usePlayer } from "@/lib/client/PlayerContext";
import { useSetArtworkColor } from "./ArtworkTheme";
import { useArtworkColor } from "./useArtworkColor";
import { setPlayState } from "./playState";

export default function ArtworkColorSync(): null {
  const { currentTrack } = usePlayer();
  const setArtworkColor = useSetArtworkColor();

  // Stable callback: the hook keeps the latest via ref, so this callback
  // identity only changes when the setter does (never, in practice).
  const onColor = useCallback(
    (color: string | null) => {
      setArtworkColor(color);
    },
    [setArtworkColor],
  );

  // Reset on unmount so a later provider remount starts clean.
  useEffect(() => {
    return () => setArtworkColor(null);
  }, [setArtworkColor]);

  useArtworkColor(
    currentTrack?.artwork,
    onColor,
    { disabled: !currentTrack },
  );

  return null;
}

/**
 * PlayStateSync — mirrors the provider's `playing` flag into the tiny external
 * store the Shell (which sits ABOVE the provider) subscribes to. Renders
 * nothing; playback logic is untouched — this only republishes a boolean.
 */
export function PlayStateSync(): null {
  const { playing } = usePlayer();

  useEffect(() => {
    setPlayState(playing);
  }, [playing]);

  // Reset on unmount so a remounted tree does not inherit a stale "playing".
  useEffect(() => () => setPlayState(false), []);

  return null;
}
