# Unstuck

> **命令卡住时，给你下一步，但不替你执行。**

Unstuck 是一个不替换终端、不接管 Shell 的 AI fallback。你继续使用熟悉的
命令行；当命令不存在、执行失败，或者你直接输入自然语言时，Unstuck 才会
出现，解释发生了什么，并把建议命令放进真实的 Shell buffer。只有你按下
Enter，命令才会执行。

```console
$ docker ps --alll
unknown flag: --alll

✦ Unstuck
│ Docker 没有 `--alll` 参数；查看全部容器应使用 `--all`。
│ -> docker ps --all  # 修正参数拼写

$ docker ps --all  # 修正参数拼写
```

Unstuck 不只是看到退出码。配合 [iZSH](https://github.com/noexcs/izsh)，它能读取
刚刚结束的命令、工作目录、退出码、耗时以及对应的 stdout/stderr，因此模型可以
根据真实错误信息分析，而不是猜测。

## 产品边界

- **Shell 是第一入口。** 正常命令不调用模型，也不会增加网络等待。
- **AI 永不执行命令。** 模型只有 `suggest_command`，没有 execute、sudo 或文件修改工具。
- **建议进入真实 buffer。** 可以修改、清空或直接忽略，最终执行权始终属于用户。
- **不接管终端。** 没有 PTY wrapper、全屏 TUI 或专用 Terminal Emulator。
- **采集与智能分离。** iZSH 只产生本地事件；Unstuck 决定读取、脱敏和发送哪些上下文。
- **BYOK。** 直接连接你配置的本地模型或 OpenAI 兼容服务，不经过 Unstuck 服务器。

## iZSH 如何增强 Unstuck

iZSH 为每个终端窗口创建独立 session，并为每条命令写入成对的
`command_start` / `command_end` 事件：

```text
~/.izsh/sessions/<session_id>/
|-- events.ndjson
`-- commands/
    |-- <command_id>.stdout
    `-- <command_id>.stderr
```

Unstuck 在提示符返回前读取当前 session 最新的完成事件，并同时校验：

- `session_id`
- 完整命令文本
- 退出码
- `<session_id>:<command_id>`
- stdout/stderr 必须位于当前 session 的 `commands/` 目录内

因此多个 iZSH 窗口并行运行时不会串读输出。Unstuck 等待 `command_end` 后才读取
文件，每个流默认只保留末尾 32 KiB；包含 NUL 的二进制输出不会进入模型上下文。

没有 iZSH 时，Unstuck 仍可在普通 Zsh 和 Bash 中工作，但失败分析只能使用命令、
退出码、目录、历史和经过处理的环境变量。

## 当前支持

| 能力 | iZSH | 普通 Zsh | Bash 4+ |
|---|---:|---:|---:|
| 自然语言生成命令 | yes | yes | yes |
| command not found 修正 | yes | yes | yes |
| 非零退出分析 | yes | yes | yes |
| 建议直接填入 Shell buffer | yes | yes | 下一次 Enter 填入 |
| 精确读取命令 stdout/stderr | yes | no | no |
| 自动执行模型建议 | **never** | **never** | **never** |

iZSH 当前提供 macOS arm64 预览构建。Unstuck 本身支持 macOS/Linux 上的 Zsh，
以及 Bash 4+；完整输出上下文目前仅在 iZSH 中可用。

## 安装开发版本

项目仍处于早期阶段。当前从源码安装：

```sh
git clone https://github.com/noexcs/unstuck.git
cd unstuck
npm install
npm run build:npm
npm link
```

需要 Node.js 20+ 和 Bun（仅用于构建发布用的单文件 CLI）。然后配置模型并安装
Shell 插件：

```sh
unstuck setup
unstuck doctor
unstuck install --write
```

重新打开终端。如果已经安装 iZSH，直接运行：

```sh
izsh
```

iZSH 会读取相同的 Zsh 启动文件，因此 Unstuck 插件会照常加载，并自动发现
`IZSH_SESSION_ID`、`IZSH_SESSION_DIR` 和 `IZSH_EVENTS_FILE`。

卸载插件加载行：

```sh
unstuck uninstall --write
```

## 配置

配置文件位于 `~/.config/unstuck/config.json`：

```json
{
  "provider": "vllm",
  "base_url": "http://127.0.0.1:8000/v1",
  "model": "Qwen3.8-27B",
  "env_mode": "redacted",
  "output_mode": "redacted",
  "timeout_ms": 60000
}
```

常用环境变量：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `UNSTUCK_DISABLE` | 空 | 非空时完全停用 AI 触发 |
| `UNSTUCK_PROVIDER` | 配置文件 | 模型服务预设 |
| `UNSTUCK_BASE_URL` | provider 默认值 | OpenAI 兼容端点 |
| `UNSTUCK_MODEL` | provider 默认值 | 模型 ID |
| `UNSTUCK_API_KEY` | 空 | 显式 API key；优先使用系统钥匙串 |
| `UNSTUCK_ENV_MODE` | `redacted` | `redacted` / `full` / `none` |
| `UNSTUCK_OUTPUT_MODE` | `redacted` | 命令输出的 `redacted` / `full` / `none` |
| `UNSTUCK_TIMEOUT_MS` | `60000` | 单次模型调用超时 |
| `UNSTUCK_IGNORE_EXTRA` | 空 | 额外忽略非零退出的命令首词 |
| `UNSTUCK_MAX_EXIT_AI` | `3` | 连续失败的最大介入次数 |
| `UNSTUCK_VERBOSE` | 开 | 设为 `0` 隐藏模型名和耗时 |

`unstuck debug --print-context` 是插件调用的底层调试入口，它从标准输入读取同一份
NUL 分隔上下文并逐字打印最终 Prompt，不会调用模型。

## 隐私与数据保留

- 环境变量默认按变量名识别并遮盖 key、token、password 等值。
- 命令输出默认对明显的密钥赋值、Authorization header 和常见 token 格式做尽力脱敏。
- 自动脱敏不可能覆盖所有秘密；敏感工作流可设置 `UNSTUCK_OUTPUT_MODE=none`。
- `full` 会发送未脱敏内容，只应在明确了解风险时使用。
- iZSH 的 session 文件保留在本机 `~/.izsh/sessions/`，当前不会自动清理。
- Unstuck 不读取终端 scrollback，只读取当前命令事件引用的文件。

## 开发

```sh
npm run lint:shell
npm run test:unit
python3 test/e2e.py --jobs 5
python3 test/e2e.py --shell bash --jobs 5
```

iZSH 输出读取器还覆盖了 session 匹配、路径越界、大输出截断、二进制输出和无采集
降级测试。

架构与约束见 [`PRODUCTION_DESIGN.md`](PRODUCTION_DESIGN.md)，早期实现决策见
[`docs/specs/2026-10-03-unstuck-mvp-design.md`](docs/specs/2026-10-03-unstuck-mvp-design.md)。
