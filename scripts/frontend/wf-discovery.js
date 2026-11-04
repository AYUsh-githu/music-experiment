export const meta = {
  name: 'sonic-discovery-audit',
  description: 'Audit Sonic frontend against the upgrade prompt (F1-F17, WS0-WS9) and establish baseline',
  phases: [{ title: 'Audit', detail: '5 parallel scope audits + gaps + verify resolutions' }],
};

const PROMPT = 'C:/Users/santo/OneDrive/Desktop/practice/Sonic-Frontend-Upgrade-Prompt.md';
const ROOT = 'C:/Users/santo/OneDrive/Desktop/practice';

const AUDIT = {
  type: 'object',
  properties: {
    inventory: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          subject: { type: 'string', description: 'Finding/WS-item + scope' },
          status: { type: 'string', enum: ['DONE', 'PARTIAL', 'MISSING', 'BLOCKED'] },
          evidence: { type: 'string', description: 'file:line + what the code actually does' },
          gap: { type: 'string', description: 'precisely what remains to implement to satisfy the prompt' },
        },
        required: ['subject', 'status', 'evidence', 'gap'],
      },
    },
    verifyResolutions: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
  },
  required: ['inventory', 'verifyResolutions', 'risks'],
};

const G = 'You are auditing READ-ONLY (do NOT edit any source file) the SONIC Next.js app at "' + ROOT + '". The authoritative spec is "' + PROMPT + '" (read its §1 metric table, §3 verified snapshot, §4 hard constraints, §5 backend freeze, §6 findings F1-F17, §8 WS0, §9 WS1-WS9, §10 fan-out ownership, §11 gates, §13 done-definition). Context: progress.md in the repo documents prior Waves 1-2 (2026-10-28) claiming to implement much of F1-F17 and WS0-WS2; RE-VERIFY every claim against the actual code, report what IS there. Backend is frozen (src/lib/server/**, src/app/api/**, scripts/** existing, next.config.ts, tsconfig.json). If a surface needs a backend change, flag it for a §12 proposal. Report concrete file:line evidence for every claim.';

phase('Audit');

const p1 =
  G + 'Scope lies ONLY in src/components/player/**, src/hooks/useGlobalKeyboardShortcuts.ts, and the ADDITIVE-only aspects of src/lib/client/PlayerContext.tsx (do NOT audit the frozen audio element lifecycle or stream-fetch core; DO audit which additive selectors/actions exist: setVolume, toggleMute, seek, toggleRepeat, toggleShuffle, etc.). AUDIT each with file:line evidence, triage DONE/PARTIAL/MISSING and the exact remaining gap: F1 Repeat & Shuffle UI toggles (icon morph Repeat/Repeat1 cross-fade 120ms, aria-pressed, active dot) in FullPlayer + MiniPlayer. F2 Keyboard-guard: is the control-selection guard only target.closest(button) or the typing guard (input,textarea,select,contenteditable)? Final shortcut map (Space/K play, arrows seek, J/L, M mute, S/R shuffle/repeat). preventDefault on handled keys. F5 Full scrubbing ProgressBar: input[type=range] OR role=slider keyboard slider; scaleX fill transform-origin left; thumb scale 1 to 1.25 hover/focus/drag; pointer-capture drag with LOCAL preview (fill + floating time bubble m:ss), ignore timeupdate while dragging, commit-on-release via context seek, never live-scrub currentTime; keyboard arrows + Home/End; aria-valuetext. F10 VolumeSlider + mute: Volume2/VolumeX crossfade 120ms; slider hidden under sm, mute always visible; persists localStorage sonic.volume; M shortcut; additive setVolume/toggleMute. F4 Shell occlusion padding reserved for mini + desktop player (pb-24, md:pb-32/36, env(safe-area-inset-bottom)). F12 QueueDrawer enter/exit via AnimatePresence: desktop slide x 100 to 0 320ms, mobile bottom sheet y 100 to 0 + drag-to-dismiss (offsetY>120 or velocity>500), backdrop fade 200ms, Escape + focus return + aria-modal + scroll lock, current track equalizer + aria-current. WS3 morph/ambient: MiniPlayer to FullPlayer artwork morph via layoutId; ambient backdrop pre-blurred layer opacity crossfade (no blur filter on a moving element); track-change title/artist slide-up; scroll lock while player open; MarqueeText on titles; at most 3 blur layers. Report what exists at file:line and what each needs to be spec-complete.';

