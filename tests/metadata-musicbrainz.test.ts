import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
  buildMusicBrainzSearchQuery,
  getMetadataRelease,
  resetMetadataRuntimeForTests,
  searchMetadata,
} from "../src/lib/server/musicbrainz";

const releaseId = "123e4567-e89b-42d3-a456-426614174000";

afterEach(() => resetMetadataRuntimeForTests());

describe("metadata search", () => {
  it("preserves credited artist joinphrases, converts duration, and deduplicates releases", async () => {
    let requestedUrl = "";
    const fetcher: typeof fetch = async (input) => {
      requestedUrl = String(input);
      return Response.json({
        recordings: [
          {
            id: "recording-1",
            title: "Song (Live)",
            disambiguation: "Live version",
            "artist-credit": [
              { name: "A & B", joinphrase: " feat. " },
              { artist: { name: "C" }, joinphrase: "" },
            ],
            length: 201_250,
            "first-release-date": "2020-01-02",
            score: 98,
            releases: [
              { id: releaseId, title: "Album", date: "2020", country: "US" },
              { id: releaseId, title: "Duplicate" },
            ],
          },
        ],
      });
    };
    const results = await searchMetadata("Yellow Coldplay", { fetcher, sleep: async () => undefined });
    assert.equal(results.length, 1);
    assert.equal(results[0].artist, "A & B feat. C");
    assert.equal(results[0].title, "Song (Live)");
    assert.equal(results[0].disambiguation, "Live version");
    assert.equal(results[0].duration, 201.25);
    assert.equal(results[0].releases.length, 1);
    assert.equal(results[0].releases[0].country, "US");
    assert.equal(new URL(requestedUrl).searchParams.get("limit"), "15");
    assert.equal(
      new URL(requestedUrl).searchParams.get("query"),
      '(recording:"Yellow" OR artist:"Yellow") AND (recording:"Coldplay" OR artist:"Coldplay")',
    );
  });

  it("escapes Lucene syntax within tokens and keys equivalent whitespace searches identically", () => {
    const quoted = buildMusicBrainzSearchQuery('Yellow (Live) "Coldplay"');
    const normalized = buildMusicBrainzSearchQuery("  yellow   (live)   \"coldplay\"  ");
    assert.equal(quoted.query.includes('recording:"Yellow" OR artist:"Yellow"'), true);
    assert.equal(quoted.query.includes('recording:"\\(Live\\)" OR artist:"\\(Live\\)"'), true);
    assert.equal(quoted.key, normalized.key);
    assert.throws(() => buildMusicBrainzSearchQuery(Array(21).fill("term").join(" ")), { code: "INVALID_SEARCH" });
  });

  it("rejects blank and oversized queries without requesting upstream", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return Response.json({ recordings: [] });
    };
    await assert.rejects(searchMetadata("  ", { fetcher }), { code: "INVALID_SEARCH" });
    await assert.rejects(searchMetadata("x".repeat(201), { fetcher }), { code: "INVALID_SEARCH" });
    assert.equal(calls, 0);
  });

  it("retries 503 with the shared start-time scheduler", async () => {
    let clock = 0;
    const starts: number[] = [];
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      starts.push(clock);
      calls += 1;
      if (calls === 1) return new Response("busy", { status: 503, headers: { "Retry-After": "1" } });
      return Response.json({ recordings: [] });
    };
    const sleep = async (ms: number) => {
      clock += ms;
    };
    await Promise.all([
      searchMetadata("retry example", { fetcher, now: () => clock, sleep }),
      searchMetadata("parallel example", { fetcher, now: () => clock, sleep }),
    ]);
    assert.equal(calls, 3);
    assert.ok(starts[1] - starts[0] >= 1_000);
    assert.ok(starts[2] - starts[1] >= 1_000);
  });

  it("does not cache failed upstream responses", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return new Response("failure", { status: 500 });
    };
    await assert.rejects(searchMetadata("failed lookup", { fetcher }), { code: "METADATA_UPSTREAM_ERROR" });
    await assert.rejects(searchMetadata("failed lookup", { fetcher }), { code: "METADATA_UPSTREAM_ERROR" });
    assert.equal(calls, 2);
  });

  it("ignores solitary punctuation tokens like hyphens in search query", () => {
    const queryResult = buildMusicBrainzSearchQuery("Queen - Bohemian Rhapsody");
    assert.equal(queryResult.query.includes('recording:"\\-"'), false);
    assert.equal(queryResult.query.includes('recording:"Queen" OR artist:"Queen"'), true);
    assert.equal(queryResult.query.includes('recording:"Bohemian" OR artist:"Bohemian"'), true);
    assert.equal(queryResult.query.includes('recording:"Rhapsody" OR artist:"Rhapsody"'), true);
  });

  it("prioritizes official studio albums over compilations and flags suggested release", async () => {
    const fetcher: typeof fetch = async () => {
      return Response.json({
        recordings: [
          {
            id: "rec-1",
            title: "Bohemian Rhapsody",
            "artist-credit": [{ name: "Queen", joinphrase: "" }],
            length: 354_000,
            "first-release-date": "1975-10-31",
            score: 100,
            releases: [
              {
                id: "rel-compilation",
                title: "Greatest Hits",
                date: "1981-10-26",
                country: "GB",
                status: "Official",
                "release-group": { "primary-type": "Album", "secondary-types": ["Compilation"] },
              },
              {
                id: "rel-studio",
                title: "A Night at the Opera",
                date: "1975-11-21",
                country: "GB",
                status: "Official",
                "release-group": { "primary-type": "Album", "secondary-types": [] },
              },
              {
                id: "rel-bootleg",
                title: "Live Bootleg 1977",
                date: "1990",
                country: "US",
                status: "Bootleg",
                "release-group": { "primary-type": "Album", "secondary-types": ["Live"] },
              },
            ],
          },
        ],
      });
    };
    const results = await searchMetadata("Queen Bohemian Rhapsody", { fetcher });
    assert.equal(results.length, 1);
    assert.equal(results[0].suggested, true);
    assert.equal(results[0].releases[0].id, "rel-studio");
    assert.equal(results[0].releases[0].suggested, true);
    assert.equal(results[0].releases[1].id, "rel-compilation");
    assert.equal(results[0].releases[2].id, "rel-bootleg");
  });

  it("boosts candidate score when targetDuration matches recording length", async () => {
    const fetcher: typeof fetch = async () => {
      return Response.json({
        recordings: [
          {
            id: "rec-live",
            title: "Yellow (Live)",
            disambiguation: "Live in Sydney",
            "artist-credit": [{ name: "Coldplay", joinphrase: "" }],
            length: 310_000,
            score: 95,
            releases: [],
          },
          {
            id: "rec-studio",
            title: "Yellow",
            "artist-credit": [{ name: "Coldplay", joinphrase: "" }],
            length: 269_000,
            score: 90,
            releases: [{ id: "rel-1", title: "Parachutes", status: "Official", "release-group": { "primary-type": "Album" } }],
          },
        ],
      });
    };
    const results = await searchMetadata("Coldplay Yellow", { fetcher, targetDuration: 270 });
    assert.equal(results[0].id, "rec-studio");
    assert.equal(results[0].suggested, true);
  });
});

