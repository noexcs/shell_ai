#!/usr/bin/env node
/**
 * ai-shell CLI.
 *
 *   ask           fallback path called by the zsh plugin (NUL context on stdin)
 *   setup         interactive BYOK configuration wizard
 *   doctor        shell + config + endpoint + tool-calling checks
 *   auth          key storage (OS keychain, or the plaintext fallback)
 *   debug         print exactly what would be sent to the model
 *   install / uninstall / print-plugin
 *   version
 */

import { renameSync, writeFileSync } from "node:fs";

import { ContextError, ENV_FIELD_INDEX, buildContext, splitNulFields } from "./context.ts";
import { runAgent } from "./agent.ts";
import { resolveConfig, type ResolvedConfig } from "./config.ts";
import { runDoctor } from "./doctor.ts";
import { promptHidden } from "./hidden-input.ts";
import { detectShell, printPluginDir, runInstall, runUninstall, type ShellName } from "./install.ts";
import { buildUserPrompt } from "./prompt.ts";
import { findProvider } from "./providers.ts";
import { redactEnv } from "./redact.ts";
import { createRenderer } from "./render.ts";
import { forgetSecret, storeSecret } from "./secret.ts";
import { runSetup } from "./setup.ts";
import { VERSION } from "./version.ts";

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_NO_SUGGESTION = 2;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function takeFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

/**
 * Fold the tool's short rationale into the command as a trailing shell comment,
 * so it travels with the command into history. Returns null when that would
 * change the command's meaning — the caller then shows the rationale separately.
 */
