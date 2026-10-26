# 📋 plan.md — "Sonic" Free Music Streaming Web App
### Master Development Plan for AI Coding Agent

> **Document purpose:** This file is the single source of truth for building the application.
> It is written FOR an AI coding agent (you). Read it completely before writing any code.
> Follow the phases in strict order. Do not skip ahead. Do not merge phases.

---

## 0. CRITICAL AGENT INSTRUCTIONS (READ FIRST — HIGHEST PRIORITY)

1. **Create `progress.md` FIRST, before any other action.**
   - At the very start of the project, create `progress.md` in the project root.
   - Initialize it with: project name, date, current phase = `Phase 0`, and an empty task log.
   - After **every completed task, every bug fix, and every phase gate**, append an entry to `progress.md` with this format:
     ```
     ## [YYYY-MM-DD HH:MM] — <Task/Phase title>
     - Status: DONE / FAILED / BLOCKED / IN-PROGRESS
     - What was done: <1–3 bullet points>
     - Files touched: <paths>
     - Issues & decisions: <anything the next session must know>
     - Next step: <exact next task>
     ```
   - `progress.md` exists so a **fresh agent session can resume instantly** with zero context loss. Treat it as sacred. Never delete it. Never rewrite history — append only.
   - If a session ends mid-phase, the LAST entry of `progress.md` must make the resume point obvious.

2. **Phase discipline:**
   - Build strictly in phase order (Phase 0 → 6). Do not implement features from a later phase early.
   - Each phase has **Acceptance Criteria**. A phase is complete ONLY when every criterion passes. Then log the gate in `progress.md` before starting the next phase.

3. **Never break the working state.** The app must build and run cleanly after every phase. Commit-sized checkpoints: after each phase, the app must be fully usable up to that phase's features.

4. **No API keys.** The entire stack is keyless by design. If you (the agent) find yourself needing a key or a paid service, STOP — you have gone off-plan. Re-read §3.

5. **Uncertainty protocol:** If an external API returns unexpected shapes or a library breaks, first check the referenced docs, then adapt gracefully, then log the incident and your adaptation in `progress.md`. Never silently swallow errors.

6. **Legal constraint (must be respected):** This app streams music via unofficial/reverse-engineered sources. It is a **personal, educational, non-commercial project**. Do not add: paywalls, user authentication/registration systems, public deployment guides, or monetization. Do not remove the "for personal testing" disclaimer from the UI footer.

---

## 1. PROJECT OVERVIEW

**Goal:** A free, keyless, web-based music streaming application (like InnerTune / OuterTune / SimpleTune) that:
- Searches songs and streams full audio via YouTube's internal API (gray-zone, for personal testing)
- Enriches tracks with clean metadata and hi-res cover art (iTunes / Deezer)
- Shows plain + time-synced lyrics (LRCLIB)
- Manages queue, favorites, history, playlists — all stored locally (no backend database, no accounts)
- Degrades gracefully via a pluggable multi-source architecture (YouTube primary, JioSaavn fallback)

**Core philosophy:** The app is a **smart aggregator + player**, not a music host. It owns no audio files, no music database, and no user accounts.

**Target platform:** Desktop + mobile web browser (responsive).

---

## 2. TECH STACK (FIXED — do not substitute without logging a justified decision)

| Layer | Choice | Notes |
|---|---|---|
| Framework | **Next.js 16+ (App Router), TypeScript strict** | Server API routes power extraction & proxying |
| Styling | **Tailwind CSS** | Dark theme primary |
| Audio extraction | **`youtubei.js`** (npm) | InnerTube wrapper; runs server-side only |
| Metadata/art | **iTunes Search API** (primary), **Deezer public API** (fallback) | Both keyless |
| Lyrics | **LRCLIB** (`https://lrclib.net`) | Keyless, CORS-open |
| Fallback stream source | **JioSaavn unofficial API** (`saavn.dev` public instance) | Direct MP3 128/320 kbps URLs |
| Player | **HTML5 `<audio>`** via a React context player | No heavy player lib needed |
| Client state | **React Context + `useReducer`** (player/queue), **Zustand** optional | Keep deps minimal |
| Persistence | **localStorage** (settings) + **IndexedDB** (library: playlists, favorites, history) | Via `idb` wrapper package or raw IndexedDB |
| Package manager | npm | |

---

