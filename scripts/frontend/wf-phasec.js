export const meta = {
  name: 'sonic-phasec-integrate-verify',
  description: 'Phase C: fill two remaining gaps, then adversarially verify shipped work against the spec',
  phases: [
    { title: 'Gaps', detail: 'history recency + queue-row menu' },
    { title: 'Verify', detail: '4 independent read-only verifications' },
  ],
};

const ROOT = 'C:/Users/santo/OneDrive/Desktop/practice';
const PROMPT = ROOT + '/Sonic-Frontend-Upgrade-Prompt.md';

const REPORT = {
  type: 'object',
  properties: {
    shipped: { type: 'array', items: { type: 'string' } },
    filesTouched: { type: 'array', items: { type: 'string' } },
    gates: { type: 'object', properties: { tsc: { type: 'string' }, eslintFiles: { type: 'string' } }, required: ['tsc'] },
    issues: { type: 'array', items: { type: 'string' } },
  },
  required: ['shipped', 'filesTouched', 'gates', 'issues'],
};

const AUDIT = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string' },
          verdict: { type: 'string', enum: ['COMPLIANT', 'DEVIATION', 'VIOLATION', 'UNVERIFIABLE'] },
          evidence: { type: 'string' },
          fix: { type: 'string' },
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['subject', 'verdict', 'evidence', 'severity'],
      },
    },
    specDeviations: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings', 'specDeviations', 'risks'],
};

const COMMON = 'Working dir: ' + ROOT + ' (Windows). Spec: ' + PROMPT + '. Read the spec sections you need. WS0 primitives exist and are READ-ONLY: src/lib/client/motion.ts (DUR/EASE/SPRING/STAGGER/revealTransition), src/hooks/{useMounted,useCanHover,usePageVisible,useDeferredLoading}.ts, src/components/ui/EqualizerBars.tsx, src/components/lyrics/LyricsPanel.tsx (frozen contract). Backend is FROZEN: never edit src/lib/server/**, src/app/api/**, existing scripts/**, bin/**, next.config.ts, tsconfig.json, package.json. src/lib/client/PlayerContext.tsx is ADDITIVE-ONLY.';

// ---------------------------------------------------------------- Phase 1: gaps

const G1 = [
  COMMON,
  '',
  'YOU ARE THE HISTORY-RECENCY AGENT. Fill ONE gap: the history shelf cannot show relative recency ("2 h ago") because getHistory() discards the stored timestamp (finding F9 residual).',
  '',
  'FILES YOU MAY EDIT (exclusive for this task): src/lib/client/db.ts, src/components/home/HomeView.tsx, src/app/library/page.tsx.',
  '',
  'TASKS:',
  '1. In src/lib/client/db.ts add a NEW exported function `getHistoryWithTimestamps(): Promise<Array<{ track: Track; at: number }>>` that returns the same newest-first rows as getHistory() but INCLUDING the stored `at` tick. DO NOT change getHistory() itself (it has 6 call sites including PlayerContext.tsx:703 and db.ts consumers — changing its shape would ripple into frozen-adjacent code). Reuse the existing store/index and the existing toHistoryEntry/toPersisted helpers; NO IndexedDB schema change, NO migration (spec F9 explicitly forbids a migration). Keep the existing HISTORY_CAP trim behaviour. Make it non-throwing on the same terms getHistory is.',
  '2. Render relative recency on the history surface(s): in HomeView.tsx and the library History tab, use the new function and show a short relative time label on each history item (e.g. "2 h ago", "just now", "3 d ago") when a timestamp is available. Format with a small local helper (Intl.RelativeTimeFormat is allowed). Keep it static text, no animation needed. DEGRADE GRACEFULLY: if the timestamp is missing/invalid, render the row exactly as before with no label.',
  '3. Preserve everything the Browse agent already shipped in those two files: the history dedupe-by-id-keeping-most-recent helper, the LIBRARY_UPDATED_EVENT + usePageVisible + focus revalidation listeners, the TrackContextMenu wiring, the deferred-loading gates, the per-section retry branches, and the EmptyState action props. Read the files fully before editing; make a SURGICAL change, do not reformat.',
  '4. Do NOT touch the dialog call-sites in library/page.tsx (dialog.prompt / dialog.confirm) — they are correct.',
  '',
  'GATES: run `npx tsc --noEmit` (must be silent, exit 0) and `npx eslint src/lib/client/db.ts src/components/home/HomeView.tsx src/app/library/page.tsx` (clean). Do NOT run npm run build.',
].join('\n');

