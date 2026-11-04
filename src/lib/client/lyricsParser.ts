/**
 * LRC lyrics parser (plan §3.4).
 *
 * WHY this module is intentionally pure (no client-only imports, no DOM, no
 * fetch): it is imported from BOTH the client (NowPlaying synced-lyrics view)
 * and the server API route (/api/lyrics) to parse an LRCLIB `syncedLyrics`
 * string. Keeping it dependency-free means the server can require it safely
 * with zero bundler surprises.
 */

/** One time-synced lyric line. `timeMs` is the timestamp in milliseconds. */
export interface LyricLine {
  timeMs: number;
  text: string;
}

/** Single LRC timestamp tag, e.g. `[00:27.93]` → 27930 ms. */
const LRC_TIMESTAMP_RE = /\[(\d{1,3}):(\d{1,2})(?:\.(\d{1,3}))?\]/g;

/**
 * Parses `text` for LRC timestamp tags and, if followed by any lyric text on
 * the same line, emits one `LyricLine` per timestamp.
 *
 * Supports:
 *   - `[00:27.93] text`
 *   - `[01:02.5][01:05.1] same text`  (multiple timestamps → one line each)
 *   - metadata tags like `[ti:...]`, `[ar:...]`, `[offset:...]` are ignored.
 *
 * Returns `null` when the string contains NO valid sync timestamps (i.e. there
 * is nothing to drive an active-line highlight from) — the caller then falls
 * back to plain lyrics. Lines that carry a tag but no text discard that tag.
 */
export function parseLRC(lrc: string): LyricLine[] | null {
  if (!lrc || typeof lrc !== "string") return null;

  const lines = lrc.split(/\r?\n/);
  const result: LyricLine[] = [];

  for (const rawLine of lines) {
    // Reset lastIndex per line: a shared global regex keeps its .lastIndex
    // across .exec() calls, so we must re-anchor it for every new line.
    LRC_TIMESTAMP_RE.lastIndex = 0;

    const tags: number[] = [];
    const textStart = parseLineTimestamps(rawLine, tags);

    // A valid lyric line needs ≥1 timestamp AND some actual text after it.
    if (tags.length === 0 || textStart === -1) continue;

    const text = rawLine.slice(textStart).trim();
    if (!text) continue;

    for (const timeMs of tags) {
      result.push({ timeMs, text });
    }
  }

  // Re-point `result` at the filtered+sorted array so the length check below
  // reflects what we actually return.
  const clean = result.filter((l) => Number.isFinite(l.timeMs) && l.timeMs >= 0);

  // WHY sort: multi-tag lines (e.g. `[01:05.00][00:25.00] Chorus`) emit entries
  // in document order, which can be out of ascending time order. Downstream
  // (LyricsPanel.tsx) breaks out of active-line highlighting on earlier
  // timestamps, so ascending order is required for synced lyrics to render
  // correctly. Ties keep insertion order: Array#sort is stable in every engine
  // we target, so equal timestamps stay in the order the file listed them.
  clean.sort((a, b) => a.timeMs - b.timeMs);

  return clean.length > 0 ? clean : null;
}

/**
 * Scans a single LRC line for `[mm:ss.xxx]` tags, pushing each timestamp (ms)
 * into `tags`. Returns the index of the first non-tag character, or -1 when the
 * line is made up entirely of tags (no trailing text).
 *
 * WHY a custom scan rather than a single replace: we need BOTH every tag value
 * AND the position where the real text begins, which a plain replace can't give
 * us cleanly.
 */
function parseLineTimestamps(line: string, tags: number[]): number {
  let lastEnd = 0;
  let match: RegExpExecArray | null;

  // The assignment-in-condition is intentional: exec() advances lastIndex per
  // call, and the explicit `!== null` guard keeps it a real condition.
  while ((match = LRC_TIMESTAMP_RE.exec(line)) !== null) {
    const minutes = parseInt(match[1], 10);
    const seconds = parseInt(match[2], 10);
    // Hundredths-of-a-second fraction (optional). "27.93" → 93, ".5" → 5. Normalize
    // up to 3 decimals; any scale above 3 is impossible from the regex.
    const frac = match[3] ? parseFraction(match[3]) : 0;

    tags.push(minutes * 60_000 + seconds * 1_000 + frac);
    lastEnd = LRC_TIMESTAMP_RE.lastIndex;
  }

  // A line that is ONLY tags (e.g. [ti:title] or [00:03.00] with no following
  // text) must not be treated as a lyric. We only consider it a lyric when some
  // non-empty character follows the trailing tag.
  return lastEnd < line.length ? lastEnd : -1;
}

/**
 * Converts a variable-width fractional string to milliseconds. "93" → 93,
 * "5" → 500 (i.e. tenths treated as shorthand for tenths), "234" → 234.
 * A 1-digit fraction is hundredths-of-a-second breadth in LRC; we pad to 3
 * digits so "00:01.5" reads as 1.5s, not 1.05s or 1.005s.
 */
function parseFraction(frac: string): number {
  const padded = frac.padEnd(3, "0").slice(0, 3);
  return parseInt(padded, 10) || 0;
}

/**
 * Formats a duration in milliseconds as `m:ss` (minutes may exceed 9).
 *
 * WHY a shared formatter: the client uses it to label clickable lyric lines
 * and the tests use it to assert parser output. Keeping it here, pure, lets
 * both reuse one definition.
 */
export function formatTimestamp(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
