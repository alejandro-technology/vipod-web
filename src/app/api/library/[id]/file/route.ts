import { Readable } from "node:stream";
import { openLibraryFile } from "@/lib/server/jobs";
import { contentDisposition } from "@/lib/server/media";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(request: Request, { params }: Context): Promise<Response> {
  try {
    const opened = await openLibraryFile((await params).id, "file");
    if (!opened) return Response.json({ error: { code: "FILE_NOT_FOUND", message: "The library file was not found." } }, { status: 404, headers: { "Cache-Control": "no-store" } });
    const { handle, item } = opened;
    return new Response(Readable.toWeb(handle.createReadStream({ signal: request.signal })) as ReadableStream, { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": contentDisposition(item.fileName), "Content-Length": String(item.fileSize), "Cache-Control": "no-store" } });
  } catch { return Response.json({ error: { code: "FILE_NOT_FOUND", message: "The library file was not found." } }, { status: 404, headers: { "Cache-Control": "no-store" } }); }
}