const G2 = [
  COMMON,
  '',
  'YOU ARE THE QUEUE-ROW-MENU AGENT. Fill ONE gap: spec WS2 says queue rows get a reduced menu with "remove + play-next". Currently QueueDrawer rows use plain inline buttons and have no such menu.',
  '',
  'FILES YOU MAY EDIT (exclusive for this task): src/components/player/QueueDrawer.tsx ONLY.',
  '',
  'TASKS:',
  '1. Keep the existing queue actions ALREADY working (row click-to-play, move up, move down, remove). The spec wants the two high-value actions (Play next, Remove) reachable from a compact reduced menu on the row.',
  '2. Implement the reduced menu as a small ⋯ trigger on each queue row (44px touch target, real <button>, accessible name) opening the SAME TrackContextMenu component that the browse surfaces use (src/components/track/TrackContextMenu.tsx) IF it accepts a reduced item set; otherwise a small local popover with exactly two items: "Play next" and "Remove". Read TrackContextMenu.tsx first and reuse it if it fits — do NOT duplicate menu logic if the shared component supports it. If you reuse the shared component, read it to learn its props; do NOT edit it (it belongs to the Browse agent).',
  '3. Consistency: the menu must dismiss on Escape / outside click, be keyboard navigable, and not break the drawer drag-to-dismiss gesture (a pointerdown on the ⋯ must NOT start a drawer drag — stop propagation where needed). Keep the existing move up/down buttons too (keyboard users rely on them).',
  '4. Keep the AnimatePresence entry/exit, drag-to-dismiss, scroll lock, EqualizerBars current-row indicator and aria-current the Player agent already shipped. This is an ADDITIVE change to the row internals.',
  '5. Animate only transform/opacity; use motion.ts tokens if you add any transition.',
  '',
  'GATES: run `npx tsc --noEmit` (silent, exit 0) and `npx eslint src/components/player/QueueDrawer.tsx` (clean). Do NOT run npm run build.',
].join('\n');

phase('Gaps');
await parallel([
  () => agent(G1, { label: 'gap:history-recency', phase: 'Gaps', schema: REPORT }),
  () => agent(G2, { label: 'gap:queue-row-menu', phase: 'Gaps', schema: REPORT }),
]);

// ---------------------------------------------------------------- Phase 2: verify

const V_RULES = [
  COMMON,
  '',
  'YOU ARE A VERIFIER. READ-ONLY: do NOT edit ANY file. Your job is to ADVERSARIALLY check shipped work against the spec and the §4 hard constraints — try to find real violations, not to confirm. Report concrete file:line evidence for every finding. If something is correct, say COMPLIANT and move on. Default to scepticism: if you cannot verify a claim from the code, mark it UNVERIFIABLE rather than assuming it works.',
  '',
  'The §4 HARD CONSTRAINTS you must police (a violation is rejection-level):',
  '  - Animate ONLY transform/opacity/clip-path. NEVER width/height/top/left/bottom/margin/padding/gap/inset/grid-template-*. Progress/track fills MUST be `transform: scaleX(...)` with `transform-origin: left` — NOT style={{width}} and NOT transition-[width]/h-[..] size animation. No animated box-shadow.',
  '  - Durations ONLY 120/200/320/400 ms, via motion.ts tokens (DUR/EASE/SPRING) — flag hardcoded literals and ad-hoc spring constants (stiffness outside 300-400 / damping outside 28-34).',
  '  - Springs only for gestures; timed eases otherwise.',
  '  - Reduced-motion fallback exists for every animated surface (framer surfaces rely on root MotionConfig reducedMotion="user" in AppProviders.tsx; CSS keyframes rely on the global prefers-reduced-motion block in globals.css — check the block actually covers each new keyframe class).',
  '  - No `any`, no non-null `!` on API/store data, no enums, import type used, strict TS clean (tsc is already green — so focus on `any`/`!` presence which tsc allows).',
  '  - Conditional classNames via a helper (src/components/track/cn.ts exists) — flag raw template-string className assembly.',
  '  - Touch targets >=44px for new controls; real button/a with accessible names; aria-pressed on toggles; aria-current on active nav/track.',
  '  - Exactly ONE <audio> element in the whole app (PlayerContext.tsx); nothing else may create audio.',
  '  - Hydration: any client store snapshot rendered during render must have a server snapshot (useSyncExternalStore) or a useMounted gate.',
  '  - No dangerouslySetInnerHTML anywhere (search highlighting must be string-split + <mark>).',
].join('\n');