## 3. EXTERNAL API INTEGRATION SPECIFICATIONS

### 3.1 Audio streams — YouTube via `youtubei.js` (SERVER-SIDE ONLY)
- Library: `youtubei.js` — **never import it in client components** (it is a Node library; heavy + CORS-sensitive).
- Usage pattern:
  ```ts
  import { Innertube } from 'youtubei.js';
  const yt = await Innertube.create();
  const search = await yt.search(query);              // → videos/albums/artists
  const info = await yt.getInfo(videoId);             // → formats, metadata
  const best = info.chooseFormat({ quality: 'best', type: 'audio' });
  // best.url → direct googlevideo.com URL (EXPIRES ~6h, per-client)
  ```
- **Rules:**
  - Resolve stream URLs **at play time**, never store them beyond a short in-memory/LRU cache (TTL ≤ 4 hours).
  - Requests must be resilient: wrap in `try/catch` with a 10s timeout; on failure return a structured error `{ ok: false, code, message }`.
  - If YouTube extraction fails (PO-Token breakage, 403s), the stream endpoint must automatically try the fallback source (§3.4) before returning an error.
  - Pin `youtubei.js` to a specific version; when it breaks, upgrade deliberately and log it in `progress.md`.

### 3.2 Stream proxy — MANDATORY
- Browsers cannot fetch `googlevideo.com` directly (no CORS, Range restrictions). **All audio bytes must flow through our server proxy route.**
- Route: `GET /api/proxy?host=<encoded>&path=<encoded>&params=<encoded>` (do NOT accept an arbitrary full URL — validate host against an allowlist: `*.googlevideo.com` etc., to prevent SSRF).
- Requirements (critical):
  - Forward the client's `Range` header to the origin.
  - Return origin's status (usually `206 Partial Content`) with `Content-Range`, `Accept-Ranges: bytes`, `Content-Length`, and correct `Content-Type` (e.g. `audio/webm`, `audio/mp4`).
  - Stream the body (no full buffering) — use `fetch` + pass `res.body` (ReadableStream) straight to the response.
  - Support seeking: any `Range: bytes=N-` must produce a correct 206 response.

### 3.3 Metadata + cover art
**Primary — iTunes Search API (keyless):**
```
GET https://itunes.apple.com/search?term=<query>&media=music&entity=song&limit=25
GET https://itunes.apple.com/lookup?id=<collectionId>&entity=song
```
- Artwork URL size hack: replace `100x100bb.jpg` with `600x600bb.jpg` / `1000x1000bb.jpg` (max `5000x5000`).
- No auth, generous limits. Send no special headers.
**Fallback — Deezer public API (keyless):**
```
GET https://api.deezer.com/search?q=<query>
GET https://api.deezer.com/album/<id>
```
- Artwork: `album.cover_big` / `cover_xl` (~1000px).

### 3.4 Lyrics — LRCLIB (keyless)
```
GET https://lrclib.net/api/get?track_name=<t>&artist_name=<a>&album_name=<al>&duration=<sec>
GET https://lrclib.net/api/search?q=<query>
```
- Response contains `plainLyrics` (string) and `syncedLyrics` (LRC string, lines like `[00:27.93] text`).
- Prefer `/api/get` (exact match), fall back to `/api/search`, take the closest duration match.
- Set header `Lrclib-Client: Sonic v1.0 (personal-project)` and/or `X-User-Agent` (browser) for better rate limits (~90 req/min). Handle `429` with `Retry-After`.
- **Parser requirement:** build a robust LRC parser → `{ timeMs, text }[]`; support multiple timestamps per line; gracefully fall back to plain lyrics if no sync data.

### 3.5 Fallback stream source — JioSaavn (keyless)
- Public instance base: `https://saavn.dev/api` (verify liveness at build time; wrap ALL calls behind the source abstraction §5.3).
- Endpoints: `/search/songs?query=`, `/songs/{id}` → returns `downloadUrl` array (128/320 kbps MP3), cover art, lyrics sometimes.
- Used automatically when YouTube source fails, or when a track is flagged unavailable.

### 3.6 Related songs / radio
- Via `youtubei.js`: `yt.getRelated(videoId)` (or `info.getRelated()`) → queue continuation. Cache per-track for the session.

---

## 4. TARGET ARCHITECTURE

