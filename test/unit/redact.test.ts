import { test } from "node:test";
import assert from "node:assert/strict";

import { isEnvMode, redactEnv, redactOutput } from "../../runtime/redact.ts";

const SAMPLE = [
  "PATH=/usr/bin:/bin",
  "HOME=/Users/someone",
  "AWS_SECRET_ACCESS_KEY=leakme-canary",
  "OPENAI_API_KEY=sk-1234567890",
  "GITHUB_TOKEN=ghp_secret",
  "DB_PASSWORD=hunter2",
  "MYKEY=plain",
  "LANG=en_US.UTF-8",
].join("\n");

test("redacted mode masks credential-shaped names and keeps the rest", () => {
  const { text, masked } = redactEnv(SAMPLE, "redacted");
  assert.ok(!text.includes("leakme-canary"));
  assert.ok(!text.includes("sk-1234567890"));
  assert.ok(!text.includes("ghp_secret"));
  assert.ok(!text.includes("hunter2"));
  assert.ok(!text.includes("plain"));
  assert.ok(text.includes("AWS_SECRET_ACCESS_KEY=[redacted]"));
  assert.ok(text.includes("PATH=/usr/bin:/bin"), "PATH survives redaction");
  assert.ok(text.includes("LANG=en_US.UTF-8"));
  assert.deepEqual(masked.sort(), [
    "AWS_SECRET_ACCESS_KEY",
    "DB_PASSWORD",
    "GITHUB_TOKEN",
    "MYKEY",
    "OPENAI_API_KEY",
  ]);
});

test("full mode passes the environment through untouched", () => {
  const { text, masked } = redactEnv(SAMPLE, "full");
  assert.equal(text, SAMPLE);
  assert.deepEqual(masked, []);
});

test("none mode sends no environment at all", () => {
  assert.deepEqual(redactEnv(SAMPLE, "none"), { text: "", masked: [] });
});

test("lines without a value are left alone", () => {
  const { text } = redactEnv("EMPTY=\nNOEQUALS\nTOKEN=x", "redacted");
  assert.equal(text, "EMPTY=\nNOEQUALS\nTOKEN=[redacted]");
});

test("isEnvMode accepts only the three documented modes", () => {
  assert.ok(isEnvMode("redacted") && isEnvMode("full") && isEnvMode("none"));
  assert.ok(!isEnvMode("REDACTED") && !isEnvMode("yes") && !isEnvMode(""));
});

test("command output redaction masks common secret forms", () => {
  const input = [
    "request failed",
    "OPENAI_API_KEY=sk-this-must-not-leak",
    "Authorization: Bearer abcdefghijklmnop",
    "github token ghp_abcdefghijklmnopqrst",
  ].join("\n");
  const { text, masked } = redactOutput(input, "redacted");
  assert.ok(text.includes("request failed"));
  assert.ok(!text.includes("this-must-not-leak"));
  assert.ok(!text.includes("abcdefghijklmnop"));
  assert.ok(masked.length >= 2);
});

test("command output can be omitted or sent in full explicitly", () => {
  assert.equal(redactOutput("secret-ish output", "none").text, "");
  assert.equal(redactOutput("secret-ish output", "full").text, "secret-ish output");
});
