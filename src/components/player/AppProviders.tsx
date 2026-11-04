"use client";

/**
 * Client provider boundary + mini player mount.
 *
 * WHY this wrapper exists: the root layout is a server component, so it cannot
 * reach into React context that lives down the client tree. AppProviders is the
 * single place the layout pulls in: it provides the global player context to
 * `children`, then renders the mini-player bar beneath them so every route gets
 * a persistent now-playing strip sharing one <audio> element.
 */

import { useState, type ReactNode } from "react";
import { MotionConfig } from "framer-motion";
import { PlayerProvider } from "@/lib/client/PlayerContext";
import { GlobalKeyboardShortcuts } from "@/lib/client/useGlobalKeyboardShortcuts";
import { ArtworkThemeProvider } from "@/lib/client/ArtworkTheme";
import ArtworkColorSync, { PlayStateSync } from "@/lib/client/ArtworkColorSync";
import PageAmbience from "@/lib/client/PageAmbience";
import { OfflineAlerter } from "@/hooks/useOnlineStatus";
import MiniPlayer from "./MiniPlayer";
import QueueDrawer from "./QueueDrawer";
import FullPlayer from "./FullPlayer";
import Toaster from "@/components/ui/Toaster";

export default function AppProviders({ children }: { children: ReactNode }) {
  // Whether the queue drawer is open. Owned here so both the MiniPlayer toggle
  // (opens) and the drawer itself (closes) can drive the same piece of state
  // without either component reaching into the other's lifecycle.
  const [drawerOpen, setDrawerOpen] = useState(false);

  return (
    // MotionConfig at the provider root (WS0): makes reduced-motion a single
    // global opt-in for every framer-motion surface, so any OS-level
    // "prefer reduced motion" collapses all spring/entrance animation app-wide
    // even where a surface omits its own MotionConfig. Nested per-surface
    // MotionConfigs inherit this value.
    <MotionConfig reducedMotion="user">
      <ArtworkThemeProvider>
        <PlayerProvider>
          {/* Artwork color extraction producer (Phase 2): pulls the now-playing
              artwork color once per track into ArtworkTheme context. Renders
              nothing; playback machinery is untouched. */}
          <ArtworkColorSync />
          {/* Mirrors `playing` outward to the Shell's tiny external store. The
              Shell wraps this provider, so it cannot call usePlayer() directly. */}
          <PlayStateSync />
          {/* Global page ambience wash (Phase 2 §2.4): fixed decorative layer
              reflecting the now-playing color at ~7% opacity. */}
          <PageAmbience />
          {/* Offline affordance (Phase 4 §4.5): one toast per online/offline
              flip. No fetch/playback logic involved. */}
          <OfflineAlerter />
          {/* Keyboard shortcuts must live INSIDE the provider: it calls usePlayer().
              Renders nothing but keeps Space/←/→ operable app-wide, including while
              the FullPlayer overlay or queue drawer is open. */}
          <GlobalKeyboardShortcuts />
          {children}
          <MiniPlayer onOpenQueue={() => setDrawerOpen(true)} drawerOpen={drawerOpen} />
          <QueueDrawer open={drawerOpen} onClose={() => setDrawerOpen(false)} />
          {/* Full now-playing view. Self-hides when closed, so it is safe to always
              mount alongside the mini-player and queue drawer. */}
          <FullPlayer />
          {/* Global toast notifications (now-playing, stream/error, source-failover).
              Self-contains its own portal, so mounting it here makes toasts available
              app-wide without any per-page wiring. */}
          <Toaster />
        </PlayerProvider>
      </ArtworkThemeProvider>
    </MotionConfig>
  );
}
