# ai-shell

运行在现有 zsh 之上的 **AI fallback 层**。Shell 仍是第一交互入口：只有在你输入自然语言、命令不存在、或命令执行失败时，AI 才介入，并把建议命令**填进真正的 ZLE buffer**——最终执行权始终在你按下 Enter 的那一刻。

> **AI 从不执行命令。** 模型输出只会被贴进 `BUFFER`，本仓库不存在任何把模型输出交给 `eval` / `sh -c` / `exec` 的代码路径；`suggest_command` 工具也没有 `execute`。
> **模型是你自己的（BYOK）。** 我们不提供模型服务，也不需要你的数据；密钥存在系统钥匙串里，环境变量默认脱敏。

设计文档：[`docs/superpowers/specs/2026-10-03-ai-shell-mvp-design.md`](docs/superpowers/specs/2026-10-03-ai-shell-mvp-design.md) · 产品设计：[`PRODUCTION_DESIGN.md`](PRODUCTION_DESIGN.md)

## 安装

**方式一：npm（约 140KB，无运行时依赖）**

```sh
npm install -g @noexcs/ai-shell
ai-shell install --write    # 写 ~/.zshrc（插件直接用包内的 plugin/zsh）
```

包内是一个 443KB 的打包 CLI（AI SDK 已 bundle，`node_modules` 里不加任何运行时依赖），
所以到用户机器上是"一个文件 + 6 个 .zsh"，没有 60MB 二进制，也没有几十 MB 依赖树。

**方式二：单文件二进制（不需要 Node）**

```sh
npm run build            # 产出 dist/ai-shell（自包含，含 zsh 插件；跨平台用 scripts/build.sh bun-linux-x64）
cp dist/ai-shell ~/.local/bin/
ai-shell install --write # 解出 zsh 插件到 ~/.local/share/ai-shell，并写入 ~/.zshrc
```

**方式二：源码开发**

```sh
npm install
node runtime/main.ts install --write    # 同上，插件直接用仓库里的 plugin/zsh
npm run sandbox                          # 或先用沙箱试：ZDOTDIR=$PWD/sandbox zsh -i
```

改过插件后，**已开着的 shell 需要重载**（插件有加载守护，避免重复注册钩子）：

```sh
ai-shell-reload
```

## 首次配置（BYOK）

```sh
ai-shell setup     # 向导：先探测本机 Ollama/LM Studio/vLLM，否则从预设里选一个
ai-shell doctor    # 自检：插件、配置、端点可达性，以及"这个模型到底会不会调用工具"
```

密钥**只存本机**：优先系统钥匙串（macOS `security` / Linux `secret-tool`），拿不到才退回 `~/.config/ai-shell/secrets.json`（mode 600，`doctor` 会提醒）。也支持直接给环境变量（`OPENAI_API_KEY`、`DEEPSEEK_API_KEY`、`VLLM_API_KEY`… 或 `AI_SHELL_API_KEY`）。

> 客户端侧之所以把密钥放钥匙串而不是导出到环境，有个额外好处：它不会出现在 shell 的 env 里，也就不可能被当作上下文发出去。

## 三个场景

```console
$ dockre ps
zsh: command not found: dockre

✦ AI — shell 助手
│ `dockre` 是 `docker` 的字母顺序打错（不是自然语言）。
│ → docker ps  # 把 dockre 纠正为 docker
│ Qwen3.8-27B · 4.3s

$ docker ps  # 把 dockre 纠正为 docker    ← 已在 buffer，可编辑，Enter 才执行
```

1. **自然语言** — 含非 ASCII 且首词不是可解析命令时拦截，不交给 zsh 执行。
2. **command not found** — 保留 zsh 原始报错，面板紧随其后，建议在下一个提示符就位。
3. **命令失败（exit ≠ 0）** — 面板出现在命令输出与下一个提示符之间。

正常命令（`ls`、`git status`、管道、`cd`、`alias`）不 fork、不联网、不产生任何日志。

## 命令

| 命令 | 作用 |
|---|---|
| `ask` | fallback 路径，被 zsh 插件调用（stdin 读 NUL 上下文） |
| `setup` | 交互式配置模型端点与密钥 |
| `doctor` | 自检 + 工具调用探针 |
| `auth set\|rm\|status <provider>` | 管理密钥（系统钥匙串优先） |
| `debug --print-context` | 打印将要发给模型的内容（含脱敏结果），不发请求 |
| `print-plugin` | 打印 zsh 插件目录（给插件管理器用） |
| `install` / `uninstall [--write]` | 打印或写入 `~/.zshrc` 的加载行 |
| `version` | 版本 |

## 配置

优先级：**内置默认 < `~/.config/ai-shell/config.json` < 环境变量 < 命令行参数**

