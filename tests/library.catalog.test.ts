import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { createLibraryCatalog } from "../src/lib/server/library";
import { parseDownloadRequest } from "../src/lib/server/validation";

const request = parseDownloadRequest({ url: "https://youtu.be/abcdefghijk", mode: "audio", audioFormat: "mp3", audioQuality: "best", includeInfoJson: true,
  metadata: { title: "Library track", artist: "Artist", album: "Album", albumArtist: "", date: "", genre: "", trackNumber: "", discNumber: "", artwork: { source: "none" } } });
async function fixture(now: () => number = Date.now, dependencies?: NonNullable<Parameters<typeof createLibraryCatalog>[0]>["dependencies"]) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "vipod-library-"));
  const catalog = createLibraryCatalog({ directory, now, dependencies });
  await catalog.initialize();
  const id = randomUUID(); await mkdir(path.join(directory, id));
  const filePath = path.join(directory, id, "temporary.mp3"); await writeFile(filePath, "same bytes");
  const infoPath = path.join(directory, id, "temporary.info.json"); await writeFile(infoPath, "{}");
  const item = await catalog.add({ id, request, fileName: "temporary.mp3", fileSize: 10,
    createdAt: new Date(now()).toISOString(), expiresAt: new Date(now() + 3600).toISOString(), filePath, infoPath });
  return { directory, catalog, item, filePath, close: async () => { await catalog.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("promoting a temporary export preserves identical bytes and permanent data survives expiry and restart", async () => {
  let clock = Date.now(); const f = await fixture(() => clock);
  try {
    const before = await readFile(f.filePath);
    const retained = await f.catalog.retain(f.item.id);
    assert.equal(retained.retention, "permanent");
    assert.deepEqual(await readFile(path.join(f.directory, "library", f.item.id, "temporary.mp3")), before);
    await f.catalog.close(); clock += 10 * 24 * 60 * 60 * 1000;
    const restarted = createLibraryCatalog({ directory: f.directory, now: () => clock });
    try { assert.equal((await restarted.get(f.item.id))?.retention, "permanent"); }
    finally { await restarted.close(); }
  } finally { await f.close(); }
});

test("temporary expiry removes catalog entry and media; missing or tampered output is excluded", async () => {
  let clock = Date.now(); const prior = process.env.JOB_TTL_HOURS; process.env.JOB_TTL_HOURS = "0.001";
  const f = await fixture(() => clock);
  try {
    clock += 3601;
    assert.deepEqual(await f.catalog.list(), []);
    await assert.rejects(readFile(f.filePath));
  } finally { await f.close(); if (prior === undefined) delete process.env.JOB_TTL_HOURS; else process.env.JOB_TTL_HOURS = prior; }
});

test("literal search covers title, artist, and album and deletion is idempotent", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.catalog.list(undefined, "Artist")).length, 1);
    assert.equal((await f.catalog.list(undefined, "%" )).length, 0);
    assert.equal(await f.catalog.delete(f.item.id), true);
    assert.equal(await f.catalog.delete(f.item.id), false);
  } finally { await f.close(); }
});

test("LIST and GET recheck missing JSON, changed bytes, and symlink ancestors after initialization", async () => {
  const f = await fixture();
  try {
    const item = await f.catalog.get(f.item.id); assert.ok(item);
    await writeFile(item.infoPath!, "{broken}"); assert.deepEqual(await f.catalog.list(), []); assert.equal(await f.catalog.get(f.item.id), null);
    await writeFile(item.infoPath!, "{}"); assert.equal((await f.catalog.list()).length, 1);
    await writeFile(item.filePath, "evil bytes"); assert.equal((await f.catalog.list()).length, 0);
  } finally { await f.close(); }
});

