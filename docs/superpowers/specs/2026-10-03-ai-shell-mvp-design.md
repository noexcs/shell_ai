# AI Shell MVP — 设计与技术方案（Spec）

> 上游文档：`PRODUCTION_DESIGN.md`（产品约束，不得违背）。
> 上游结论：2026-10-03 可行性实测（本文 §2 是其结论落地）。
> 状态：**已实现**（2026-10-03）。验收证据：`npm run test:unit` 11/11；`python3 test/e2e.py` 5/5 场景通过（A1–A5，pty 驱动 + 真实 LLM 调用，22s）。

## 1. MVP 功能清单

### 1.1 做（三场景闭环）

| # | 场景 | 触发器 | 用户可见行为 |
|---|---|---|---|
| S1 | 自然语言 | `accept-line` widget 预判 | 该行**不交给 zsh 执行**；AI 面板流式出现；建议命令进入真 buffer，光标可编辑，Enter 才执行 |
| S2 | command not found | `command_not_found_handler` | 保留 zsh 原始报错，AI 面板紧随其后；建议命令在**下一个提示符**已就位 |
| S3 | 命令执行失败（exit != 0） | `precmd` | 命令输出保持不变；AI 面板插在命令输出与新提示符之间；建议命令在下一个提示符就位 |

// 不需要屏蔽原始ZSH提示，预判逻辑怎么写的？

三者共用同一个 runtime 调用与同一套面板渲染。

### 1.2 不做（明确排除，避免范围蔓延）

不捕获命令输出（用户决策）；不做长命令实时 AI（用户决策）；不做常驻 daemon / WebSocket / UDS；不做多 shell（zsh only）；不做 Bash/Fish；不做 TUI / alternate screen / 鼠标；不做 permission 系统、subagent、memory、MCP、checkpoint；不自动执行任何命令；不接 Codex/Claude Code 等成熟 agent backend。

### 1.3 明确的功能性削减（与 PRODUCTION_DESIGN §10/§24 的差异）

- 面板是**纯 stdout 文本**（带少量 SGR 颜色），不使用框线/浮动窗；不用 `zle -M`。
- 不打印 `Enter 执行 · Esc 关闭` 之类操作提示：已打印的历史文本无法撤回，提示无意义（PRODUCTION_DESIGN §10/§24 的示意里有，此处按实际取舍去掉）。
- 不提供"Esc 关闭面板"（面板是已打印的历史文本，无法撤回）；提供 `Ctrl+U`/Backspace 修改已注入的命令。

## 2. 已实测的技术前提（实现依据，全部本机实测）

| # | 结论 | 证据 |
|---|---|---|
| P1 | `zle -N accept-line f` + `zle .accept-line` 可用，包裹函数运行在父 shell，无递归 | pty 实测，`$sysparams[pid]` 一致 |
| P2 | `command_not_found_handler` **运行在子 shell** | CNF 内 pid 79557 ≠ 提示符 79496；CNF 内改全局变量、`print -z` 均到不了父 shell |
| P3 | `BUFFER=`/`CURSOR=` 仅在 **widget 上下文**生效；`zle -F` handler 内直接赋值无效，必须 `zle <widget>` 间接调用 | 实测两种写法 A/B |
| P4 | 面板打印必须单子进程；zsh 每 fork 一次子进程，SIGCHLD 后 ZLE 重绘 prompt，造成输出交错 | `tok1 / P> fb / tok2` 交错 vs 单子进程干净 |
| P5 | 阻塞 widget 期间用户键入不丢失，会追加到注入 buffer 尾部 | 等待期发 `XYZ` → buffer 变 `echo X…XYZ` |
| P6 | 含未闭合 `(` 的输入进入 PS2 续行而非报错；`zsh -n -c` 对不完整输入返回 0，无法用于探测 | `帮我(找出` → `>` 续行；`zsh -n -c 'echo ('` rc=0 |
| P7 | 含 `/` 的路径不触发 CNF | `./nope` → `zsh: no such file or directory`，handler 未调用 |
| P8 | 目标模型稳定支持 streaming tool calling，且**同时**输出自然语言与结构化 tool call | deepseek-flash 1.78s、自建 Qwen3.8-27B 4.3s，均 `finish_reason: tool_calls` |
| P9 | Node 26 直接执行 `.ts`（type stripping），无需构建步骤 | `node /tmp/t.ts` 输出正常 |
| P10 | `zle -I; <print>; zle reset-prompt` 可重绘提示符 | 实测面板输出后提示符正确重建 |

