import { spawn } from "node:child_process";
import { lstat, mkdir, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DownloadRequest, LibraryItem, MediaInfo, TrackMetadata } from "@/lib/contracts";

type JobManager = ReturnType<typeof import("@/lib/server/jobs").createJobManager>;

function mediaFor(url: string): MediaInfo {
  const id = new URL(url).searchParams.get("v");
  if (!id) throw new Error("The fixture request is missing its video ID.");
  return {
    id, url, title: "Local verification fixture", description: "", thumbnail: null, thumbnails: [],
    duration: 0.25, uploader: null, channel: null, uploadDate: null, viewCount: null, likeCount: null,
    categories: [], tags: [], music: {}, formats: [], chapters: [], subtitleLanguages: [], raw: {},
  };
}

function makeTone(filePath: string, ffmpegPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.25",
      "-codec:a", "libmp3lame", "-q:a", "9", "-y", filePath,
    ], { stdio: "ignore" });
    const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with status ${String(code)} while creating a local verification tone.`));
    });
  });
}

function metadata(title: string): TrackMetadata {
  return {
    title, artist: "VIPOD verification", album: "", albumArtist: "", date: "", genre: "",
    trackNumber: "", discNumber: "", artwork: { source: "none" },
  };
}

function request(videoId: string, title: string, keepInLibrary: boolean): DownloadRequest {
  return {
    url: `https://www.youtube.com/watch?v=${videoId}`, mode: "audio", audioFormat: "mp3", audioQuality: "best",
    metadata: metadata(title), includeInfoJson: true, keepInLibrary,
  };
}

async function waitForTerminal(manager: JobManager, id: string) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const job = await manager.get(id);
    if (!job) throw new Error(`Verification job ${id} disappeared before completion.`);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await manager.cancel(id);
  throw new Error(`Verification job ${id} did not reach a terminal state in time.`);
}

async function main() {
  const dataDirectory = process.env.DATA_DIR;
  if (!dataDirectory) throw new Error("Set DATA_DIR to an empty vipod-web-verify-* directory first.");

  const root = path.resolve(dataDirectory);
  if (!path.basename(root).startsWith("vipod-web-verify-")) {
    throw new Error("Refusing to seed data: DATA_DIR must have a vipod-web-verify-* basename.");
  }
  const safeParent = path.resolve(os.tmpdir(), "opencode");
  if (path.dirname(root) !== safeParent) {
    throw new Error("Refusing to seed data outside the isolated opencode temporary directory.");
  }
  const parentInfo = await lstat(safeParent).catch(() => null);
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) {
    throw new Error("Refusing to seed data: the opencode temporary directory must exist and must not be a symlink.");
  }
  const canonicalTemp = await realpath(os.tmpdir());
  const canonicalParent = await realpath(safeParent);
  if (!canonicalParent.startsWith(`${canonicalTemp}${path.sep}`)) {
    throw new Error("Refusing to seed data: the opencode temporary directory resolves outside the system temporary directory.");
  }

  const [{ serverConfig }, { createJobManager }] = await Promise.all([
    import("@/lib/server/config"), import("@/lib/server/jobs"),
  ]);
  // Create exactly the requested child, only after validating its real parent.
  await mkdir(root, { mode: 0o700 });
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error("Refusing to seed a non-directory or symlinked DATA_DIR.");
  if ((await realpath(path.dirname(root))) !== canonicalParent) throw new Error("Refusing to seed data: DATA_DIR parent changed during validation.");
  const existingEntries = await readdir(root);
  if (existingEntries.length) {
    throw new Error(`Refusing to seed non-empty DATA_DIR (${existingEntries.length} existing entries). Use a new empty verification directory.`);
  }

  const manager = createJobManager({
    directory: root,
    cleanupIntervalMs: 60_000,
    dependencies: {
      analyze: async (input) => {
        if (typeof input !== "string") throw new Error("The fixture analyzer received a non-string URL.");
        return mediaFor(input);
      },
      download: async (directory) => {
        const source = path.join(directory, "source", "verification.mp3");
        await mkdir(path.dirname(source), { recursive: true, mode: 0o700 });
        await makeTone(source, serverConfig.ffmpegPath);
        return source;
      },
      finalize: async (_source, directory) => {
        const output = path.join(directory, "verification.mp3");
        await makeTone(output, serverConfig.ffmpegPath);
        return { path: output, fileName: "verification.mp3", size: (await stat(output)).size, probe: {} };
      },
    },
  });

  let output: { dataDirectory: string; jobs: Awaited<ReturnType<typeof manager.get>>[]; requests: DownloadRequest[] } | undefined;
  try {
    await manager.initialize();
    const requests = [
      request("abcdefghijk", "Verification temporary track", false),
      request("ABCDEFGHIJK", "Verification saved track", true),
    ];
    const created = await Promise.all(requests.map((item) => manager.create(item)));
    const completed = await Promise.all(created.map((job) => waitForTerminal(manager, job.id)));
    if (completed.some((job) => job.status !== "completed")) {
      throw new Error(`Fixture job failed: ${JSON.stringify(completed.filter((job) => job.status !== "completed"))}`);
    }
    if (completed.some((job) => job.retentionError)) {
      throw new Error(`Fixture library retention failed: ${JSON.stringify(completed.filter((job) => job.retentionError))}`);
    }

    // Terminal cancel awaits each job task and its manifest writes, ensuring
    // publication has drained before taking the final list or printing.
    const jobs = await Promise.all(completed.map((job) => manager.cancel(job.id)));
    const listed = await manager.list();
    if (listed.some((job) => job.status !== "completed")) throw new Error("A fixture job was not completed in the final manager snapshot.");
    const libraryItems: LibraryItem[] = await manager.listLibrary();
    const expectedTitles = new Set(["Verification temporary track", "Verification saved track"]);
    const titles = libraryItems.map((item) => item.metadata.title);
    const temporaryItems = libraryItems.filter((item) => item.retention === "temporary");
    const permanentItems = libraryItems.filter((item) => item.retention === "permanent");
    if (libraryItems.length !== 2 || titles.some((title) => !expectedTitles.has(title)) || new Set(titles).size !== 2) {
      throw new Error(`Expected exactly the two fixture exports in the library; found ${JSON.stringify(libraryItems)}.`);
    }
    if (temporaryItems.length !== 1 || permanentItems.length !== 1) {
      throw new Error(`Expected one temporary and one permanent export; found ${JSON.stringify(libraryItems)}.`);
    }
    if (libraryItems.some((item) => !item.infoUrl)) {
      throw new Error(`Expected JSON companion files for both fixture exports; found ${JSON.stringify(libraryItems)}.`);
    }
    output = { dataDirectory: root, jobs, requests };
  } finally {
    await manager.dispose();
  }
  console.log(JSON.stringify(output, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
