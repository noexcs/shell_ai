import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ContextError,
  LIMITS,
  buildContext,
  splitNulFields,
  truncateUtf8,
} from "../../runtime/context.ts";

const field = (parts: string[]): string => parts.join("\0") + "\0";

const baseFields = (over: Record<number, string> = {}): string[] => {
  const fields = [
    "1",
    "zsh",
    "/tmp/project",
    "dockre ps",
    "dockre ps",
    "127",
    "command_not_found",
    "",
    "PATH=/usr/bin",
    "/tmp/session/pending",
    "Darwin 27.0.0 arm64",
  ];
  for (const [index, value] of Object.entries(over)) fields[Number(index)] = value;
  return fields;
};

test("splitNulFields tolerates the trailing separator and keeps raw content", () => {
  const raw = field(["1", "zsh", "line\nwith\nnewlines", 'quote " and \\ backslash']);
  const fields = splitNulFields(raw);
  assert.deepEqual(fields, ["1", "zsh", "line\nwith\nnewlines", 'quote " and \\ backslash']);
});

test("splitNulFields keeps empty fields", () => {
  assert.deepEqual(splitNulFields(field(["a", "", "c"])), ["a", "", "c"]);
  assert.deepEqual(splitNulFields(""), []);
});

test("truncateUtf8 honours the byte budget and never emits U+FFFD", () => {
  const wide = "语".repeat(100); // 3 bytes each
  const cut = truncateUtf8(wide, 10);
  assert.equal(new TextEncoder().encode(cut).length, 9);
  assert.equal(cut, "语".repeat(3));
  assert.ok(!cut.includes("\uFFFD"));
  assert.equal(truncateUtf8("abc", 10), "abc");
  assert.equal(truncateUtf8(wide, 0), "");
});

test("buildContext maps every field", () => {
  const ctx = buildContext(baseFields());
  assert.equal(ctx.version, "1");
  assert.equal(ctx.shell, "zsh");
  assert.equal(ctx.cwd, "/tmp/project");
  assert.equal(ctx.buffer, "dockre ps");
  assert.equal(ctx.lastCommand, "dockre ps");
  assert.equal(ctx.exitCode, "127");
  assert.equal(ctx.trigger, "command_not_found");
  assert.deepEqual(ctx.history, []);
  assert.equal(ctx.env, "PATH=/usr/bin");
  assert.equal(ctx.commandOut, "/tmp/session/pending");
  assert.equal(ctx.platform, "Darwin 27.0.0 arm64");
});

test("buildContext keeps only the most recent history lines", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `cmd-${i}`);
  const ctx = buildContext(baseFields({ 7: lines.join("\n") + "\n" }));
  assert.equal(ctx.history.length, LIMITS.historyLines);
  assert.equal(ctx.history.at(-1), "cmd-99");
  assert.equal(ctx.history.at(0), `cmd-${100 - LIMITS.historyLines}`);
});

test("buildContext truncates env to the byte budget", () => {
  const ctx = buildContext(baseFields({ 8: "A".repeat(LIMITS.envBytes + 500) }));
  assert.equal(new TextEncoder().encode(ctx.env).length, LIMITS.envBytes);
});

test("buildContext rejects malformed payloads", () => {
  assert.throws(() => buildContext(["1", "zsh"]), ContextError);
  assert.throws(() => buildContext(baseFields({ 6: "boom" })), ContextError);
  assert.throws(() => buildContext(baseFields({ 5: "not-a-number" })), ContextError);
  assert.doesNotThrow(() => buildContext(baseFields({ 5: "" })));
});
