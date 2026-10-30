import { listLibrary } from "@/lib/server/jobs";
import { errorResponse } from "@/lib/server/errors";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(request: Request): Promise<Response> {
  try {
    const url = new URL(request.url); const retention = url.searchParams.get("retention");
    if (retention && retention !== "temporary" && retention !== "permanent") return Response.json({ error: { code: "INVALID_RETENTION", message: "Retention must be temporary or permanent." } }, { status: 400, headers: { "Cache-Control": "no-store" } });
    return Response.json({ items: await listLibrary(retention as "temporary" | "permanent" | undefined, url.searchParams.get("q") ?? "") }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
