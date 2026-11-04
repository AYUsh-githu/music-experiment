/**
 * Check whether iTunes Search results include a streamable previewUrl
 * (30s MP3) — a keyless, reliable audio path that works even when YouTube
 * streaming is blocked and the Saavn fallback is down.
 *
 * Run: npx tsx scripts/smoke-itunes-preview.ts
 */
async function main() {
  const url =
    "https://itunes.apple.com/search?term=shape+of+you&media=music&entity=song&limit=3";
  const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
  const j: any = await res.json();
  console.log(`resultCount=${j.resultCount}`);
  for (const r of j.results ?? []) {
    console.log(
      `- "${r.trackName}" ${r.artistName} | preview=${Boolean(r.previewUrl)} ` +
        `artwork=${r.artworkUrl100 ?? ""?.slice(0, 50)} | duration=${r.trackTimeMillis / 1000}s ` +
        `| collection=${r.collectionName ?? "?"}`
    );
  }
}

main().catch((e) => {
  console.error("FAILED", e?.message ?? e);
  process.exit(1);
});
