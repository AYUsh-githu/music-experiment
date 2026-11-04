/**
 * Phase 0/1 smoke test — check which keyless sources are actually reachable
 * and which can deliver streamable audio FROM THIS ENVIRONMENT.
 *
 * Queries the plan's data sources and reports what works. This drives the
 * Phase 1 architecture decision (source priority + failover).
 *
 * Run: npx tsx scripts/smoke-connectivity.ts
 */
const targets = [
  { name: "itunes-search", url: "https://itunes.apple.com/search?term=shape+of+you&media=music&entity=song&limit=3" },
  { name: "deezer-search", url: "https://api.deezer.com/search?q=shape%20of%20you" },
  { name: "lrclib", url: "https://lrclib.net/api/search?q=shape+of+you" },
  { name: "saavn.dev", url: "https://saavn.dev/api/search/songs?query=shape+of+you" },
];

async function probe(name: string, url: string) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const ctype = res.headers.get("content-type") ?? "";
    let sample = "";
    if (ctype.includes("json")) {
      const j: any = await res.json();
      sample = summarize(name, j);
    }
    console.log(`${name.padEnd(16)} status=${res.status} ✅ (${sample})`);
  } catch (err: any) {
    console.log(`${name.padEnd(16)} status=ERR ❌ ${err?.message ?? err}`);
  }
}

function summarize(name: string, j: any): string {
  if (name === "itunes-search") return `${j?.resultCount ?? 0} results; first has preview=${Boolean(j?.results?.[0]?.previewUrl)}`;
  if (name === "deezer-search") return `${j?.total ?? j?.data?.length ?? 0} results; preview=${Boolean(j?.data?.[0]?.preview)}`;
  if (name === "lrclib") return `${Array.isArray(j) ? j.length : 0} hits`;
  if (name === "saavn.dev") return `${j?.data?.results?.length ?? 0} results`;
  return "";
}

async function main() {
  for (const t of targets) await probe(t.name, t.url);
  console.log("\nDONE");
}

main();
