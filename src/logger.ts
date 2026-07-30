import * as vscode from "vscode";

const channel = vscode.window.createOutputChannel("Javelin");

function stringify(value: unknown): string {
  if (value instanceof Error) return value.message;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Logs an error (plus any extra detail) to the "Javelin" output channel. */
export function logError(message: string, ...details: unknown[]): void {
  const suffix = details.length ? " " + details.map(stringify).join(" ") : "";
  channel.appendLine(`[${new Date().toISOString()}] ${message}${suffix}`);
}
