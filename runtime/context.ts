/**
 * Shell context transport.
 *
 * The zsh plugin writes context as NUL-separated raw fields on stdin
 * (`print -rn -- "$value"$'\0'`), so arbitrary content (newlines, quotes,
 * control chars) needs no escaping on the shell side. This module is the
 * only place that knows the field order.
 */

import type { CommandCapture } from "./capture.ts";

export const CONTEXT_VERSION = "1";

export const TRIGGERS = ["nl", "command_not_found", "non_zero_exit"] as const;
export type Trigger = (typeof TRIGGERS)[number];

export const FIELD_COUNT = 11;

/** Index of the env field in the NUL payload (0-based). */
export const ENV_FIELD_INDEX = 8;

export const LIMITS = {
  /** env is truncated to this many bytes before it reaches the prompt. */
  envBytes: 2048,
  /** history lines kept (the shell already sends fewer). */
  historyLines: 40,
} as const;

export interface ShellContext {
  version: string;
  shell: string;
  cwd: string;
  buffer: string;
  lastCommand: string;
  exitCode: string;
  trigger: Trigger;
  history: string[];
  env: string;
  commandOut: string;
  /** `uname -srm` — keeps suggested commands to tools the platform actually has. */
  platform: string;
  /** Completed command data supplied by iZSH, when available and matched. */
  capture: CommandCapture | null;
}

export class ContextError extends Error {}

/** Split the NUL-separated stdin payload, tolerating one trailing separator. */
export function splitNulFields(raw: string): string[] {
  const fields = raw.split("\0");
  if (fields.length > 0 && fields[fields.length - 1] === "") fields.pop();
  return fields;
}

/** Truncate to a UTF-8 byte budget without splitting (or replacing) a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes));
  return head.endsWith("\uFFFD") ? head.slice(0, -1) : head;
}

function isTrigger(value: string): value is Trigger {
  return (TRIGGERS as readonly string[]).includes(value);
}

export function buildContext(fields: string[]): ShellContext {
  if (fields.length !== FIELD_COUNT) {
    throw new ContextError(`expected ${FIELD_COUNT} NUL-separated fields, got ${fields.length}`);
  }
  const [
    version,
    shell,
    cwd,
    buffer,
    lastCommand,
    exitCode,
    trigger,
    historyRaw,
    envRaw,
    commandOut,
    platform,
  ] = fields;

  if (!isTrigger(trigger)) {
    throw new ContextError(`unknown trigger: ${JSON.stringify(trigger)}`);
  }
  if (exitCode !== "" && !/^-?\d+$/.test(exitCode)) {
    throw new ContextError(`exit code is not an integer: ${JSON.stringify(exitCode)}`);
  }

  const history = historyRaw
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => line.trim() !== "")
    .slice(-LIMITS.historyLines);

  return {
    version,
    shell,
    cwd,
    buffer,
    lastCommand,
    exitCode,
    trigger,
    history,
    env: truncateUtf8(envRaw, LIMITS.envBytes),
    commandOut,
    platform,
    capture: null,
  };
}
