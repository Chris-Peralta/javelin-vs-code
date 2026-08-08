import * as vscode from "vscode";

const channel = vscode.window.createOutputChannel("Javelin");

const pid = process.pid;

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export const LOG_LEVELS: readonly LogLevel[] = ["DEBUG", "INFO", "WARN", "ERROR"];

const LEVEL_SEVERITY: Record<LogLevel, number> = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

let currentLevel: LogLevel = "WARN";

/** Sets the minimum level that gets written to the output channel; calls below it are dropped. */
export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function stringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: LogLevel, message: string, details: unknown[]): void {
  if (LEVEL_SEVERITY[level] < LEVEL_SEVERITY[currentLevel]) return;
  const suffix = details.length ? " " + details.map(stringify).join(" ") : "";
  channel.appendLine(`[${new Date().toISOString()}] [pid ${pid}] [${level}] ${message}${suffix}`);
}

/** Logs raw Javelin protocol/device detail (plus any extra detail) to the "Javelin" output channel. */
export function logDebug(message: string, ...details: unknown[]): void {
  write("DEBUG", message, details);
}

/** Logs diagnostic info (plus any extra detail) to the "Javelin" output channel. */
export function logInfo(message: string, ...details: unknown[]): void {
  write("INFO", message, details);
}

/** Logs a recoverable problem (plus any extra detail) to the "Javelin" output channel. */
export function logWarn(message: string, ...details: unknown[]): void {
  write("WARN", message, details);
}

/** Logs an error (plus any extra detail) to the "Javelin" output channel. */
export function logError(message: string, ...details: unknown[]): void {
  write("ERROR", message, details);
}
