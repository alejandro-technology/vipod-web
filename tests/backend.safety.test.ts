import assert from "node:assert/strict";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { analyzeVideo, normalizeMedia } from "../src/lib/server/analyze";
import { serverConfig, ttlMs } from "../src/lib/server/config";
import { ApiFailure } from "../src/lib/server/errors";
import { downloadSource } from "../src/lib/server/jobs";
import { fetchArtwork, probe } from "../src/lib/server/media";
import { runProcess, splitCompleteLines } from "../src/lib/server/process";
import { parseDownloadRequest } from "../src/lib/server/validation";

const imageUrl = "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg";
function request(url = imageUrl, source: "thumbnail" | "coverart" | "none" = "thumbnail") {
  return parseDownloadRequest({ url: "https://youtu.be/abcdefghijk", mode: "audio", audioFormat: "mp3", audioQuality: "best", includeInfoJson: false,
    metadata: { title: " media '%s\n-next' ", artist: "", album: "", albumArtist: "", date: "2024-02-29", genre: "", trackNumber: "1/10", discNumber: "1/2", artwork: { source, url } } });
}
const media = () => normalizeMedia({ id: "abcdefghijk", title: "media", duration: 1, thumbnails: [{ url: imageUrl }], thumbnail: imageUrl,
  formats: [{ format_id: "a", ext: "wav", acodec: "pcm_s16le", vcodec: "none" }] }, request().url);
const code = (expected: string) => (error: unknown) => error instanceof ApiFailure && error.code === expected;

test("metadata schema constrains dates/track/disc and preserves quoting; raw numbers and compact release dates normalize", () => {
  const base = request(); assert.equal(base.metadata.title, " media '%s\n-next' ");
  for (const patch of [{ title: " \n\t" }, { date: "2024-02-30" }, { date: "2023-02-29" }, { date: "2024-13" }, { trackNumber: "0" }, { trackNumber: "3/2" }, { discNumber: "-1" }, { discNumber: "1/0" }]) assert.throws(() => parseDownloadRequest({ ...base, metadata: { ...base.metadata, ...patch } }), code("INVALID_REQUEST"));
  const normalized = normalizeMedia({ title: "  ", track_number: 3, disc_number: 2, release_date: 20240229 }, base.url);
  assert.equal(normalized.title, "Untitled video"); assert.deepEqual(normalized.music, { date: "2024-02-29", trackNumber: "3", discNumber: "2" });
  assert.deepEqual(normalizeMedia({ track_number: -1, disc_number: 1.5, release_date: "20230229" }, base.url).music, {});
});

test("canonical config names override legacy aliases and PATH tools remain portable", () => {
  const keys = ["YT_DLP_PATH", "FFMPEG_PATH", "FFPROBE_PATH", "FFMPEG_LOCATION", "MAX_DOWNLOAD_MB", "MAX_DOWNLOAD_BYTES", "MAX_DURATION_SECONDS", "MAX_VIDEO_DURATION_SECONDS", "JOB_TTL_HOURS"];
  const previous = keys.map((key) => process.env[key]);
  try {
    keys.forEach((key) => delete process.env[key]);
    assert.equal(serverConfig.ytDlpPath, "yt-dlp"); assert.equal(serverConfig.ffmpegPath, "ffmpeg"); assert.equal(serverConfig.ffprobePath, "ffprobe");
    process.env.MAX_DOWNLOAD_BYTES = "123"; assert.equal(serverConfig.maxDownloadBytes(), 123);
    process.env.MAX_DOWNLOAD_MB = "2"; assert.equal(serverConfig.maxDownloadBytes(), 2 * 1024 ** 2);
    process.env.MAX_VIDEO_DURATION_SECONDS = "123"; assert.equal(serverConfig.maxDurationSeconds(), 123);
    process.env.MAX_DURATION_SECONDS = "456"; assert.equal(serverConfig.maxDurationSeconds(), 456);
    process.env.JOB_TTL_HOURS = "2"; assert.equal(ttlMs(), 7_200_000);
    process.env.FFMPEG_PATH = "/custom/ffmpeg"; assert.equal(serverConfig.ffmpegLocation, "/custom/ffmpeg");
    process.env.FFMPEG_LOCATION = "/custom/tools"; assert.equal(serverConfig.ffmpegLocation, "/custom/tools");
  } finally { keys.forEach((key, index) => { if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index]; }); }
});

