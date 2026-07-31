import * as vscode from "vscode";

const channel = vscode.window.createOutputChannel("Javelin");

const pid = process.pid;

function stringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function write(level: string, message: string, details: unknown[]): void {
  const suffix = details.length ? " " + details.map(stringify).join(" ") : "";
  channel.appendLine(`[${new Date().toISOString()}] [pid ${pid}] [${level}] ${message}${suffix}`);
}

/** Logs an error (plus any extra detail) to the "Javelin" output channel. */
export function logError(message: string, ...details: unknown[]): void {
  write("ERROR", message, details);
}

/** Logs diagnostic info (plus any extra detail) to the "Javelin" output channel. */
export function logInfo(message: string, ...details: unknown[]): void {
  write("INFO", message, details);
}
