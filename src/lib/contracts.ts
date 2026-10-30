export type MediaFormat = {
  id: string;
  ext: string;
  audioCodec: string | null;
  videoCodec: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrate: number | null;
  audioBitrate: number | null;
  sampleRate: number | null;
  filesize: number | null;
  filesizeApprox: number | null;
  note: string;
  type: "audio" | "video" | "combined";
};

export type TrackMetadata = {
  title: string;
  artist: string;
  album: string;
  albumArtist: string;
  date: string;
  genre: string;
  trackNumber: string;
  discNumber: string;
  artwork: { source: "thumbnail" | "coverart" | "none"; url?: string };
};

export type MediaInfo = {
  id: string;
  url: string;
  title: string;
  description: string;
  thumbnail: string | null;
  thumbnails: Array<{ url: string; width?: number; height?: number }>;
  duration: number | null;
  uploader: string | null;
  channel: string | null;
  uploadDate: string | null;
  viewCount: number | null;
  likeCount: number | null;
  categories: string[];
  tags: string[];
  music: Partial<Omit<TrackMetadata, "artwork">>;
  formats: MediaFormat[];
  chapters: Array<{ title: string; start: number; end: number }>;
  subtitleLanguages: string[];
  raw: Record<string, unknown>;
};

export type DownloadRequest = {
  url: string;
  mode: "audio" | "video" | "combined";
  audioFormat: "m4a" | "mp3" | "original";
  audioQuality: "best" | "192" | "256" | "320";
  formatId?: string;
  audioFormatId?: string;
  metadata: TrackMetadata;
  includeInfoJson: boolean;
  keepInLibrary?: boolean;
};

export type DownloadJob = {
  id: string;
  status:
    | "queued"
    | "analyzing"
    | "downloading"
    | "processing"
    | "completed"
    | "failed"
    | "cancelled";
  progress: number | null;
  stage: string;
  message?: string;
  createdAt: string;
  updatedAt: string;
  fileName?: string;
  fileSize?: number;
  downloadUrl?: string;
  infoUrl?: string;
  error?: string;
  expiresAt?: string;
  libraryItemId?: string;
  reused?: boolean;
  retentionError?: string;
};

export type LibraryItem = {
  id: string;
  sourceId: string;
  sourceUrl: string;
  metadata: TrackMetadata;
  mode: DownloadRequest["mode"];
  format: string;
  fileName: string;
  fileSize: number;
  createdAt: string;
  retention: "temporary" | "permanent";
  expiresAt: string | null;
  downloadUrl: string;
  infoUrl: string | null;
};

export type MetadataCandidate = {
  id: string;
  title: string;
  disambiguation?: string;
  artist: string;
  duration: number | null;
  firstReleaseDate: string | null;
  score: number;
  suggested?: boolean;
  releases: Array<{
    id: string;
    title: string;
    date: string | null;
    country: string | null;
    status?: string | null;
    primaryType?: string | null;
    secondaryTypes?: string[];
    suggested?: boolean;
  }>;
};

export type MetadataRelease = {
  id: string;
  title: string;
  artist: string;
  date: string | null;
  genre: string;
  artworkUrl: string | null;
  tracks: Array<{
    recordingId: string;
    title: string;
    artist: string;
    trackNumber: string;
    discNumber: string;
  }>;
};

export type DependencyHealth = {
  ready: boolean;
  tools: Array<{ name: string; available: boolean; version: string | null }>;
};

export type ApiError = {
  error: { code: string; message: string };
};
