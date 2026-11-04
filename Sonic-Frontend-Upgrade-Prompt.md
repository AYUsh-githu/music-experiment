# SONIC — Frontend Interaction, Motion & Polish Upgrade

**Master prompt for the coding agent (Claude Code) · Sonic web app · Refined edition — 2026-10-28**

Work in the SONIC repository root (the project containing `src/app`, `src/lib`, `src/components`). `cd` there before anything else and treat every path in this document as relative to that root.

SONIC is a free, keyless, web-based music streaming app. Current stack: **Next.js 16+ (App Router) · TypeScript strict · Tailwind CSS · HTML5 `<audio>` · React Context + useReducer (`PlayerContext`) · IndexedDB (`idb`) + localStorage · framer-motion (the only approved animation dependency)**. The backend was recently rebuilt and verified by the owner: search, streaming, proxy, lyrics, and related tracks all work, backed by the failover chain **YtDlpSource → YouTubeSource (youtubei.js) → SaavnSource → iTunes preview**, with every byte of audio flowing through `/api/proxy` (Range → 206, host allowlist, streamed not buffered).

**Your job:** upgrade the frontend so it feels like a premium music product — a fast first impression, skeleton loading that never shifts layout, polished micro-interactions, purposeful motion around playback, full touch + keyboard parity — **without disturbing a single byte of backend behavior.**

You are a senior frontend engineer and motion designer. You work in small, verified phases, you never regress audio continuity, performance, accessibility, or the project's own rules, and you journal your work in `progress.md` as you go.

Anything marked **(verify)** is an inference you must confirm in the repo or in a real browser before acting on it. Do not improvise around a **(verify)** — resolve it first, and record how you resolved it.

---

## 1. Mission & success metrics

Upgrade SONIC's frontend along five axes, in this priority order:

1. **Correctness first** — every control works on touch, mouse, and keyboard; nothing occludes content; no native `prompt/confirm/alert` dialogs; playback is never interrupted by UI work.
2. **Perceived quality** — skeleton loading that matches real layouts, active-track feedback, drag-to-seek, volume, queue transitions.
3. **Sonic Motion Language** — one consistent, restrained motion system (tokens, springs, transform/opacity only) applied everywhere.
4. **Cohesion** — toasts, dialogs, menus, empty states, and settings all speak the same design language.
5. **Hardening** — accessibility, hydration safety, and measured performance.

Success is **measured, not felt**:

| Metric | Target |
|---|---|
| Backend freeze proof | `git diff --name-only` ∩ frozen paths (§5) = **empty** at every gate |
| Playback continuity battery (§9 / WS9, 12 scenarios) | **12/12** pass; exactly **one** `<audio>` element in the DOM at all times |
| CLS per route (`/`, `/search`, `/library`, `/settings`, playlist pages), API delayed 1500 ms, at 375×667 **and** 1280×800 | ≤ **0.02** |
| Skeleton → content layout-box delta | ≤ **2 px** |
| Entrance animation total (last item delay + duration) | ≤ **400 ms** |
| Route transition + player open/close + drawer/diaper transitions | ≤ **320 ms** |
| Frame health with player active | no animation-attributable long task > 50 ms; scroll ≥ 55 fps average |
| Console | **0** new errors/warnings; **0** hydration mismatches |
| Native dialogs remaining in `src/` (`window.prompt`, `window.confirm`, `window.alert`, bare `alert(`) | **0** (grep-verified) |
| Touch parity at 375 px | every control reachable **without hover** |
| Reduced motion | every new animated surface has a documented static fallback |
| Build gates | `npm run build` clean, lint clean, strict `tsc` 0 errors |

**Capture baselines before changing anything:** build output sizes per route, CLS per route (Lighthouse or Playwright if present in the repo (verify)), battery pass/fail, and screenshots. Save to `scripts/frontend/out/baseline.json` and add `scripts/frontend/out/` to `.gitignore`. Every claim in your final report must be a **before → after** comparison against this baseline.

---

## 2. Read first (mandatory, in this order)

1. **`plan.md`** (repo root) — §0 agent instructions (progress.md protocol), §2 fixed tech stack, §3 API response shapes, §5 engineering rules, §7 folder blueprint. The API shapes there are the contract you consume, never the contract you change.
2. **`progress.md`** — append-only journal. Read the SOURCE-STATUS table and prior audit reports. It may contain stale claims; re-verify anything you rely on. You will append one entry per workstream (§11).
3. **Backend contract files (READ-ONLY — to learn what you consume):** `src/app/api/search/route.ts`, `src/app/api/stream/route.ts`, `src/app/api/proxy/route.ts`, `src/app/api/lyrics/route.ts`, `src/app/api/related/route.ts` (verify exact route names), and `src/lib/server/sources/resolver.ts`.
4. **Client core you will extend or freeze:** `src/lib/client/PlayerContext.tsx` (audio element, reducer, state/actions), `src/lib/client/db.ts`, `src/lib/client/lyricsParser.ts`, `src/lib/client/toast.ts`, `src/hooks/useGlobalKeyboardShortcuts.ts`.
5. **Every component you will touch:** all of `src/components/player/**`, `src/components/track/**`, `src/components/layout/**`, `src/components/ui/**`, plus `src/app/layout.tsx`, `src/app/**/page.tsx`, and any existing `template.tsx` / `loading.tsx` (verify).
6. **Config:** `package.json`, `next.config.ts`, Tailwind config (verify: v3 `tailwind.config.*` or v4 CSS-first config in `globals.css`), `globals.css`, `tsconfig.json`.
7. Inventory the real route list by globbing `src/app/**/page.tsx` and note it in your plan file — this document names routes by their audited names (`/library`, `/settings`); adjust if the repo differs.

Never print, log, or commit the contents of `.env*`.

---

## 3. Verified project snapshot

Architecture facts that matter for motion and correctness:

