/**
 * Environment redaction.
 *
 * The context includes the shell's environment so the model can reason about
 * PATH, toolchains and locale. A BYOK setup exports the user's own API keys, so
 * shipping the raw env means mailing one provider's key to another — redaction
 * is on by default and `full` must be asked for explicitly.
 */

export type EnvMode = "redacted" | "full" | "none";

const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH|SESSION_ID)/i;

export function isEnvMode(value: string): value is EnvMode {
  return value === "redacted" || value === "full" || value === "none";
}

export interface RedactionReport {
  text: string;
  /** names of the variables that were masked */
  masked: string[];
}

export function redactEnv(env: string, mode: EnvMode): RedactionReport {
  if (mode === "full") return { text: env, masked: [] };
  if (mode === "none") return { text: "", masked: [] };

  const masked: string[] = [];
  const lines = env
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const separator = line.indexOf("=");
      if (separator <= 0) return line;
      const name = line.slice(0, separator);
      if (!SECRET_NAME.test(name)) return line;
      masked.push(name);
      return `${name}=[redacted]`;
    });

  return { text: lines.join("\n"), masked };
}

/** Best-effort masking for secrets that commands print in otherwise useful output. */
export function redactOutput(output: string, mode: EnvMode): RedactionReport {
  if (mode === "full") return { text: output, masked: [] };
  if (mode === "none") return { text: "", masked: [] };

  const masked: string[] = [];
  let text = output.replace(
    /(\b[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|AUTH)[A-Za-z0-9_]*\s*[=:]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s\n]+)/gi,
    (match, prefix: string) => {
      masked.push("secret assignment");
      return `${prefix}[redacted]`;
    },
  );
  text = text.replace(/(\bAuthorization\s*:\s*(?:Bearer|Basic)\s+)[^\s]+/gi, (_match, prefix: string) => {
    masked.push("authorization header");
    return `${prefix}[redacted]`;
  });
  text = text.replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})\b/g, () => {
    masked.push("token pattern");
    return "[redacted]";
  });

  return { text, masked: [...new Set(masked)] };
}
