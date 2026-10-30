import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { POST as create } from "../src/app/api/downloads/route";
import { DELETE as cancel, GET as get } from "../src/app/api/downloads/[id]/route";
import { GET as file } from "../src/app/api/downloads/[id]/file/route";
import { GET as info } from "../src/app/api/downloads/[id]/info/route";
import { createJobManager } from "../src/lib/server/jobs";
import { normalizeMedia } from "../src/lib/server/analyze";
import { parseDownloadRequest } from "../src/lib/server/validation";

test("download API routes preserve JSON contracts, file/info responses, cancellation semantics, and unsafe path 404s", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-api-")); const previous = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  const request = parseDownloadRequest({ url: "https://youtu.be/abcdefghijk", mode: "audio", audioFormat: "mp3", audioQuality: "best", includeInfoJson: true,
    metadata: { title: "media", artist: "", album: "", albumArtist: "", date: "", genre: "", trackNumber: "", discNumber: "", artwork: { source: "none" } } });
  const manager = createJobManager({ directory, dependencies: {
    analyze: async () => normalizeMedia({ id: "abcdefghijk", formats: [] }, request.url),
    download: async (jobDirectory) => { await mkdir(path.join(jobDirectory, "source")); const source = path.join(jobDirectory, "source", "media.wav"); await writeFile(source, "source"); return source; },
    finalize: async (_source, jobDirectory) => { const output = path.join(jobDirectory, "media.mp3"); await writeFile(output, "completed"); return { path: output, size: 9, fileName: "media.mp3", probe: {} }; },
  } });
  try {
    const job = await manager.create(request);
    for (let i = 0; i < 100 && (await manager.get(job.id))?.status !== "completed"; i++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await manager.cancel(job.id))?.status, "completed"); await manager.dispose();
    const context = { params: Promise.resolve({ id: job.id }) }; const http = new Request(`http://localhost/api/downloads/${job.id}`);
    const response = await get(http, context); assert.equal(response.status, 200);
    const body = await response.json(); assert.equal(body.status, "completed"); assert.equal(body.downloadUrl, `/api/downloads/${job.id}/file`); assert.equal(body.fileSize, 9);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const output = await file(http, context); assert.equal(output.status, 200); assert.equal(output.headers.get("content-length"), "9");
    assert.match(output.headers.get("content-disposition")!, /media\.mp3/); assert.equal(await output.text(), "completed");
    const infoResponse = await info(http, context); assert.equal(infoResponse.status, 200);
    const infoBody = await infoResponse.json(); assert.equal(infoBody.final.fileName, "media.mp3"); assert.equal(infoBody.final.metadata.title, "media");
    assert.equal((await (await cancel(http, context)).json()).status, "completed");
    const missing = { params: Promise.resolve({ id: "not-a-job" }) }; assert.equal((await get(http, missing)).status, 404); assert.equal((await file(http, missing)).status, 404);
    const bad = new Request("http://localhost/api/downloads", { method: "POST", body: JSON.stringify({ ...request, metadata: { ...request.metadata, title: " " } }), headers: { "content-type": "application/json" } });
    const invalid = await create(bad); assert.equal(invalid.status, 400); assert.equal((await invalid.json()).error.code, "INVALID_REQUEST");
    const outputPath = path.join(directory, job.id, "media.mp3"); await rm(outputPath);
    const outside = path.join(directory, "outside"); await writeFile(outside, "completed"); await symlink(outside, outputPath);
    assert.equal((await file(http, context)).status, 404);
    assert.equal(JSON.parse(await readFile(path.join(directory, job.id, "job.json"), "utf8")).status, "completed");
  } finally { await manager.dispose(); if (previous === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = previous; await rm(directory, { recursive: true, force: true }); }
});
