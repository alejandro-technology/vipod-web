import { randomUUID } from "node:crypto";
import { chmod, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DownloadRequest, MediaInfo } from "@/lib/contracts";
import { ApiFailure } from "./errors";
import { checkAbort, runProcess } from "./process";
import { serverConfig } from "./config";

export function safeBaseName(value: string): string {
  const cleaned = value.normalize("NFKC").replace(/[<>:"/\\|?*\u0000-\u001f]/g, " ").replace(/[. ]+$/g, "").replace(/\s+/g, " ").trim();
  let result = (cleaned || "download").slice(0, 150);
  while (Buffer.byteLength(result) > 180) result = [...result].slice(0, -1).join("");
  return result;
}
export function contentDisposition(fileName: string): string {
  const ascii = fileName.normalize("NFKD").replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}
function metadataPairs(metadata: DownloadRequest["metadata"]): Array<[string, string]> {
  return [["title", metadata.title], ["artist", metadata.artist], ["album", metadata.album], ["album_artist", metadata.albumArtist], ["date", metadata.date], ["genre", metadata.genre], ["track", metadata.trackNumber], ["disc", metadata.discNumber]];
}
export function metadataArgs(metadata: DownloadRequest["metadata"]): string[] {
  return metadataPairs(metadata).flatMap(([key, value]) => ["-metadata", `${key}=${value}`]);
}
type Stream = { codec_type?: string; codec_name?: string; disposition?: { attached_pic?: number }; tags?: Record<string, unknown> };
type Inspection = { streams: Stream[]; format: { duration?: string; tags?: Record<string, unknown> } };
export async function probe(file: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const result = await runProcess(serverConfig.ffprobePath, ["-v", "error", "-protocol_whitelist", "file,pipe", "-show_streams", "-show_format", "-of", "json", file], { timeoutMs: 30_000, maxOutput: 1_000_000, signal });
  if (result.code !== 0) throw new ApiFailure(422, "INVALID_MEDIA", "The processed file is not valid media.");
  try {
    const value = JSON.parse(result.stdout) as Record<string, unknown>;
    if (!value || !Array.isArray(value.streams) || !value.streams.every((stream) => stream && typeof stream === "object") || !value.format || typeof value.format !== "object") throw new Error("Invalid probe shape");
    return value;
  } catch { throw new ApiFailure(422, "INVALID_MEDIA", "The processed file could not be inspected."); }
}

const artworkHostAllowed = (host: string) => ["i.ytimg.com", "img.youtube.com", "coverartarchive.org", "archive.org"].includes(host) || host.endsWith(".archive.org");
function artworkUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiFailure(400, "INVALID_ARTWORK_URL", "The artwork URL is invalid."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port || !artworkHostAllowed(url.hostname.toLowerCase())) throw new ApiFailure(400, "INVALID_ARTWORK_URL", "Artwork must come from an approved HTTPS image host without credentials or a nondefault port.");
  return url;
}
export async function fetchArtwork(request: DownloadRequest, media: MediaInfo, directory: string, signal?: AbortSignal, fetcher: typeof fetch = fetch): Promise<string | undefined> {
  checkAbort(signal);
  const selection = request.metadata.artwork;
  if (selection.source === "none") return undefined;
  const selected = selection.source === "thumbnail" ? selection.url || media.thumbnail : selection.url;
  if (!selected) throw new ApiFailure(422, "ARTWORK_UNAVAILABLE", "The selected artwork could not be resolved.");
  if (selection.source === "thumbnail" && !media.thumbnails.some((thumbnail) => thumbnail.url === selected)) throw new ApiFailure(400, "INVALID_ARTWORK_URL", "Choose artwork from the analyzed video's thumbnails.");
  if (selection.source === "coverart" && !/^https:\/\/coverartarchive\.org\/release\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/front(?:-1200|-500|-250)?$/i.test(selected)) throw new ApiFailure(400, "INVALID_ARTWORK_URL", "Choose the front cover for a valid MusicBrainz release.");
  let current = artworkUrl(selected);
  const fetchSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
  for (let redirects = 0; redirects <= 4; redirects++) {
    checkAbort(signal); fetchSignal.throwIfAborted();
    current = artworkUrl(current.href);
    const response = await fetcher(current, { redirect: "manual", signal: fetchSignal });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location"); await response.body?.cancel();
      if (!location || redirects === 4) break;
      current = artworkUrl(new URL(location, current).href); continue;
    }
    if (!response.ok || !/^image\//i.test(response.headers.get("content-type") || "")) {
      await response.body?.cancel(); throw new ApiFailure(422, "ARTWORK_UNAVAILABLE", "The selected artwork could not be downloaded.");
    }
    const maxBytes = 10 * 1024 * 1024;
    if (Number(response.headers.get("content-length") || 0) > maxBytes) {
      await response.body?.cancel(); throw new ApiFailure(422, "ARTWORK_LIMIT", "The artwork image exceeds the 10 MB limit.");
    }
    if (!response.body) throw new ApiFailure(422, "ARTWORK_UNAVAILABLE", "The selected artwork has no image data.");
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let bytes = 0;
    const abortReader = () => { void reader.cancel(fetchSignal.reason).catch(() => undefined); };
    fetchSignal.addEventListener("abort", abortReader, { once: true });
    try {
      while (true) {
        checkAbort(signal); fetchSignal.throwIfAborted();
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.byteLength;
        if (bytes > maxBytes) throw new ApiFailure(422, "ARTWORK_LIMIT", "The artwork image exceeds the 10 MB limit.");
        chunks.push(value);
      }
    } finally { fetchSignal.removeEventListener("abort", abortReader); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    checkAbort(signal); fetchSignal.throwIfAborted();
    if (!bytes) throw new ApiFailure(422, "ARTWORK_UNAVAILABLE", "The selected artwork is empty.");
    const input = path.join(directory, `.artwork-${randomUUID()}`);
    const converted = path.join(directory, `.artwork-${randomUUID()}.jpg`);
    try {
      await writeFile(input, Buffer.concat(chunks), { mode: 0o600, signal }); checkAbort(signal);
      const result = await runProcess(serverConfig.ffmpegPath, ["-y", "-protocol_whitelist", "file,pipe", "-i", input, "-vf", "scale='min(1000,iw)':-2", "-frames:v", "1", converted], { timeoutMs: 30_000, maxOutput: 100_000, signal });
      if (result.code !== 0) throw new ApiFailure(422, "ARTWORK_INVALID", "The selected artwork is not a supported image.");
      return converted;
    } catch (error) { await unlink(converted).catch(() => undefined); throw error; }
    finally { await unlink(input).catch(() => undefined); }
  }
  throw new ApiFailure(422, "ARTWORK_UNAVAILABLE", "The selected artwork could not be resolved.");
}

function inspectOutput(inspected: Inspection, source: Inspection, request: DownloadRequest, title: string, artwork: boolean): void {
  const audio = inspected.streams.filter((stream) => stream.codec_type === "audio");
  const video = inspected.streams.filter((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1);
  const covers = inspected.streams.filter((stream) => stream.disposition?.attached_pic === 1);
  if (audio.length !== (request.mode === "video" ? 0 : 1) || video.length !== (request.mode === "audio" ? 0 : 1) || covers.length !== (artwork ? 1 : 0)) throw new ApiFailure(422, "INVALID_MEDIA", "The final file does not contain the expected media streams and artwork.");
  if (inspected.streams.length !== audio.length + video.length + covers.length) throw new ApiFailure(422, "INVALID_MEDIA", "The final file contains unexpected streams.");
  if (request.mode === "audio" && request.audioFormat !== "original" && audio[0]?.codec_name !== (request.audioFormat === "mp3" ? "mp3" : "aac")) throw new ApiFailure(422, "INVALID_MEDIA", "The output audio codec does not match the requested format.");
  if (request.mode !== "audio" && video[0]?.codec_name !== source.streams.find((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1)?.codec_name) throw new ApiFailure(422, "INVALID_MEDIA", "The output video codec does not match its source.");
  const duration = Number(inspected.format.duration); const sourceDuration = Number(source.format.duration);
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(sourceDuration) || sourceDuration <= 0 || Math.abs(duration - sourceDuration) > Math.max(0.25, sourceDuration * 0.03)) throw new ApiFailure(422, "INVALID_MEDIA", "The output media duration does not match its source.");
  if (duration > serverConfig.maxDurationSeconds()) throw new ApiFailure(422, "DURATION_LIMIT", "The output media exceeds the configured duration limit.");
  const tags = new Map([...audio.flatMap((stream) => Object.entries(stream.tags ?? {})), ...Object.entries(inspected.format.tags ?? {})].map(([key, value]) => [key.toLowerCase(), String(value)]));
  if (!tags.has("track")) tags.set("track", tags.get("tracknumber") ?? "");
  if (!tags.has("disc")) tags.set("disc", tags.get("discnumber") ?? "");
  for (const [key, value] of metadataPairs({ ...request.metadata, title })) if (value && tags.get(key) !== value) throw new ApiFailure(422, "METADATA_NOT_EMBEDDED", `The ${key.replace("_", " ")} metadata could not be embedded.`);
}

export type FinalizeOptions = { artworkPath?: string; signal?: AbortSignal; maxBytes?: number; beforePublish?: () => Promise<void> };
export async function finalizeMedia(source: string, directory: string, request: DownloadRequest, media: MediaInfo, options: FinalizeOptions = {}): Promise<{ path: string; fileName: string; size: number; probe: Record<string, unknown> }> {
  checkAbort(options.signal);
  const sourceProbe = await probe(source, options.signal);
  const sourceInspection = sourceProbe as Inspection;
  const sourceAudioCodec = sourceInspection.streams.find((stream) => stream.codec_type === "audio")?.codec_name;
  if (!sourceAudioCodec && request.mode !== "video") throw new ApiFailure(422, "INVALID_MEDIA", "The source file does not contain audio.");
  if (!sourceInspection.streams.some((stream) => stream.codec_type === "video" && stream.disposition?.attached_pic !== 1) && request.mode !== "audio") throw new ApiFailure(422, "INVALID_MEDIA", "The source file does not contain video.");
  const sourceDuration = Number(sourceInspection.format.duration);
  if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new ApiFailure(422, "INVALID_MEDIA", "The source media has no valid duration.");
  if (sourceDuration > serverConfig.maxDurationSeconds()) throw new ApiFailure(422, "DURATION_LIMIT", "The source media exceeds the configured duration limit.");
  if (media.duration !== null && Number.isFinite(media.duration) && media.duration > 0 && Math.abs(sourceDuration - media.duration) > Math.max(1, media.duration * 0.03)) throw new ApiFailure(422, "INVALID_MEDIA", "The downloaded media duration does not match the analyzed source.");
  const extension = request.mode === "audio" && request.audioFormat !== "original" ? request.audioFormat : path.extname(source).slice(1).toLowerCase();
  if (request.mode === "audio" && request.audioFormat === "original" && ["opus", "webm", "ogg"].includes(extension) && (request.metadata.artwork.source !== "none" || options.artworkPath)) throw new ApiFailure(422, "ARTWORK_UNSUPPORTED", "Cover artwork is not supported for original WebM/Opus/Ogg files. Choose MP3 or M4A to include a cover.");
  if (!["mp3", "m4a", "mp4", "flac", "opus", "ogg", "webm", "mkv", "mov"].includes(extension)) throw new ApiFailure(422, "METADATA_UNSUPPORTED", "This container cannot reliably preserve the requested metadata. Choose MP3 or M4A for audio.");
  const title = request.metadata.title.trim() ? request.metadata.title : media.music.title || media.title;
  if (!title?.trim()) throw new ApiFailure(400, "INVALID_TITLE", "A title is required to name the output file.");
  const fileName = `${safeBaseName(request.metadata.artist ? `${request.metadata.artist} - ${title}` : title)}.${extension}`;
  const finalPath = path.join(directory, fileName); const temporaryPath = path.join(directory, `.final-${randomUUID()}.${extension}`);
  let artwork = options.artworkPath;
  const generatedArtwork = !artwork && request.mode === "audio" && request.metadata.artwork.source !== "none";
  try {
    if (generatedArtwork) artwork = await fetchArtwork(request, media, directory, options.signal);
    if (artwork && request.mode !== "audio") throw new ApiFailure(422, "ARTWORK_UNSUPPORTED", "Attached cover artwork is only supported for audio outputs.");
    const args = ["-y", "-protocol_whitelist", "file,pipe", "-i", source];
    if (artwork) args.push("-protocol_whitelist", "file,pipe", "-i", artwork, "-map", "0:a:0", "-map", "1:v:0", "-c:v:0", "mjpeg", "-disposition:v:0", "attached_pic");
    else if (request.mode === "audio") args.push("-map", "0:a:0", "-vn");
    if (request.mode !== "audio") args.push("-map", "0:V:0", "-c:v:0", "copy");
    if (request.mode === "combined") args.push("-map", "0:a:0", "-c:a:0", "copy");
    else if (request.mode === "video") args.push("-an");
    else {
      const targetCodec = request.audioFormat === "mp3" ? "mp3" : "aac";
      const transcode = request.audioFormat !== "original" && (sourceAudioCodec !== targetCodec || request.audioQuality !== "best");
      if (!transcode) args.push("-c:a:0", "copy");
      else args.push("-c:a:0", targetCodec === "mp3" ? "libmp3lame" : "aac", "-b:a:0", request.audioQuality === "best" ? (targetCodec === "mp3" ? "320k" : "256k") : `${request.audioQuality}k`);
    }
    args.push("-map_metadata", "-1", ...metadataArgs({ ...request.metadata, title }));
    if (["mp4", "m4a"].includes(extension)) args.push("-movflags", "+faststart");
    args.push(temporaryPath);
    const result = await runProcess(serverConfig.ffmpegPath, args, { timeoutMs: serverConfig.outputTimeoutMs(), maxOutput: 200_000, signal: options.signal });
    if (result.code !== 0) throw new ApiFailure(502, "PROCESSING_FAILED", "The downloaded media could not be finalized.");
    const inspected = await probe(temporaryPath, options.signal);
    inspectOutput(inspected as Inspection, sourceInspection, request, title, Boolean(artwork));
    const info = await stat(temporaryPath);
    if (info.size <= 0) throw new ApiFailure(422, "INVALID_MEDIA", "The final media file is empty.");
    if (info.size > (options.maxBytes ?? serverConfig.maxDownloadBytes())) throw new ApiFailure(413, "FILE_TOO_LARGE", "The processed media exceeds the configured size limit.");
    await chmod(temporaryPath, 0o600); await options.beforePublish?.(); checkAbort(options.signal);
    await rename(temporaryPath, finalPath);
    return { path: finalPath, fileName, size: info.size, probe: inspected };
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
    if (generatedArtwork && artwork) await unlink(artwork).catch(() => undefined);
  }
}

export async function writeInfo(pathName: string, media: MediaInfo, request: DownloadRequest, fileName: string, signal?: AbortSignal): Promise<void> {
  checkAbort(signal);
  try {
    await writeFile(pathName, JSON.stringify({ media, final: { fileName, metadata: request.metadata, mode: request.mode, audioFormat: request.audioFormat } }, null, 2), { encoding: "utf8", mode: 0o600, signal });
    checkAbort(signal);
  } catch (error) { await unlink(pathName).catch(() => undefined); throw error; }
}
