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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      processCapture.closed,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} timed out after ${timeoutMs}ms`)),
          timeoutMs
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
  if (
    processCapture.child.exitCode === null
    && processCapture.child.signalCode === null
  ) {
    processCapture.child.kill("SIGKILL");
  }
  const exit = await waitForClose(processCapture, `${label} termination`, timeoutMs);
  if (
    exit.code === null
    && exit.signal === null
    && processCapture.child.exitCode === null
    && processCapture.child.signalCode === null
  ) {
    throw new Error(`${label} remained live after SIGKILL`);
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
  let exit: ProcessExit;
  try {
    exit = await waitForClose(processCapture, input.label, input.timeoutMs);
  } catch (error) {
    let cleanupError: unknown;
    try {
      await terminateCapturedProcess(
        processCapture,
        input.label,
        input.timeoutMs
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      input.connect(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            `${input.label} connect timed out after ${input.timeoutMs}ms`
          )),
          input.timeoutMs
        );
      })
    ]);
  } catch (error) {
    let cleanupError: unknown;
    try {
      await terminateCapturedProcess(
        input.processCapture,
        input.label,
        input.timeoutMs
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
