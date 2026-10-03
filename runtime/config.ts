/**
 * Configuration resolution. Precedence, lowest first:
 *
 *   built-in defaults  <  ~/.config/ai-shell/config.json  <  environment  <  CLI flags
 *
 * The API key is never read from config.json's plain fields by preference: it
 * comes from the env or the OS keychain (see secret.ts).
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findProvider } from "./providers.ts";
import { isEnvMode, type EnvMode } from "./redact.ts";
import { configDir, lookupSecret } from "./secret.ts";

export interface FileConfig {
  provider?: string;
  base_url?: string;
  model?: string;
  env_mode?: string;
  timeout_ms?: number;
  verbose?: boolean;
}

export interface ResolvedConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  apiKeySource: string;
  envMode: EnvMode;
  timeoutMs: number;
  verbose: boolean;
  /** false ⇒ tell the user to run `ai-shell setup` instead of guessing */
  configured: boolean;
}

export function configPath(): string {
  return join(configDir(), "config.json");
}

export function readFileConfig(): FileConfig {
  try {
    return JSON.parse(readFileSync(configPath(), "utf8")) as FileConfig;
  } catch {
    return {};
  }
}

export function writeFileConfig(patch: FileConfig): string {
  const path = configPath();
  mkdirSync(configDir(), { recursive: true });
  const merged = { ...readFileConfig(), ...patch };
  writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf8");
  chmodSync(path, 0o600);
  return path;
}

export async function resolveConfig(
  overrides: { model?: string; timeoutMs?: number } = {},
): Promise<ResolvedConfig> {
  const file = readFileConfig();
  const providerId = process.env.AI_SHELL_PROVIDER ?? file.provider ?? "";
  const preset = providerId === "" ? undefined : findProvider(providerId);

  const baseUrl = process.env.AI_SHELL_BASE_URL ?? file.base_url ?? preset?.baseUrl ?? "";
  const model = overrides.model ?? process.env.AI_SHELL_MODEL ?? file.model ?? preset?.model ?? "";

  const envModeRaw = process.env.AI_SHELL_ENV_MODE ?? file.env_mode ?? "redacted";
  const envMode: EnvMode = isEnvMode(envModeRaw) ? envModeRaw : "redacted";

  const timeoutRaw = overrides.timeoutMs ?? Number(process.env.AI_SHELL_TIMEOUT_MS ?? file.timeout_ms ?? 60000);
  const timeoutMs = Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? timeoutRaw : 60000;

  const key = providerId === "" ? null : await lookupSecret(providerId, preset?.keyEnv ?? []);

  return {
    provider: providerId,
    baseUrl,
    model,
    apiKey: key?.value ?? "",
    apiKeySource: key?.source ?? "(none)",
    envMode,
    timeoutMs,
    verbose: process.env.AI_SHELL_VERBOSE !== "0" && file.verbose !== false,
    configured: providerId !== "" && baseUrl !== "" && model !== "",
  };
}

export function isConfigured(): boolean {
  return existsSync(configPath());
}
