import "server-only";
import { DatabaseSync } from "node:sqlite";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { DownloadRequest, LibraryItem, MediaInfo } from "@/lib/contracts";
import { serverConfig } from "./config";
import { ApiFailure } from "./errors";
import { parseDownloadRequest } from "./validation";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
type Row = { id: string; request_json: string; media_json: string | null; format: string; file_name: string; file_size: number; created_at: string;
  retention: LibraryItem["retention"]; expires_at: string | null; file_path: string; info_path: string | null; version_key: string; digest: string; info_digest: string | null; origin_info_path: string | null };
type CatalogOptions = { directory?: string; now?: () => number; dependencies?: { copy?: typeof copyFile; remove?: typeof rm; beforeWrite?: (operation: string) => void } };
type Publication = { id: string; request: DownloadRequest; media?: MediaInfo; fileName: string; fileSize: number; createdAt: string; expiresAt: string;
  filePath: string; infoPath: string | null };

export function versionKey(request: DownloadRequest): string {
  const r = parseDownloadRequest(request);
  const m = r.metadata;
  return JSON.stringify([new URL(r.url).searchParams.get("v"), r.mode, r.audioFormat, r.audioQuality, r.formatId ?? null, r.audioFormatId ?? null,
    m.title, m.artist, m.album, m.albumArtist, m.date, m.genre, m.trackNumber, m.discNumber, m.artwork.source, m.artwork.source === "none" ? null : m.artwork.url ?? null]);
}

