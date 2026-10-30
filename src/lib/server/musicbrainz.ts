import type { MetadataCandidate, MetadataRelease } from "@/lib/contracts";
import { isPunctuationOnly } from "@/lib/title-cleaner";

const MUSICBRAINZ_BASE = "https://musicbrainz.org/ws/2";
const COVER_ART_BASE = "https://coverartarchive.org/release";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_RESPONSE_BYTES = 2_000_000;
const MAX_RECORDINGS = 15;
const MAX_RELEASES = 100;
const MAX_TRACKS = 500;
const MAX_SEARCH_TERMS = 20;
const MAX_RETRIES = 2;
const MIN_REQUEST_INTERVAL_MS = 1_000;
const CACHE_LIMIT = 100;
const SEARCH_TTL_MS = 5 * 60_000;
const RELEASE_TTL_MS = 30 * 60_000;

type CacheEntry<T> = { value: T; expiresAt: number };
type SchedulerState = { nextStartAt: number; tail: Promise<void> };
type RuntimeState = {
  scheduler: SchedulerState;
  searches: Map<string, CacheEntry<MetadataCandidate[]>>;
  releases: Map<string, CacheEntry<MetadataRelease>>;
  pending: Map<string, Promise<unknown>>;
};

const runtimeKey = "__vipodWebMusicbrainzRuntime";
const globalState = globalThis as typeof globalThis & { __vipodWebMusicbrainzRuntime?: RuntimeState };
const runtime: RuntimeState = (globalState[runtimeKey] ??= {
  scheduler: { nextStartAt: 0, tail: Promise.resolve() },
  searches: new Map(),
  releases: new Map(),
  pending: new Map(),
});

export class MetadataServiceError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "MetadataServiceError";
  }
}

type ServiceOptions = {
  fetcher?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  targetDuration?: number | null;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function getUserAgent(): string {
  const configured = process.env.MUSICBRAINZ_USER_AGENT?.trim();
  return configured || "vipod-web/0.1.0 (personal local music library)";
}

function boundedCacheSet<T>(cache: Map<string, CacheEntry<T>>, key: string, value: T, ttl: number, now: number) {
  if (cache.size >= CACHE_LIMIT && !cache.has(key)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.delete(key);
  cache.set(key, { value, expiresAt: now + ttl });
}

function cacheGet<T>(cache: Map<string, CacheEntry<T>>, key: string, now: number): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    cache.delete(key);
    return undefined;
  }
  // Refresh insertion order so eviction favors the least recently used entry.
  cache.delete(key);
  cache.set(key, entry);
  return entry.value;
}

function coalesce<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const existing = runtime.pending.get(key);
  if (existing) return existing as Promise<T>;
  const promise = operation().finally(() => runtime.pending.delete(key));
  runtime.pending.set(key, promise);
  return promise;
}

async function scheduleRequest<T>(operation: () => Promise<T>, now: () => number, sleep: (ms: number) => Promise<void>): Promise<T> {
  let release!: () => void;
  const previous = runtime.scheduler.tail;
  runtime.scheduler.tail = new Promise<void>((resolve) => (release = resolve));
  await previous;
  try {
    const waitMs = Math.max(0, runtime.scheduler.nextStartAt - now());
    if (waitMs > 0) await sleep(waitMs);
    runtime.scheduler.nextStartAt = now() + MIN_REQUEST_INTERVAL_MS;
    return await operation();
  } finally {
    release();
  }
}

function retryDelay(response: Response, retry: number): number {
  const header = response.headers.get("retry-after");
  if (header) {
    const seconds = Number(header);
    const retryAt = Number.isFinite(seconds) ? Date.now() + seconds * 1_000 : Date.parse(header);
    if (Number.isFinite(retryAt)) return Math.max(250, Math.min(10_000, retryAt - Date.now()));
  }
  return Math.min(4_000, 500 * 2 ** retry);
}