for (const failure of ["media-copy", "info-copy", "sql"] as const) {
  test(`promotion ${failure} failure cleans every staged destination and preserves original media plus JSON`, async () => {
    let copies = 0;
    const f = await fixture(Date.now, { copy: async (...args) => {
      copies++;
      if (failure === "media-copy" && copies === 1 || failure === "info-copy" && copies === 2) {
        await writeFile(args[1], "partial"); throw new Error("Injected copy failure");
      }
      await copyFile(...args);
    }, beforeWrite: (op) => { if (failure === "sql" && op === "retain") throw new Error("Injected SQL failure"); } });
    try {
      await assert.rejects(f.catalog.retain(f.item.id), /remains temporary/);
      assert.deepEqual(await readdir(path.join(f.directory, "library")), []);
      assert.equal(await readFile(f.filePath, "utf8"), "same bytes");
      const item = await f.catalog.get(f.item.id); assert.equal(item?.retention, "temporary"); assert.equal(await readFile(item!.infoPath!, "utf8"), "{}");
    } finally { await f.close(); }
  });
}

test("retain/delete/expiry serialize during a held copy and cannot resurrect or expire the retained file", async () => {
  let clock = Date.now(); let entered!: () => void; let release!: () => void;
  const started = new Promise<void>((done) => { entered = done; }); const hold = new Promise<void>((done) => { release = done; });
  let copies = 0;
  const f = await fixture(() => clock, { copy: async (...args) => { if (++copies === 1) { entered(); await hold; } await copyFile(...args); } });
  try {
    const promotion = f.catalog.retain(f.item.id); await started; clock += 5000;
    const list = f.catalog.list(); const deletion = f.catalog.delete(f.item.id); const repeatedRetain = f.catalog.retain(f.item.id);
    const rejection = assert.rejects(repeatedRetain, /not found|expired/);
    release(); assert.equal((await promotion).retention, "permanent"); assert.equal((await list)[0].retention, "permanent"); assert.equal(await deletion, true); await rejection;
    assert.equal(await f.catalog.get(f.item.id), null);
    await assert.rejects(readFile(path.join(f.directory, "library", f.item.id, "temporary.mp3")));
  } finally { release(); await f.close(); }
});

