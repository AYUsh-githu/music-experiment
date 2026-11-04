# Sonic — Frontend Upgrade Plan (frontend.md)

> **Goal:** Make Sonic feel like a polished, modern music app (Spotify / Apple Music / Tidal tier) — richer hover effects, ambient artwork-driven theming, real iconography, expressive players, smoother transitions.
>
> **Hard constraint:** The streaming backend (`src/app/api/*`, `src/lib/server/*`, scripts) is **out of scope**. Every change here is presentational/client-side only. Playback flow (`PlayerContext` → `/api/stream` → `/api/proxy` → `<audio>`) must keep working with zero behavioral changes — we only touch what the UI *looks like*, never how audio is fetched or played.
>
> **Baseline (already good):** The app already has a Wave 2 motion system — tokens in `src/lib/client/motion.ts` + CSS vars (`.sonic-shimmer/.sonic-sheen/.sonic-marquee/.sonic-ambient-shift`, eq bars), framer-motion shared-element morph (`sonic-np-art`), staggered TrackList, ambient FullPlayer backdrop, marquee, drag-to-dismiss queue drawer, like-burst heart. This plan builds on it, it does not rewrite it.

---

## Guiding principles (research conclusions)

1. **Compositor-only motion.** Every new animation animates `transform`/`opacity` (allowed exception: the progress-bar hover grow, a single tiny element). All gated behind `prefers-reduced-motion`.
2. **Zero new dependencies.** Everything planned is pure CSS + tiny vanilla JS (canvas color extraction, IntersectionObserver, View Transitions API feature-guard). framer-motion is already installed and stays the only motion lib.
3. **Timing scale (existing tokens):** hover/press 120ms · overlays 200ms · surfaces 320ms · pages 400ms. Entrances ease-out, exits ~25% faster, overshoot beziers only for feedback pops. Interactive feedback always under 400ms total.
4. **Contrast discipline:** purple = interactive elements only; text stays `--text`/`--muted` (WCAG AA on dark).
5. **Press feedback everywhere:** `active:scale-[0.97]` on every tappable artwork/button.

---

# Phase 1 — Foundation: Design System Polish & Iconography
*(The "unfinished" feeling fixer — touches every screen at once.)*

### 1.1 Icon system (lib-only, no dependency)
- Create `src/components/ui/icons.tsx` — a small set of hand-authored inline SVG icons (24px, `currentColor`, `stroke-width 1.8`): Home, Search, Library, Settings, Play, Pause, SkipBack, SkipForward, Shuffle, Repeat, RepeatOne, Queue, Lyrics, Heart, Volume, VolumeMute, Expand, Collapse, More(dots), ChevronL/R, X, Clock.
- Replace **all emoji glyphs**: nav (Shell), transport (MiniPlayer, FullPlayer), menu triggers (`⋯`), EmptyState icons. Why: emoji metrics vary per OS, look unfinished; SVGs are consistent and colorable.
- Keep the existing hand-written SVGs in MiniPlayer by migrating them into `icons.tsx` (single source).

### 1.2 Brand & Topbar identity
- **Brand block:** replace flat "S" square with a gradient (`accent→accent-2`, `bg-clip-text`) wordmark "Sonic" + a small waveform logo mark (5 bars of the Equalizer component, animated only while playing).
- **Topbar:** keep glass-on-scroll; the settings entry stays as-is positionally, just gets a real icon. *(No search-shortcut chip — the existing `useGlobalKeyboardShortcuts` hook has no Cmd/Ctrl+K binding and wiring one would require editing a.playback-adjacent shared hook; out of scope for zero-risk work.)*

### 1.3 Typography & gradient utilities
- Add utility classes in `globals.css`: `.text-gradient-accent` (accent→accent-2, background-clip:text) for display headings; refined scale (Home h1 → text-3xl/4xl, section h2 → consistent text-lg tracking).
- Gradient **hairline borders** via the double-background (`padding-box`/`border-box`) technique for featured surfaces.
- **Browser-chrome polish (critic-found, one-liners in globals.css):** `:root { color-scheme: dark; }` (native inputs/scrollbars/autofill stop rendering as light-theme widgets) and `::selection { background: color-mix(in srgb, var(--accent) 40%, transparent); }` (copying lyrics no longer flashes OS blue).

