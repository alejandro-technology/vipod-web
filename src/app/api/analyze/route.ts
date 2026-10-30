import { analyzeVideo } from "@/lib/server/analyze";
import { errorResponse, parseJson } from "@/lib/server/errors";
import { assertTrustedOrigin } from "@/lib/server/origin";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function POST(request: Request): Promise<Response> {
  try {
    assertTrustedOrigin(request);
    const body = z.object({ url: z.string().max(2048) }).strict().safeParse(await parseJson(request));
    if (!body.success) return Response.json({ error: { code: "INVALID_REQUEST", message: "Provide a valid video URL." } }, { status: 400 });
    return Response.json(await analyzeVideo(body.data.url, { signal: request.signal }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