## 3. 架构

```
┌─ terminal ─────────────────────────────────────────────┐
│                                                        │
│  zsh ── plugin/zsh/*.zsh                                │
│   ├─ accept-line widget ─┐                              │
│   ├─ command_not_found_handler ─┼─► (阻塞)              │
│   ├─ precmd ─────────────┘      │                      │
│   └─ zle-line-init ◄── pending 文件                     │
│                                  │ NUL 分隔 stdin       │
│                                  ▼                      │
│                    node runtime/main.ts (单进程)         │
│                       └─ ai@7 + @ai-sdk/openai-compatible         │
│                            tool: suggest_command (无 execute)
└────────────────────────────────────────────────────────┘
```

- **无常驻进程**：每次 fallback 起一个 node 进程（实测冷启 29ms，仅 fallback 路径付出）。
- **正常命令零开销**：accept-line 只做内建判定，不 fork、不联网（见 §4.1）。
- **单进程流式**：P4 —— runtime 是唯一子进程，所有流式渲染都在它内部完成。

### 3.1 三条触发路径的数据流

**S1（自然语言）** — 阻塞发生在 widget 内，结果直接写 `BUFFER`：

```
accept-line widget
  └ _ai_should_intercept? 否 → zle .accept-line（原样）
  └ 是 → zle -I（清提示符显示）
         node runtime ask --command-out $SESSION/pending < context  (阻塞、流式渲染面板)
         BUFFER=$(<$SESSION/pending); CURSOR=$#BUFFER
         AI_SHELL_SUPPRESS_EXIT=1        # 防止随后 precmd 把旧的 $? 当新失败
         rm -f $SESSION/pending
         zle reset-prompt
```

**S2（命令不存在）** — CNF 在子 shell（P2），故：AI 阻塞在子 shell 内完成渲染；建议经**文件**交给父 shell 的 `zle-line-init`（P3 允许 widget 内赋值）：

```
command_not_found_handler <cmd>
  └ touch $SESSION/cnf-handled                       # 抑制 S3 重复触发
  └ node runtime ask --command-out $SESSION/pending < context   # 面板渲染在错误下方
  └ return 127                                        # 保留退出码语义，且不打印 zsh 原始提示
父 shell 下个提示符：
  zle-line-init → [[ -s $SESSION/pending ]] && BUFFER=$(<...) && rm -f pending
```

**S3（执行失败）**：

```
precmd
  ├ [[ -f $SESSION/cnf-handled ]] → rm; skip           # S2 已处理
  ├ [[ -n $AI_SHELL_SUPPRESS_EXIT ]] → unset; skip     # 上一行是 S1 拦截，$? 是陈旧的
  ├ [[ $? -eq 0 || $? -eq 130 ]] → skip                # 成功 / 用户 Ctrl+C
  ├ [[ 命令名 ∈ IGNORE_LIST ]] → skip                  # 预期失败：grep/diff/test/…
  └ node runtime ask --command-out $SESSION/pending < context   # 面板在提示符之前
```

## 4. 关键机制设计

### 4.1 热路径判定（S1，必须 O(1)、无 fork、无网络）

```zsh
_ai_should_intercept() {
  [[ $BUFFER == *[^[:ascii:]]* ]] || return 1   # 纯 ASCII 一律交给 shell（拼写错误走 S2）
  local -a w=(${(z)BUFFER})
  whence -w -- "$w[1]" >/dev/null 2>&1 && return 1   # 首词可解析（如 `cat 文件.txt`）→ 交给 shell
  return 0
}
```

保守原则（PRODUCTION_DESIGN §15）：**只有含非 ASCII 且首词不可解析**才拦。因此 `find the biggest files` 这类纯 ASCII 自然语言不被拦，交给 shell → 报错 → 由 S3 兜底（这是刻意的：宁可少触发，不可误拦）。

该判定同时解掉 P6：`帮我(找出` 首词 `帮我` 不可解析 → 在 accept-line 阶段被拦截，不会掉进 PS2 续行。

### 4.2 面板渲染（runtime 侧）

runtime 直接把人类可读文本写到 stdout（zsh 不做 JSON 解析）：

```
✦ AI — shell 助手
│ <模型自然语言输出，逐 token 流式>
│ → find . -type f -exec du -h {} + | sort -rh | head -n 10
│ Qwen3.8-27B · 4.3s
```

