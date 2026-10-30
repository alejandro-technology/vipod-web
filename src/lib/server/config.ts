import path from "node:path";

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = value ? Number(value) : fallback;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const serverConfig = {
  get ytDlpPath() { return process.env.YT_DLP_PATH || "yt-dlp"; },
  get ffmpegPath() { return process.env.FFMPEG_PATH || "ffmpeg"; },
  get ffprobePath() { return process.env.FFPROBE_PATH || "ffprobe"; },
  get ffmpegLocation() { return process.env.FFMPEG_LOCATION || process.env.FFMPEG_PATH; },
  dataDirectory: () => path.resolve(process.env.DATA_DIR || path.join(process.cwd(), ".vipod-data")),
  maxDownloadBytes: () => process.env.MAX_DOWNLOAD_MB
    ? positiveNumber(process.env.MAX_DOWNLOAD_MB, 2048) * 1024 * 1024
    : positiveNumber(process.env.MAX_DOWNLOAD_BYTES, 2 * 1024 ** 3),
  maxDurationSeconds: () => positiveNumber(process.env.MAX_DURATION_SECONDS, positiveNumber(process.env.MAX_VIDEO_DURATION_SECONDS, 4 * 60 * 60)),
  jobTtlHours: () => positiveNumber(process.env.JOB_TTL_HOURS, 24),
  downloadTimeoutMs: () => positiveNumber(process.env.DOWNLOAD_TIMEOUT_MS, 30 * 60_000),
  outputTimeoutMs: () => positiveNumber(process.env.OUTPUT_TIMEOUT_MS, 30 * 60_000),
};

export function ttlMs(): number {
  return serverConfig.jobTtlHours() * 60 * 60 * 1000;
}
