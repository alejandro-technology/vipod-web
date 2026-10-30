export class ApiRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const body = payload as { error?: { message?: string } } | null;
    throw new ApiRequestError(body?.error?.message || `Request failed (${response.status})`, response.status);
  }
  return payload as T;
}
