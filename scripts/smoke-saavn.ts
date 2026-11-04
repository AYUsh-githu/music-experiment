/**
 * Phase 0/1 smoke test — verify the Saavn fallback source is reachable from
 * this environment. If YouTube stream extraction is blocked (see smoke-yt.ts),
 * the Saavn path is what keeps the app able to actually play audio.
 *
 * Run: npx tsx scripts/smoke-saavn.ts
 */
async function main() {
  const base = "https://saavn.dev/api";
  const q = "shape of you ed sheeran";

  console.log(`GET ${base}/search/songs?query=${encodeURIComponent(q)}`);
  const t0 = Date.now();
  const res = await fetch(`${base}/search/songs?query=${encodeURIComponent(q)}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(15000),
  });
  const ms = Date.now() - t0;
  console.log(`status=${res.status} (${ms}ms)`);

  const body: any = await res.json();
  const results = body?.data?.results ?? [];
  console.log(`results: ${results.length}`);
  const first = results[0];
  if (first) {
    console.log(`first: "${first.name}" by ${(first.artists?.primary?.[0]?.name) ?? "?"}`);
    const dl = first.downloadUrl ?? [];
    console.log(`downloadUrl entries: ${dl.length}`);
    dl.slice(0, 3).forEach((d: any) => console.log(`  quality=${d.quality} link=${d.link?.slice(0, 60)}`));
    console.log(`cover image: ${first.image?.[2]?.link ?? "?"}`);
    console.log(`id: ${first.id}`);
  }
}

main().catch((err) => {
  console.error("FAILED");
  console.error(err);
  process.exit(1);
});
