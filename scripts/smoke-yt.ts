/**
 * Phase 0 smoke test v2 — explore how youtubei.js exposes streamable URLs
 * in THIS environment (many format objects come back url-less and need
 * deciphering / PO-token handling).
 *
 * Run: npx tsx scripts/smoke-yt.ts
 */
import { Innertube } from "youtubei.js";

async function main() {
  const yt = await Innertube.create();
  const search = await yt.search("shape of you ed sheeran");
  const videos = search.videos ?? [];
  const first = videos[0];
  const id = first.id ?? "";
  console.log(`Testing ${first.title} (${id})`);

  const info = await yt.getInfo(id);

  // Inspect the raw streaming_data to learn which formats ship a URL.
  const sd = info.streaming_data as any;
  const all = [...(sd?.adaptive_formats ?? []), ...(sd?.formats ?? [])];
  console.log(`streaming_data present: ${Boolean(sd)}`);
  console.log(`adaptive_formats: ${sd?.adaptive_formats?.length ?? 0}`);
  console.log(`formats: ${sd?.formats?.length ?? 0}`);

  const taggedAudio = all.filter(
    (f: any) => typeof f.mime_type === "string" && f.mime_type.startsWith("audio")
  );
  console.log(`\n--- ${taggedAudio.length} audio formats ---`);
  for (const f of taggedAudio.slice(0, 10)) {
    const keys = Object.keys(f ?? {});
    console.log(
      `itag=${f.itag} mime=${String(f.mime_type ?? "").split(";")[0]} ` +
        `url=${Boolean(f.url)} cipher=${Boolean(f.cipher)} ` +
        `sigCipher=${Boolean(f.signatureCipher || f.signature_cipher)}`
    );
    void keys;
  }

  // Try chooseFormat and dig into the returned object.
  const best = info.chooseFormat({ quality: "best", type: "audio" });
  console.log(`\nchooseFormat picked itag=${best?.itag}`);
  console.log(`best.url =`, best?.url ?? "(empty)");
  if (best) {
    console.log(
      `best fields: url=${Boolean(best.url)} cipher=${Boolean((best as any).cipher)} ` +
        `sigCipher=${Boolean((best as any).signatureCipher)}`
    );
  }

  // Fallback answer: is there ANY audio format with a real URL?
  const withUrl = taggedAudio.find((f: any) => Boolean(f.url));
  console.log(`\nfirst audio with a real URL: itag=${withUrl?.itag} url=${Boolean(withUrl?.url)}`);

  // Report distinct mime types seen (for proxy Content-Type mapping).
  const mimes = [...new Set(taggedAudio.map((f: any) => String(f.mime_type).split(";")[0]))];
  console.log(`audio mime types seen: ${mimes.join(", ")}`);

  console.log("\nDONE");
}

main().catch((err) => {
  console.error("FAILED");
  console.error(err);
  process.exit(1);
});
