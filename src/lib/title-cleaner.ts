/**
 * Clean YouTube video titles and format them into clean artist and song names
 * suitable for search engines like MusicBrainz.
 */

const NOISE_WORDS = new Set([
  "official", "officiel", "music", "video", "vídeo", "audio", "lyric", "lyrics",
  "visualizer", "clip", "videoclip", "oficial", "letra", "full", "song", "version",
  "album", "hd", "hq", "4k", "1080p", "remaster", "remastered", "remasterizado",
  "con", "en", "de", "del",
]);

function isNoiseBracketContent(content: string): boolean {
  const trimmed = content.trim().toLowerCase();
  if (!trimmed) return true;
  if (/^(?:4k|hd|hq|1080p|720p|remaster(?:ed)?|remasterizado|\d{4}\s*remaster(?:ed)?)$/i.test(trimmed)) {
    return true;
  }
  const words = trimmed.split(/[\s,/-]+/).filter(Boolean);
  return words.length > 0 && words.every((word) => /^\d+$/.test(word) || NOISE_WORDS.has(word));
}

const TRAILING_NOISE_PATTERN =
  /\s*\|\s*(?:official\s+music\s+video|official\s+video|video\s+oficial|audio\s+oficial|audio|visualizer|lyric\s+video|vevo|album\s+track|un\s+verano\s+sin\s+ti|.*topic).*$/i;

const COMMON_SEPARATORS = /\s+(?:[-–—]|:\s+|•)\s+/;

export type CleanedTitleResult = {
  cleaned: string;
  artist: string | null;
  title: string;
};

/**
 * Strips YouTube-specific noise (like "(Official Video)", "[HD]", "| Vevo")
 * and extracts artist and track title when separated by a hyphen or dash.
 */
export function cleanYouTubeTitle(rawTitle: string): CleanedTitleResult {
  if (!rawTitle || typeof rawTitle !== "string") {
    return { cleaned: "", artist: null, title: "" };
  }

  let text = rawTitle.trim();

  // Strip trailing noise after pipe (often album or channel branding)
  text = text.replace(TRAILING_NOISE_PATTERN, "");

  // Strip bracketed noise (e.g. "(Official Video)", "[Remastered 2021]", "(Official Video Remastered)")
  text = text.replace(/\s*[([{\u3010]([^)\]}\u3011]+)[)\]}\u3011]/g, (match, inner: string) => {
    return isNoiseBracketContent(inner) ? "" : match;
  });

  // Strip featured artists in parenthesis or brackets like "(feat. Dr. Dre)" or "[ft. Artist]"
  text = text.replace(/\s*[([{\u3010](?:feat\.?|ft\.?|featuring)\s+[^)\]}\u3011]+[)\]}\u3011]/gi, "");

  // Strip trailing "ft. Artist" or "feat. Artist"
  text = text.replace(/\s+(?:feat\.?|ft\.?|featuring)\s+.+$/i, "");

  // Normalize quotes and whitespace
  text = text.replace(/["“”«»]/g, "").replace(/\s+/g, " ").trim();

  // Check if title has standard Artist - Title separator
  const separatorMatch = text.match(COMMON_SEPARATORS);
  if (separatorMatch && separatorMatch.index !== undefined) {
    const artistPart = text.slice(0, separatorMatch.index).trim();
    const titlePart = text.slice(separatorMatch.index + separatorMatch[0].length).trim();

    if (artistPart && titlePart) {
      return {
        cleaned: `${artistPart} - ${titlePart}`,
        artist: artistPart,
        title: titlePart,
      };
    }
  }

  return {
    cleaned: text,
    artist: null,
    title: text,
  };
}

/**
 * Checks if a string token is only punctuation/symbols with no letters or numbers.
 */
export function isPunctuationOnly(token: string): boolean {
  return !/[\p{L}\p{N}]/u.test(token);
}

/**
 * Sanitizes a search string into clean alphanumeric terms suitable for search clauses.
 */
export function sanitizeSearchQuery(rawQuery: string): string {
  if (!rawQuery || typeof rawQuery !== "string") return "";

  // First run general YouTube title cleanup
  const { cleaned } = cleanYouTubeTitle(rawQuery);

  // Split into tokens and remove punctuation-only tokens (such as lone hyphens "-")
  const tokens = cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !isPunctuationOnly(t));

  return tokens.join(" ");
}
