import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import { resolveJobFile } from "@/lib/server/jobs";
import { errorResponse } from "@/lib/server/errors";
import { contentDisposition } from "@/lib/server/media";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  try {
    const { id } = await params; const resolved = await resolveJobFile(id, "info");
    if (!resolved) return Response.json({ error: { code: "FILE_NOT_FOUND", message: "The metadata export was not found." } }, { status: 404 });
    const handle = await open(resolved.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stream = handle.createReadStream({ signal: _request.signal });
    return new Response(Readable.toWeb(stream) as ReadableStream, { headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": contentDisposition(`${id}.info.json`), "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