const p2 =
  G + 'Scope lies ONLY in src/components/track/**, src/components/home/**, src/components/browse/** if any, home/library list sections, history shelf logic. AUDIT with file:line evidence, triage DONE/PARTIAL/MISSING, exact gap: F3 Hover-only play affordance: .touch-visible utility or equivalent so play + menu always visible at hover:none; whole-row tap plays; verify at 375px touch. F7 Active-track indicator: playing row gets equalizer bars in place of the index, accent title, aria-current=true; TrackCard gets a playing ring + bars overlay; no layout shift (reserve the index slot). F8 TrackMenu wired on rows/cards + reduced queue row menu; long-press 500ms (timer, cancel >8px move) + contextmenu at cursor; popover items Play next / Add to queue / Add to playlist submenu / New playlist / Favorite / Go to artist-album; Escape + outside + route-change dismiss, focus trap, arrow-key nav, position flips near edges. Inspect src/components/track/TrackContextMenu.tsx. F9 History shelf revalidation: on visibilitychange + focus + after each local play; dedupe by track.id keep most recent; relative recency; no IndexedDB schema migration. Like burst on favorite plus one guarded navigator.vibrate(8) on mobile; press-scale feedback scale 0.98 120ms. Report what exists (TrackContextMenu vs TrackMenu naming, Equalizer in track rows/cards) at file:line and each items spec gap.';

const p3 =
  G + 'Scope lies ONLY in src/lib/client/lyricsParser.ts, src/lib/client/db.ts, src/lib/client/toast.ts, src/lib/client/settings.ts, src/components/ui/Toaster.tsx, src/components/lyrics/** (check existence of LyricsPanel.tsx), src/app/settings/page.tsx, and the three dialog call-sites in src/app/library/page.tsx (create/rename/delete). AUDIT with file:line evidence, triage DONE/PARTIAL/MISSING, exact gap: F15 lyricsParser sort: lines sorted ascending by timeMs, drop negative/NaN, stable ties; verify the parse function sorts. F11 LyricsPanel: does src/components/lyrics/LyricsPanel.tsx exist? If yes assess against the frozen contract (trackId, lines sorted, plainLyrics, currentTime, isPlaying, onSeek): follow-mode auto-scroll with user-override (wheel/touch/pointer sets follow=false + Resume-sync pill), active line accent + scale 1.02 200ms, click-line-to-seek, plain fallback, empty state, LyricsSkeleton. If the file is a stub or missing, report so. F14 Toaster hydration: useSyncExternalStore with getServerSnapshot returning [] or a mounted gate; keep dedupe + cap; enter/exit AnimatePresence; auto-dismiss progress scaleX pausing on hover; swipe-to-dismiss drag x; aria-live polite. F16 db write race: toggleFavorite serialized through a promise queue or single atomic tx; report which. F6 Modal/ConfirmDialog/PromptDialog primitives exist? inspect src/components/ui/Modal.tsx + src/lib/client/useDialog.tsx: assess vs recipe portal role=dialog aria-modal focus trap Escape focus return spring-in scale 0.96 to 1 overlay fade 200ms. The three library call-sites must use these. F13 Settings: no alert(); cache-clear confirm via ConfirmDialog; success via toast. Report where the full LyricsPanel lives or is expected (FullPlayer mount) and its current wiring.';