function attachExplanation(command: string, explanation: string): string | null {
  const trimmed = command.replace(/\s+$/, "");
  const rationale = explanation.replace(/\s*\n\s*/g, " ").trim();
  if (trimmed === "" || rationale === "") return null;
  // A trailing operator/continuation would swallow the comment into the syntax.
  if (/[|&\\,(=]$/.test(trimmed)) return null;
  return `${trimmed}  # ${rationale}`;
}

function writeAtomically(path: string, contents: string): void {
  const temp = `${path}.tmp-${process.pid}`;
  writeFileSync(temp, contents, "utf8");
  renameSync(temp, path);
}

/**
 * Reads the NUL payload and applies environment redaction.
 *
 * Redaction runs on the *untruncated* env field on purpose: truncating first
 * could cut a variable name in half and hide it from the name-based filter.
 */
async function readRedactedContext(cfg: ResolvedConfig) {
  const fields = splitNulFields(await readStdin());
  let masked: string[] = [];
  if (fields.length > ENV_FIELD_INDEX) {
    const redacted = redactEnv(fields[ENV_FIELD_INDEX], cfg.envMode);
    fields[ENV_FIELD_INDEX] = redacted.text;
    masked = redacted.masked;
  }
  const ctx = buildContext(fields);
  ctx.env = ctx.env === "" ? "（未发送环境变量）" : ctx.env;
  return { ctx, masked };
}

function shellFlag(args: string[]): ShellName {
  const value = takeFlag(args, "--shell");
  if (value === "zsh" || value === "bash") return value;
  return detectShell();
}

async function ask(args: string[]): Promise<number> {
  const renderer = createRenderer(process.stdout);

  const timeoutFlag = takeFlag(args, "--timeout");
  const cfg = await resolveConfig({
    model: takeFlag(args, "--model"),
    timeoutMs: timeoutFlag === undefined ? undefined : Number(timeoutFlag),
  });

  if (!cfg.configured) {
    renderer.notice("ai-shell: 还没配置模型端点 —— 运行 `ai-shell setup`");
    return EXIT_ERROR;
  }

  // BYOK's most common first-run failure: no key anywhere. Fail fast and point
  // at the fix instead of firing a request that returns 401.
  const preset = findProvider(cfg.provider);
  if (cfg.apiKey === "" && (preset?.keyEnv.length ?? 0) > 0) {
    const hint = preset?.keyEnv[0] ?? "AI_SHELL_API_KEY";
    renderer.notice(
      `ai-shell: 没找到 ${cfg.provider} 的 API key —— 运行 \`ai-shell auth set ${cfg.provider}\`，或设置 ${hint}`,
    );
    return EXIT_ERROR;
  }

  let ctx;
  try {
    ({ ctx } = await readRedactedContext(cfg));
  } catch (error) {
    const detail = error instanceof ContextError ? error.message : String(error);
    createRenderer().notice(`ai-shell: 上下文解析失败（${detail}）`);
    return EXIT_ERROR;
  }

  const commandOut = takeFlag(args, "--command-out") ?? ctx.commandOut;
  const startedAt = performance.now();
  const latency = () => `${((performance.now() - startedAt) / 1000).toFixed(1)}s`;
  const verboseTail = () => {
    if (cfg.verbose) renderer.notice(`${cfg.model} · ${latency()}`);
  };

  try {
    const suggestion = await runAgent(ctx, renderer, {
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
      timeoutMs: cfg.timeoutMs,
    });
    if (suggestion === null) {
      renderer.notice("（没有给出命令建议）");
      verboseTail();
      renderer.end();
      return EXIT_NO_SUGGESTION;
    }
    const withComment = args.includes("--comment")
      ? attachExplanation(suggestion.command, suggestion.explanation)
      : null;
    const finalCommand = withComment ?? suggestion.command;
    renderer.suggestion(
      finalCommand,
      withComment === null ? suggestion.explanation : "",
      cfg.verbose ? `${cfg.model} · ${latency()}` : "",
    );
    renderer.end();
    writeAtomically(commandOut, finalCommand);
    return EXIT_OK;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const unreachable = /fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|timed out|timeout/i.test(detail);
    renderer.notice(`ai-shell: ${detail}${unreachable ? `（检查 ${cfg.baseUrl} 是否可达）` : ""}`);
    verboseTail();
    renderer.end();
    return EXIT_ERROR;
  }
}

/** `ai-shell debug --print-context` — show the exact prompt, no model call. */
async function debug(args: string[]): Promise<number> {
  if (!args.includes("--print-context")) {
    console.log("用法：ai-shell debug --print-context   （从 stdin 读 NUL 上下文并打印将要发送的内容）");
    return EXIT_OK;
  }
  const cfg = await resolveConfig();
  const { ctx, masked } = await readRedactedContext(cfg);
  if (cfg.envMode === "redacted" && masked.length > 0) {
    console.log(`# 已脱敏 ${masked.length} 个变量：${masked.join(", ")}`);
    console.log("# 需要完整 env 时设置 AI_SHELL_ENV_MODE=full（不推荐）\n");
  }
  console.log(buildUserPrompt(ctx));
  return EXIT_OK;
}

async function auth(args: string[]): Promise<number> {
  const [action, provider] = args;
  const target = provider ?? (await resolveConfig()).provider;
  if (target === "") {
    console.log("用法：ai-shell auth set|rm|status <provider>");
    return EXIT_ERROR;
  }
  if (action === "set") {
    const key = await promptHidden(`API key for ${target}（不回显）: `);
    const store = await storeSecret(target, key.trim());
    console.log(`已保存到 ${store}。`);
    return EXIT_OK;
  }
  if (action === "rm") {
    console.log((await forgetSecret(target)) ? "已删除。" : "没有存过。");
    return EXIT_OK;
  }
  if (action === "status") {
    const cfg = await resolveConfig();
    console.log(`key 来源：${cfg.apiKeySource}`);
    return EXIT_OK;
  }
  console.log("用法：ai-shell auth set|rm|status <provider>");
  return EXIT_ERROR;
}

function usage(): string {
  return [
    `ai-shell ${VERSION}`,
    "用法：ai-shell <command>",
    "  ask [--command-out PATH] [--model ID] [--timeout MS] [--comment]   从 stdin 读 NUL 分隔上下文，输出面板并把建议写入 PATH",
    "  setup                                                              交互式配置模型端点（BYOK）",
    "  doctor                                                             自检：插件、配置、端点、工具调用能力",
    "  auth set|rm|status <provider>                                      管理密钥（系统钥匙串优先）",
    "  debug --print-context                                              打印将要发送给模型的内容（含脱敏结果）",
    "  print-plugin [--shell zsh|bash]                                   打印 shell 插件入口（给插件管理器用）",
    "  install [--shell zsh|bash] [--write]                              打印或写入对应 rc 文件的加载行",
    "  version                                                            打印版本",
  ].join("\n");
}

async function main(): Promise<number> {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case "ask":
      return ask(args);
    case "setup":
      return runSetup();
    case "doctor":
      return runDoctor({ echo: console.log });
    case "auth":
      return auth(args);
    case "debug":
      return debug(args);
    case "print-plugin":
      return printPluginDir(console.log, shellFlag(args));
    case "install":
      return runInstall({ write: args.includes("--write"), shell: shellFlag(args), echo: console.log });
    case "uninstall":
      return runUninstall({ write: args.includes("--write"), shell: shellFlag(args), echo: console.log });
    case "version":
      console.log(`ai-shell ${VERSION}`);
      return EXIT_OK;
    default:
      console.log(usage());
      return EXIT_ERROR;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.error(`ai-shell: 未捕获错误：${error instanceof Error ? error.message : String(error)}`);
    process.exit(EXIT_ERROR);
  });
