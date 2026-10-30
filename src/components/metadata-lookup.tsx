"use client";

import type { FormEvent } from "react";
import { Check, LoaderCircle, Music2, Search } from "lucide-react";
import type { MetadataCandidate, MetadataRelease } from "@/lib/contracts";

type MetadataLookupProps = {
  metadataQuery: string;
  searching: boolean;
  releaseLoading: boolean;
  metadataMessage: string;
  candidates: MetadataCandidate[];
  selectedCandidate: MetadataCandidate | null;
  releaseId: string;
  release: MetadataRelease | null;
  chosenTrack: number;
  onQueryChange: (value: string) => void;
  onSearch: (event: FormEvent) => void;
  onSelectCandidate: (candidate: MetadataCandidate) => void;
  onSelectRelease: (id: string) => void;
  onChooseTrack: (index: number) => void;
  onApply: () => void;
};

function formatDuration(seconds: number | null) {
  if (seconds == null || !Number.isFinite(seconds)) return "Duration unavailable";
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
}

export function MetadataLookup({
  metadataQuery, searching, releaseLoading, metadataMessage, candidates, selectedCandidate,
  releaseId, release, chosenTrack, onQueryChange, onSearch, onSelectCandidate,
  onSelectRelease, onChooseTrack, onApply,
}: MetadataLookupProps) {
  const matchingTracks = release && selectedCandidate
    ? release.tracks.filter((track) => track.recordingId === selectedCandidate.id)
    : [];

  return <div className="lookup-box">
    <div className="lookup-title"><div><p className="eyebrow">OPTIONAL · MUSICBRAINZ</p><h3>Find a release</h3></div><span className="manual-pill">Manual tags always work</span></div>
    <p className="lookup-explainer">Search for the music in this video, then choose the recording and album version that match.</p>
    <form className="lookup-form" onSubmit={onSearch} aria-busy={searching}>
      <label className="sr-only" htmlFor="music-search">Search music metadata</label>
      <input id="music-search" value={metadataQuery} maxLength={120} onChange={(event) => onQueryChange(event.target.value)} placeholder="Song title and artist" required />
      <button type="submit" className="secondary-action" disabled={searching}>{searching ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}Search</button>
    </form>
    {metadataMessage && <p className="lookup-message" role="status">{metadataMessage}</p>}
    {candidates.length > 0 && <div className="candidate-list" aria-label="MusicBrainz search results">
      {candidates.map((candidate) => <button type="button" className={`candidate-row ${selectedCandidate?.id === candidate.id ? "selected" : ""}`} key={candidate.id} aria-pressed={selectedCandidate?.id === candidate.id} onClick={() => onSelectCandidate(candidate)}>
        <span className="candidate-disc"><Music2 size={17} /></span><span className="candidate-info"><strong>{candidate.title}</strong><small>{candidate.artist}{candidate.disambiguation ? ` · ${candidate.disambiguation}` : ""}{` · ${formatDuration(candidate.duration)} · ${candidate.firstReleaseDate || "Date unknown"}`}</small></span><span className="candidate-score-wrap">{candidate.suggested && <span className="suggested-badge">Suggested</span>}<span className="candidate-score">{Math.round(candidate.score)}%</span></span>
      </button>)}
    </div>}
    {selectedCandidate && <div className="release-picker">
      <div className="release-header">
        <label className="field-label" htmlFor="release-version-select">Choose album version</label>
        {selectedCandidate.releases.find((item) => item.id === releaseId)?.suggested && <span className="suggested-badge">Suggested release</span>}
      </div>
      <select id="release-version-select" value={releaseId} onChange={(event) => onSelectRelease(event.target.value)}><option value="">Select a release…</option>{selectedCandidate.releases.map((item) => <option key={item.id} value={item.id}>{item.suggested ? "⭐ " : ""}{item.title}{item.date ? ` · ${item.date}` : ""}{item.country ? ` · ${item.country}` : ""}{item.primaryType ? ` [${item.primaryType}]` : ""}{item.suggested ? " — Suggested" : ""}</option>)}</select>
      {releaseLoading && <span className="field-hint" role="status"><LoaderCircle className="spin" size={14} /> Loading release details…</span>}
      {release && <>
        <p className="release-summary"><strong>{release.title}</strong> · {release.artist}{release.date ? ` · ${release.date}` : ""}<br />{matchingTracks.length ? `${matchingTracks.length} matching track version(s) in this release.` : "This release does not contain the selected recording. Choose another release."}</p>
        {matchingTracks.length > 1 && <label className="field-label">Track version<select value={chosenTrack} onChange={(event) => onChooseTrack(Number(event.target.value))}>{matchingTracks.map((track, index) => <option key={`${track.recordingId}-${index}`} value={index}>{track.trackNumber || "?"}. {track.title} · {track.artist}</option>)}</select></label>}
        <button className="secondary-action apply-release" type="button" onClick={onApply} disabled={!matchingTracks.length}><Check size={16} />Apply release details</button>
      </>}
    </div>}
  </div>;
}
