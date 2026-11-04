/**
 * Shared title/artist cleaning helpers used by the streaming-fallback chain.
 *
 * WHY this module exists: source-native titles from YouTube carry clutter that
 * breaks matching against Saavn and iTunes — e.g. "Song Name (Official Video)",
 * "Song Name ft. Other Artist". Both downstream lookup backends search on a
 * `<title> <artist>` query string, so stripping these marketing suffixes and
 * featuring-partner suffixes up front is what lets a fallback source actually
 * find the same recording. Keeping the cleaning in one const-source module
 * (shared by SaavnSource.resolveStreamFor and the /api/stream route) guarantees
 * every fallback search uses the identical normalization.
 */

/** Pattern matching the most common YouTube/official-video tag clutter. */
const TITLE_SUFFIX = /\s*\((official (music )?video|official audio|official.*?video|lyrics|remix|official visualizer)\)\s*$/i;

/** Audio "(Official Audio)", Apple/Spotify "[Live]" variants. */
const TITLE_SUFFIX_BRACKET = /\s*\[(live|official audio|official music video|official video)\]+\s*$/i;

/**
 * Strips trailing tag clutter from a song title.
 *
 * WHY broad but conservative: we only remove *trailing* parenthesized/bracketed
 * tags, never text inside the real title, so an untagged title passes through
 * untouched. Matching is case-insensitive so "(OFFICIAL VIDEO)" and
 * "(official video)" are handled identically.
 */
export function cleanTitle(title: string): string {
  let t = title.trim();
  t = t.replace(TITLE_SUFFIX, "").trim();
  t = t.replace(TITLE_SUFFIX_BRACKET, "").trim();
  return t;
}

/** Pattern for a featuring-artist clause and its leading separator. */
const FEAT_PATTERN =
  /\s(ft\.?|feat\.?\s*|featuring)\s+.+$/i;

/**
 * Strips a " ft. X" / " feat. X" clause from an artist string.
 *
 * WHY: search match quality benefits from the primary artist only — the
 * featured partner is often spelled differently across catalogues and hurts the
 * match. We cut from the first featuring marker to the end, leaving the main
 * artist as the query.
 */
export function cleanArtist(artist: string): string {
  return artist.trim().replace(FEAT_PATTERN, "").trim();
}

/**
 * Builds the canonical `<title> <artist>` search query for a track, cleaned.
 *
 * WHY: Saavn search and iTunes search both key off a single query string. This
 * returns a normalized, deduplicated-looking query so that (a) different
 * sources search identically, and (b) the Saavn resolve cache (keyed on this
 * string) stays stable across calls carrying slightly messy titles.
 */
export function cleanTrackQuery(track: {
  title: string;
  artist: string;
}): string {
  const t = cleanTitle(track.title);
  const a = cleanArtist(track.artist);
  const query = `${t} ${a}`.trim();
  return query || "";
}