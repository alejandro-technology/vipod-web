import { createJob, listJobs } from "@/lib/server/jobs";
import { errorResponse, parseJson } from "@/lib/server/errors";
import { assertTrustedOrigin } from "@/lib/server/origin";
import { parseDownloadRequest } from "@/lib/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(): Promise<Response> {
  try { return Response.json({ jobs: await listJobs() }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return errorResponse(error); }
}
export async function POST(request: Request): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const job = await createJob(parseDownloadRequest(await parseJson(request)));
    return Response.json(job, { status: 202, headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
