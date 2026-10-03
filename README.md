# ai-shell

> **AI 是 shell 的兜底，不是入口。**
>
> 你照常敲命令。只有**打错了命令、命令跑失败了、或者直接说人话**的时候它才出现——
> 把该敲的命令放进**你正在编辑的那一行**，你按 Enter 它才会执行。

[![release](https://img.shields.io/github/v/release/noexcs/shell_ai?color=brightgreen)](https://github.com/noexcs/shell_ai/releases)
[![shells](https://img.shields.io/badge/shells-zsh%20%7C%20bash%20%28WSL%20%E5%8F%AF%E7%94%A8%EF%BC%89-blue)](#常见问题)

```console
$ dockre ps
zsh: command not found: dockre

✦ AI — shell 助手
│ `dockre` 是 `docker` 的字母顺序打错（不是自然语言）。
│ → docker ps  # 把 dockre 纠正为 docker
│ Qwen3.8-27B · 3.8s

$ docker ps        ← 命令已经在你的命令行里，能改，按 Enter 才执行
```

不用记快捷键，不用学新命令，不用切换模式，也不用复制粘贴。**它给你的不是一段文本，是你命令行里那条待执行的命令。**

## 它能帮你做什么

| 你遇到的情况 | 会发生什么 |
|---|---|
| **打错命令**（`dockre ps`） | 它认出这是拼写错误，告诉你正确的命令，并把正确命令放进你的命令行 |
| **命令跑失败了**（参数写错、服务没起、权限不够…） | 它**先解释为什么失败**，再给出修好的命令——而不是丢给你一条猜的命令 |
| **不知道命令怎么写**（"找出当前目录最大的文件"、"看看谁占着 8080"） | 直接用中文说就行，它把命令给你 |
| **连命令名都记不住** | 你不需要记——说你要做什么就可以 |

**命令永远先到你手上**：它会填进你正在编辑的那一行，你可以改、可以删，按 Enter 才真的执行。

## 和别的做法比

让 AI 帮你敲命令，现在大致四条路，我们选了第四条。

| 做法 | 代表 | 你怎么用它 | 代价 |
|---|---|---|---|
| **手动触发的 shell 插件** | [smart-suggestion](https://github.com/yetone/smart-suggestion)（`Ctrl+O`）、[zsh-ai-cmd](https://github.com/kylesnowschwartz/zsh-ai-cmd)（`Ctrl+Z`）、[ohmyai-zsh](https://github.com/briques/ohmyai-zsh) | 先想起来按快捷键，建议以幽灵文本出现，按键接受 | **忘了按就没有 AI**；失败之后要你自己再问一次 |
| **终端内置 AI** | Warp | 换过去用，AI 是终端的一部分 | 换终端 |
| **Agent 类** | GitHub Copilot CLI（原 `gh copilot` 已于 2025-10 下线，改为 agent 形态）、Claude Code | 对话，让它自己读文件、跑命令、多步完成 | 它会**真的执行**命令、改文件——那是另一个物种 |
| **ai-shell** | 本项目 | **什么都不用记**：打错命令、命令失败、说人话时它自己出现 | 只支持 zsh/bash；不做长任务 |

我们这条路的三条取舍：

1. **触发靠"出错"，不靠"你想起来按什么键"。** 用快捷键的插件做得都不错，但它们把"我知道我现在需要 AI"当成了前提——而真实情况往往是"我打错了"和"我不知道为什么失败"。
2. **建议落进命令行，不落进对话。** 不是一段要你复制的文本，也不只停在幽灵文本：就是你自己那行命令，能改、能删，按 Enter 才执行。
3. **不抓你的命令输出。** 有些工具会额外挂一个代理 shell 录下终端输出（上下文更全，代价是你的输出被读走）。我们只带命令历史、当前目录和脱敏后的环境变量——**不读命令输出，不读终端回滚**。

（顺带说：上面几个开源插件有些工程细节相当讲究——标红破坏性命令、丢弃会让 shell 停在续行状态的建议、多条候选可循环——值得学。）

## 为什么可以放心天天用

- **不会乱执行你的命令。** 它没有执行命令这个能力——不是"默认关闭"的开关，而是根本不存在这个功能。你看到的每条建议都只是填进命令行。
- **正常敲命令时它完全不工作。** 不联网、不占时间、不留记录。`ls`、`git status`、`cd`、管道……你感觉不到它存在。
- **不用把密钥交出去。** 密钥存在系统钥匙串里（不进 shell 环境）；发给模型的环境变量默认打码（`*KEY*`、`*TOKEN*` → `[redacted]`）；想确认到底发了什么，一条 `ai-shell debug --print-context` 逐字给你看。
- **不抓你的命令输出**，不读终端历史回滚。
- **换成你自己的模型**：本地 Ollama / LM Studio、自建 vLLM、或任意 OpenAI 兼容服务；我们用你的 key 直连，不经过我们的服务器。

## 它不做什么（先说清楚，免得期待错）

- **不替换你的 shell**，也不改变你任何一条普通命令的行为。
- **不自动执行**、不自动 sudo、不改你的文件。
- **不在长命令运行期间插话**（比如 `npm install` 跑到一半）。
- **不接管终端**：不装壳套在你的终端外面，不做全屏界面。
- 目前只支持 **zsh 和 bash**（含 WSL）；PowerShell 只验证过机制、还没实现。

## 怎么开始

**1. 装（约 140KB，不需要管理员权限）**

```sh
curl -sL https://github.com/noexcs/shell_ai/releases/download/v0.1.4/noexcs-ai-shell-0.1.4.tgz -o /tmp/ai-shell.tgz
npm i -g /tmp/ai-shell.tgz
```

**2. 配一个模型（BYOK，30 秒）**

```sh
ai-shell setup      # 先自动探测本机模型（Ollama / LM Studio / vLLM）；没有就从预设里选一个，粘贴你的 key
ai-shell doctor     # 自检：还会真调一次模型，确认它能配合工作
```

**3. 挂进 shell，重开终端**

```sh
ai-shell install --write     # 自动识别 zsh / bash，写入对应配置文件
exec $SHELL
```

然后随便打错一条命令试试。想卸载：`ai-shell uninstall --write`。

> 没有 Node？可以下**单文件二进制**（自包含，含插件），或在源码目录里跑 `node runtime/main.ts install --write`。

## 适合谁

- 每天都在终端里，但**记不住参数**：`find` 的 `-exec`、`tar` 的 `-zxvf`、`ffmpeg` 那一长串。
- 经常**离开终端去搜"这个报错是什么意思"**。
- 在**别人的机器 / 服务器 / WSL** 里干活，环境不熟。
- 想要 AI 帮忙，但**受不了它自动执行命令**。
- 手里已经有模型（本地部署或 API key），想让它在 shell 里随叫随到。

**可能不适合你**：主力是 PowerShell/cmd；想要全屏 TUI 与鼠标操作；想让它直接改文件、跑命令、自己完成多步任务（那是 Code Agent 的活，不是这个产品的定位）。

## 常见问题

**它会不会没等我同意就把命令跑了？**
不会。它只能把命令填进你的命令行，执行永远是你按 Enter。

**我的密钥和命令历史会被发到哪里？**
只发给**你自己配置的模型服务**（本地模型则不出机器）。密钥默认存系统钥匙串、不进 shell 环境；环境变量默认脱敏；`ai-shell debug --print-context` 能逐字检查即将发出的内容。

**它会拖慢我的 shell 吗？**
正常命令不会联网、不会起后台进程、不会写日志——只有"打错/失败/说人话"这三种情况才会调用模型（通常几秒）。

**要花多少钱？**
用你自己的 key 或本地模型。正常敲命令零成本；一次 AI 介入取决于你选的模型（本地模型为零）。

**支持哪些 shell / 系统？**
zsh 与 bash（含 WSL），macOS 与 Linux。完整功能需要 **bash 4+**（"命令不存在"这条路径依赖 `command_not_found_handle`）；我们在 bash 5 上实测。macOS 自带的 bash 3.2 太老，`brew install bash` 即可。

**PowerShell 呢？**
只做过可行性验证（`AcceptLine()` 同键放行、提示函数里可预填），尚未实现——欢迎 PR。

**和那些"按快捷键生成命令"的工具差在哪？**
**触发方式**是最大的差别：那些要先想起来按快捷键；这个是**出错自动出现、正常使用零打扰**。细节见上面的[「和别的做法比」](#和别的做法比)。

## 进阶配置

配置文件 `~/.config/ai-shell/config.json`（也可以用环境变量，优先级更高）：

```json
{
  "provider": "vllm",
  "base_url": "http://127.0.0.1:8000/v1",
  "model": "Qwen3.8-27B",
  "env_mode": "redacted",
  "timeout_ms": 60000
}
```

| 开关 | 默认 | 作用 |
|---|---|---|
| `AI_SHELL_DISABLE` | 空 | 非空即暂时完全停用 |
| `AI_SHELL_PROVIDER` | 配置文件 | 预设：openai / anthropic / deepseek / openrouter / groq / ollama / lmstudio / vllm |
| `AI_SHELL_MODEL` | 由 provider 决定 | 模型名 |
| `AI_SHELL_ENV_MODE` | `redacted` | `redacted` / `full` / `none`——`full` 会把含密钥的完整环境变量发出去 |
| `AI_SHELL_TIMEOUT_MS` | `60000` | 单次等待上限（思考型模型常见 4–20s） |
| `AI_SHELL_IGNORE_EXTRA` | 空 | 让更多命令"失败也不打扰"，如 `"curl docker"` |
| `AI_SHELL_MAX_EXIT_AI` | `3` | 连续失败最多打扰几次，防刷屏 |
| `AI_SHELL_VERBOSE` | 开 | 置 `0` 关掉面板末尾的"模型 · 耗时" |

`grep`、`diff`、`test`、`[` 这类"失败是正常语义"的命令已经默认不打扰（匹配命令首词，所以 `git diff --exit-code` 这类过滤不了）。

## 开发者

设计文档：[`docs/superpowers/specs/2026-10-03-ai-shell-mvp-design.md`](docs/superpowers/specs/2026-10-03-ai-shell-mvp-design.md) · 产品设计：[`PRODUCTION_DESIGN.md`](PRODUCTION_DESIGN.md)

所有行为都有自动化验收（zsh 与 bash 各 6 个场景，覆盖"正常命令零打扰""建议必须等你按 Enter""密钥不外发"等），自己跑：

```sh
npm run test:unit                   # 快，无网络
python3 test/e2e.py                 # zsh 端到端（真实模型调用）
python3 test/e2e.py --shell bash    # bash
```
