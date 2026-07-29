import {
  spawn,
  type ChildProcess,
  type SpawnOptions
} from "node:child_process";

export interface ProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface ProcessCapture {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  closed: Promise<ProcessExit>;
}

export class CapturedProcessError extends Error {
  constructor(
    message: string,
    readonly processCapture: ProcessCapture,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "CapturedProcessError";
  }
}

export function capture(child: ChildProcess): ProcessCapture {
  let resolveClosed: (exit: ProcessExit) => void = () => undefined;
  let rejectClosed: (error: Error) => void = () => undefined;
  const result: ProcessCapture = {
    child,
    stdout: "",
    stderr: "",
    closed: new Promise<ProcessExit>((resolvePromise, reject) => {
      resolveClosed = resolvePromise;
      rejectClosed = reject;
    })
  };
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    result.stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    result.stderr += chunk;
  });
  child.once("error", rejectClosed);
  child.once("close", (code, signal) => {
    resolveClosed({ code, signal });
  });
  return result;
}

export async function waitForClose(
  processCapture: ProcessCapture,
  label: string,
  timeoutMs: number
): Promise<ProcessExit> {
  return waitForCloseUntil(
    processCapture,
    label,
    Date.now() + timeoutMs
  );
}

export async function waitForCloseUntil(
  processCapture: ProcessCapture,
  label: string,
  deadlineAt: number
): Promise<ProcessExit> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      processCapture.closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} exceeded its absolute deadline`)),
          Math.max(0, deadlineAt - Date.now())
        );
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function terminateCapturedProcess(
  processCapture: ProcessCapture,
  label: string,
  timeoutMs: number
): Promise<void> {
  return terminateCapturedProcessUntil(
    processCapture,
    label,
    Date.now() + timeoutMs
  );
}

export async function terminateCapturedProcessUntil(
  processCapture: ProcessCapture,
  label: string,
  deadlineAt: number
): Promise<void> {
  if (
    processCapture.child.exitCode === null
    && processCapture.child.signalCode === null
  ) {
    processCapture.child.kill("SIGKILL");
  }
  const exit = await waitForCloseUntil(
    processCapture,
    `${label} termination`,
    deadlineAt
  );
  if (
    exit.code === null
    && exit.signal === null
    && processCapture.child.exitCode === null
    && processCapture.child.signalCode === null
  ) {
    throw new Error(`${label} remained live after SIGKILL`);
  }
}

function cleanupReserve(totalBudgetMs: number): number {
  return Math.min(1_000, Math.max(25, Math.floor(totalBudgetMs * 0.2)));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (
      error instanceof Error
      && "code" in error
      && (error as NodeJS.ErrnoException).code === "ESRCH"
    ) {
      return false;
    }
    throw error;
  }
}

export async function forceReapCapturedProcessTree(input: {
  processCapture: ProcessCapture;
  descendantPids: () => Promise<readonly number[]>;
  label: string;
  deadlineAt: number;
}): Promise<void> {
  const errors: Error[] = [];
  let descendantPids: readonly number[] = [];
  try {
    descendantPids = await input.descendantPids();
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
  if (
    input.processCapture.child.exitCode === null
    && input.processCapture.child.signalCode === null
  ) {
    if (!input.processCapture.child.kill("SIGKILL")) {
      errors.push(new Error(`${input.label} root process rejected SIGKILL`));
    }
  }
  for (const pid of new Set(descendantPids)) {
    try {
      if (processAlive(pid)) process.kill(pid, "SIGKILL");
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  try {
    await waitForCloseUntil(
      input.processCapture,
      `${input.label} root reap`,
      input.deadlineAt
    );
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
  while (Date.now() < input.deadlineAt) {
    const live: number[] = [];
    for (const pid of new Set(descendantPids)) {
      try {
        if (processAlive(pid)) live.push(pid);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (live.length === 0) break;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  const leaked = [...new Set(descendantPids)].filter((pid) => {
    try {
      return processAlive(pid);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
      return true;
    }
  });
  if (leaked.length > 0) {
    errors.push(new Error(
      `${input.label} leaked descendant PIDs: ${leaked.join(", ")}`
    ));
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${input.label} process-tree reap failed`);
  }
}

