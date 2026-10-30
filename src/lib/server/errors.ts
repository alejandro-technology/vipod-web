export class ApiFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export function errorResponse(error: unknown): Response {
  const failure = error instanceof ApiFailure
    ? error
    : new ApiFailure(500, "INTERNAL_ERROR", "An unexpected server error occurred.");
  return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status });
}

export async function parseJson(request: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new ApiFailure(413, "BODY_TOO_LARGE", "The request body is too large.");
  if (!request.body) throw new ApiFailure(400, "INVALID_JSON", "The request body must be valid JSON.");
  const reader = request.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); throw new ApiFailure(413, "BODY_TOO_LARGE", "The request body is too large."); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const text = Buffer.concat(chunks).toString("utf8");
  try { return JSON.parse(text); } catch { throw new ApiFailure(400, "INVALID_JSON", "The request body must be valid JSON."); }
}
