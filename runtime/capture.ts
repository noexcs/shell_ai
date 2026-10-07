/**
 * Reads the completed command that iZSH recorded for the current shell.
 *
 * iZSH is the producer and Unstuck is the consumer: the shell plugin does not
 * parse NDJSON or copy command output through shell variables. This module
 * validates the session boundary, matches the command, and reads only a bounded
 * tail of each output stream.
 */

import { open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";

import type { ShellContext } from "./context.ts";

export const CAPTURE_LIMITS = {
  eventsBytes: 256 * 1024,
  outputBytes: 32 * 1024,
} as const;

export interface CapturedStream {
  text: string;
  bytes: number;
  truncated: boolean;
}

export interface CommandCapture {
  source: "izsh";
  id: string;
  durationMs: number;
  stdout: CapturedStream;
  stderr: CapturedStream;
}

interface CaptureEnvironment {
  IZSH_SESSION_ID?: string;
  IZSH_SESSION_DIR?: string;
  IZSH_EVENTS_FILE?: string;
}

interface CommandStartEvent {
  type: "command_start";
  session_id: string;
  id: string;
  command: string;
  stdout_path: string;
  stderr_path: string;
}

interface CommandEndEvent {
  type: "command_end";
  session_id: string;
  id: string;
  exit: number;
  duration_ms: number;
  stdout_path: string;
  stderr_path: string;
}

async function readTail(path: string, maxBytes: number): Promise<{ data: Buffer; bytes: number; truncated: boolean }> {
  const file = await open(path, "r");
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error("capture path is not a regular file");
    const start = Math.max(0, stat.size - maxBytes);
    const data = Buffer.alloc(stat.size - start);
    if (data.length > 0) await file.read(data, 0, data.length, start);
    return { data, bytes: stat.size, truncated: start > 0 };
  } finally {
    await file.close();
  }
}

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

async function checkedPath(path: string, parent: string): Promise<string> {
  const actual = await realpath(path);
  if (!isInside(actual, parent)) throw new Error("capture path escaped the iZSH session");
  return actual;
}

function parseRecord(line: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(line);
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isStart(value: Record<string, unknown>): value is unknown & CommandStartEvent {
  return (
    value.type === "command_start" &&
    typeof value.session_id === "string" &&
    typeof value.id === "string" &&
    typeof value.command === "string" &&
    typeof value.stdout_path === "string" &&
    typeof value.stderr_path === "string"
  );
}

function isEnd(value: Record<string, unknown>): value is unknown & CommandEndEvent {
  return (
    value.type === "command_end" &&
    typeof value.session_id === "string" &&
    typeof value.id === "string" &&
    typeof value.exit === "number" &&
    typeof value.duration_ms === "number" &&
    typeof value.stdout_path === "string" &&
    typeof value.stderr_path === "string"
  );
}

function cleanText(data: Buffer, bytes: number, truncated: boolean): string {
  if (data.includes(0)) return `[binary output omitted: ${bytes} bytes]`;
  const text = data
    .toString("utf8")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  return truncated ? `[earlier output omitted]\n${text}` : text;
}

async function readStream(path: string, commandsDir: string): Promise<CapturedStream> {
  const actual = await checkedPath(path, commandsDir);
  const tail = await readTail(actual, CAPTURE_LIMITS.outputBytes);
  return {
    text: cleanText(tail.data, tail.bytes, tail.truncated),
    bytes: tail.bytes,
    truncated: tail.truncated,
  };
}

/** Returns null whenever the current command cannot be proven to match. */
export async function readIzshCapture(
  context: ShellContext,
  env: CaptureEnvironment = process.env,
): Promise<CommandCapture | null> {
  const sessionId = env.IZSH_SESSION_ID;
  const sessionPath = env.IZSH_SESSION_DIR;
  const eventsPath = env.IZSH_EVENTS_FILE;
  if (!sessionId || !sessionPath || !eventsPath || context.trigger === "nl") return null;

  try {
    const sessionDir = await realpath(sessionPath);
    if (basename(sessionDir) !== sessionId) return null;
    const commandsDir = await realpath(resolve(sessionDir, "commands"));
    if (!isInside(commandsDir, sessionDir)) return null;
    const eventsFile = await checkedPath(eventsPath, sessionDir);
    const tail = await readTail(eventsFile, CAPTURE_LIMITS.eventsBytes);
    let text = tail.data.toString("utf8");
    if (tail.truncated) {
      const firstNewline = text.indexOf("\n");
      text = firstNewline === -1 ? "" : text.slice(firstNewline + 1);
    }
    const records = text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map(parseRecord)
      .filter((record): record is Record<string, unknown> => record !== null);

    const wantedExit = Number(context.exitCode);
    for (let index = records.length - 1; index >= 0; index -= 1) {
      const end = records[index];
      if (!isEnd(end) || end.session_id !== sessionId || end.exit !== wantedExit) continue;
      const start = records
        .slice(0, index)
        .reverse()
        .find((record) => isStart(record) && record.session_id === sessionId && record.id === end.id);
      if (!start || !isStart(start)) continue;
      if (start.command.trim() !== context.lastCommand.trim()) continue;
      if (start.stdout_path !== end.stdout_path || start.stderr_path !== end.stderr_path) continue;

      const [stdout, stderr] = await Promise.all([
        readStream(end.stdout_path, commandsDir),
        readStream(end.stderr_path, commandsDir),
      ]);
      return {
        source: "izsh",
        id: end.id,
        durationMs: end.duration_ms,
        stdout,
        stderr,
      };
    }
  } catch {
    // Capture is optional. A missing, malformed, or unsafe sidecar must never
    // break the command path or prevent the fallback from running.
  }
  return null;
}