- **`PlayerContext` is the playback core.** The `<audio>` element, the stream-URL fetch pipeline (`/api/stream` → TTL cache → `/api/proxy` playback), the queue reducer, repeat/shuffle state, and `currentTime` (~4 Hz via `timeupdate`) all live here. The provider sits at the root layout level (verify exact mount point in `src/app/layout.tsx`), so route navigation never remounts the audio element. **Only leaf components may subscribe to `currentTime`.** Never introduce a second audio element.
- **Next.js App Router:** the scroll container is `window` unless `Shell.tsx` defines an inner overflow container (verify before any scroll-linked effect). Route changes unmount page components; anything that must persist lives in layouts/providers, not pages.
- **SSR/hydration is real.** localStorage/IndexedDB/`window` access must be client-gated. The Toaster currently risks hydration mismatch (finding F14). Use `useSyncExternalStore` with a server snapshot, or a mounted gate, for anything store-driven.
- **framer-motion is the only animation dependency** (approved for this upgrade). If `package.json` lacks it, `npm i framer-motion` is the single permitted dependency change — record the installed version. No other new runtime dependency for any reason (§4).
- **Streaming invariants (context, do not touch):** the browser never receives raw googlevideo/saavncdn URLs — everything is proxied through `/api/proxy`. Never bypass the proxy, never prefetch audio, never construct upstream URLs client-side. Stream URLs expire (TTL ≤ 4 h) — the existing re-fetch logic in `PlayerContext` handles this; UI must not assume a URL outlives the cache.
- **Lyrics** come from `/api/lyrics` (LRCLIB behind it): plain + synced LRC. Parsing lives client-side in `src/lib/client/lyricsParser.ts`, which currently returns lines **unsorted** (finding F15). Fix there, not in the API.
- **Existing UI inventory (verify as you read):** `Shell.tsx` (app frame + persistent player surfaces), player components (FullPlayer, MiniPlayer, ProgressBar, QueueDrawer, AmbientBackdrop if present, lyrics view inside FullPlayer), track components (TrackRow, TrackCard), `Toaster.tsx` + `toast.ts`, keyboard-shortcuts hook, pages: home, search, library (playlists + favorites + history), settings.
- **`next.config.ts`** may contain a turbopack root fix from the backend rebuild — do not revert or "clean up" it (F17).

---

## 4. Hard constraints (violations are rejected)