const V1 = [
  V_RULES,
  '',
  'SCOPE: the PLAYER workstream (WS1 + WS3). Audit these files: src/components/player/FullPlayer.tsx, MiniPlayer.tsx, ProgressBar.tsx, QueueDrawer.tsx, VolumeSlider.tsx, useScrollLock.ts, src/components/ui/AmbientBackdrop.tsx, src/lib/client/useGlobalKeyboardShortcuts.ts, and the ADDITIVE delta in src/lib/client/PlayerContext.tsx (volume storage key migration to "sonic.volume" with legacy fallback; confirm NOTHING in the audio lifecycle / stream-fetch / reducer semantics changed — use `git diff` only where possible; most files are untracked so read them directly and reason about the invariants).',
  '',
  'CHECK SPECIFICALLY:',
  '  - F5 ProgressBar: fill is scaleX(progress)+transform-origin:left (NOT width); thumb grows via scale 1->1.25 on hover/focus/drag (NOT width/height); Home/End present; drag uses pointer capture; display is frozen while scrubbing (timeupdate ignored); commit-on-release via context seek; the floating bubble is translateX(-50%) at the ratio. Confirm NO width/height animation remains.',
  '  - F10 Volume: VolumeSlider has pointer-capture drag; fill is scaleX; persistence key is "sonic.volume" with a legacy read fallback; mute visible on mobile; slider hidden under sm in FullPlayer; Volume2/VolumeX 120ms cross-fade; M shortcut works.',
  '  - F1: repeat/shuffle have 120ms icon cross-fades (AnimatePresence) + active dots; aria-pressed.',
  '  - F2: the blanket closest("button") guard is gone from the Arrow cases; Space has a deliberate, documented double-toggle guard (stands down inside a <button>) and K is the unconditional alias; K/J/L/S/R all present; preventDefault on handled keys.',
  '  - F12: QueueDrawer uses AnimatePresence with desktop x-slide + mobile y-sheet + drag-to-dismiss thresholds (offsetY>120 or velocity>500); backdrop fade 200ms; Escape + focus return + aria-modal; scroll lock applied and released correctly (no stuck lock).',
  '  - WS3: artwork morph layoutId "sonic-np-art" on BOTH MiniPlayer and FullPlayer with SPRING.soft; track-change title/artist slide-up swap keyed by track id; AmbientBackdrop opacity <=0.25 dark, scale 1.1, crossfade 200/320ms, blur on STATIC layers only with <=2 blurred layers; FullPlayer title marquees on overflow; FullPlayer mounts <LyricsPanel> with the FROZEN contract props (verify the props passed match the interface exactly, and that no inline lyrics logic was left dead).',
  '  - useScrollLock: confirm it releases on unmount and on close (a leaked lock would freeze scrolling app-wide) and that it targets the real scroll container (Shell <main> / #main), NOT window.',
  'Flag any VIOLATION with the exact line, and any place the player could break the single-<audio> invariant or interrupt playback.',
].join('\n');

