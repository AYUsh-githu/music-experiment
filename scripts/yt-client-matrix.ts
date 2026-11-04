/**
 * Wave 4 audit fix — YouTube client matrix diagnostic (standalone).
 * NOT part of the Next build; excluded from tsconfig already (scripts/ has its own tsconfig).
 *
 * Goal: find a youtubei.js client that returns NON-EMPTY audio stream URLs.
 * For each viable client we create a session and call getInfo, then count:
 *   - #formats returned (streaming_data adaptive_formats)
 *   - #audio-only formats
 *   - whether any audio format carries a non-empty `url`
 *   - the URL length (of the first audio-with-url)
 *   - any HTTP/error raised
 *
 * Run: npx tsx scripts/yt-client-matrix.ts
 *
 * IMPORTANT: results here are diagnostic only. getStream() in the app must never
 * return an empty/url-less response — it throws STREAM_UNAVAILABLE so the resolver
 * fails over. This script only tells us WHICH client (if any) is worth adopting.
 */
import { Innertube } from "youtubei.js";
import { ClientType } from "youtubei.js"; // client enum in 18.3.0

/**
 * NOTE: getInfo() parses the watch-next back-half, which throws for non-WEB
 * mobile clients ("Cannot read properties of null (reading 'as')") even when the
 * player/streaming data succeeded. This diagnostic therefore uses getBasicInfo()
 * (no watch-next parsing) to read streaming_data so mobile clients that DO return
 * non-empty URLs (IOS, ANDROID_VR) are surfaced correctly.
 */

/** The candidate clients to probe. */
const CLIENTS: { label: string; type: ClientType }[] = [
  { label: "WEB", type: ClientType.WEB },
  { label: "MWEB", type: ClientType.MWEB },
  { label: "IOS", type: ClientType.IOS },
  { label: "ANDROID", type: ClientType.ANDROID },
  { label: "ANDROID_VR", type: ClientType.ANDROID_VR },
  { label: "MUSIC(WEB_REMIX)", type: ClientType.MUSIC },
  { label: "ANDROID_MUSIC", type: ClientType.ANDROID_MUSIC },
  { label: "TVHTML5", type: ClientType.TV },
  { label: "TV_SIMPLY", type: ClientType.TV_SIMPLY },
  { label: "WEB_EMBEDDED", type: ClientType.WEB_EMBEDDED },
];

/** Known-good YouTube video IDs to probe. */
const VIDEO_IDS = [
  { id: "dQw4w9WgXcQ", note: "Rick Astley — Never Gonna Give You Up" },
  { id: "kJQP7kiw5Fk", note: "Luis Fonsi — Despacito" },
  { id: "hT_nvWreIhg", note: "OneRepublic — Counting Stars" },
];

type ClientResult = {
  client: string;
  videoId: string;
  formats: number;
  audioFormats: number;
  audioWithUrl: number;
  firstUrlLength: number;
  firstUrl: string;
  firstMime: string;
  error: string;
};

async function probeClient(clientLabel: string, type: ClientType, videoId: string): Promise<ClientResult> {
  const base: ClientResult = {
    client: clientLabel,
    videoId,
    formats: 0,
    audioFormats: 0,
    audioWithUrl: 0,
    firstUrlLength: 0,
    firstUrl: "",
    firstMime: "",
    error: "",
  };
  try {
    const yt = await Innertube.create({ client_type: type });
    // getBasicInfo (not getInfo) — avoids the watch-next cast error on mobile
    // clients and still returns streaming_data + chooseFormat.
    const info = await yt.getBasicInfo(videoId);
    // Raw streaming_data.
    const sd = (info as any).streaming_data;
    const adaptive = sd?.adaptive_formats ?? [];
    const formats = sd?.formats ?? [];
    const all = [...adaptive, ...formats];
    base.formats = all.length;

    const audioFormats = all.filter((f: any) =>
      String(f?.mime_type ?? f?.mimeType ?? "").startsWith("audio")
    );
    base.audioFormats = audioFormats.length;

    // Pick first audio format that carries a non-empty `url`.
    const withUrl = audioFormats.find((f: any) => Boolean(f?.url) && String(f.url).length > 0);
    if (withUrl) {
      const audio = audioFormats.filter((f: any) => Boolean(f?.url) && String(f.url).length > 0);
      base.audioWithUrl = audio.length;
      base.firstUrl = (withUrl as any).url ?? "";
      base.firstUrlLength = String((withUrl as any).url ?? "").length;
      base.firstMime = String(withUrl?.mime_type ?? withUrl?.mimeType ?? "").split(";")[0];
    }
  } catch (err: any) {
    base.error = `${err?.message ?? String(err)}`.slice(0, 200);
  }
  return base;
}

function pad(s: string, w: number): string {
  s = s ?? "";
  return s.padEnd(w);
}

async function main() {
  console.log("== YouTube client matrix ==");
  console.log(
    "NOTE: vox (youtubei.js) 18.3.0 is installed. client_type selects the InnerTube client. A PO-Token/visitor_data may be needed for these clients to return urls.\n"
  );

  const header = [
    pad("client", 20),
    pad("video", 12),
    pad("formats", 8),
    pad("audio", 6),
    pad("audio+url", 9),
    pad("urlLen", 7),
    "first audio mime | error",
  ].join("");
  console.log(header);
  console.log("-".repeat(header.length));

  const results: ClientResult[] = [];
  for (const { label, type } of CLIENTS) {
    for (const { id } of VIDEO_IDS) {
      const r = await probeClient(label, type, id);
      results.push(r);
      console.log(
        [
          pad(r.client, 20),
          pad(r.videoId, 12),
          pad(String(r.formats), 8),
          pad(String(r.audioFormats), 6),
          pad(String(r.audioWithUrl), 9),
          pad(String(r.firstUrlLength), 7),
          pad((r.firstMime || "-") + (r.error ? " | " + r.error : ""), 30),
        ].join("")
      );
    }
  }

  // Summary: which clients produced at least one non-empty audio url?
  console.log("\n== Summary ==");
  const working = results.filter((r) => r.audioWithUrl > 0);
  if (working.length === 0) {
    console.log("NO client produced a non-empty audio URL. YouTube audio streams remain PO-Token blocked.");
  } else {
    const byClient = new Map<string, number>();
    for (const r of working) byClient.set(r.client, (byClient.get(r.client) ?? 0) + 1);
    console.log("Clients with >=1 non-empty audio URL:");
    for (const [c, n] of byClient) console.log(`  ${c}: ${n}/${VIDEO_IDS.length} videos`);
  }
}

main()
  .catch((err) => {
    console.error("MATRIX SCRIPT FAILED");
    console.error(err);
    process.exit(1);
  });
