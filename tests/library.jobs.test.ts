import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createJobManager } from "../src/lib/server/jobs";
import { normalizeMedia } from "../src/lib/server/analyze";
import { parseDownloadRequest } from "../src/lib/server/validation";
import type { DownloadJob, DownloadRequest } from "../src/lib/contracts";

const request = (): DownloadRequest => parseDownloadRequest({ url: "https://youtu.be/abcdefghijk", mode: "audio", audioFormat: "mp3", audioQuality: "best", includeInfoJson: false,
  metadata: { title: "media", artist: "Artist", album: "Album", albumArtist: "", date: "", genre: "", trackNumber: "", discNumber: "", artwork: { source: "none" } } });
const media = () => normalizeMedia({ id: "abcdefghijk", title: "media", formats: [{ format_id: "audio", ext: "m4a", acodec: "aac", vcodec: "none" }] }, request().url);
type Manager = ReturnType<typeof createJobManager>;
type Options = NonNullable<Parameters<typeof createJobManager>[0]>;
async function settled(manager: Manager, id: string): Promise<DownloadJob> {
  for (let i = 0; i < 300; i++) {
    const job = await manager.get(id);
    if (job && ["completed", "failed", "cancelled"].includes(job.status)) return (await manager.cancel(id)) ?? job;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Job did not settle");
}
async function fixture(options: Partial<Options> = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-libjobs-")); let downloads = 0;
  const manager = createJobManager({ ...options, directory, dependencies: {
    analyze: async () => media(),
    download: async (dir) => { downloads++; await mkdir(path.join(dir, "source")); const source = path.join(dir, "source", "media.wav"); await writeFile(source, "source"); return source; },
    finalize: async (_source, dir, req) => { const fileName = `media.${req.audioFormat}`; const file = path.join(dir, fileName); await writeFile(file, "final bytes"); return { path: file, fileName, size: 11, probe: {} }; },
    ...options.dependencies,
  } });
  return { manager, directory, downloads: () => downloads, close: async () => { await manager.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

test("exact completed reuse normalizes URL aliases, honors keep, and synthesizes JSON without another downloader", async () => {
  const f = await fixture();
  try {
    const job = await settled(f.manager, (await f.manager.create(request())).id);
    assert.equal(job.status, "completed"); assert.ok(job.libraryItemId);
    const reused = await f.manager.create({ ...request(), url: "https://music.youtube.com/watch?v=abcdefghijk&list=ignored", includeInfoJson: true, keepInLibrary: true });
    assert.equal(reused.reused, true); assert.equal(reused.libraryItemId, job.libraryItemId); assert.equal(f.downloads(), 1);
    const item = await f.manager.getLibraryItem(job.libraryItemId!); assert.equal(item?.retention, "permanent"); assert.ok(item?.infoPath);
    const info = JSON.parse(await readFile(item!.infoPath!, "utf8")); assert.equal(info.final.metadata.title, "media"); assert.equal(info.media.id, "abcdefghijk");
    assert.ok(await f.manager.get(reused.id));
  } finally { await f.close(); }
});

test("changed metadata, output format, quality, and source format selection create independent versions", async () => {
  const f = await fixture();
  try {
    await settled(f.manager, (await f.manager.create(request())).id);
    for (const next of [
      { ...request(), metadata: { ...request().metadata, title: "Changed" } },
      { ...request(), audioFormat: "m4a" as const },
      { ...request(), audioQuality: "192" as const },
      { ...request(), formatId: "audio" },
    ]) { const job = await f.manager.create(next); assert.notEqual(job.reused, true); assert.equal((await settled(f.manager, job.id)).status, "completed"); }
    assert.equal(f.downloads(), 5); assert.equal((await f.manager.listLibrary()).length, 5);
  } finally { await f.close(); }
});

test("concurrent identical creates share one job and a concurrent keep/JSON request upgrades it", async () => {
  let release!: () => void; const held = new Promise<void>((done) => { release = done; });
  const f = await fixture({ dependencies: { analyze: async () => { await held; return media(); } } });
  try {
    const [a, b, c] = await Promise.all([f.manager.create(request()), f.manager.create({ ...request(), keepInLibrary: true, includeInfoJson: true }), f.manager.create(request())]);
    assert.equal(a.id, b.id); assert.equal(b.id, c.id); release();
    const result = await settled(f.manager, a.id); assert.equal(result.status, "completed"); assert.equal(f.downloads(), 1);
    const items = await f.manager.listLibrary("permanent"); assert.equal(items.length, 1); assert.ok(items[0].infoUrl); assert.equal(result.retentionError, undefined);
  } finally { release(); await f.close(); }
});

test("permanent catalog files survive originating job expiry, restart, and exact reuse", async () => {
  let clock = Date.now(); const f = await fixture({ now: () => clock });
  try {
    const job = await settled(f.manager, (await f.manager.create({ ...request(), keepInLibrary: true, includeInfoJson: true })).id);
    const before = await f.manager.getLibraryItem(job.libraryItemId!); assert.equal(before?.retention, "permanent");
    clock += 25 * 60 * 60 * 1000; await f.manager.list();
    await assert.rejects(readFile(path.join(f.directory, job.id, "media.mp3")));
    assert.equal(await readFile(before!.filePath, "utf8"), "final bytes");
    await f.manager.dispose();
    const restarted = createJobManager({ directory: f.directory, now: () => clock, dependencies: { download: async () => { throw new Error("must not download"); } } });
    try {
      const item = await restarted.getLibraryItem(job.libraryItemId!); assert.equal(item?.retention, "permanent");
      const reused = await restarted.create(request()); assert.equal(reused.reused, true); assert.equal(reused.libraryItemId, job.libraryItemId);
      assert.equal((await restarted.get(reused.id))?.status, "completed");
      assert.equal((await restarted.cancel(reused.id))?.status, "completed");
      assert.equal((await restarted.resolveFile(job.id, "file"))?.path, before!.filePath);
    } finally { await restarted.dispose(); }
  } finally { await f.close(); }
});

for (const operation of ["add", "retain"] as const) {
  test(`${operation} SQL failure preserves a valid downloadable temporary file and reports an explicit error`, async () => {
    const f = await fixture({ catalogDependencies: { beforeWrite: (op) => { if (op === operation) throw new Error("Injected database failure"); } } });
    try {
      const job = await settled(f.manager, (await f.manager.create({ ...request(), keepInLibrary: true })).id);
      assert.equal(job.status, "completed"); assert.match(job.retentionError!, /temporar|saving/i);
      const file = await f.manager.resolveFile(job.id, "file"); assert.ok(file); assert.equal(await readFile(file.path, "utf8"), "final bytes");
      assert.equal((await f.manager.listLibrary("permanent")).length, 0);
      assert.deepEqual(await readdir(path.join(f.directory, "library")), []);
    } finally { await f.close(); }
  });
}

test("legacy valid manifests recover as temporary exports and preserve user files", async () => {
  const f = await fixture();
  try {
    const completed = await settled(f.manager, (await f.manager.create(request())).id); await f.manager.dispose();
    for (const suffix of ["", "-wal", "-shm"]) await rm(path.join(f.directory, `library.sqlite${suffix}`), { force: true });
    const manifest = path.join(f.directory, completed.id, "job.json"); const stored = JSON.parse(await readFile(manifest, "utf8")); delete stored.libraryItemId; delete stored.request.keepInLibrary; await writeFile(manifest, JSON.stringify(stored));
    await writeFile(path.join(f.directory, "user-file.txt"), "preserve");
    const recovered = createJobManager({ directory: f.directory });
    try { const items = await recovered.listLibrary("temporary"); assert.equal(items.length, 1); assert.equal(items[0].id, completed.id); assert.equal(await readFile(path.join(f.directory, "user-file.txt"), "utf8"), "preserve"); }
    finally { await recovered.dispose(); }
  } finally { await f.close(); }
});

test("explicit deletion removes originals plus retained copies and restart does not resurrect them", async () => {
  const f = await fixture();
  try {
    const completed = await settled(f.manager, (await f.manager.create({ ...request(), keepInLibrary: true, includeInfoJson: true })).id);
    const item = await f.manager.getLibraryItem(completed.libraryItemId!); assert.ok(item);
    await f.manager.deleteLibraryItem(item.id); await f.manager.deleteLibraryItem(item.id);
    assert.equal(await f.manager.getLibraryItem(item.id), null); await assert.rejects(readFile(item.filePath)); await assert.rejects(readFile(path.join(f.directory, completed.id, "media.mp3")));
    await f.manager.dispose(); const restarted = createJobManager({ directory: f.directory });
    try { assert.deepEqual(await restarted.listLibrary(), []); } finally { await restarted.dispose(); }
  } finally { await f.close(); }
});

test("missing and same-size tampered completed files are not reused or listed", async () => {
  const f = await fixture();
  try {
    const a = await settled(f.manager, (await f.manager.create(request())).id); const item = await f.manager.getLibraryItem(a.libraryItemId!); assert.ok(item);
    await writeFile(item.filePath, "other bytes"); assert.equal((await f.manager.listLibrary()).length, 0);
    const b = await f.manager.create(request()); assert.notEqual(b.reused, true); await settled(f.manager, b.id); assert.equal(f.downloads(), 2);
  } finally { await f.close(); }
});

test("a late concurrent JSON request upgrades processing output and stays valid after restart", async () => {
  let entered!: () => void; let release!: () => void;
  const atPublish = new Promise<void>((done) => { entered = done; }); const held = new Promise<void>((done) => { release = done; });
  const f = await fixture({ dependencies: { writeManifest: async (file, content) => {
    const parsed = JSON.parse(content);
    if (parsed.status === "completed" && !parsed.libraryItemId) { entered(); await held; }
    await writeFile(file, content);
  } } });
  try {
    const first = await f.manager.create(request()); await atPublish;
    const upgrade = f.manager.create({ ...request(), keepInLibrary: true, includeInfoJson: true }); release();
    const reused = await upgrade; assert.equal(reused.reused, true); assert.ok(reused.infoUrl); assert.equal(f.downloads(), 1);
    await f.manager.dispose(); const restarted = createJobManager({ directory: f.directory });
    try {
      const restored = await restarted.get(first.id); assert.equal(restored?.status, "completed"); assert.ok(restored?.infoUrl);
      assert.equal((await restarted.listLibrary("permanent")).length, 1);
    } finally { await restarted.dispose(); }
  } finally { release(); await f.close(); }
});

test("implicit thumbnail reuse resolves the applied artwork URL; a changed URL creates another version", async () => {
  let thumbnail = "https://i.ytimg.com/vi/abcdefghijk/hqdefault.jpg";
  const f = await fixture({ dependencies: { analyze: async () => ({ ...media(), thumbnail, thumbnails: [{ url: thumbnail }] }) } });
  try {
    const input = { ...request(), metadata: { ...request().metadata, artwork: { source: "thumbnail" as const } } };
    const first = await settled(f.manager, (await f.manager.create(input)).id);
    assert.equal((await f.manager.getLibraryItem(first.libraryItemId!))?.metadata.artwork.url, thumbnail);
    const reused = await f.manager.create(input); assert.equal(reused.reused, true); assert.equal(f.downloads(), 1);
    thumbnail = "https://i.ytimg.com/vi/abcdefghijk/maxresdefault.jpg";
    const changed = await f.manager.create(input); assert.notEqual(changed.reused, true); await settled(f.manager, changed.id); assert.equal(f.downloads(), 2);
  } finally { await f.close(); }
});

test("expired temporary exports cannot be reused and their files are removed during the running process", async () => {
  let clock = Date.now(); const f = await fixture({ now: () => clock });
  try {
    const first = await settled(f.manager, (await f.manager.create(request())).id);
    clock += 25 * 60 * 60 * 1000;
    const next = await f.manager.create(request()); assert.notEqual(next.reused, true); assert.notEqual(next.id, first.id);
    await settled(f.manager, next.id); assert.equal(f.downloads(), 2); await assert.rejects(readFile(path.join(f.directory, first.id, "media.mp3")));
    assert.equal((await f.manager.listLibrary("temporary")).length, 1);
  } finally { await f.close(); }
});

test("legacy exports without an analysis snapshot do not lie or redownload solely to provide optional JSON", async () => {
  const f = await fixture();
  try {
    const completed = await settled(f.manager, (await f.manager.create(request())).id); await f.manager.dispose();
    for (const suffix of ["", "-wal", "-shm"]) await rm(path.join(f.directory, `library.sqlite${suffix}`), { force: true });
    const restarted = createJobManager({ directory: f.directory, dependencies: { download: async () => { throw new Error("Must not redownload for JSON"); } } });
    try {
      const items = await restarted.listLibrary(); assert.equal(items[0].id, completed.id);
      await assert.rejects(restarted.create({ ...request(), includeInfoJson: true }), (error: unknown) => error instanceof Error && "code" in error && error.code === "INFO_UNAVAILABLE");
      assert.ok(await restarted.resolveFile(completed.id, "file"));
    } finally { await restarted.dispose(); }
  } finally { await f.close(); }
});

test("failed media unlink withdraws both library and legacy job URLs and remains retryable", async () => {
  let fail = true;
  const f = await fixture({ catalogDependencies: { remove: async (...args) => { if (fail) throw new Error("Injected media unlink failure"); await rm(...args); } } });
  try {
    const completed = await settled(f.manager, (await f.manager.create({ ...request(), keepInLibrary: true })).id);
    await assert.rejects(f.manager.deleteLibraryItem(completed.libraryItemId!), /Injected media unlink/);
    assert.equal(await f.manager.resolveFile(completed.id, "file"), null); assert.equal((await f.manager.get(completed.id))?.stage, "deleted");
    assert.deepEqual(await f.manager.listLibrary(), []); fail = false;
    await f.manager.deleteLibraryItem(completed.id); await assert.rejects(readFile(path.join(f.directory, completed.id, "media.mp3")));
  } finally { await f.close(); }
});
