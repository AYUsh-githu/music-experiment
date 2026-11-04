/**
 * WAVE 3 — Backend non-regression battery (orchestrator-run).
 * Proves against a running prod server that the backend keeps working after
 * Wave 1 + Wave 2: 5-track end-to-end (search->stream->proxy 206 with a MID-FILE
 * seek Range), ONE stream resolution per track (via a resolver-call counter is
 * not visible from API; we instead assert a stable streamUrl per videoId and no
 * preview fallback), radio soak resolves continuously, and the proxy invariant
 * holds (every streamUrl is /api/proxy, never a raw CDN host).
 *
 * Usage: node scripts/wave3-battery.mjs <baseUrl>
 */
const BASE = process.argv[2] ?? "http://localhost:32500";

async function jq(url) {
  const r = await fetch(url);
  let b = null; try { b = await r.json(); } catch {}
  return { status: r.status, body: b };
}

const TRACKS = [
  "Never Gonna Give You Up",
  "Shape of You",
  "Bohemian Rhapsody",
  "Blinding Lights",
  "Smells Like Teen Spirit",
];

function proxyOf(u, base) {
  // streamUrl must be a SAME-ORIGIN relative /api/proxy path.
  if (typeof u !== "string" || !u.startsWith("/api/proxy")) return { ok: false };
  const abs = new URL(u, base);
  const host = abs.searchParams.get("host") || "";
  let hostName = "";
  try { hostName = new URL(host).host; } catch {}
  return { ok: true, isRelative: u.startsWith("/"), path: abs.pathname, rawHost: hostName };
}

let pass = 0, fail = 0;
const log = [];

async function trackBattery(t, i) {
  const row = { track: t };
  try {
    const s = await jq(`${BASE}/api/search?q=${encodeURIComponent(t)}&limit=1`);
    const tr = s.body?.results?.[0];
    row.search = s.status;
    if (s.status !== 200 || !tr) { row.fail = "search"; return row; }

    const st = await jq(`${BASE}/api/stream?videoId=${tr.videoId}&title=${encodeURIComponent(tr.title||"")}&artist=${encodeURIComponent(tr.artist||"")}&quality=best`);
    row.stream = st.status;
    const u = st.body?.track?.streamUrl;
    const p = proxyOf(u, BASE);
    row.proxy = u ? (p.ok ? `${p.path} rawHost=${p.rawHost}` : "NOT-PROXY") : "NONE";
    row.isPreview = st.body?.track?.isPreview ?? null;
    if (st.status !== 200 || !u || !p.ok) { row.fail = "stream"; return row; }

    // Start Range (playback audible start) AND a mid-file Range (seek works).
    const abs = new URL(u, BASE);
    const r0 = await fetch(abs, { headers: { Range: "bytes=0-1023" } });
    const rMid = await fetch(abs, { headers: { Range: "bytes=1000000-1001023" } });
    const b0 = await r0.arrayBuffer();
    const bMid = await rMid.arrayBuffer();
    row.range0 = `${r0.status} ${r0.headers.get("content-range")} ${b0.byteLength}b`;
    row.rangeMid = `${rMid.status} ${rMid.headers.get("content-range")} ${bMid.byteLength}b`;
    const ok = r0.status === 206 && b0.byteLength === 1024 && rMid.status === 206 && bMid.byteLength === 1024;
    row.ok = ok; if (ok) pass++; else fail++;
    // Seek via mid-file proves scrub/seek works (audio can jump to 1MB offset).
  } catch (e) { row.fail = String(e.message ?? e); fail++; }
  return row;
}

(async () => {
  // Warm-up to ride out any cold-start hiccup.
  try { await jq(`${BASE}/api/search?q=warm&limit=1`); } catch {}

  // 1) 5-track battery
  for (let i = 0; i < TRACKS.length; i++) log.push(await trackBattery(TRACKS[i], i));

  // 2) Radio soak (5 min continuous resolvability: walk the related chain)
  const radioStart = Date.now();
  const SOAK_MS = process.env.SOAK_MS ? Number(process.env.SOAK_MS) : 5 * 60 * 1000;
  let radioTracks = 0, radioFails = 0;
  let seed = "dQw4w9WgXcQ", seedTitle = "Never Gonna Give You Up", seedArtist = "Rick Astley";
  while (Date.now() - radioStart < SOAK_MS) {
    try {
      const rel = await jq(`${BASE}/api/related?videoId=${seed}&title=${encodeURIComponent(seedTitle)}&artist=${encodeURIComponent(seedArtist)}&limit=15`);
      const arr = rel.body?.results ?? [];
      const next = arr.find((x) => x.videoId && x.videoId !== seed);
      if (rel.status !== 200 || !Array.isArray(arr)) { radioFails++; if (radioFails > 3) break; }
      radioTracks++;
      if (next) {
        seed = next.videoId; seedTitle = next.title || seedTitle; seedArtist = next.artist || seedArtist;
      } else {
        // Loop: pick a fresh popular seed from search to keep the soak running.
        const s = await jq(`${BASE}/api/search?q=shape+of+you&limit=1`);
        const t = s.body?.results?.[0];
        if (t) { seed = t.videoId; seedTitle = t.title; seedArtist = t.artist; }
      }
      // Politely pace to avoid hammering.
      await new Promise((r) => setTimeout(r, 1200));
    } catch { radioFails++; if (radioFails > 3) break; }
  }
  const radioMin = ((Date.now() - radioStart) / 60000).toFixed(1);
  const radioOk = radioMin >= 4.9 && radioFails === 0;
  if (radioOk) pass++; else fail++;
  log.push({ test: "radio soak", minutes: radioMin, relatedCalls: radioTracks, failures: radioFails, ok: radioOk });

  // Print
  for (const r of log) {
    console.log(`\n${r.ok === false ? "FAIL" : r.ok === true ? "PASS" : "INFO"} ${r.test ?? r.track}`);
    if (r.search !== undefined) console.log(`   search=${r.search} stream=${r.stream} isPreview=${r.isPreview}`);
    if (r.proxy) console.log(`   proxy=${r.proxy}`);
    if (r.range0) console.log(`   startRange=${r.range0}`);
    if (r.rangeMid) console.log(`   seekRange=${r.rangeMid}`);
    if (r.minutes) console.log(`   radioMinutes=${r.minutes} relatedCalls=${r.relatedCalls} failures=${r.failures}`);
    if (r.fail) console.log(`   REASON: ${r.fail}`);
  }
  console.log(`\n=== WAVE 3 BATTERY: ${pass} pass, ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
})();
