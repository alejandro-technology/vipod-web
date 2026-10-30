import { z } from "zod";
import type { DownloadRequest, MediaInfo } from "@/lib/contracts";
import { ApiFailure } from "./errors";

const ID = /^[A-Za-z0-9_-]{11}$/;
export function validMetadataDate(value: string): boolean {
  if (!value) return true;
  if (!/^[1-9]\d{3}(?:-\d{2}(?:-\d{2})?)?$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  if (month !== undefined && (month < 1 || month > 12)) return false;
  return day === undefined || (day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate());
}
export function validMetadataNumber(value: string, digits = 4): boolean {
  if (!value) return true;
  if (!new RegExp(`^[1-9]\\d{0,${digits - 1}}(?:/[1-9]\\d{0,${digits - 1}})?$`).test(value)) return false;
  const [number, total] = value.split("/").map(Number);
  return total === undefined || number <= total;
}
export function canonicalVideoUrl(input: unknown): string {
  if (typeof input !== "string" || input.length > 2048) throw new ApiFailure(400, "INVALID_URL", "Provide a valid YouTube video URL.");
  let url: URL;
  try { url = new URL(input); } catch { throw new ApiFailure(400, "INVALID_URL", "Provide a valid YouTube video URL."); }
  const authority = input.match(/^https:\/\/([^/?#]*)/i)?.[1] ?? "";
  if (url.protocol !== "https:" || url.username || url.password || url.port || /:\d+$/.test(authority)) throw new ApiFailure(400, "INVALID_URL", "Only HTTPS YouTube video links are supported.");
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  let id: string | null = null;
  if (host === "youtu.be" && /^\/[^/]+\/?$/.test(url.pathname)) id = url.pathname.split("/")[1];
  if (["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com"].includes(host)) {
    if (url.pathname === "/watch") id = url.searchParams.get("v");
    else {
      const match = url.pathname.match(/^\/(?:shorts|live)\/([^/]+)\/?$/);
      if (match) id = match[1];
    }
  }
  if (!id || !ID.test(id)) throw new ApiFailure(400, "INVALID_URL", "The URL must identify one YouTube video.");
  return `https://www.youtube.com/watch?v=${id}`;
}

const metadataSchema = z.object({
  title: z.string().max(500).refine((value) => value.trim().length > 0), artist: z.string().max(500), album: z.string().max(500),
  albumArtist: z.string().max(500), date: z.string().max(10).refine(validMetadataDate), genre: z.string().max(250),
  trackNumber: z.string().max(9).refine((value) => validMetadataNumber(value)), discNumber: z.string().max(7).refine((value) => validMetadataNumber(value, 3)),
  artwork: z.object({ source: z.enum(["thumbnail", "coverart", "none"]), url: z.string().max(2048).optional() }).strict(),
}).strict();
export const downloadRequestSchema = z.object({
  url: z.string().max(2048), mode: z.enum(["audio", "video", "combined"]),
  audioFormat: z.enum(["m4a", "mp3", "original"]), audioQuality: z.enum(["best", "192", "256", "320"]),
  formatId: z.string().max(64).regex(/^[\w.-]+$/).optional(), audioFormatId: z.string().max(64).regex(/^[\w.-]+$/).optional(),
  metadata: metadataSchema, includeInfoJson: z.boolean(), keepInLibrary: z.boolean().optional(),
}).strict();
export function parseDownloadRequest(value: unknown): DownloadRequest {
  const parsed = downloadRequestSchema.safeParse(value);
  if (!parsed.success) throw new ApiFailure(400, "INVALID_REQUEST", "The download request is invalid.");
  return { ...parsed.data, url: canonicalVideoUrl(parsed.data.url) };
}
export function validateFormatRequest(request: DownloadRequest, media: MediaInfo): void {
  const selected = (id: string | undefined) => id ? media.formats.find((format) => format.id === id) : undefined;
  if (request.mode === "audio") {
    const format = selected(request.formatId);
    if (request.audioFormatId) throw new ApiFailure(400, "INVALID_FORMAT", "Audio mode accepts one combined or audio format ID.");
    if (request.formatId && (!format || format.type === "video")) throw new ApiFailure(400, "INVALID_FORMAT", "The selected audio format is unavailable.");
  } else if (request.mode === "video") {
    const format = selected(request.formatId);
    if (request.audioFormatId) throw new ApiFailure(400, "INVALID_FORMAT", "Video mode accepts only a video format ID.");
    if (request.formatId && (!format || format.type !== "video")) throw new ApiFailure(400, "INVALID_FORMAT", "Choose a video-only format for video mode.");
  } else {
    const video = selected(request.formatId);
    const audio = selected(request.audioFormatId);
    if (request.formatId && !video) throw new ApiFailure(400, "INVALID_FORMAT", "The selected format is unavailable.");
    if (request.audioFormatId && (!audio || audio.type !== "audio")) throw new ApiFailure(400, "INVALID_FORMAT", "The selected audio format is unavailable.");
    if (video && video.type !== "video" && request.audioFormatId) throw new ApiFailure(400, "INVALID_FORMAT", "A separate audio ID can only accompany a video-only ID or automatic video.");
  }
}

export function formatSelector(request: DownloadRequest, media: MediaInfo): string {
  validateFormatRequest(request, media);
  if (request.mode === "audio") return request.formatId ?? (request.audioFormat === "m4a" ? "bestaudio[acodec^=mp4a]/bestaudio/best" : "bestaudio/best");
  if (request.mode === "video") return request.formatId ?? "bestvideo";
  if (request.formatId && request.audioFormatId) return `${request.formatId}+${request.audioFormatId}`;
  if (request.audioFormatId) return `bestvideo+${request.audioFormatId}`;
  if (request.formatId) {
    const format = media.formats.find((format) => format.id === request.formatId)!;
    if (format.type === "combined") return request.formatId;
    if (format.type === "audio") return `bestvideo+${request.formatId}`;
    return `${request.formatId}+bestaudio`;
  }
  return "bestvideo+bestaudio/best";
}
