/**
 * Agent runtime: one call per fallback, against an OpenAI-compatible endpoint
 * (default: the self-hosted vLLM serving Qwen3.8-27B).
 *
 * `suggest_command` deliberately has **no `execute`** — the AI SDK treats it as
 * a client-side tool call, so there is no code path in this process that runs
 * anything the model produced. The suggestion is handed back to the caller,
 * which writes it to a file the shell pastes into its line buffer.
 */

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { hasToolCall, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";

import type { ShellContext } from "./context.ts";
import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.ts";
import type { Renderer } from "./render.ts";

export interface Suggestion {
  command: string;
  explanation: string;
}

export interface AgentOptions {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
}

const suggestCommand = tool({
  description:
    "给出恰好一条可直接执行的 shell 命令，交给用户按 Enter 自行执行。本工具不执行任何命令，也没有执行能力。",
  inputSchema: z.object({
    command: z.string().describe("完整、单行、可直接复制粘贴执行的 shell 命令"),
    explanation: z.string().describe("一句话说明为什么是这条命令"),
  }),
});

export async function runAgent(
  ctx: ShellContext,
  renderer: Renderer,
  options: AgentOptions,
): Promise<Suggestion | null> {
  const timeoutMs = options.timeoutMs ?? 60000;
  const provider = createOpenAICompatible({
    name: "ai-shell",
    baseURL: options.baseUrl,
    // Local servers often ignore auth entirely; something must still be non-empty.
    apiKey: options.apiKey === "" ? "unused" : options.apiKey,
  });
  // Own the controller so an aborted run can be reported as such: an abort ends
  // the stream quietly, which would otherwise look like "the model had no idea".
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const startedAt = Date.now();
  const paintStatus = () =>
    renderer.status(`✦ AI 正在分析… ${Math.floor((Date.now() - startedAt) / 1000)}s`);
  // Start waiting feedback immediately: not every server streams reasoning
  // deltas, and a frozen shell with no output reads as a hang.
  let ticker: NodeJS.Timeout | undefined;
  if (process.stdout.isTTY === true) {
    paintStatus();
    ticker = setInterval(paintStatus, 500);
  }

  let suggestion: Suggestion | null = null;
  try {
    const result = streamText({
      model: provider(options.model),
      system: SYSTEM_PROMPT,
      prompt: buildUserPrompt(ctx),
      tools: { suggest_command: suggestCommand },
      // No `execute` ⇒ the SDK must not look for a tool result; stop at the call.
      stopWhen: [hasToolCall("suggest_command"), stepCountIs(2)],
      abortSignal: controller.signal,
      // Errors are turned into a one-line notice by the caller; without this the
      // SDK also dumps its own stack trace into the user's terminal.
      onError: () => {},
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        renderer.text(part.text ?? "");
      } else if (part.type === "reasoning-delta" || part.type === "reasoning") {
        const delta = part.text ?? "";
        if (process.env.AI_SHELL_SHOW_THINKING === "1") renderer.text(delta);
      } else if (part.type === "tool-call") {
        if (part.toolName === "suggest_command") {
          const input = part.input as { command?: unknown; explanation?: unknown } | undefined;
          const command = typeof input?.command === "string" ? input.command.trim() : "";
          if (command !== "") {
            suggestion = {
              command,
              explanation: typeof input?.explanation === "string" ? input.explanation.trim() : "",
            };
          }
        }
      } else if (part.type === "error") {
        throw part.error instanceof Error ? part.error : new Error(String(part.error));
      }
    }
  } finally {
    clearTimeout(timer);
    clearInterval(ticker);
  }

  if (controller.signal.aborted) {
    throw new Error(`AI 调用超时（${timeoutMs}ms），可用 AI_SHELL_TIMEOUT_MS 调整`);
  }
  return suggestion;
}
