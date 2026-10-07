/**
 * Provider presets. Model names change fast, so they are only *suggestions*:
 * `unstuck doctor` proves the chosen model actually does tool calling instead
 * of trusting this table.
 */

export interface Provider {
  /** id used in config.json */
  id: string;
  /** one-line description shown by `unstuck setup` */
  label: string;
  baseUrl: string;
  /** env vars to look for the key, in order */
  keyEnv: string[];
  /** suggested model id (editable) */
  model: string;
  /** true when the endpoint normally runs on this machine */
  local: boolean;
}

export const PROVIDERS: Provider[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    keyEnv: ["OPENAI_API_KEY"],
    model: "gpt-5.4-mini",
    local: false,
  },
  {
    id: "anthropic",
    label: "Anthropic（OpenAI 兼容端点）",
    baseUrl: "https://api.anthropic.com/v1",
    keyEnv: ["ANTHROPIC_API_KEY"],
    model: "claude-haiku-4-5-20251001",
    local: false,
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    keyEnv: ["DEEPSEEK_API_KEY"],
    model: "deepseek-flash",
    local: false,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    keyEnv: ["OPENROUTER_API_KEY"],
    model: "anthropic/claude-haiku-4.5",
    local: false,
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    keyEnv: ["GROQ_API_KEY"],
    model: "openai/gpt-oss-120b",
    local: false,
  },
  {
    id: "ollama",
    label: "Ollama（本机 11434）",
    baseUrl: "http://127.0.0.1:11434/v1",
    keyEnv: [],
    model: "qwen3:8b",
    local: true,
  },
  {
    id: "lmstudio",
    label: "LM Studio（本机 1234）",
    baseUrl: "http://127.0.0.1:1234/v1",
    keyEnv: [],
    model: "local-model",
    local: true,
  },
  {
    id: "vllm",
    label: "自建 vLLM（OpenAI 兼容）",
    baseUrl: "http://127.0.0.1:8000/v1",
    keyEnv: ["VLLM_API_KEY"],
    model: "local-model",
    local: true,
  },
];

export function findProvider(id: string): Provider | undefined {
  return PROVIDERS.find((provider) => provider.id === id);
}

/** Local endpoints probed by `setup` before asking the user anything. */
export const LOCAL_PROBES = [
  { baseUrl: "http://127.0.0.1:11434/v1", provider: "ollama" },
  { baseUrl: "http://127.0.0.1:1234/v1", provider: "lmstudio" },
  { baseUrl: "http://127.0.0.1:8000/v1", provider: "vllm" },
];
