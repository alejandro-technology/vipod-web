import { ApiFailure } from "./errors";
import { runProcess } from "./process";
import { canonicalVideoUrl, validMetadataDate, validMetadataNumber } from "./validation";
import type { MediaFormat, MediaInfo } from "@/lib/contracts";
import { serverConfig } from "./config";

const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) ? value : null;
const textOrNull = (value: unknown): string | null => typeof value === "string" && value.trim() ? value.trim() : null;
const arrText = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").slice(0, 500) : [];
const musicText = (value: unknown): string | null => typeof value === "string" || typeof value === "number" ? String(value).trim() || null : null;
function releaseDate(value: unknown): string | null {
  const date = musicText(value);
  if (!date) return null;
  const compact = date.match(/^(\d{4})(\d{2})(\d{2})$/);
  const normalized = compact ? `${compact[1]}-${compact[2]}-${compact[3]}` : date;
  return validMetadataDate(normalized) ? normalized : null;
}

const PRIVATE_KEYS = /^(url|manifest_url|fragment_base_url|fragments|http_headers|cookies|requested_downloads|requested_formats|webpage_url|original_url|_filename|filename|filepath|protocol_headers)$/i;
export function sanitizeRaw(value: unknown, depth = 0): unknown {
  if (depth > 12) return undefined;
  if (Array.isArray(value)) return value.slice(0, 200).map((entry) => sanitizeRaw(entry, depth + 1)).filter((entry) => entry !== undefined);
  if (!value || typeof value !== "object") return typeof value === "string" ? value.slice(0, 4000) : value;
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>).slice(0, 500)) {
    if (PRIVATE_KEYS.test(key)) continue;
    if (/^(filesize|filesize_approx|content_length)$/i.test(key) && typeof entry === "number") { result[key] = Math.min(entry, 2 ** 40); continue; }
    const sanitized = sanitizeRaw(entry, depth + 1);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  return result;
}

export function normalizeMedia(raw: Record<string, unknown>, url: string): MediaInfo {
  const id = textOrNull(raw.id) ?? new URL(url).searchParams.get("v") ?? "";
  const formats: MediaFormat[] = (Array.isArray(raw.formats) ? raw.formats : []).slice(0, 500).flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const f = item as Record<string, unknown>;
    const formatId = textOrNull(f.format_id); const ext = textOrNull(f.ext);
    if (!formatId || !ext || /storyboard/i.test(`${formatId} ${f.format_note ?? ""}`) || f.vcodec === "images" || f.vcodec === "none" && f.acodec === "none") return [];
    const audioCodec = f.acodec === "none" ? null : textOrNull(f.acodec);
    const videoCodec = f.vcodec === "none" ? null : textOrNull(f.vcodec);
    if (!audioCodec && !videoCodec) return [];
    const type = audioCodec && videoCodec ? "combined" : audioCodec ? "audio" : "video";
    return [{ id: formatId, ext, audioCodec, videoCodec, width: numberOrNull(f.width), height: numberOrNull(f.height), fps: numberOrNull(f.fps), bitrate: numberOrNull(f.tbr), audioBitrate: numberOrNull(f.abr), sampleRate: numberOrNull(f.asr), filesize: numberOrNull(f.filesize), filesizeApprox: numberOrNull(f.filesize_approx), note: textOrNull(f.format_note) ?? textOrNull(f.resolution) ?? ext, type }];
  });
  const thumbnailEntries = Array.isArray(raw.thumbnails) ? raw.thumbnails : [];
  const thumbnails = thumbnailEntries.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const t = item as Record<string, unknown>;
    const imageUrl = textOrNull(t.url);
    if (!imageUrl || !/^https:\/\/(?:i\.ytimg\.com|img\.youtube\.com)\//i.test(imageUrl)) return [];
    return [{ url: imageUrl, ...(numberOrNull(t.width) ? { width: numberOrNull(t.width)! } : {}), ...(numberOrNull(t.height) ? { height: numberOrNull(t.height)! } : {}) }];
  }).slice(-30);
  const music: Record<string, string> = {};
  for (const [contractKey, rawKey] of [["title", "track"], ["artist", "artist"], ["album", "album"], ["albumArtist", "album_artist"], ["genre", "genre"]] as const) {
    const value = musicText(raw[rawKey]); if (value) music[contractKey] = value;
  }
  const date = releaseDate(raw.release_date ?? raw.release_year);
  const trackNumber = musicText(raw.track_number ?? raw.track_number_raw);
  const discNumber = musicText(raw.disc_number ?? raw.disc_number_raw);
  if (date) music.date = date;
  if (trackNumber && validMetadataNumber(trackNumber)) music.trackNumber = trackNumber;
  if (discNumber && validMetadataNumber(discNumber, 3)) music.discNumber = discNumber;
  const chapters = Array.isArray(raw.chapters) ? raw.chapters.slice(0, 500).flatMap((chapter) => {
    if (!chapter || typeof chapter !== "object") return [];
    const c = chapter as Record<string, unknown>;
    const start = numberOrNull(c.start_time); const end = numberOrNull(c.end_time);
    return start !== null && end !== null ? [{ title: textOrNull(c.title) ?? "Chapter", start, end }] : [];
  }) : [];
  const subtitles = raw.subtitles && typeof raw.subtitles === "object" ? Object.keys(raw.subtitles as object) : [];
  const automatic = raw.automatic_captions && typeof raw.automatic_captions === "object" ? Object.keys(raw.automatic_captions as object) : [];
  const rawThumbnail = textOrNull(raw.thumbnail);
  const thumb = (rawThumbnail && thumbnails.some((thumbnail) => thumbnail.url === rawThumbnail) ? rawThumbnail : null) ?? thumbnails.at(-1)?.url ?? null;
  return {
    id, url, title: textOrNull(raw.title) ?? "Untitled video", description: (textOrNull(raw.description) ?? "").slice(0, 20_000),
    thumbnail: thumb, thumbnails, duration: numberOrNull(raw.duration), uploader: textOrNull(raw.uploader), channel: textOrNull(raw.channel),
    uploadDate: releaseDate(raw.upload_date), viewCount: numberOrNull(raw.view_count), likeCount: numberOrNull(raw.like_count),
    categories: arrText(raw.categories), tags: arrText(raw.tags), music, formats,
    chapters, subtitleLanguages: [...new Set([...subtitles, ...automatic])].slice(0, 200), raw: sanitizeRaw(raw) as Record<string, unknown>,
  };
}