test("tampered DB paths never authorize reading or deleting an outside file", async () => {
  const f = await fixture(); const outside = await mkdtemp(path.join(os.tmpdir(), "vipod-outside-")); const external = path.join(outside, "keep.mp3");
  try {
    await writeFile(external, "same bytes"); const db = new DatabaseSync(path.join(f.directory, "library.sqlite"));
    try { db.prepare("UPDATE exports SET file_path=? WHERE id=?").run(external, f.item.id); } finally { db.close(); }
    assert.deepEqual(await f.catalog.list(), []); assert.equal(await f.catalog.get(f.item.id), null);
    await f.catalog.delete(f.item.id); assert.equal(await readFile(external, "utf8"), "same bytes");
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});

test("symlinked job/library ancestors are rejected and deletion never traverses them", async () => {
  const f = await fixture(); const outside = await mkdtemp(path.join(os.tmpdir(), "vipod-link-"));
  try {
    const item = await f.catalog.get(f.item.id); assert.ok(item);
    await writeFile(path.join(outside, "temporary.mp3"), "same bytes"); await writeFile(path.join(outside, "temporary.info.json"), "{}");
    await rm(path.dirname(f.filePath), { recursive: true }); await symlink(outside, path.dirname(f.filePath));
    assert.deepEqual(await f.catalog.list(), []); assert.equal(await f.catalog.get(f.item.id), null); await assert.rejects(f.catalog.retain(f.item.id));
    await f.catalog.delete(f.item.id); assert.equal(await readFile(path.join(outside, "temporary.mp3"), "utf8"), "same bytes");
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});

test("restart reconciles a fingerprinted complete promotion left between directory rename and SQL publication", async () => {
  let clock = Date.now(); const f = await fixture(() => clock);
  try {
    await f.catalog.retain(f.item.id);
    const db = new DatabaseSync(path.join(f.directory, "library.sqlite"));
    try { db.prepare("UPDATE exports SET retention='temporary',expires_at=?,file_path=?,info_path=? WHERE id=?").run(new Date(clock + 3600).toISOString(), f.filePath, path.join(path.dirname(f.filePath), "temporary.info.json"), f.item.id); }
    finally { db.close(); }
    await f.catalog.close(); clock += 5000;
    const restarted = createLibraryCatalog({ directory: f.directory, now: () => clock });
    try {
      const item = await restarted.get(f.item.id); assert.equal(item?.retention, "permanent"); assert.equal(item?.expiresAt, null);
      assert.equal(await readFile(item!.filePath, "utf8"), "same bytes"); assert.equal(await readFile(item!.infoPath!, "utf8"), "{}");
    } finally { await restarted.close(); }
  } finally { await f.close(); }
});

test("future schema versions fail closed without deleting catalog or media", async () => {
  const f = await fixture();
  try {
    await f.catalog.close(); const db = new DatabaseSync(path.join(f.directory, "library.sqlite")); db.exec("PRAGMA user_version=3"); db.close();
    const unknown = createLibraryCatalog({ directory: f.directory });
    try { await assert.rejects(unknown.initialize(), /Unsupported/); assert.equal(await readFile(f.filePath, "utf8"), "same bytes"); }
    finally { await unknown.close(); }
  } finally { await f.close(); }
});

for (const tombstoneShape of ["id-only", "id-and-row-json"] as const) {
  test(`migrates actual v1 catalog with ${tombstoneShape} tombstones and preserves export/media through retain/delete/restart`, async () => {
    const f = await fixture(); const otherId = randomUUID();
    try {
      await f.catalog.close();
      const db = new DatabaseSync(path.join(f.directory, "library.sqlite"));
      try {
        db.exec("BEGIN IMMEDIATE; DROP TABLE deleted_exports;");
        db.exec(tombstoneShape === "id-only" ? "CREATE TABLE deleted_exports(id TEXT PRIMARY KEY);" : "CREATE TABLE deleted_exports(id TEXT PRIMARY KEY,row_json TEXT);");
        db.prepare(tombstoneShape === "id-only" ? "INSERT INTO deleted_exports(id) VALUES(?)" : "INSERT INTO deleted_exports(id,row_json) VALUES(?,NULL)").run(otherId);
        db.exec("PRAGMA user_version=1; COMMIT;");
      } finally { db.close(); }

      const migrated = createLibraryCatalog({ directory: f.directory });
      try {
        const listed = await migrated.list("temporary"); assert.equal(listed.length, 1); assert.equal(listed[0].id, f.item.id);
        assert.equal((await migrated.get(f.item.id))?.retention, "temporary");
        const retained = await migrated.retain(f.item.id); assert.equal(retained.retention, "permanent");
        assert.equal(await readFile(path.join(f.directory, "library", f.item.id, "temporary.mp3"), "utf8"), "same bytes");
        const check = new DatabaseSync(path.join(f.directory, "library.sqlite"));
        try {
          assert.equal((check.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 2);
          const columns = check.prepare("PRAGMA table_info(deleted_exports)").all() as Array<{ name: string }>;
          assert.ok(columns.some((column) => column.name === "row_json"));
          assert.ok(check.prepare("SELECT id FROM deleted_exports WHERE id=?").get(otherId));
        } finally { check.close(); }
        assert.equal(await readFile(f.filePath, "utf8"), "same bytes");
        assert.equal(await migrated.delete(f.item.id), true);
      } finally { await migrated.close(); }
      const restarted = createLibraryCatalog({ directory: f.directory });
      try { assert.equal(await restarted.get(f.item.id), null); await assert.rejects(readFile(f.filePath)); }
      finally { await restarted.close(); }
    } finally { await f.close(); }
  });
}

test("partial filesystem deletion remains hidden and is durably retryable after restart", async () => {
  let fail = true;
  const f = await fixture(Date.now, { remove: async (...args) => { if (fail) throw new Error("Injected unlink failure"); await rm(...args); } });
  try {
    await assert.rejects(f.catalog.delete(f.item.id), /Injected unlink/);
    assert.equal(await readFile(f.filePath, "utf8"), "same bytes");
    assert.deepEqual(await f.catalog.list(), []); // Failed cleanup never becomes a visible export.
    await f.catalog.close(); fail = false;
    const restarted = createLibraryCatalog({ directory: f.directory });
    try { assert.equal(await restarted.delete(f.item.id), false); await assert.rejects(readFile(f.filePath)); assert.equal(await restarted.get(f.item.id), null); }
    finally { await restarted.close(); }
  } finally { await f.close(); }
});