```json
{
  "provider": "vllm",
  "base_url": "http://127.0.0.1:8000/v1",
  "model": "Qwen3.8-27B",
  "env_mode": "redacted",
  "timeout_ms": 60000
}
```

| 变量 | 默认 | 作用 |
|---|---|---|
| `AI_SHELL_DISABLE` | 空 | 非空即完全停用 |
| `AI_SHELL_PROVIDER` | 配置文件 | 预设名（openai/anthropic/deepseek/openrouter/groq/ollama/lmstudio/vllm） |
| `AI_SHELL_BASE_URL` | 由 provider 决定 | OpenAI 兼容端点 |
| `AI_SHELL_API_KEY` | 空 | 直接给 key（覆盖钥匙串） |
| `AI_SHELL_MODEL` | 由 provider 决定 | 模型 id |
| `AI_SHELL_ENV_MODE` | `redacted` | `redacted` / `full` / `none`——`full` 会把含密钥的完整 env 发出去 |
| `AI_SHELL_TIMEOUT_MS` | `60000` | 单次调用超时（思考型模型实测 4–20s） |
| `AI_SHELL_LOG` / `AI_SHELL_LOG_FILE` | 空 / 会话目录 | 调用日志（测试断言"正常命令无痕"靠它） |
| `AI_SHELL_IGNORE_EXTRA` | 空 | 额外"非零退出属正常"的命令名，空格分隔，如 `"curl docker"` |
| `AI_SHELL_MAX_EXIT_AI` | `3` | 连续失败触发上限，防刷屏 |
| `AI_SHELL_VERBOSE` | 开 | 置 `0` 关闭面板末尾的 `模型 · 耗时` |
| `AI_SHELL_NO_COLOR` / `NO_COLOR` | 空 | 关闭颜色 |
| `AI_SHELL_BIN` / `AI_SHELL_PLUGIN_DIR` | 自动探测 | 指定 runtime 二进制 / zsh 插件目录 |

失败的退出码若来自 `grep`/`diff`/`cmp`/`test`/`[`/`[[`/`rg` 等（内置 `AI_SHELL_IGNORE`）不会触发 AI——它们"失败"是正常语义。注意匹配的是**命令首词**，`git diff --exit-code` 这类"子命令语义"的失败过滤不了。

### 建议命令的解释

模型的简短理由会作为**行尾注释**附在建议命令后面（`docker ps  # 查看所有容器`），这样它随命令进历史。前提是 shell 把 `#` 当注释——zsh **默认不是**：

```sh
setopt interactive_comments   # 放进 ~/.zshrc
```

没有这个选项时插件会自动回退：命令不带注释，理由改为面板里单独一行（因为 `# …` 会被当成参数传给命令）。

## 隐私

- **env 默认脱敏**：`*KEY*/*TOKEN*/*SECRET*/*PASSWORD*/*CREDENTIAL*/*AUTH*` 名字的值替换成 `[redacted]`，且脱敏发生在截断之前（避免名字被切半而漏匹配）。
- `ai-shell debug --print-context` 让你亲眼看到要发出去的内容。
- 密钥优先存系统钥匙串，不进 shell 环境。
- 上下文只含：shell/平台/cwd/命令/退出码/最近历史/（脱敏后的）env/最近 20 条历史。**不含命令输出**（MVP 不做 output capture）。

## 结构

```
plugin/zsh/          zsh 集成（accept-line / command_not_found_handler / precmd / zle-line-init）
runtime/             Node/Bun runtime：NUL 上下文 → OpenAI 兼容端点 → 面板 + --command-out
runtime/generated/   由 scripts/gen-plugin.ts 生成的插件副本（供单文件二进制内嵌）
sandbox/.zshrc       ZDOTDIR 沙箱
test/unit/           node --test
test/e2e.py          pty 三场景 + 脱敏验收（并行，真实 LLM 调用）
```

契约只有两条：**stdin** 是 NUL 分隔的 11 个裸字段（顺序见 `runtime/context.ts`，无需转义）；**stdout** 是给人看的面板，不承载机器语义——建议命令只经 `--command-out` 文件传递，shell 侧用 `$(<file)` 读取，**永不 eval**。

## 测试

```sh
npm run test:unit              # 快，无网络
python3 test/e2e.py            # 6 个场景，3 并发；每个场景独立 pty/日志
python3 test/e2e.py --jobs 5   # 更快
python3 test/e2e.py --only A2  # 单场景
```

## 已知限制

- 等待 AI 期间敲的键不会丢，但会追加到建议命令之后——用 Backspace/Ctrl+U 清掉即可（也可 Ctrl+C 直接中断这次调用）。
- 不提供命令输出内容（MVP 不做 output capture）。
- 长命令运行期间的实时介入不在范围内。
- 面板是已打印的历史文本，没有 Esc 收起。
- 只在 zsh 5.9 / macOS 上做过完整验证；Bash/Fish 未支持。
