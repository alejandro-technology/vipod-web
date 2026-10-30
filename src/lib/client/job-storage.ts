const JOB_STORAGE_KEY = "vipod.latest-job";

export function readStoredJobId(): string | null {
  try { return window.localStorage.getItem(JOB_STORAGE_KEY); } catch { return null; }
}

export function persistJobId(id: string): void {
  try { window.localStorage.setItem(JOB_STORAGE_KEY, id); } catch { /* Storage is optional; the server job remains authoritative. */ }
}

export function clearStoredJobId(id: string): void {
  try {
    if (window.localStorage.getItem(JOB_STORAGE_KEY) === id) window.localStorage.removeItem(JOB_STORAGE_KEY);
  } catch { /* Storage is optional. */ }
}
