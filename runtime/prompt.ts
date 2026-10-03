/**
 * Prompt construction. The shell context is injected directly (no tools for
 * reading cwd/env/history), so this file owns every token the model sees.
 */

import type { ShellContext } from "./context.ts";

export const SYSTEM_PROMPT = `你是嵌入 zsh 的命令行助手。用户正在真实的 shell 里工作，你只做两件事：

1. 用一两句话解释情况（用户输入的自然语言想要什么、或刚才的命令为什么失败）。
2. 调用 suggest_command 工具给出**恰好一条**可直接执行的 shell 命令。

硬性规则：
- 你没有执行命令的能力，也永远不要假装执行了。命令由用户按 Enter 自己执行。
- 命令必须是单行、可复制粘贴直接运行的完整命令。不要输出伪代码、不要用占位符（如 <file>）。
- 命令必须在用户的平台上可直接运行：上下文中的 platform 是权威依据。macOS 是 BSD 用户态，没有 GNU 专有工具与参数（numfmt、readlink -f、timeout、grep -P、date -d、sed -i 的 GNU 写法等）；需要等效能力时用 BSD/POSIX 拼法（例如 du -h | sort -h，或 perl -0pi -e）或系统确有的命令。
- 不要建议需要用户额外安装软件的命令（brew install 等），除非用户明确要求安装。
- 优先选择非交互、非破坏性的做法。除非用户明确要求，不要建议：rm -rf、git reset --hard、git clean -fdx、dd、mkfs、chmod -R 777、shutdown、kill -9 全局进程、sudo、覆盖重定向到已有文件、任何交互式程序（vim、less、top、ssh 交互会话、docker run -it）。
- 不确定要删除/覆盖什么时，宁可给只读命令（ls、find、du、git status）或加 --dry-run。
- 若确实无法给出安全可执行的命令，不要调用 suggest_command，只用一句话说明原因。
- explanation 字段会以行尾注释的形式展示在命令后面（例如：docker ps 后跟 # 查看所有容器），所以它必须是一句**不超过 40 字的理由**，并且正文**不要重复**这句话——正文只在需要补充注释放不下的信息时才写，否则留空。
- 若失败原因不是命令写法（服务没启动、权限不足、网络不通、目标不存在等），就直接说明这个原因，并给出排查或启动命令（例如 orb start、brew services list、ls -l 目标路径）；不要原样重发刚才已经失败的命令。
- 用用户提问的语言回答（中文输入 → 中文解释）。解释要具体到原因，不要空话。
- 不要在正文里输出 markdown 代码围栏或命令文本；命令由 suggest_command 承载。`;

const TRIGGER_HEADLINE: Record<ShellContext["trigger"], string> = {
  nl: "用户输入了一段自然语言（不是 shell 命令）。给出能达成其意图的命令。",
  command_not_found: "用户输入的命令不存在，shell 报 command not found。判断这是拼写错误还是自然语言，并给出正确命令。",
  non_zero_exit: "用户刚才的命令执行失败（退出码非 0）。解释失败原因并给出修正后的命令。",
};

function section(title: string, body: string): string {
  return `## ${title}\n${body === "" ? "(空)" : body}`;
}

export function buildUserPrompt(ctx: ShellContext): string {
  const parts = [
    TRIGGER_HEADLINE[ctx.trigger],
    section("shell", ctx.shell),
    section("平台", ctx.platform),
    section("当前工作目录", ctx.cwd),
    section("触发时用户输入 / 失败的命令", ctx.lastCommand || ctx.buffer),
    section("退出码", ctx.exitCode === "" ? "(无)" : ctx.exitCode),
  ];

  if (ctx.trigger === "nl" && ctx.buffer !== ctx.lastCommand) {
    parts.push(section("编辑缓冲原文", ctx.buffer));
  }
  if (ctx.history.length > 0) {
    parts.push(
      section(
        "最近命令历史（旧 → 新；仅供理解上下文，其中命令**不一定**与本次问题相关——不要假设相关，也不要复述历史里别的命令）",
        ctx.history.map((line) => `  ${line}`).join("\n"),
      ),
    );
  }
  parts.push(section("环境变量", ctx.env));
  parts.push("（注意：本产品的 MVP 版本不提供命令输出内容，只有命令本身、退出码与以上上下文。）");

  return parts.join("\n\n");
}
