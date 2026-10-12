import { spawn as nodeSpawn } from "node:child_process";

/**
 * Open the approval page in the user's default browser. argv arrays only — the
 * URL is never interpolated into a shell string. Best-effort: any failure is
 * swallowed (the URL is also printed to stderr and returned by the tool).
 *
 *   win32   rundll32 url.dll,FileProtocolHandler <url>
 *   darwin  open <url>
 *   other   xdg-open <url> — skipped without DISPLAY / WAYLAND_DISPLAY
 */
export interface OpenBrowserDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  spawn?: (cmd: string, args: string[]) => void;
}

/** Exported for tests: the command a platform would run, or null when there is no desktop to open on. */
export function browserCommand(
  url: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): { cmd: string; args: string[] } | null {
  if (!/^http:\/\/127\.0\.0\.1:\d+\/a\/[A-Za-z0-9_-]+$/.test(url)) return null;
  if (platform === "win32") return { cmd: "rundll32", args: ["url.dll,FileProtocolHandler", url] };
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return { cmd: "xdg-open", args: [url] };
}

export function openBrowser(url: string, deps: OpenBrowserDeps = {}): boolean {
  const c = browserCommand(url, deps.platform ?? process.platform, deps.env ?? process.env);
  if (!c) return false;
  try {
    if (deps.spawn) {
      deps.spawn(c.cmd, c.args);
    } else {
      const child = nodeSpawn(c.cmd, c.args, { detached: true, stdio: "ignore", windowsHide: true, shell: false });
      child.on("error", () => undefined);
      child.unref();
    }
    return true;
  } catch {
    return false;
  }
}
