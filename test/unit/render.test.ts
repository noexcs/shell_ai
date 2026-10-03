import { test } from "node:test";
import assert from "node:assert/strict";

import { createRenderer } from "../../runtime/render.ts";

// Colour depends on the ambient environment; pin it so isTTY alone decides.
process.env.TERM = "xterm-256color";
delete process.env.NO_COLOR;
delete process.env.AI_SHELL_NO_COLOR;

function capture(isTTY: boolean) {
  const chunks: string[] = [];
  const stream = {
    isTTY,
    write: (chunk: string) => {
      chunks.push(chunk);
      return true;
    },
  } as unknown as NodeJS.WriteStream;
  return { renderer: createRenderer(stream), output: () => chunks.join("") };
}

test("repeated identical status text is written once", () => {
  const { renderer, output } = capture(true);
  for (let i = 0; i < 50; i++) renderer.status("✦ AI 正在分析…");
  assert.equal(output().split("正在分析").length - 1, 1);
});

test("status is cleared before the panel opens", () => {
  const { renderer, output } = capture(true);
  renderer.status("✦ AI 正在分析…");
  renderer.text("解释一下");
  const text = output();
  assert.equal(text.split("— shell 助手").length - 1, 1, "panel header printed once");
  assert.ok(text.includes("\r\x1b[K"), "status line is erased, not appended to");
  assert.ok(text.endsWith("解释一下"), "streamed text lands after the header");
});

test("suggestion renders the command and its explanation", () => {
  const { renderer, output } = capture(false);
  renderer.suggestion("docker ps -a", "查看所有容器");
  const text = output();
  assert.ok(text.includes("docker ps -a"));
  assert.ok(text.includes("查看所有容器"));
});

test("multi-line suggestions keep every line", () => {
  const { renderer, output } = capture(false);
  renderer.suggestion("line one\nline two", "");
  assert.ok(output().includes("line one"));
  assert.ok(output().includes("line two"));
});

test("blank lines inside the panel keep the bar column continuous", () => {
  const { renderer, output } = capture(false);
  renderer.text("第一段\n\n第二段\n");
  renderer.suggestion("docker ps", "", "");
  renderer.end();
  assert.deepEqual(output().split("\n"), [
    "",
    "✦ AI — shell 助手",
    "│ 第一段",
    "│",
    "│ 第二段",
    "│ → docker ps",
    "",
    "",
  ]);
});

test("the gap that ends the panel stays bare", () => {
  const { renderer, output } = capture(false);
  renderer.suggestion("docker ps", "", "model · 1.0s");
  renderer.end();
  assert.ok(output().endsWith("1.0s\n\n"), "panel ends with one bare blank line");
});

test("explanation is dropped when the model already wrote prose", () => {
  const { renderer, output } = capture(false);
  renderer.text("这个命令失败是因为 docker 的参数写法不对。");
  renderer.suggestion("docker ps -a", "使用 -a 查看所有容器");
  const text = output();
  assert.ok(text.includes("docker ps -a"));
  assert.ok(!text.includes("使用 -a 查看所有容器"), "no second explanation under the command");
});
