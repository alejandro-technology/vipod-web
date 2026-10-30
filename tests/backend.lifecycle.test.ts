import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DownloadJob } from "../src/lib/contracts";
import { normalizeMedia } from "../src/lib/server/analyze";
import { createJobManager, writeAtomic } from "../src/lib/server/jobs";
import { checkAbort } from "../src/lib/server/process";
import { parseDownloadRequest } from "../src/lib/server/validation";

const request = () => parseDownloadRequest({ url: "https://youtu.be/abcdefghijk", mode: "audio", audioFormat: "mp3", audioQuality: "best", includeInfoJson: true,
  metadata: { title: "media", artist: "", album: "", albumArtist: "", date: "", genre: "", trackNumber: "", discNumber: "", artwork: { source: "none" } } });
const media = () => normalizeMedia({ id: "abcdefghijk", title: "media", duration: 1, formats: [{ format_id: "a", ext: "wav", acodec: "pcm_s16le", vcodec: "none" }] }, request().url);
type Manager = ReturnType<typeof createJobManager>;
type Dependencies = NonNullable<NonNullable<Parameters<typeof createJobManager>[0]>["dependencies"]>;
const defaults: Dependencies = {
  analyze: async () => media(),
  download: async (directory, _request, _media, options) => {
    checkAbort(options.signal); await mkdir(path.join(directory, "source"), { recursive: true });
    const file = path.join(directory, "source", "media.wav"); await writeFile(file, "source"); return file;
  },
  finalize: async (_source, directory, _request, _media, options = {}) => {
    checkAbort(options.signal); await options.beforePublish?.();
    const file = path.join(directory, "media.mp3"); await writeFile(file, "completed");
    return { path: file, fileName: "media.mp3", size: 9, probe: {} };
  },
};
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve };
}
function waitForAbort(signal: AbortSignal): Promise<never> {
  checkAbort(signal);
  return new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason), { once: true }); });
}
async function terminalJob(manager: Manager, id: string): Promise<DownloadJob> {
  for (let attempt = 0; attempt < 300; attempt++) {
    const job = await manager.get(id);
    if (job && ["completed", "cancelled", "failed"].includes(job.status)) return (await manager.cancel(id))!;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Job did not reach a terminal state");
}
async function fixture(dependencies: Dependencies = {}, extra: Parameters<typeof createJobManager>[0] = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-lifecycle-"));
  const manager = createJobManager({ directory, watchdogIntervalMs: 10, dependencies: { ...defaults, ...dependencies }, ...extra });
  return { directory, manager, close: async () => { await manager.dispose(); await rm(directory, { recursive: true, force: true }); } };
}

for (const phase of ["analyze", "download", "finalize", "info"] as const) {
  test(`one lifecycle signal cancels and waits during ${phase}, without late completed/progress races`, async () => {
    const entered = deferred(); const exited = deferred(); const signals: AbortSignal[] = [];
    let staleProgress: ((value: Partial<DownloadJob>) => void) | undefined;
    const hold = async (signal: AbortSignal) => {
      signals.push(signal); entered.resolve();
      try { await waitForAbort(signal); }
      finally { await new Promise((resolve) => setTimeout(resolve, 20)); exited.resolve(); }
    };
    const dependencies: Dependencies = {
      analyze: async (_url, options = {}) => { signals.push(options.signal!); if (phase === "analyze") await hold(options.signal!); return media(); },
      download: async (...args) => { signals.push(args[3].signal); staleProgress = args[3].progress; if (phase === "download") await hold(args[3].signal); return defaults.download!(...args); },
      finalize: async (...args) => { signals.push(args[4]!.signal!); if (phase === "finalize") await hold(args[4]!.signal!); return defaults.finalize!(...args); },
      info: async (_file, _media, _request, _fileName, signal) => { signals.push(signal!); if (phase === "info") await hold(signal!); },
    };
    const f = await fixture(dependencies);
    try {
      const job = await f.manager.create(request()); await entered.promise;
      const cancelled = await f.manager.cancel(job.id); await exited.promise;
      assert.equal(cancelled?.status, "cancelled"); assert.ok(signals.every((signal) => signal === signals[0]));
      staleProgress?.({ status: "completed", progress: 100, stage: "completed" });
      assert.equal((await f.manager.get(job.id))?.status, "cancelled");
      assert.deepEqual(await readdir(path.join(f.directory, job.id)), ["job.json"]);
      assert.equal(JSON.parse(await readFile(path.join(f.directory, job.id, "job.json"), "utf8")).status, "cancelled");
      assert.equal(await f.manager.resolveFile(job.id, "file"), null);
    } finally { await f.close(); }
  });
}

test("elapsed timeout covers analysis before the downloader is spawned", async () => {
  const previous = process.env.DOWNLOAD_TIMEOUT_MS; process.env.DOWNLOAD_TIMEOUT_MS = "50";
  let downloads = 0;
  const f = await fixture({ analyze: async (_url, options = {}) => waitForAbort(options.signal!), download: async () => { downloads++; throw new Error("Must not spawn"); } });
  try {
    const job = await f.manager.create(request()); const finished = await terminalJob(f.manager, job.id);
    assert.equal(finished.status, "failed"); assert.equal(finished.stage, "DOWNLOAD_TIMEOUT"); assert.equal(downloads, 0);
  } finally { await f.close(); if (previous === undefined) delete process.env.DOWNLOAD_TIMEOUT_MS; else process.env.DOWNLOAD_TIMEOUT_MS = previous; }
});

for (const phase of ["download", "finalize"] as const) {
  test(`periodic recursive watchdog detects silent oversize files during ${phase} as FILE_TOO_LARGE`, async () => {
    const previous = process.env.MAX_DOWNLOAD_MB; process.env.MAX_DOWNLOAD_MB = String(8192 / 1024 ** 2);
    const overflow = async (directory: string, signal: AbortSignal) => {
      const nested = path.join(directory, phase === "download" ? "source" : "nested", "deeper");
      await mkdir(nested, { recursive: true }); await writeFile(path.join(nested, "silent.partial"), Buffer.alloc(9000));
      return waitForAbort(signal);
    };
    const f = await fixture(phase === "download" ? { download: async (directory, _request, _media, options) => overflow(directory, options.signal) }
      : { finalize: async (_source, directory, _request, _media, options = {}) => overflow(directory, options.signal!) });
    try {
      const job = await f.manager.create(request()); const finished = await terminalJob(f.manager, job.id);
      assert.equal(finished.status, "failed"); assert.equal(finished.stage, "FILE_TOO_LARGE"); assert.match(finished.error!, /size limit/i);
      assert.deepEqual(await readdir(path.join(f.directory, job.id)), ["job.json"]);
    } finally { await f.close(); if (previous === undefined) delete process.env.MAX_DOWNLOAD_MB; else process.env.MAX_DOWNLOAD_MB = previous; }
  });
}

test("atomic writes capture immutable snapshots, recover after a failed write, and ignore stale terminal progress", async () => {
  const entered = deferred(); const release = deferred(); const snapshots: Array<{ status: string; progress: number | null }> = [];
  let staleProgress: ((value: Partial<DownloadJob>) => void) | undefined; let writes = 0;
  const f = await fixture({
    writeManifest: async (file, content) => {
      snapshots.push(JSON.parse(content)); writes++;
      if (writes === 2) { entered.resolve(); await release.promise; throw new Error("Injected disk failure"); }
      await writeAtomic(file, content);
    },
    analyze: async (_url, options = {}) => waitForAbort(options.signal!),
    download: async (...args) => { staleProgress = args[3].progress; return defaults.download!(...args); },
  });
  try {
    const job = await f.manager.create(request()); await entered.promise; release.resolve();
    const finished = await terminalJob(f.manager, job.id);
    assert.equal(finished.status, "failed"); assert.equal(finished.stage, "PERSISTENCE_FAILED");
    await f.manager.cancel(job.id); // Drain terminal write before reading disk.
    assert.deepEqual(snapshots.map((value) => value.status), ["queued", "analyzing", "failed"]);
    assert.equal(JSON.parse(await readFile(path.join(f.directory, job.id, "job.json"), "utf8")).status, "failed");
    staleProgress?.({ progress: 99 }); assert.equal((await f.manager.get(job.id))?.progress, null);
  } finally { release.resolve(); await f.close(); }
});

test("successful progress manifests serialize distinct immutable snapshots before completed publication", async () => {
  let activeWrites = 0; let peakWrites = 0; const snapshots: Array<{ status: string; progress: number | null }> = [];
  let staleProgress: ((value: Partial<DownloadJob>) => void) | undefined;
  const f = await fixture({
    writeManifest: async (file, content) => {
      activeWrites++; peakWrites = Math.max(peakWrites, activeWrites);
      try { await new Promise((resolve) => setTimeout(resolve, 3)); snapshots.push(JSON.parse(content)); await writeAtomic(file, content); }
      finally { activeWrites--; }
    },
    download: async (...args) => {
      staleProgress = args[3].progress;
      for (const value of [10, 20, 30]) args[3].progress({ progress: value, stage: "downloading" });
      return defaults.download!(...args);
    },
  });
  try {
    const job = await f.manager.create(request()); await terminalJob(f.manager, job.id);
    assert.equal(peakWrites, 1);
    assert.deepEqual(snapshots.map(({ status, progress }) => `${status}:${progress}`), ["queued:null", "analyzing:null", "downloading:0", "downloading:10", "downloading:20", "downloading:30", "processing:99", "completed:100", "completed:100"]);
    staleProgress?.({ status: "downloading", stage: "downloading", progress: 1 });
    assert.equal((await f.manager.get(job.id))?.status, "completed");
    assert.equal(JSON.parse(await readFile(path.join(f.directory, job.id, "job.json"), "utf8")).status, "completed");
  } finally { await f.close(); }
});

for (const phase of ["finalize", "info"] as const) {
  test(`elapsed lifecycle timeout remains active during ${phase}`, async () => {
    const previous = process.env.DOWNLOAD_TIMEOUT_MS; process.env.DOWNLOAD_TIMEOUT_MS = "80";
    const f = await fixture(phase === "finalize" ? { finalize: async (_source, _directory, _request, _media, options = {}) => waitForAbort(options.signal!) }
      : { info: async (_file, _media, _request, _fileName, signal) => waitForAbort(signal!) });
    try {
      const job = await f.manager.create(request()); const finished = await terminalJob(f.manager, job.id);
      assert.equal(finished.status, "failed"); assert.equal(finished.stage, "DOWNLOAD_TIMEOUT");
      assert.deepEqual(await readdir(path.join(f.directory, job.id)), ["job.json"]);
    } finally { await f.close(); if (previous === undefined) delete process.env.DOWNLOAD_TIMEOUT_MS; else process.env.DOWNLOAD_TIMEOUT_MS = previous; }
  });
}

test("queued and terminal TTL expiry runs on access and periodically; restart preserves corrupt/orphan user data", async () => {
  const previous = process.env.JOB_TTL_HOURS; process.env.JOB_TTL_HOURS = "0.001";
  let clock = Date.now(); const entered = deferred();
  const f = await fixture({ analyze: async (_url, options = {}) => { entered.resolve(); return waitForAbort(options.signal!); } }, { now: () => clock, cleanupIntervalMs: 10 });
  try {
    const active = await f.manager.create(request()); await entered.promise;
    const queued = await f.manager.create({ ...request(), metadata: { ...request().metadata, title: "another version" } });
    assert.equal(Date.parse(queued.expiresAt!) - clock, 3600);
    clock += 3601;
    assert.equal(await f.manager.get(queued.id), null); await assert.rejects(lstat(path.join(f.directory, queued.id)));
    assert.equal((await f.manager.get(active.id))?.status, "analyzing"); // Only queued/terminal expiry interrupts retention.
    const cancelled = await f.manager.cancel(active.id); assert.equal(cancelled?.status, "cancelled");
    clock += 3601;
    for (let attempt = 0; attempt < 100; attempt++) { if (!(await lstat(path.join(f.directory, active.id)).catch(() => null))) break; await new Promise((resolve) => setTimeout(resolve, 10)); }
    await assert.rejects(lstat(path.join(f.directory, active.id)));
    await f.manager.dispose();
    const corrupt = randomUUID(); const orphan = randomUUID(); const expired = randomUUID();
    await mkdir(path.join(f.directory, corrupt)); await writeFile(path.join(f.directory, corrupt, "job.json"), "{bad");
    await mkdir(path.join(f.directory, orphan)); await writeFile(path.join(f.directory, orphan, "partial"), "partial");
    await mkdir(path.join(f.directory, expired));
    await writeFile(path.join(f.directory, expired, "job.json"), JSON.stringify({ id: expired, status: "queued", progress: null, stage: "queued", createdAt: new Date(clock - 5000).toISOString(), updatedAt: new Date(clock - 5000).toISOString(), request: request() }));
    await mkdir(path.join(f.directory, "unrelated")); await writeFile(path.join(f.directory, "unrelated", "keep"), "keep");
    const restart = createJobManager({ directory: f.directory, now: () => clock });
    try {
      await restart.initialize();
      for (const id of [corrupt, orphan]) { assert.equal(await restart.get(id), null); assert.ok(await lstat(path.join(f.directory, id))); }
      assert.equal(await restart.get(expired), null); await assert.rejects(lstat(path.join(f.directory, expired)));
      assert.equal(await readFile(path.join(f.directory, "unrelated", "keep"), "utf8"), "keep");
    } finally { await restart.dispose(); }
  } finally { await f.close(); if (previous === undefined) delete process.env.JOB_TTL_HOURS; else process.env.JOB_TTL_HOURS = previous; }
});

test("completed resolution rejects symlinks, missing/changed media, and unauthorized info files", async () => {
  const f = await fixture();
  try {
    const job = await f.manager.create({ ...request(), includeInfoJson: false }); await terminalJob(f.manager, job.id);
    const resolved = await f.manager.resolveFile(job.id, "file"); assert.ok(resolved);
    assert.equal(await f.manager.resolveFile(job.id, "info"), null);
    await rm(resolved.path); assert.equal(await f.manager.resolveFile(job.id, "file"), null);
    const outside = path.join(f.directory, "outside"); await writeFile(outside, "completed"); await symlink(outside, resolved.path);
    assert.equal(await f.manager.resolveFile(job.id, "file"), null);
    await rm(resolved.path); await writeFile(resolved.path, "changed-size");
    assert.equal(await f.manager.resolveFile(job.id, "file"), null);
  } finally { await f.close(); }
});
