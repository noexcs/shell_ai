/**
 * `ai-shell doctor` — the gate between "configured" and "actually works".
 *
 * A shell assistant that silently produces nothing is worse than one that says
 * what is wrong, so this checks the shell side, the config side and — the only
 * check that really matters — that the chosen model can call a tool at all.
 *
 * Spawning `zsh`/`fetch` here is fine (diagnostics); the model path still
 * spawns nothing.
 */

import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { runAgent } from "./agent.ts";
import { configPath, resolveConfig } from "./config.ts";
import { buildContext } from "./context.ts";
import type { Renderer } from "./render.ts";
import { VERSION } from "./version.ts";

const run = promisify(execFile);

export interface DoctorOptions {
  echo: (message: string) => void;
}

function silentRenderer(): Renderer {
  return { status() {}, text() {}, notice() {}, suggestion() {} };
}

function userShell(): { name: "zsh" | "bash"; rc: string } {
  const login = (process.env.SHELL ?? "").split("/").pop() ?? "";
  // bash users have no ~/.zshrc; on a bash-only box the zsh check would silently
  // report "未登记" for a plugin that is in fact installed.
  if (login === "bash") return { name: "bash", rc: join(homedir(), ".bashrc") };
  return { name: "zsh", rc: join(process.env.ZDOTDIR ?? homedir(), ".zshrc") };
}

async function shellReport(): Promise<string[]> {
  const shell = userShell();
  const lines: string[] = [];
  const installed = existsSync(shell.rc) && readFileSync(shell.rc, "utf8").includes("# >>> ai-shell >>>");
  lines.push(`${shell.rc.replace(homedir(), "~")} 加载行：${installed ? "已登记" : "未登记（运行 ai-shell install --write）"}`);

  try {
    const { stdout } = await run(shell.name, ["-ic", "ai-shell-doctor"], { timeout: 15000 });
    for (const line of stdout.split("\n")) if (line.trim() !== "") lines.push(line.trim());
  } catch {
    lines.push(`shell 侧自检：跳过（${shell.name} 里未加载插件，或 ai-shell-doctor 不存在）`);
  }
  return lines;
}

async function probeToolCalling(baseUrl: string, apiKey: string, model: string, timeoutMs: number) {
  const context = buildContext([
    "1",
    "zsh",
    process.cwd(),
    "为什么刚才的命令失败了？",
    "ls -Z",
    "2",
    "non_zero_exit",
    "",
    "PATH=/usr/bin",
    "/tmp/ai-shell-doctor-pending",
    "doctor",
  ]);
  const started = performance.now();
  const suggestion = await runAgent(context, silentRenderer(), { baseUrl, apiKey, model, timeoutMs });
  return { ok: suggestion !== null, ms: performance.now() - started };
}

export async function runDoctor(options: DoctorOptions): Promise<number> {
  const echo = options.echo;
  let problems = 0;

  echo(`ai-shell ${VERSION}`);
  echo("");
  echo("== shell 侧 ==");
  for (const line of await shellReport()) echo(`  ${line}`);

  echo("");
  echo("== 配置 ==");
  const cfg = await resolveConfig();
  if (!cfg.configured) {
    echo("  ✗ 未配置。运行 ai-shell setup（或写 " + configPath() + "）");
    return 1;
  }
  echo(`  provider : ${cfg.provider}`);
  echo(`  base_url : ${cfg.baseUrl}`);
  echo(`  model    : ${cfg.model}`);
  echo(`  api key  : ${cfg.apiKey === "" ? "（无，本地端点通常不需要）" : `已提供（来源 ${cfg.apiKeySource}）`}`);
  echo(`  env_mode : ${cfg.envMode}${cfg.envMode === "full" ? "  ⚠️ 完整 env（含密钥）会发给端点" : ""}`);
  echo(`  timeout  : ${cfg.timeoutMs}ms`);

  echo("");
  echo("== 端点 ==");
  try {
    const response = await fetch(`${cfg.baseUrl.replace(/\/$/, "")}/models`, {
      headers: cfg.apiKey === "" ? {} : { authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (response.ok) {
      const body = (await response.json()) as { data?: Array<{ id?: string }> };
      const ids = (body.data ?? []).map((item) => item.id).filter((id): id is string => typeof id === "string");
      echo(`  ✓ /models 可达（${ids.length} 个模型${ids.includes(cfg.model) ? `，包含 ${cfg.model}` : ids.length > 0 ? `，未见 ${cfg.model}` : ""}）`);
      if (ids.length > 0 && !ids.includes(cfg.model)) problems += 1;
    } else {
      echo(`  ⚠️ /models 返回 ${response.status}`);
    }
  } catch (error) {
    echo(`  ✗ 不可达：${error instanceof Error ? error.message : String(error)}`);
    problems += 1;
  }

  echo("");
  echo("== 工具调用探针（唯一真正重要的检查）==");
  try {
    const result = await probeToolCalling(cfg.baseUrl, cfg.apiKey, cfg.model, cfg.timeoutMs);
    if (result.ok) {
      echo(`  ✓ ${cfg.model} 返回了 suggest_command 调用（${(result.ms / 1000).toFixed(1)}s）`);
    } else {
      echo(`  ✗ ${cfg.model} 没有调用工具（${(result.ms / 1000).toFixed(1)}s）——本产品的交互依赖工具调用`);
      problems += 1;
    }
  } catch (error) {
    echo(`  ✗ 调用失败：${error instanceof Error ? error.message : String(error)}`);
    problems += 1;
  }

  echo("");
  echo(problems === 0 ? "一切正常。" : `发现 ${problems} 个问题。`);
  return problems === 0 ? 0 : 1;
}