```
┌────────────────────────────────────────────────────────────────┐
│ FRONTEND (Next.js App Router, client components)               │
│  • Home: trending/moods (Deezer charts + editorial picks)      │
│  • Search: songs (YT search merged w/ iTunes art), filters     │
│  • NowPlaying: full-screen player, queue drawer, synced lyrics │
│  • Library: favorites, playlists, history (IndexedDB)          │
└──────────────┬─────────────────────────────────────────────────┘
               │ same-origin /api/* fetches
┌──────────────▼─────────────────────────────────────────────────┐
│ API ROUTES (server)                                            │
│  GET /api/search?q=&filter=      → normalized Track[]          │
│  GET /api/stream?videoId=        → { url (proxied), format,    │
│                                      metadata, source }        │
│  GET /api/proxy?host=&path=&...  → audio bytes w/ Range        │
│  GET /api/lyrics?title=&artist=  → { plain, synced[] }         │
│  GET /api/related?videoId=       → Track[]                     │
│  GET /api/artwork?q=             → iTunes/Deezer art merge     │
└──────────────┬─────────────────────────────────────────────────┘
               │
   Client persistence: localStorage (settings) + IndexedDB (library)
```

**Normalized Track model (used everywhere, both client & server):**
```ts
interface Track {
  id: string;              // stable id: `yt:${videoId}` or `saavn:${id}`
  source: 'youtube' | 'saavn';
  videoId: string;         // source-native id
  title: string;
  artist: string;
  album?: string;
  duration: number;        // seconds
  artwork: string;         // best-size URL (client upgrades size)
  streamUrl?: string;      // NEVER persisted; ephemeral
  matched?: boolean;       // true if metadata was enriched via iTunes/Deezer
}
```

---

## 5. ENGINEERING RULES (NON-NEGOTIABLE)

### 5.1 Coding style
- **TypeScript strict mode.** No `any` without an inline justification comment. Prefer `unknown` + narrowing.
- **Naming:** `PascalCase` components/types, `camelCase` functions/variables, `SCREAMING_SNAKE_CASE` constants, one component per file, file names match the component.
- **Server vs client split:** every file starts with `'use client'` only when required. All extraction/proxy code lives in `src/lib/server/` and is imported ONLY by route handlers.
- **Functions:** small, single-purpose; max ~50 lines; extract helpers rather than nesting.
- **Error handling:** every external call wrapped; typed error object `{ ok, code, message, source? }`; user-facing errors are friendly and actionable ("Track unavailable — trying another source…"), never raw stack traces.
- **Async:** `async/await` only (no `.then` chains); `Promise.allSettled` for parallel independent calls (e.g., search + artwork merge).
- **Comments:** explain WHY, not WHAT. JSDoc on exported functions and the Track/source interfaces.
- **No secrets in code** (there are none by design), no env vars required to run.
- **Styling:** Tailwind utility classes inline; extract repeated patterns into components; dark theme tokens defined once in `globals.css` (CSS variables: `--bg`, `--surface`, `--accent`, `--text`, `--muted`).
- **Accessibility:** buttons have labels; player is fully keyboard-operable (space = play/pause, ←/→ = seek).

### 5.2 Performance & UX rules
- Stream URL resolution must not block UI: show skeleton + "preparing…" state; prefetch the next track's URL when the current track passes 70% progress.
- Artwork: lazy-load, `loading="lazy"`, always specify width/height (no layout shift).
- Search: debounce input 350ms; abort in-flight requests with `AbortController` when a new query arrives.
- Queue state survives page reload (persist to localStorage).

### 5.3 Source abstraction (the most important structural rule)
All stream sourcing must go through one interface so backends are swappable:
```ts
interface MusicSource {
  id: string;
  search(q: string, opts?: SearchOpts): Promise<Track[]>;
  getStream(id: string): Promise<{ url: string; format: string; expiresSec: number }>;
  getRelated(id: string): Promise<Track[]>;
  isAvailable(): Promise<boolean>;   // cheap health probe, cached 60s
}
```
- `YouTubeSource` (primary) and `SaavnSource` (fallback) implement it.
- Resolver order: primary → on failure → fallback → on total failure → typed error. Log every source failover to `progress.md`-style server log + surface a toast in UI.