async function musicBrainzJson<T>(url: string, options: ServiceOptions = {}): Promise<T> {
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;

  for (let retry = 0; ; retry += 1) {
    const response = await scheduleRequest(
      () => fetcher(url, {
        headers: { Accept: "application/json", "User-Agent": getUserAgent() },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        cache: "no-store",
      }),
      now,
      sleep,
    ).catch((error: unknown) => {
      if (error instanceof MetadataServiceError) throw error;
      throw new MetadataServiceError("METADATA_UPSTREAM_UNAVAILABLE", "Music metadata service is unavailable.", 503);
    });

    if ((response.status === 429 || response.status === 503) && retry < MAX_RETRIES) {
      await sleep(retryDelay(response, retry));
      continue;
    }
    if (!response.ok) {
      const retryable = response.status === 429 || response.status === 503;
      throw new MetadataServiceError(
        retryable ? "METADATA_UPSTREAM_UNAVAILABLE" : "METADATA_UPSTREAM_ERROR",
        retryable ? "Music metadata service is temporarily unavailable." : "Music metadata service returned an error.",
        retryable ? 503 : 502,
      );
    }

    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
      throw new MetadataServiceError("METADATA_UPSTREAM_INVALID", "Music metadata response was too large.", 502);
    }
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > MAX_RESPONSE_BYTES) {
      throw new MetadataServiceError("METADATA_UPSTREAM_INVALID", "Music metadata response was too large.", 502);
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new MetadataServiceError("METADATA_UPSTREAM_INVALID", "Music metadata service returned invalid data.", 502);
    }
  }
}

function artistCredit(credits: unknown): string {
  if (!Array.isArray(credits)) return "";
  return credits.slice(0, 30).map((credit) => {
    if (!credit || typeof credit !== "object") return "";
    const item = credit as { name?: unknown; joinphrase?: unknown; artist?: { name?: unknown } };
    const name = typeof item.name === "string" ? item.name : typeof item.artist?.name === "string" ? item.artist.name : "";
    const joinphrase = typeof item.joinphrase === "string" ? item.joinphrase : "";
    return `${name}${joinphrase}`;
  }).join("").trim();
}

