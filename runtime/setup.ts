/**
 * `ai-shell setup` — the only place that asks a human anything.
 *
 * BYOK: we never provide a model. The wizard probes for a local
 * OpenAI-compatible server first (best privacy story, zero cost), then falls
 * back to a provider preset where the user supplies their own key.
 */

import { createInterface } from "node:readline";

import { configPath, writeFileConfig } from "./config.ts";
import { promptHidden } from "./hidden-input.ts";
import { LOCAL_PROBES, PROVIDERS, findProvider } from "./providers.ts";
import { storeSecret } from "./secret.ts";

async function probeLocal(baseUrl: string): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(700) });
    return response.ok;
  } catch {
    return false;
  }
}

export async function runSetup(): Promise<number> {
  const echo = console.log;
  if (process.stdin.isTTY !== true) {
    echo("setup 需要交互终端。也可以直接创建 " + configPath() + "，例如：");
    echo(JSON.stringify({ provider: "ollama", model: "qwen3:8b" }, null, 2));
    return 1;
  }

  echo("ai-shell 配置向导（密钥只存本机：系统钥匙串优先，绝不写进 ~/.zshrc）");
  echo("");

  let detected: string | undefined;
  for (const probe of LOCAL_PROBES) {
    if (await probeLocal(probe.baseUrl)) {
      detected = probe.provider;
      echo(`检测到本机可用端点：${findProvider(probe.provider)?.label ?? probe.provider}（${probe.baseUrl}）`);
      break;
    }
  }
  if (detected === undefined) echo("未检测到本机模型服务（Ollama 11434 / LM Studio 1234 / vLLM 8000）。");

  const readline = createInterface({ input: process.stdin, output: process.stdout });
  const ask = (question: string) => new Promise<string>((resolve) => readline.question(question, resolve));

  echo("");
  echo("可选 provider：");
  PROVIDERS.forEach((provider, index) => {
    echo(`  ${String(index + 1).padStart(2)}. ${provider.id.padEnd(11)} ${provider.label}`);
  });

  const defaultIndex = detected === undefined ? 1 : PROVIDERS.findIndex((p) => p.id === detected) + 1;
  const picked = (await ask(`选择 provider [${defaultIndex}]: `)).trim();
  const index = picked === "" ? defaultIndex : Number(picked);
  const preset = PROVIDERS[index - 1];
  if (preset === undefined) {
    echo("无效选择。");
    readline.close();
    return 1;
  }

  const baseUrlAnswer = (await ask(`base_url [${preset.baseUrl}]: `)).trim();
  const baseUrl = baseUrlAnswer === "" ? preset.baseUrl : baseUrlAnswer;

  const model = (await ask(`model [${preset.model}]: `)).trim() || preset.model;

  let apiKey = "";
  const envKey = preset.keyEnv.map((name) => process.env[name]).find((value) => value);
  if (envKey !== undefined) {
    echo(`检测到环境变量里的密钥（${preset.keyEnv[0]}），将直接使用，不重复存。`);
  } else if (preset.keyEnv.length > 0) {
    apiKey = await promptHidden(`API key（输入不回显，存系统钥匙串）: `);
  }

  readline.close();

  const path = writeFileConfig({ provider: preset.id, base_url: baseUrl, model, env_mode: "redacted" });
  echo(`已写入 ${path}（mode 600）`);
  if (apiKey !== "") {
    const store = await storeSecret(preset.id, apiKey);
    echo(`已保存密钥：${store === "file" ? "secrets.json（明文，建议改用环境变量或 keyring）" : store}`);
  }

  echo("");
  echo("下一步：");
  echo("  1) ai-shell doctor          # 验证端点与工具调用能力");
  echo("  2) ai-shell install --write # 把插件写进 ~/.zshrc（若还没装）");
  return 0;
}
