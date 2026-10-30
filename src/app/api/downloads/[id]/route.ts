import { cancelJob, getJob } from "@/lib/server/jobs";
import { errorResponse } from "@/lib/server/errors";
import { assertTrustedOrigin } from "@/lib/server/origin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Context = { params: Promise<{ id: string }> };
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  try {
    const { id } = await params; const job = await getJob(id);
    return job ? Response.json(job, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: { code: "JOB_NOT_FOUND", message: "The download job was not found." } }, { status: 404 });
  } catch (error) { return errorResponse(error); }
}
export async function DELETE(request: Request, { params }: Context): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const { id } = await params; const job = await cancelJob(id);
    return job ? Response.json(job, { headers: { "Cache-Control": "no-store" } }) : Response.json({ error: { code: "JOB_NOT_FOUND", message: "The download job was not found." } }, { status: 404 });
  } catch (error) { return errorResponse(error); }
}
