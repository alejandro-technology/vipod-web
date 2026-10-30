import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DownloadRequest } from "../src/lib/contracts";
import { normalizeMedia } from "../src/lib/server/analyze";
import { serverConfig } from "../src/lib/server/config";
import { ApiFailure } from "../src/lib/server/errors";
import { fetchArtwork, finalizeMedia } from "../src/lib/server/media";
import { runProcess } from "../src/lib/server/process";
import { parseDownloadRequest } from "../src/lib/server/validation";

const url = "https://www.youtube.com/watch?v=abcdefghijk";
const media = normalizeMedia({ id: "abcdefghijk", title: "Fallback title", formats: [] }, url);
function request(audioFormat: "mp3" | "m4a" | "original" = "mp3", mode: DownloadRequest["mode"] = "audio"): DownloadRequest {
  return parseDownloadRequest({ url, mode, audioFormat, audioQuality: "best", includeInfoJson: false,
    metadata: { title: "media '%s\n-next'", artist: "Artist", album: "Album", albumArtist: "Album Artist", date: "2024-02-29", genre: "Test", trackNumber: "2/10", discNumber: "1/2", artwork: { source: "none" } } });
}
async function ffmpeg(args: string[]) {
  const result = await runProcess(serverConfig.ffmpegPath, ["-y", ...args], { timeoutMs: 15_000 });
  assert.equal(result.code, 0, result.stderr); return result;
}
const code = (expected: string) => (error: unknown) => error instanceof ApiFailure && error.code === expected;
type Inspection = { streams: Array<{ codec_type: string; codec_name: string; bit_rate?: string; disposition?: { attached_pic?: number } }>; format: { duration: string; tags: Record<string, string> } };

