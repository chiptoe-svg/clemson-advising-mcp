// Tiny structured-ish logger. Writes JSON-ish lines to stderr by default so
// they don't get mixed into the summary text on stdout. When LOG_FILE is set,
// lines go to that file with size-based rotation (LOG_FILE, LOG_FILE.1 … .N):
// launchd does not rotate StandardErrorPath, and macOS newsyslog needs root,
// so the process rotates its own log. Rotation is a rename chain done
// synchronously before the write that would cross the cap, so a line is never
// split across files and the newest line is always in LOG_FILE.
import fs from "node:fs";

type Level = "debug" | "info" | "warn" | "error";

const ORDER: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const THRESHOLD: Level = (process.env.LOG_LEVEL as Level) || "info";

interface LogConfig {
  file?: string;
  maxBytes: number;
  keep: number;
  sink: (line: string) => void;
}

function envConfig(): LogConfig {
  return {
    file: process.env.LOG_FILE || undefined,
    maxBytes:
      Number(process.env.LOG_MAX_BYTES) > 0
        ? Number(process.env.LOG_MAX_BYTES)
        : 10_485_760,
    keep: Number(process.env.LOG_KEEP) > 0 ? Number(process.env.LOG_KEEP) : 5,
    sink: (line) => process.stderr.write(line),
  };
}

let config: LogConfig = envConfig();

function rotate(file: string, keep: number): void {
  for (let i = keep - 1; i >= 1; i--) {
    const from = `${file}.${i}`;
    if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i + 1}`);
  }
  if (fs.existsSync(file)) fs.renameSync(file, `${file}.1`);
}

function writeLine(line: string): void {
  if (!config.file) {
    try {
      config.sink(line);
    } catch {
      // Nothing left to fall back to; a logger must never take the process down.
    }
    return;
  }
  try {
    let size = 0;
    try {
      size = fs.statSync(config.file).size;
    } catch {
      size = 0;
    }
    if (size + Buffer.byteLength(line) > config.maxBytes && size > 0)
      rotate(config.file, config.keep);
    fs.appendFileSync(config.file, line);
  } catch (err) {
    // Never let logging take the process down; fall back to stderr once.
    process.stderr.write(`[log] file write failed (${String(err)}): ${line}`);
  }
}

function emit(level: Level, msg: string, ctx?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[THRESHOLD]) return;
  const ts = new Date().toISOString();
  const ctxStr = ctx ? " " + JSON.stringify(ctx) : "";
  writeLine(`${ts} [${level}] ${msg}${ctxStr}\n`);
}

export const log = {
  debug: (msg: string, ctx?: Record<string, unknown>) =>
    emit("debug", msg, ctx),
  info: (msg: string, ctx?: Record<string, unknown>) => emit("info", msg, ctx),
  warn: (msg: string, ctx?: Record<string, unknown>) => emit("warn", msg, ctx),
  error: (msg: string, ctx?: Record<string, unknown>) =>
    emit("error", msg, ctx),
};

/** Test seam: override file/limits/sink without touching the environment. */
export function __configureLogForTest(opts: Partial<LogConfig>): void {
  config = { ...envConfig(), ...opts };
}

/** Test seam: restore the environment-derived configuration. */
export function __resetLogForTest(): void {
  config = envConfig();
}