export async function waitForCapturedProcessTreeExit(input: {
  processCapture: ProcessCapture;
  descendantPids: () => Promise<readonly number[]>;
  label: string;
  totalBudgetMs: number;
}): Promise<ProcessExit> {
  const deadlineAt = Date.now() + input.totalBudgetMs;
  const forceAt = deadlineAt - cleanupReserve(input.totalBudgetMs);
  try {
    return await waitForCloseUntil(
      input.processCapture,
      input.label,
      forceAt
    );
  } catch (error) {
    let reapError: unknown;
    try {
      await forceReapCapturedProcessTree({
        processCapture: input.processCapture,
        descendantPids: input.descendantPids,
        label: input.label,
        deadlineAt
      });
    } catch (cleanupError) {
      reapError = cleanupError;
    }
    throw new CapturedProcessError(
      diagnostic(`${input.label} timed out`, input.processCapture),
      input.processCapture,
      {
        cause: new AggregateError(
          reapError === undefined ? [error] : [error, reapError],
          `${input.label} timed out and required process-tree cleanup`
        )
      }
    );
  }
}

function diagnostic(
  label: string,
  processCapture: ProcessCapture
): string {
  return [
    label,
    "stdout:",
    processCapture.stdout,
    "stderr:",
    processCapture.stderr
  ].join("\n");
}

export function formatErrorTree(error: unknown): string {
  const seen = new Set<unknown>();
  const lines: string[] = [];
  const visit = (value: unknown, label: string): void => {
    if (seen.has(value)) return;
    if (typeof value === "object" && value !== null) seen.add(value);
    if (value instanceof Error) {
      lines.push(`${label}: ${value.stack ?? `${value.name}: ${value.message}`}`);
      if (value instanceof AggregateError) {
        value.errors.forEach((member, index) => {
          visit(member, `${label}.errors[${index}]`);
        });
      }
      if (value.cause !== undefined) visit(value.cause, `${label}.cause`);
      return;
    }
    lines.push(`${label}: ${String(value)}`);
  };
  visit(error, "error");
  return lines.join("\n");
}

export async function runCapturedCommand(input: {
  file: string;
  args: readonly string[];
  options: SpawnOptions;
  label: string;
  timeoutMs: number;
}): Promise<ProcessCapture> {
  const processCapture = capture(spawn(
    input.file,
    [...input.args],
    input.options
  ));
  const deadlineAt = Date.now() + input.timeoutMs;
  const executionDeadline = deadlineAt - cleanupReserve(input.timeoutMs);
  let exit: ProcessExit;
  try {
    exit = await waitForCloseUntil(
      processCapture,
      input.label,
      executionDeadline
    );
  } catch (error) {
    let cleanupError: unknown;
    try {
      await terminateCapturedProcessUntil(
        processCapture,
        input.label,
        deadlineAt
      );
    } catch (terminationError) {
      cleanupError = terminationError;
    }
    const causes = cleanupError === undefined
      ? [error]
      : [error, cleanupError];
    throw new CapturedProcessError(
      diagnostic(`${input.label} failed`, processCapture),
      processCapture,
      { cause: new AggregateError(causes, `${input.label} cleanup failed`) }
    );
  }
  if (exit.code !== 0) {
    throw new CapturedProcessError(
      diagnostic(
        `${input.label} exited (code=${String(exit.code)}, signal=${String(exit.signal)})`,
        processCapture
      ),
      processCapture
    );
  }
  return processCapture;
}

export async function connectOrTerminateCapturedProcess<T>(input: {
  processCapture: ProcessCapture;
  connect: () => Promise<T>;
  label: string;
  timeoutMs: number;
}): Promise<T> {
  const deadlineAt = Date.now() + input.timeoutMs;
  const connectDeadline = deadlineAt - cleanupReserve(input.timeoutMs);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.connect(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            `${input.label} connect timed out after ${input.timeoutMs}ms`
          )),
          Math.max(0, connectDeadline - Date.now())
        );
      })
    ]);
  } catch (error) {
    let cleanupError: unknown;
    try {
      await terminateCapturedProcessUntil(
        input.processCapture,
        input.label,
        deadlineAt
      );
    } catch (terminationError) {
      cleanupError = terminationError;
    }
    throw new CapturedProcessError(
      diagnostic(`${input.label} connect failed`, input.processCapture),
      input.processCapture,
      {
        cause: new AggregateError(
          cleanupError === undefined ? [error] : [error, cleanupError],
          `${input.label} connect and cleanup failed`
        )
      }
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
