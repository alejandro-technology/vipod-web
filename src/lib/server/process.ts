import { spawn, type ChildProcess } from "node:child_process";
import { ApiFailure } from "./errors";

export type ProcessResult = { stdout: string; stderr: string; code: number | null };
export function abortFailure(signal?: AbortSignal): Error {
  return signal?.reason instanceof ApiFailure ? signal.reason : new ApiFailure(499, "CANCELLED", "The operation was cancelled.");
}
export function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortFailure(signal);
}
export function splitCompleteLines(pending: string, chunk: string): { lines: string[]; pending: string } {
  const parts = `${pending}${chunk}`.split(/\r?\n/);
  if (parts.some((line) => line.length > 4096)) throw new ApiFailure(502, "OUTPUT_LIMIT", "The downloader produced an oversized output line.");
  return { lines: parts.slice(0, -1), pending: parts.at(-1) ?? "" };
}

function sendSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try { process.kill(process.platform === "win32" ? child.pid : -child.pid, signal); }
  catch { child.kill(signal); }
}

function killWindowsTree(child: ChildProcess): Promise<void> {
  if (!child.pid) return Promise.resolve();
  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { shell: false, stdio: "ignore" });
    const fallback = setTimeout(() => { killer.kill(); child.kill("SIGKILL"); }, 3000);
    killer.once("error", () => { child.kill("SIGKILL"); });
    killer.once("close", (code) => { clearTimeout(fallback); if (code !== 0) child.kill("SIGKILL"); resolve(); });
  });
}

export type ProcessOptions = {
  timeoutMs: number; maxOutput?: number; signal?: AbortSignal; cwd?: string;
  onStdout?: (chunk: string) => void;
};
export function runProcess(command: string, args: string[], options: ProcessOptions): Promise<ProcessResult> {
  if (options.signal?.aborted) return Promise.reject(abortFailure(options.signal));
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let failure: Error | undefined; let escalation: NodeJS.Timeout | undefined;
    let windowsTermination: Promise<void> | undefined;
    const kill = (signal: NodeJS.Signals) => {
      if (process.platform === "win32") windowsTermination ??= killWindowsTree(child);
      else sendSignal(child, signal);
    };
    const max = options.maxOutput ?? 2_000_000;
    const terminate = (error: Error) => {
      if (failure) return;
      failure = error;
      kill("SIGTERM");
      // Keep this timer referenced: callers must not finish before child exits.
      escalation = setTimeout(() => kill("SIGKILL"), 1500);
    };
    const abort = () => terminate(abortFailure(options.signal));
    const timer = setTimeout(() => terminate(new ApiFailure(504, "PROCESS_TIMEOUT", "The media operation timed out.")), options.timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout?.setEncoding("utf8"); child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (failure) return;
      if (options.onStdout) {
        try { options.onStdout(chunk); } catch (error) { terminate(error instanceof Error ? error : new Error(String(error))); }
      } else {
        if (stdout.length + chunk.length > max) terminate(new ApiFailure(502, "OUTPUT_LIMIT", "The media tool produced too much output."));
        stdout = (stdout + chunk).slice(0, max);
      }
    });
    child.stderr?.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-max); });
    child.once("error", (error) => { failure ??= new ApiFailure(503, "TOOL_UNAVAILABLE", `Could not start required tool: ${error.message}`); });
    // Even if the parent exits on SIGTERM, descendants may ignore it or close
    // their stdio. Kill the whole group rather than leaving those descendants.
    child.once("exit", () => { if (failure) kill("SIGKILL"); });
    child.once("close", (code) => {
      clearTimeout(timer); if (escalation) clearTimeout(escalation);
      options.signal?.removeEventListener("abort", abort);
      if (failure) {
        kill("SIGKILL");
        void Promise.resolve(windowsTermination).then(() => { setTimeout(() => reject(failure), 50); });
      } else resolve({ stdout, stderr, code });
    });
  });
}

export function spawnManaged(command: string, args: string[], cwd: string): ChildProcess {
  return spawn(command, args, { cwd, shell: false, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
}

export function killProcessGroup(child: ChildProcess): void {
  sendSignal(child, "SIGTERM");
  const escalation = setTimeout(() => sendSignal(child, "SIGKILL"), 1500);
  escalation.unref();
}
