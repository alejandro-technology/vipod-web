import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { normalizeMedia, sanitizeRaw } from "../src/lib/server/analyze";
import { contentDisposition, finalizeMedia, metadataArgs, safeBaseName } from "../src/lib/server/media";
import { runProcess, splitCompleteLines } from "../src/lib/server/process";
import { canonicalVideoUrl, formatSelector, parseDownloadRequest, validateFormatRequest } from "../src/lib/server/validation";
import { createJobManager } from "../src/lib/server/jobs";

test("canonical video URLs accept supported forms and reject playlist-only or hostile URLs", () => {
  assert.equal(canonicalVideoUrl("https://youtu.be/abcdefghijk?t=2&list=PL"), "https://www.youtube.com/watch?v=abcdefghijk");
  assert.equal(canonicalVideoUrl("https://music.youtube.com/watch?v=abcdefghijk&list=PL"), "https://www.youtube.com/watch?v=abcdefghijk");
  assert.equal(canonicalVideoUrl("https://www.youtube.com/shorts/abcdefghijk?feature=share"), "https://www.youtube.com/watch?v=abcdefghijk");
  for (const url of ["http://youtube.com/watch?v=abcdefghijk", "https://youtube.com/playlist?list=PL", "https://youtube.com.evil.test/watch?v=abcdefghijk", "https://user@youtube.com/watch?v=abcdefghijk", "https://youtube.com:443/watch?v=abcdefghijk", "https://youtube.com/watch?v=short"]) {
    assert.throws(() => canonicalVideoUrl(url));
  }
});

test("normalization labels media streams and recursively removes transport data", () => {
  const media = normalizeMedia({ id: "abcdefghijk", title: "Title", uploader: "Channel not artist", formats: [
    { format_id: "a", ext: "m4a", acodec: "aac", vcodec: "none", filesize: 20 },
    { format_id: "v", ext: "mp4", acodec: "none", vcodec: "avc1", width: 1920 },
    { format_id: "av", ext: "mp4", acodec: "aac", vcodec: "avc1" },
    { format_id: "s", ext: "mhtml", acodec: "none", vcodec: "images", format_note: "storyboard" },
  ], artist: undefined, thumbnails: [{ url: "https://i.ytimg.com/vi/a/maxresdefault.jpg", width: 1280 }], requested_formats: [{ url: "https://secret.example/stream" }], http_headers: { Authorization: "secret" } }, "https://www.youtube.com/watch?v=abcdefghijk");
  assert.deepEqual(media.formats.map((format) => format.type), ["audio", "video", "combined"]);
  assert.equal(media.music.artist, undefined);
  assert.equal(media.raw.requested_formats, undefined);
  assert.equal(media.raw.http_headers, undefined);
  assert.equal(media.thumbnails[0]?.url, "https://i.ytimg.com/vi/a/maxresdefault.jpg");
  assert.deepEqual(sanitizeRaw({ nested: { url: "https://secret", useful: "kept" } }), { nested: { useful: "kept" } });
});

test("thumbnail normalization rejects untrusted HTTPS hosts and selectors combine automatic video with selected audio", () => {
  const media = normalizeMedia({ id: "abcdefghijk", title: "Title", thumbnail: "https://attacker.example/image.jpg", thumbnails: [
    { url: "https://attacker.example/also.jpg", width: 600 },
    { url: "https://i.ytimg.com/vi/a/hqdefault.jpg", width: 480 },
  ], formats: [{ format_id: "a", ext: "m4a", acodec: "aac", vcodec: "none" }] }, "https://www.youtube.com/watch?v=abcdefghijk");
  assert.deepEqual(media.thumbnails.map((thumbnail) => thumbnail.url), ["https://i.ytimg.com/vi/a/hqdefault.jpg"]);
  assert.equal(media.thumbnail, "https://i.ytimg.com/vi/a/hqdefault.jpg");
  const request = parseDownloadRequest({ url: media.url, mode: "combined", audioFormat: "original", audioQuality: "best", audioFormatId: "a", metadata: { title: "Selected title", artist: "", album: "", albumArtist: "", date: "", genre: "", trackNumber: "", discNumber: "", artwork: { source: "none" } }, includeInfoJson: false });
  assert.equal(formatSelector(request, media), "bestvideo+a");
});

