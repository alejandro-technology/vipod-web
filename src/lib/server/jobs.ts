import "server-only";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { DownloadJob, DownloadRequest, LibraryItem, MediaInfo } from "@/lib/contracts";
import { analyzeVideo } from "./analyze";
import { ApiFailure } from "./errors";
import { finalizeMedia, writeInfo } from "./media";
import { checkAbort, runProcess, splitCompleteLines } from "./process";
import { downloadRequestSchema, formatSelector, parseDownloadRequest } from "./validation";
import { serverConfig, ttlMs } from "./config";
import { createLibraryCatalog, versionKey } from "./library";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const terminal = new Set<DownloadJob["status"]>(["completed", "failed", "cancelled"]);
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const manifestSchema = z.object({
  id: z.string().regex(UUID), status: z.enum(["queued", "analyzing", "downloading", "processing", "completed", "failed", "cancelled"]),
  progress: z.number().min(0).max(100).nullable(), stage: z.string().max(200), message: z.string().max(2000).optional(),
  createdAt: timestamp, updatedAt: timestamp, expiresAt: timestamp.optional(),
  fileName: z.string().min(1).max(255).refine((value) => value !== "." && value !== ".." && !/[\\/\u0000-\u001f]/.test(value)).optional(),
  fileSize: z.number().int().positive().optional(), downloadUrl: z.string().optional(), infoUrl: z.string().optional(),
  error: z.string().max(2000).optional(), request: downloadRequestSchema,
  libraryItemId: z.string().regex(UUID).optional(), reused: z.boolean().optional(), retentionError: z.string().max(2000).optional(),
}).strict().refine((value) => value.status !== "completed" || Boolean(value.fileName && value.fileSize));

type StoredJob = {
  view: DownloadJob; directory: string; request: DownloadRequest; controller: AbortController;
  task?: Promise<void>; persistenceError?: Error;
};
type DownloadOptions = { signal: AbortSignal; progress: (value: Partial<DownloadJob>) => void };
type Dependencies = {
  analyze: typeof analyzeVideo; finalize: typeof finalizeMedia; info: typeof writeInfo;
  download: typeof downloadSource; writeManifest: typeof writeAtomic;
};
type ManagerOptions = {
  directory?: string; dependencies?: Partial<Dependencies>; now?: () => number;
  cleanupIntervalMs?: number; watchdogIntervalMs?: number;
  catalogDependencies?: NonNullable<Parameters<typeof createLibraryCatalog>[0]>["dependencies"];
};

export async function writeAtomic(filePath: string, content: string): Promise<void> {
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await rename(temporary, filePath);
  } finally { await rm(temporary, { force: true }); }
}

export async function directorySize(directory: string): Promise<number> {
  let bytes = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const child = path.join(directory, entry.name);
    const info = await lstat(child).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    if (!info) continue;
    if (info.isSymbolicLink()) throw new ApiFailure(500, "INVALID_OUTPUT_PATH", "The job contains an unsafe symbolic link.");
    if (info.isDirectory()) bytes += await directorySize(child).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return 0;
      throw error;
    });
    else if (info.isFile()) bytes += info.size;
  }
  return bytes;
}

