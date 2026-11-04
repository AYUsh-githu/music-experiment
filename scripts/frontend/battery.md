# Playback Continuity Battery — Sonic Frontend Upgrade (WS9)

Manual runbook. Pass = **audio never unexpectedly stops**, **exactly one `<audio>`
element in the DOM at all times**, and **no console errors** — after every step.

## Why this exists

The upgrade touches the player shell, queue drawer, browsing surfaces, and
overlays. Every one of those could, if wrong, unmount the `<audio>` element or
interrupt the stream. This battery proves the playback core survived the frontend
work: the element is created once in `PlayerContext` (mounted at the root layout)
and must never be recreated by a route change, overlay, or gesture.

## Prerequisites

1. Production build running locally:
   ```bash
   npm run build
   npm run start        # http://localhost:3000 (or the port Next prints)
   ```
2. DevTools open with:
   - **Console** tab cleared, filter set to show errors + warnings.
   - The following snippet pasted once, to assert the single-element canary at any
     moment (re-run after each scenario):
     ```js
     document.querySelectorAll("audio").length   // must always === 1
     ```
3. A track playing before you start (search any song → play it). Playback must be
   audible/advancing before scenario 1.

## Device matrix

Run the whole battery at **both**:
- **375×667** (mobile, touch emulation on)
- **1280×800** (desktop)

Under reduced motion ("Emulate `prefers-reduced-motion: reduce`" in DevTools
Rendering), re-run scenarios 1, 2, 7, 12 and confirm each degrades to an instant /
static transition with audio still running.

## The 12 scenarios

| # | Scenario | Steps | Pass criteria |
|---|---|---|---|
| 1 | FullPlayer open/close | Click the mini-player artwork to open the full player; close it (X / Escape). | Audio keeps playing. Artwork morph runs (no morph under reduced motion). No console errors. `<audio>` count still 1. |
| 2 | QueueDrawer open / drag-dismiss | Open the queue from the mini-player. On mobile, drag the sheet down past the threshold; on desktop press Escape. | Drawer animates in/out; drag-dismiss only on mobile. Background scroll is locked while open and restored after. Audio uninterrupted. |
| 3 | Navigate 3 routes + back | With audio running, go Home → Search → Library → browser Back. | Mini-player stays mounted on every route; `<audio>` count stays 1; no remount gap in audio; no scroll-jump bug. |
| 4 | Theme toggle ×2 | Toggle the theme twice (if a toggle exists). | Audio unaffected; no hydration warning on re-render. |
| 5 | Dialog open/cancel/confirm | In Library, open the create-playlist dialog; cancel. Then open the delete confirm; confirm. | Focus trapped inside the dialog; Escape cancels; focus returns to the trigger. Destructive confirm shows the item name. Audio unaffected. |
| 6 | Toast swipe-dismiss | Trigger a toast (e.g. favorite a track, or clear cache in Settings), then swipe it away (mobile) / hover it (desktop). | Swipe dismisses (mobile). Hover pauses the auto-dismiss countdown (desktop). No console errors. |
| 7 | Lyrics follow off/on + line-seek | With the full player open, scroll the lyrics manually; watch for the "Resume sync" pill; click it. Then click a lyric line. | Manual scroll does NOT snap back; the pill appears on the gesture; clicking it resumes follow and recenters; clicking a line seeks within ±0.5s. Audio uninterrupted. |
| 8 | Scrub drag/release | Drag the progress bar and release. | The fill + time bubble track the pointer; `timeupdate` does not fight the drag; on release audio seeks once and keeps playing. The stream URL is NOT re-fetched per drag (check Network: no new `/api/stream` on drag). |
| 9 | Volume / mute | Move the volume slider; press `M`; move it again. | Volume changes smoothly (pointer-capture drag); `M` mutes/unmutes with an icon cross-fade; the value persists across reload (`localStorage` key `sonic.volume`). Mute button reachable on mobile at 375px. |
| 10 | Shuffle / repeat toggles | Press `S` and `R`, then click the on-screen toggles. | Repeat cycles off → all → one with an icon cross-fade and an active dot; shuffle toggles with `aria-pressed`; audio keeps playing throughout. |
| 11 | TrackMenu play-next + add-to-playlist | On a search/library row, open the `⋯` menu (click; right-click on desktop; long-press on touch). Choose "Play next"; reopen and add to a playlist. | Menu opens from all three openers; arrow keys navigate; Escape/outside-click/route-change closes; "Play next" reorders the queue; add-to-playlist persists. Audio uninterrupted. |
| 12 | Skeleton → content on a throttled fresh route | In DevTools Network, set throttling to Slow 3G, then hard-navigate to a route. | Skeleton matches the real layout (no layout jump on swap, ≤2px); no skeleton flash on a fast/cached reload; audio (if playing) continues through the navigation. |

## Recording

Copy the table below into the work log and fill it in:

```
Scenario | 375px | 1280px | reduced-motion | audio count (must be 1) | notes
1        |       |        |                |                         |
...12
```

## Automated coverage

There is **no Playwright in this repo** (verified: `package.json` has no
Playwright/Puppeteer, `node_modules/playwright` is absent), so
`scripts/frontend/verify-frontend.mjs` is intentionally NOT authored. CLS,
skeleton layout-box delta, hydration-error counting, and the native-dialog
assertion therefore cannot be automated without adding a dev-only dependency,
which requires a §12 amendment. The native-dialog count **is** covered by a
grep-able gate (`window.prompt|window.confirm|window.alert` over `src/` = 0).
