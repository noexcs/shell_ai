import { test } from "node:test";
import assert from "node:assert/strict";

import { buildContext } from "../../runtime/context.ts";
import { buildUserPrompt } from "../../runtime/prompt.ts";

function failedContext() {
  return buildContext([
    "1",
    "zsh",
    "/workspace",
    "docker ps --alll",
    "docker ps --alll",
    "125",
    "non_zero_exit",
    "docker ps",
    "PATH=/usr/bin",
    "/tmp/unstuck/pending",
    "Darwin 27.0.0 arm64",
  ]);
}

test("prompt includes matched iZSH output as primary evidence", () => {
  const context = failedContext();
  context.capture = {
    source: "izsh",
    id: "20261007T135718Z-a1b2c3:8",
    durationMs: 41,
    stdout: { text: "", bytes: 0, truncated: false },
    stderr: { text: "unknown flag: --alll", bytes: 21, truncated: false },
  };

  const prompt = buildUserPrompt(context);
  assert.match(prompt, /iZSH 命令 ID/);
  assert.match(prompt, /20261007T135718Z-a1b2c3:8/);
  assert.match(prompt, /执行耗时\n41ms/);
  assert.match(prompt, /stderr（最多保留末尾 32 KiB）\nunknown flag: --alll/);
});

test("prompt explicitly marks a missing capture", () => {
  const prompt = buildUserPrompt(failedContext());
  assert.match(prompt, /没有可匹配的 iZSH 输出/);
  assert.doesNotMatch(prompt, /stdout（最多保留/);
});
