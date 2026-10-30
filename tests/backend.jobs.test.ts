import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { DownloadRequest, MediaInfo } from "../src/lib/contracts";
import { normalizeMedia } from "../src/lib/server/analyze";
import { createJobManager } from "../src/lib/server/jobs";
import { parseDownloadRequest } from "../src/lib/server/validation";

function request(): DownloadRequest {
  return parseDownloadRequest({
    url: "https://youtu.be/abcdefghijk", mode: "audio", audioFormat: "mp3", audioQuality: "192",
    metadata: { title: "media", artist: "", album: "", albumArtist: "", date: "", genre: "", trackNumber: "", discNumber: "", artwork: { source: "none" } },
    includeInfoJson: true,
  });
}

function media(): MediaInfo {
  return normalizeMedia({ id: "abcdefghijk", title: "media", formats: [{ format_id: "audio", ext: "m4a", acodec: "aac", vcodec: "none" }] }, "https://www.youtube.com/watch?v=abcdefghijk");
}

async function waitForJob(manager: ReturnType<typeof createJobManager>, id: string, status: "downloading" | "completed") {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const job = await manager.get(id);
    if (job?.status === status) return job;
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
  throw new Error(`Timed out waiting for job ${id} to become ${status}.`);
}

test("queue cancellation, file resolution, and completed restart recovery work end to end", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-jobs-test-"));
  let holdDownload = true;
  const analyze = async () => media();
  const download = async (jobDirectory: string, _request: DownloadRequest, _media: MediaInfo, options: { signal: AbortSignal }): Promise<string> => {
    const sourceDirectory = path.join(jobDirectory, "source");
    await mkdir(sourceDirectory, { recursive: true });
    const source = path.join(sourceDirectory, "media.wav");
    await writeFile(source, "synthetic source");
    if (holdDownload) await new Promise<void>((resolve, reject) => {
      const onAbort = () => { options.signal.removeEventListener("abort", onAbort); reject(options.signal.reason); };
      options.signal.addEventListener("abort", onAbort, { once: true });
    });
    return source;
  };
  const finalize = async (source: string, jobDirectory: string) => {
    assert.equal(path.basename(path.dirname(source)), "source");
    const finalPath = path.join(jobDirectory, "media.mp3");
    await writeFile(finalPath, "synthetic final media");
    return { path: finalPath, fileName: "media.mp3", size: (await readFile(finalPath)).length, probe: {} };
  };
  const info = async (file: string) => { await writeFile(file, JSON.stringify({ info: true })); };
  const manager = createJobManager({ directory, watchdogIntervalMs: 25, cleanupIntervalMs: 60_000, dependencies: { analyze, download, finalize, info } });
  try {
    const active = await manager.create(request());
    await waitForJob(manager, active.id, "downloading");
    const queued = await manager.create({ ...request(), metadata: { ...request().metadata, title: "another version" } });
    assert.equal(queued.status, "queued");
    assert.equal((await manager.cancel(queued.id))?.status, "cancelled");
    await manager.cancel(active.id);
    assert.equal((await manager.get(active.id))?.status, "cancelled");

    holdDownload = false;
    const completed = await manager.create(request());
    await waitForJob(manager, completed.id, "completed");
    const resolved = await manager.resolveFile(completed.id, "file");
    assert.equal(resolved?.job.fileName, "media.mp3");
    assert.equal(await readFile(resolved!.path, "utf8"), "synthetic final media");
    assert.ok(await manager.resolveFile(completed.id, "info"));

    await manager.dispose();
    const restarted = createJobManager({ directory, cleanupIntervalMs: 60_000 });
    assert.equal((await restarted.get(completed.id))?.status, "completed");
    assert.equal((await restarted.resolveFile(completed.id, "file"))?.job.fileName, "media.mp3");
    await restarted.dispose();
  } finally {
    await manager.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});

test("restart marks an interrupted manifest failed and removes partial output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-restart-test-"));
  const id = "770e8400-e29b-41d4-a716-446655440000";
  const jobDirectory = path.join(directory, id);
  try {
    await mkdir(path.join(jobDirectory, "source"), { recursive: true });
    await writeFile(path.join(jobDirectory, "source", "partial.media"), "partial");
    const now = new Date().toISOString();
    await writeFile(path.join(jobDirectory, "job.json"), JSON.stringify({
      id, status: "processing", progress: 99, stage: "processing", message: "Working", createdAt: now, updatedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), request: request(),
    }));
    const manager = createJobManager({ directory, cleanupIntervalMs: 60_000 });
    const recovered = await manager.get(id);
    assert.equal(recovered?.status, "failed");
    assert.match(recovered?.error ?? "", /server restarted/i);
    assert.equal(JSON.parse(await readFile(path.join(jobDirectory, "job.json"), "utf8")).status, "failed");
    await assert.rejects(readFile(path.join(jobDirectory, "source", "partial.media")));
    await manager.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("restart rejects completed manifests with path traversal names", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-traversal-test-"));
  const id = "d89c87b6-cba0-4b3c-89bb-aa124325ab1d";
  const jobDirectory = path.join(directory, id);
  const now = new Date().toISOString();
  try {
    await mkdir(jobDirectory);
    await writeFile(path.join(jobDirectory, "job.json"), JSON.stringify({
      id, status: "completed", progress: 100, stage: "completed", createdAt: now, updatedAt: now,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), fileName: "../outside.mp3", fileSize: 10,
      downloadUrl: `/api/downloads/${id}/file`, request: request(),
    }));
    const manager = createJobManager({ directory, cleanupIntervalMs: 60_000 });
    assert.equal(await manager.get(id), null);
    assert.equal(await manager.resolveFile(id, "file"), null);
    await manager.dispose();
  } finally { await rm(directory, { recursive: true, force: true }); }
});
