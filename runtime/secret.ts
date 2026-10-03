/**
 * API-key storage. Order of preference:
 *   1. environment variable (provider-specific, then AI_SHELL_API_KEY)
 *   2. OS keychain (macOS `security`, Linux `secret-tool`)
 *   3. config.json (plaintext, mode 600 — last resort, doctor warns about it)
 *
 * Keeping the key out of the shell's environment is deliberate: it then cannot
 * end up in the env dump we send to the model.
 */

import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const SERVICE = "ai-shell";

export type SecretStore = "keychain" | "secret-tool" | "file";

function configDir(): string {
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "ai-shell");
}

function secretFile(): string {
  return join(configDir(), "secrets.json");
}

function readFileSecrets(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(secretFile(), "utf8")) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Reads the key for `provider` from env or from the OS store. Null when absent. */
export async function lookupSecret(
  provider: string,
  keyEnv: string[] = [],
): Promise<{ value: string; source: string } | null> {
  for (const name of keyEnv) {
    const value = process.env[name];
    if (value) return { value, source: `env:${name}` };
  }
  const explicit = process.env.AI_SHELL_API_KEY;
  if (explicit) return { value: explicit, source: "env:AI_SHELL_API_KEY" };

  if (platform() === "darwin") {
    try {
      const { stdout } = await run("/usr/bin/security", [
        "find-generic-password",
        "-s",
        SERVICE,
        "-a",
        provider,
        "-w",
      ]);
      if (stdout.trim() !== "") return { value: stdout.trim(), source: "keychain" };
    } catch {
      /* not stored */
    }
  } else {
    try {
      const { stdout } = await run("secret-tool", ["lookup", "service", SERVICE, "account", provider]);
      if (stdout.trim() !== "") return { value: stdout.trim(), source: "secret-tool" };
    } catch {
      /* not stored */
    }
  }

  const fromFile = readFileSecrets()[provider];
  if (fromFile) return { value: fromFile, source: "config:secrets.json" };
  return null;
}

export async function storeSecret(provider: string, secret: string): Promise<SecretStore> {
  if (platform() === "darwin") {
    try {
      await run("/usr/bin/security", [
        "add-generic-password",
        "-s",
        SERVICE,
        "-a",
        provider,
        "-w",
        secret,
        "-U",
      ]);
      return "keychain";
    } catch {
      /* fall through to the file */
    }
  } else {
    try {
      await run("secret-tool", ["store", `--label=${SERVICE} ${provider}`, "service", SERVICE, "account", provider], {
        // secret-tool reads the secret from stdin
      });
      return "secret-tool";
    } catch {
      /* fall through to the file */
    }
  }

  mkdirSync(configDir(), { recursive: true });
  const secrets = readFileSecrets();
  secrets[provider] = secret;
  writeFileSync(secretFile(), JSON.stringify(secrets, null, 2), "utf8");
  chmodSync(secretFile(), 0o600);
  return "file";
}

export async function forgetSecret(provider: string): Promise<boolean> {
  let removed = false;
  if (platform() === "darwin") {
    try {
      await run("/usr/bin/security", ["delete-generic-password", "-s", SERVICE, "-a", provider]);
      removed = true;
    } catch {
      /* nothing stored */
    }
  } else {
    try {
      await run("secret-tool", ["clear", "service", SERVICE, "account", provider]);
      removed = true;
    } catch {
      /* nothing stored */
    }
  }
  const secrets = readFileSecrets();
  if (secrets[provider] !== undefined) {
    delete secrets[provider];
    writeFileSync(secretFile(), JSON.stringify(secrets, null, 2), "utf8");
    chmodSync(secretFile(), 0o600);
    removed = true;
  }
  return removed;
}

export function secretsFileExists(): boolean {
  return existsSync(secretFile());
}

export { configDir };