### 5.4 Testing & verification (per phase)
- After each phase: run `npm run build` (must pass), run the app, manually verify every Acceptance Criterion, and record results in `progress.md`.
- Keep a minimal `scripts/verify-*.ts` (or curl-based) check for API routes — e.g., verify `/api/stream` returns a proxy URL and `/api/proxy` returns 206 with a Range request.

---

## 6. EXECUTION PHASES

> ⚠️ STRICT ORDER. Each phase ends with a GATE: all acceptance criteria verified → logged in `progress.md` → only then continue.

---

### PHASE 0 — Bootstrap & Skeleton
**Objective:** Runnable project skeleton + progress file + design foundation.
**Tasks:**
1. ⭐ **FIRST ACTION: create `progress.md`** per §0.1 (even before scaffolding).
2. Scaffold Next.js (App Router, TypeScript, Tailwind). Pin versions in `package.json`.
3. Create the folder blueprint (§7). Add `globals.css` theme tokens (dark theme).
4. Build app shell: sidebar/bottom-nav layout, empty Home/Search/Library pages wired to routing.
5. Install & smoke-test `youtubei.js` in a throwaway script: `Innertube.create()` + one `search()` call → prove extraction works in this environment. Log the result.
6. TypeScript strict config; ESLint clean.

**Acceptance criteria:** `npm run dev` serves the shell; navigation works between 3 empty pages; smoke-test script successfully prints ≥5 YouTube search results.

---

### PHASE 1 — Search + Streaming Player (MVP heart)
**Objective:** Type a query → see songs → click → music plays.
**Tasks:**
1. `MusicSource` interface + `YouTubeSource` (search + getStream) in `src/lib/server/`.
2. Route `GET /api/search`: YT search → normalize to `Track[]` → parallel artwork/metadata enrichment from iTunes (`Promise.allSettled`; keep YT data on enrichment failure).
3. Route `GET /api/stream?videoId=`: resolve best audio format → rewrite URL into `/api/proxy?...` form → return.
4. Route `GET /api/proxy`: full Range-aware streaming proxy (§3.2). **Verify seeking with curl `-H "Range: bytes=0-1023"` → expect `206`.**
5. Frontend: search page (debounced, skeletons), track list rows (art, title, artist, duration).
6. PlayerProvider (Context + reducer): current track, play/pause, `<audio>` element wired to `/api/stream`.
7. Persistent bottom mini-player bar (art, title, play/pause, progress, seek).

**Acceptance criteria:** Search "shape of you" returns ≥10 enriched tracks; clicking a track starts playback within ~3s; seeking works (no restart); mini-player persists across route navigation; a track that fails to stream auto-falls back to Saavn source or shows a friendly error.

---

### PHASE 2 — Queue & Playback Controls
**Objective:** A real listening experience.
**Tasks:**
1. Queue model in PlayerProvider: ordered list, current index, modes (repeat off/all/one, shuffle).
2. Add-to-queue / play-next / remove; queue drawer UI with drag-free reorder buttons (v1).
3. Next/prev buttons; auto-advance on track end; enqueue `/api/related` for autoplay when queue empties (Phase 4 completes this — for now advance to "queue end" state).
4. Queue persists across reload (localStorage).
5. MediaSession API integration: lock-screen/OS media controls (title, artist, artwork, play/pause/next/prev handlers).

**Acceptance criteria:** Multi-track queue plays through with auto-advance; shuffle & repeat behave correctly; OS media keys work; reload restores queue position.

---

### PHASE 3 — Lyrics + Local Library
**Objective:** Synced lyrics + a personal library without accounts.
**Tasks:**
1. Route `GET /api/lyrics` (LRCLIB, §3.4) + robust LRC parser util.
2. NowPlaying full-screen view: big artwork, track info, synced lyrics with active-line highlight driven by `audio.currentTime` (requestAnimationFrame or `timeupdate`), click-line-to-seek; plain-lyrics fallback; "No lyrics found" state.
3. IndexedDB layer (`src/lib/db.ts` via `idb`): stores `favorites`, `history`, `playlists`.
4. UI: heart toggle (list rows + player), Library page (Favorites / Playlists / History tabs), create-rename-delete playlist, add/remove tracks, play playlist as queue.
5. History: auto-record plays (dedupe consecutive).

**Acceptance criteria:** Lyrics highlight in real time and are clickable-to-seek; favorites survive full reload; playlists are editable and playable as a queue; history records recent plays correctly.

---