test("download request format IDs and metadata arguments remain data, not FFmpeg syntax", () => {
  const value = parseDownloadRequest({ url: "https://youtu.be/abcdefghijk", mode: "audio", audioFormat: "mp3", audioQuality: "192", formatId: "140", metadata: { title: `Song '%s\n-next',` , artist: "Artist", album: "", albumArtist: "", date: "", genre: "", trackNumber: "", discNumber: "", artwork: { source: "none" } }, includeInfoJson: false });
  const media = normalizeMedia({ id: "abcdefghijk", formats: [{ format_id: "140", ext: "m4a", acodec: "aac", vcodec: "none" }] }, value.url);
  assert.doesNotThrow(() => validateFormatRequest(value, media));
  const m4aRequest = parseDownloadRequest({ ...value, audioFormat: "m4a", formatId: undefined });
  assert.equal(formatSelector(m4aRequest, media), "bestaudio[acodec^=mp4a]/bestaudio/best");
  assert.deepEqual(metadataArgs(value.metadata).slice(0, 2), ["-metadata", "title=Song '%s\n-next',"]);
  assert.equal(safeBaseName(`A/B: C?`), "A B C");
  assert.match(contentDisposition("音楽.mp3"), /filename\*=UTF-8''/);
  assert.throws(() => parseDownloadRequest({ ...value, formatId: "bestvideo; rm -rf /" }));
});

test("format validation distinguishes audio, video-only, and combined selections", () => {
  const media = normalizeMedia({ id: "abcdefghijk", formats: [
    { format_id: "a", ext: "m4a", acodec: "aac", vcodec: "none" },
    { format_id: "v", ext: "mp4", acodec: "none", vcodec: "h264" },
    { format_id: "av", ext: "mp4", acodec: "aac", vcodec: "h264" },
  ] }, "https://www.youtube.com/watch?v=abcdefghijk");
  const base = { url: "https://youtu.be/abcdefghijk", audioFormat: "original", audioQuality: "best", metadata: { title: "", artist: "", album: "", albumArtist: "", date: "", genre: "", trackNumber: "", discNumber: "", artwork: { source: "none" } }, includeInfoJson: false } as const;
  const request = (mode: "audio" | "video" | "combined", formatId?: string, audioFormatId?: string) => ({ ...base, mode, ...(formatId ? { formatId } : {}), ...(audioFormatId ? { audioFormatId } : {}) });
  assert.doesNotThrow(() => validateFormatRequest(request("audio", "av"), media));
  assert.throws(() => validateFormatRequest(request("video", "av"), media));
  assert.doesNotThrow(() => validateFormatRequest(request("combined", "av"), media));
  assert.throws(() => validateFormatRequest(request("combined", "av", "a"), media));
  assert.doesNotThrow(() => validateFormatRequest(request("combined", "v", "a"), media));
  assert.doesNotThrow(() => validateFormatRequest(request("combined", undefined, "a"), media));
  assert.doesNotThrow(() => validateFormatRequest(request("combined", undefined, "a"), media));
});

test("process line parsing preserves fragments and process execution enforces timeout and cancellation", async () => {
  assert.deepEqual(splitCompleteLines("VIPOD_PROG", "RESS:42%\r\nVIPOD_FILE:/tmp/x\npartial"), {
    lines: ["VIPOD_PROGRESS:42%", "VIPOD_FILE:/tmp/x"], pending: "partial",
  });
  const success = await runProcess(process.execPath, ["-e", "process.stdout.write('fragment'); process.stdout.write('ed\\n')"], { timeoutMs: 2000 });
  assert.equal(success.stdout, "fragmented\n");
  await assert.rejects(runProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 30 }), /timed out/i);
  const controller = new AbortController();
  const cancelled = runProcess(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], { timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  await assert.rejects(cancelled, /cancelled/i);
});