export async function downloadSource(directory: string, request: DownloadRequest, media: MediaInfo, options: DownloadOptions): Promise<string> {
  checkAbort(options.signal);
  const sourceDirectory = path.join(directory, "source");
  await mkdir(sourceDirectory, { recursive: true, mode: 0o700 });
  checkAbort(options.signal);
  const args = ["--ignore-config", "--no-plugin-dirs", "--no-playlist", "--no-colors",
    "--js-runtimes", `node:${process.execPath}`, "--no-simulate", "--newline", "--progress",
    "--progress-template", "download:VIPOD_PROGRESS:%(progress._percent_str)s", "--progress-template", "postprocess:VIPOD_POSTPROCESS:%(progress.status)s",
    "--max-filesize", String(serverConfig.maxDownloadBytes()), "--socket-timeout", "20", "--retries", "2",
    "-f", formatSelector(request, media), "-o", path.join(sourceDirectory, "media.%(ext)s"), "--print", "after_move:VIPOD_FILE:%(filepath)s", request.url];
  if (serverConfig.ffmpegLocation) args.splice(4, 0, "--ffmpeg-location", serverConfig.ffmpegLocation);
  let pending = ""; let finalPath = ""; let lastProgress = -1;
  const line = (value: string) => {
    checkAbort(options.signal);
    if (value.startsWith("VIPOD_FILE:")) finalPath = value.slice("VIPOD_FILE:".length).trim();
    else if (value.startsWith("VIPOD_POSTPROCESS:")) options.progress({ status: "processing", stage: "processing", progress: 99 });
    else if (value.startsWith("VIPOD_PROGRESS:")) {
      const progress = Number.parseFloat(value.slice("VIPOD_PROGRESS:".length));
      const rounded = Math.min(98, Math.max(0, Math.floor(progress)));
      if (Number.isFinite(progress) && rounded !== lastProgress) {
        lastProgress = rounded; options.progress({ progress: rounded, stage: "downloading" });
      }
    }
  };
  const result = await runProcess(serverConfig.ytDlpPath, args, {
    cwd: sourceDirectory, signal: options.signal, timeoutMs: serverConfig.downloadTimeoutMs(), maxOutput: 100_000,
    onStdout: (chunk) => { const parsed = splitCompleteLines(pending, chunk); pending = parsed.pending; parsed.lines.forEach(line); },
  });
  if (pending) line(pending);
  checkAbort(options.signal);
  if (result.code !== 0) {
    if (/max-filesize|larger than|too large|filesize.*maximum/i.test(result.stderr)) throw new ApiFailure(413, "FILE_TOO_LARGE", "The downloaded media exceeds the configured size limit.");
    throw new ApiFailure(502, "DOWNLOAD_FAILED", /private|unavailable/i.test(result.stderr) ? "This video is unavailable or private." : "The media download failed.");
  }
  if (!finalPath) throw new ApiFailure(502, "MISSING_OUTPUT", "The downloader did not produce a media file.");
  const resolved = path.resolve(sourceDirectory, finalPath);
  const canonicalSource = await realpath(sourceDirectory);
  const actual = await realpath(resolved);
  if (!actual.startsWith(`${canonicalSource}${path.sep}`) || !(await lstat(resolved)).isFile()) throw new ApiFailure(500, "INVALID_OUTPUT_PATH", "The downloader produced an invalid output path.");
  return actual;
}

