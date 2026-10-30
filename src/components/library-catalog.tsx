/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDownToLine, CircleAlert, Disc3, FileJson2, LoaderCircle, Pause, Trash2 } from "lucide-react";
import Link from "next/link";
import type { DownloadJob, LibraryItem } from "@/lib/contracts";
import { SiteHeader } from "@/components/site-header";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || `Request failed (${response.status})`);
  return body as T;
}

const active = new Set<DownloadJob["status"]>(["queued", "analyzing", "downloading", "processing"]);
type DownloadJobsResponse = { jobs: DownloadJob[] };
const formatSize = (bytes: number) => bytes > 0 ? `${(bytes / 1048576).toFixed(bytes / 1048576 < 10 ? 1 : 0)} MB` : "Size unknown";
const formatDate = (value: string) => new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));

export function LibraryCatalog({ temporary = false }: { temporary?: boolean }) {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [now, setNow] = useState(Date.now());
  const [pending, setPending] = useState<Record<string, string>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState("");
  const [failedArtwork, setFailedArtwork] = useState<Record<string, boolean>>({});
  const revalidatedExpiryIds = useRef(new Set<string>());
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(search.trim().slice(0, 120)), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const itemsQuery = useQuery({
    queryKey: ["library", temporary ? "temporary" : "permanent", debounced],
    queryFn: ({ signal }) => request<{ items: LibraryItem[] }>(`/api/library?retention=${temporary ? "temporary" : "permanent"}${debounced ? `&q=${encodeURIComponent(debounced)}` : ""}`, { signal }),
    refetchInterval: temporary ? 30_000 : false,
  });
  const jobsQuery = useQuery({
    queryKey: ["downloads"],
    queryFn: ({ signal }) => request<DownloadJobsResponse>("/api/downloads", { signal }),
    enabled: temporary,
    refetchInterval: temporary ? 3_000 : false,
  });
  const retainMutation = useMutation({
    mutationFn: (id: string) => request<LibraryItem>(`/api/library/${encodeURIComponent(id)}/retain`, { method: "POST" }),
    onSuccess: async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ["library"] }), queryClient.invalidateQueries({ queryKey: ["downloads"] })]); },
  });
  const deleteMutation = useMutation({
    mutationFn: (item: LibraryItem) => request<void>(`/api/library/${encodeURIComponent(item.id)}`, { method: "DELETE" }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["library"] }),
        queryClient.invalidateQueries({ queryKey: ["downloads"] }),
        queryClient.invalidateQueries({ queryKey: ["download-job"] }),
      ]);
    },
  });
  const cancelMutation = useMutation({
    mutationFn: (job: DownloadJob) => request<DownloadJob>(`/api/downloads/${encodeURIComponent(job.id)}`, { method: "DELETE" }),
    onSuccess: async (job) => {
      queryClient.setQueryData<DownloadJobsResponse>(["downloads"], (current) => current && ({ jobs: current.jobs.map((item) => item.id === job.id ? job : item) }));
      await queryClient.invalidateQueries({ queryKey: ["downloads"] });
    },
  });
  const items = useMemo(() => (itemsQuery.data?.items ?? []).filter((item) => !temporary || !item.expiresAt || new Date(item.expiresAt).getTime() > now), [itemsQuery.data, now, temporary]);
  const jobs = (jobsQuery.data?.jobs ?? []).filter((job) => active.has(job.status));

  useEffect(() => {
    if (!temporary || !itemsQuery.data) return;
    const newlyExpired = itemsQuery.data.items.some((item) => {
      if (!item.expiresAt || Date.parse(item.expiresAt) > now || revalidatedExpiryIds.current.has(item.id)) return false;
      revalidatedExpiryIds.current.add(item.id);
      return true;
    });
    if (newlyExpired) void queryClient.invalidateQueries({ queryKey: ["library", "temporary"] });
  }, [itemsQuery.data, now, queryClient, temporary]);

  async function runItemAction(id: string, action: string, operation: () => Promise<unknown>) {
    setPending((current) => ({ ...current, [id]: action })); setErrors((current) => ({ ...current, [id]: "" }));
    try {
      await operation();
      setNotice(action === "retain" ? "Saved to the Library. The server copy is retained." : action === "delete" ? "Deleted from the server. Copies already saved to devices are unaffected." : "Download cancelled.");
    } catch (cause) { setErrors((current) => ({ ...current, [id]: cause instanceof Error ? cause.message : "The action failed." })); }
    finally { setPending((current) => { const next = { ...current }; delete next[id]; return next; }); }
  }

  return <main className="app-shell catalog-page">
    <SiteHeader />
    <section className="catalog-hero">
      <p className="eyebrow"><span /> YOUR PERSONAL MUSIC TOOL</p>
      <h1>{temporary ? <>Temporary <em>exports.</em></> : <>Your <em>library.</em></>}</h1>
      <p>{temporary ? "Files are available here until their server retention expires." : "Saved exports ready whenever you need them."}</p>
    </section>
    <label className="catalog-search"><span className="sr-only">Search by title, artist, or album</span><input value={search} maxLength={120} onChange={(event) => setSearch(event.target.value)} placeholder="Search title, artist, or album" /></label>
    {notice && <p className="soft-notice" role="status">{notice}</p>}
    {itemsQuery.isPending ? <div className="catalog-grid" aria-label="Loading saved files" aria-busy="true">{[1, 2, 3].map((id) => <div className="catalog-skeleton" key={id} />)}</div>
      : itemsQuery.isError ? <div className="catalog-state" role="alert"><CircleAlert /> <p>{itemsQuery.error.message}</p><button className="secondary-action" onClick={() => void itemsQuery.refetch()}>Try again</button></div>
        : items.length ? <div className="catalog-grid">{items.map((item) => {
          const id = item.id;
          const expiry = item.expiresAt ? Math.max(0, new Date(item.expiresAt).getTime() - now) : null;
          const remaining = expiry == null ? "" : expiry <= 0 ? "Expired" : `${Math.floor(expiry / 3600000)}h ${Math.floor((expiry % 3600000) / 60000)}m remaining`;
          return <article className="library-card" key={id}>
            <div className="library-art">{item.metadata.artwork.url && !failedArtwork[id] ? <img src={item.metadata.artwork.url} alt={`${item.metadata.title || item.fileName} artwork`} onError={() => setFailedArtwork((current) => ({ ...current, [id]: true }))} /> : <Disc3 size={35} aria-label="Artwork unavailable" />}</div>
            <div className="library-card-content"><p className="eyebrow">{item.mode === "audio" ? "AUDIO EXPORT" : item.mode === "video" ? "VIDEO EXPORT" : "AUDIO + VIDEO EXPORT"}</p>
              <h2>{item.metadata.title || item.fileName}</h2><p className="library-subtitle">{[item.metadata.artist, item.metadata.album].filter(Boolean).join(" · ") || "Details unavailable"}</p>
              <p className="library-facts"><span>{item.format.toUpperCase()}</span><span>{formatSize(item.fileSize)}</span><span>{formatDate(item.createdAt)}</span>{temporary && <span className="expiry-label">{remaining}</span>}</p>
              {errors[id] && <p className="error-line" role="alert">{errors[id]}</p>}
              <div className="library-actions"><a className="primary-action" href={item.downloadUrl}><ArrowDownToLine size={16} />Save to device</a>{item.infoUrl && <a className="secondary-action" href={item.infoUrl}><FileJson2 size={15} />Info JSON</a>}
                {temporary && <button className="secondary-action" disabled={Boolean(pending[id])} aria-busy={pending[id] === "retain"} onClick={() => void runItemAction(id, "retain", () => retainMutation.mutateAsync(id))}>{pending[id] === "retain" ? <LoaderCircle className="spin" size={15} /> : null}{pending[id] === "retain" ? "Keeping…" : "Keep in library"}</button>}
                <button className="cancel-action" disabled={Boolean(pending[id])} aria-busy={pending[id] === "delete"} onClick={() => { if (window.confirm(`Delete ${item.fileName} from the server? Any copy already saved to your device will remain.`)) void runItemAction(id, "delete", () => deleteMutation.mutateAsync(item)); }}>{pending[id] === "delete" ? <LoaderCircle className="spin" size={15} /> : <Trash2 size={15} />}{pending[id] === "delete" ? "Deleting…" : "Delete from server"}</button>
              </div>
            </div>
          </article>;
        })}</div> : <div className="catalog-state"><Disc3 size={28} /><h2>{search ? "No matching files" : temporary ? "No temporary exports" : "Your library is ready"}</h2><p>{search ? "Try another title, artist, or album." : temporary ? "New temporary downloads will appear here." : "Choose Keep in library when downloading to save an export here."}</p></div>}
    {temporary && <section className="active-downloads"><h2>Active downloads</h2>{jobsQuery.isPending ? <p role="status">Loading active downloads…</p> : jobsQuery.isError ? <p className="error-line" role="alert">{jobsQuery.error.message}<button className="text-action" onClick={() => void jobsQuery.refetch()}>Retry</button></p> : jobs.length ? jobs.map((job) => <article className="active-download" key={job.id}><div><strong>{job.fileName || job.message || "Download in progress"}</strong><span>{job.status} · {job.stage}</span>{errors[job.id] && <span role="alert">{errors[job.id]}</span>}</div><button className="cancel-action" disabled={Boolean(pending[job.id])} aria-busy={pending[job.id] === "cancel"} onClick={() => void runItemAction(job.id, "cancel", () => cancelMutation.mutateAsync(job))}>{pending[job.id] === "cancel" ? <LoaderCircle className="spin" size={15} /> : <Pause size={15} />}{pending[job.id] === "cancel" ? "Cancelling…" : "Cancel"}</button></article>) : <p>No active downloads.</p>}</section>}
    <footer className="footer"><Link className="wordmark footer-wordmark" href="/"><span className="brand-icon"><Disc3 size={17} /></span>VIPOD</Link><span>Your music stays yours.</span></footer>
  </main>;
}
