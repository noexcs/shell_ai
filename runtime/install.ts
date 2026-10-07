/**
 * `unstuck install` / `uninstall` / `print-plugin`, per shell.
 *
 * This is the only code that touches the user's shell configuration, and only
 * when `--write` is passed.  The plugin directory is resolved as: an explicit
 * UNSTUCK_PLUGIN_DIR, the in-repo checkout (development), or the copies
 * embedded in the binary — extracted under the user's data dir so a single-file
 * install still works with no loose files.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { PLUGIN_FILES } from "./generated/plugin.ts";

const MARKER_START = "# >>> unstuck >>>";
const MARKER_END = "# <<< unstuck <<<";

export type ShellName = "zsh" | "bash";

export const SHELLS: ShellName[] = ["zsh", "bash"];

const ENTRY: Record<ShellName, string> = { zsh: "unstuck.zsh", bash: "unstuck.bash" };
const RC_FILE: Record<ShellName, string> = { zsh: ".zshrc", bash: ".bashrc" };

export interface InstallOptions {
  write: boolean;
  shell: ShellName;
  echo: (message: string) => void;
}

function repoRoot(): string {
  // runtime/install.ts → repo root when running from a checkout.
  return join(import.meta.dirname, "..");
}

function dataHome(): string {
  return process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
}

/** Where the embedded tree is unpacked (mirrors the repo layout). */
export function extractRoot(): string {
  return join(dataHome(), "unstuck");
}

export function extractPlugin(): string {
  const target = extractRoot();
  for (const [path, contents] of Object.entries(PLUGIN_FILES)) {
    const file = join(target, path);
    if (existsSync(file) && readFileSync(file, "utf8") === contents) continue;
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents, "utf8");
  }
  return join(target, "plugin");
}

/** Directory holding <shell>/unstuck.<ext>. */
export function resolvePluginDir(shell: ShellName): string {
  const explicit = process.env.UNSTUCK_PLUGIN_DIR;
  if (explicit !== undefined && explicit !== "") return explicit;

  const checkout = join(repoRoot(), "plugin");
  if (existsSync(join(checkout, shell, ENTRY[shell]))) return checkout;

  return extractPlugin();
}

export function entryPoint(shell: ShellName): string {
  return join(resolvePluginDir(shell), shell, ENTRY[shell]);
}

function rcPath(shell: ShellName): string {
  if (shell === "zsh") return join(process.env.ZDOTDIR ?? homedir(), RC_FILE.zsh);
  return join(homedir(), RC_FILE.bash);
}

/** Detection used when the user does not pass --shell. */
export function detectShell(): ShellName {
  const fromEnv = (process.env.UNSTUCK_SHELL ?? "").trim().replace(/^-/, "");
  if (fromEnv === "zsh" || fromEnv === "bash") return fromEnv;
  const login = (process.env.SHELL ?? "").split("/").pop() ?? "";
  return login === "bash" ? "bash" : "zsh";
}

function applyWrite(options: InstallOptions, next: string, summary: string): number {
  const path = rcPath(options.shell);
  if (!options.write) {
    options.echo(`以下内容需要写入 ${path}（加 --write 才会真正写入）：`);
    options.echo(next);
    return 0;
  }
  const temp = `${path}.unstuck.tmp`;
  writeFileSync(temp, next, "utf8");
  chmodSync(temp, 0o644);
  renameSync(temp, path);
  options.echo(`${summary}：${path}`);
  return 0;
}

export function runInstall(options: InstallOptions): number {
  const line = `source ${entryPoint(options.shell)}`;
  const block = [MARKER_START, line, MARKER_END].join("\n");
  const path = rcPath(options.shell);
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";

  if (current.includes(MARKER_START)) {
    const updated = current.replace(new RegExp(`${MARKER_START}[\\s\\S]*?${MARKER_END}`), block);
    if (updated === current) {
      options.echo(`unstuck 已在 ${path} 中登记（未改动）。`);
      return 0;
    }
    return applyWrite(options, updated, "已更新 unstuck 加载行");
  }

  const next = `${current.replace(/\n*$/, "")}\n\n${block}\n`;
  const code = applyWrite(options, next, "已写入 unstuck 加载行");
  if (options.write) {
    options.echo("下一步：新开一个终端，或在当前 shell 执行 `unstuck-reload`；配置模型用 `unstuck setup`。");
  }
  return code;
}

export function runUninstall(options: InstallOptions): number {
  const path = rcPath(options.shell);
  if (!existsSync(path)) {
    options.echo(`${path} 不存在，无需卸载。`);
    return 0;
  }
  const current = readFileSync(path, "utf8");
  if (!current.includes(MARKER_START)) {
    options.echo(`${path} 中没有 unstuck 加载行。`);
    return 0;
  }
  const pattern = new RegExp(`\\n*${MARKER_START}[\\s\\S]*?${MARKER_END}\\n*`, "m");
  const next = current.replace(pattern, "\n").replace(/\n{3,}/g, "\n\n");
  return applyWrite(options, next, "已删除 unstuck 加载行");
}

/** For shell plugin managers that want the directory instead of an rc edit. */
export function printPluginDir(echo: (message: string) => void, shell: ShellName): number {
  echo(entryPoint(shell));
  return 0;
}
