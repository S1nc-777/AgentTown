import {
  spawn,
  type ChildProcess,
  type ChildProcessWithoutNullStreams
} from "node:child_process";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_OUTPUT_LIMIT_BYTES = 4 * 1024 * 1024;

export interface GitCommandOptions {
  cwd: string;
  timeoutMs?: number;
  stdin?: string;
  allowedExitCodes?: readonly number[];
}

export interface GitCommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface GitCommandRunnerOptions {
  maxStdoutBytes?: number;
  maxStderrBytes?: number;
}

interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

interface CapturedGitProcess {
  child: ChildProcessWithoutNullStreams;
  stdout: Buffer[];
  stderr: Buffer[];
  stdoutBytes: number;
  stderrBytes: number;
  closed: Promise<ProcessExit>;
  ownsProcessGroup: boolean;
}

export class GitCommandError extends Error {
  readonly subcommand: string;
  readonly exitCode: number | null;
  readonly stderr: string;

  constructor(input: {
    subcommand: string;
    exitCode: number | null;
    stderr: string;
    message?: string;
    cause?: unknown;
  }) {
    const diagnostic = safeStderr(input.stderr);
    const summary = input.message
      ?? `git ${input.subcommand} exited with code ${String(input.exitCode)}`;
    super(
      summary + (diagnostic.length === 0 ? "" : `: ${diagnostic}`),
      input.cause === undefined ? undefined : { cause: input.cause }
    );
    this.name = "GitCommandError";
    this.subcommand = input.subcommand;
    this.exitCode = input.exitCode;
    this.stderr = diagnostic;
  }
}

export class GitCommandTimeoutError extends GitCommandError {
  readonly timeoutMs: number;

  constructor(input: {
    subcommand: string;
    timeoutMs: number;
    stderr: string;
    cause?: unknown;
  }) {
    super({
      subcommand: input.subcommand,
      exitCode: null,
      stderr: input.stderr,
      message: `git ${input.subcommand} timed out after ${input.timeoutMs}ms`,
      cause: input.cause
    });
    this.name = "GitCommandTimeoutError";
    this.timeoutMs = input.timeoutMs;
  }
}

export class GitOutputOverflowError extends GitCommandError {
  readonly stream: "stdout" | "stderr";
  readonly limitBytes: number;

  constructor(input: {
    subcommand: string;
    stream: "stdout" | "stderr";
    limitBytes: number;
    stderr: string;
    cause?: unknown;
  }) {
    super({
      subcommand: input.subcommand,
      exitCode: null,
      stderr: input.stderr,
      message: `git ${input.subcommand} exceeded the ${input.stream} capture limit `
        + `of ${input.limitBytes} bytes`,
      cause: input.cause
    });
    this.name = "GitOutputOverflowError";
    this.stream = input.stream;
    this.limitBytes = input.limitBytes;
  }
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

function cleanupReserve(totalBudgetMs: number): number {
  return Math.min(
    1_000,
    Math.max(25, Math.floor(totalBudgetMs * (2 / 3))),
    Math.max(1, totalBudgetMs - 1)
  );
}

function isLive(child: ChildProcess): boolean {
  return child.exitCode === null && child.signalCode === null;
}

function safeStderr(stderr: string): string {
  return stderr
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[^\P{C}\n\r\t]/gu, "?")
    .trim()
    .slice(0, 2_000);
}

function capturedText(chunks: readonly Buffer[]): string {
  return Buffer.concat(chunks).toString("utf8");
}

function appendBounded(
  target: Buffer[],
  chunk: Buffer,
  currentBytes: number,
  limitBytes: number
): { bytes: number; overflowed: boolean } {
  const remaining = limitBytes - currentBytes;
  if (remaining > 0) target.push(chunk.subarray(0, remaining));
  return {
    bytes: Math.min(limitBytes, currentBytes + chunk.length),
    overflowed: chunk.length > remaining
  };
}