test("real FFmpeg finalization embeds edited MP3 tags and an attached cover image", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-media-test-"));
  try {
    const ffmpeg = process.env.FFMPEG_PATH || "/opt/homebrew/bin/ffmpeg";
    const source = path.join(directory, "tone.wav"); const image = path.join(directory, "cover.jpg");
    const tone = await runProcess(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-c:a", "pcm_s16le", source], { timeoutMs: 15_000 });
    const cover = await runProcess(ffmpeg, ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", image], { timeoutMs: 15_000 });
    assert.equal(tone.code, 0); assert.equal(cover.code, 0);
    const request = parseDownloadRequest({ url: "https://youtu.be/abcdefghijk", mode: "audio", audioFormat: "mp3", audioQuality: "192", metadata: { title: "A tagged tone", artist: "Vipod Test", album: "Local Smoke", albumArtist: "", date: "", genre: "Test", trackNumber: "1", discNumber: "", artwork: { source: "thumbnail" } }, includeInfoJson: false });
    const final = await finalizeMedia(source, directory, request, normalizeMedia({ id: "abcdefghijk", formats: [] }, request.url), { artworkPath: image });
    const tags = (final.probe.format as { tags: Record<string, string> }).tags;
    assert.equal(tags.title, "A tagged tone");
    assert.equal(tags.artist, "Vipod Test");
    assert.equal(tags.genre, "Test");
    assert.ok((final.probe.streams as Array<{ disposition?: { attached_pic?: number } }>).some((stream) => stream.disposition?.attached_pic === 1));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real FFmpeg converts WAV and Opus sources to requested MP3 and M4A codecs", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-codec-test-"));
  try {
    const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
    const source = path.join(directory, "media.wav");
    const generated = await runProcess(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=330:duration=0.5", "-c:a", "pcm_s16le", source], { timeoutMs: 15_000 });
    assert.equal(generated.code, 0);
    const opus = path.join(directory, "source.opus");
    const encodedOpus = await runProcess(ffmpeg, ["-y", "-i", source, "-c:a", "libopus", opus], { timeoutMs: 15_000 });
    assert.equal(encodedOpus.code, 0);
    const media = normalizeMedia({ id: "abcdefghijk", title: "Fallback", formats: [] }, "https://www.youtube.com/watch?v=abcdefghijk");
    for (const input of [source, opus]) {
      for (const audioFormat of ["mp3", "m4a"] as const) {
        const request = parseDownloadRequest({ url: media.url, mode: "audio", audioFormat, audioQuality: "192", metadata: { title: `Converted ${audioFormat}`, artist: "Local Test", album: "Codec Test", albumArtist: "", date: "2024", genre: "Test", trackNumber: "2/10", discNumber: "1", artwork: { source: "none" } }, includeInfoJson: false });
        const result = await finalizeMedia(input, directory, request, media);
        const audio = (result.probe.streams as Array<{ codec_type: string; codec_name: string }>).find((stream) => stream.codec_type === "audio");
        assert.equal(audio?.codec_name, audioFormat === "mp3" ? "mp3" : "aac");
        assert.ok(Number((result.probe.format as { duration: string }).duration) > 0.3);
        const tags = (result.probe.format as { tags: Record<string, string> }).tags;
        assert.equal(tags.title, `Converted ${audioFormat}`);
        assert.equal(tags.artist, "Local Test");
        await rm(result.path, { force: true });
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("real FFmpeg converts WAV audio to M4A and preserves requested tags", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-m4a-test-"));
  try {
    const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
    const source = path.join(directory, "media.wav");
    const generated = await runProcess(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.25", "-c:a", "pcm_s16le", source], { timeoutMs: 15_000 });
    assert.equal(generated.code, 0);
    const request = parseDownloadRequest({ url: "https://youtu.be/abcdefghijk", mode: "audio", audioFormat: "m4a", audioQuality: "best", metadata: { title: "M4A tone", artist: "Vipod Test", album: "Local Smoke", albumArtist: "", date: "", genre: "", trackNumber: "", discNumber: "", artwork: { source: "none" } }, includeInfoJson: false });
    const result = await finalizeMedia(source, directory, request, normalizeMedia({ id: "abcdefghijk", title: "Fallback", formats: [] }, request.url));
    const streams = result.probe.streams as Array<{ codec_type: string; codec_name: string }>;
    assert.equal(streams.find((stream) => stream.codec_type === "audio")?.codec_name, "aac");
    assert.equal((result.probe.format as { tags: Record<string, string> }).tags.title, "M4A tone");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("injected job manager resolves a completed file after a restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-jobs-test-"));
  const request = parseDownloadRequest({ url: "https://youtu.be/abcdefghijk", mode: "audio", audioFormat: "original", audioQuality: "best", metadata: { title: "Durable file", artist: "", album: "", albumArtist: "", date: "", genre: "", trackNumber: "", discNumber: "", artwork: { source: "none" } }, includeInfoJson: false });
  const media = normalizeMedia({ id: "abcdefghijk", title: "Durable file", formats: [] }, request.url);
  const manager = createJobManager({ directory, cleanupIntervalMs: 60_000, dependencies: {
    analyze: async () => media,
    download: async (jobDirectory) => {
      const sourceDirectory = path.join(jobDirectory, "source"); await mkdir(sourceDirectory, { recursive: true });
      const source = path.join(sourceDirectory, "media.wav"); await writeFile(source, "source");
      return source;
    },
    finalize: async (_source, jobDirectory) => {
      const output = path.join(jobDirectory, "Durable file.wav"); await writeFile(output, "published-media");
      return { path: output, fileName: "Durable file.wav", size: 15, probe: {} };
    },
  } });
  try {
    const created = await manager.create(request);
    let job = await manager.get(created.id);
    for (let attempt = 0; attempt < 100 && job?.status !== "completed"; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10)); job = await manager.get(created.id);
    }
    assert.equal(job?.status, "completed");
    await manager.dispose();
    const restarted = createJobManager({ directory, cleanupIntervalMs: 60_000 });
    const resolved = await restarted.resolveFile(created.id, "file");
    assert.equal(resolved?.path, path.join(directory, created.id, "Durable file.wav"));
    await restarted.dispose();
  } finally { await manager.dispose(); await rm(directory, { recursive: true, force: true }); }
});

test("finalizing a source named media in its source directory preserves it when the output is media.mp3", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-name-collision-"));
  try {
    const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
    const sourceDirectory = path.join(directory, "source");
    await mkdir(sourceDirectory);
    const source = path.join(sourceDirectory, "media.wav");
    const generated = await runProcess(ffmpeg, ["-y", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.3", "-c:a", "pcm_s16le", source], { timeoutMs: 15_000 });
    assert.equal(generated.code, 0);
    const request = parseDownloadRequest({ url: "https://youtu.be/abcdefghijk", mode: "audio", audioFormat: "mp3", audioQuality: "192", metadata: { title: "media", artist: "", album: "", albumArtist: "", date: "", genre: "", trackNumber: "", discNumber: "", artwork: { source: "none" } }, includeInfoJson: false });
    const final = await finalizeMedia(source, directory, request, normalizeMedia({ id: "abcdefghijk", title: "Fallback", formats: [] }, request.url));
    assert.equal(final.fileName, "media.mp3");
    await access(source);
    await access(final.path);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
