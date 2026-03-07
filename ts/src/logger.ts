// Symphony TypeScript - Structured Logging (Section 13)

export type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  issueId?: string;
  issueIdentifier?: string;
  sessionId?: string;
  [key: string]: unknown;
}

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let minLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  minLevel = level;
}

function formatContext(ctx: LogContext): string {
  return Object.entries(ctx)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
}

function log(level: LogLevel, message: string, context: LogContext = {}): void {
  if (LEVEL_ORDER[level] < LEVEL_ORDER[minLevel]) return;

  const ts = new Date().toISOString();
  const ctxStr = formatContext(context);
  const line = ctxStr
    ? `${ts} [${level.toUpperCase()}] ${message} ${ctxStr}`
    : `${ts} [${level.toUpperCase()}] ${message}`;

  if (level === "error") {
    console.error(line);
  } else if (level === "warn") {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug: (msg: string, ctx?: LogContext) => log("debug", msg, ctx),
  info: (msg: string, ctx?: LogContext) => log("info", msg, ctx),
  warn: (msg: string, ctx?: LogContext) => log("warn", msg, ctx),
  error: (msg: string, ctx?: LogContext) => log("error", msg, ctx),
};
