import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createSingleFlightGuard } from "@/lib/client/single-flight-guard";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

function wrapperFor(client: QueryClient) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client }, children);
  };
}

test("a late search from the previous media session cannot replace current candidates", async () => {
  const { renderHook, waitFor, act, cleanup } = await import("@testing-library/react");
  const { useDownloaderQueries } = await import("@/lib/client/use-downloader-queries");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const previousFetch = globalThis.fetch;
  const responses: Array<(response: Response) => void> = [];
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/metadata/search")) {
      return new Promise<Response>((resolve) => { responses.push(resolve); });
    }
    return Response.json({ ready: true, tools: [] });
  };
  const hook = renderHook(
    (props: { session: number; search: string }) => useDownloaderQueries({ mediaSession: props.session, search: props.search, releaseId: "", jobId: null, cancelingJobId: null }),
    { initialProps: { session: 1, search: "Track" }, wrapper: wrapperFor(client) },
  );
  await waitFor(() => assert.equal(responses.length, 1));
  hook.rerender({ session: 2, search: "" });
  hook.rerender({ session: 2, search: "Track" });
  await waitFor(() => assert.equal(responses.length, 2));

  await act(async () => { responses[0](Response.json({ results: [{ id: "old" }] })); });
  assert.equal(hook.result.current.metadataSearch.data, undefined);
  await act(async () => { responses[1](Response.json({ results: [{ id: "new" }] })); });
  await waitFor(() => assert.equal(hook.result.current.metadataSearch.data?.results[0]?.id, "new"));

  cleanup(); client.clear(); globalThis.fetch = previousFetch;
});

test("an identical search can be refetched after a structurally unchanged result", async () => {
  const { renderHook, waitFor, act, cleanup } = await import("@testing-library/react");
  const { useDownloaderQueries } = await import("@/lib/client/use-downloader-queries");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const previousFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async (input) => String(input).includes("/api/metadata/search")
    ? (requests += 1, Response.json({ results: [{ id: "same", title: "Same" }] }))
    : Response.json({ ready: true, tools: [] });
  const hook = renderHook(
    () => useDownloaderQueries({ mediaSession: 4, search: "Same", releaseId: "", jobId: null, cancelingJobId: null }),
    { wrapper: wrapperFor(client) },
  );
  await waitFor(() => assert.equal(hook.result.current.metadataSearch.data?.results[0]?.id, "same"));
  await act(async () => { await client.invalidateQueries({ queryKey: ["metadata-search", 4, "Same"] }); });
  assert.equal(requests, 2);
  assert.equal(hook.result.current.metadataSearch.isFetching, false);

  cleanup(); client.clear(); globalThis.fetch = previousFetch;
});

test("a late album response remains isolated after selecting a different release", async () => {
  const { renderHook, waitFor, act, cleanup } = await import("@testing-library/react");
  const { useDownloaderQueries } = await import("@/lib/client/use-downloader-queries");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const previousFetch = globalThis.fetch;
  const releases: Array<{ id: string; resolve: (response: Response) => void; signal: AbortSignal }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/api/metadata/releases/")) {
      const id = url.split("/").pop()!;
      return new Promise<Response>((resolve) => releases.push({ id, resolve, signal: init?.signal as AbortSignal }));
    }
    return Response.json({ ready: true, tools: [] });
  };
  const hook = renderHook(
    (releaseId: string) => useDownloaderQueries({ mediaSession: 3, search: "", releaseId, jobId: null, cancelingJobId: null }),
    { initialProps: "release-old", wrapper: wrapperFor(client) },
  );
  await waitFor(() => assert.equal(releases.length, 1));
  hook.rerender("release-new");
  await waitFor(() => assert.equal(releases.length, 2));
  assert.equal(releases[0]?.signal.aborted, true);
  await act(async () => { releases[0]!.resolve(Response.json({ id: "release-old" })); });
  assert.equal(hook.result.current.release.data, undefined);
  await act(async () => { releases[1]!.resolve(Response.json({ id: "release-new" })); });
  await waitFor(() => assert.equal(hook.result.current.release.data?.id, "release-new"));

  cleanup(); client.clear(); globalThis.fetch = previousFetch;
});

