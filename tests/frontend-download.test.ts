import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import React from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { DownloadJob, DownloadRequest, MediaInfo } from "@/lib/contracts";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost" });
Object.assign(globalThis, {
  window: dom.window,
  self: dom.window,
  document: dom.window.document,
  HTMLElement: dom.window.HTMLElement,
  IS_REACT_ACT_ENVIRONMENT: true,
});
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });

const sourceUrl = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const media: MediaInfo = {
  id: "dQw4w9WgXcQ", url: sourceUrl, title: "Test track", description: "", thumbnail: null,
  thumbnails: [], duration: 180, uploader: "Test artist", channel: null, uploadDate: null,
  viewCount: null, likeCount: null, categories: [], tags: [], music: {}, formats: [],
  chapters: [], subtitleLanguages: [], raw: {},
};
const activeJob: DownloadJob = {
  id: "new-job", status: "downloading", progress: 20, stage: "downloading",
  createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z",
};

async function setup(restoredResponse: () => Response) {
  const ui = await import("@testing-library/react");
  const { default: Home } = await import("@/app/page");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const previousFetch = globalThis.fetch;
  const requests: DownloadRequest[] = [];
  let newJobMissing = false;
  dom.window.localStorage.clear();
  dom.window.localStorage.setItem("vipod.latest-job", "old-job");
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url === "/api/health") return Response.json({ ready: true, tools: [] });
    if (url === "/api/analyze") return Response.json(media);
    if (url === "/api/downloads/old-job") return restoredResponse();
    if (url === "/api/downloads" && init?.method === "POST") {
      requests.push(JSON.parse(String(init.body)) as DownloadRequest);
      return Response.json(activeJob);
    }
    if (url === "/api/downloads/new-job") return newJobMissing
      ? Response.json({ error: { message: "The download job was not found." } }, { status: 404 })
      : Response.json(activeJob);
    throw new Error(`Unexpected request: ${url}`);
  };
  let page!: ReturnType<typeof ui.render>;
  try {
    await ui.act(async () => {
      page = ui.render(React.createElement(QueryClientProvider, { client }, React.createElement(Home)));
    });
  } catch (error) {
    ui.cleanup(); client.clear(); globalThis.fetch = previousFetch;
    throw error instanceof AggregateError ? error.errors[0] : error;
  }
  return {
    ...ui, page, client, requests,
    markNewJobMissing: () => { newJobMissing = true; },
    analyze: async () => {
      ui.fireEvent.change(page.getByLabelText("YouTube video URL"), { target: { value: sourceUrl } });
      await ui.act(async () => { ui.fireEvent.click(page.getByRole("button", { name: "Analyze media link" })); });
      await ui.waitFor(() => assert.ok(page.getByRole("region", { name: "Download setup" })));
    },
    dispose: () => {
      ui.cleanup(); client.clear(); globalThis.fetch = previousFetch; dom.window.localStorage.clear();
    },
  };
}

test("a missing stored download allows a new export and releases the guard if that export disappears", async () => {
  const harness = await setup(() => Response.json({ error: { message: "The download job was not found." } }, { status: 404 }));
  try {
    await harness.analyze();
    const button = await harness.page.findByRole("button", { name: "Download to this device" });
    assert.equal((button as HTMLButtonElement).disabled, false);
    assert.equal(dom.window.localStorage.getItem("vipod.latest-job"), null);
    assert.equal(harness.page.queryByText("Retry status check"), null);

    await harness.act(async () => { harness.fireEvent.click(button); });
    await harness.waitFor(() => assert.equal(harness.requests.length, 1));
    assert.equal(harness.requests[0]?.url, sourceUrl);
    await harness.waitFor(() => assert.equal(dom.window.localStorage.getItem("vipod.latest-job"), "new-job"));
    assert.ok(harness.page.getByRole("button", { name: "Download in progress" }));

    harness.markNewJobMissing();
    await harness.act(async () => { await harness.client.invalidateQueries({ queryKey: ["download-job", "new-job"] }); });
    const nextButton = await harness.page.findByRole("button", { name: "Download to this device" });
    assert.equal((nextButton as HTMLButtonElement).disabled, false);
    await harness.act(async () => { harness.fireEvent.click(nextButton); });
    await harness.waitFor(() => assert.equal(harness.requests.length, 2));
  } finally { harness.dispose(); }
});

test("a restored active download prevents duplicate exports", async () => {
  const harness = await setup(() => Response.json({ ...activeJob, id: "old-job" }));
  try {
    await harness.analyze();
    const button = await harness.page.findByRole("button", { name: "Download in progress" });
    assert.equal((button as HTMLButtonElement).disabled, true);
    harness.fireEvent.click(button);
    assert.equal(harness.requests.length, 0);
    assert.equal(dom.window.localStorage.getItem("vipod.latest-job"), "old-job");
  } finally { harness.dispose(); }
});

test("a temporary server error preserves the stored job and offers a status retry", async () => {
  const harness = await setup(() => Response.json({ error: { message: "Status temporarily unavailable." } }, { status: 500 }));
  try {
    await harness.analyze();
    const button = await harness.page.findByRole("button", { name: "Could not restore previous download" });
    assert.equal((button as HTMLButtonElement).disabled, true);
    assert.ok(harness.page.getByRole("button", { name: "Retry status check" }));
    assert.equal(dom.window.localStorage.getItem("vipod.latest-job"), "old-job");
    assert.equal(harness.requests.length, 0);
  } finally { harness.dispose(); }
});