// A single serialized catalog boundary includes filesystem work. In particular,
// promotion, deletion, expiry and originating-job cleanup cannot interleave.
export function createLibraryCatalog(options: CatalogOptions = {}) {
  const root = path.resolve(options.directory ?? serverConfig.dataDirectory());
  const storage = path.join(root, "library");
  const now = options.now ?? Date.now;
  const copy = options.dependencies?.copy ?? copyFile;
  const remove = options.dependencies?.remove ?? rm;
  let db: DatabaseSync | undefined; let initialization: Promise<void> | undefined;
  let canonicalRoot = "";
  let tail = Promise.resolve(); let closed = false;
  const checksums = new Map<string, { signature: string; checksum: string }>();
  const signature = async (file: string) => {
    const stat = await lstat(file, { bigint: true });
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  };
  const sql = () => { if (!db || closed) throw new Error("Library catalog is closed."); return db; };
  const beforeWrite = (operation: string) => options.dependencies?.beforeWrite?.(operation);
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work); tail = next.then(() => undefined, () => undefined); return next;
  };
  const initialize = () => {
    if (closed) return Promise.reject(new Error("Library catalog is closed."));
    return initialization ??= (async () => {
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await lstat(root)).isSymbolicLink()) throw new Error("Unsafe data directory.");
    let ancestor = root;
    while (ancestor !== path.dirname(ancestor)) {
      const osAlias = process.platform === "darwin" && (ancestor === "/var" || ancestor === "/tmp");
      if (!osAlias && (await lstat(ancestor)).isSymbolicLink()) throw new Error("Unsafe data-directory ancestor.");
      ancestor = path.dirname(ancestor);
    }
    canonicalRoot = await realpath(root);
    const databasePath = path.join(root, "library.sqlite");
    for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, storage]) {
      const stat = await lstat(file).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (stat?.isSymbolicLink()) throw new Error("Unsafe library storage.");
    }
    await mkdir(storage, { recursive: true, mode: 0o700 });
    db = new DatabaseSync(databasePath);
    try {
      db.exec("PRAGMA busy_timeout=5000;");
      const version = db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version.user_version > 2) throw new Error("Unsupported library schema version.");
      if (version.user_version === 0 && db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get()) throw new Error("An unrecognized database exists at the library path; it was preserved.");
      db.exec("PRAGMA journal_mode=WAL;");
      if (version.user_version === 0) db.exec(`BEGIN IMMEDIATE;
        CREATE TABLE exports (
          id TEXT PRIMARY KEY, request_json TEXT NOT NULL, media_json TEXT, format TEXT NOT NULL,
          file_name TEXT NOT NULL, file_size INTEGER NOT NULL CHECK(file_size>0), created_at TEXT NOT NULL,
          retention TEXT NOT NULL CHECK(retention IN ('temporary','permanent')), expires_at TEXT,
          file_path TEXT NOT NULL, info_path TEXT, version_key TEXT NOT NULL, digest TEXT NOT NULL, info_digest TEXT, origin_info_path TEXT
        );
        CREATE TABLE deleted_exports(id TEXT PRIMARY KEY, row_json TEXT);
        CREATE INDEX exports_version ON exports(version_key, retention, created_at DESC);
        CREATE INDEX exports_expiry ON exports(retention, expires_at);
        PRAGMA user_version=2; COMMIT;`);
      else if (version.user_version === 1) {
        db.exec("BEGIN IMMEDIATE;");
        try {
          const deletedColumns = db.prepare("PRAGMA table_info(deleted_exports)").all() as Array<{ name: string }>;
          if (!deletedColumns.length) throw new Error("Schema v1 is missing deleted_exports; the database was preserved.");
          if (!deletedColumns.some((column) => column.name === "row_json")) db.exec("ALTER TABLE deleted_exports ADD COLUMN row_json TEXT");
          const exportColumns = db.prepare("PRAGMA table_info(exports)").all() as Array<{ name: string }>;
          if (!exportColumns.length) throw new Error("Schema v1 is missing exports; the database was preserved.");
          if (!exportColumns.some((column) => column.name === "origin_info_path")) db.exec("ALTER TABLE exports ADD COLUMN origin_info_path TEXT");
          db.exec("PRAGMA user_version=2; COMMIT;");
        } catch (error) { db.exec("ROLLBACK;"); throw error; }
      }
    } catch (error) { db.close(); db = undefined; throw error; }
    })();
  };
  const rowById = (id: string) => UUID.test(id) ? sql().prepare("SELECT * FROM exports WHERE id=?").get(id) as Row | undefined : undefined;
  const item = (row: Row): LibraryItem => {
    const request = parseDownloadRequest(JSON.parse(row.request_json));
    return { id: row.id, sourceId: new URL(request.url).searchParams.get("v")!, sourceUrl: request.url, metadata: request.metadata,
      mode: request.mode, format: row.format, fileName: row.file_name, fileSize: row.file_size, createdAt: row.created_at,
      retention: row.retention, expiresAt: row.expires_at, downloadUrl: `/api/library/${row.id}/file`, infoUrl: row.info_path ? `/api/library/${row.id}/info` : null };
  };
  const safePath = async (file: string, allowMissing = false): Promise<boolean> => {
    if ((await lstat(root)).isSymbolicLink() || await realpath(root) !== canonicalRoot) return false;
    const relative = path.relative(root, file); const parts = relative.split(path.sep);
    // Temporary files live directly in a job UUID; retained files in library/UUID.
    if (path.resolve(file) !== file || relative.startsWith("..") || path.isAbsolute(relative) ||
      !(parts.length === 2 && UUID.test(parts[0]) || parts.length === 3 && parts[0] === "library" && UUID.test(parts[1])) ||
      parts.some((part) => !part || part === "." || part === ".." || /[\\\u0000-\u001f]/.test(part))) return false;
    let cursor = root;
    for (let i = 0; i < parts.length; i++) {
      cursor = path.join(cursor, parts[i]);
      const stat = await lstat(cursor).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; });
      if (!stat) return allowMissing;
      if (stat.isSymbolicLink() || (i < parts.length - 1 && !stat.isDirectory()) || (i === parts.length - 1 && !stat.isFile())) return false;
    }
    return await realpath(file) === path.join(await realpath(root), relative);
  };
  const digest = async (file: string): Promise<string> => {
    const before = await signature(file);
    const hash = createHash("sha256");
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    for await (const chunk of handle.createReadStream()) hash.update(chunk);
    if (await signature(file) !== before) throw new Error("The output changed during integrity inspection.");
    const checksum = hash.digest("hex");
    // Revalidate paths/stat on every access, but reread media bytes only when
    // inode, size, nanosecond mtime or ctime changes. Bound this process cache.
    if (checksums.size >= 1000) checksums.delete(checksums.keys().next().value!);
    checksums.set(file, { signature: before, checksum });
    return checksum;
  };
  const matchesDigest = async (file: string, expected: string | null) => {
    const cached = checksums.get(file);
    return (cached?.signature === await signature(file) ? cached.checksum : await digest(file)) === expected;
  };
  const valid = async (row: Row): Promise<boolean> => {
    try {
      if (!Number.isFinite(Date.parse(row.created_at)) || row.retention !== "permanent" && (row.retention !== "temporary" || !row.expires_at || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at) <= now())) return false;
      const owner = row.retention === "permanent" ? path.join(storage, row.id) : path.join(root, row.id);
      if (!UUID.test(row.id) || path.basename(row.file_name) !== row.file_name || row.file_path !== path.join(owner, row.file_name) || row.info_path && path.dirname(row.info_path) !== owner || !await safePath(row.file_path) || (await lstat(row.file_path)).size !== row.file_size || !await matchesDigest(row.file_path, row.digest)) return false;
      if (row.info_path && (!await safePath(row.info_path) || (await lstat(row.info_path)).size <= 0 || !await matchesDigest(row.info_path, row.info_digest))) return false;
      item(row); return true;
    } catch { return false; }
  };
  const unlinkOwned = async (file: string | null) => { if (file && await safePath(file, true)) { await remove(file, { force: true }); checksums.delete(file); } };
  const purge = async (row: Row) => {
    if (UUID.test(row.id)) {
      const owner = row.retention === "permanent" ? path.join(storage, row.id) : path.join(root, row.id);
      if (row.file_path === path.join(owner, row.file_name) && path.basename(row.file_name) === row.file_name) await unlinkOwned(row.file_path);
      if (row.info_path && path.dirname(row.info_path) === owner) await unlinkOwned(row.info_path);
      // Promotion keeps originals until job expiry; explicit deletion removes
      // those known owned copies too. DB paths never authorize arbitrary rm.
      if (row.retention === "permanent" && path.basename(row.file_name) === row.file_name) {
        await unlinkOwned(path.join(root, row.id, row.file_name));
        if (row.origin_info_path && path.dirname(row.origin_info_path) === path.join(root, row.id)) await unlinkOwned(row.origin_info_path);
      }
    }
    sql().prepare("UPDATE deleted_exports SET row_json=NULL WHERE id=?").run(row.id);
  };
  const deleteRow = async (row: Row) => {
    // Persist the deletion intent before unlinking. Failed/partial filesystem
    // cleanup can be retried after restart without making the item visible.
    beforeWrite("delete");
    sql().exec("BEGIN IMMEDIATE");
    try { sql().prepare("INSERT OR REPLACE INTO deleted_exports VALUES(?,?)").run(row.id, JSON.stringify(row)); sql().prepare("DELETE FROM exports WHERE id=?").run(row.id); sql().exec("COMMIT"); }
    catch (error) { sql().exec("ROLLBACK"); throw error; }
    await purge(row);
  };
  const expire = async () => {
    const rows = sql().prepare("SELECT * FROM exports WHERE retention='temporary' AND expires_at<=? LIMIT 200").all(new Date(now()).toISOString()) as Row[];
    for (const row of rows) await deleteRow(row);
  };
  let recovered = false;
  const ready = async () => {
    await initialize();
    const pendingDeletes = sql().prepare("SELECT row_json FROM deleted_exports WHERE row_json IS NOT NULL LIMIT 200").all() as Array<{ row_json: string }>;
    for (const pending of pendingDeletes) {
      try { await purge(JSON.parse(pending.row_json) as Row); } catch { /* Keep the durable deletion intent for a later access/restart. */ }
    }
    if (!recovered) {
      // A crash after atomic directory publication but before SQL commit leaves
      // a complete, fingerprinted promotion. Reconcile only that exact row.
      const rows = sql().prepare("SELECT * FROM exports WHERE retention='temporary' LIMIT 200").all() as Row[];
      for (const row of rows) {
        if (!UUID.test(row.id)) continue;
        const marker = path.join(storage, row.id, ".promotion.json");
        if (!await safePath(marker) || (await lstat(marker)).size > 1000) continue;
        let proof: { id?: string; digest?: string; infoDigest?: string | null };
        try { proof = JSON.parse(await readFile(marker, "utf8")); } catch { continue; }
        if (proof.id !== row.id || proof.digest !== row.digest || proof.infoDigest !== row.info_digest) continue;
        const candidate = { ...row, retention: "permanent" as const, expires_at: null, file_path: path.join(storage, row.id, row.file_name), info_path: row.info_path ? path.join(storage, row.id, "info.json") : null };
        if (!await valid(candidate)) continue;
        beforeWrite("recover"); sql().prepare("UPDATE exports SET retention='permanent',expires_at=NULL,file_path=?,info_path=? WHERE id=?").run(candidate.file_path, candidate.info_path, row.id);
      }
      recovered = true;
    }
    await expire();
  };
  const retain = async (row: Row): Promise<LibraryItem> => {
    if (!await valid(row)) throw new ApiFailure(404, "LIBRARY_NOT_FOUND", "The export is missing or invalid.");
    if (row.retention === "permanent") return item(row);
    const stage = path.join(storage, randomUUID());
    const destination = path.join(storage, row.id);
    if ((await lstat(storage)).isSymbolicLink()) throw new ApiFailure(500, "INVALID_OUTPUT_PATH", "The library storage is unsafe.");
    // Exclusively create a stage; never overwrite an unknown/preexisting directory.
    await mkdir(stage, { mode: 0o700 });
    let published = false;
    try {
      await copy(row.file_path, path.join(stage, row.file_name), constants.COPYFILE_EXCL);
      if (row.info_path) await copy(row.info_path, path.join(stage, "info.json"), constants.COPYFILE_EXCL);
      if (await digest(path.join(stage, row.file_name)) !== row.digest || row.info_path && await digest(path.join(stage, "info.json")) !== row.info_digest) throw new Error("Promotion copy did not match its source.");
      await writeFile(path.join(stage, ".promotion.json"), JSON.stringify({ id: row.id, digest: row.digest, infoDigest: row.info_digest }), { mode: 0o600, flag: "wx" });
      if (await lstat(destination).catch(() => null)) throw new Error("A retained destination already exists; the temporary export remains available.");
      await rename(stage, destination); published = true;
      const file = path.join(destination, row.file_name); const info = row.info_path ? path.join(destination, "info.json") : null;
      beforeWrite("retain");
      sql().prepare("UPDATE exports SET retention='permanent',expires_at=NULL,file_path=?,info_path=? WHERE id=? AND retention='temporary'").run(file, info, row.id);
      return item(rowById(row.id)!);
    } catch {
      // Both copies and SQL are in the rollback boundary; originals are untouched.
      await rm(published ? destination : stage, { recursive: true, force: true });
      throw new ApiFailure(500, "RETENTION_FAILED", "The file remains temporary; retaining it failed.");
    }
  };
  return {
    root, storage, initialize,
    async close() { await tail; await initialization?.catch(() => undefined); if (!closed) { db?.close(); checksums.clear(); closed = true; } },
    cleanupExpired(): Promise<void> { return serialize(ready); },
    isDeleted(id: string): Promise<boolean> { return serialize(async () => { await initialize(); return UUID.test(id) && Boolean(sql().prepare("SELECT id FROM deleted_exports WHERE id=?").get(id)); }); },
    list(retention?: LibraryItem["retention"], query = ""): Promise<LibraryItem[]> { return serialize(async () => {
      await ready(); const q = query.trim().slice(0, 200);
      const rows = sql().prepare(`SELECT * FROM exports WHERE (?='' OR retention=?) AND
        (?='' OR instr(lower(json_extract(request_json,'$.metadata.title')),lower(?))>0 OR instr(lower(json_extract(request_json,'$.metadata.artist')),lower(?))>0 OR instr(lower(json_extract(request_json,'$.metadata.album')),lower(?))>0)
        ORDER BY created_at DESC,id LIMIT 200`).all(retention ?? "", retention ?? "", q, q, q, q) as Row[];
      const result: LibraryItem[] = []; for (const row of rows) if (await valid(row)) result.push(item(row)); return result;
    }); },
    get(id: string) { return serialize(async () => {
      await ready(); const row = rowById(id); if (!row || !await valid(row)) return null;
      return { ...item(row), filePath: row.file_path, infoPath: row.info_path };
    }); },
    add(input: Publication): Promise<LibraryItem> { return serialize(async () => {
      await ready();
      const existing = rowById(input.id); if (existing && await valid(existing)) return item(existing);
      if (existing) throw new Error("An existing catalog export is missing or invalid.");
      if (sql().prepare("SELECT id FROM deleted_exports WHERE id=?").get(input.id)) throw new ApiFailure(410, "EXPORT_DELETED", "The export has been deleted.");
      if (!UUID.test(input.id) || input.filePath !== path.join(root, input.id, input.fileName) || !await safePath(input.filePath) || input.infoPath && (path.dirname(input.infoPath) !== path.join(root, input.id) || !await safePath(input.infoPath))) throw new Error("Unsafe publication path.");
      const checksum = await digest(input.filePath); const infoChecksum = input.infoPath ? await digest(input.infoPath) : null;
      if ((await lstat(input.filePath)).size !== input.fileSize || input.infoPath && (await lstat(input.infoPath)).size <= 0) throw new Error("Invalid publication size.");
      beforeWrite("add");
      const request = parseDownloadRequest(input.request);
      sql().prepare(`INSERT OR REPLACE INTO exports VALUES(?,?,?,?,?,?,?,'temporary',?,?,?,?,?,?,?)`).run(input.id, JSON.stringify(request), input.media ? JSON.stringify(input.media) : null,
        path.extname(input.fileName).slice(1), input.fileName, input.fileSize, input.createdAt, input.expiresAt, input.filePath, input.infoPath, versionKey(input.request), checksum, infoChecksum, input.infoPath);
      return item(rowById(input.id)!);
    }); },
    retain(id: string): Promise<LibraryItem> { return serialize(async () => { await ready(); const row = rowById(id);
      if (!row) throw new ApiFailure(404, "LIBRARY_NOT_FOUND", "The export was not found or has expired."); return retain(row);
    }); },
    delete(id: string): Promise<boolean> { return serialize(async () => { await ready(); const row = rowById(id); if (!row) return false; await deleteRow(row); return true; }); },
    hasImplicitArtworkVersion(request: DownloadRequest): Promise<boolean> { return serialize(async () => {
      await ready(); const key = versionKey(request);
      const rows = sql().prepare("SELECT * FROM exports WHERE json_extract(request_json,'$.url')=? ORDER BY created_at DESC LIMIT 200").all(request.url) as Row[];
      for (const row of rows) {
        const candidate = parseDownloadRequest(JSON.parse(row.request_json));
        if (candidate.metadata.artwork.source !== "thumbnail") continue;
        const withoutUrl = { ...candidate, metadata: { ...candidate.metadata, artwork: { source: "thumbnail" as const } } };
        if (versionKey(withoutUrl) === key && await valid(row)) return true;
      }
      return false;
    }); },
    findVersion(key: string, includeInfo = false): Promise<LibraryItem | null> { return serialize(async () => {
      await ready(); const rows = sql().prepare("SELECT * FROM exports WHERE version_key=? ORDER BY retention,created_at DESC LIMIT 200").all(key) as Row[];
      for (const row of rows) {
        if (!await valid(row)) continue;
        if (includeInfo && !row.info_path) {
          // Completed metadata, not another download, supplies an optional JSON.
          if (!row.media_json) throw new ApiFailure(409, "INFO_UNAVAILABLE", "This legacy export has no analysis snapshot for a JSON companion.");
          const file = path.join(path.dirname(row.file_path), "info.json"); const stage = path.join(path.dirname(row.file_path), `.info-${randomUUID()}.json`);
          try {
            if (await lstat(file).catch(() => null)) throw new Error("An info destination already exists.");
            const request = parseDownloadRequest(JSON.parse(row.request_json));
            await writeFile(stage, JSON.stringify({ media: JSON.parse(row.media_json), final: { fileName: row.file_name, metadata: request.metadata, mode: request.mode, audioFormat: request.audioFormat } }, null, 2), { mode: 0o600, flag: "wx" });
            const checksum = await digest(stage); await rename(stage, file);
            try { beforeWrite("info"); sql().prepare("UPDATE exports SET info_path=?,info_digest=?,origin_info_path=CASE WHEN retention='temporary' THEN ? ELSE origin_info_path END WHERE id=?").run(file, checksum, file, row.id); }
            catch (error) { await rm(file, { force: true }); throw error; }
            row.info_path = file; row.info_digest = checksum;
          } finally { await rm(stage, { force: true }); }
        }
        return item(row);
      }
      return null;
    }); },
    cleanupJob(id: string, removeDirectory: () => Promise<void>): Promise<void> { return serialize(async () => {
      await initialize(); const row = rowById(id);
      if (row?.retention === "temporary") await deleteRow(row);
      const directory = path.join(root, id);
      const stat = UUID.test(id) ? await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return null; throw error; }) : null;
      if (!stat) return;
      if (stat.isSymbolicLink() || !stat.isDirectory() || await realpath(root) !== canonicalRoot || await realpath(directory) !== path.join(canonicalRoot, id)) throw new ApiFailure(500, "INVALID_OUTPUT_PATH", "The job cleanup path is unsafe.");
      await removeDirectory();
    }); },
    async openFile(id: string, kind: "file" | "info") { return serialize(async () => {
      await ready(); const row = rowById(id); if (!row || !await valid(row)) return null;
      const file = kind === "file" ? row.file_path : row.info_path; if (!file) return null;
      const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const stat = await handle.stat(); const current = await lstat(file);
        if (!await safePath(file) || stat.ino !== current.ino || stat.dev !== current.dev || stat.size !== current.size) { await handle.close(); return null; }
        return { item: item(row), handle, size: stat.size };
      } catch (error) { await handle.close(); throw error; }
    }); },
  };
}

export type LibraryCatalog = ReturnType<typeof createLibraryCatalog>;