function safeString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function escapeLucenePhrase(value: string): string {
  return value.replace(/[+\-!(){}\[\]^"~*?:\\/]|&&|\|\|/g, "\\$&");
}

function normalizeSearch(raw: unknown): { query: string; key: string } {
  if (typeof raw !== "string") throw new MetadataServiceError("INVALID_SEARCH", "Search query must be between 1 and 200 characters.", 400);
  const trimmed = raw.trim();
  if (trimmed.length < 1 || trimmed.length > 200) {
    throw new MetadataServiceError("INVALID_SEARCH", "Search query must be between 1 and 200 characters.", 400);
  }
  const terms = trimmed.split(/\s+/).filter(Boolean);
  if (terms.length > MAX_SEARCH_TERMS) {
    throw new MetadataServiceError("INVALID_SEARCH", "Search query must be between 1 and 200 characters.", 400);
  }
  const meaningfulTerms = terms.filter((term) => !isPunctuationOnly(term));
  if (meaningfulTerms.length < 1) {
    throw new MetadataServiceError("INVALID_SEARCH", "Search query must contain searchable words or numbers.", 400);
  }
  const query = meaningfulTerms.join(" ");
  return { query, key: query.toLocaleLowerCase() };
}

export function buildMusicBrainzSearchQuery(rawQuery: unknown): { query: string; key: string } {
  const { query, key } = normalizeSearch(rawQuery);
  const clauses = query.split(" ").map((term) => {
    const phrase = `"${escapeLucenePhrase(term)}"`;
    return `(recording:${phrase} OR artist:${phrase})`;
  });
  return { query: clauses.join(" AND "), key };
}

export function scoreRelease(
  release: {
    title: string;
    date: string | null;
    country: string | null;
    status?: string | null;
    primaryType?: string | null;
    secondaryTypes?: string[];
  },
  recordingFirstReleaseDate: string | null,
): number {
  let score = 50;

  if (release.status === "Official") score += 25;
  else if (release.status === "Bootleg") score -= 40;
  else if (release.status === "Promotion") score -= 15;

  if (release.primaryType === "Album") score += 30;
  else if (release.primaryType === "EP") score += 15;
  else if (release.primaryType === "Single") score += 10;

  if (release.secondaryTypes?.includes("Compilation")) score -= 30;
  if (release.secondaryTypes?.includes("Live")) score -= 20;
  if (release.secondaryTypes?.includes("Remix")) score -= 20;
  if (release.secondaryTypes?.includes("Soundtrack")) score -= 10;

  if (recordingFirstReleaseDate && release.date) {
    const recYear = parseInt(recordingFirstReleaseDate.slice(0, 4), 10);
    const relYear = parseInt(release.date.slice(0, 4), 10);
    if (!isNaN(recYear) && !isNaN(relYear)) {
      const diff = Math.abs(relYear - recYear);
      if (diff === 0) score += 20;
      else if (diff <= 1) score += 15;
      else if (diff <= 3) score += 10;
      else if (diff > 15) score -= 10;
    }
  }

  const t = release.title.toLowerCase();
  if (/greatest\s+hits|best\s+of|anthology|collection|ultimate|gold|platinum|the\s+hits/i.test(t)) {
    score -= 25;
  }
  if (/karaoke|tribute|cover|instrumental/i.test(t)) {
    score -= 50;
  }

  if (release.country && ["US", "GB", "UK", "XW", "XE", "EU"].includes(release.country.toUpperCase())) {
    score += 5;
  }

  return score;
}

export function scoreCandidate(
  candidate: {
    score: number;
    duration: number | null;
    disambiguation?: string;
    releases: Array<{ status?: string | null; primaryType?: string | null }>;
  },
  targetDuration?: number | null,
): number {
  let score = candidate.score;

  if (targetDuration != null && candidate.duration != null && targetDuration > 0) {
    const diff = Math.abs(targetDuration - candidate.duration);
    if (diff <= 3) score += 20;
    else if (diff <= 8) score += 12;
    else if (diff <= 15) score += 5;
    else if (diff > 30) score -= 15;
    else if (diff > 60) score -= 30;
  }

  if (candidate.disambiguation) {
    const d = candidate.disambiguation.toLowerCase();
    if (/karaoke|tribute|instrumental|parody|cover/i.test(d)) score -= 40;
    else if (/live/i.test(d)) score -= 15;
  }

  if (candidate.releases.some((r) => r.status === "Official" && r.primaryType === "Album")) {
    score += 10;
  }

  return Math.max(0, Math.min(100, Math.round(score)));
}

export async function searchMetadata(rawQuery: unknown, options: ServiceOptions = {}): Promise<MetadataCandidate[]> {
  const { query, key } = buildMusicBrainzSearchQuery(rawQuery);
  const now = options.now ?? Date.now;
  const cacheKey = options.targetDuration != null && Number.isFinite(options.targetDuration) && options.targetDuration > 0
    ? `${key}:dur-${Math.round(options.targetDuration)}`
    : key;
  const cached = cacheGet(runtime.searches, cacheKey, now());
  if (cached) return cached;

  return coalesce(`search:${cacheKey}`, async () => {
    const url = new URL(`${MUSICBRAINZ_BASE}/recording`);
    url.searchParams.set("query", query);
    url.searchParams.set("limit", String(MAX_RECORDINGS));
    url.searchParams.set("fmt", "json");
    const result = await musicBrainzJson<{ recordings?: unknown }>(url.toString(), options);
    const recordings = Array.isArray(result.recordings) ? result.recordings.slice(0, MAX_RECORDINGS) : [];
    const candidates: MetadataCandidate[] = [];
    const ids = new Set<string>();
    for (const value of recordings) {
      if (!value || typeof value !== "object") continue;
      const recording = value as Record<string, unknown>;
      const id = safeString(recording.id);
      if (!id || ids.has(id)) continue;
      ids.add(id);
      const releases: MetadataCandidate["releases"] = [];
      const releaseIds = new Set<string>();
      const recordingReleases = Array.isArray(recording.releases) ? recording.releases.slice(0, MAX_RELEASES) : [];
      for (const releaseValue of recordingReleases) {
        if (!releaseValue || typeof releaseValue !== "object") continue;
        const release = releaseValue as Record<string, unknown>;
        const releaseId = safeString(release.id);
        if (!releaseId || releaseIds.has(releaseId)) continue;
        releaseIds.add(releaseId);
        const title = safeString(release.title);
        const date = safeString(release.date) || null;
        const country = safeString(release.country) || null;
        const status = safeString(release.status) || null;
        const releaseGroup = release["release-group"] && typeof release["release-group"] === "object"
          ? release["release-group"] as Record<string, unknown>
          : null;
        const primaryType = releaseGroup ? safeString(releaseGroup["primary-type"]) || null : null;
        const secondaryTypes = releaseGroup && Array.isArray(releaseGroup["secondary-types"])
          ? releaseGroup["secondary-types"].map((t) => safeString(t)).filter(Boolean)
          : [];
        releases.push({
          id: releaseId,
          title,
          date,
          country,
          ...(status ? { status } : {}),
          ...(primaryType ? { primaryType } : {}),
          ...(secondaryTypes.length ? { secondaryTypes } : {}),
        });
      }
      const firstReleaseDate = safeString(recording["first-release-date"]) || null;
      releases.sort((a, b) => scoreRelease(b, firstReleaseDate) - scoreRelease(a, firstReleaseDate));
      if (releases.length > 0) {
        releases[0].suggested = true;
      }
      const milliseconds = typeof recording.length === "number" && Number.isFinite(recording.length) ? recording.length : null;
      candidates.push({
        id,
        title: safeString(recording.title),
        ...(safeString(recording.disambiguation) ? { disambiguation: safeString(recording.disambiguation) } : {}),
        artist: artistCredit(recording["artist-credit"]),
        duration: milliseconds === null ? null : milliseconds / 1_000,
        firstReleaseDate,
        score: typeof recording.score === "number" && Number.isFinite(recording.score) ? recording.score : 0,
        releases,
      });
    }
    candidates.sort((a, b) => scoreCandidate(b, options.targetDuration) - scoreCandidate(a, options.targetDuration));
    if (candidates.length > 0) {
      candidates[0].suggested = true;
    }
    boundedCacheSet(runtime.searches, cacheKey, candidates, SEARCH_TTL_MS, now());
    return candidates;
  });
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function getArtworkUrl(releaseId: string, options: ServiceOptions): Promise<string | null> {
  const fetcher = options.fetcher ?? fetch;
  try {
    const response = await fetcher(`${COVER_ART_BASE}/${releaseId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!response.ok) return null;
    const body = await response.text();
    if (new TextEncoder().encode(body).byteLength > 256_000) return null;
    const data = JSON.parse(body) as { images?: unknown };
    if (!Array.isArray(data.images)) return null;
    const hasFront = data.images.some((image) => image && typeof image === "object" && (image as { front?: unknown }).front === true);
    return hasFront ? `${COVER_ART_BASE}/${releaseId}/front-500` : null;
  } catch {
    return null;
  }
}

export async function getMetadataRelease(rawId: unknown, options: ServiceOptions = {}): Promise<MetadataRelease> {
  if (typeof rawId !== "string" || !isUuid(rawId)) {
    throw new MetadataServiceError("INVALID_RELEASE_ID", "Release ID must be a valid UUID.", 400);
  }
  const id = rawId.toLowerCase();
  const now = options.now ?? Date.now;
  const cached = cacheGet(runtime.releases, id, now());
  if (cached) return cached;

  return coalesce(`release:${id}`, async () => {
    const url = new URL(`${MUSICBRAINZ_BASE}/release/${id}`);
    url.searchParams.set("inc", "artist-credits+recordings+genres");
    url.searchParams.set("fmt", "json");
    const release = await musicBrainzJson<Record<string, unknown>>(url.toString(), options);
    const media = Array.isArray(release.media) ? release.media.slice(0, 100) : [];
    const tracks: MetadataRelease["tracks"] = [];
    for (let discIndex = 0; discIndex < media.length && tracks.length < MAX_TRACKS; discIndex += 1) {
      const medium = media[discIndex];
      if (!medium || typeof medium !== "object") continue;
      const record = medium as Record<string, unknown>;
      const discNumber = typeof record.position === "number" && Number.isFinite(record.position) && record.position > 0
        ? String(record.position)
        : String(discIndex + 1);
      const mediumTracks = Array.isArray(record.tracks) ? record.tracks : [];
      for (let trackIndex = 0; trackIndex < mediumTracks.length && tracks.length < MAX_TRACKS; trackIndex += 1) {
        const trackValue = mediumTracks[trackIndex];
        if (!trackValue || typeof trackValue !== "object") continue;
        const track = trackValue as Record<string, unknown>;
        const recording = track.recording && typeof track.recording === "object" ? track.recording as Record<string, unknown> : {};
        tracks.push({
          recordingId: safeString(recording.id),
          title: safeString(track.title) || safeString(recording.title),
          artist: artistCredit(track["artist-credit"]) || artistCredit(recording["artist-credit"]) || artistCredit(release["artist-credit"]),
          trackNumber: safeString(track.number) || String(trackIndex + 1),
          discNumber,
        });
      }
    }
    const genres = Array.isArray(release.genres) ? release.genres : [];
    const genre = genres.map((item) => item && typeof item === "object" ? safeString((item as { name?: unknown }).name) : "").find(Boolean) ?? "";
    const artworkUrl = await getArtworkUrl(id, options);
    const value: MetadataRelease = {
      id,
      title: safeString(release.title),
      artist: artistCredit(release["artist-credit"]),
      date: safeString(release.date) || null,
      genre,
      artworkUrl,
      tracks,
    };
    boundedCacheSet(runtime.releases, id, value, RELEASE_TTL_MS, now());
    return value;
  });
}

export function metadataErrorResponse(error: unknown): { status: number; body: { error: { code: string; message: string } } } {
  if (error instanceof MetadataServiceError) {
    return { status: error.status, body: { error: { code: error.code, message: error.message } } };
  }
  return { status: 500, body: { error: { code: "INTERNAL_ERROR", message: "An unexpected metadata error occurred." } } };
}

export function resetMetadataRuntimeForTests(): void {
  runtime.scheduler.nextStartAt = 0;
  runtime.scheduler.tail = Promise.resolve();
  runtime.searches.clear();
  runtime.releases.clear();
  runtime.pending.clear();
}
