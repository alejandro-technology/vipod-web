/* eslint-disable @next/next/no-img-element */
"use client";

import {
  Activity, ArrowDownToLine, AudioLines, Check, ChevronDown, ChevronRight,
  CircleAlert, Disc3, Download, ExternalLink, FileAudio, FileJson2, LoaderCircle,
  Music2, Pause, Search, Sparkles, X,
} from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { usePreferenceStore } from "@/lib/client/preferences";
import { api, ApiRequestError } from "@/lib/client/api";
import { useDownloaderQueries } from "@/lib/client/use-downloader-queries";
import { clearStoredJobId, persistJobId, readStoredJobId } from "@/lib/client/job-storage";
import { createSingleFlightGuard } from "@/lib/client/single-flight-guard";
import Link from "next/link";
import { MetadataLookup } from "@/components/metadata-lookup";
import { cleanYouTubeTitle } from "@/lib/title-cleaner";
import type {
  DownloadJob, DownloadRequest, MediaFormat, MediaInfo, MetadataCandidate, TrackMetadata,
} from "@/lib/contracts";

type Panel = "download" | "metadata" | "details";
type Mode = DownloadRequest["mode"];
type AudioFormat = DownloadRequest["audioFormat"];
const ACTIVE = new Set<DownloadJob["status"]>(["queued", "analyzing", "downloading", "processing"]);

function defaultMetadata(media: MediaInfo): TrackMetadata {
  return {
    title: media.music.title || media.title || "",
    artist: media.music.artist || "",
    album: media.music.album || "",
    albumArtist: media.music.albumArtist || "",
    date: media.music.date || "",
    genre: media.music.genre || "",
    trackNumber: media.music.trackNumber || "",
    discNumber: media.music.discNumber || "",
    artwork: media.thumbnail ? { source: "thumbnail", url: media.thumbnail } : { source: "none" },
  };
}