test("job polling is disabled while cancellation is in progress", async () => {
  const { renderHook, waitFor, cleanup } = await import("@testing-library/react");
  const { useDownloaderQueries } = await import("@/lib/client/use-downloader-queries");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const previousFetch = globalThis.fetch;
  let jobRequests = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/downloads/job-1")) {
      jobRequests += 1;
      return Response.json({ id: "job-1", status: "downloading", progress: 20, stage: "downloading", createdAt: "", updatedAt: "" });
    }
    return Response.json({ ready: true, tools: [] });
  };
  const hook = renderHook(
    (cancelingJobId: string | null) => useDownloaderQueries({ mediaSession: 0, search: "", releaseId: "", jobId: "job-1", cancelingJobId }),
    { initialProps: null as string | null, wrapper: wrapperFor(client) },
  );
  await waitFor(() => assert.equal(jobRequests, 1));
  hook.rerender("job-1");
  await waitFor(() => assert.equal(hook.result.current.job.fetchStatus, "idle"));
  assert.equal(jobRequests, 1);

  cleanup(); client.clear(); globalThis.fetch = previousFetch;
});

test("job-ID storage failures are non-fatal", async () => {
  const previousWindow = globalThis.window;
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { setItem() { throw new Error("blocked"); }, getItem() { throw new Error("blocked"); }, removeItem() { throw new Error("blocked"); } } } });
  const { persistJobId, readStoredJobId, clearStoredJobId } = await import("@/lib/client/job-storage");
  assert.doesNotThrow(() => persistJobId("job-1"));
  assert.equal(readStoredJobId(), null);
  assert.doesNotThrow(() => clearStoredJobId("job-1"));
  Object.defineProperty(globalThis, "window", { configurable: true, value: previousWindow });
});

test("a missing job stops polling even when no previous response exists", async () => {
  const { renderHook, waitFor, act, cleanup } = await import("@testing-library/react");
  const { useDownloaderQueries } = await import("@/lib/client/use-downloader-queries");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const previousFetch = globalThis.fetch;
  let jobRequests = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes("/api/downloads/missing-job")) {
      jobRequests += 1;
      return Response.json({ error: { message: "The download job was not found." } }, { status: 404 });
    }
    return Response.json({ ready: true, tools: [] });
  };
  try {
    const hook = renderHook(
      () => useDownloaderQueries({ mediaSession: 0, search: "", releaseId: "", jobId: "missing-job", cancelingJobId: null }),
      { wrapper: wrapperFor(client) },
    );
    await waitFor(() => assert.equal(hook.result.current.job.isError, true));
    assert.equal(hook.result.current.job.data, undefined);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 2_200)); });
    assert.equal(jobRequests, 1);
  } finally {
    cleanup(); client.clear(); globalThis.fetch = previousFetch;
  }
});

test("download creation stays guarded until a terminal result releases it", () => {
  const guard = createSingleFlightGuard();
  assert.equal(guard.enter(), true);
  assert.equal(guard.enter(), false);
  guard.release();
  assert.equal(guard.enter(), true);
});

test("preferences wait for persisted browser values without writing defaults first", async () => {
  const previousStorage = globalThis.localStorage;
  const values = new Map([["vipod.preferences", JSON.stringify({ state: { audioFormat: "mp3", audioQuality: "320", keepInLibrary: true }, version: 0 })]]);
  let writes = 0;
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { writes += 1; values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const previousWindowStorage = dom.window.localStorage;
  Object.defineProperty(dom.window, "localStorage", { configurable: true, value: storage });
  const { usePreferenceStore } = await import("@/lib/client/preferences");
  assert.equal(usePreferenceStore.getState().audioFormat, "m4a");
  assert.equal(writes, 0);
  await usePreferenceStore.persist.rehydrate();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(usePreferenceStore.getState().audioFormat, "mp3");
  assert.equal(usePreferenceStore.getState().audioQuality, "320");
  assert.equal(usePreferenceStore.getState().keepInLibrary, true);
  Object.defineProperty(dom.window, "localStorage", { configurable: true, value: previousWindowStorage });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: previousStorage });
});
