/**
 * Sanity check for the F15 lyricsParser fix (WS4). Run:
 *   npx tsx scripts/frontend/parser-check.ts
 *
 * Not part of the build; scripts/** is gitignored for tooling like this. It
 * exists so the sort + finite/non-negative drop can be re-verified in one
 * command rather than by eyeballing a fixture.
 */
import { parseLRC } from "../../src/lib/client/lyricsParser";

let failures = 0;
function check(label: string, cond: boolean): void {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"}  ${label}`);
}

// A deliberately shuffled source: "Second" appears first in the file but is the
// LATEST time; the multi-tag line must emit once per tag, both in place.
const shuffled =
  "[00:30.00] Second\n[00:10.00][00:50.00] Multi\n[ti:ignore]\n[00:20.50] Third\n[00:05.00] First";
const out = parseLRC(shuffled) ?? [];
const times = out.map((l) => l.timeMs);

console.log("parsed:", JSON.stringify(out));
check("emits one line per tag (5 tags)", times.length === 5);
check(
  "ascending by timeMs",
  times.every((v, i, a) => i === 0 || a[i - 1] <= v),
);
check("no NaN / negative times", times.every((t) => Number.isFinite(t) && t >= 0));
check(
  "exact sorted order",
  JSON.stringify(times) === JSON.stringify([5000, 10000, 20500, 30000, 50000]),
);
check("plain text (no tags) -> null", parseLRC("just words\nno tags") === null);
check("empty string -> null", parseLRC("") === null);
check(
  "stable order for equal timestamps",
  JSON.stringify(
    (parseLRC("[00:10.00] A\n[00:10.00] B") ?? []).map((l) => l.text),
  ) === JSON.stringify(["A", "B"]),
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