function formatDuration(seconds: number | null | undefined) {
  if (seconds == null || !Number.isFinite(seconds)) return "Duration unavailable";
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

function readableSize(bytes: number | null | undefined) {
  if (!bytes || bytes <= 0) return "Size unknown";
  const value = bytes / (1024 * 1024);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} MB`;
}

function formatLabel(format: MediaFormat) {
  if (format.type === "audio") return `${format.ext.toUpperCase()} audio`;
  const resolution = format.height ? `${format.height}p` : format.width ? `${format.width}px` : "Video";
  return `${resolution} · ${format.ext.toUpperCase()}${format.type === "combined" ? " · audio included" : " · video only"}`;
}

function formatUploadDate(value: string | null) {
  if (!value) return "Unavailable";
  const match = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  return match ? `${match[1]}-${match[2]}-${match[3]}` : value;
}

function formatTechnicalDetails(format: MediaFormat) {
  const details = [formatLabel(format), `ID ${format.id}`];
  if (format.bitrate) details.push(`${Math.round(format.bitrate)} kbps`);
  if (format.audioBitrate) details.push(`audio ${Math.round(format.audioBitrate)} kbps`);
  if (format.fps) details.push(`${format.fps} fps`);
  if (format.width && format.height) details.push(`${format.width}×${format.height}`);
  const size = format.filesize ?? format.filesizeApprox;
  if (size) details.push(`${readableSize(size)}${format.filesize ? "" : " approx."}`);
  else details.push("Size unknown");
  return details.join(" · ");
}

type MetadataOrigin = "YouTube" | "MusicBrainz" | "Manual";
type MetadataField = keyof Omit<TrackMetadata, "artwork">;

export default function Home() {
  const [url, setUrl] = useState("");
  const [media, setMedia] = useState<MediaInfo | null>(null);
  const [metadata, setMetadata] = useState<TrackMetadata | null>(null);
  const [metadataOrigins, setMetadataOrigins] = useState<Partial<Record<MetadataField, MetadataOrigin>>>({});
  const [panel, setPanel] = useState<Panel>("download");
  const queryClient = useQueryClient();
  const { audioFormat, audioQuality, keepInLibrary, setAudioFormat, setAudioQuality, setKeepInLibrary } = usePreferenceStore();
  const [error, setError] = useState("");
  const [mode, setMode] = useState<Mode>("audio");
  const quality = audioQuality;
  const [formatId, setFormatId] = useState("");
  const [audioFormatId, setAudioFormatId] = useState("");
  const [includeInfoJson, setIncludeInfoJson] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [cancelingJobId, setCancelingJobId] = useState<string | null>(null);
  const [restoreChecked, setRestoreChecked] = useState(false);
  const [jobSourceUrl, setJobSourceUrl] = useState<string | null>(null);
  const [retryAvailable, setRetryAvailable] = useState(false);
  const [metadataQuery, setMetadataQuery] = useState("");
  const [mediaSession, setMediaSession] = useState(0);
  const [submittedSearch, setSubmittedSearch] = useState("");
  const [selectedCandidate, setSelectedCandidate] = useState<MetadataCandidate | null>(null);
  const [releaseId, setReleaseId] = useState("");
  const [chosenTrack, setChosenTrack] = useState(0);
  const [metadataMessage, setMetadataMessage] = useState("");
  const [descriptionOpen, setDescriptionOpen] = useState(false);
  const { health: healthQuery, metadataSearch: metadataSearchQuery, release: releaseQuery, job: jobQuery } = useDownloaderQueries({
    mediaSession,
    search: submittedSearch,
    duration: media?.duration,
    releaseId,
    jobId,
    cancelingJobId,
  });
  const health = healthQuery.data ?? null;
  const healthError = healthQuery.isError;
  const [createGuard] = useState(() => createSingleFlightGuard());
  const lastSubmittedRequest = useRef<DownloadRequest | null>(null);

  const analyzeMutation = useMutation({
    mutationFn: (sourceUrl: string) => api<MediaInfo>("/api/analyze", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: sourceUrl }),
    }),
  });
  const createMutation = useMutation({
    mutationFn: (request: DownloadRequest) => api<DownloadJob>("/api/downloads", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request),
    }),
    onSuccess: async (result, request) => {
      setJobId(result.id);
      queryClient.setQueryData(["download-job", result.id], result);
      persistJobId(result.id);
      setJobSourceUrl(request.url);
      setRetryAvailable(true);
      setPanel("download");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["library"] }),
        queryClient.invalidateQueries({ queryKey: ["downloads"] }),
      ]);
    },
    onError: (cause) => { createGuard.release(); setError(cause instanceof Error ? cause.message : "Could not start the download."); },
  });
  const cancelMutation = useMutation({
    mutationFn: (id: string) => api<DownloadJob>(`/api/downloads/${encodeURIComponent(id)}`, { method: "DELETE" }),
    onSuccess: (updated, id) => queryClient.setQueryData(["download-job", id], updated),
    onError: (cause) => setError(cause instanceof Error ? cause.message : "Could not cancel this download."),
  });

  const candidates = metadataSearchQuery.data?.results ?? [];
  const release = releaseQuery.data?.id === releaseId ? releaseQuery.data : null;

  useEffect(() => { void usePreferenceStore.persist.rehydrate(); }, []);

  useEffect(() => {
    const storedId = readStoredJobId();
    queueMicrotask(() => {
      if (storedId) setJobId(storedId);
      setRestoreChecked(true);
    });
  }, []);

  const job = jobQuery.data ?? null;
  const currentJobId = job?.id;
  const currentJobStatus = job?.status;
  const jobReady = restoreChecked && (!jobId || jobQuery.isSuccess);
  useEffect(() => {
    if (jobQuery.isError && jobId && jobQuery.error instanceof ApiRequestError && jobQuery.error.status === 404) {
      clearStoredJobId(jobId);
      createGuard.release();
      queueMicrotask(() => setJobId((current) => current === jobId ? null : current));
    }
  }, [createGuard, jobId, jobQuery.error, jobQuery.isError]);
  useEffect(() => { if (currentJobStatus && !ACTIVE.has(currentJobStatus)) createGuard.release(); }, [createGuard, currentJobId, currentJobStatus]);

  const formats = useMemo(() => media?.formats.filter((item) => item.type !== "video" || Boolean(item.videoCodec)) ?? [], [media]);
  const audioFormats = formats.filter((item) => item.type === "audio" || item.type === "combined");
  const videoFormats = formats.filter((item) => item.type === "video");
  const combinedFormats = formats.filter((item) => item.type === "combined");
  const videoChoices = [...videoFormats, ...combinedFormats];
  const audioOptions = mode === "combined" ? formats.filter((item) => item.type === "audio") : audioFormats;
  const selectedFormat = formats.find((item) => item.id === formatId);
  const selectedFormatIsMuxed = mode === "combined" && selectedFormat?.type === "combined";

  async function analyze(event: FormEvent) {
    event.preventDefault();
    const sourceUrl = url.trim();
    if (!sourceUrl) return;
    await queryClient.cancelQueries({ queryKey: ["metadata-search"] });
    await queryClient.cancelQueries({ queryKey: ["metadata-release"] });
    setMediaSession((current) => current + 1);
    setSubmittedSearch("");
    setError(""); setMedia(null); setMetadata(null); setMetadataOrigins({}); setFormatId(""); setAudioFormatId(""); setDescriptionOpen(false);
    setSelectedCandidate(null); setReleaseId(""); setMetadataMessage("");
    try {
      const result = await analyzeMutation.mutateAsync(sourceUrl);
      const nextMetadata = defaultMetadata(result);
      setMedia(result); setMetadata(nextMetadata);
      setMetadataOrigins(Object.fromEntries(
        Object.entries(nextMetadata).filter(([key]) => key !== "artwork").map(([key]) => [key, "YouTube"]),
      ) as Partial<Record<MetadataField, MetadataOrigin>>);
      const cleanedTitle = cleanYouTubeTitle(result.title);
      const initialQuery = result.music.title && result.music.artist
        ? `${result.music.artist} - ${result.music.title}`
        : cleanedTitle.cleaned;
      setMetadataQuery(initialQuery);
      setPanel("download");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not analyze this link.");
    }
  }

  function searchMetadata(event: FormEvent) {
    event.preventDefault();
    const query = metadataQuery.trim().slice(0, 120);
    if (!query) return;
    setMetadataMessage(""); setSelectedCandidate(null); setReleaseId("");
    setSubmittedSearch(query);
    void queryClient.invalidateQueries({ queryKey: ["metadata-search", mediaSession, query] });
  }

  function loadRelease(id: string) {
    setReleaseId(id); setMetadataMessage("");
  }

  function applyRelease() {
    if (!release || !selectedCandidate || !metadata) return;
    const matching = release.tracks.filter((track) => track.recordingId === selectedCandidate.id);
    if (!matching.length) return;
    const track = matching[Math.min(chosenTrack, matching.length - 1)];
    const updatedMetadata = {
      ...metadata,
      title: track?.title || selectedCandidate.title || metadata.title,
      artist: track?.artist || release.artist || selectedCandidate.artist || metadata.artist,
      album: release.title || metadata.album,
      albumArtist: release.artist || metadata.albumArtist,
      date: release.date || metadata.date,
      genre: release.genre || metadata.genre,
      trackNumber: track?.trackNumber || metadata.trackNumber,
      discNumber: track?.discNumber || metadata.discNumber,
      artwork: release.artworkUrl ? { source: "coverart", url: release.artworkUrl } : metadata.artwork,
    } satisfies TrackMetadata;
    setMetadata(updatedMetadata);
    setMetadataOrigins((current) => ({
      ...current,
      title: track?.title || selectedCandidate.title ? "MusicBrainz" : current.title,
      artist: track?.artist || release.artist || selectedCandidate.artist ? "MusicBrainz" : current.artist,
      album: release.title ? "MusicBrainz" : current.album,
      albumArtist: release.artist ? "MusicBrainz" : current.albumArtist,
      date: release.date ? "MusicBrainz" : current.date,
      genre: release.genre ? "MusicBrainz" : current.genre,
      trackNumber: track?.trackNumber ? "MusicBrainz" : current.trackNumber,
      discNumber: track?.discNumber ? "MusicBrainz" : current.discNumber,
    }));
    setMetadataMessage(release.artworkUrl ? "Release details applied, including album artwork." : "Release details applied. This release has no available cover art.");
  }

  async function submitDownload(request: DownloadRequest) {
    if (!createGuard.enter()) return;
    setError("");
    lastSubmittedRequest.current = request;
    try {
      await createMutation.mutateAsync(request);
    } catch { /* The mutation owns the visible error and releases the duplicate guard. */ }
  }

  async function startDownload() {
    if (!media || !metadata || (mode === "video" && !videoChoices.length)) return;
    const request: DownloadRequest & { keepInLibrary: boolean } = {
      url: media.url,
      mode,
      audioFormat,
      audioQuality: quality,
      ...(mode === "audio" && formatId ? { formatId } : {}),
      ...(mode === "video" && formatId ? { formatId } : {}),
      ...(mode === "combined" && formatId ? { formatId } : {}),
      ...(mode === "combined" && !selectedFormatIsMuxed && audioFormatId ? { audioFormatId } : {}),
      metadata,
      includeInfoJson,
      keepInLibrary,
    };
    await submitDownload(request);
  }

  async function cancelDownload() {
    if (!job) return;
    const jobId = job.id;
    setCancelingJobId(jobId);
    await queryClient.cancelQueries({ queryKey: ["download-job", jobId] });
    try { await cancelMutation.mutateAsync(jobId); }
    catch { /* The mutation owns the visible error. */ }
    finally { setCancelingJobId(null); }
  }

  function retry() {
    if (lastSubmittedRequest.current) void submitDownload(lastSubmittedRequest.current);
  }
  function updateMetadata(field: MetadataField, value: string) {
    setMetadata((current) => current ? { ...current, [field]: value } : current);
    setMetadataOrigins((current) => ({ ...current, [field]: "Manual" }));
  }
  const currentArtwork = metadata?.artwork.source === "none" ? null : metadata?.artwork.url;
  const jobPercent = job?.progress == null ? null : Math.max(0, Math.min(100, job.progress));
  const lookupMessage = metadataMessage || (releaseQuery.isError ? `${releaseQuery.error.message} Manual editing remains available.` : metadataSearchQuery.isError ? `${metadataSearchQuery.error.message} Your manual edits are safe.` : metadataSearchQuery.isSuccess && !candidates.length ? "No matches found. You can still edit tags manually and download." : "");

  return (
    <main className="app-shell">
      <header className="topbar">
        <Link className="wordmark" href="/" aria-label="Vipod home"><span className="brand-icon"><Disc3 size={21} /></span>VIPOD</Link>
        <nav className="site-nav" aria-label="Main navigation"><Link href="/">Download</Link><Link href="/library">Library</Link><Link href="/temporary">Temporary</Link></nav>
        <p className="top-tagline">Your music. Your library.</p>
        <div className={`health-pill ${health?.ready ? "is-ready" : health && !health.ready ? "is-offline" : ""}`} aria-live="polite">
          <span className="health-dot" />{health?.ready ? "Tools ready" : health && !health.ready ? "Tools need setup" : healthError ? "Tools status unavailable" : "Checking tools"}
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy"><p className="eyebrow"><span /> YOUR PERSONAL MUSIC TOOL</p><h1>Make the internet<br /><em>part of your library.</em></h1><p className="hero-description">Bring a track in. Make it yours. Keep it close.</p></div>
        <div className="record-art" aria-hidden="true"><div className="record"><div className="record-label"><AudioLines size={23} /><span>VP</span></div></div><div className="record-shadow" /></div>
      </section>

      {health && !health.ready && <aside className="dependency-banner" role="status"><CircleAlert size={19} /><div><strong>Local tools need a hand</strong><p>Install <code>yt-dlp</code> and <code>ffmpeg</code> with <code>brew install yt-dlp ffmpeg</code>, then refresh this page. You can still try analyzing while setup finishes.</p></div></aside>}
      {!health && healthError && <aside className="soft-notice" role="status">Couldn’t check local tools yet. Try refreshing if analysis doesn’t work.</aside>}

      <section className="link-panel" aria-labelledby="link-heading">
        <div className="section-heading"><span className="step-index">01</span><div><p className="eyebrow">START WITH A LINK</p><h2 id="link-heading">What are we bringing in?</h2></div></div>
        <form className="link-form" onSubmit={analyze}>
          <label className="sr-only" htmlFor="video-url">YouTube video URL</label>
          <div className="url-field"><Music2 size={19} aria-hidden="true" /><input id="video-url" type="url" placeholder="Paste a YouTube link" value={url} onChange={(event) => setUrl(event.target.value)} required autoComplete="url" /><button type="submit" className="analyze-button" aria-label="Analyze media link" aria-busy={analyzeMutation.isPending} disabled={analyzeMutation.isPending}>{analyzeMutation.isPending ? <LoaderCircle className="spin" size={17} /> : <Sparkles size={17} />}<span>{analyzeMutation.isPending ? "Analyzing…" : "Analyze"}</span><ChevronRight size={16} /></button></div>
        </form>
        {error && <p className="error-line" role="alert"><CircleAlert size={16} />{error}</p>}
      </section>

      {media && metadata && <>
        <section className="media-card" aria-label="Analyzed media">
          <div className="cover-frame">{media.thumbnail ? <img src={media.thumbnail} alt={`Thumbnail for ${media.title}`} /> : <div className="cover-empty"><Disc3 size={42} /><span>No artwork</span></div>}<span className="duration-chip">{formatDuration(media.duration)}</span></div>
          <div className="media-summary"><div className="summary-top"><p className="eyebrow">READY TO MAKE YOURS</p><span className="source-chip">YOUTUBE</span></div><h2>{media.title}</h2><p className="channel-name">{media.channel || media.uploader || "Channel unavailable"}</p><div className="media-facts"><span>{formatDuration(media.duration)}</span>{media.uploadDate && <span>Uploaded {formatUploadDate(media.uploadDate)}</span>}{media.viewCount != null && <span>{media.viewCount.toLocaleString()} views</span>}</div><button className="text-action" type="button" onClick={() => setDescriptionOpen((value) => !value)} aria-expanded={descriptionOpen}>{descriptionOpen ? "Hide description" : "Show description"}<ChevronDown size={15} className={descriptionOpen ? "rotate" : ""} /></button>{descriptionOpen && <p className="media-description">{media.description || "No description was provided."}</p>}</div>
        </section>

        <section className="workspace" aria-label="Download setup">
          <div className="panel-tabs" aria-label="Setup sections">{(["download", "metadata", "details"] as Panel[]).map((tab) => <button key={tab} type="button" aria-pressed={panel === tab} onClick={() => setPanel(tab)}>{tab === "download" ? <Download size={16} /> : tab === "metadata" ? <Music2 size={16} /> : <Activity size={16} />}{tab === "download" ? "Download" : tab === "metadata" ? "Metadata" : "Details"}</button>)}</div>
          {panel === "download" && <div className="panel-body download-panel">
            <div className="panel-intro"><div><p className="eyebrow">02 · PICK YOUR EDITION</p><h2>Choose a format</h2></div><p>Keep it simple. You can change tags before you save.</p></div>
          <fieldset className="mode-options">
            <legend className="sr-only">Download mode</legend>
            {(["audio", "video", "combined"] as Mode[]).map((item) => (
              <label className={`mode-option ${mode === item ? "selected" : ""}`} key={item}>
                <input
                  type="radio"
                  name="download-mode"
                  value={item}
                  checked={mode === item}
                  onChange={() => {
                    setMode(item);
                    setFormatId("");
                    setAudioFormatId("");
                  }}
                />
                <span className="radio-mark" />
                {item === "audio" ? "Audio" : item === "video" ? "Video" : "Audio + video"}
              </label>
            ))}
          </fieldset>
            {mode === "audio" && <div className="format-grid"><label className="field-label">Audio file<select value={audioFormat} onChange={(event) => setAudioFormat(event.target.value as AudioFormat)}><option value="m4a">M4A · recommended for VIPOD</option><option value="mp3">MP3 · widely compatible</option><option value="original">Original · may not play in VIPOD</option></select></label><label className="field-label">Audio quality<select value={quality} onChange={(event) => setAudioQuality(event.target.value as DownloadRequest["audioQuality"])}><option value="best">Best available</option><option value="192">192 kbps</option><option value="256">256 kbps</option><option value="320">320 kbps</option></select></label>{audioFormats.length > 0 && <label className="field-label">Source audio<select value={formatId} onChange={(event) => setFormatId(event.target.value)}><option value="">Auto · best available</option>{audioFormats.map((format) => <option value={format.id} key={format.id}>{formatLabel(format)} · ID {format.id} · {readableSize(format.filesize || format.filesizeApprox)}{!format.filesize && format.filesizeApprox ? " approx." : ""}</option>)}</select></label>}</div>}
            {mode === "video" && <label className="field-label format-select">Video quality<select value={formatId} onChange={(event) => setFormatId(event.target.value)}><option value="">Auto · best available</option>{videoFormats.map((format) => <option value={format.id} key={format.id}>{formatLabel(format)} · ID {format.id} · {readableSize(format.filesize || format.filesizeApprox)}{!format.filesize && format.filesizeApprox ? " approx." : ""}</option>)}</select>{!videoFormats.length && <span className="field-hint">No video-only formats are available for this media.</span>}</label>}
            {mode === "combined" && <div className="format-grid"><label className="field-label">Video track<select value={formatId} onChange={(event) => setFormatId(event.target.value)}><option value="">Auto · best available</option>{videoChoices.map((format) => <option key={format.id} value={format.id}>{formatLabel(format)} · ID {format.id} · {readableSize(format.filesize || format.filesizeApprox)}{!format.filesize && format.filesizeApprox ? " approx." : ""}</option>)}</select><span className="field-hint">Muxed formats already contain both tracks.</span></label>{!selectedFormatIsMuxed && <label className="field-label">Audio track<select value={audioFormatId} onChange={(event) => setAudioFormatId(event.target.value)}><option value="">Auto · best available</option>{audioOptions.map((format) => <option key={format.id} value={format.id}>{formatLabel(format)} · ID {format.id} · {readableSize(format.filesize || format.filesizeApprox)}{!format.filesize && format.filesizeApprox ? " approx." : ""}</option>)}</select><span className="field-hint">Choose an audio ID independently, or leave it on auto.</span></label>}</div>}
            {mode === "audio" && <div className="available-formats"><p className="eyebrow">AVAILABLE SOURCES</p>{audioFormats.length ? <div className="format-chips">{audioFormats.slice(0, 8).map((item) => <span key={item.id}>{item.ext.toUpperCase()} · {item.audioBitrate ? `${item.audioBitrate} kbps` : item.audioCodec || "audio"}{item.filesize || item.filesizeApprox ? ` · ${readableSize(item.filesize || item.filesizeApprox)}${!item.filesize ? " approx." : ""}` : " · size unknown"}</span>)}</div> : <p className="field-hint">Source formats are unavailable; automatic best quality will be used.</p>}<p className="quality-note">Converting can change the file format, but it cannot improve the source audio quality.</p></div>}
            <label className="checkbox-row"><input type="checkbox" checked={includeInfoJson} onChange={(event) => setIncludeInfoJson(event.target.checked)} /><span className="check-box"><Check size={13} /></span><span><strong>Save a JSON info companion</strong><small>Keep source details beside your download.</small></span><FileJson2 size={18} className="checkbox-icon" /></label>
            <label className="checkbox-row"><input type="checkbox" checked={keepInLibrary} onChange={(event) => setKeepInLibrary(event.target.checked)} /><span className="check-box"><Check size={13} /></span><span><strong>Keep a copy in my library</strong><small>Retain this export on the server so it can be reused.</small></span><Disc3 size={18} className="checkbox-icon" /></label>
            {mode === "audio" && audioFormat === "original" && metadata.artwork.source !== "none" && <p className="format-warning" role="status">Original files outside MP3, M4A, FLAC, or Opus may not preserve tags or cover art. Choose No artwork or an M4A/MP3 export.</p>}
            <div className="metadata-mini"><div className="mini-art">{currentArtwork ? <img src={currentArtwork} alt="Selected track artwork preview" /> : <Disc3 size={22} />}</div><div><p className="eyebrow">SAVED WITH YOUR FILE</p><strong>{metadata.title || "Untitled track"}</strong><span>{metadata.artist || "Artist not set"}{metadata.album ? ` · ${metadata.album}` : ""}</span></div><button className="text-action" type="button" onClick={() => setPanel("metadata")}>Edit tags <ChevronRight size={14} /></button></div>
            <button className="primary-action" type="button" onClick={() => void startDownload()} disabled={!jobReady || createMutation.isPending || Boolean(job && ACTIVE.has(job.status)) || (mode === "video" && !videoFormats.length)} aria-busy={createMutation.isPending}><ArrowDownToLine size={18} />{!jobReady ? jobQuery.isError ? "Could not restore previous download" : "Checking previous download…" : createMutation.isPending ? "Starting…" : job && ACTIVE.has(job.status) ? jobSourceUrl && jobSourceUrl !== media.url ? "Previous download in progress" : "Download in progress" : "Download to this device"}</button>
            {jobQuery.isError && <p className="error-line" role="alert">{jobQuery.error.message}<button className="text-action" type="button" onClick={() => void jobQuery.refetch()}>Retry status check</button></p>}
          </div>}

          {panel === "metadata" && (
            <div className="panel-body metadata-panel">
              <div className="panel-intro">
                <div><p className="eyebrow">MAKE IT YOURS</p><h2>Track details</h2></div>
                <p>Only known details are prefilled. Your edits stay yours.</p>
              </div>
              <div className="metadata-editor">
                <div className="artwork-editor">
                  <div className="artwork-preview">
                    {currentArtwork ? <img src={currentArtwork} alt="Selected track artwork" /> : <Disc3 size={42} />}
                  </div>
                  <label className="field-label">
                    Artwork source
                    <select
                      value={metadata.artwork.source}
                      onChange={(event) => {
                        const source = event.target.value as TrackMetadata["artwork"]["source"];
                        const artwork = source === "thumbnail" && media.thumbnail
                          ? { source, url: media.thumbnail }
                          : source === "coverart" && release?.artworkUrl
                            ? { source, url: release.artworkUrl }
                            : { source: "none" as const };
                        setMetadata((current) => current ? { ...current, artwork } : current);
                      }}
                    >
                      <option value="thumbnail" disabled={!media.thumbnail}>Video thumbnail</option>
                      <option value="coverart" disabled={!release?.artworkUrl}>Album cover{release?.artworkUrl ? " · available" : " · unavailable"}</option>
                      <option value="none">No artwork</option>
                    </select>
                  </label>
                  <p className="field-hint">
                    {mode !== "audio"
                      ? "Preview only; video downloads do not embed audio artwork."
                      : metadata.artwork.source === "none"
                        ? "No artwork will be embedded."
                        : "Artwork will be embedded in the audio file."}
                  </p>
                </div>
                <div className="metadata-fields">
                  {([
                    ["title", "Title"], ["artist", "Artist"], ["album", "Album"],
                    ["albumArtist", "Album artist"], ["date", "Date"], ["genre", "Genre"],
                    ["trackNumber", "Track number"], ["discNumber", "Disc number"],
                  ] as const).map(([field, label]) => (
                    <label className="field-label" key={field}>
                      {label}
                      <input
                        value={metadata[field]}
                        onChange={(event) => updateMetadata(field, event.target.value)}
                        placeholder={field === "date" ? "YYYY or YYYY-MM-DD" : undefined}
                      />
                      <span className="field-hint">Source: {metadataOrigins[field] || "Manual"}</span>
                    </label>
                  ))}
                </div>
              </div>
              <MetadataLookup
                metadataQuery={metadataQuery}
                searching={metadataSearchQuery.isFetching}
                releaseLoading={releaseQuery.isFetching}
                metadataMessage={lookupMessage}
                candidates={candidates}
                selectedCandidate={selectedCandidate}
                releaseId={releaseId}
                release={release}
                chosenTrack={chosenTrack}
                onQueryChange={setMetadataQuery}
                onSearch={searchMetadata}
                onSelectCandidate={(candidate) => {
                  setSelectedCandidate(candidate);
                  const suggested = candidate.releases.find((r) => r.suggested) ?? candidate.releases[0];
                  setReleaseId(suggested ? suggested.id : "");
                  setChosenTrack(0);
                }}
                onSelectRelease={(id) => void loadRelease(id)}
                onChooseTrack={setChosenTrack}
                onApply={applyRelease}
              />
            </div>
          )}
          {panel === "details" && (
            <div className="panel-body details-panel">
              <div className="panel-intro">
                <div><p className="eyebrow">SOURCE INFORMATION</p><h2>Details & extras</h2></div>
                <p>Original upload information, kept separate from release metadata.</p>
              </div>
              <div className="detail-cards">
                <div className="detail-card"><span>Uploaded</span><strong>{formatUploadDate(media.uploadDate)}</strong><small>Upload date is not the music release date.</small></div>
                <div className="detail-card"><span>Views</span><strong>{media.viewCount?.toLocaleString() || "Unavailable"}</strong></div>
                <div className="detail-card"><span>Likes</span><strong>{media.likeCount?.toLocaleString() || "Unavailable"}</strong></div>
                <div className="detail-card"><span>Chapters</span><strong>{media.chapters.length || "None"}</strong>{media.chapters.length > 0 && <small>{media.chapters.map((item) => `${formatDuration(item.start)} ${item.title}`).join(" · ")}</small>}</div>
                <div className="detail-card"><span>Subtitles</span><strong>{media.subtitleLanguages.length ? media.subtitleLanguages.join(", ") : "Unavailable"}</strong></div>
                <div className="detail-card"><span>Categories</span><strong>{media.categories.length ? media.categories.join(", ") : "Unavailable"}</strong></div>
              </div>
              <details className="raw-details">
                <summary><span>Technical info & raw source data</span><ChevronDown size={16} /></summary>
                <div>
                  <p className="eyebrow">FORMATS · CODECS · SOURCE IDS</p>
                  {formats.length ? (
                    <div className="format-chips">
                      {formats.map((item) => <span key={item.id}>{formatTechnicalDetails(item)} · {item.audioCodec || "no audio"}{item.videoCodec ? ` / ${item.videoCodec}` : ""}</span>)}
                    </div>
                  ) : <p className="field-hint">No format data available.</p>}
                  <p className="eyebrow raw-label">SOURCE JSON</p>
                  <pre>{JSON.stringify(media.raw, null, 2)}</pre>
                </div>
              </details>
            </div>
          )}
        </section>
      </>}

      {job && (
        <section className={`job-card job-${job.status}`} aria-live="polite">
          <div className="job-icon">
            {job.status === "completed" ? <Check size={20} />
              : job.status === "failed" ? <CircleAlert size={20} />
                : job.status === "cancelled" ? <X size={20} />
                  : job.status === "processing" ? <FileAudio size={20} />
                    : <LoaderCircle size={20} className="spin" />}
          </div>
          <div className="job-content">
            <div className="job-heading">
              <div>
                <p className="eyebrow">{job.status === "processing" ? "FINALIZING YOUR FILE" : "DOWNLOAD STATUS"}</p>
                <h2>
                  {job.status === "completed" ? "Ready for your library."
                    : job.status === "failed" ? "That download needs another try."
                      : job.status === "cancelled" ? "Download cancelled."
                        : job.status === "processing" ? "Finishing up"
                          : job.status === "downloading" ? "Bringing it in"
                            : job.status === "analyzing" ? "Checking the source" : "In the queue"}
                </h2>
              </div>
              <span className="job-status-label">{job.status}</span>
            </div>
            <p className="job-message">{job.error || job.message || job.stage}</p>
            {jobPercent != null && (
              <div className="progress-track" role="progressbar" aria-label="Download progress" aria-valuenow={Math.round(jobPercent)} aria-valuemin={0} aria-valuemax={100}>
                <span style={{ width: `${jobPercent}%` }} />
              </div>
            )}
            {jobPercent == null && ACTIVE.has(job.status) && (
              <div className="progress-track indeterminate" aria-label="Download in progress"><span /></div>
            )}
            {job.status === "completed" && (
              <div className="job-downloads">
                <a className="primary-action download-link" href={job.downloadUrl || `/api/downloads/${encodeURIComponent(job.id)}/file`}>
                  <ArrowDownToLine size={18} />Save {job.fileName || "file"}<ExternalLink size={15} />
                </a>
                {job.infoUrl && <a className="secondary-action" href={job.infoUrl}><FileJson2 size={16} />Save info JSON</a>}
              </div>
            )}
            {job.status === "failed" && retryAvailable && (
              <button className="secondary-action" type="button" onClick={retry} disabled={createMutation.isPending}>
                <Download size={16} />Retry this download
              </button>
            )}
            {job.status === "failed" && !retryAvailable && (
              <p className="field-hint">Analyze the source again to start a new download.</p>
            )}
            {ACTIVE.has(job.status) && (
              <button className="cancel-action" type="button" onClick={() => void cancelDownload()} disabled={cancelMutation.isPending} aria-busy={cancelMutation.isPending}>
                {cancelMutation.isPending ? <LoaderCircle className="spin" size={15} /> : <Pause size={15} />}{cancelMutation.isPending ? "Cancelling…" : "Cancel"}
              </button>
            )}
          </div>
        </section>
      )}

      {!media && !job && <section className="how-it-works"><div className="section-heading"><span className="step-index">02</span><div><p className="eyebrow">THREE SMALL STEPS</p><h2>From link to library.</h2></div></div><div className="steps-grid"><article><span className="step-icon"><Search size={19} /></span><span className="step-number">01</span><h3>Paste a link</h3><p>Start with a YouTube video. We’ll find the available media.</p></article><article><span className="step-icon"><Music2 size={19} /></span><span className="step-number">02</span><h3>Make it yours</h3><p>Choose your format and add the track details you want.</p></article><article><span className="step-icon"><Download size={19} /></span><span className="step-number">03</span><h3>Download & import</h3><p>Save the file and bring it into your personal library.</p></article></div></section>}
      <footer className="footer"><a className="wordmark footer-wordmark" href="#top"><span className="brand-icon"><Disc3 size={17} /></span>VIPOD</a><span>Your music stays yours.</span></footer>
    </main>
  );
}
