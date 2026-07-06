/**
 * GUI apps launched via Finder/Dock/Spotlight (not a Terminal) get macOS's
 * bare default PATH (`/etc/paths`: /usr/local/bin, /usr/bin, /bin, ...) -
 * Homebrew on Apple Silicon (/opt/homebrew/bin), nvm, volta, etc. are only
 * on PATH because the user's shell profile (.zshrc/.zprofile) exports them,
 * and GUI launches never source that profile. Any provider that shells out
 * to a CLI (Claude Code, gh, etc.) then looks "not installed" even though a
 * Terminal finds it fine - the classic symptom being "works when I test it
 * myself, missing in the actual app." Fix: resolve the user's real
 * login-shell PATH once at startup and merge it in.
 */

import { execFile } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);
const LOGIN_SHELL_PATH_TIMEOUT_MS = 2_000;

export async function resolveLoginShellPath(shellOverride?: string): Promise<string | null> {
  if (process.platform === "win32") return null;

  const shellPath = shellOverride ?? process.env.SHELL ?? "/bin/zsh";
  try {
    const { stdout } = await execFileAsync(shellPath, ["-ilc", 'echo -n "$PATH"'], {
      timeout: LOGIN_SHELL_PATH_TIMEOUT_MS,
      encoding: "utf8",
    });

    // Some shell configs print a banner/MOTD to stdout before our command
    // runs; PATH itself never contains a newline, so the last non-blank
    // line is safe to take even if earlier lines are noise.
    const lines = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    const lastLine = lines[lines.length - 1];
    return lastLine || null;
  } catch {
    return null;
  }
}

export function mergePathEnv(currentPath: string | undefined, loginShellPath: string): string {
  const current = (currentPath ?? "").split(":").filter(Boolean);
  const fromLoginShell = loginShellPath.split(":").filter(Boolean);
  return [...new Set([...fromLoginShell, ...current])].join(":");
}

/**
 * Best-effort: never throws, leaves `env.PATH` untouched if the login shell
 * can't be resolved (unsupported shell, timeout, sandboxed environment).
 */
export async function fixGuiProcessPath(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const loginShellPath = await resolveLoginShellPath();
  if (!loginShellPath) return;
  env.PATH = mergePathEnv(env.PATH, loginShellPath);
}