### 1.4 Mobile device polish (pre-requisite — critic-found)
- `layout.tsx`: add `export const viewport: Viewport = { viewportFit: 'cover', themeColor: '#0b0b10' }` + `apple-touch-icon`/icons in Metadata. Without `viewport-fit=cover`, the app's existing `env(safe-area-inset-bottom)` rules in Shell are **dead code** on iPhones — this makes them real and colors the mobile browser bar.
- MiniPlayer `bottom-[52px]` → `bottom-[calc(52px+env(safe-area-inset-bottom))]`; audit FullPlayer / QueueDrawer fixed overlays for the same `pb-[env(safe-area-inset-bottom)]` so controls never sit in the home-indicator gesture zone.

### 1.5 Micro-interaction sweep (whole-app consistency pass)
- Standardize `active:scale-[0.97]` + 120ms press on **all** buttons/tiles.
- TrackRow hover upgrade: replace flat `bg-surface-2` with `rgba(255,255,255,0.06)` wash; index number **cross-fades to a play glyph** on hover (Spotify's most-copied pattern; EqualizerBars still take precedence when playing); duration swaps to a `⋯` menu trigger (keep existing context menu behavior, restyled with the new icon).
- TrackCardRow shelves: add **edge-fade masks** + peek of next card to the horizontal scroller; `scroll-snap-type: x proximity`, snap on children; hidden arrow buttons (desktop, hover-capable) that scroll by one card width.
- Staggered entrance (reuse `STAGGER`, max 8) for TrackCard rows and Library grid — currently only TrackList staggers.
- Modal gains the subtle scale 0.98→1 + fade it deliberately skipped (60/120ms — imperceptible for reduced-motion users, still gated).
- **Phase 1 acceptance extra:** the Phase 1.4 "aria-expanded fix" from the old journal is already done in code — verify only, don't re-implement.

### 1.6 Skeleton & empty polish
- Skeletons already shimmer — align all new surfaces (Phase 2–4) to the same `Skeleton` primitives.
- EmptyState: swap emoji for the new SVG icons, oversized + `opacity-40` ghost style (YouTube Music pattern), one CTA always.
- **Artwork arrival fade (critic-found):** in `Artwork.tsx`, tiny opacity 0→1 fade on `onLoad` (+contextual blur-up, optional) — artwork currently pops in with a hard cut.

**Phase 1 files:** `globals.css`, `layout.tsx` (viewport/icons metadata only), `src/components/ui/icons.tsx` (new), `Shell.tsx`, `Topbar.tsx`, `MiniPlayer.tsx`, `FullPlayer.tsx`, `TrackRow.tsx`, `TrackCard.tsx`, `TrackCardRow.tsx`, `EmptyState.tsx`, `Modal.tsx`, `TrackList.tsx`, `TrackContextMenu.tsx`, `Artwork.tsx`, settings/search/library pages (icon swaps only).

**Acceptance:** zero emoji left in UI; `npm run build` + `lint` pass; all playback paths unchanged (verified with the Phase-gate curl checklist: `/api/search`, `/api/stream`, `/api/proxy` 206).

---

# Phase 2 — Artwork-Driven Theming & Hero Surfaces
*(The "wow" phase — the app starts matching every screen to its music.)*

### 2.1 Artwork color extraction hook (0 dependencies)
- New hook `src/lib/client/useArtworkColor.ts`: in a `useEffect`, draw the artwork `<img>` into an offscreen canvas downscaled to **24×24px**, scan for the **most-saturated** color (not most-common — Spotify lesson: dominant color is usually a white bg), then blend 25% toward brand purple for cohesion.
- Requirements: `crossOrigin="anonymous"` must be set on the img *before* `src` to avoid canvas tainting — ⚠️ **verify per-CDN first** (load each artwork host — mzstatic, ytimg thumbs, any fallback — with `crossOrigin=anonymous` in the browser devtools and confirm no image fails; if any CDN rejects, do NOT set it globally on the shared `Artwork.tsx` element; instead compute extraction from a hidden dedicated `<img>` created per-track, leaving all visible artwork elements untouched). `try/catch` with a fallback to `--accent`; cache per artwork URL in a small Map; compute once per track change (cheap).
- Expose the color via a new lightweight context `ArtworkTheme.tsx` `{ color, setColor(track) }` — **additive context, does not touch PlayerContext** (preserving the backend/playback contract).

### 2.2 ambient theming applications
- **FullPlayer:** existing `AmbientBackdrop` gains the extracted color as a tinted radial-gradient overlay (top-left / bottom-right dual gradient over ~`#0a0a0f`, opacity ~0.25) — richer than plain blur; slow crossfade on track change already exists.
- **Ambient tint** on the MiniPlayer progress fill and the like-heart fill (in `FavoriteButton.tsx`) use the artwork color (Apple Music behavior).
- **Home hero gallery (2.3)** and playlist-card backgrounds (Phase 4) get the same treatment.

### 2.3 Home page hero
- Rebuild `JumpBackIn` → a **hero gallery** keeping its IndexedDB logic 100% intact (rename not required by logic — only presentation): large (280–320px) featured card with (a) slow **Ken-Burns** artwork `scale 1.0→1.06` over 20s (`transform`-only, reduced-motion off), (b) gradient scrim bottom-left + tag pill ("Recently played"), (c) play FAB scales in, (d) card background tinted from its artwork color at 18% opacity via the new hook.
- If history is empty, fall back to a **trending** hero item (uses data already fetched — no new API); if both fail, existing empty state.
- Section headers get "Show all" affordances where a route exists (Search) and h2 consistent styling.

### 2.4 Global ambient page wash (subtle)
- One fixed, `aria-hidden` page-level radial gradient that reflects the *now-playing* color at ~6–8% opacity (desktop only, disabled on any scroll-critical device or reduced-motion). Never repaints scroll (fixed layer).

**Phase 2 files:** `src/lib/client/useArtworkColor.ts` (new), `src/lib/client/ArtworkTheme.tsx` (new), `AmbientBackdrop.tsx`, `FullPlayer.tsx`, `MiniPlayer.tsx` (tint fills only), `FavoriteButton.tsx` (heart tint), `JumpBackIn.tsx`, `HomeView.tsx`, `TrackCard.tsx`, `AppProviders.tsx` (mount context — additive).

**Acceptance:** extracted color changes on track change without flicker; contrast on all text over tints verified (AA); Ken-Burns/sheen disabled under reduced-motion; playback untouched.

---

# Phase 3 — Player Expression & Advanced Motion
*(The "flagship" phase — the identity of the app is its player.)*

### 3.1 Transport & progress upgrades
- **Play/pause icon morph**: animated bars↔triangle transition (Apple Music signature) — SVG with CSS transitions, not emoji.
- ProgressBar: hover grow to thicker rail via `scaleY` **on a wrapper** (compositor-only) + knob fade/scale in + **hover time bubble** already exists → restyle with artwork-tinted fill.
- VolumeSlider: knob enlarges 120ms on hover/drag; track tints accent→artwork color.
- Shuffle/repeat buttons: state change animates color + small scale pop (200ms); RepeatOne glyph swaps in with cross-fade (exists on desktop — port to mobile menu styling).

### 3.2 Now-playing surface (FullPlayer)
- Artwork: **3D tilt on hover** (`rotateY 6deg, scale 1.02`, 300ms `cubic-bezier(.2,.8,.2,1)`, transform-only, hover-capable devices only) + artwork-color drop shadow `0 8px 24px color/40%`.
- Lyrics (logic untouched): artwork-colored radial gradient behind LyricsPanel; Apple-Music-style depth hints where already supported (active scale exists; add soft blur/opacity depth on non-active lines only if CSS-cheap).
- While-playing artwork tint pulse: a 2px accent→artwork-color ring breathing at low opacity (no rotation/vinyl — read as gimmicky).

### 3.3 View Transitions API route morphs (feature-guarded)
- Tiny helper `src/lib/client/viewTransition.ts`: wraps route changes in `document.startViewTransition` when supported (Chrome 111+/Safari 18+/FF 141+), fallback to existing `template.tsx` framer fade (unchanged). 200ms crossfade + 8px slide via `::view-transition-new(root)` styles.
- The mini↔full player artwork morph stays framer `layoutId` (already better than a VT for per-element control) — do not double-implement.

### 3.4 Shine & delight finishes
- Card sheen (exists) extended to QueueDrawer rows on current track.
- `Toaster`/`QueueDrawer` exit animations already exist — no change.
- One-time celebratory pop on **playlist created** / **first favorite** (scale-bounce on the button, not confetti — minimalist).

**Phase 3 files:** `ProgressBar.tsx`, `VolumeSlider.tsx`, `MiniPlayer.tsx`, `FullPlayer.tsx`, `LyricsPanel.tsx` (style-layer only), `TrackCard.tsx`, `viewTransition.ts` (new), `AppProviders.tsx`, `globals.css`.

**Acceptance:** all new motion disabled under `prefers-reduced-motion`; 60fps (no layout-property animations except documented progress grow); morphs don't conflict with existing `layoutId` system; playback untouched.

---

# Phase 4 — Library, Search & Final Cohesion
*(The "complete the journey" phase.)*

### 4.1 Library grid & playlist covers
- Library cards → responsive `auto-fill minmax(160px,1fr)` grid; card lift (−4px), artwork shadow grows, hover FAB scales in (Phase 1 primitives reused).
- **Playlist cover mosaics**: 2×2 collage of the first 4 tracks' artworks (client-side, from artworks already in IndexedDB — no API), fallback to two-color gradient cover (Deezer pattern) when a playlist has <2 artworks.

### 4.2 Search page
- Hero-style large search field (48–56px, accent border on focus, glass pill), **recent-search chips** row — persisted in **`localStorage`** (the IndexedDB `db.ts` is frozen/migration-forbidden per code comments; do NOT bump DB_VERSION), filter chips (All / Songs) purely visual over already-received results.
- Results list keeps existing stagger + Play-queue wiring untouched.

### 4.3 Settings page
- Row-styled settings list with icons, subtle dividers, hover wash (Phase 1 primitive); section grouping headings. No new settings — presentation only.

### 4.4 Queue drawer polish
- Drag-reorder affordance: elevation shadow while dragging a row (framer drag already wired for dismiss — extend carefully, no reorder-backend change: move/down buttons remain the accessible path).
- Current-track row artwork gets EqualizerBars overlay + artwork-tinted edge (sheen from 3.4).

### 4.5 Offline affordance (critic-found)
- Tiny `useOnlineStatus` hook → pushes a single "You're offline" / "Back online" toast via the existing Toaster store on `navigator.onLine` flips. No API or playback logic touched — right now a wifi hiccup just silently kills the progress bar.

### 4.6 Final cohesion pass
- Audit ~30 template-string className sites → `cn()` where touched by phases.
- Cross-page motion-token consistency check (no forking `DUR/EASE/SPRING`).
- Full `npm run build` + `npm run lint` + manual click-through (Home→Search→play→queue→lyrics→favorite→nav) as regression.
- Final **backend-untouched verification**: `git diff src/app/api src/lib/server` must be empty.

**Phase 4 files:** `library/page.tsx`, `search/page.tsx`, `settings/page.tsx`, TrackCard/TrackCardRow/TrackList refinements, QueueDrawer.tsx, JumpBackIn leftovers (HomeView), `src/lib/client/useOnlineStatus.ts` (new), `cn` cleanups.

---

## Execution order & safety rails

| Phase | Theme | Risk | Rollback unit |
|-------|-------|------|--------------|
| 1 | Icons + design-system polish | Low (visual only) | One commit |
| 2 | Artwork-color theming + hero | Low-Med (new hook, canvas) | One commit |
| 3 | Player expression + View Transitions | Low-Med (feature-guarded APIs) | One commit |
| 4 | Library/search/settings + cohesion | Low (grid/visual) | One commit |

**Non-negotiables across all phases:**
1. `src/app/api/**`, `src/lib/server/**`, `scripts/**` — untouched (final `git diff` check).
2. `PlayerContext.tsx` / `playerBridge.ts` — no logic changes; only additive context providers may consume them.
3. Every phase ends with `npm run build` + `npm run lint` clean, plus the manual playback smoke (play → seek → next → favorite).
4. `prefers-reduced-motion` gates every new animation; `useCanHover` gates every hover-only affordance on touch devices.
5. All animations = transform/opacity (documented tiny exceptions at most).

**Recommended start:** Phase 1 — biggest immediate visual lift for the least risk, and it unblocks clean iconography that Phases 2–4 reuse.