| Area | Rule |
|---|---|
| **Backend freeze** | Zero edits to everything in §5. Verified by `git diff` at every gate. If a feature seems to need a backend change, **stop and write it up as a §12 proposal** instead of touching it. |
| Dependencies | No new runtime dependency except `framer-motion` (see §3). Banned: three/@react-three/*, gsap, lenis, lottie, rive, tsparticles, react-spring, auto-animate, Radix, shadcn adds, any UI kit. Dev-only tooling additions need a §12 proposal. |
| Animated properties | **transform, opacity, clip-path, color/background-color, and filter only on small/static layers.** Never animate width/height/top/left/bottom/margin/padding/gap/inset/grid-template-*. Progress fill = `scaleX` with `transform-origin: left`. Never animate `box-shadow`; stack a pre-blurred element and animate its opacity. framer-motion `layout`/`layoutId` is allowed (transform-based) but only in small, bounded subtrees (artwork + title block — not whole pages). |
| Durations | **120 / 200 / 320 / 400 ms** for state changes — these are the only values, via the motion tokens (WS0). Ambient loops (marquee, equalizer, ken-burns) may run longer. No loop on text a user is trying to read (marquee only for overflowing titles). |
| Springs | Spring presets only from the token file: stiffness 300–400, damping 28–34. No ad-hoc spring constants in components. Springs are for gesture-driven motion (drag release, sheet dismiss, morph); timed eases for everything else. |
| Reduced motion | Mount `<MotionConfig reducedMotion="user">` (WS0). Keep/strengthen any global reduced-motion CSS. Every new animated component defines its static fallback and documents it in the report. |
| TypeScript | Full strict mode. No `any`, no non-null `!` on API/store data, `import type` where applicable, no enums, prefer `satisfies`. Never pass an explicit `undefined` to an optional prop. |
| Styling | Tailwind utility classes with theme tokens; `cn()` (or the repo's existing conditional-class helper (verify)) for every conditional className — never template-string className assembly. No magic hex/pixel literals in components. One accent color per viewport. Glass/blur stack ≤ 3 layers in any line of sight. |
| Audio is frozen | The `<audio>` element, its creation, its `crossOrigin`/`preload` attributes, and the stream-fetch pipeline inside `PlayerContext` are untouchable. Read-only subscriptions and **additive** context selectors/actions are allowed under the §5 shared-care rules. Never create a second `<audio>` element. Never prefetch audio. |
| Data & media | No `fetch` outside the repo's existing service/client layer pattern. Artwork: reuse the existing size trick if present (`100x100bb.jpg` → larger (verify)); player/mini-player artwork must not use `loading="lazy"` (it pops in during playback); grid/list artwork may stay lazy. |
| Accessibility | Real `<button>`/`<a>` with accessible names; `focus-visible:ring-2`; `aria-pressed` for toggles, `aria-current` for active nav/track; polite live regions for async feedback; touch targets ≥ 44 px for all new controls; every dialog: `role="dialog"`, `aria-modal`, focus trap, Escape, focus return. |
| Hover-only affordances | Gate with `(hover: hover) and (pointer: fine)` via the `useCanHover` hook (WS0) or CSS media queries. A control must never be discoverable **only** by hover (fixes F3). |
| Hydration | Any client store snapshot consumed during render must have a server snapshot (`useSyncExternalStore`) or a mounted gate. Zero hydration-mismatch warnings allowed. |
| Search highlighting | If you highlight matches, split strings and wrap in `<mark>`-style spans — never `dangerouslySetInnerHTML`. |
| Visual identity | **No redesign.** No new fonts, no layout rewrites, no color-system overhaul. This is an interaction + motion + polish upgrade inside the existing design language. |
| Journal | Append to `progress.md` after every workstream (§11). Never rewrite old entries. |

---

## 5. Cardinal rule — Backend freeze (proof required)

The backend is **working**. Nothing in this upgrade justifies touching it. The following paths must produce an **empty diff** at every gate:

| Frozen path | Why |
|---|---|
| `src/lib/server/**` (sources, resolver, spawn, throttle, text, cache) | Source failover chain: YtDlpSource → YouTubeSource → SaavnSource → iTunes. Working. Do not touch. |
| `src/app/api/**` (search, stream, proxy, lyrics, related, …) | API routes + response shapes are the contract. The client adapts to them, never the reverse. |
| `scripts/**` — **existing files only** | Backend verification scripts (e.g. `verify-sources.ts`). New frontend scripts go under `scripts/frontend/` (new directory, allowed). |
| `bin/**` (yt-dlp binary) and the sibling `jiosaavn-api/**` clone | Infrastructure. Untouchable. |
| `next.config.ts`, `tsconfig.json` | Only exception: adding `scripts/frontend/out/` to `.gitignore` and (if truly required by framer-motion) nothing else. Any config change must be justified in the report. |
| `package.json` dependencies | `framer-motion` install is the only allowed dependency mutation. |

**Shared-care files** (not frozen, but restricted):

| File | Rule |
|---|---|
| `src/lib/client/PlayerContext.tsx` | **Additive-only, single owner** (the Player agent in §10). You may add new selectors/actions (e.g. `setVolume`, `seek`) and read state. You may NOT modify: the `<audio>` element lifecycle, the stream-URL fetch/caching logic, next/prev/repeat/shuffle core logic, or the reducer's existing action semantics. Every additive change listed in the report. |
| `src/lib/client/motion.ts` (new, WS0) | Created once in WS0, then **read-only for everyone**. Missing token? Stop and report — do not fork tokens. |
| `src/components/lyrics/LyricsPanel.tsx` (new) | Interface frozen in WS0 (§8). The Player agent leaves a mount point; the Lyrics agent implements; the orchestrator wires in Phase C (§10). |

**Gate command** (run and record output at every gate):

```bash
git diff --name-only -- src/lib/server src/app/api scripts next.config.ts tsconfig.json bin
# expected: (empty). If non-empty: stop, revert, re-run gate.
git diff --name-only -- package.json
# expected: package.json only if framer-motion was just added (once).
```

---

## 6. Verified findings (fix all — F1–F17)

Facts from the owner's 13-defect audit plus carryover items from the backend-era audit that live in client files. File/line references are from the audit; **re-verify line numbers before editing** (the repo may have drifted).

### HIGH — user-facing breakage

**F1 — Repeat & Shuffle controls missing from the UI.**
`PlayerContext` already models repeat (off → all → one) and shuffle, but the player chrome exposes no toggles. *Fix:* add Shuffle and Repeat buttons to the full-player control row (and to the desktop mini bar if space allows). Icons from `lucide-react` (`Shuffle`, `Repeat`, `Repeat1`). Active state: accent color + a small dot indicator; `aria-pressed={active}`; label `aria-label="Shuffle on/off"` etc. Repeat cycles off → all → one with icon morph between `Repeat`/`Repeat1` (cross-fade, 120 ms). Wire to the existing context state/actions (verify names); if an action is missing, the Player agent may add it additively (§5). Persist nothing new unless `PlayerContext` already does.

**F2 — Keyboard shortcut guard blocks arrow-key seek.**
`src/hooks/useGlobalKeyboardShortcuts.ts` (~L81–87) bails out when `target.closest("button")` matches — so arrow-key seek dies whenever any button has focus (which is almost always). *Fix:* replace the guard with a typing-context guard:
```ts
const t = e.target as HTMLElement | null;
if (t?.closest('input, textarea, select, [contenteditable="true"]')) return;
```
Remove the `button` clause entirely. For handled keys, `e.preventDefault()` after handling. Verify the full map still works with a button focused: Space/K play-pause, ←/→ seek ±5 s, J/L ±10 s (verify existing mapping — keep it, only fix the guard; add `M` mute and `S`/`R` shuffle/repeat **only if** F1/F10 introduce them, and document the final map in the report).

**F3 — Hover-only play affordance invisible on touch.**
`TrackRow.tsx` (~L69–70, and TrackCard (verify)) uses `opacity-0 group-hover:opacity-100` for the play button — on touch devices it never appears and the row offers no alternative. *Fix:* the whole row remains tappable to play, **and** the play affordance becomes always-visible when hover is unavailable:
```css
/* utilities in globals.css */
.touch-visible { opacity: 1; }
@media (hover: hover) and (pointer: fine) { .touch-visible { opacity: 0; } }
/* then in JSX: className="... group-hover:opacity-100 touch-visible" */
```
Also add the persistent `⋯` menu button (F8) with the same treatment. Verify at 375×667 with touch emulation: play + menu both visible without hover.

### MEDIUM — product quality

**F4 — Persistent player occludes page content.**
`Shell.tsx` (~L80) reserves only `md:pb-6` while the desktop player bar is taller. *Fix:* reserve real space: `pb-24` (mobile mini-player ≈ 64 px + safe area) and `md:pb-32`/`md:pb-36` (desktop bar height — measure it). Add `env(safe-area-inset-bottom)` padding for iOS. Verify with: FullPlayer closed, QueueDrawer open (drawer must not cover the last row's action area (verify choice)), and on the shortest viewport.

**F5 — No seek scrubbing.**
`ProgressBar.tsx` (~L50–56) renders a static bar. *Fix recipe (prescriptive):*
- Keep the native accessibility story: use a styled `input[type=range]` as the interaction layer (keyboard + ARIA slider semantics for free), visually integrated with the custom fill; **or** a `role="slider"` div with full keyboard handling. Choose one, document it.
- Fill = `scaleX(progress)`, `transform-origin: left` — never width. Thumb grows on hover/focus/drag (`scale` 1 → 1.25).
- Drag: `onPointerDown` → `setPointerCapture`, set `dragging.current = true`, compute `ratio = clamp((clientX - rect.left) / rect.width)`. While dragging, render a **local preview** (fill + floating time bubble) and **ignore `timeupdate`-driven values**; `onPointerUp` → commit via the context's seek (add additive `seek(t)` action if missing (verify)), release capture, hide bubble.
- Floating time bubble: absolutely positioned, `transform: translateX(-50%)` at the ratio position, formatted `m:ss`, visible only during hover/drag, opacity 120 ms. Bubble is a leaf component — it may subscribe to the drag-local value, not context.
- Keyboard: ←/→ ±5 s, Home/End 0/duration, `aria-valuetext="m:ss of m:ss"`.
- Buffered indicator if `audio.buffered` is exposed (verify — if it requires touching frozen code, skip and note it).
- **Do not** live-scrub `audio.currentTime` during drag; commit on release (keeps stream URL churn at zero).

**F6 — Native `window.prompt` / `window.confirm` in library.**
`library/page.tsx` (~L209, L217, L227) uses native dialogs for create/rename playlist and delete confirmations. *Fix:* build the app dialog primitives once (WS0/WS5): `Modal` (portal, `role="dialog"`, `aria-modal`, focus trap, Escape, focus return, spring-in scale 0.96 → 1, overlay fade 200 ms) + `ConfirmDialog` (title/body/confirm/cancel, destructive variant) + `PromptDialog` (text input, validates non-empty, Enter submits). Replace all three call sites. Delete flows use the destructive variant with the item name in the body.

**F7 — No active-track indicator anywhere.**
Playing track is indistinguishable in rows/cards. *Fix (WS0 provides `EqualizerBars`):* on the playing row (match by `track.id` against context's current track): replace the index number with animated equalizer bars while `isPlaying` (static bars when paused), tint the title with accent, and set `aria-current="true"` on the row. On TrackCard: a playing ring (accent, 2 px, subtle scale on cover) + bars overlay on the cover bottom. All transform/opacity.

**F8 — No Add-to-Playlist on browsing surfaces.**
Only some detail surface offers it (verify). *Fix (new `TrackMenu` in WS0, wired in WS2):* a `⋯` icon button on TrackRow/TrackCard (44 px target) opening a popover menu: **Play next** → **Add to queue** → **Add to playlist ▸** (submenu or dialog listing playlists from `db.ts` + "New playlist…" inline) → **Favorite toggle** → any available "Go to artist/album" if the data shape has the ids (verify; drop the item if not). Interactions: click for button; `contextmenu` on the row opens the same menu at the cursor (desktop); long-press 500 ms on touch (timer, cancel on > 8 px move). Menu: Escape/outside-click/route-change dismiss, focus trap, arrow-key navigation between items, framer scale/opacity 120 ms, position flips near viewport edges.

### LOW — polish gaps

**F9 — Stale history shelf.**
The history shelf (home/library (verify location)) shows stale entries after new plays. *Fix:* revalidate on `document` visibility change + on `focus` + after each local play event (listen to what `PlayerContext` exposes — a lightweight event bus or context value change; do not modify core logic). Dedupe by `track.id`, keep most recent, cap at the existing shelf length. Show relative recency ("2 h ago") if timestamps exist (verify `db.ts` schema; do not migrate IndexedDB schema in this upgrade — if a migration would be needed, degrade gracefully and note it).

**F10 — No volume / mute control.**
*Fix:* horizontal `VolumeSlider` in the FullPlayer control row (desktop-first; on mobile rely on hardware volume — hide the slider under `sm:` but keep the mute toggle visible). Mute button with `Volume2`/`VolumeX` cross-fade 120 ms. Slider reuses the ProgressBar drag pattern (pointer capture, `scaleX` fill, commit on release is fine for volume — it is cheap). Persists to `localStorage` key `sonic.volume` (client-gated, SSR-safe). Requires additive `setVolume(v: number)` / `toggleMute()` on the context (Player agent, §5). `M` shortcut.

**F11 — Lyrics auto-scroll fights the user.**
`FullPlayer.tsx` (~L168–178) force-scrolls on every active-line change, so manual scrolling snaps back. *Fix (implemented inside `LyricsPanel`, WS0 contract):* maintain a `follow` state. Any user gesture on the lyrics container (`wheel`, `touchmove`, `pointerdown`) → `follow = false` immediately + show a small floating "Resume sync ⤓" pill (opacity/slide 120 ms, bottom center of the lyrics area). While `follow`: on active-line change, `scrollIntoView({ block: "center", behavior: reducedMotion ? "auto" : "smooth" })`, gated by tab visibility. Pill click → `follow = true` + immediate centering. Active line: accent color + `scale(1.02)` (transform only) + 200 ms ease; adjacent lines dimmed via opacity steps. Click a line → seek to its time (uses the additive `seek`). Requires **sorted** lines — fix F15 first.

**F12 — QueueDrawer has no enter/exit transition.**
`QueueDrawer.tsx` (~L53–66) pops in/out. *Fix:* `AnimatePresence` around the drawer: desktop slides in from the right (`x: 100% → 0`, 320 ms ease-out) — if it is a right-side panel (verify); mobile = bottom sheet (`y: 100% → 0`, spring soft) with **drag-to-dismiss** (`drag="y"`, `dragConstraints { top: 0 }`, dismiss when `offsetY > 120` or release velocity > 500). Backdrop: opacity 200 ms, click closes. Escape closes, focus returns to the invoker, `aria-modal` + focus trap, background scroll locked (on the actual scroll container (verify)). Current track gets equalizer bars (WS0) + `aria-current`. Active/played rows visually dimmed. Keep all existing queue actions working; reorder-drag is a §12 proposal, not now.

**F13 — Settings feedback bypasses the toast system.**
`settings/page.tsx` (~L50) uses `alert()`. *Fix:* replace with the upgraded toast system (WS5) + inline validation where appropriate (e.g. cache-clear confirmation becomes a `ConfirmDialog`; success becomes a toast).

### Carryover from the backend-era audit — client-side, verify current state first

**F14 — Toaster hydration mismatch.** `Toaster.tsx` / `toast.ts` render store-driven content during SSR. *Fix:* subscribe with `useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)` where `getServerSnapshot` returns `[]`, or gate the toast list behind a `mounted` flag. Keep the existing dedupe + 5-toast cap intact.

**F15 — Unsorted LRC lines.** `lyricsParser.ts` (~L33–59) parses synced lyrics without sorting. *Fix:* after parsing, sort lines ascending by time; drop lines with negative/NaN times; stable-order ties by original index. Unit-check with a deliberately shuffled fixture; the active-line computation (`activeIndexFor`) and F11 both depend on this.

**F16 — `toggleFavorite` write race.** `db.ts` (~L162–172, `dbPromise` L88–97): concurrent toggles can interleave read-modify-write. *Fix:* serialize writes through a promise queue:
```ts
let tail: Promise<unknown> = Promise.resolve();
function enqueueWrite<T>(fn: () => Promise<T>): Promise<T> {
  const p = tail.then(fn, fn);
  tail = p.catch(() => {});
  return p;
}
```
Wrap `toggleFavorite` (and any other read-modify-write helpers) in `enqueueWrite`. No schema changes. Optimistic UI update stays.

**F17 — Config inventory (not a bug).** Confirm before any config-adjacent work: Tailwind major version + config location, `next.config.ts` turbopack root fix (leave as-is), framer-motion presence/version, whether Playwright exists for WS9 verification. Record answers in the plan file.

---

## 7. Effects triage (adopt / adapt / defer / reject)

The governing question for any effect: **does it help a listener find, play, or understand music faster — or does it merely decorate?** For anything not listed here, adopt only if all five are true: (1) serves that question; (2) fits §4 budgets; (3) uses transform/opacity/clip-path; (4) has a reduced-motion fallback; (5) works on a 400 px touch screen. Otherwise → §12 proposal.

**ADOPT (in budget, this upgrade):**

| Category | Adopt |
|---|---|
| Loading | Shimmer skeleton system matched to real layouts; skeleton → content cross-fade with capped stagger; inline button loading; deferred loading (no flash on fast loads) |
| Feedback | Equalizer bars on the active track; like burst on favorite (6–8 particles, transform/opacity, ≤ 400 ms, one guarded `navigator.vibrate(8)` on mobile); press-scale on rows/cards/buttons; track-change title/artist slide-up swap |
| Player | MiniPlayer → FullPlayer artwork morph via `layoutId`; ambient blurred-artwork backdrop (static blurred layer + opacity cross-fade on track change); drag-to-seek with floating time bubble; volume slider; queue bottom-sheet drag-to-dismiss |
| Text | Shared `MarqueeText` for overflowing titles (player + rows on hover); `aria-hidden` duplicated track |
| Lists | `whileInView` once reveals with capped stagger; appended pages never replay earlier items; active-row treatment (F7) |
| Navigation | Active nav pill with `layoutId`; topbar glass-on-scroll with hysteresis; page transition via `template.tsx` (fade + 8 px rise, 200 ms) |
| Overlays | Spring-in dialogs; toast enter/exit + swipe-to-dismiss; popover menu (TrackMenu) |
| Forms | Search: focus glow (static layer), clear-button reveal, inline "searching" state, empty state |
| Misc | Back-to-top on long lists; empty/error/offline states; focus-visible rings everywhere |

**ADAPT (native alternative instead of a banned tool):**

| Wanted | Use instead |
|---|---|
| GSAP/Lenis scroll effects | Native scrolling; CSS only; framer `whileInView` |
| Aurora/shader/mesh backgrounds (WebGL) | One static blurred radial-gradient layer behind the player (existing accent), opacity-animated only |
| Page-transition libraries | `template.tsx` + framer (View Transitions API → §12 proposal) |
| Audio-reactive visualizer (Web Audio) | Equalizer bars driven by playback state only (Web Audio is blocked by the frozen `<audio crossOrigin>` — §12) |
| Drag-reorder libraries | Keep existing up/down queue controls; Reorder → §12 proposal |

**DEFER → §12 proposals (write up, do not build):** View Transitions API (Next.js experimental `viewTransition`), dominant-color accent from artwork (canvas + same-origin proxy images — feasible later), command palette (⌘K), `LazyMotion` + `m` bundle-size optimization, queue drag-reorder with keyboard-safe buttons, mini-player swipe left/right for next/prev, vinyl-style rotating platter, page-level ambient wash outside the player, ken-burns hero, self-hosted display font.

**REJECT (with reason):** custom cursor/trail/blend followers (accessibility, touch-first app); scroll-jacking/pinned storytelling/smooth-scroll libraries (fights native feel); WebGL/three/particles (banned, heavy); UI sound effects (competes with the music); confetti/XP/gamification; typewriter text; page-flip/cube/glitch/pixelate transitions (gimmicks over the 320 ms standard); neumorphism/brutalist reskins (off-language); fake progress bars; masonry reflow (grids are uniform); pull-to-refresh (fights native overscroll); auto-playing carousels on Home (adds motion noise, no discovery value — keep current Home sections).

---

## 8. WS0 — Foundation (do first; everything depends on it)

**Goal:** create the token layer, primitives, and shared components every other workstream consumes. After WS0, these files are **read-only** for all subagents (§5).

**Deliver:**

1. **`src/lib/client/motion.ts`** — the single source of motion truth:
```ts
export const DUR = { instant: 0.12, quick: 0.2, standard: 0.32, deliberate: 0.4 } as const;
export const EASE = { out: [0.22, 1, 0.36, 1], inOut: [0.4, 0, 0.2, 1] } as const;
export const SPRING = {
  snappy:  { type: "spring", stiffness: 400, damping: 34 },
  soft:    { type: "spring", stiffness: 300, damping: 30 },
  release: { type: "spring", stiffness: 380, damping: 28 },
} as const;
export const STAGGER = { step: 0.025, maxItems: 8 } as const;
// Entrance total rule: last delay (7 × 0.025 = 0.175) + duration (0.2) = 0.375 s ≤ 0.4 s ✓
export const revealTransition = (i = 0) => ({
  duration: DUR.quick, ease: EASE.out,
  delay: Math.min(i, STAGGER.maxItems - 1) * STAGGER.step,
});
```
   Replace magic durations/numbers in files you touch with these tokens (only in files you already own in that workstream — do not churn untouched files).

2. **`MotionConfig reducedMotion="user"`** wrapping the component tree — mount it inside the existing client Providers component that wraps `PlayerContext` (verify the providers file; if none, `src/app/layout.tsx` is the fallback spot, in a small client wrapper). Verify it coexists with any global reduced-motion CSS.

3. **Tailwind/globals.css additions** (respect the version found in F17): keyframes `shimmer` (translateX −100% → 100%, 1.4 s linear infinite — a **dedicated** keyframe; do not reuse marquee), `eq-bounce` (scaleY 0.25 → 1, `transform-origin: bottom`), and utilities `.touch-visible` (F3 recipe). Keep/extend the global reduced-motion override so keyframe animations collapse to static states.

4. **Hooks in `src/hooks/`** (typed, SSR-safe, cleaned up on unmount):
   - `useCanHover()` — `matchMedia("(hover: hover) and (pointer: fine)")`, listener-backed.
   - `usePageVisible()` — document visibility, listener-backed.
   - `useMounted()` — hydration gate.
   - `useDeferredLoading(loading, { delay: 120, minDisplay: 350 })` — true only if loading persists ≥ 120 ms, and stays true ≥ 350 ms once shown (prevents both flash-on-fast-loads and blink-on-cached-loads).

5. **Shared components:**
   - `src/components/ui/EqualizerBars.tsx` — 3–4 bars, `eq-bounce` with varied durations/delays, `.eq-paused` variant (bars frozen at scaleY(0.3)) when `!isPlaying`, reduced-motion → static bars. Props: `playing: boolean; bars?: number; className?: string`.
   - `src/components/ui/MarqueeText.tsx` — measures overflow with `ResizeObserver` (threshold +4 px); when overflowing and hovered/focused/active: duplicated content (`aria-hidden` copy) with `translateX` loop, duration proportional to width (clamp 6–14 s), pauses on hover/focus-off and under reduced motion (falls back to ellipsis). Used later in player titles and rows.
   - **Skeleton primitive + variants** in the repo's existing skeleton location (verify; else `src/components/ui/Skeleton.tsx`): shimmer sweep (dedicated keyframe, optional per-column phase offset), `aria-hidden`, theme-aware base color. Variants must be **measured against the real DOM**, not eyeballed: `TrackRowSkeleton` (h-14), `TrackCardSkeleton` (padding, border, square cover, title/artist lines, meta row), `LyricsSkeleton`, `QueueSkeleton`, `HistoryShelfSkeleton`, `SettingsSectionSkeleton`. Delete ad-hoc `animate-pulse` blocks you encounter **in files you own**; others in WS6.
   - **Dialog primitives** (`Modal`, `ConfirmDialog`, `PromptDialog`) in `src/components/ui/` — recipe per F6. These are the only dialogs allowed anywhere in the app after WS5.
   - **`src/components/ui/TrackMenu.tsx`** — the popover menu per F8, exported with a stable props API (`track`, `onAfterAction?`), so WS2 only wires it in.
   - **`src/components/lyrics/LyricsPanel.tsx`** — create the **frozen contract** as a stub:
```ts
export interface LyricsPanelProps {
  trackId: string;
  lines: LyricLine[];        // sorted synced lines from lyricsParser (F15)
  plainLyrics: string | null;
  currentTime: number;       // ~4 Hz, leaf-subscribed
  isPlaying: boolean;
  onSeek: (t: number) => void;
}
```
     Stub renders a placeholder; the Lyrics agent implements in WS4; the orchestrator wires it into FullPlayer in Phase C (§10).

6. **Baseline capture** (§1) → `scripts/frontend/out/baseline.json`.

**Accept:** build + lint green; freeze diff empty; `MotionConfig` verified (toggle OS reduced motion → framer animations collapse); tokens file compiles under strict mode; no visual change to the app yet; baseline committed to `scripts/frontend/out/` (not git — ignored, kept locally).

---

## 9. Workstreams (WS1–WS9)

Recommended order: **WS0 → WS1 → WS2 → WS3 → WS4 → WS5 → WS6 → WS7 → WS8 → WS9**. Every workstream ends with the freeze check + the build gate + the portion of the playback battery that touches its surfaces.

### WS1 — Playback controls & input (F1, F2, F5, F10)
Deliver: shuffle + repeat toggles with morphing icons and `aria-pressed`; keyboard guard replacement + final shortcut map; full scrubbing ProgressBar (pointer capture, preview, floating bubble, commit-on-release, keyboard slider, `scaleX` fill, growing thumb); `VolumeSlider` + mute with persistence and `M` shortcut. All additive `PlayerContext` actions go through the Player agent (§5/§10).
**Accept:** seek by drag at 375 px and 1280 px; bubble tracks the pointer; no `timeupdate` jitter while dragging; audio never re-fetches a stream URL during scrub; keyboard-only user can complete: play/pause, seek ±5 s, volume, mute, shuffle, repeat. Battery scenarios 8–10 pass.

### WS2 — Active state, touch parity & browse surfaces (F3, F7, F8, F9)
Deliver: `.touch-visible` play + persistent `⋯` on TrackRow/TrackCard under `(hover: none)`; whole-row tap plays (verify current click semantics and keep them); equalizer bars + accent title + `aria-current` on the playing row/card; `TrackMenu` wired on all browsing surfaces (rows, cards, queue rows get a reduced menu: remove + play-next); long-press + `contextmenu` open it; history shelf revalidation (F9); like burst on favorite (with the one guarded `navigator.vibrate(8)` mobile tap); press-scale feedback (scale 0.98, 120 ms).
**Accept:** at 375×667 touch emulation every action reachable without hover; `contextmenu` suppressed default menu only where the custom menu opens (right-click elsewhere untouched); battery scenario 11 passes; no layout shift when bars replace the index number (reserve the slot).

### WS3 — Player shell experience (F4, F12 + morph + ambient)
Deliver: Shell padding fix (F4); `AnimatePresence` QueueDrawer with mobile bottom-sheet drag-to-dismiss and desktop slide (F12); **MiniPlayer → FullPlayer artwork morph**: `layoutId="sonic-np-art"` on both artwork surfaces (same track id), FullPlayer mounts with backdrop fade first then the artwork morph (`SPRING.soft`), closes in reverse; keep the morph subtree bounded (artwork + title block only); **ambient backdrop**: behind FullPlayer, a static pre-blurred artwork layer (`filter: blur(60px)`, `scale(1.1)`, opacity ≤ 0.25 dark theme / ≤ 0.12 light), cross-faded on track change by stacking two layers and animating their opacity (200/320 ms) — never re-blurring a moving element; scroll lock while FullPlayer/QueueDrawer open (on the real scroll container (verify)); `MarqueeText` on player + mini titles; track-change title/artist slide-up swap (120 ms in / 120 ms out).
**Accept:** battery scenarios 1–3 pass (open/close player, drawer drag-dismiss, navigation with audio running); `<audio>` element count stays 1 throughout (canary); no CLS when opening FullPlayer; reduced-motion → instant open/close, no morph.

### WS4 — Lyrics experience (F11, F15)
Deliver: `lyricsParser.ts` sort fix (F15) with a shuffled-fixture sanity check; full `LyricsPanel` implementation per the frozen contract: sorted synced lines, active line accent + scale, follow-mode auto-scroll with user-override + "Resume sync" pill, click-line-to-seek, plain-lyrics fallback layout (readable measure, centered column, no fake sync), empty state ("No lyrics found"), loading `LyricsSkeleton`.
**Accept:** user can scroll freely during playback with zero snap-backs; pill resumes sync; line click seeks within ±0.5 s of the line time; works with synced-only, plain-only, and no-lyrics responses from `/api/lyrics`; reduced-motion → `behavior: "auto"` scrolls; battery scenario 7 passes.

### WS5 — Toasts, dialogs & settings (F6, F13, F14, F16)
Deliver: hydration-safe Toaster via `useSyncExternalStore`/mounted gate (keep dedupe + 5-cap); `AnimatePresence` toast enter/exit (enter: y 16 → 0 + fade, spring snappy; exit: fade + x 24; `layout` stacking); auto-dismiss progress rule (`scaleX` countdown, pauses on hover/focus); swipe-to-dismiss on mobile (`drag="x"`, threshold 80 px, `touch-action: pan-y`); tone icon pop; keep `aria-live="polite"`; replace all `window.prompt/confirm/alert` call sites with `ConfirmDialog`/`PromptDialog`/toasts (F6 library, F13 settings); `db.ts` write queue (F16).
**Accept:** grep `window.prompt|window.confirm|window.alert|(^|\s)alert\(` over `src/` = 0 hits; zero hydration warnings in console on first load of every route; rapid double-click favorite on a row then reloading shows correct persisted state (race gone); battery scenarios 5–6 pass.

### WS6 — Home, skeletons & loading states (defers nothing; completes the loading story)
Deliver: wire `useDeferredLoading` + skeleton variants on home, search, library (playlists, favorites, history), playlist detail, settings; route-level `loading.tsx` files reusing the same primitives (verify which routes are dynamic); skeleton → content cross-fade (`DUR.quick`) with capped stagger; per-section independent loading on multi-section pages (one section's failure must not blank the page — surface per-section retry); empty states (favorites empty, search no-results, offline) as a simple `EmptyState` component (icon + line + action — fancy illustration is a §12 proposal); back-to-top on long lists; search polish: debounce, inline "searching" state, clear-button reveal, match highlight via string splitting.
**Accept:** with API delayed 1500 ms, CLS ≤ 0.02 per route at both viewports; cached/fast loads show no skeleton flash (deferred loading); screenshots of every skeleton vs its real page saved to `scripts/frontend/out/`.

### WS7 — Navigation, page transitions & topbar
Deliver: `template.tsx` (or per-route wrappers if `template.tsx` remounts something load-bearing (verify first)) — fade + 8 px rise, 200 ms, disabled under reduced motion; active nav pill with `layoutId` + `aria-current` in the sidebar/bottom nav; topbar transparent at scrollTop 0 → glass after ~8 px with hysteresis (opacity-animated background layer; never toggle `backdrop-filter`); `document.title` per route via App Router `metadata` (verify current state); scroll behavior on route change verified (App Router restores on back/forward by default (verify) — only add handling if actually broken).
**Accept:** battery scenario 3 passes; transitions ≤ 320 ms; no remount of any player surface on navigation; `<audio>` count canary stays 1.

### WS8 — Accessibility & performance hardening
Deliver: full keyboard pass (every new control tabbable in DOM order; dialogs/menus trap + return focus; lyrics and queue operable); live region announcing track changes ("Now playing: Title — Artist", polite); focus-visible rings on everything; contrast ≥ 4.5:1 for dim text on glass (bump `white/60` → `/70` where needed); touch targets ≥ 44 px audit; motion hygiene audit: every infinite CSS animation gated by visibility (`animation-play-state: paused` via an IntersectionObserver class toggle or `usePageVisible`), no `will-change` left parked in the DOM, no blur filters on moving elements, zero subscriptions to `currentTime` outside leaf components; re-measure all §1 metrics and fix or justify misses.
**Accept:** reduced-motion matrix documented per animated surface (component → behavior under reduce); OS-level forced-colors check doesn't hide focus rings; §1 table green (or documented misses).

### WS9 — Verification, battery & journal
Deliver:
- `scripts/frontend/battery.md` — the manual runbook for the **Playback continuity battery** (12 scenarios, §1): (1) FullPlayer open/close, (2) QueueDrawer open/drag-dismiss, (3) navigate 3 routes + back, (4) theme toggle ×2, (5) dialog open/cancel/confirm, (6) toast swipe-dismiss, (7) lyrics follow off/on + line-seek, (8) scrub drag/release, (9) volume/mute, (10) shuffle/repeat toggles, (11) TrackMenu play-next + add-to-playlist, (12) skeleton→content on throttled fresh route. Pass = audio never unexpectedly stops, `<audio>` count = 1 at all times, no console errors. If Playwright exists in the repo (F17), script scenarios 1–4, 8–10 instead; keep the rest manual.
- `scripts/frontend/verify-frontend.mjs` (if Playwright present): CLS-per-route assertion (≤ 0.02, API delayed 1500 ms via route interception, both viewports), hydration-error assertion (console filter), native-dialog assertion.
- `progress.md` entries per §11; final report per §13.
**Accept:** battery 12/12 recorded; all scripts runnable from the documented prerequisites; `scripts/frontend/out/` populated with before/after artifacts.

---

## 10. Parallel subagent protocol (fan-out)

If the harness supports subagents, execute in three phases. If not, run everything serially in the listed order — the plan works both ways.

### Phase A — serial (orchestrator): WS0
Foundation must land first: tokens, hooks, primitives, contracts. Gate. Only then fan out.

### Phase B — parallel fan-out, four agents with exclusive file ownership

Give every subagent: this document's path, its workstream section(s), its ownership list, and the two global rules (§4 hard constraints, §5 freeze). Ownership is **exclusive** — no agent touches another's files. Shared files (`motion.ts`, primitives, globals.css additions) are **read-only** after Phase A; if an agent needs a new token/primitive, it reports back instead of editing.

| Agent | Workstreams | Exclusive files |
|---|---|---|
| **P — Player** | WS1 + WS3 | `src/components/player/**` (incl. FullPlayer, MiniPlayer, ProgressBar, QueueDrawer, new VolumeSlider, AmbientBackdrop), `src/hooks/useGlobalKeyboardShortcuts.ts`, new `src/components/player/VolumeSlider.tsx`; **additive-only** edits to `PlayerContext.tsx` (single owner) |
| **B — Browse** | WS2 | `src/components/track/**`, `src/components/browse/**` (if exists), home/library list sections they live in, wiring of `TrackMenu` (component itself is Phase A), history shelf logic |
| **L — Lyrics + System** | WS4 + WS5 | `src/lib/client/lyricsParser.ts`, `src/lib/client/db.ts`, `src/lib/client/toast.ts`, `src/components/ui/Toaster.tsx`, `src/components/lyrics/LyricsPanel.tsx` (full implementation of the Phase A stub), `settings/page.tsx`, new dialog call-site edits in `library/page.tsx` **limited to the three prompt/confirm replacements** |
| **S — Surfaces** | WS6 + WS7 | `src/app/**/page.tsx`, new `template.tsx` / `loading.tsx`, `src/components/layout/**` (Shell, nav, topbar), skeleton wiring on pages, `EmptyState`, search polish |

**Conflict rules:**
- `library/page.tsx` is touched by L (dialog swaps) and B (history shelf, TrackMenu wiring) — B goes first in the file's list sections, L only swaps the three dialog call sites; both run `git diff` on that file before committing and coordinate via the orchestrator. If your harness cannot guarantee this, serialize L after B.
- `FullPlayer.tsx` is P's — including its lyrics mount point. P leaves the documented mount (`<LyricsPanel … />` consuming the frozen contract); L never edits FullPlayer. Orchestrator performs the final visual check after both land.
- Every agent: work on its own branch or commit sequence, run the §11 gates before reporting, and hand back a per-workstream summary (shipped / deferred / files touched / gates).

### Phase C — serial (orchestrator): integration + hardening
Wire `LyricsPanel` into FullPlayer's mount (final), reconcile cross-file drift, run WS8 + WS9, full battery, re-measure §1 metrics, write the report.

---

## 11. Execution protocol

1. **Plan first.** Write `scripts/frontend/motion-upgrade-plan.md` before any code: files to touch per workstream, order, risks, and the resolution of every **(verify)** item (each with evidence — file path, line, or browser observation).
2. **One workstream per commit** (or per subagent branch). Imperative subject ≤ 72 chars; body explains why. Include the Task ID (e.g. `FE-WS3`).
3. **Gate after every workstream** — all must pass before the next starts:
   ```bash
   git diff --name-only -- src/lib/server src/app/api scripts next.config.ts tsconfig.json bin   # must be empty
   npm run build            # zero errors
   npm run lint             # zero errors (verify the repo's lint script name)
   npx tsc --noEmit         # strict, zero errors
   ```
   Plus: the new surfaces' battery scenarios, hydration check (console clean on first paint of each touched route), and `grep -rn "window.prompt\|window.confirm\|window.alert" src/` = 0 hits from WS5 onward.
4. **Stop conditions:** if a gate regresses and you cannot fix it in two attempts, revert that workstream's commit and report it. If a task needs a frozen-file change, a banned dependency, or a rule exception — **stop** and write it into §12 proposals instead of improvising.
5. **Judgment calls:** decide yourself when the answer is reversible and within the rules; list the decision in the report. Ask the owner only for product questions you genuinely cannot resolve (currently: none — everything here is specified).
6. **Never weaken or delete an existing check** to make a gate pass.
7. **`progress.md` journal** — append after every workstream, using plan.md §0's entry format: Task ID, date, files changed, gate results, deviations, and notes for the next session. Append-only; never rewrite history.

---

## 12. Amendment proposals (write up, do not implement)

For each: benefit, measured cost (bundle kB / CPU where measurable), risk, and your recommendation.

1. **View Transitions API** for route transitions + shared-element cover morph (Next.js experimental `viewTransition` flag) — would supersede the `template.tsx` fade; evaluate remount semantics against the persistent player.
2. **Web Audio analyser visualizer** — blocked today: requires `crossOrigin` on the `<audio>` element and correct CORS on every proxied Range/206 response (backend frozen). Default recommendation: no; equalizer bars cover the need.
3. **Dominant-color dynamic accent** from artwork via canvas — feasible because covers are proxied same-origin (verify); touches the one-accent design rule. Prototype behind a flag first.
4. **Command palette (⌘K)** with track/playlist actions + shortcut cheat sheet.
5. **`LazyMotion` + `m` components** migration — measure the gzip saving against the churn of converting `motion.*` call sites.
6. **Queue drag-reorder** via framer `Reorder`, keeping up/down buttons for keyboard users.
7. **Mini-player swipe gestures** (left/right = next/prev, up = open FullPlayer) — buttons remain.
8. **Fancy empty-state illustrations** (animated SVG path-draw ≤ 600 ms) beyond the simple `EmptyState`.
9. **Page-level ambient wash** outside the player (opacity ≤ 0.12) + ken-burns hero.
10. **Self-hosted display font** (woff2, `font-display: swap`, size-adjusted fallback) if the current font stack causes CLS.

---

## 13. Definition of done & report format

**Done means:** all F1–F17 fixed or explicitly dispositioned; every §1 target met or a measured, documented reason it wasn't; all §11 gates green; freeze proof recorded at every gate; no banned dependency added; zero native dialogs; zero hydration warnings; every new animated surface has a reduced-motion fallback; battery 12/12.

**Final report (concise, factual):**

1. Per workstream: shipped / deferred / reverted, with commit hashes.
2. Before → after table: build sizes, CLS per route (both viewports), battery results, console cleanliness, native-dialog count, entrance-timing audit.
3. How each **(verify)** item was resolved (evidence included).
4. The §12 proposals with recommendations.
5. Reduced-motion matrix (surface → fallback).
6. Additive `PlayerContext` changes (exact list — these get extra owner scrutiny).
7. Paths of screenshots and outputs in `scripts/frontend/out/`.
8. Known risks and anything intentionally not built, with reasons.
