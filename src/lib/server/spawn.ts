/**
 * Safe, typed wrapper around the standalone yt-dlp binary.
 *
 * WHY this module exists: the ytdlp source (YtDlpSource.ts) needs to shell out
 * to `bin/yt-dlp.exe` to search YouTube and resolve audio stream URLs. Child
 * process handling is the classic injection / hang / memory-blowup footgun, so
 * every involvement with the binary is funneled through this one module:
 *
 *   1) INJECTION-SAFE: we use Node's `child_process.execFile` with an args
 *      ARRAY — no shell, no string interpolation, no `--` parsing by a shell.
 *      An uncontrolled string can only ever be one argv element, never a flag
 *      or a second command.
 *   2) BOUNDED: a timeout kills a hung extraction, and maxBuffer caps how much
 *      stdout/stderr we will ever hold in memory (yt-dlp can be chatty).
 *   3) NORMALIZED: callers never see a raw child-process throw (ENOENT, E2BIG,
 *      kill). We always resolve with a stable `SpawnResult` shape
 *      `{ stdout, stderr, code, timedOut }`; a failed spawn resolves with a
 *      negative/absent exit code rather than throwing.
 *
 * Cross-platform note: the binary lives at `bin/yt-dlp.exe` on Windows but as
 * `bin/yt-dlp` on POSIX, so we pick the right filename per platform.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

/** Normalized outcome of one yt-dlp invocation. Callers must treat a `timedOut`
 *  or empty/absent `code` as a failure even when `stdout` is non-empty. */
export interface SpawnResult {
  stdout: string;
  stderr: string;
  /** Process exit code; null when the process could not be spawned (e.g. the
   *  binary is missing) or was killed / emitted no code. */
  code: number | null;
  /** True when the run was aborted by our own timeout (NOT a yt-dlp exit). */
  timedOut: boolean;
}

/** Options controlling one invocation. All have safe defaults. */
export interface RunYtDlpOptions {
  /** Hard wall-clock cap for one run. Default 60_000ms (extraction). */
  timeoutMs?: number;
  /** Extra bytes of combined stdout+stderr we will buffer before an error.
   *  Defaults give `--dump-single-json` enough headroom for large payloads. */
  maxBufferBytes?: number;
  /** Arbitrary argv elements passed verbatim to yt-dlp (injection-safe). */
  args?: string[];
}

const DEFAULT_TIMEOUT_MS = 60_000;
const FLOOR_BUFFER = 8 * 1024 * 1024; // 8 MiB floor: dump-single-json is large.

/**
 * Resolves the yt-dlp executable path, in priority order:
 *   1) process.env.YTDLP_PATH if set (operator override for packaged deploys),
 *   2) `<cwd>/bin/yt-dlp[.exe]` — the repo-committed standalone binary,
 *   3) `yt-dlp` bare name, resolved later from the OS PATH.
 *
 * WHY cwd-anchored: Next dev/server and the standalone verify script both run
 * from the project root, so `bin/yt-dlp.exe` is reliably `<cwd>/bin/`. Falling
 * back to PATH keeps the code working in environments that pre-install yt-dlp.
 */
export function resolveYtDlpBinary(): string {
  if (process.env.YTDLP_PATH && process.env.YTDLP_PATH.trim().length > 0) {
    return process.env.YTDLP_PATH;
  }
  const exeName = process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
  const repoBin = path.resolve(process.cwd(), "bin", exeName);
  // Guard existence in try/catch so a permission error on the stat never
  // crashes resolution — it should just fall through to the PATH check.
  try {
    if (fs.existsSync(repoBin)) return repoBin;
  } catch {
    // fall through to PATH
  }
  return "yt-dlp";
}

/**
 * Normalizes the exit code out of an execFile error. execFile reports a
 * non-zero process exit as an Error whose `code` is the numeric exit code,
 * and a missing binary (ENOENT) as an Error with a string code. Everything
 * else (kill, signal) surfaces as null — a failed run, not a real exit.
 */
function normalizeExitCode(err: NodeJS.ErrnoException): number | null {
  const raw = (err as { code?: unknown }).code;
  // Numeric => a genuine process exit code (e.g. yt-dlp returned 1).
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  // string codes (ENOENT, E2BIG, killed) are NOT valid exit codes → null.
  return null;
}

/**
 * Runs one yt-dlp invocation and awaits its completion.
 *
 * Never throws for child-process failures: a missing binary, a kill, or any
 * spawn error is normalized into a resolved `SpawnResult` with `code: null`.
 */
export async function runYtDlp(opts: RunYtDlpOptions = {}): Promise<SpawnResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = Math.max(opts.maxBufferBytes ?? 0, FLOOR_BUFFER);
  const args = opts.args ?? [];

  return new Promise<SpawnResult>((resolve) => {
    // execFile: no shell. `args` is the argv array — each element stays one
    // token no matter how hostile its content is. No `--` needs quoting.
    const child = execFile(
      resolveYtDlpBinary(),
      args,
      {
        maxBuffer,
        windowsHide: true,
        encoding: "utf8",
      },
      (err, stdout, stderr) => {
        // execFile calls back with null err ONLY on a clean exit 0; any other
        // exit (or spawn failure) arrives as an Error — normalize, don't throw.
        if (err) {
          resolve({
            stdout,
            stderr,
            code: normalizeExitCode(err as NodeJS.ErrnoException),
            timedOut: false,
          });
          return;
        }
        resolve({ stdout, stderr, code: 0, timedOut: false });
      },
    );

    // Wall-clock timeout: if the child hasn't exited in time, kill it and
    // report `timedOut` so callers can distinguish our kill from a real exit.
    const timer = setTimeout(() => {
      child.kill();
      resolve({ stdout: "", stderr: "yt-dlp timed out", code: null, timedOut: true });
    }, timeoutMs);
    // Clear the timer once the process settles so we never fire on a done run.
    // A later resolve (from the settle callback) is a no-op — first wins.
    child.on("close", () => clearTimeout(timer));
  });
}
