# Unstuck — 产品设计与实现探索文档

> 本文档用于交给本地 Code Agent，作为项目实现、技术探索和架构决策的基础。
>
> **重要：本文档中“已确定”部分应视为产品约束；“待探索”部分允许 Code Agent 调研、实验和提出方案，但不得擅自改变已确定的核心产品原则。**
>
> **2026-10-07 状态更新：** Command Output Capture 已采用独立的
> [iZSH](https://github.com/noexcs/izsh) producer 实现。iZSH 负责按 session 和
> command 写事件及 stdout/stderr 文件；Unstuck 在 `command_end` 后做匹配、限量读取、
> 脱敏和模型调用。本文后面的 PTY sidecar 等内容保留为历史方案比较，不再是当前架构。

---

# 1. 产品概念

## 1.1 产品定位

这是一个运行在现有 Shell 之上的 **Unstuck Middleware / AI Fallback Layer**。

它不是新的 Shell，也不是新的 Terminal Emulator，更不是一个传统意义上的 Code Agent。

核心思想：

> **Shell 是第一交互入口，AI 是 Shell 的智能 fallback。**

用户不需要学习新的 AI 命令，也不需要在 Shell 和 Agent 之间手动切换模式。

用户可以自然地混合使用：

```text
普通 Shell 命令
自然语言
错误命令
执行异常
长时间运行命令
```

系统自动判断什么时候应该继续交给 Shell，什么时候应该唤起 AI。

---

# 2. 与传统 Code Agent 的区别

传统 Code Agent：

```text
Agent
  │
  ├── 自然语言
  │
  └── !command
          ↓
        Shell
```

即：

> Agent 是第一世界，Shell 是 Agent 的工具。

本产品反过来：

```text
Shell
  │
  ├── 正常命令
  │      ↓
  │    Shell
  │
  └── 自然语言 / 错误 / 超时
          ↓
        Agent
```

即：

> **Shell 是第一世界，Agent 是 Shell 的智能 fallback。**

这是整个产品最核心的设计思想。

---

# 3. 核心用户体验

用户平时完全按照使用 Zsh 的方式使用 Shell。

例如：

```bash
git status
docker ps
npm run build
cd project
```

这些命令应该完全按照正常 Zsh 行为执行。

用户也可以直接输入自然语言：

```text
帮我找出当前目录最大的10个文件
```

或者：

```text
为什么刚才的命令失败了？
```

或者输入一个错误命令：

```bash
dockre ps
```

或者：

```bash
docker ps -all
```

系统发现 Shell 命令不存在、执行失败或者满足其他 AI fallback 条件时，唤起 AI。

---

# 4. 最重要的安全原则

## AI 永远不直接执行 Shell 命令

这是产品的核心安全边界。

AI 的职责：

```text
理解
分析
解释
提出命令建议
```

AI 不具有：

```text
execute_command()
run_shell()
sudo()
```

等能力。

最终流程：

```text
AI
 ↓
suggest_command
 ↓
Shell UI
 ↓
Shell Buffer
 ↓
用户确认
 ↓
用户按 Enter
 ↓
Zsh 执行
```

因此：

> **AI 可以建议命令，但只有用户主动按 Enter 才能执行命令。**

用户始终拥有最终执行权。

---

# 5. AI 的唯一 Tool

当前已经确定：

> Agent Tool 不需要设计成庞大的 Shell Toolset。

MVP 只提供一个 Tool：

```text
suggest_command
```

概念：

```typescript
suggest_command({
    command: string,
    explanation: string
})
```

它的含义是：

> AI 建议用户执行某个 Shell 命令。

它不是：

```text
set_shell_buffer
```

也不是：

```text
execute_command
```

---

# 6. Shell Context 不通过 Tool 获取

当前工作目录、环境变量等简单上下文不需要 Tool。

由 Shell Middleware 在调用 Agent 时直接构造 Prompt。

例如：

```text
Shell: zsh

Current working directory:
/Users/user/project

Environment:
...

Current command buffer:
docker ps -all

Last command:
docker ps -all

Exit code:
125

Command output:
unknown flag: --all

Recent command history:
...
```

这些内容属于 Agent Context，而不是 Agent Tool。

---

# 7. Agent Runtime

当前已经确定：

> **不使用 Codex、Claude Code、Pi、Oh My Pi 等成熟 Code Agent 作为 Backend。**

原因：

这些工具本身已经拥有自己的 Agent Runtime、Tool System 和输出协议。

如果把它们作为黑盒 Backend：

* 难以注入自己的 Shell Tool
* 难以控制 Agent 行为
* 难以控制 Tool 权限
* 难以可靠区分自然语言输出和结构化命令
* 难以深度整合 Shell Buffer
* 会引入不必要的 Agent Runtime 复杂度

因此：

> **自己实现一个非常轻量的 Agent Runtime。**

但不自己实现底层 LLM 调用、Streaming、Tool Calling 等基础设施。

---

# 8. AI SDK

当前倾向确定：

> 使用 Vercel AI SDK 作为 Agent Runtime 的基础 SDK。

AI SDK 负责：

* Model 调用
* Streaming
* Tool Calling
* Tool Schema
* Agent Loop 等基础能力

产品自己的代码负责：

* Shell Context
* Shell 生命周期
* `suggest_command`
* AI UI
* Zsh Integration
* Shell Buffer 操作

---

# 9. 为什么使用 Tool Calling，而不是让模型直接输出 JSON

不采用：

```text
LLM
 ↓
JSON
 ↓
Shell parser
```

也不要求模型最终回答必须是 JSON。

原因：

AI 的用户可见回答应该保持自然语言。

例如：

```text
这个命令失败是因为 Docker 不支持 `-all` 这种参数写法。

可以使用 `-a` 查看所有容器。
```

同时 AI 调用：

```text
suggest_command({
    command: "docker ps -a",
    explanation: "使用 -a 查看所有容器"
})
```

因此：

```text
自然语言输出
```

和：

```text
结构化 command suggestion
```

由 AI SDK 的不同输出通道天然分离。

无需：

* 正则解析 JSON
* Markdown Code Block 解析
* 从自然语言中提取命令
* 猜测哪个字符串是最终命令

---

# 10. AI Prompt UI

AI 被唤起后，应该在当前命令输出的底部出现一个 AI 提示区域。

例如：

```text
$ docker ps -all

unknown flag: --all

┌─ ✦ Unstuck ──────────────────────────────────────┐
│                                              │
│  `--all` 参数写法不正确。Docker 使用 `-a`   │
│  表示查看所有容器。                          │
│                                              │
│  ❯ docker ps -a                              │
│                                              │
│  Enter 执行 · Esc 关闭                       │
└──────────────────────────────────────────────┘
```

要求：

1. 用户不应该看到 JSON。
2. 用户应该看到自然语言解释。
3. 推荐命令应该清晰突出。
4. 推荐命令最终进入 Shell Buffer。
5. 用户可以修改命令。
6. 用户按 Enter 后才执行。

---

# 11. Shell Buffer 是关键交互对象

推荐命令不是简单打印出来让用户复制。

而应该直接填充 Zsh 的：

```text
BUFFER
```

例如：

```text
AI:
    suggest_command("docker ps -a")

        ↓

ZLE:

$ docker ps -a█
```

用户可以继续编辑：

```text
$ docker ps -a --format ...
```

然后按 Enter。

因此：

> **AI 的命令建议最终应该成为真正的 Shell 输入，而不是普通终端文本。**

---

# 12. Zsh 是第一目标

第一版本只支持：

```text
Zsh
```

暂时不考虑：

```text
Bash
Fish
PowerShell
```

不要为了跨 Shell 提前抽象大量接口。

原因：

Zsh 的 ZLE 提供了我们需要的：

* BUFFER
* CURSOR
* accept-line
* widget
* prompt redraw

第一版应该充分利用这些能力。

---

# 13. 最重要的 Shell 入口：accept-line

自然语言识别不能只依赖：

```text
command not found
```

因为 Shell 可能在真正执行之前发生：

```text
parse error
```

因此核心入口应该研究：

```zsh
accept-line
```

概念：

```text
用户按 Enter
       ↓
custom accept-line
       ↓
判断输入
   ┌───┴────┐
   │        │
Shell      AI
command    fallback
   │        │
   ▼        ▼
Zsh       Agent
```

正常 Shell 命令应该调用原始：

```text
.accept-line
```

保持 Zsh 原本行为。

---

# 14. Shell / Natural Language 分类

需要实现一个可靠的分类机制。

目标：

```text
git status
        ↓
Shell

cd ..
        ↓
Shell

npm run build
        ↓
Shell

帮我找出最大的文件
        ↓
Agent

为什么刚才失败了
        ↓
Agent
```

不能简单地：

```text
第一个 token 是否存在于 PATH
```

因为 Shell 命令还包括：

* builtin
* alias
* function
* shell syntax
* variable assignment
* pipeline
* redirection
* `&&`
* `||`
* subshell
* command substitution
* `if`
* `for`
* `while`
* `source`
* `export`
* `sudo`
* 用户自定义函数等。

应尽量利用 Zsh 自身的解析/命令解析能力。

---

## 已实现的触发方式

| 方式 | 判定 | 备注 |
|---|---|---|
| 自然语言 | 含非 ASCII 字符，且第一个词不是能解析到的命令 | 用户无需任何标记 |
| `# …` | 前缀 | 显式提问，英文也能用 |
| `? …` | 前缀 | 同 `#`，更接近"提问"的手感 |

标记后面没有内容（`#`、`?`、`#   `）不算提问：`#` 仍是注释、`?` 仍是通配符，交给 Shell。

**拦截后不能只清空 buffer 再提交。** 那样这一行在终端里没有痕迹、也不进历史，用户会觉得输入被
吃掉了。做法是把 buffer 改写成一行注释（`# 问题`）再提交：zsh 正常回显、写进历史、执行成 no-op，
于是提问留在了提示符上，`↑` 也找得回来。两种例外必须回退到清空 buffer：

* `interactive_comments` 关闭时，`#` 开头的行会被当成命令；
* buffer 是多行时，`#` 只注释得掉第一行，剩下的会真的执行。

发给模型的是去掉标记后的问题本身；`# 问题` 这类历史条目在构建上下文时被过滤掉，不会混进
「最近命令」。

---

# 15. 分类策略的安全原则

分类器应该：

> **宁愿少触发 AI，也不要误拦正常 Shell 命令。**

用户对 Shell 行为有非常强的预期。

例如：

```bash
foo
```

即使无法确定 `foo` 是什么，也不能轻易改变 Shell 行为。

可以优先采用：

```text
确定是 Shell → Shell

明显是自然语言 → Agent

无法确定 → 尽量保持 Shell 原行为
```

---

# 16. Shell 生命周期

需要记录：

```text
command start
command end
exit code
duration
```

Zsh 可研究：

```text
preexec
precmd
TRAPZERR
```

用于建立：

```text
last command
exit code
duration
```

等上下文。

---

# 17. 已知的最大技术难点：Command Output Capture

Zsh 可以比较方便地获取：

```text
command
exit code
cwd
history
duration
```

但：

> **Zsh 没有直接提供 `$LAST_COMMAND_OUTPUT`。**

命令输出通常直接写入 Terminal PTY。

例如：

```bash
npm run build
```

其 stdout/stderr 直接流向 Terminal。

不能简单地给每个命令统一：

```bash
command > /tmp/output 2>&1
```

因为这会破坏：

```text
vim
ssh
top
less
tmux
docker run -it
```

等交互式程序。

---

# 18. Output Capture 的探索方向

这是明确的待研究问题。

候选方向：

### 方案 A：纯 Zsh Hook

研究是否可以通过：

* fd duplication
* Zsh redirection
* hooks
* MULTIOS
* trap

实现透明输出记录。

要求：

不能破坏普通命令和交互式程序。

---

### 方案 B：PTY Sidecar

架构：

```text
Terminal
   │
   ▼
PTY Middleware
   │
   ▼
Zsh
```

Middleware 观察：

```text
stdin
stdout
stderr
process lifecycle
```

优点：

可以天然获取 Terminal I/O。

缺点：

* 架构复杂度明显增加
* PTY 行为需要大量测试
* signal
* resize
* terminal modes
* interactive programs
* Ctrl+C
* Ctrl+Z
* job control

都需要正确处理。

---

### 方案 C：Terminal Emulator Integration

例如针对：

```text
Ghostty
iTerm2
```

获取 Terminal 输出/状态。

暂时不作为核心架构。

产品必须首先保持：

> **Terminal Emulator agnostic。**

---

# 19. Output Capture 的 MVP 策略

不要一开始解决所有 Output Capture。

推荐：

### V0

不需要 Output Capture。

只实现：

```text
自然语言
↓
Agent
↓
suggest_command
↓
BUFFER
```

### V1

加入：

```text
command not found
exit code != 0
```

Agent 获得：

```text
last command
exit code
```

### V2

探索可靠 Output Capture。

### V3

考虑长时间运行命令和实时 AI。

---

# 20. Command Not Found

这是非常重要的第一个错误场景。

例如：

```bash
$ dockre ps

zsh: command not found: dockre
```

Agent Context：

```text
command: dockre ps
exit_code: 127
output: zsh: command not found: dockre
```

Agent：

```text
suggest_command(
    command="docker ps",
    explanation="你输入的 `dockre` 可能是 `docker` 的拼写错误。"
)
```

最终：

```text
$ docker ps█
```

---

# 21. Command Execution Error

例如：

```bash
$ docker ps -all

unknown flag: --all
```

Agent 获得：

```text
command
exit code
output
history
cwd
env
```

然后：

```text
suggest_command(
    command="docker ps -a",
    explanation="Docker 使用 `-a` 或 `--all`，当前参数格式不正确。"
)
```

---

# 22. Timeout / Long Running Command

这是另一个独立问题。

需要区分：

## 命令执行完成但耗时很长

例如：

```text
npm install
```

执行 30 秒后结束。

这种情况下可以在：

```text
precmd
```

阶段判断 duration。

---

## 命令仍在运行

例如：

```text
npm install
```

20 秒仍未结束。

希望：

```text
命令仍在运行
        ↓
AI Assistant 出现
```

这比较复杂，因为：

> 此时前台进程仍然占据 Shell。

ZLE 不一定处于可交互状态。

需要研究旁路 AI UI / terminal UI。

第一版不需要解决实时运行期间 AI。

---

# 23. AI UI 与 ZLE 的关系

建议区分：

```text
AI UI
```

和：

```text
Zsh ZLE Buffer
```

AI UI 负责：

```text
解释
状态
建议
```

ZLE Buffer 负责：

```text
真正可编辑的 Shell Command
```

最终：

```text
AI Panel
   │
   │ suggestion
   ▼
ZLE BUFFER
   │
   │ 用户编辑
   ▼
Enter
   │
   ▼
Zsh
```

不要让 AI UI 自己成为一个新的 Shell。

---

# 24. 暂时不要做复杂 Terminal UI

第一版不需要：

* 全屏 TUI
* alternate screen
* 类 IDE floating window
* mouse UI
* complex ANSI layout

先使用简单、可靠的 Terminal Output + ZLE。

例如：

```text
✦ Unstuck

这个命令失败是因为……

❯ docker ps -a

Enter 执行 · Esc 关闭
```

之后再优化视觉效果。

---

# 25. Agent Context

当前推荐的最小 Context：

```text
shell
cwd
env
current buffer
last command
exit code
command output
recent history
```

其中：

### 直接注入 Prompt

```text
shell
cwd
env
buffer
last command
exit code
history
output
```

### 不通过 Tool 获取

不需要：

```text
get_cwd
get_env
get_history
get_buffer
get_output
```

等大量 Tool。

---

# 26. Agent Tool

唯一 Tool：

```text
suggest_command
```

推荐 schema：

```typescript
{
    command: string,
    explanation: string
}
```

职责：

> 向 Shell Runtime 提交一个“建议执行的命令”。

Tool 不执行命令。

Tool 不直接修改 ZLE。

Shell Runtime 收到 Tool Call 后：

```text
command
 ↓
AI UI
 ↓
ZLE BUFFER
```

---

# 27. Agent 不应该拥有 Execute Tool

禁止设计：

```text
execute_command
run_command
shell
terminal
sudo
```

等执行类 Tool。

如果未来需要更多能力，也优先考虑：

```text
read-only
```

而不是：

```text
mutation
```

---

# 28. Streaming

AI 用户体验应该支持 Streaming。

理想过程：

```text
✦ Unstuck 正在分析...
```

然后逐步出现：

```text
✦ Unstuck

这个命令失败是因为 Docker 参数格式不正确……

建议使用：
```

最终 Tool Call：

```text
suggest_command(...)
```

然后命令进入：

```text
ZLE BUFFER
```

---

# 29. AI Runtime 不需要做成大型 Agent Framework

不要提前设计：

* Subagent
* Planner
* Memory system
* MCP
* Durable Execution
* Checkpoint
* Complex StateGraph
* Multi-agent
* Tool marketplace

这些都不是当前产品需要的。

核心 Loop：

```text
Prompt
 ↓
LLM
 ↓
Tool Call
 ↓
Tool Result
 ↓
LLM
 ↓
Final response
```

Vercel AI SDK 负责底层 Agent Loop。

---

# 30. 当前确定的技术方向

目前：

```text
Shell:
    Zsh

Shell Integration:
    Zsh plugin / middleware

Agent Runtime:
    自研轻量 Runtime

LLM SDK:
    Vercel AI SDK

Agent Backend:
    不使用 Codex / Claude Code / Pi 等成熟 Code Agent

Tool:
    suggest_command

Execution:
    用户按 Enter 执行

Unstuck Permission:
    不允许直接执行命令

Terminal:
    Terminal Emulator agnostic

MVP:
    优先实现 Zsh
```

---

# 31. 当前尚未确定的问题

以下问题允许 Code Agent 进行调研和实验：

## A. Zsh Buffer 获取/修改

确认：

* ZLE BUFFER 获取方式
* CURSOR 获取方式
* BUFFER 写回方式
* multiline command
* multiline prompt
* paste
* Unicode
* IME
* autosuggestion 插件兼容性
* syntax highlighting 插件兼容性

---

## B. `accept-line` Hook

研究：

* 如何安全包装原始 `accept-line`
* 如何调用 `.accept-line`
* 如何避免递归
* Ctrl+M
* Ctrl+J
* 自定义 keymap
* viins / vicmd
* emacs mode
* 与 Oh My Zsh 插件兼容

---

## C. Shell Command Detection

研究：

* builtin
* alias
* function
* executable
* shell grammar
* pipelines
* redirects
* command substitution
* assignment
* `&&`
* `||`
* subshell
* compound commands

目标：

> 最大限度保持原始 Zsh 行为。

---

## D. Exit Code / Lifecycle

研究：

```text
preexec
precmd
TRAPZERR
```

以及：

* `$?`
* pipeline exit status
* subshell
* background process
* jobs
* Ctrl+C
* Ctrl+Z

---

## E. Output Capture

这是重点研究项目。

需要比较：

```text
Zsh hooks
vs
FD duplication
vs
PTY sidecar
vs
Terminal integration
```

并测试：

```text
普通命令
stdout
stderr
pipeline
interactive program
vim
ssh
tmux
less
top
Ctrl+C
Ctrl+Z
terminal resize
Unicode
大量输出
```

---

## F. Timeout

研究：

```text
命令开始时间
命令结束时间
前台进程
background job
```

第一阶段只需要：

```text
命令完成后判断 duration
```

实时 timeout AI 属于后续版本。

---

## G. AI UI

研究：

* 如何在 Shell output 底部渲染
* 如何不破坏 prompt
* multiline
* terminal resize
* ANSI escape
* cursor positioning
* redraw
* AI streaming
* command suggestion 的视觉表现

---

## H. Shell Buffer 与 AI UI 的协调

研究：

```text
AI response
 ↓
suggest_command
 ↓
BUFFER
```

如何做到：

* 用户可以修改
* Esc 取消
* Enter 执行
* ↑ / ↓
* Ctrl+C
* Ctrl+U
* Ctrl+A / Ctrl+E
* history

等行为自然工作。

---

# 32. 不要过早支持多 Shell

第一阶段：

```text
Zsh only
```

第二阶段再考虑：

```text
Bash
Fish
```

等。

如果未来扩展，抽象目标应该是：

```text
Shell Adapter
```

例如：

```text
ShellAdapter
├── ZshAdapter
├── BashAdapter
└── FishAdapter
```

但不要为了这个接口提前制造复杂架构。

---

# 33. 推荐项目架构

可以从简单版本开始：

```text
unstuck/
│
├── plugin/
│   └── zsh/
│       ├── unstuck.zsh
│       ├── accept-line.zsh
│       ├── lifecycle.zsh
│       ├── context.zsh
│       └── ui.zsh
│
├── runtime/
│   ├── agent/
│   ├── context/
│   ├── tools/
│   └── ui/
│
├── package/
│
└── docs/
```

具体语言尚未完全确定。

如果采用 Vercel AI SDK，则 Agent Runtime 很自然地使用：

```text
TypeScript / Node.js
```

但 Shell Integration 与 Runtime 的通信方式仍然需要研究。

候选：

```text
Unix Domain Socket
stdin/stdout
HTTP localhost
WebSocket
```

对于本地 Agent Runtime，优先研究：

```text
Unix Domain Socket
```

或简单的 localhost HTTP。

不要为了性能过早优化。

---

# 34. Runtime 与 Zsh 的关系

推荐：

```text
Zsh Plugin
    │
    │ local IPC
    ▼
Unstuck Runtime
    │
    ▼
Vercel AI SDK
    │
    ▼
LLM
```

这样：

Zsh Plugin：

* 轻量
* 快速
* 只负责 Shell Integration

Runtime：

* Agent
* LLM
* Streaming
* Tool Calling
* Context
* UI protocol

这样可以避免把大量逻辑塞进 `.zshrc`。

---

# 35. 性能原则

正常 Shell 命令：

```text
git status
ls
cd
npm
docker
```

不能因为 Unstuck 的存在产生明显延迟。

尤其：

> **正常 Shell 命令不应该调用 LLM。**

理想路径：

```text
accept-line
 ↓
classification
 ↓
normal shell
```

AI 只在：

```text
natural language
command not found
execution error
timeout
```

等情况下触发。

---

# 36. AI 应该“隐形存在”

产品体验目标：

> **AI should be invisible until useful.**

正常情况下：

```text
$ git status
```

用户根本感觉不到 Unstuck 存在。

只有：

```text
$ 帮我找...
```

或者：

```text
$ dockre ps
command not found
```

才出现：

```text
✦ Unstuck
```

---

# 37. MVP Definition

MVP 最低闭环：

### 场景 1：自然语言

```text
用户输入自然语言
        ↓
accept-line
        ↓
Agent
        ↓
suggest_command
        ↓
BUFFER
        ↓
用户 Enter
        ↓
Shell 执行
```

### 场景 2：command not found

```text
dockre ps
        ↓
command not found
        ↓
Agent
        ↓
suggest_command
        ↓
docker ps
        ↓
BUFFER
```

### 场景 3：command error

```text
docker ps -all
        ↓
exit code != 0
        ↓
Agent
        ↓
suggest_command
        ↓
docker ps -a
        ↓
BUFFER
```

如果这三个场景完整工作，MVP 核心就成立。

---

# 38. MVP 暂时不做

以下内容暂时不要实现：

```text
多 Agent
Subagent
MCP
复杂 Memory
Agent Checkpoint
Agent Swarm
自动执行命令
自动 sudo
自动修改文件
完整 Code Agent
完整 TUI
Terminal Emulator 专属插件
Bash/Fish
复杂权限系统
```

除非探索过程中发现某项是实现 MVP 的必要条件。

---

# 39. Code Agent 的工作方式

实现时不要直接开始写大量代码。

应该先进行技术 Spike。

推荐顺序：

## Spike 1

证明：

```text
Zsh accept-line
    ↓
获取 BUFFER
    ↓
调用外部程序
    ↓
返回
```

---

## Spike 2

证明：

```text
Agent
 ↓
Vercel AI SDK
 ↓
suggest_command
 ↓
Zsh BUFFER
```

完整跑通。

---

## Spike 3

测试：

```text
normal command
natural language
invalid command
builtin
alias
function
pipeline
redirect
```

---

## Spike 4

研究：

```text
preexec
precmd
TRAPZERR
```

获取：

```text
last command
exit code
duration
```

---

## Spike 5

研究 Output Capture。

不要假设某种方案可行。

应该做实验并记录：

```text
普通命令
stderr
stdout
interactive program
Ctrl+C
Ctrl+Z
resize
tmux
ssh
```

---

## Spike 6

AI UI / ZLE redraw。

验证：

```text
AI output
 ↓
suggest_command
 ↓
BUFFER
 ↓
用户编辑
 ↓
Enter
```

---

# 40. 最终验收标准

## 正常 Shell

```bash
git status
ls
cd ..
export FOO=bar
alias
function foo() {}
```

行为应该与原 Zsh 一致。

---

## 自然语言

输入：

```text
找出当前目录最大的10个文件
```

应该：

1. 不执行自然语言。
2. 唤起 AI。
3. AI 给出解释。
4. AI 调用 `suggest_command`。
5. 命令进入 BUFFER。
6. 用户可以编辑。
7. Enter 执行。

---

## 错误命令

```bash
dockre ps
```

应该：

1. Shell 报错。
2. AI 自动出现。
3. AI 获取错误上下文。
4. 给出建议。
5. 建议进入 BUFFER。
6. 用户确认执行。

---

## 安全性

任何情况下：

> AI 不应该未经用户按 Enter 就执行 Shell Command。

---

# 41. 最终产品原则

整个项目实现过程中始终遵守下面几条：

### Principle 1

> **Do not replace the shell.**

不要创建新的 Shell 语言。

---

### Principle 2

> **AI is a fallback, not the primary interface.**

Shell 永远是第一入口。

---

### Principle 3

> **AI never executes commands.**

AI 只能建议。

---

### Principle 4

> **The suggested command becomes the real Shell Buffer.**

不要要求用户复制粘贴。

---

### Principle 5

> **Structured data belongs to the Agent Runtime, not the user interface.**

用户看到自然语言和漂亮的命令建议，而不是 JSON。

---

### Principle 6

> **Prefer a tiny Agent over a full Code Agent.**

当前产品不需要 Code Agent 那套复杂 Runtime。

---

### Principle 7

> **Use existing infrastructure where it is strong.**

LLM / Streaming / Tool Calling：

```text
Vercel AI SDK
```

Shell Integration：

```text
Zsh / ZLE
```

不要重复造轮子。

---

### Principle 8

> **Normal shell usage must remain fast and boring.**

用户正常使用 Shell 时，AI 应该完全隐形。

---

# 42. 一句话产品定义

> **一个不替换现有 Shell 的 AI Middleware：用户继续使用熟悉的 Zsh；当输入自然语言、命令不存在、命令执行失败或其他异常情况出现时，AI 自动介入分析，并通过 `suggest_command` 将可执行的 Shell 命令直接放入用户的 Shell Buffer，由用户最终确认执行。**

# 43. 给实现 Agent 的最终指令

实现过程中：

1. 优先完成最小闭环。
2. 不要提前实现复杂 Agent Framework。
3. 不要引入成熟 Code Agent。
4. 不要让 AI 获得 Shell Execute Tool。
5. 不要为了跨 Shell 过早抽象。
6. 对 Zsh 行为保持最大兼容。
7. 对 Output Capture 不要凭假设实现，先做技术 Spike。
8. 对 PTY 不要默认引入，除非实验确认 Zsh Hook 无法满足需求。
9. 对 Terminal UI 不要过度设计。
10. 每一个尚未确定的技术问题，先实验、记录结果，再决定架构。

**优先级：**

```text
Zsh accept-line
        ↓
BUFFER
        ↓
Agent
        ↓
suggest_command
        ↓
BUFFER
        ↓
Enter
        ↓
正常 Shell 执行
```

先把这条链路做通。

然后再逐步加入：

```text
command not found
        ↓
exit code
        ↓
command output
        ↓
timeout
        ↓
更高级的 AI UI
```

不要反过来。