test("artwork requires exact thumbnail membership and exact CAA release/front URLs before fetching", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-art-safety-")); let calls = 0;
  const fetcher: typeof fetch = async () => { calls++; throw new Error("Must not fetch"); };
  try {
    for (const url of ["https://i.ytimg.com/vi/other/hqdefault.jpg", "https://user:pass@i.ytimg.com/a", "https://i.ytimg.com:444/a", "http://i.ytimg.com/a", "https://i.ytimg.com.evil.test/a"]) {
      const selected = { ...media(), thumbnails: [{ url }] };
      await assert.rejects(fetchArtwork(request(url), url.includes("other") ? media() : selected, directory, undefined, fetcher), code("INVALID_ARTWORK_URL"));
    }
    const notMember = { ...media(), thumbnails: [], thumbnail: imageUrl };
    await assert.rejects(fetchArtwork(request(), notMember, directory, undefined, fetcher), code("INVALID_ARTWORK_URL"));
    for (const suffix of ["/front.jpg", "/front-501", "/front?x=y", "/front/", "/back", "/front-500#fragment"]) await assert.rejects(fetchArtwork(request(`https://coverartarchive.org/release/770e8400-e29b-41d4-a716-446655440000${suffix}`, "coverart"), media(), directory, undefined, fetcher), code("INVALID_ARTWORK_URL"));
    await assert.rejects(fetchArtwork(request("https://coverartarchive.org/release/not-a-uuid/front", "coverart"), media(), directory, undefined, fetcher), code("INVALID_ARTWORK_URL"));
    assert.equal(calls, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("artwork redirect allow-list is enforced on every hop and CAA front variants are accepted", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-art-redirect-"));
  try {
    for (const location of ["http://archive.org/image", "https://archive.org:444/image", "https://user@archive.org/image", "https://evil.test/image"]) {
      let calls = 0;
      const fetcher: typeof fetch = async () => { calls++; return new Response(null, { status: 302, headers: { location } }); };
      await assert.rejects(fetchArtwork(request(), media(), directory, undefined, fetcher), code("INVALID_ARTWORK_URL")); assert.equal(calls, 1);
    }
    for (const suffix of ["front", "front-250", "front-500", "front-1200"]) {
      const urls: string[] = [];
      const fetcher: typeof fetch = async (url) => {
        urls.push(String(url));
        return urls.length === 1 ? new Response(null, { status: 302, headers: { location: "https://ia800100.us.archive.org/cover.jpg" } }) : new Response("not found", { status: 404 });
      };
      await assert.rejects(fetchArtwork(request(`https://coverartarchive.org/release/770e8400-e29b-41d4-a716-446655440000/${suffix}`, "coverart"), media(), directory, undefined, fetcher), code("ARTWORK_UNAVAILABLE"));
      assert.equal(urls.length, 2); assert.equal(urls[1], "https://ia800100.us.archive.org/cover.jpg");
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("artwork streaming enforces 10MB without content-length and cancels the reader", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-art-limit-")); let cancelled = false;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)); }, cancel() { cancelled = true; },
  }), { headers: { "content-type": "image/jpeg" } });
  try { await assert.rejects(fetchArtwork(request(), media(), directory, undefined, fetcher), code("ARTWORK_LIMIT")); assert.ok(cancelled); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("artwork cancellation actively cancels a blocked body reader", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-art-abort-")); const controller = new AbortController(); let cancelled = false;
  const fetcher: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ pull() { controller.abort(); }, cancel() { cancelled = true; } }), { headers: { "content-type": "image/jpeg" } });
  try { await assert.rejects(fetchArtwork(request(), media(), directory, controller.signal, fetcher), code("CANCELLED")); assert.ok(cancelled); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("already aborted process signals never spawn, partial lines are bounded, and output limits terminate children", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-process-safety-")); const marker = path.join(directory, "spawned");
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(runProcess(process.execPath, ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned')`], { signal: controller.signal, timeoutMs: 1000 }), code("CANCELLED"));
    await assert.rejects(lstat(marker));
    assert.throws(() => splitCompleteLines("a".repeat(4096), "b"), code("OUTPUT_LIMIT"));
    await assert.rejects(runProcess(process.execPath, ["-e", "process.stdout.write('a'.repeat(10000)); setInterval(()=>{},1000)"], { timeoutMs: 3000, maxOutput: 128 }), code("OUTPUT_LIMIT"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("POSIX cancellation kills descendants that ignore SIGTERM and waits for group shutdown", { skip: process.platform === "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-process-group-")); const heartbeat = path.join(directory, "heartbeat");
  const controller = new AbortController(); let pid = 0;
  const descendant = `const fs=require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync(process.argv[1],'.'),10); process.stdout.write('READY');`;
  const parent = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(descendant)},process.argv[1]],{stdio:['ignore','pipe','ignore']}); child.stdout.once('data',()=>process.stdout.write(String(child.pid)+'\\n')); setInterval(()=>{},1000);`;
  try {
    const running = runProcess(process.execPath, ["-e", parent, heartbeat], { signal: controller.signal, timeoutMs: 5000, onStdout: (chunk) => { pid = Number(chunk.trim()); controller.abort(); } });
    await assert.rejects(running, code("CANCELLED")); assert.ok(pid > 0);
    const before = await readFile(heartbeat, "utf8").catch(() => ""); await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(await readFile(heartbeat, "utf8").catch(() => ""), before);
    assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("elapsed process timeout escalates a SIGTERM-resistant child and resolves only after exit", { skip: process.platform === "win32" }, async () => {
  let pid = 0; const started = Date.now();
  await assert.rejects(runProcess(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); process.stdout.write(String(process.pid)); setInterval(()=>{},1000);"], {
    timeoutMs: 2000, onStdout: (chunk) => { pid = Number(chunk); },
  }), code("PROCESS_TIMEOUT"));
  assert.ok(pid > 0); assert.ok(Date.now() - started >= 3450);
  assert.throws(() => process.kill(pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
});

test("local FFprobe protocols reject remote playlist references without internet access", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-protocol-")); const playlist = path.join(directory, "remote.m3u8");
  try {
    await writeFile(playlist, "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXTINF:1,\nhttp://127.0.0.1:9/segment.ts\n#EXT-X-ENDLIST\n");
    await assert.rejects(probe(playlist), code("INVALID_MEDIA"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("fake local yt-dlp uses configured FFmpeg location, isolated source output, and source containment", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-fake-downloader-")); const tool = path.join(directory, "yt-dlp"); const argsFile = path.join(directory, "args.json");
  const previous = process.env.YT_DLP_PATH; const previousLocation = process.env.FFMPEG_LOCATION;
  try {
    await writeFile(tool, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);fs.writeFileSync(${JSON.stringify(argsFile)},JSON.stringify(args));if(args.includes('--dump-single-json'))process.stdout.write(${JSON.stringify(JSON.stringify({ id: "abcdefghijk", duration: 1, formats: [{ format_id: "a", acodec: "aac", vcodec: "none", ext: "m4a" }] }))});else{const out=args[args.indexOf('-o')+1].replace('%(ext)s','wav');fs.writeFileSync(out,'source');process.stdout.write('VIPOD_FILE:'+out+'\\n');}\n`);
    await chmod(tool, 0o700); process.env.YT_DLP_PATH = tool; process.env.FFMPEG_LOCATION = "/local/tools";
    const req = { ...request(), metadata: { ...request().metadata, title: "media" } };
    await analyzeVideo(req.url);
    const analysisArgs: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    assert.equal(analysisArgs[analysisArgs.indexOf("--ffmpeg-location") + 1], "/local/tools");
    const file = await downloadSource(directory, req, media(), { signal: new AbortController().signal, progress() {} });
    assert.equal(file, await realpath(path.join(directory, "source", "media.wav")));
    const args: string[] = JSON.parse(await readFile(argsFile, "utf8"));
    assert.equal(args[args.indexOf("--ffmpeg-location") + 1], "/local/tools"); assert.equal(args[args.indexOf("-o") + 1], path.join(directory, "source", "media.%(ext)s"));
    await writeFile(tool, `#!${process.execPath}\nprocess.stdout.write('VIPOD_FILE:'+${JSON.stringify(argsFile)}+'\\n');\n`);
    await assert.rejects(downloadSource(directory, req, media(), { signal: new AbortController().signal, progress() {} }), code("INVALID_OUTPUT_PATH"));
  } finally {
    if (previous === undefined) delete process.env.YT_DLP_PATH; else process.env.YT_DLP_PATH = previous;
    if (previousLocation === undefined) delete process.env.FFMPEG_LOCATION; else process.env.FFMPEG_LOCATION = previousLocation;
    await rm(directory, { recursive: true, force: true });
  }
});
