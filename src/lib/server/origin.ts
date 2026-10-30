import { ApiFailure } from "./errors";

function trustedHost(host: string): boolean {
  const normalized = host.toLowerCase();
  const value = normalized.startsWith("[") ? normalized.slice(1, normalized.indexOf("]")) : normalized.split(":")[0];
  return value === "localhost" || value === "127.0.0.1" || value === "::1" || value.endsWith(".local") || value.split(".").length === 4;
}
export function assertTrustedOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  const host = request.headers.get("host");
  const allowed = new Set((process.env.ALLOWED_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean));
  if (host && trustedHost(host)) allowed.add(`${new URL(request.url).protocol}//${host}`);
  if (origin === "null" || !allowed.has(origin)) throw new ApiFailure(403, "ORIGIN_DENIED", "Requests from this origin are not allowed.");
}
