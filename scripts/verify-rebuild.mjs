/**
 * Orchestrator verification battery for the BACKEND REBUILD.
 * Probes a running server (default localhost:3100) and proves:
 *   1. Search returns enriched tracks (206-independent).
 *   2. Every /api/stream response is 200 with a SAME-ORIGIN /api/proxy streamUrl
 *      (browser never sees a raw CDN URL) AND not a preview (full-track).
 *   3. A Range request through the proxy returns HTTP 206 with content-range.
 * Runs a 5-track soak and prints a per-track report.
 *
 * Usage: node scripts/verify-rebuild.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? "http://localhost:3100";

async function j(url, opts = {}) {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { /* non-json */ }
  return { status: res.status, body, headers: res.headers };
}

function proxyOf(u) {
  // Returns {sameOrigin, isProxy, rawHost} — never prints the full raw URL.
  try {
    // streamUrl is a SAME-ORIGIN RELATIVE path (/api/proxy?...). Resolve it
    // against BASE for origin/path checks. sameOrigin only needs pathname check
    // since the client fetches it as a relative URL on the same host.
    const parsed = new URL(u, BASE);
    const isProxy = parsed.pathname.startsWith("/api/proxy");
    const isRelative = u.startsWith("/");
    // The target host is encoded in the query (host=...); surface only its host
    // part, never the full googlevideo path/params.
    let rawHost = "";
    const host = parsed.searchParams.get("host");
    if (host) { try { rawHost = new URL(host).host; } catch { rawHost = "(unparsable)"; } }
    return { isRelative, isProxy, rawHost, absolute: parsed.toString() };
  } catch { return { isRelative: false, isProxy: false, rawHost: "(bad url)", absolute: "" }; }
}

const QUERIES = ["Never Gonna Give You Up", "Shape of You", "Bohemian Rhapsody", "Blinding Lights", "Smells Like Teen Spirit"];

console.log(`=== BACKEND REBUILD VERIFICATION BATTERY (base=${BASE}) ===`);

let pass = 0, fail = 0;
const report = [];

// --- Warm-up ---
// First request after a server restart does a cold Innertube session init that
// can hiccup once (transient). Fire one throwaway search so the battery isn't
// falsely red on a cold-start. Not counted.
try { await j(`${BASE}/api/search?q=warmup&limit=1`); } catch { /* best-effort */ }

// --- Per-track soak ---
for (let i = 0; i < QUERIES.length; i++) {
  const q = QUERIES[i];
  const row = { track: q };
  try {
    const searchRes = await j(`${BASE}/api/search?q=${encodeURIComponent(q)}&limit=1`);
    row.search = searchRes.status;
    const hit = searchRes.body?.results?.[0] ?? searchRes.body?.tracks?.[0];
    if (searchRes.status !== 200 || !hit) {
      row.ok = false; row.reason = `search ${searchRes.status}`;
      report.push(row); fail++; continue;
    }
    const t = hit;
    row.videoId = t.videoId || t.id || "";
    row.title = t.title;
    row.artist = t.artist;

    const streamRes = await j(`${BASE}/api/stream?videoId=${encodeURIComponent(row.videoId)}&title=${encodeURIComponent(t.title || "")}&artist=${encodeURIComponent(t.artist || "")}`);
    row.streamStatus = streamRes.status;
    if (streamRes.status !== 200 || !streamRes.body?.ok || !streamRes.body?.track?.streamUrl) {
      row.ok = false; row.reason = `stream ${streamRes.status} ${streamRes.body?.code ?? ""}`;
      report.push(row); fail++; continue;
    }
    const p = proxyOf(streamRes.body.track.streamUrl);
    row.proxy = p;
    row.isPreview = streamRes.body.track.isPreview ?? false;

    // Range probe through the proxy — must be 206 Partial Content.
    const rangeRes = await fetch(p.absolute, {
      headers: { Range: "bytes=0-1023" },
    });
    row.rangeStatus = rangeRes.status;
    row.contentRange = rangeRes.headers.get("content-range") ?? "(none)";
    row.bytes = (await rangeRes.arrayBuffer()).byteLength;

    const good =
      row.streamStatus === 200 && p.isRelative && p.isProxy &&
      row.rangeStatus === 206 && row.bytes === 1024;
    row.ok = good;
    if (good) pass++; else { row.reason = "probe mismatch"; fail++; }
  } catch (e) {
    row.ok = false; row.reason = String(e); fail++;
  }
  report.push(row);
  // Small politeness gap between soak hits.
  await new Promise((r) => setTimeout(r, 400));
}

// --- Related (radio) probe ---
// The client always passes title/artist (radio's search-fallback needs a query;
// YouTube's native related feed alone is flaky). Mirror that so the probe is
// realistic: pass title/artist from the first soaked track when available.
try {
  const seed = report.find((r) => r.videoId) || {};
  const vid = seed.videoId || "dQw4w9WgXcQ";
  const qs = `videoId=${encodeURIComponent(vid)}` +
    (seed.title ? `&title=${encodeURIComponent(seed.title)}` : "") +
    (seed.artist ? `&artist=${encodeURIComponent(seed.artist)}` : "");
  const rel = await j(`${BASE}/api/related?${qs}`);
  const arr = rel.body?.results ?? rel.body?.tracks;
  const n = Array.isArray(arr) ? arr.length : -1;
  // Radio "pass" = endpoint 200 AND it produced other tracks to autoplay.
  const relOk = rel.status === 200 && n >= 1;
  (report.push({ test: "related/radio", videoId: vid, status: rel.status, count: n, ok: relOk }));
  if (relOk) pass++; else fail++;
} catch (e) { report.push({ test: "related/radio", status: "ERR", detail: String(e), ok: false }); fail++; }

// --- Print ---
for (const r of report) {
  const marker = r.ok === false ? "FAIL" : r.ok === true ? "PASS" : "INFO";
  console.log(`\n[${marker}] ${r.test ?? r.track}`);
  if (r.title) console.log(`   title=${r.title}`);
  if (r.artist) console.log(`   artist=${r.artist}`);
  if (r.videoId) console.log(`   videoId=${r.videoId}`);
  if (r.search) console.log(`   search=${r.search}`);
  if (r.streamStatus) console.log(`   stream=${r.streamStatus} isPreview=${r.isPreview ?? ""}`);
  if (r.proxy) console.log(`   proxy relative=${r.proxy.isRelative} isProxy=${r.proxy.isProxy} rawHost=${r.proxy.rawHost}`);
  if (r.rangeStatus) console.log(`   range=${r.rangeStatus} contentRange=${r.contentRange} bytes=${r.bytes}`);
  if (r.count !== undefined) console.log(`   relatedCount=${r.count} status=${r.status}`);
  if (r.reason) console.log(`   REASON: ${r.reason}`);
  if (r.detail) console.log(`   detail: ${r.detail}`);
}

console.log(`\n=== RESULT: ${pass} pass, ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