const V2 = [
  V_RULES,
  '',
  'SCOPE: the BROWSE (WS2) + SURFACES (WS6/WS7) workstreams, WITH SPECIAL ATTENTION to the three files that were edited concurrently by multiple agents and are the highest drift risk: src/components/home/HomeView.tsx, src/components/track/TrackRow.tsx, src/app/library/page.tsx. Read those three FULLY and check for integration breakage (duplicate declarations, lost handlers, orphaned imports, a revalidation listener that no longer fires, a dedupe that no longer runs, an EmptyState action that was dropped, a search <Text>/Highlight wrapper that got clobbered, dialog call-sites still intact).',
  '',
  'FILES: src/components/track/** (TrackRow, TrackContextMenu, FavoriteButton, TrackList, cn.ts), src/components/home/** (HomeView, TrackCard, TrackCardRow), src/app/library/page.tsx, src/components/layout/** (Shell, Topbar, RouteTitle), src/app/template.tsx, src/app/loading.tsx + per-route loading.tsx, src/components/ui/Skeleton.tsx, EmptyState.tsx, BackToTop.tsx, Highlight.tsx, src/app/search/page.tsx.',
  '',
  'CHECK SPECIFICALLY:',
  '  - F3: touch parity is gated on CAPABILITY (useCanHover), not the md: width breakpoint; the play affordance + the menu are visible without hover at 375px AND on a >768px touch device; whole-row/card tap still plays.',
  '  - F7: aria-current="true" present on the playing row AND card AND library ActionRow; EqualizerBars receives the real playing state everywhere (the old bug was the library equalizer animating while paused — confirm it is fixed); the index slot is reserved (no CLS); TrackCard has an accent playing ring + bars at the cover bottom.',
  '  - F8: TrackContextMenu has the Favorite toggle item, long-press (500ms, cancel on >8px), contextmenu opener, route-change dismissal, focus trap + arrow-key roving + focus return, and true edge FLIP (not just clamping). Confirm it does not break the underlying row click.',
  '  - F9: visibilitychange + focus revalidation present in BOTH HomeView and the library History tab; dedupe by track.id keeps the most recent; cap preserved.',
  '  - WS2: press-scale 0.98/120ms on rows/cards; like burst is <=400ms transform/opacity with a REAL reduced-motion static fallback (subtree not created); ONE guarded navigator.vibrate(8) only on non-hover devices.',
  '  - WS6: Skeleton variants are measured against the REAL component markup (compare TrackRowSkeleton to TrackRow, TrackCardSkeleton to TrackCard, SettingsSectionSkeleton to the settings rows) — flag any height/padding mismatch that would cause a visible skeleton->content jump; useDeferredLoading is wired; loading.tsx files exist and mirror their real pages; EmptyState has the action slot wired; BackToTop targets the real scroll container; search has the clear button, inline "Searching…" state, and <mark> highlighting via string splitting with NO dangerouslySetInnerHTML.',
  '  - WS7: template.tsx is fade + 8px rise at DUR.quick(200ms) EASE.out with NO nested MotionConfig (a nested config could override the root reducedMotion="user"); nav pill uses layoutId in BOTH rails with aria-current preserved; Topbar glass uses an opacity LAYER (not a backdrop-filter toggle) with hysteresis (two thresholds); per-route document.title set; route-change scroll reset targets the Shell <main>; Shell reserve padding is pb-24+env(safe-area-inset-bottom) mobile and md:pb-32 desktop; confirm the Shell h-full -> flex h-full flex-col -> min-h-0 flex-1 overflow-y-auto chain is intact (it is load-bearing for the topbar/back-to-top/route-reset listeners).',
].join('\n');

const V3 = [
  V_RULES,
  '',
  'SCOPE: the LYRICS + SYSTEM workstream (WS4/WS5). Audit src/components/lyrics/LyricsPanel.tsx, src/lib/client/lyricsParser.ts, src/lib/client/toast.ts, src/components/ui/Toaster.tsx, src/app/settings/page.tsx, and the FullPlayer mount of LyricsPanel (read-only — do not edit FullPlayer).',
  '',
  'CHECK SPECIFICALLY:',
  '  - F11 LyricsPanel: the exported LyricsPanelProps interface is EXACTLY the frozen WS0 contract (trackId, lines, plainLyrics, currentTime, isPlaying, onSeek) — flag any drift. Follow-mode is a PERSISTENT boolean false-d by ANY user gesture (pointerdown/wheel/touchmove) with a "Resume sync" pill, NOT a 4s timed pause; auto-scroll runs only while follow and is GATED by page visibility (usePageVisible); active line is accent + transform scale(1.02) 200ms (transform only, no width/height); click-a-line seeks via onSeek within ±0.5s; keyboard-accessible lines; plain fallback has NO fake sync; empty state present; reduced motion uses behavior:"auto".',
  '  - F11 wiring: FullPlayer passes the contract props correctly (lines sorted, plainLyrics, currentTime, isPlaying, and an onSeek that calls the context seek). Confirm the CURRENT-TIME subscription is a LEAF concern (the spec forbids non-leaf components subscribing to ~4Hz currentTime) — flag if FullPlayer itself re-renders at 4Hz because of the panel.',
  '  - F15: lyricsParser sorts ascending AND drops negative/NaN times, stable ties. Run the fixture: `npx tsx scripts/frontend/parser-check.ts` (if tsx is available) and report the result.',
  '  - F14: toaster hydration uses useSyncExternalStore with a stable server snapshot; dedupe + cap intact; AnimatePresence enter/exit; the auto-dismiss countdown PAUSES on hover/focus (spec F14 sub-item) — verify BOTH the CSS hairline pause AND that the store timer actually freezes (the agent claims store-level pauseToast/resumeToast + useToastHold); check the resume re-arms a sane remainder and the toast still eventually dismisses (a stuck toast would be a bug).',
  '  - F16: confirm toggleFavorite is still an atomic single readwrite transaction (db.ts) and report whether it is a tx or a promise queue.',
  '  - Confirm 0 executable native dialogs remain in src/ (grep) and that settings uses useDialog + toasts.',
].join('\n');