function waitForCloseUntil(
  capture: CapturedGitProcess,
  label: string,
  deadlineAt: number
): Promise<ProcessExit> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    capture.closed,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} exceeded its absolute cleanup deadline`)),
        Math.max(0, deadlineAt - Date.now())
      );
    })
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

async function terminateProcessTree(
  capture: CapturedGitProcess,
  label: string,
  deadlineAt: number
): Promise<void> {
  if (!isLive(capture.child)) return;
  const pid = capture.child.pid;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
    throw new Error(`${label} live process has no valid PID`);
  }

  if (process.platform === "win32") {
    const taskkill = spawn(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"]
      }
    );
    taskkill.stdout?.resume();
    taskkill.stderr?.resume();
    const taskkillExit = await new Promise<ProcessExit>((resolvePromise, reject) => {
      taskkill.once("error", reject);
      taskkill.once("close", (code, signal) => resolvePromise({ code, signal }));
      const remaining = Math.max(0, deadlineAt - Date.now());
      const timer = setTimeout(() => {
        if (isLive(taskkill)) taskkill.kill("SIGKILL");
        reject(new Error(`${label} taskkill exceeded its absolute cleanup deadline`));
      }, remaining);
      taskkill.once("close", () => clearTimeout(timer));
      taskkill.once("error", () => clearTimeout(timer));
    });
    if (taskkillExit.code !== 0 && isLive(capture.child)) {
      throw new Error(`${label} taskkill failed with code ${String(taskkillExit.code)}`);
    }
  } else if (capture.ownsProcessGroup) {
    try {
      process.kill(-(pid as number), "SIGKILL");
    } catch (error) {
      if (
        !(error instanceof Error)
        || !("code" in error)
        || (error as NodeJS.ErrnoException).code !== "ESRCH"
      ) {
        throw error;
      }
    }
  } else if (isLive(capture.child)) {
    capture.child.kill("SIGKILL");
  }

  if (isLive(capture.child)) {
    await waitForCloseUntil(capture, `${label} root reap`, deadlineAt);
  }
  if (isLive(capture.child)) {
    throw new Error(`${label} root process remains live after cleanup`);
  }
}

export class GitCommandRunner {
  readonly #maxStdoutBytes: number;
  readonly #maxStderrBytes: number;

  constructor(options: GitCommandRunnerOptions = {}) {
    this.#maxStdoutBytes = positiveInteger(
      options.maxStdoutBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
      "maxStdoutBytes"
    );
    this.#maxStderrBytes = positiveInteger(
      options.maxStderrBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
      "maxStderrBytes"
    );
  }

  async run(
    args: readonly string[],
    options: GitCommandOptions
  ): Promise<GitCommandResult> {
    const firstArgument = args[0];
    if (firstArgument === undefined || firstArgument.length === 0) {
      throw new TypeError("a Git subcommand is required");
    }
    const subcommand = firstArgument === "-c"
      ? args.find((arg, index) => index > 1 && !arg.startsWith("-")) ?? "-c"
      : firstArgument;
    const timeoutMs = positiveInteger(
      options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      "timeoutMs"
    );
    const allowedExitCodes = options.allowedExitCodes ?? [0];
    if (
      allowedExitCodes.length === 0
      || allowedExitCodes.some((code) => !Number.isSafeInteger(code))
    ) {
      throw new TypeError("allowedExitCodes must contain integer exit codes");
    }

    const ownsProcessGroup = process.platform !== "win32";
    let resolveClosed: (exit: ProcessExit) => void = () => undefined;
    let rejectClosed: (error: Error) => void = () => undefined;
    const child = spawn("git", [...args], {
      cwd: options.cwd,
      detached: ownsProcessGroup,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        LANG: "C",
        LC_ALL: "C"
      },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const capture: CapturedGitProcess = {
      child,
      stdout: [],
      stderr: [],
      stdoutBytes: 0,
      stderrBytes: 0,
      ownsProcessGroup,
      closed: new Promise<ProcessExit>((resolvePromise, reject) => {
        resolveClosed = resolvePromise;
        rejectClosed = reject;
      })
    };
    child.once("error", rejectClosed);
    child.once("close", (code, signal) => resolveClosed({ code, signal }));
    child.stdin.on("error", () => undefined);

    let resolveOverflow: (
      stream: "stdout" | "stderr"
    ) => void = () => undefined;
    const overflowed = new Promise<"stdout" | "stderr">((resolvePromise) => {
      resolveOverflow = resolvePromise;
    });
    let overflowStream: "stdout" | "stderr" | undefined;
    child.stdout.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const appended = appendBounded(
        capture.stdout,
        chunk,
        capture.stdoutBytes,
        this.#maxStdoutBytes
      );
      capture.stdoutBytes = appended.bytes;
      if (appended.overflowed && overflowStream === undefined) {
        overflowStream = "stdout";
        resolveOverflow("stdout");
      }
    });
    child.stderr.on("data", (value: Buffer | string) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const appended = appendBounded(
        capture.stderr,
        chunk,
        capture.stderrBytes,
        this.#maxStderrBytes
      );
      capture.stderrBytes = appended.bytes;
      if (appended.overflowed && overflowStream === undefined) {
        overflowStream = "stderr";
        resolveOverflow("stderr");
      }
    });
    child.stdin.end(options.stdin);

    const deadlineAt = Date.now() + timeoutMs;
    const executionDeadlineAt = deadlineAt - cleanupReserve(timeoutMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolvePromise) => {
      timer = setTimeout(
        () => resolvePromise("timeout"),
        Math.max(0, executionDeadlineAt - Date.now())
      );
    });

    let outcome: ProcessExit | "stdout" | "stderr" | "timeout";
    try {
      outcome = await Promise.race([capture.closed, overflowed, timeout]);
    } catch (error) {
      throw new GitCommandError({
        subcommand,
        exitCode: null,
        stderr: capturedText(capture.stderr),
        message: `failed to start git ${subcommand}: ${
          error instanceof Error ? error.message : String(error)
        }`,
        cause: error
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }

    if (typeof outcome === "string") {
      let cleanupError: unknown;
      try {
        await terminateProcessTree(
          capture,
          `git ${subcommand}`,
          deadlineAt
        );
      } catch (error) {
        cleanupError = error;
      }
      const stderr = capturedText(capture.stderr);
      const cause = cleanupError === undefined
        ? undefined
        : new AggregateError(
          [cleanupError],
          `git ${subcommand} process-tree cleanup could not be verified`
        );
      if (outcome === "timeout") {
        throw new GitCommandTimeoutError({
          subcommand,
          timeoutMs,
          stderr,
          cause
        });
      }
      throw new GitOutputOverflowError({
        subcommand,
        stream: outcome,
        limitBytes: outcome === "stdout"
          ? this.#maxStdoutBytes
          : this.#maxStderrBytes,
        stderr,
        cause
      });
    }

    const stdout = capturedText(capture.stdout);
    const stderr = capturedText(capture.stderr);
    if (outcome.code === null) {
      throw new GitCommandError({
        subcommand,
        exitCode: null,
        stderr,
        message: `git ${subcommand} terminated by ${outcome.signal ?? "an unknown signal"}`
      });
    }
    if (!allowedExitCodes.includes(outcome.code)) {
      throw new GitCommandError({
        subcommand,
        exitCode: outcome.code,
        stderr
      });
    }
    return { stdout, stderr, exitCode: outcome.code };
  }
}
