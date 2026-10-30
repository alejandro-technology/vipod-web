import { retainLibraryItem } from "@/lib/server/jobs";
import { errorResponse } from "@/lib/server/errors";
import { assertTrustedOrigin } from "@/lib/server/origin";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function POST(request: Request, { params }: Context): Promise<Response> {
  try { assertTrustedOrigin(request); const { id } = await params; return Response.json(await retainLibraryItem(id), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
