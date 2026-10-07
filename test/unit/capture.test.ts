import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CAPTURE_LIMITS, readIzshCapture } from "../../runtime/capture.ts";
import { buildContext } from "../../runtime/context.ts";

function context(command = "failing-command", exitCode = "7") {
  return buildContext([
    "1",
    "zsh",
    "/tmp/project",
    command,
    command,
    exitCode,
    "non_zero_exit",
    "",
    "PATH=/usr/bin",
    "/tmp/unstuck/pending",
    "Darwin 27.0.0 arm64",
  ]);
}

function fixture(stdout = "useful stdout", stderr = "useful stderr") {
  const root = mkdtempSync(join(tmpdir(), "unstuck-capture-"));
  const sessionId = "20261007T135718Z-a1b2c3";
  const sessionDir = join(root, sessionId);
  const commandsDir = join(sessionDir, "commands");
  const stdoutPath = join(commandsDir, "4.stdout");
  const stderrPath = join(commandsDir, "4.stderr");
  const eventsFile = join(sessionDir, "events.ndjson");
  mkdirSync(commandsDir, { recursive: true });
  writeFileSync(stdoutPath, stdout);
  writeFileSync(stderrPath, stderr);
  const start = {
    type: "command_start",
    session_id: sessionId,
    command_id: 4,
    id: `${sessionId}:4`,
    command: "failing-command",
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
  };
  const end = {
    type: "command_end",
    session_id: sessionId,
    command_id: 4,
    id: `${sessionId}:4`,
    exit: 7,
    duration_ms: 23,
    stdout_bytes: Buffer.byteLength(stdout),
    stderr_bytes: Buffer.byteLength(stderr),
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
  };
  writeFileSync(eventsFile, `${JSON.stringify(start)}\n${JSON.stringify(end)}\n`);
  return {
    root,
    sessionId,
    sessionDir,
    commandsDir,
    stdoutPath,
    stderrPath,
    eventsFile,
    env: {
      IZSH_SESSION_ID: sessionId,
      IZSH_SESSION_DIR: sessionDir,
      IZSH_EVENTS_FILE: eventsFile,
    },
  };
}

test("reads the matching completed iZSH command", async (t) => {
  const item = fixture("stdout text", "stderr text");
  t.after(() => rmSync(item.root, { recursive: true, force: true }));

  const capture = await readIzshCapture(context(), item.env);
  assert.ok(capture);
  assert.equal(capture.id, `${item.sessionId}:4`);
  assert.equal(capture.durationMs, 23);
  assert.equal(capture.stdout.text, "stdout text");
  assert.equal(capture.stderr.text, "stderr text");
  assert.equal(capture.stdout.truncated, false);
  assert.equal(capture.stderr.truncated, false);
});

test("ignores a stale command or exit-code mismatch", async (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));

  assert.equal(await readIzshCapture(context("another-command"), item.env), null);
  assert.equal(await readIzshCapture(context("failing-command", "2"), item.env), null);
});

test("rejects output paths outside the current session", async (t) => {
  const item = fixture();
  t.after(() => rmSync(item.root, { recursive: true, force: true }));
  const outside = join(item.root, "outside.txt");
  writeFileSync(outside, "must not be read");

  const lines = item.eventsFile;
  const records = readFileSync(lines, "utf8").trim().split("\n").map(JSON.parse);
  records[0].stdout_path = outside;
  records[1].stdout_path = outside;
  writeFileSync(lines, `${records.map(JSON.stringify).join("\n")}\n`);

  assert.equal(await readIzshCapture(context(), item.env), null);
});

test("keeps the useful tail of large output and marks truncation", async (t) => {
  const suffix = "THE-ERROR-AT-THE-END";
  const item = fixture("x".repeat(CAPTURE_LIMITS.outputBytes + 100) + suffix, "");
  t.after(() => rmSync(item.root, { recursive: true, force: true }));

  const capture = await readIzshCapture(context(), item.env);
  assert.ok(capture);
  assert.equal(capture.stdout.truncated, true);
  assert.match(capture.stdout.text, /^\[earlier output omitted\]\n/);
  assert.ok(capture.stdout.text.endsWith(suffix));
  assert.ok(Buffer.byteLength(capture.stdout.text) < CAPTURE_LIMITS.outputBytes + 100);
});

test("does not place binary bytes in model context", async (t) => {
  const item = fixture("text\0binary", "");
  t.after(() => rmSync(item.root, { recursive: true, force: true }));

  const capture = await readIzshCapture(context(), item.env);
  assert.ok(capture);
  assert.equal(capture.stdout.text, "[binary output omitted: 11 bytes]");
});

test("does nothing outside an iZSH session", async () => {
  assert.equal(await readIzshCapture(context(), {}), null);
});