test("native FFmpeg WAV/Opus -> MP3/M4A has correct codecs, duration, quoted tags, attached art, and file size", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-native-media-"));
  try {
    const sourceDirectory = path.join(directory, "source"); await mkdir(sourceDirectory);
    const wav = path.join(sourceDirectory, "media.wav"); const opus = path.join(sourceDirectory, "media.opus"); const cover = path.join(directory, "cover.jpg");
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a:0", "pcm_s16le", wav]);
    await ffmpeg(["-i", wav, "-c:a:0", "libopus", opus]);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", cover]);
    for (const source of [wav, opus]) for (const audioFormat of ["mp3", "m4a"] as const) {
      const req = request(audioFormat); req.metadata.artwork.source = "thumbnail"; req.audioQuality = "192";
      const result = await finalizeMedia(source, directory, req, media, { artworkPath: cover });
      const inspected = result.probe as Inspection;
      assert.equal(inspected.streams.find((stream) => stream.codec_type === "audio")?.codec_name, audioFormat === "mp3" ? "mp3" : "aac");
      assert.equal(inspected.streams.length, 2); assert.equal(inspected.streams.filter((stream) => stream.disposition?.attached_pic === 1).length, 1);
      assert.ok(Math.abs(Number(inspected.format.duration) - 1) < 0.1);
      assert.equal(inspected.format.tags.title, req.metadata.title); assert.equal(inspected.format.tags.album_artist, "Album Artist");
      assert.equal(inspected.format.tags.track, "2/10"); assert.equal(inspected.format.tags.disc, "1/2"); assert.equal(inspected.format.tags.date, "2024-02-29");
      assert.equal(result.size, (await stat(result.path)).size); assert.ok(result.size > 0);
      if (audioFormat === "mp3") assert.equal(Number(inspected.streams.find((stream) => stream.codec_type === "audio")?.bit_rate), 192_000);
      t.diagnostic(`${path.extname(source).slice(1)} -> ${audioFormat}: codec=${inspected.streams.find((stream) => stream.codec_type === "audio")?.codec_name}, duration=${inspected.format.duration}s, attached_pic=1, size=${result.size}`);
      await rm(result.path);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native best MP3 -> MP3 and AAC -> M4A copy compressed audio; explicit quality reencodes", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-native-copy-"));
  // AAC's ADTS headers are removed during M4A remuxing. Compare the same
  // compressed payload representation, not transport-header bytes.
  const audioHash = async (file: string, aac = false) => (await ffmpeg(["-i", file, "-map", "0:a:0", "-c:a:0", "copy", ...(aac ? ["-bsf:a", "aac_adtstoasc"] : []), "-f", "md5", "-"])).stdout.trim();
  try {
    for (const [extension, codec, target] of [["mp3", "libmp3lame", "mp3"], ["aac", "aac", "m4a"]] as const) {
      const source = path.join(directory, `source.${extension}`);
      await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=660:duration=1", "-c:a:0", codec, "-b:a:0", "64k", source]);
      const originalHash = await audioHash(source, target === "m4a"); const req = request(target);
      const copied = await finalizeMedia(source, directory, req, media);
      assert.equal(await audioHash(copied.path, target === "m4a"), originalHash);
      t.diagnostic(`${extension} -> ${target} best: compressed-audio MD5 unchanged (${originalHash})`);
      await rm(copied.path);
      req.audioQuality = "192";
      const encoded = await finalizeMedia(source, directory, req, media);
      assert.notEqual(await audioHash(encoded.path, target === "m4a"), originalHash);
      if (target === "mp3") assert.equal(Number((encoded.probe as Inspection).streams[0].bit_rate), 192_000);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native MP4/MKV/WebM video outputs preserve metadata and correctly retain/drop audio without covers", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-native-video-"));
  try {
    for (const extension of ["mp4", "mkv", "webm"]) {
      const source = path.join(directory, `source.${extension}`);
      await ffmpeg(["-f", "lavfi", "-i", "color=c=red:s=64x64:r=10:d=1", "-f", "lavfi", "-i", "sine=frequency=440:duration=1",
        "-c:v:0", extension === "webm" ? "libvpx-vp9" : "libx264", "-c:a:0", extension === "webm" ? "libopus" : "aac", "-t", "1", source]);
      for (const mode of ["combined", "video"] as const) {
        const req = request("original", mode);
        const final = await finalizeMedia(source, directory, req, media);
        const inspected = final.probe as Inspection;
        assert.equal(inspected.streams.filter((stream) => stream.codec_type === "video").length, 1);
        assert.equal(inspected.streams.filter((stream) => stream.codec_type === "audio").length, mode === "video" ? 0 : 1);
        assert.ok(inspected.streams.every((stream) => stream.disposition?.attached_pic !== 1));
        const tags = Object.fromEntries(Object.entries(inspected.format.tags).map(([key, value]) => [key.toLowerCase(), value]));
        assert.equal(tags.title, req.metadata.title); assert.equal(tags.artist, req.metadata.artist);
        await rm(final.path);
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native original WebM/Opus rejects covers explicitly, while unadorned originals retain tags", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-native-original-"));
  try {
    for (const extension of ["opus", "webm"]) {
      const source = path.join(directory, `source.${extension}`);
      await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-c:a:0", "libopus", source]);
      const req = request("original"); req.metadata.artwork.source = "thumbnail";
      await assert.rejects(finalizeMedia(source, directory, req, media), code("ARTWORK_UNSUPPORTED"));
      req.metadata.artwork.source = "none";
      const final = await finalizeMedia(source, directory, req, media);
      assert.equal((final.probe as Inspection).streams[0].codec_name, "opus");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native final-size and before-publish cancellation guards prevent atomic output publication", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-native-publish-"));
  try {
    const source = path.join(directory, "source.wav"); await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", source]);
    await assert.rejects(finalizeMedia(source, directory, request(), media, { maxBytes: 1 }), code("FILE_TOO_LARGE"));
    assert.deepEqual(await readdir(directory), ["source.wav"]);
    const controller = new AbortController();
    await assert.rejects(finalizeMedia(source, directory, request(), media, { signal: controller.signal, beforePublish: async () => { controller.abort(); } }), code("CANCELLED"));
    assert.deepEqual(await readdir(directory), ["source.wav"]);
    const req = request(); req.metadata.title = ""; // Defensive fallback for already-validated legacy internal calls.
    const final = await finalizeMedia(source, directory, req, media);
    assert.equal((final.probe as Inspection).format.tags.title, "Fallback title");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("native image conversion reads injected artwork bytes using local protocols only", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-native-art-fetch-"));
  try {
    const image = path.join(directory, "local.jpg"); await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", image]);
    const bytes = await readFile(image); const thumbnail = "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg";
    const req = request(); req.metadata.artwork = { source: "thumbnail", url: thumbnail };
    const fetcher: typeof fetch = async () => new Response(bytes, { headers: { "content-type": "image/jpeg" } });
    const art = await fetchArtwork(req, { ...media, thumbnails: [{ url: thumbnail }] }, directory, undefined, fetcher);
    assert.ok(art); assert.ok((await stat(art)).size > 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("invalid output duration/codec/tags/cover inspection fails before publish and removes temporary output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-probe-validation-")); const previous = process.env.FFPROBE_PATH;
  try {
    const source = path.join(directory, "source.wav"); const cover = path.join(directory, "cover.jpg");
    await ffmpeg(["-f", "lavfi", "-i", "sine=frequency=440:duration=1", source]);
    await ffmpeg(["-f", "lavfi", "-i", "color=c=blue:s=64x64", "-frames:v", "1", cover]);
    const fakeProbe = path.join(directory, "ffprobe");
    const req = request();
    const tags = { title: req.metadata.title, artist: "Artist", album: "Album", album_artist: "Album Artist", date: "2024-02-29", genre: "Test", track: "2/10", disc: "1/2" };
    const valid = { streams: [{ codec_type: "audio", codec_name: "mp3" }], format: { duration: "1", tags } };
    for (const [output, expected, art] of [
      [{ ...valid, format: { ...valid.format, duration: "4" } }, "INVALID_MEDIA", false],
      [{ ...valid, streams: [{ codec_type: "audio", codec_name: "aac" }] }, "INVALID_MEDIA", false],
      [{ ...valid, format: { ...valid.format, tags: { ...tags, title: "wrong" } } }, "METADATA_NOT_EMBEDDED", false],
      [valid, "INVALID_MEDIA", true],
    ] as const) {
      await writeFile(fakeProbe, `#!${process.execPath}\nconst final=process.argv.at(-1).includes('.final-'); process.stdout.write(JSON.stringify(final?${JSON.stringify(output)}:${JSON.stringify({ streams: [{ codec_type: "audio", codec_name: "pcm_s16le" }], format: { duration: "1" } })}));\n`);
      await chmod(fakeProbe, 0o700); process.env.FFPROBE_PATH = fakeProbe;
      await assert.rejects(finalizeMedia(source, directory, req, media, art ? { artworkPath: cover } : {}), code(expected));
      assert.ok((await readdir(directory)).every((name) => !name.startsWith(".final-") && name !== "Artist - media '%s -next'.mp3"));
    }
  } finally { if (previous === undefined) delete process.env.FFPROBE_PATH; else process.env.FFPROBE_PATH = previous; await rm(directory, { recursive: true, force: true }); }
});
