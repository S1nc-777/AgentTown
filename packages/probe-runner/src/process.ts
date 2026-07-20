import { spawn } from "node:child_process";
import type { PtyOptions, RunResult } from "./pty.js";

const INTERRUPT_GRACE_MS = 2_000;

function copyEnvironment(overrides: Record<string, string> | undefined): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...overrides };
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
  let escalationTimer: NodeJS.Timeout | undefined;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (text: string) => { rawOutput += text; });
  child.stderr.on("data", (text: string) => { rawOutput += text; });

  return new Promise<RunResult>((resolve, reject) => {
    const timeoutTimer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      child.kill("SIGINT");
      escalationTimer = setTimeout(() => {
        if (!settled) child.kill("SIGKILL");
      }, INTERRUPT_GRACE_MS);
    }, options.timeoutMs);

    child.once("error", (error) => {
      settled = true;
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      reject(error);
    });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      resolve({
        command: [options.file, ...options.args],
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        exitCode: exitCode ?? -1,
        rawOutput,
        timedOut
      });
    });
  });
}
