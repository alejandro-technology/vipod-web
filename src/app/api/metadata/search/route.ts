import { NextResponse } from "next/server";
import { metadataErrorResponse, searchMetadata } from "@/lib/server/musicbrainz";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q");
    const durationParam = url.searchParams.get("duration");
    const targetDuration = durationParam && Number.isFinite(Number(durationParam)) ? Number(durationParam) : null;
    const results = await searchMetadata(query, { targetDuration });
    return NextResponse.json({ results }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const result = metadataErrorResponse(error);
    return NextResponse.json(result.body, { status: result.status, headers: { "Cache-Control": "no-store" } });
  }
}
