import { execFile, spawn } from "node:child_process";
import type { PtyOptions, RunResult } from "./pty.js";

const INTERRUPT_GRACE_MS = 2_000;
const WINDOWS_TREE_KILL_TIMEOUT_MS = 2_000;
const PROCESS_CLOSE_GRACE_MS = 1_000;

function copyEnvironment(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...overrides };
}

function terminateWindowsProcessTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    let hardTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      resolve();
    };
    const taskkill = execFile(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      { windowsHide: true, timeout: WINDOWS_TREE_KILL_TIMEOUT_MS },
      finish
    );
    hardTimer = setTimeout(() => {
      taskkill.kill("SIGKILL");
      finish();
    }, WINDOWS_TREE_KILL_TIMEOUT_MS + 250);
  });
}

export function runProcess(options: PtyOptions): Promise<RunResult> {
  const startedAt = new Date();
  const child = spawn(options.file, options.args, {
    cwd: options.cwd,
    env: copyEnvironment(options.env),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  let rawOutput = "";
  let timedOut = false;
  let settled = false;
  let closed = false;
  let exitCode = -1;
  let windowsTerminationPending = false;
  let escalationTimer: NodeJS.Timeout | undefined;
  let closeTimer: NodeJS.Timeout | undefined;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text: string) => { rawOutput += text; });
  child.stderr.on("data", (text: string) => { rawOutput += text; });

  return new Promise<RunResult>((resolve, reject) => {
    const clearTimers = () => {
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      if (closeTimer) clearTimeout(closeTimer);
    };
    const resolveIfReady = () => {
      if (settled || !closed || windowsTerminationPending) return;
      settled = true;
      clearTimers();
      resolve({
        command: [options.file, ...options.args],
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        exitCode,
        rawOutput,
        timedOut
      });
    };
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      if (process.platform === "win32" && child.pid !== undefined) {
        windowsTerminationPending = true;
        void terminateWindowsProcessTree(child.pid).then(() => {
          windowsTerminationPending = false;
          if (!closed) child.kill("SIGKILL");
          resolveIfReady();
          if (!settled && !closed) {
            closeTimer = setTimeout(() => {
              if (settled) return;
              settled = true;
              clearTimers();
              reject(new Error("Timed out waiting for the Windows process tree to close"));
            }, PROCESS_CLOSE_GRACE_MS);
          }
        });
        return;
      }

      child.kill("SIGINT");
      escalationTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, INTERRUPT_GRACE_MS);
    }, options.timeoutMs);

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      reject(error);
    });
    child.once("close", (code) => {
      closed = true;
      exitCode = code ?? -1;
      resolveIfReady();
    });
  });
}