- 模型的思考流（reasoning_content）默认只用于一行状态 `正在分析…`，内容不打印；`AI_SHELL_SHOW_THINKING=1` 时打印。状态行在请求发出时就显示，不等首个 token——自建 vLLM 不一定推 reasoning delta。
- 面板内容每行前缀一个 dim 的 `│ `：AI 输出必须与命令输出一眼可分（用户实测反馈），且纯文本、不依赖终端能力。空行不加前缀。
- 面板前**始终**有一个空行，把面板与上面的内容（命令输出、报错、被拦截的那行）分开。
- `→` 而不是 `❯` 标记建议命令：starship 等提示符本身就用 `❯`，同形会让面板那行看起来像"命令已经执行过"。
- 解释的处理：模型给了自然语言时，`suggest_command.explanation` 折叠成**行尾注释**附在命令后（随命令进历史）；仅当 shell 开启 `interactive_comments` 时才这样做（`--comment` 标志），否则 `# …` 会被当作参数，此时回退为面板里的独立一行。命令以 `|`/`&`/`\`/`,`/`(`/`=` 结尾时同样回退（注释会被语法吞掉）。
- 面板末尾一行 dim 的 `模型 · 耗时`（`AI_SHELL_VERBOSE=0` 关闭）。不打印"Enter 执行…"之类的操作提示——用户对 Enter 的预期不需要教。
- 面板末尾再空一行：把面板与下面的提示符分开；同时它是"牺牲行"——ZLE 在 widget 内重绘提示符时若覆盖最后一行，被吃掉的是空行而不是 `模型 · 耗时`。
- 颜色仅在 `[ -t 1 ]` 时输出；`AI_SHELL_NO_COLOR=1` 关闭。

### 4.3 上下文协议（stdin，NUL 分隔，固定顺序）

zsh 侧**不构造 JSON**，用 `print -rn -- "$v"$'\0'` 逐字段输出，runtime 按 `\0` 切分 —— 任意内容（换行、引号、控制字符）安全，无转义负担。

| # | 字段 | 来源 |
|---|---|---|
| 1 | `version` | 常量 `1` |
| 2 | `shell` | `zsh` |
| 3 | `cwd` | `$PWD` |
| 4 | `buffer` | `$BUFFER`（S1）/ 触发命令（S2/S3） |
| 5 | `last_command` | `$1`（preexec）/ CNF 参数 |
| 6 | `exit_code` | 数字或空 |
| 7 | `trigger` | `nl` \| `command_not_found` \| `non_zero_exit` |
| 8 | `history` | 最近 20 条，`\n` 连接（`$history` 尾部，过滤空行） |
| 9 | `env` | `env` 全量输出（用户决策：完整注入） |
| 10 | `command_out` | pending 文件绝对路径（runtime 也可直接用 `--command-out`，二者一致即可） |
| 11 | `platform` | `uname -srm` —— 让模型避开本机没有的 GNU 独有工具（冒烟实测：缺此字段时它给出 `numfmt`，macOS 无） |

env/history 在 runtime 侧截断：env 最多 8 KiB、history 最多 40 行（防 prompt 爆炸）。

**上下文卫生**：runtime 追加的 `  # 理由` 在进入上下文前会被剥掉（`plugin/zsh/context.zsh`）。实测教训：带着注释回传时，模型会去分析自己的注释（把 docker 守护进程未启动误判成"interactive_comments 没开"），而不是真正的失败原因。

### 4.4 结构化输出契约（唯一的机器可读结果）

建议命令**只走文件**：`--command-out <path>`，内容 = 纯命令文本（无换行）。写入用「写临时文件 + rename」保证原子性。文件不存在 = 模型未给建议。zsh 侧 `$(<file)` 读取，**永不 eval**。

标准输出**不承载机器语义**，因此 zsh 侧不需要解析器、不需要 jq。

### 4.5 安全边界（结构性，而非策略性）

- 模型输出 → `BUFFER=` 赋值 → 用户按 Enter → zsh 执行。**不存在任何把模型输出交给 `eval`/`sh -c`/`exec` 的代码路径**。
- `suggest_command` 工具**不定义 `execute`**（AI SDK 7 明确支持"转发到客户端/队列"的用法），因此 runtime 内不存在"模型→执行"的 API 面。
- runtime 进程本身不 spawn 任何子进程。
- 已知残余风险：完整 env（含密钥）会随请求发给 LLM 端点（用户已确认接受；当前端点是自建 vLLM）。

### 4.6 会话状态

```
AI_SHELL_SESSION_DIR=${TMPDIR:-/tmp}/ai-shell-$UID-$ZSH_PID
  pending        建议命令（单槽，读到即删）
  cnf-handled    S2→S3 抑制标记
  log            AI_SHELL_LOG=1 时的调用记录（触发原因、耗时、是否写建议）
```

目录在插件加载时创建，`zshexit` 时删除。多 shell 会话天然隔离。

## 5. 文件布局

```
shell_ai/
├── PRODUCTION_DESIGN.md
├── docs/superpowers/specs/2026-10-03-ai-shell-mvp-design.md   ← 本文
├── package.json                     # deps: ai@7, @ai-sdk/openai-compatible, zod@4
├── plugin/zsh/
│   ├── ai-shell.zsh                 # 入口：路径解析、会话目录、开关、加载子模块
│   ├── context.zsh                  # NUL 上下文构造 + runtime 调用 + 日志
│   ├── accept-line.zsh              # S1 判定与拦截
│   ├── cnf.zsh                      # S2 command_not_found_handler
│   ├── lifecycle.zsh                # preexec/precmd + 忽略名单 + 抑制标记
│   └── inject.zsh                   # zle-line-init 注入 pending
├── runtime/
│   ├── main.ts                      # CLI：ask / install / version
│   ├── context.ts                   # stdin NUL 解析 + 截断
│   ├── prompt.ts                    # system + user prompt 构造
│   ├── agent.ts                     # AI SDK streamText + tool + 事件回调
│   ├── render.ts                    # 面板流式渲染（颜色、单行建议）
│   └── install.ts                   # install/uninstall：打印或追加 ~/.zshrc
├── sandbox/.zshrc                   # 沙箱：source 插件（ZDOTDIR 指向它）
├── scripts/sandbox.sh               # ZDOTDIR=$PWD/sandbox zsh -i
└── test/
    ├── unit/*.test.ts               # node --test（无外部依赖）
    └── e2e.py                       # pty 驱动三场景 + 性能断言（无外部依赖）
```

## 6. 配置项

| 变量 | 默认 | 作用 |
|---|---|---|
| `AI_SHELL_DISABLE` | 空 | `1` = 完全停用（所有触发点短路） |
| `AI_SHELL_PROVIDER` | 配置文件 | 预设名（openai/anthropic/deepseek/openrouter/groq/ollama/lmstudio/vllm） |
| `AI_SHELL_BASE_URL` | 由 provider 决定 | OpenAI 兼容端点 |
| `AI_SHELL_API_KEY` | 空 | 直接给 key（优先级高于钥匙串） |
| `AI_SHELL_MODEL` | 由 provider 决定 | 传给 provider 的 model id |
| `AI_SHELL_ENV_MODE` | `redacted` | `redacted`/`full`/`none`；`full` 会把含密钥的完整 env 发给端点 |
| `AI_SHELL_BIN` / `AI_SHELL_PLUGIN_DIR` | 自动探测 | 指定 runtime 二进制 / zsh 插件目录 |
| `AI_SHELL_TIMEOUT_MS` | `60000` | 单次调用超时（AbortSignal）。自建 Qwen3.8-27B 实测 6–12s、偶发 >20s，故默认放宽；超时可用 Ctrl+C 提前中断 |
| `AI_SHELL_LOG` | 空 | `1` = 写调用日志（e2e 用它断言"正常命令未调用 AI"） |
| `AI_SHELL_LOG_FILE` | `$AI_SHELL_SESSION_DIR/log` | 日志路径；沙箱固定指向 `<repo>/.ai-shell-e2e/log` |
| `AI_SHELL_SHOW_THINKING` | 空 | `1` = 打印 reasoning |
| `AI_SHELL_VERBOSE` | 开 | 置 `0` 关闭提示行尾部的 `模型 · 耗时` |
| `AI_SHELL_NO_COLOR` | 空 | `1` = 关闭颜色 |
| `AI_SHELL_MAX_EXIT_AI` | `3` | 连续失败触发上限，防刷屏 |
| `AI_SHELL_IGNORE_EXTRA` | 空 | 额外"非零退出属正常"的命令名（空格分隔），补在内置 `AI_SHELL_IGNORE` 之上；只匹配命令首词 |
| `AI_SHELL_BASE_URL` / `AI_SHELL_API_KEY` | 由 provider 决定 | 端点与鉴权；未配置时 runtime 提示运行 `ai-shell setup`（不猜端点，shell 不受影响） |

**解析顺序**：内置默认 < `~/.config/ai-shell/config.json`（mode 600）< 环境变量 < 命令行参数。密钥不放在 config.json 的明文字段里：优先环境变量，其次系统钥匙串（`security`/`secret-tool`），最后才是 `secrets.json` 兜底。未配置时 `ask` 直接提示运行 `ai-shell setup`，不猜端点。

## 7. 验收标准（可执行）

`python3 test/e2e.py` 全绿，且以下断言逐条成立：

| # | 输入 | 断言 |
|---|---|---|
| A1 | `echo hi` / `ls \| head -1` / `alias` / `cd /tmp` | 行为与原生 zsh 一致；日志文件**不新增**记录（证明未调用 LLM，P-性能要求） |
| A2 | `dockre ps` | 保留 `command not found: dockre` 原始报错；面板出现；下个提示符 buffer = 可执行命令（含 `docker`）；日志恰 1 条 `command_not_found` |
| A3 | `帮我找出当前目录最大的10个文件` | 该串未被当作命令执行；面板出现；buffer 非空且首词可解析；**按 Enter 后真的执行**且不产生新的 AI 调用 |
| A4 | `ls -Z`（BSD ls 非法选项，exit 非 0） | 命令输出保留；面板出现在其下方；buffer 得到修正建议 |
| A5 | AI 建议的命令 | 未经 Enter 不产生任何执行痕迹（安全断言：面板出现后立即退出，日志中无执行记录） |
| A6 | 等待期键入 | 记录为已知限制（P5），不崩溃、不卡死 |

## 8. 决策记录（用户已确认）

1. 输出捕获：**不做**（V2 不用输出上下文，只用 command + exit code + cwd + env）。
2. 长命令实时 AI：**无限期推迟**。
3. 调用模式：**阻塞式、无常驻 daemon**。
4. env：**完整注入**（已接受密钥外发风险）。
5. MVP 场景：**三场景全做**，S3 带忽略名单与 `AI_SHELL_DISABLE` 开关。
6. 接入方式：**沙箱 ZDOTDIR**，提供 `ai-shell install` 但绝不自动改 `~/.zshrc`。

## 9. 任务拆解（本次执行顺序）

每个任务以其可观察验证为界：

1. **T1 runtime 骨架**：`package.json` + `context.ts`（NUL 解析与截断）+ 单测 → `node --test` 绿。
2. **T2 agent + render**：`prompt.ts` / `agent.ts` / `render.ts`；手工 CLI 冒烟：喂一段 NUL 上下文，观察面板与 `--command-out` 内容。
3. **T3 zsh 插件**：`ai-shell.zsh` + `context.zsh` + `accept-line.zsh`（S1 先跑通）。
4. **T4 S2/S3 与注入**：`cnf.zsh` + `lifecycle.zsh` + `inject.zsh`。
5. **T5 沙箱与 e2e**：`sandbox/.zshrc` + `scripts/sandbox.sh` + `test/e2e.py`，跑 A1–A5。
6. **T6 install/文档**：`install.ts` + README 使用说明（保持与本文一致）。

## 10. 风险与已知限制

| 风险 | 处理 |
|---|---|
| P5：阻塞期键入追加到建议命令 | 已知限制，文档标注；后续可用 `zsh/system` 的 `sysread -t 0` 排空输入队列验证 |
| S3 误报造成卡顿（grep 等预期失败） | 忽略名单 + 连续失败上限 + 全局开关 |
| 模型偶尔不调用工具或给出危险命令 | 无建议 → 面板提示"未给出建议"、不写 pending；命令始终需用户 Enter；system prompt 明令禁止破坏性/交互式命令 |
| prompt 过大（env/history） | 截断（8 KiB / 40 行） |
| 多行建议命令 | 允许（`BUFFER` 支持多行），但 M1 渲染会分行显示；pending 文件按原样保存 |
| runtime 崩溃/超时 | zsh 侧检查退出码与 pending 是否存在；失败仅打印一行错误，绝不改变 shell 行为 |
| 与时区/代理相关的 API 不通 | 失败时面板提示检查端点可达性，shell 照常 |

## 11. 分发形态（BYOK）

**目标形态**：单文件二进制 + Homebrew tap / install.sh；不依赖用户机器的 Node。

- **二进制**：`scripts/build.sh` 用 `bun build --compile` 产出 `dist/ai-shell`（本机 60MB、冷启动 48ms）。零原生模块，只链系统库，`otool -L` 可验证；`env -i ./dist/ai-shell ask` 实测可跑（PATH 里没有 node）。
- **插件内嵌**：`scripts/gen-plugin.ts` 把 `plugin/zsh/*.zsh` 生成为 `runtime/generated/plugin.ts`，随二进制打包；`ai-shell install` 解出到 `~/.local/share/ai-shell/plugin/zsh/` 再写 `~/.zshrc`。这样 `import.meta.url` 指向 bun 虚拟路径的问题不再影响安装（`/$bunfs/...` 已验证会算错路径）。
- **插件找 runtime**：`AI_SHELL_BIN` → PATH 上的 `ai-shell` → 开发时的 `node runtime/main.ts`。
- **BYOK**：不提供模型服务。`setup` 先探测本机 Ollama(11434)/LM Studio(1234)/vLLM(8000)，否则从 provider 预设里选；密钥存系统钥匙串；`doctor` 用一次真实调用验证所选模型**会调用工具**（这是架构的硬前提）。
- **隐私默认值**：`env_mode=redacted`。BYOK 下用户的 key 就在自己的环境里，不脱敏等于把 A 家的 key 发给 B 家。脱敏在截断之前执行，避免名字被切半而漏匹配。
- **分发前仍需**：macOS 签名/公证（Gatekeeper 会拦未签名二进制）、Linux glibc/musl 两种 target、以及把 `test/e2e.py` 扩成终端/插件管理器兼容矩阵。

## 12. ShellAdapter（多 shell，2026-10-03 起）

核心（`plugin/lib/ai-shell-core.sh`）持有全部策略：触发判定、上下文组装、runtime 桥接、忽略名单、连击上限、pending 交付。每个 shell 只实现适配层：

```
_ai_shell_adapter_init / _finish      注册/注销钩子
_history <n>                          最近 n 条历史
_command_exists <word>                本 shell 能否解析
_supports_comment                     '#' 是否算注释（决定 --comment）
_pending_ready <cmd>                  建议的交付方式
_notice <text>                        一行提示（可为空实现）
_not_found_message <cmd>              本 shell 原样的报错文案
_doctor                               shell 侧自检输出
```

**实测能力矩阵**（同一批 spike，非推断）：

| 机制 | zsh 5.9 | bash 5.3 | PowerShell 7.6 |
|---|---|---|---|
| 执行前拦 Enter | accept-line widget | `bind -x`，**会吃掉这次回车** | PSReadLine key handler |
| 同键放行 | `.accept-line` ✅ | ❌（只能 eval，会坏交互程序） | `AcceptLine()` ✅ |
| 读/改编辑行 | BUFFER / CURSOR | READLINE_LINE / POINT | `$line` + Replace/Insert |
| **免按键预填下一行** | `zle-line-init` ✅ | ❌ 无此机制 | prompt 函数里 `Insert()` ✅ |
| 命令不存在钩子 | ✅ CNF（**子 shell**） | ✅ CNF（**子 shell**） | ❌ 无，需在 Enter 处理器里预判 |
| 退出码 | precmd | PROMPT_COMMAND | prompt 函数 |
| 本仓库 pty e2e | ✅ | ✅（同一套场景） | ❌ 需 ConPTY |

**因此产生的行为差异（已写进 e2e 断言）**：
- bash 不拦 Enter：自然语言会被执行并落到 command-not-found 路径（多一行 `bash: X: command not found`）；zsh 在 accept-line 就拦下、不执行。
- bash 无预填：建议经**一次性回车处理器**交付（空行回车本是 no-op），面板后打印一行提示，比 zsh 多一次回车。
- **空行不重置 `$?`**（两 shell 实测一致）→ 适配层用 `HISTCMD` 判断"是否真的执行了新命令"，否则空行会重复触发 S3、重复消耗模型。
- 注释：bash 默认开 `interactive_comments`（建议直接带行尾注释）；zsh 默认关，需显式 `setopt`。

**加一个新 shell 的步骤**：写 `plugin/<shell>/ai-shell.<ext>`（入口：定位 root、source core+adapter、`_ai_shell_setup`）与 `adapter.<ext>`；在 `runtime/install.ts` 的 `ENTRY`/`RC_FILE` 里登记；`test/e2e.py --shell <name>` 复用场景（差异用 `session.accept()` 与 shell 条件断言表达）。
