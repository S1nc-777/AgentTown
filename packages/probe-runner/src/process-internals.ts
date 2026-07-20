import {
  execFile,
  spawn,
  type ChildProcess
} from "node:child_process";
import type { PtyOptions, RunResult } from "./pty.js";

const INTERRUPT_GRACE_MS = 2_000;
const WINDOWS_TREE_KILL_TIMEOUT_MS = 2_000;
const WINDOWS_TREE_KILL_HARD_TIMEOUT_MS = 2_250;
const PROCESS_CLOSE_GRACE_MS = 1_000;

type TaskkillError = Error & {
  code?: string | number | null;
  killed?: boolean;
};

export interface TaskkillProcess {
  kill(signal?: NodeJS.Signals | number): boolean;
}

export type TaskkillLauncher = (
  pid: number,
  timeoutMs: number,
  callback: (error: TaskkillError | null) => void
) => TaskkillProcess;

interface WindowsTerminationOptions {
  launchTaskkill?: TaskkillLauncher;
  taskkillTimeoutMs?: number;
  hardTimeoutMs?: number;
}

interface RunProcessDependencies {
  platform?: NodeJS.Platform;
  terminateWindowsProcessTree?: (pid: number) => Promise<void>;
  killDirectChild?: (child: Pick<ChildProcess, "kill">) => boolean;
  processCloseGraceMs?: number;
}

const launchTaskkill: TaskkillLauncher = (pid, timeoutMs, callback) => execFile(
  "taskkill.exe",
  ["/PID", String(pid), "/T", "/F"],
  { windowsHide: true, timeout: timeoutMs },
  (error) => callback(error)
);

function describeTaskkillFailure(pid: number, error: TaskkillError): Error {
  if (error.code === "ETIMEDOUT" || error.killed === true) {
    return new Error(`taskkill timed out while terminating Windows process tree ${pid}`, { cause: error });
  }
  if (error.code !== undefined && error.code !== null) {
    return new Error(`taskkill failed with code ${String(error.code)} for Windows process tree ${pid}`, { cause: error });
  }
  return new Error(`taskkill failed for Windows process tree ${pid}: ${error.message}`, { cause: error });
}

export function terminateWindowsProcessTree(
  pid: number,
  options: WindowsTerminationOptions = {}
): Promise<void> {
  const invokeTaskkill = options.launchTaskkill ?? launchTaskkill;
  const taskkillTimeoutMs = options.taskkillTimeoutMs ?? WINDOWS_TREE_KILL_TIMEOUT_MS;
  const hardTimeoutMs = options.hardTimeoutMs ?? WINDOWS_TREE_KILL_HARD_TIMEOUT_MS;

  return new Promise((resolve, reject) => {
    let settled = false;
    let taskkill: TaskkillProcess | undefined;
    let hardTimer: NodeJS.Timeout | undefined;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      if (hardTimer) clearTimeout(hardTimer);
      if (error) reject(error);
      else resolve();
    };

    try {
      taskkill = invokeTaskkill(pid, taskkillTimeoutMs, (error) => {
        if (error) finish(describeTaskkillFailure(pid, error));
        else finish();
      });
    } catch (error) {
      finish(new Error(`taskkill failed to start for Windows process tree ${pid}`, {
        cause: error
      }));
      return;
    }

    if (settled) return;
    hardTimer = setTimeout(() => {
      try {
        taskkill?.kill("SIGKILL");
        finish(new Error(
          `taskkill did not report completion while terminating Windows process tree ${pid}`
        ));
      } catch (error) {
        finish(new Error(
          `taskkill hard-kill threw while terminating Windows process tree ${pid}`,
          { cause: error }
        ));
      }
    }, hardTimeoutMs);
  });
}

function copyEnvironment(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...overrides };
}

export function runProcessWithDependencies(
  options: PtyOptions,
  overrides: RunProcessDependencies = {}
): Promise<RunResult> {
  const platform = overrides.platform ?? process.platform;
  const terminateTree = overrides.terminateWindowsProcessTree ?? terminateWindowsProcessTree;
  const killDirectChild = overrides.killDirectChild ?? ((child) => child.kill("SIGKILL"));
  const processCloseGraceMs = overrides.processCloseGraceMs ?? PROCESS_CLOSE_GRACE_MS;
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
  let windowsTerminationError: Error | undefined;
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
    const settleIfReady = () => {
      if (settled || !closed || windowsTerminationPending) return;
      settled = true;
      clearTimers();
      if (windowsTerminationError) {
        reject(windowsTerminationError);
        return;
      }
      resolve({
        command: [options.file, ...options.args],
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        exitCode,
        rawOutput,
        timedOut
      });
    };
    const waitForClose = () => {
      settleIfReady();
      if (settled || closed || closeTimer) return;
      closeTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearTimers();
        const message = windowsTerminationError
          ? "Failed to terminate the Windows process tree and its direct child did not close"
          : "Timed out waiting for the Windows process tree to close";
        reject(new Error(message, { cause: windowsTerminationError }));
      }, processCloseGraceMs);
    };
    const killDirectChildAndWait = (treeError?: Error) => {
      windowsTerminationPending = false;
      windowsTerminationError = treeError;
      try {
        if (!closed) killDirectChild(child);
      } catch (error) {
        const directKillError = error instanceof Error ? error : new Error(String(error));
        windowsTerminationError = treeError
          ? new AggregateError(
            [treeError, directKillError],
            "Windows tree cleanup and direct-child kill both failed"
          )
          : new Error("Direct-child kill threw after Windows tree termination", {
            cause: directKillError
          });
      } finally {
        waitForClose();
      }
    };
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      if (platform === "win32" && child.pid !== undefined) {
        windowsTerminationPending = true;
        void terminateTree(child.pid).then(
          () => {
            killDirectChildAndWait();
          },
          (error: unknown) => {
            killDirectChildAndWait(
              error instanceof Error ? error : new Error(String(error))
            );
          }
        );
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
      settleIfReady();
    });
  });
}