const V4 = [
  V_RULES,
  '',
  'SCOPE: CROSS-CUTTING SWEEP over the WHOLE diff of this upgrade. You do not own a workstream — your job is the §4 constraint sweep and the "did anything regress" check across every changed/new file.',
  '',
  'TASKS:',
  '1. BANNED-ANIMATION SWEEP: grep the whole of src/ (not only changed files) for rejection-level patterns and report each with file:line: `style={{ width:` / `style={{width:` (a scaleX fill must not use width), `transition-[width`, `transition-all` on sized elements, `animate-pulse` (should be gone, replaced by the shimmer system), `box-shadow` inside a transition/animate, and any `duration-[0-9]` numeric literal that is not one of 120/200/320/400 (e.g. 240, 600, 700, 1000). Also grep for ad-hoc framer springs: `stiffness:` / `damping:` outside src/lib/client/motion.ts — flag any component-level spring constants.',
  '2. TOKEN COMPLIANCE: grep for hardcoded `.12`/`0.12`/`0.2`/`0.32`/`0.4` second durations in framer transitions that should come from DUR, and for `duration: 0.24` style literals left over. Report the ones that are NOT in motion.ts.',
  '3. REDUCED-MOTION COVERAGE: list every CSS keyframe class added during this upgrade (read globals.css) and verify each is neutralised by the `@media (prefers-reduced-motion: reduce)` block — flag any new keyframe class the guard does not cover (e.g. eq-bounce/.eq-anim, the toast pause rule, any topbar/back-to-top keyframe).',
  '4. SINGLE AUDIO: confirm exactly one `<audio` element exists in src/ and no `new Audio(` anywhere.',
  '5. HYDRATION: grep for direct `window.`/`localStorage`/`document.` access during render in client components that could desync SSR — flag any unguarded one. Check the new Topbar/RouteTitle/BackToTop/Highlight for SSR safety.',
  '6. A11Y: grep the new controls (BackToTop, Topbar, RouteTitle is not interactive, VolumeSlider, the reduced queue menu if present) for accessible names + 44px targets; flag missing aria-label on icon-only buttons and any `<div onClick>` that should be a <button>.',
  '7. DEAD CODE: flag any now-unused import or leftover helper in the changed files (e.g. FullPlayer after its inline lyrics block was extracted, or unused Equalizer vs EqualizerBars imports).',
  'Return a findings list with file:line and severity. Be exhaustive — this is the last line of defence before the report.',
].join('\n');

phase('Verify');
const [v1, v2, v3, v4] = await parallel([
  () => agent(V1, { label: 'verify:player', phase: 'Verify', schema: AUDIT }),
  () => agent(V2, { label: 'verify:browse-surfaces', phase: 'Verify', schema: AUDIT }),
  () => agent(V3, { label: 'verify:lyrics-system', phase: 'Verify', schema: AUDIT }),
  () => agent(V4, { label: 'verify:cross-cutting', phase: 'Verify', schema: AUDIT }),
]);

const all = [v1, v2, v3, v4].filter(Boolean);
const violations = all.flatMap((a) => (a.findings || [])).filter((f) => f.verdict === 'VIOLATION');
const deviations = all.flatMap((a) => (a.findings || [])).filter((f) => f.verdict === 'DEVIATION');

return {
  counts: {
    violations: violations.length,
    deviations: deviations.length,
    unverifiable: all.flatMap((a) => (a.findings || [])).filter((f) => f.verdict === 'UNVERIFIABLE').length,
  },
  violations,
  deviations,
  v1,
  v2,
  v3,
  v4,
};