function ytDlpPath(): string { return serverConfig.ytDlpPath; }
export async function analyzeVideo(input: unknown, options: { signal?: AbortSignal } = {}): Promise<MediaInfo> {
  const url = canonicalVideoUrl(input);
  const args = ["--ignore-config", "--no-plugin-dirs", "--no-playlist", "--no-colors", "--js-runtimes", `node:${process.execPath}`, "--dump-single-json", "--socket-timeout", "20", "--retries", "2", url];
  if (serverConfig.ffmpegLocation) args.splice(4, 0, "--ffmpeg-location", serverConfig.ffmpegLocation);
  const result = await runProcess(ytDlpPath(), args, { timeoutMs: 90_000, maxOutput: 8_000_000, signal: options.signal });
  if (result.code !== 0) {
    const err = result.stderr.toLowerCase();
    if (/private|unavailable|removed|not available/.test(err)) throw new ApiFailure(422, "VIDEO_UNAVAILABLE", "This video is unavailable or private.");
    if (/unable to download|network|timed out|http error/.test(err)) throw new ApiFailure(502, "UPSTREAM_NETWORK", "Could not retrieve video information from YouTube.");
    throw new ApiFailure(502, "ANALYSIS_FAILED", "The video could not be analyzed.");
  }
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(result.stdout) as Record<string, unknown>; if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid response shape"); } catch { throw new ApiFailure(502, "INVALID_TOOL_RESPONSE", "The downloader returned invalid video information."); }
  if (raw.is_live || raw.live_status === "is_live" || raw.live_status === "is_upcoming") throw new ApiFailure(422, "LIVE_UNSUPPORTED", "Live streams and upcoming broadcasts are not supported.");
  const duration = numberOrNull(raw.duration);
  const maxDuration = serverConfig.maxDurationSeconds();
  if (duration !== null && duration > maxDuration) throw new ApiFailure(422, "DURATION_LIMIT", "Videos longer than the configured duration limit are not supported.");
  const media = normalizeMedia(raw, url);
  if (!media.formats.length) throw new ApiFailure(422, "NO_MEDIA_FORMATS", "No downloadable audio or video formats were found.");
  return media;
}
