import { NextResponse } from "next/server";
import { getMetadataRelease, metadataErrorResponse } from "@/lib/server/musicbrainz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const release = await getMetadataRelease(id);
    return NextResponse.json(release, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const result = metadataErrorResponse(error);
    return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  }
}
