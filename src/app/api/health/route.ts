import { runProcess } from "@/lib/server/process";
import { serverConfig } from "@/lib/server/config";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
async function tool(name: string, command: string, args: string[]) {
  try {
    const result = await runProcess(command, args, { timeoutMs: 5000, maxOutput: 2000 });
    const version = (result.stdout || result.stderr).split(/\r?\n/)[0]?.slice(0, 200) || null;
    return { name, available: result.code === 0, version };
  } catch { return { name, available: false, version: null }; }
}
export async function GET(): Promise<Response> {
  const tools = await Promise.all([
    tool("yt-dlp", serverConfig.ytDlpPath, ["--version"]),
    tool("ffmpeg", serverConfig.ffmpegPath, ["-version"]),
    tool("ffprobe", serverConfig.ffprobePath, ["-version"]),
  ]);
  return Response.json({ ready: tools.every((entry) => entry.available), tools }, { headers: { "Cache-Control": "no-store" } });
}