describe("metadata release", () => {
  it("returns exact per-disc track alignment and no artwork when CAA has no front cover", async () => {
    const calls: string[] = [];
    const fetcher: typeof fetch = async (input) => {
      const url = String(input);
      calls.push(url);
      if (url.includes("coverartarchive.org")) return new Response("not found", { status: 404 });
      return Response.json({
        id: releaseId,
        title: "Album",
        date: "2022-05-01",
        "artist-credit": [{ name: "Artist", joinphrase: " & " }, { name: "Guest", joinphrase: "" }],
        genres: [{ name: "rock" }],
        media: [
          { position: 3, tracks: [{ number: "1", title: "Opening", "artist-credit": [{ name: "Track artist", joinphrase: " feat. " }, { name: "Guest", joinphrase: "" }], recording: { id: "rec-1", title: "Fallback", "artist-credit": [{ name: "Recording artist", joinphrase: "" }] } }] },
          { position: 1, tracks: [{ number: "1", title: "Finale", recording: { id: "rec-2", title: "Finale" } }] },
        ],
      });
    };
    const release = await getMetadataRelease(releaseId, { fetcher, sleep: async () => undefined });
    assert.equal(release.artist, "Artist & Guest");
    assert.equal(release.genre, "rock");
    assert.equal(release.artworkUrl, null);
    assert.deepEqual(release.tracks.map(({ recordingId, title, artist, trackNumber, discNumber }) => ({ recordingId, title, artist, trackNumber, discNumber })), [
      { recordingId: "rec-1", title: "Opening", artist: "Track artist feat. Guest", trackNumber: "1", discNumber: "3" },
      { recordingId: "rec-2", title: "Finale", artist: "Artist & Guest", trackNumber: "1", discNumber: "1" },
    ]);
    assert.ok(calls[0].includes("artist-credits%2Brecordings%2Bgenres"));
  });

  it("only advertises the standard artwork URL when CAA confirms a front image", async () => {
    const fetcher: typeof fetch = async (input) => String(input).includes("coverartarchive.org")
      ? Response.json({ images: [{ front: true, image: "https://untrusted.example/art.jpg" }] })
      : Response.json({ id: releaseId, media: [] });
    const release = await getMetadataRelease(releaseId, { fetcher, sleep: async () => undefined });
    assert.equal(release.artworkUrl, `https://coverartarchive.org/release/${releaseId}/front-500`);
  });

  it("validates release UUIDs before making requests", async () => {
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls += 1;
      return Response.json({});
    };
    await assert.rejects(getMetadataRelease("not-a-uuid", { fetcher }), { code: "INVALID_RELEASE_ID" });
    assert.equal(calls, 0);
  });
});