const p4 =
  G + 'Scope lies ONLY in src/app/** page.tsx files plus template.tsx / loading.tsx (check existence), src/components/layout/** (Shell, nav, topbar), src/components/ui/EmptyState.tsx + Skeleton.tsx, and every page loading/skeleton wiring + search page polish. AUDIT with file:line evidence, triage DONE/PARTIAL/MISSING, exact gap: F17 config facts: report Tailwind major version (^4: confirm @tailwindcss/turbopack + @import tailwindcss in globals.css; any tailwind.config.* file?), framer-motion version, whether Playwright or any browser-verification tool exists, next.config.ts turbopack root fix present. WS6 skeletons/loading: does a Skeleton system matching real layouts exist (TrackRowSkeleton h-14, TrackCardSkeleton, queue/lyrics/history/settings skeletons)? Are useDeferredLoading-style hooks present in src/hooks (useMounted, useCanHover, usePageVisible, useDeferredLoading)? Skeleton to content cross-fade DUR.quick capped stagger; per-section independent loading; EmptyState; back-to-top; search debounce + inline searching + clear-button + match highlight. Do route-level loading.tsx files exist? glob src/app/loading.tsx and src/app/*/loading.tsx. WS7 navigation/transitions: template.tsx exists (fade + small rise 200ms per prompt; note the journal says 4px/240ms, verify); active nav pill with layoutId + aria-current; topbar glass-on-scroll hysteresis; document.title via metadata; route-change scroll behavior. src/app/layout.tsx: where MotionConfig and AppProviders/PlayerContext mount; confirm exactly one audio element.';

const p5 =
  G + 'You are the BASELINE + GATES agent. Working tree: ' + ROOT + ' (Windows). Do NOT edit source files. You may run read-only shell/PowerShell commands and WRITE ONLY under scripts/frontend/out/. TASKS with evidence. 1 Freeze diff: run git diff --name-only -- src/lib/server src/app/api scripts next.config.ts tsconfig.json bin AND git diff --name-only -- package.json. State exact output and whether acceptable per prompt §5 (note: this repos first commit is the bare Next scaffold, so most source files are untracked; report the reality, which tracked paths differ, and confirm no frozen backend/logic paths were changed by frontend work in the working tree). 2 Gates: run npm run build then npm run lint then npx tsc --noEmit. Report pass/fail verbatim with a generous timeout (these take minutes). 3 Native dialogs: grep src/ for window.prompt, window.confirm, window.alert, and bare alert( and report hit count + file:line (target 0). 4 Audio element: locate the single audio element definition and confirm exactly one source of truth. 5 Baseline: create scripts/frontend/out/ and write baseline.json capturing current state (build status, lint status, tsc status, native-dialog count, framer-motion version, next version, tailwind version, notes). Do not git-add. 6 Report whether scripts/frontend/battery.md and any verify-frontend scripts exist (WS9 items, likely MISSING). The scripts/** freeze protects EXISTING scripts only; creating scripts/frontend/ is explicitly allowed by the prompt.';

const [player, browse, lyrics, surfaces, verify] = await parallel([
  () => agent(p1, { label: 'audit:player', phase: 'Audit', schema: AUDIT }),
  () => agent(p2, { label: 'audit:browse', phase: 'Audit', schema: AUDIT }),
  () => agent(p3, { label: 'audit:lyrics', phase: 'Audit', schema: AUDIT }),
  () => agent(p4, { label: 'audit:surfaces', phase: 'Audit', schema: AUDIT }),
  () => agent(p5, { label: 'audit:verify', phase: 'Audit', schema: AUDIT }),
]);

return {
  summary: {
    playerCount: player && player.inventory ? player.inventory.length : 0,
    browseCount: browse && browse.inventory ? browse.inventory.length : 0,
    lyricsCount: lyrics && lyrics.inventory ? lyrics.inventory.length : 0,
    surfacesCount: surfaces && surfaces.inventory ? surfaces.inventory.length : 0,
    verifyCount: verify && verify.inventory ? verify.inventory.length : 0,
  },
  player,
  browse,
  lyrics,
  surfaces,
  verify,
};
