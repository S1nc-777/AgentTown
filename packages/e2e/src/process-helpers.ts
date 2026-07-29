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
  ownsProcessGroup: boolean;
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

export function capture(
  child: ChildProcess,
  options: { ownsProcessGroup?: boolean } = {}
): ProcessCapture {
  let resolveClosed: (exit: ProcessExit) => void = () => undefined;
  let rejectClosed: (error: Error) => void = () => undefined;
  const result: ProcessCapture = {
    child,
    stdout: "",
    stderr: "",
    ownsProcessGroup: options.ownsProcessGroup ?? false,
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

export interface AdapterProcessDiagnostic {
  type: "adapter.process.started" | "adapter.process.exited";
  employeeId: string;
  pid: number;
  processInstanceId: string;
  exitCode?: number | null;
  signal?: NodeJS.Signals | null;
}

export interface ParsedAdapterProcessDiagnostics {
  diagnostics: AdapterProcessDiagnostic[];
  errors: Error[];
}

export function parseAdapterProcessDiagnostics(
  content: string,
  source: string
): ParsedAdapterProcessDiagnostics {
  const diagnostics: AdapterProcessDiagnostic[] = [];
  const errors: Error[] = [];
  for (const [index, line] of content.split(/\r?\n/u).entries()) {
    const jsonStart = line.indexOf("{");
    if (jsonStart < 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.slice(jsonStart));
    } catch (error) {
      errors.push(new Error(
        `${source}:${index + 1} contains malformed JSON`,
        { cause: error }
      ));
      continue;
    }
    if (
      typeof parsed !== "object"
      || parsed === null
      || !("type" in parsed)
      || (
        parsed.type !== "adapter.process.started"
        && parsed.type !== "adapter.process.exited"
      )
    ) {
      continue;
    }
    const candidate = parsed as Partial<AdapterProcessDiagnostic>;
    if (
      typeof candidate.employeeId !== "string"
      || !Number.isSafeInteger(candidate.pid)
      || (candidate.pid as number) <= 0
      || typeof candidate.processInstanceId !== "string"
      || candidate.processInstanceId.length === 0
    ) {
      errors.push(new Error(
        `${source}:${index + 1} contains an invalid process diagnostic`
      ));
      continue;
    }
    diagnostics.push(candidate as AdapterProcessDiagnostic);
  }
  return { diagnostics, errors };
}

export function activeAdapterProcessDiagnostics(
  diagnostics: readonly AdapterProcessDiagnostic[]
): AdapterProcessDiagnostic[] {
  const exitedInstances = new Set(diagnostics
    .filter(({ type }) => type === "adapter.process.exited")
    .map(({ processInstanceId }) => processInstanceId));
  const active = new Map<string, AdapterProcessDiagnostic>();
  for (const diagnostic of diagnostics) {
    if (
      diagnostic.type === "adapter.process.started"
      && !exitedInstances.has(diagnostic.processInstanceId)
    ) {
      active.set(diagnostic.processInstanceId, diagnostic);
    }
  }
  return [...active.values()];
}

export interface ProcessVerification {
  pids: readonly number[];
  errors: readonly Error[];
}

export type OwnedProcessTreeTerminator = (input: {
  processCapture: ProcessCapture;
  label: string;
  deadlineAt: number;
}) => Promise<void>;

function processCaptureIsLive(processCapture: ProcessCapture): boolean {
  return processCapture.child.exitCode === null
    && processCapture.child.signalCode === null;
}

export const terminateOwnedProcessTree: OwnedProcessTreeTerminator = async ({
  processCapture,
  label,
  deadlineAt
}) => {
  if (!processCaptureIsLive(processCapture)) return;
  const pid = processCapture.child.pid;
  if (!Number.isSafeInteger(pid) || (pid as number) <= 0) {
    throw new Error(`${label} live root process has no valid PID`);
  }

  if (process.platform === "win32") {
    if (!processCaptureIsLive(processCapture)) return;
    const taskkill = capture(spawn(
      "taskkill.exe",
      ["/PID", String(pid), "/T", "/F"],
      {
        windowsHide: true,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"]
      }
    ));
    let taskkillExit: ProcessExit;
    try {
      taskkillExit = await waitForCloseUntil(
        taskkill,
        `${label} taskkill`,
        deadlineAt
      );
    } catch (error) {
      if (processCaptureIsLive(taskkill)) taskkill.child.kill("SIGKILL");
      throw error;
    }
    if (taskkillExit.code !== 0 && processCaptureIsLive(processCapture)) {
      throw new CapturedProcessError(
        diagnostic(`${label} taskkill failed`, taskkill),
        taskkill
      );
    }
  } else if (processCapture.ownsProcessGroup) {
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
  } else if (processCaptureIsLive(processCapture)) {
    processCapture.child.kill("SIGKILL");
  }

  if (processCaptureIsLive(processCapture)) {
    await waitForCloseUntil(processCapture, `${label} root reap`, deadlineAt);
  }
};

async function verificationUntil(
  provider: () => Promise<ProcessVerification>,
  label: string,
  deadlineAt: number
): Promise<ProcessVerification> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      provider(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} verification provider exceeded deadline`)),
          Math.max(0, deadlineAt - Date.now())
        );
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function forceReapCapturedProcessTree(input: {
  processCapture: ProcessCapture;
  verification: () => Promise<ProcessVerification>;
  terminateTree?: OwnedProcessTreeTerminator | undefined;
  label: string;
  deadlineAt: number;
}): Promise<void> {
  const errors: Error[] = [];
  try {
    await (input.terminateTree ?? terminateOwnedProcessTree)({
      processCapture: input.processCapture,
      label: input.label,
      deadlineAt: input.deadlineAt
    });
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
  if (processCaptureIsLive(input.processCapture)) {
    errors.push(new Error(`${input.label} root process remains live`));
  }
  let verification: ProcessVerification = { pids: [], errors: [] };
  try {
    verification = await verificationUntil(
      input.verification,
      input.label,
      input.deadlineAt
    );
  } catch (error) {
    errors.push(error instanceof Error ? error : new Error(String(error)));
  }
  errors.push(...verification.errors);
  while (Date.now() < input.deadlineAt) {
    const live: number[] = [];
    for (const pid of new Set(verification.pids)) {
      try {
        if (processAlive(pid)) live.push(pid);
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (live.length === 0) break;
    await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 5));
  }
  const leaked = [...new Set(verification.pids)].filter((pid) => {
    try {
      return processAlive(pid);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
      return true;
    }
  });
  if (leaked.length > 0) {
    errors.push(new Error(
      `${input.label} still-live diagnostic PIDs: ${leaked.join(", ")}`
    ));
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      `${input.label} process-tree reap failed: `
      + errors.map(({ message }) => message).join("; ")
    );
  }
}

export async function waitForCapturedProcessTreeExit(input: {
  processCapture: ProcessCapture;
  verification: () => Promise<ProcessVerification>;
  terminateTree?: OwnedProcessTreeTerminator | undefined;
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
        verification: input.verification,
        terminateTree: input.terminateTree,
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
