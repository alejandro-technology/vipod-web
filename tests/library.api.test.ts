import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { GET as list } from "../src/app/api/library/route";
import { GET as file } from "../src/app/api/library/[id]/file/route";
import { GET as info } from "../src/app/api/library/[id]/info/route";
import { POST as retain } from "../src/app/api/library/[id]/retain/route";
import { DELETE as remove } from "../src/app/api/library/[id]/route";
import { GET as jobs } from "../src/app/api/downloads/route";
import { createJobManager } from "../src/lib/server/jobs";
import { normalizeMedia } from "../src/lib/server/analyze";
import { parseDownloadRequest } from "../src/lib/server/validation";

test("library API lists/searches, streams attachment bytes/JSON, retains idempotently, checks write origin, and deletes idempotently", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-libapi-"));
  const request = parseDownloadRequest({ url: "https://youtu.be/abcdefghijk", mode: "audio", audioFormat: "mp3", audioQuality: "best", includeInfoJson: true,
    metadata: { title: "API track", artist: "Artist", album: "Album", albumArtist: "", date: "", genre: "", trackNumber: "", discNumber: "", artwork: { source: "none" } } });
  const manager = createJobManager({ directory, dependencies: {
    analyze: async () => normalizeMedia({ id: "abcdefghijk", title: "API track", formats: [] }, request.url),
    download: async (dir) => { await mkdir(path.join(dir, "source")); const source = path.join(dir, "source", "media.wav"); await writeFile(source, "source"); return source; },
    finalize: async (_source, dir) => { const output = path.join(dir, "track.mp3"); await writeFile(output, "media bytes"); return { path: output, fileName: "track.mp3", size: 11, probe: {} }; },
  } });
  const runtimeKey = Symbol.for("vipod.downloader.manager.v2");
  const host = globalThis as typeof globalThis & { [runtimeKey]?: typeof manager }; const previous = host[runtimeKey]; host[runtimeKey] = manager;
  try {
    const job = await manager.create(request);
    for (let i = 0; i < 200 && (await manager.get(job.id))?.status !== "completed"; i++) await new Promise((resolve) => setTimeout(resolve, 5));
    const completed = await manager.get(job.id); assert.equal(completed?.status, "completed"); assert.ok(completed?.libraryItemId);
    const context = { params: Promise.resolve({ id: completed.libraryItemId }) }; const http = new Request("http://localhost/api/library");
    const response = await list(new Request("http://localhost/api/library?retention=temporary&q=Artist")); assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
    const payload = await response.json(); assert.equal(payload.items.length, 1); assert.equal(payload.items[0].fileSize, 11); assert.equal("filePath" in payload.items[0], false);
    assert.equal((await list(new Request("http://localhost/api/library?retention=invalid"))).status, 400);
    const download = await file(http, context); assert.equal(download.status, 200); assert.equal(download.headers.get("cache-control"), "no-store"); assert.equal(download.headers.get("content-length"), "11"); assert.match(download.headers.get("content-disposition")!, /attachment.*track\.mp3/); assert.equal(await download.text(), "media bytes");
    const companion = await info(http, context); assert.equal(companion.status, 200); assert.equal(companion.headers.get("cache-control"), "no-store"); assert.match(companion.headers.get("content-disposition")!, /attachment/); assert.equal((await companion.json()).final.metadata.title, "API track");
    const denied = new Request("http://localhost/api/library", { method: "POST", headers: { host: "localhost", origin: "https://evil.example" } });
    assert.equal((await retain(denied, context)).status, 403); assert.equal((await remove(denied, context)).status, 403);
    const trusted = new Request("http://localhost/api/library", { method: "POST", headers: { host: "localhost", origin: "http://localhost" } });
    assert.equal((await (await retain(trusted, context)).json()).retention, "permanent"); assert.equal((await (await retain(trusted, context)).json()).retention, "permanent");
    assert.equal((await (await jobs()).json()).jobs.length, 1);
    assert.equal((await remove(trusted, context)).status, 204); assert.equal((await remove(trusted, context)).status, 204);
    assert.equal((await file(http, context)).status, 404); assert.equal((await info(http, context)).status, 404); assert.equal((await retain(trusted, context)).status, 404);
    assert.equal((await (await list(http)).json()).items.length, 0);
  } finally { if (previous) host[runtimeKey] = previous; else delete host[runtimeKey]; await manager.dispose(); await rm(directory, { recursive: true, force: true }); }
});
