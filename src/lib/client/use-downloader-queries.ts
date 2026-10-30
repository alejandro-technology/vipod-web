"use client";

import { useQuery } from "@tanstack/react-query";
import type { DependencyHealth, DownloadJob, MetadataCandidate, MetadataRelease } from "@/lib/contracts";
import { api, ApiRequestError } from "./api";

const ACTIVE = new Set<DownloadJob["status"]>(["queued", "analyzing", "downloading", "processing"]);

export function useDownloaderQueries({ mediaSession, search, duration, releaseId, jobId, cancelingJobId }: {
  mediaSession: number;
  search: string;
  duration?: number | null;
  releaseId: string;
  jobId: string | null;
  cancelingJobId: string | null;
}) {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: ({ signal }) => api<DependencyHealth>("/api/health", { signal }),
    staleTime: 60_000,
  });
  const metadataSearch = useQuery({
    queryKey: ["metadata-search", mediaSession, search, duration],
    queryFn: ({ signal }) => {
      const params = new URLSearchParams({ q: search });
      if (typeof duration === "number" && Number.isFinite(duration) && duration > 0) {
        params.set("duration", String(Math.round(duration)));
      }
      return api<{ results: MetadataCandidate[] }>(`/api/metadata/search?${params.toString()}`, { signal });
    },
    enabled: Boolean(search),
    staleTime: 5 * 60_000,
  });
  const release = useQuery({
    queryKey: ["metadata-release", mediaSession, releaseId],
    queryFn: ({ signal }) => api<MetadataRelease>(`/api/metadata/releases/${encodeURIComponent(releaseId)}`, { signal }),
    enabled: Boolean(releaseId),
    staleTime: 5 * 60_000,
  });
  const job = useQuery({
    queryKey: ["download-job", jobId],
    queryFn: ({ signal }) => api<DownloadJob>(`/api/downloads/${encodeURIComponent(jobId!)}`, { signal }),
    enabled: Boolean(jobId && !cancelingJobId),
    retry: false,
    refetchInterval: (query) => {
      if (query.state.error instanceof ApiRequestError && query.state.error.status === 404) return false;
      return query.state.data && !ACTIVE.has(query.state.data.status) ? false : 2_000;
    },
  });
  return { health, metadataSearch, release, job };
}