### PHASE 4 — Radio, Fallback Source Hardening & Quality Settings
**Objective:** "Never stops playing" + resilience + settings.
**Tasks:**
1. Autoplay radio: when queue ends → fetch `/api/related?videoId=` → append seeds (dedupe vs. played history; cap 15).
2. `SaavnSource` fully implemented (search + stream + related stub) behind the abstraction; automatic failover drills (simulate YT failure; verify fallback path works end-to-end).
3. Settings page: default audio quality (best/low — maps to different itag selection), artwork size, clear-library buttons.
4. Stream URL LRU cache server-side (TTL ≤ 4h) to avoid re-resolving within a session.
5. Prefetch next track at 70% progress (§5.2).

**Acceptance criteria:** Continuous playback for 20+ minutes via radio without manual input; killing YT resolution (e.g., temporarily blocked) transparently switches to Saavn; settings persist and take effect immediately.

---

### PHASE 5 — Polish, Responsiveness & Error Resilience
**Objective:** Feels professional.
**Tasks:**
1. Mobile responsive pass: bottom nav on small screens, swipe-down/full-screen player, touch-friendly targets (≥44px).
2. Global toast/notification system (now-playing, errors, source failover notices).
3. Loading/empty/error states for every page; artwork placeholder gradient with initials.
4. Keyboard shortcuts (space, arrows) + focus states.
5. Home page content: Deezer editorial/charts (keyless) + "recently played" row + "jump back in".
6. Footer disclaimer: "For personal testing/education only. Streams provided by public sources; not affiliated with YouTube/Deezer/Saavn."

**Acceptance criteria:** Clean UI at 360px, 768px, 1440px widths; zero console errors in normal flows; every async surface has a visible state; Lighthouse perf ≥ 80 on desktop profile.

---

### PHASE 6 — Final Verification & Handover
**Objective:** Confident delivery.
**Tasks:**
1. Full regression: walk every Acceptance Criterion from Phases 0–5; record PASS/FAIL in `progress.md`.
2. `npm run build` production build passes; brief production-run test.
3. Write/refresh `README.md` (short): what it is, how to run, legal note, architecture diagram reference.
4. Final `progress.md` entry: completion summary, known limitations, upgrade notes for future breakage (e.g., "if YT extraction breaks: bump youtubei.js, check PO-token issues").

**Acceptance criteria:** All prior criteria re-verified; production build runs; README + progress.md tell the full story for any future maintainer/agent.

---

## 7. FOLDER BLUEPRINT

```
├── plan.md                    ← this file (do not modify except logging changes at top)
├── progress.md                ← agent work journal (created FIRST, append-only)
├── README.md                  ← end of project
└── src/
    ├── app/
    │   ├── layout.tsx                 # shell + PlayerProvider + mini-player
    │   ├── page.tsx                   # Home
    │   ├── search/page.tsx
    │   ├── library/page.tsx
    │   ├── settings/page.tsx
    │   └── api/
    │       ├── search/route.ts
    │       ├── stream/route.ts
    │       ├── proxy/route.ts
    │       ├── lyrics/route.ts
    │       └── related/route.ts
    ├── components/
    │   ├── player/     (MiniPlayer, FullPlayer, QueueDrawer, ProgressBar)
    │   ├── track/      (TrackRow, TrackList, Artwork)
    │   ├── layout/     (Sidebar, BottomNav, Shell)
    │   └── ui/         (Toast, Skeleton, EmptyState, IconButton)
    ├── lib/
    │   ├── server/     (sources/YouTubeSource.ts, sources/SaavnSource.ts,
    │   │                sources/types.ts, innertube.ts, cache.ts, http.ts)
    │   ├── client/     (PlayerContext.tsx, db.ts (IndexedDB), settings.ts,
    │   │                lyricsParser.ts, format.ts)
    │   └── types.ts    (Track, QueueState, Lyrics, Source interfaces)
    └── styles/globals.css
```

---

## 8. DEFINITION OF DONE (whole project)
- [ ] All 6 phase gates recorded as DONE in `progress.md`
- [ ] Search → play → seek → queue → lyrics → favorites → playlist → radio: full journey works
- [ ] Automatic source failover demonstrated at least once
- [ ] Zero required API keys / env vars / paid services
- [ ] Production build passes
- [ ] README + progress.md are complete enough for a brand-new agent session to continue maintenance

*— End of plan.md —*
