"use client";

/**
 * Highlight — match highlighting for search results (WS6).
 *
 * WHY client-side string splitting: §4 forbids `dangerouslySetInnerHTML`, so a
 * match is highlighted by splitting the text into [before, match, after] parts
 * and wrapping each match in a <mark>. The text is rendered as React children,
 * so it is escaped exactly like any other string — an injected `<script>` in a
 * title stays inert text.
 *
 * WHY a context and not a prop: TrackRow/TrackCard are owned by the Browse
 * agent, and threading a `query` prop through TrackList → TrackRow would mean
 * editing three files outside this workstream's ownership. Instead the search
 * page wraps its result list in <Highlight query=…>, and any row that renders a
 * title through <Text> opts in by reading the context. With no provider (every
 * other surface in the app) the value is `""` and the component renders the
 * plain string unchanged, so it costs nothing outside search.
 *
 * A11y: <mark> is a semantic element (it means "highlighted for reference"). We
 * only override its default yellow with a translucent accent wash, keeping the
 * text color inherited from the row so contrast is never reduced and the accent
 * still reads as the active track's color (§4: one accent per viewport).
 */
import { createContext, useContext, type ReactNode } from "react";

const HighlightContext = createContext("");

/** Wraps a subtree so descendants can highlight matches for `query`. */
export default function Highlight({
  query,
  children,
}: {
  query: string;
  children: ReactNode;
}) {
  return <HighlightContext.Provider value={query}>{children}</HighlightContext.Provider>;
}

/** Splits `text` on case-insensitive occurrences of `query`. */
function splitMatch(text: string, query: string): { hit: boolean; value: string }[] {
  if (!query) return [{ hit: false, value: text }];
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const parts: { hit: boolean; value: string }[] = [];
  let cursor = 0;
  let at = lowerText.indexOf(lowerQuery, cursor);
  // Guard against a zero-length query producing an infinite loop (query is
  // already checked above, but defend the loop condition too).
  while (at !== -1 && lowerQuery.length > 0) {
    if (at > cursor) parts.push({ hit: false, value: text.slice(cursor, at) });
    parts.push({ hit: true, value: text.slice(at, at + query.length) });
    cursor = at + query.length;
    at = lowerText.indexOf(lowerQuery, cursor);
  }
  if (cursor < text.length) parts.push({ hit: false, value: text.slice(cursor) });
  return parts;
}

/**
 * Renders `text` with any matches for the ambient query wrapped in <mark>.
 * Returns the bare string when there is no provider or no query.
 *
 * WHY per-part keys of `${index}` and no wrapping spans in the miss case: a
 * plain string child is what React already renders for every other title, so a
 * row with no match stays byte-identical to its non-search markup (no extra
 * DOM, no extra style work). Only the matched runs get elements.
 */
export function Text({ text }: { text: string }) {
  const query = useContext(HighlightContext);
  if (!query) return <>{text}</>;
  const parts = splitMatch(text, query);
  // Nothing matched: render the plain string (identical to the no-provider path).
  if (parts.length === 1 && !parts[0].hit) return <>{text}</>;
  return (
    <>
      {parts.map((part, i) =>
        part.hit ? (
          // `text-inherit` keeps the row's own color (accent for the playing
          // track, text otherwise); the wash is a translucent accent so it
          // reads on both without ever touching text color (contrast).
          <mark
            key={i}
            className="rounded-[3px] bg-accent/25 px-[1px] text-inherit"
          >
            {part.value}
          </mark>
        ) : (
          <span key={i}>{part.value}</span>
        )
      )}
    </>
  );
}
