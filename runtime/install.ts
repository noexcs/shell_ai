/**
 * `ai-shell install` / `uninstall` / `print-plugin`.
 *
 * This is the only code that touches the user's shell configuration, and only
 * when `--write` is passed. The zsh side is resolved in this order: an explicit
 * AI_SHELL_PLUGIN_DIR, the in-repo checkout (development), or the copies
 * embedded in the binary — extracted to the user's data dir so a single-file
 * install still works with no loose files.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { PLUGIN_FILES } from "./generated/plugin.ts";

const MARKER_START = "# >>> ai-shell >>>";
const MARKER_END = "# <<< ai-shell <<<";

export interface InstallOptions {
  write: boolean;
  echo: (message: string) => void;
}

function rootDir(): string {
  // runtime/install.ts → repo root when running from a checkout.
  return join(import.meta.dirname, "..");
}

function dataHome(): string {
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

function zshrcPath(): string {
  return join(process.env.ZDOTDIR ?? homedir(), ".zshrc");
}

export function extractPlugin(): string {
  const dir = join(dataHome(), "ai-shell", "plugin", "zsh");
  mkdirSync(dir, { recursive: true });
  for (const [name, contents] of Object.entries(PLUGIN_FILES)) {
    const target = join(dir, name);
    if (existsSync(target) && readFileSync(target, "utf8") === contents) continue;
    writeFileSync(target, contents, "utf8");
  }
  return dir;
}

/** Directory to `source` from ~/.zshrc. */
export function resolvePluginDir(): string {
  const explicit = process.env.AI_SHELL_PLUGIN_DIR;
  if (explicit !== undefined && explicit !== "") return explicit;

  const checkout = join(rootDir(), "plugin", "zsh");
  if (existsSync(join(checkout, "ai-shell.zsh"))) return checkout;

  return extractPlugin();
}

function applyWrite(options: InstallOptions, next: string, summary: string): number {
  const path = zshrcPath();
  if (!options.write) {
    options.echo("以下内容需要写入 ~/.zshrc（加 --write 才会真正写入）：");
    options.echo(next);
    return 0;
  }
  const temp = `${path}.ai-shell.tmp`;
  writeFileSync(temp, next, "utf8");
  chmodSync(temp, 0o644);
  renameSync(temp, path);
  options.echo(`${summary}：${path}`);
  return 0;
}

export function runInstall(options: InstallOptions): number {
  const dir = resolvePluginDir();
  const line = `source ${join(dir, "ai-shell.zsh")}`;
  const path = zshrcPath();
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = [MARKER_START, line, MARKER_END].join("\n");

  if (current.includes(MARKER_START)) {
    const updated = current.replace(new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`), block);
    if (updated === current) {
      options.echo("ai-shell 已在 ~/.zshrc 中登记（未改动）。");
      return 0;
    }
    return applyWrite(options, updated, "已更新 ai-shell 加载行");
  }

  const next = `${current.replace(/\n*$/, "")}\n\n${block}\n`;
  const code = applyWrite(options, next, "已写入 ai-shell 加载行");
  if (options.write) {
    options.echo("下一步：新开一个终端，或在当前 shell 执行 `ai-shell-reload`；配置模型用 `ai-shell setup`。");
  }
  return code;
}

export function runUninstall(options: InstallOptions): number {
  const path = zshrcPath();
  if (!existsSync(path)) {
    options.echo("~/.zshrc 不存在，无需卸载。");
    return 0;
  }
  const current = readFileSync(path, "utf8");
  if (!current.includes(MARKER_START)) {
    options.echo("~/.zshrc 中没有 ai-shell 加载行。");
    return 0;
  }
  const pattern = new RegExp(`\\n*${MARKER_START}[\\s\\S]*?${MARKER_END}\\n*`, "m");
  const next = current.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
  return applyWrite(options, next, "已删除 ai-shell 加载行");
}

/** For zsh plugin managers that want the directory instead of an rc edit. */
export function printPluginDir(echo: (message: string) => void): number {
  echo(resolvePluginDir());
  return 0;
}
