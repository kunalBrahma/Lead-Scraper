export const MAX_QUERIES = 50_000;

/** Splits a textarea into trimmed, case-insensitively unique lines. */
export function parseLines(text: string): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+/g, ' ');
    const key = line.toLowerCase();
    if (line && !seen.has(key)) {
      seen.add(key);
      lines.push(line);
    }
  }
  return lines;
}

/** Crosses keywords with locations. With no locations, keywords are used as written. */
export function generateQueries(keywords: string[], locations: string[]): string[] {
  const queries = locations.length
    ? keywords.flatMap((keyword) => locations.map((location) => `${keyword} in ${location}`))
    : keywords;
  return [...new Set(queries)];
}

/** English results keep the on-page text the scroller looks for consistent. */
export function buildSearchUrl(query: string): string {
  return `https://www.google.com/maps/search/${encodeURIComponent(query)}/?hl=en`;
}
