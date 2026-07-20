import { spawn as spawnPty } from "node-pty";

export interface PtyOptions {
  file: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  timeoutMs: number;
}

export interface RunResult {
  command: string[];
  startedAt: string;
  durationMs: number;
  exitCode: number;
  rawOutput: string;
  timedOut: boolean;
}

export interface ProbeHandle {
  pid: number;
  completed: Promise<RunResult>;
  write(text: string): void;
  resize(cols: number, rows: number): void;
  interrupt(): void;
  kill(): void;
  waitFor(predicate: (text: string) => boolean): Promise<string>;
}

interface Waiter {
  predicate: (text: string) => boolean;
  resolve(text: string): void;
  reject(error: Error): void;
}

const INTERRUPT_GRACE_MS = 2_000;

function copyEnvironment(overrides: Record<string, string> | undefined): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) environment[name] = value;
  }
  return { ...environment, ...overrides };
}

export function runPty(options: PtyOptions): ProbeHandle {
  const startedAt = new Date();
  const terminal = spawnPty(options.file, options.args, {
    cwd: options.cwd,
    env: copyEnvironment(options.env),
    cols: 80,
    rows: 24,
    useConpty: process.platform === "win32"
  });

  let rawOutput = "";
  let exited = false;
  let timedOut = false;
  let escalationTimer: NodeJS.Timeout | undefined;
  const waiters = new Set<Waiter>();
  const hardKill = () => {
    if (!exited) terminal.kill(process.platform === "win32" ? undefined : "SIGKILL");
  };

  const completed = new Promise<RunResult>((resolve) => {
    const dataDisposable = terminal.onData((text) => {
      rawOutput += text;
      for (const waiter of [...waiters]) {
        try {
          if (waiter.predicate(rawOutput)) {
            waiters.delete(waiter);
            waiter.resolve(rawOutput);
          }
        } catch (error) {
          waiters.delete(waiter);
          waiter.reject(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });

    const timeoutTimer = setTimeout(() => {
      if (exited) return;
      timedOut = true;
      terminal.write("\x03");
      escalationTimer = setTimeout(() => {
        hardKill();
      }, INTERRUPT_GRACE_MS);
    }, options.timeoutMs);

    const exitDisposable = terminal.onExit(({ exitCode }) => {
      exited = true;
      clearTimeout(timeoutTimer);
      if (escalationTimer) clearTimeout(escalationTimer);
      dataDisposable.dispose();
      exitDisposable.dispose();
      for (const waiter of waiters) {
        waiter.reject(new Error("PTY exited before the requested output was observed"));
      }
      waiters.clear();
      resolve({
        command: [options.file, ...options.args],
        startedAt: startedAt.toISOString(),
        durationMs: Date.now() - startedAt.getTime(),
        exitCode,
        rawOutput,
        timedOut
      });
    });
  });

  return {
    pid: terminal.pid,
    completed,
    write: (text) => terminal.write(text),
    resize: (cols, rows) => terminal.resize(cols, rows),
    interrupt: () => terminal.write("\x03"),
    kill: hardKill,
    waitFor: (predicate) => {
      try {
        if (predicate(rawOutput)) return Promise.resolve(rawOutput);
      } catch (error) {
        return Promise.reject(error);
      }
      if (exited) return Promise.reject(new Error("PTY already exited before the requested output was observed"));
      return new Promise<string>((resolve, reject) => {
        waiters.add({ predicate, resolve, reject });
      });
    }
  };
}