// A factory keeps offline tests isolated from the process-wide API queue.
// Production uses exactly one manager and one serial queue per process.
export function createJobManager(options: ManagerOptions = {}) {
  const root = path.resolve(options.directory ?? serverConfig.dataDirectory());
  const deps: Dependencies = { analyze: analyzeVideo, finalize: finalizeMedia, info: writeInfo, download: downloadSource, writeManifest: writeAtomic, ...options.dependencies };
  const now = options.now ?? Date.now;
  const library = createLibraryCatalog({ directory: root, now, dependencies: options.catalogDependencies });
  let creationTail = Promise.resolve();
  const serialCreate = <T>(work: () => Promise<T>): Promise<T> => {
    const next = creationTail.then(work); creationTail = next.then(() => undefined, () => undefined); return next;
  };
  const requestedVersion = (request: DownloadRequest) => versionKey(request);
  const catalogCompleted = async (job: StoredJob, media?: MediaInfo) => {
    try {
      const infoPath = path.join(job.directory, `${job.view.id}.info.json`);
      const hasInfo = Boolean((await lstat(infoPath).catch(() => null))?.isFile());
      const effectiveRequest = media && job.request.metadata.artwork.source === "thumbnail" && !job.request.metadata.artwork.url && media.thumbnail
        ? { ...job.request, metadata: { ...job.request.metadata, artwork: { source: "thumbnail" as const, url: media.thumbnail } } } : job.request;
      const item = await library.add({ id: job.view.id, request: effectiveRequest, media,
        fileName: job.view.fileName!, fileSize: job.view.fileSize!, createdAt: job.view.updatedAt, expiresAt: job.view.expiresAt!,
        filePath: path.join(job.directory, job.view.fileName!), infoPath: hasInfo ? infoPath : null });
      job.view.libraryItemId = item.id;
      if (job.request.includeInfoJson && !hasInfo) {
        const upgraded = await library.findVersion(requestedVersion(effectiveRequest), true);
        job.view.infoUrl = upgraded?.infoUrl ?? undefined;
      }
      if (job.request.keepInLibrary) await library.retain(item.id);
    } catch { job.view.retentionError = "The media is ready temporarily, but saving it to the library failed."; }
  };
  const jobs = new Map<string, StoredJob>(); const queue: string[] = []; const locks = new Map<string, Promise<void>>();
  let init: Promise<void> | undefined; let pump: Promise<void> | undefined; let cleanup: Promise<void> | undefined;
  let cleanupTimer: NodeJS.Timeout | undefined; let creating = 0; let disposed = false;
  const iso = () => new Date(now()).toISOString();
  const expiry = () => new Date(now() + ttlMs()).toISOString();
  const project = (job: StoredJob): DownloadJob => structuredClone(job.view);
  const projectLibrary = (item: LibraryItem): DownloadJob => ({ id: item.id, status: "completed", stage: "completed", progress: 100,
    createdAt: item.createdAt, updatedAt: item.createdAt, fileName: item.fileName, fileSize: item.fileSize,
    downloadUrl: item.downloadUrl, infoUrl: item.infoUrl ?? undefined, libraryItemId: item.id });
  const markDeleted = (job: StoredJob) => {
    Object.assign(job.view, { status: "failed", stage: "deleted", progress: null, downloadUrl: undefined, infoUrl: undefined,
      libraryItemId: undefined, error: "The completed export was deleted.", message: "The completed export was deleted." });
  };
  const persist = (job: StoredJob): Promise<void> => {
    // Capture bytes NOW, not when the prior write finishes.
    const content = JSON.stringify({ ...project(job), request: job.request });
    const next = (locks.get(job.view.id) ?? Promise.resolve()).catch(() => undefined)
      .then(() => deps.writeManifest(path.join(job.directory, "job.json"), content));
    locks.set(job.view.id, next);
    // Attach rejection handling immediately; keep the rejecting promise for
    // explicit callers, but never leave background progress writes unhandled.
    void next.then(() => { if (locks.get(job.view.id) === next) locks.delete(job.view.id); }, (error: unknown) => {
      job.persistenceError = error instanceof Error ? error : new Error(String(error));
      if (!terminal.has(job.view.status)) job.controller.abort(new ApiFailure(500, "PERSISTENCE_FAILED", "The job state could not be saved."));
      if (locks.get(job.view.id) === next) locks.delete(job.view.id);
    });
    return next;
  };
  const drain = async (job: StoredJob) => { await locks.get(job.view.id)?.catch(() => undefined); };
  const progress = (job: StoredJob, value: Partial<DownloadJob>) => {
    if (job.controller.signal.aborted || terminal.has(job.view.status)) return;
    // Downloader progress must not move processing back to downloading.
    if (job.view.status === "processing" && value.stage === "downloading") return;
    Object.assign(job.view, value, { updatedAt: iso() }); void persist(job);
  };
  const removePartials = async (job: StoredJob) => {
    await drain(job);
    for (const name of await readdir(job.directory)) if (name !== "job.json") await rm(path.join(job.directory, name), { recursive: true, force: true });
  };
  const fail = async (job: StoredJob, error: unknown) => {
    const reason = job.controller.signal.aborted ? job.controller.signal.reason : error;
    const failure = reason instanceof ApiFailure ? reason : new ApiFailure(500, "DOWNLOAD_FAILED", "The download failed due to an unexpected error.");
    const cancelled = failure.code === "CANCELLED";
    Object.assign(job.view, { status: cancelled ? "cancelled" : "failed", stage: cancelled ? "cancelled" : failure.code, progress: null,
      updatedAt: iso(), message: failure.message, error: failure.message, expiresAt: expiry(), fileName: undefined, fileSize: undefined, downloadUrl: undefined, infoUrl: undefined });
    await removePartials(job); await persist(job);
  };
  const run = async (job: StoredJob) => {
    const signal = job.controller.signal;
    const checkSize = async () => {
      checkAbort(signal);
      if (await directorySize(job.directory) > serverConfig.maxDownloadBytes()) {
        const error = new ApiFailure(413, "FILE_TOO_LARGE", "The job files exceed the configured size limit.");
        job.controller.abort(error); throw error;
      }
      checkAbort(signal);
    };
    let watching: Promise<void> | undefined;
    const watchdog = setInterval(() => {
      if (watching || signal.aborted) return;
      watching = checkSize().catch((error: unknown) => { job.controller.abort(error); }).finally(() => { watching = undefined; });
    }, options.watchdogIntervalMs ?? 250);
    const timeout = setTimeout(() => job.controller.abort(new ApiFailure(504, "DOWNLOAD_TIMEOUT", "The job exceeded its elapsed time limit.")), serverConfig.downloadTimeoutMs());
    try {
      checkAbort(signal);
      progress(job, { status: "analyzing", stage: "analyzing", progress: null, message: "Checking the video and selected formats." });
      const media = await deps.analyze(job.request.url, { signal });
      checkAbort(signal); formatSelector(job.request, media);
      progress(job, { status: "downloading", stage: "downloading", progress: 0, message: "Downloading media." });
      const source = await deps.download(job.directory, job.request, media, { signal, progress: (value) => progress(job, value) });
      await checkSize();
      progress(job, { status: "processing", stage: "processing", progress: 99, message: "Validating and tagging the final file." });
      const final = await deps.finalize(source, job.directory, job.request, media, { signal, beforePublish: checkSize });
      checkAbort(signal);
      if (job.request.includeInfoJson) await deps.info(path.join(job.directory, `${job.view.id}.info.json`), media, job.request, final.fileName, signal);
      await checkSize(); await drain(job);
      if (job.persistenceError) throw job.persistenceError;
      await rm(path.join(job.directory, "source"), { recursive: true, force: true });
      clearInterval(watchdog); await watching;
      await checkSize(); checkAbort(signal);
      // This mutation has no await boundary. Cancellation sees either an
      // active controller or a terminal completed job, never an in-between.
      Object.assign(job.view, { status: "completed", stage: "completed", progress: 100, message: "Download is ready.", updatedAt: iso(),
        fileName: final.fileName, fileSize: final.size, downloadUrl: `/api/downloads/${job.view.id}/file`,
        infoUrl: job.request.includeInfoJson ? `/api/downloads/${job.view.id}/info` : undefined, expiresAt: expiry(), error: undefined });
      clearTimeout(timeout);
      await persist(job);
      await catalogCompleted(job, media);
      // A late catalog/retention write failure does not invalidate valid media.
      await persist(job).catch(() => { job.view.retentionError = "The file is ready, but its library state could not be persisted."; });
    } catch (error) {
      clearInterval(watchdog); clearTimeout(timeout); await watching;
      await fail(job, error);
    } finally { clearInterval(watchdog); clearTimeout(timeout); }
  };
  const pumpQueue = () => {
    if (pump || disposed) return;
    pump = (async () => {
      while (queue.length && !disposed) {
        const job = jobs.get(queue.shift()!);
        if (!job || job.view.status !== "queued") continue;
        if (Date.parse(job.view.expiresAt!) <= now()) { await expire(job); continue; }
        job.task = run(job);
        await job.task.catch((error: unknown) => { console.error("Download job state write failed", error); });
      }
    })().catch((error: unknown) => { console.error("Download queue operation failed", error); })
      .finally(() => { pump = undefined; if (queue.length && !disposed) pumpQueue(); });
  };
  const expire = async (job: StoredJob) => {
    const index = queue.indexOf(job.view.id); if (index >= 0) queue.splice(index, 1);
    job.controller.abort(new ApiFailure(410, "JOB_EXPIRED", "The job has expired."));
    await job.task?.catch(() => undefined); await drain(job);
    await library.cleanupJob(job.view.id, async () => { await rm(job.directory, { recursive: true, force: true }); });
    jobs.delete(job.view.id);
  };
  const cleanupExpired = (): Promise<void> => {
    if (cleanup) return cleanup;
    cleanup = (async () => {
      for (const job of jobs.values()) if ((terminal.has(job.view.status) || job.view.status === "queued") && Date.parse(job.view.expiresAt!) <= now()) await expire(job);
      await library.cleanupExpired();
    })().finally(() => { cleanup = undefined; });
    return cleanup;
  };
  const initialize = (): Promise<void> => {
    if (init) return init;
    init = (async () => {
      await mkdir(root, { recursive: true, mode: 0o700 });
      await library.initialize();
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!UUID.test(entry.name)) continue; // Never clean unrelated user data.
        const directory = path.join(root, entry.name);
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        let validated = false;
        try {
          const manifest = path.join(directory, "job.json"); const info = await lstat(manifest);
          if (!info.isFile() || info.isSymbolicLink() || info.size > 100_000) throw new Error("Invalid manifest file");
          const parsed = manifestSchema.parse(JSON.parse(await readFile(manifest, "utf8")));
          if (parsed.id !== entry.name) throw new Error("Manifest ID mismatch");
          const request = parseDownloadRequest(parsed.request);
          validated = true;
          const { request: _request, ...view } = parsed;
          void _request;
          // URLs are derived rather than trusted from persisted input.
          view.downloadUrl = view.status === "completed" ? `/api/downloads/${view.id}/file` : undefined;
          view.infoUrl = view.status === "completed" && request.includeInfoJson ? `/api/downloads/${view.id}/info` : undefined;
          view.expiresAt ??= new Date(Date.parse(view.status === "queued" ? view.createdAt : view.updatedAt) + ttlMs()).toISOString();
           const job: StoredJob = { directory, view, request, controller: new AbortController() };
           if (Date.parse(view.expiresAt) <= now()) { await rm(directory, { recursive: true, force: true }); continue; }
           jobs.set(view.id, job);
           if (await library.isDeleted(view.id)) { markDeleted(job); await persist(job); }
           else if (!terminal.has(view.status)) await fail(job, new ApiFailure(500, "INTERRUPTED", "The server restarted before this download completed."));
           else if (view.status === "completed") {
             const catalogItem = view.libraryItemId ? await library.get(view.libraryItemId) : null;
             const output = path.join(directory, view.fileName!);
             const outputInfo = await lstat(output).catch(() => null);
             const realDirectory = await realpath(directory);
             const realOutput = outputInfo?.isFile() && !outputInfo.isSymbolicLink() ? await realpath(output).catch(() => "") : "";
             const infoFile = path.join(directory, `${view.id}.info.json`);
             const infoInfo = request.includeInfoJson ? await lstat(infoFile).catch(() => null) : null;
             const infoIsValid = !request.includeInfoJson || Boolean(catalogItem?.infoUrl) || Boolean(infoInfo?.isFile() && !infoInfo.isSymbolicLink() && infoInfo.size > 0 && await realpath(infoFile).then((value) => value.startsWith(`${realDirectory}${path.sep}`), () => false));
             const fileIsValid = Boolean(outputInfo?.isFile() && !outputInfo.isSymbolicLink() && outputInfo.size === view.fileSize && realOutput.startsWith(`${realDirectory}${path.sep}`));
             if (!fileIsValid || !infoIsValid) {
               Object.assign(view, { status: "failed", progress: null, stage: "failed", message: "The completed job files are missing or invalid.", error: "The completed job files are missing or invalid.", fileName: undefined, fileSize: undefined, downloadUrl: undefined, infoUrl: undefined });
               await persist(job); // Preserve preexisting invalid output for inspection.
             } else {
               await catalogCompleted(job);
               if (catalogItem && view.reused) {
                 view.downloadUrl = catalogItem.downloadUrl;
                 view.infoUrl = request.includeInfoJson ? catalogItem.infoUrl ?? undefined : undefined;
               }
             }
           }
            else if (view.stage !== "deleted") await removePartials(job);
        } catch (error) {
          // A disk/permission failure recovering a valid job is not a corrupt
          // manifest. Preserve its directory and let initialization fail.
          if (validated) throw error;
          jobs.delete(entry.name); // Unknown/corrupt data is not deletion authority.
        }
      }
      cleanupTimer = setInterval(() => { void cleanupExpired().catch((error: unknown) => console.error("Job expiry cleanup failed", error)); }, options.cleanupIntervalMs ?? 60_000);
      cleanupTimer.unref();
    })();
    return init;
  };
  const lookup = async (id: string) => {
    await initialize(); await cleanupExpired();
    return UUID.test(id) ? jobs.get(id) : undefined;
  };
  return {
    initialize,
    create(input: DownloadRequest): Promise<DownloadJob> { return serialCreate(async () => {
      let request = input;
      request = parseDownloadRequest(request);
      if (disposed) throw new ApiFailure(503, "QUEUE_UNAVAILABLE", "The download queue is unavailable.");
      await initialize(); await cleanupExpired();
      let key = requestedVersion(request);
      for (const job of jobs.values()) {
        if (job.view.status === "completed" && requestedVersion(job.request) === key) await job.task;
        if (terminal.has(job.view.status) || requestedVersion(job.request) !== key) continue;
        const needsInfo = request.includeInfoJson && !job.request.includeInfoJson;
        job.request.keepInLibrary ||= request.keepInLibrary;
        job.request.includeInfoJson ||= request.includeInfoJson;
        await persist(job);
        // If JSON was requested after the processing phase passed its info
        // boundary, wait for publication and synthesize from the saved snapshot.
        if (needsInfo && job.view.status === "processing") {
          await job.task;
          if (job.view.libraryItemId) {
            const upgraded = await library.findVersion(key, true);
            if (upgraded?.infoUrl) job.view.infoUrl = upgraded.infoUrl;
          }
        }
        if (terminal.has(job.view.status) && request.keepInLibrary && job.view.libraryItemId) {
          try { await library.retain(job.view.libraryItemId); }
          catch { job.view.retentionError = "The file remains temporary; retaining it failed."; }
        }
        return { ...project(job), reused: true };
      }
      if (request.metadata.artwork.source === "thumbnail" && !request.metadata.artwork.url && await library.hasImplicitArtworkVersion(request)) {
        // Resolve an implicit thumbnail before claiming the same applied bytes.
        // This is an analysis only; exact reuse never invokes the downloader.
        const media = await deps.analyze(request.url);
        if (media.thumbnail) request = { ...request, metadata: { ...request.metadata, artwork: { source: "thumbnail", url: media.thumbnail } } };
        key = requestedVersion(request);
      }
      let reusable = await library.findVersion(key, request.includeInfoJson);
      if (reusable) {
        let retentionError: string | undefined;
        if (request.keepInLibrary) {
          try { reusable = await library.retain(reusable.id); }
          catch { retentionError = "The file remains temporary; retaining it failed."; }
        }
        const original = jobs.get(reusable.id);
        const view: DownloadJob = { id: reusable.id, status: "completed", progress: 100, stage: "completed", message: "An exact completed export was reused.",
          createdAt: reusable.createdAt, updatedAt: iso(), fileName: reusable.fileName, fileSize: reusable.fileSize, downloadUrl: reusable.downloadUrl,
          infoUrl: request.includeInfoJson ? reusable.infoUrl ?? undefined : undefined, libraryItemId: reusable.id, reused: true, retentionError,
          expiresAt: original?.view.expiresAt ?? reusable.expiresAt ?? undefined };
        // A retained export can outlive its original manifest. Its catalog ID
        // remains pollable without creating a fake job directory.
        if (original) {
          Object.assign(original.view, view);
          original.request.keepInLibrary ||= request.keepInLibrary;
          original.request.includeInfoJson ||= request.includeInfoJson;
          await persist(original).catch(() => { original.view.retentionError = "The reused file is available, but its job state could not be saved."; });
        }
        return original ? project(original) : view;
      }
      if (disposed) throw new ApiFailure(503, "QUEUE_UNAVAILABLE", "The download queue is unavailable.");
      if ([...jobs.values()].filter((job) => !terminal.has(job.view.status)).length + creating >= 8) throw new ApiFailure(429, "QUEUE_FULL", "The download queue is full. Try again shortly.");
      creating++;
      const id = randomUUID(); const directory = path.join(root, id);
      try {
        await mkdir(directory, { mode: 0o700 });
        const job: StoredJob = { directory, request: structuredClone(request), controller: new AbortController(),
          view: { id, status: "queued", progress: null, stage: "queued", message: "Waiting in queue.", createdAt: iso(), updatedAt: iso(), expiresAt: expiry() } };
        jobs.set(id, job);
        await persist(job); queue.push(id);
        const result = project(job); pumpQueue(); return result;
      } catch (error) { jobs.delete(id); await locks.get(id)?.catch(() => undefined); await rm(directory, { recursive: true, force: true }); throw error; }
      finally { creating--; }
    }); },
    async get(id: string): Promise<DownloadJob | null> {
      const job = await lookup(id); if (job) { if (job.view.status === "completed") await job.task; return project(job); }
      const retained = await library.get(id);
      return retained ? projectLibrary(retained) : null;
    },
    async list(): Promise<DownloadJob[]> {
      await initialize(); await cleanupExpired();
      return Promise.all([...jobs.values()].map(async (job) => { if (job.view.status === "completed") await job.task; return project(job); }));
    },
    async listLibrary(retention?: "temporary" | "permanent", query = "") { await initialize(); return library.list(retention, query); },
    async getLibraryItem(id: string) { await initialize(); return library.get(id); },
    async openLibraryFile(id: string, kind: "file" | "info") { await initialize(); return library.openFile(id, kind); },
    async retainLibraryItem(id: string) { await initialize(); return library.retain(id); },
    async deleteLibraryItem(id: string) {
      await initialize(); const job = jobs.get(id);
      try { return await library.delete(id); }
      finally {
        if (job?.view.status === "completed" && await library.isDeleted(id)) { markDeleted(job); await persist(job); }
      }
    },
    async cancel(id: string): Promise<DownloadJob | null> {
      const job = await lookup(id);
      if (!job) { const item = await library.get(id); return item ? projectLibrary(item) : null; }
      if (terminal.has(job.view.status)) { await job.task; await drain(job); return project(job); }
      job.controller.abort(new ApiFailure(499, "CANCELLED", "The download was cancelled."));
      const index = queue.indexOf(id); if (index >= 0) queue.splice(index, 1);
      if (job.task) await job.task;
      else await fail(job, job.controller.signal.reason);
      return project(job);
    },
    async resolveFile(id: string, kind: "file" | "info"): Promise<{ job: DownloadJob; path: string } | null> {
      const job = await lookup(id);
      if (!job) {
        const item = await library.get(id); const file = kind === "info" ? item?.infoPath : item?.filePath;
        return item && file ? { job: projectLibrary(item), path: file } : null;
      }
      if (job.view.status !== "completed") return null;
      if ((kind === "info" ? job.view.infoUrl : job.view.downloadUrl)?.startsWith("/api/library/")) {
        const item = job.view.libraryItemId ? await library.get(job.view.libraryItemId) : null;
        const file = kind === "info" ? item?.infoPath : item?.filePath;
        return file ? { job: project(job), path: file } : null;
      }
      if (kind === "info" && !job.request.includeInfoJson) return null;
      const fileName = kind === "file" ? job.view.fileName : `${id}.info.json`;
      if (!fileName || path.basename(fileName) !== fileName || /[\\/\u0000-\u001f]/.test(fileName)) return null;
      try {
        const directoryInfo = await lstat(job.directory); if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) return null;
        const resolved = path.join(job.directory, fileName); const info = await lstat(resolved);
        if (!info.isFile() || info.isSymbolicLink() || info.size <= 0 || (kind === "file" && info.size !== job.view.fileSize)) return null;
        if (await realpath(resolved) !== path.join(await realpath(job.directory), fileName)) return null;
        return { job: project(job), path: resolved };
      } catch { return null; }
    },
    async dispose(): Promise<void> {
      disposed = true; if (cleanupTimer) clearInterval(cleanupTimer);
      for (const job of jobs.values()) if (!terminal.has(job.view.status)) job.controller.abort(new ApiFailure(499, "CANCELLED", "The download was cancelled."));
      await creationTail; await pump; await cleanup; await Promise.all([...locks.values()].map((promise) => promise.catch(() => undefined))); await library.close();
    },
  };
}

type Manager = ReturnType<typeof createJobManager>;
const runtimeKey = Symbol.for("vipod.downloader.manager.v2");
function manager(): Manager {
  const host = globalThis as typeof globalThis & { [runtimeKey]?: Manager };
  return host[runtimeKey] ??= createJobManager();
}
export const createJob = (request: DownloadRequest) => manager().create(request);
export const getJob = (id: string) => manager().get(id);
export const cancelJob = (id: string) => manager().cancel(id);
export const resolveJobFile = (id: string, kind: "file" | "info") => manager().resolveFile(id, kind);
export const initializeJobs = () => manager().initialize();
export const listJobs = () => manager().list();
export const listLibrary = (retention?: "temporary" | "permanent", query = "") => manager().listLibrary(retention, query);
export const getLibraryItem = (id: string) => manager().getLibraryItem(id);
export const openLibraryFile = (id: string, kind: "file" | "info") => manager().openLibraryFile(id, kind);
export const retainLibraryItem = (id: string) => manager().retainLibraryItem(id);
export const deleteLibraryItem = (id: string) => manager().deleteLibraryItem(id);
