import {
  spawn,
  type SpawnOptionsWithoutStdio,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  appendFileSync,
  closeSync,
  lstat,
  mkdir,
  openSync,
  realpath
} from "node:fs";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type {
  AgentAdapter,
  AgentCapabilities,
  AgentEvent,
  AgentMessage,
  ResumeSessionInput,
  SessionHandle,
  StartSessionInput,
  UsageSnapshot
} from "@agenttown/runtime-contract";

const accessAsync = promisify(access);
const lstatAsync = promisify(lstat);
const mkdirAsync = promisify(mkdir);
const realpathAsync = promisify(realpath);
const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
const EMPLOYEE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/u;

interface AsyncJsonLineQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(error?: Error): void;
}

interface LiveFakeSession {
  handle: SessionHandle;
  child: ChildProcessWithoutNullStreams;
  lines: AsyncJsonLineQueue<AgentEvent>;
  usage: UsageSnapshot;
  closed: Promise<void>;
  interruptWaiters: Array<(interrupted: boolean) => void>;
  logFileDescriptor: number;
  logFileClosed: boolean;
  processExitLogged: boolean;
  processInstanceId: string;
  lifecycleErrors: Error[];
  stopping: Promise<void> | null;
}

interface QueueWaiter<T> {
  resolve: (result: IteratorResult<T>) => void;
  reject: (error: Error) => void;
}

function createAsyncJsonLineQueue<T>(): AsyncJsonLineQueue<T> {
  const values: T[] = [];
  const waiters: Array<QueueWaiter<T>> = [];
  let closed = false;
  let failure: Error | undefined;

  return {
    push(value) {
      if (closed) return;
      const waiter = waiters.shift();
      if (waiter === undefined) {
        values.push(value);
      } else {
        waiter.resolve({ done: false, value });
      }
    },
    close(error) {
      if (closed) return;
      closed = true;
      failure = error;
      for (const waiter of waiters.splice(0)) {
        if (error === undefined) {
          waiter.resolve({ done: true, value: undefined });
        } else {
          waiter.reject(error);
        }
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<T>> {
          const value = values.shift();
          if (value !== undefined) {
            return Promise.resolve({ done: false, value });
          }
          if (failure !== undefined) return Promise.reject(failure);
          if (closed) {
            return Promise.resolve({ done: true, value: undefined });
          }
          return new Promise<IteratorResult<T>>((resolvePromise, reject) => {
            waiters.push({ resolve: resolvePromise, reject });
          });
        }
      };
    }
  };
}

function isWithin(parent: string, child: string): boolean {
  const childRelative = relative(parent, child);
  return childRelative === "" ||
    (!childRelative.startsWith("..") && !isAbsolute(childRelative));
}

function writeJsonLine(
  child: ChildProcessWithoutNullStreams,
  value: Record<string, unknown>
): void {
  if (!child.stdin.write(`${JSON.stringify(value)}\n`)) {
    throw new Error("Fake Agent input stream is unavailable");
  }
}

async function nextWithTimeout<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  message: string
): Promise<IteratorResult<T>> {
  const iterator = iterable[Symbol.asyncIterator]();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      iterator.next(),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

export interface FakeAgentAdapterOptions {
  executable: string;
  packageRoot: string;
  allowedEmployeeIds: ReadonlySet<string>;
  spawnProcess?: (
    executable: string,
    args: string[],
    options: SpawnOptionsWithoutStdio & {
      stdio: ["pipe", "pipe", "pipe"];
    }
  ) => ChildProcessWithoutNullStreams;
  writeDiagnostic?: (fileDescriptor: number, line: string) => void;
}

export class FakeAgentAdapter implements AgentAdapter {
  readonly #executable: string;
  readonly #packageRoot: string;
  readonly #allowedEmployeeIds: ReadonlySet<string>;
  readonly #spawnProcess: NonNullable<FakeAgentAdapterOptions["spawnProcess"]>;
  readonly #writeDiagnosticLine: NonNullable<
    FakeAgentAdapterOptions["writeDiagnostic"]
  >;
  readonly #sessions = new Map<string, LiveFakeSession>();

  constructor(options: FakeAgentAdapterOptions) {
    this.#executable = resolve(options.executable);
    this.#packageRoot = resolve(options.packageRoot);
    this.#allowedEmployeeIds = new Set(options.allowedEmployeeIds);
    this.#spawnProcess = options.spawnProcess
      ?? ((executable, args, spawnOptions) =>
        spawn(executable, args, spawnOptions));
    this.#writeDiagnosticLine = options.writeDiagnostic
      ?? ((fileDescriptor, line) =>
        appendFileSync(fileDescriptor, line, "utf8"));
  }

  async detect(): Promise<{ available: boolean; version: string }> {
    try {
      await accessAsync(this.#executable, fsConstants.F_OK);
      return { available: true, version: process.version };
    } catch {
      return { available: false, version: "unknown" };
    }
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      nativeResume: "supported",
      structuredOutput: "supported",
      nonInteractive: "supported",
      interrupt: "supported",
      parallelSessions: "supported",
      tokenUsage: "supported",
      contextUsage: "unknown",
      interactiveTakeover: "unsupported"
    };
  }

  async start(input: StartSessionInput): Promise<SessionHandle> {
    return this.#start(input);
  }

  async *send(
    session: SessionHandle,
    message: AgentMessage
  ): AsyncIterable<AgentEvent> {
    const live = this.#getLive(session);
    if (live.child.exitCode === null && live.child.signalCode === null) {
      writeJsonLine(live.child, {
        type: "message",
        messageId: message.messageId,
        taskId: message.taskId,
        text: message.text
      });
    }

    for await (const event of live.lines) {
      yield event;
      if (
        event.type === "usage.updated" ||
        event.type === "adapter.error" ||
        event.type === "session.exited"
      ) {
        if (event.type === "session.exited") {
          this.#sessions.delete(session.internalSessionId);
        }
        return;
      }
    }
  }

  async interrupt(session: SessionHandle): Promise<{ interrupted: boolean }> {
    const live = this.#getLive(session);
    if (live.child.exitCode !== null || live.child.signalCode !== null) {
      return { interrupted: false };
    }
    return new Promise<{ interrupted: boolean }>((resolvePromise, reject) => {
      const resolveInterrupt = (interrupted: boolean) => {
        resolvePromise({ interrupted });
      };
      live.interruptWaiters.push(resolveInterrupt);
      try {
        writeJsonLine(live.child, { type: "interrupt" });
      } catch (error) {
        const waiterIndex = live.interruptWaiters.indexOf(resolveInterrupt);
        if (waiterIndex >= 0) live.interruptWaiters.splice(waiterIndex, 1);
        reject(error);
      }
    });
  }

  async resume(input: ResumeSessionInput): Promise<SessionHandle> {
    if (input.previous.nativeSessionId === null) {
      throw new Error("Fake Agent resume requires a native session ID");
    }
    await this.stop(input.previous);
    return this.#start(input, input.previous.nativeSessionId);
  }

  async stop(session: SessionHandle): Promise<void> {
    const live = this.#sessions.get(session.internalSessionId);
    if (live === undefined) return;
    if (live.stopping !== null) return live.stopping;

    const stopping = (async () => {
      if (live.child.exitCode === null && live.child.signalCode === null) {
        writeJsonLine(live.child, { type: "stop" });
        const closed = await Promise.race([
          live.closed.then(() => true),
          new Promise<false>((resolvePromise) => {
            setTimeout(() => resolvePromise(false), STOP_TIMEOUT_MS);
          })
        ]);
        if (!closed) {
          live.child.stdin.destroy();
          live.child.kill();
          await live.closed;
        }
      } else {
        await live.closed;
      }
      this.#sessions.delete(session.internalSessionId);
    })();
    live.stopping = stopping;
    return stopping;
  }

  async forceStop(session: SessionHandle): Promise<void> {
    const live = this.#sessions.get(session.internalSessionId);
    if (live === undefined) return;
    if (live.child.exitCode === null && live.child.signalCode === null) {
      live.child.stdin.destroy();
      if (!live.child.kill()) {
        throw new Error(`failed to force-stop Fake Agent: ${session.employeeId}`);
      }
    }
    await live.closed;
    this.#sessions.delete(session.internalSessionId);
  }

  async usage(session: SessionHandle): Promise<UsageSnapshot> {
    const live = this.#getLive(session);
    return { ...live.usage };
  }

  async #start(
    input: StartSessionInput,
    resumeId?: string
  ): Promise<SessionHandle> {
    if (!EMPLOYEE_ID_PATTERN.test(input.employeeId)) {
      throw new Error(`invalid employee id: ${input.employeeId}`);
    }
    if (!this.#allowedEmployeeIds.has(input.employeeId)) {
      throw new Error(`employee is not configured: ${input.employeeId}`);
    }

    const projectRoot = resolve(input.projectRoot);
    const stateRoot = resolve(projectRoot, ".agenttown");
    const logsRoot = resolve(stateRoot, "logs");
    if (!isWithin(projectRoot, stateRoot) || !isWithin(stateRoot, logsRoot)) {
      throw new Error("Fake Agent log path escapes the project state directory");
    }
    await mkdirAsync(stateRoot, { recursive: true });
    const canonicalProjectRoot = await realpathAsync(projectRoot);
    const canonicalStateRoot = await realpathAsync(stateRoot);
    if (!isWithin(canonicalProjectRoot, canonicalStateRoot)) {
      throw new Error("Fake Agent log path escapes the project state directory");
    }
    await mkdirAsync(logsRoot, { recursive: true });
    const canonicalLogsRoot = await realpathAsync(logsRoot);
    if (!isWithin(canonicalStateRoot, canonicalLogsRoot)) {
      throw new Error("Fake Agent log path escapes the project state directory");
    }
    const logPath = resolve(canonicalLogsRoot, `${input.employeeId}.jsonl`);
    if (dirname(logPath) !== canonicalLogsRoot) {
      throw new Error("Fake Agent log path escapes the logs directory");
    }
    const existingLog = await lstatAsync(logPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
    );
    if (existingLog?.isSymbolicLink() === true) {
      throw new Error("Fake Agent log file must not be a symbolic link");
    }
    if (existingLog !== undefined) {
      const canonicalLogPath = await realpathAsync(logPath);
      if (dirname(canonicalLogPath) !== canonicalLogsRoot) {
        throw new Error("Fake Agent log file escapes the logs directory");
      }
    }
    const logFileDescriptor = openSync(logPath, "a", 0o600);

    const args = [
      "--import",
      "tsx",
      "src/company-cli.ts",
      "--employee-id",
      input.employeeId,
      "--scenario",
      input.scenario
    ];
    if (resumeId !== undefined) args.push("--resume", resumeId);

    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#spawnProcess(this.#executable, args, {
        cwd: this.#packageRoot,
        stdio: ["pipe", "pipe", "pipe"]
      });
    } catch (error) {
      closeSync(logFileDescriptor);
      throw error;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const lines = createAsyncJsonLineQueue<AgentEvent>();
    const live: LiveFakeSession = {
      handle: {
        employeeId: input.employeeId,
        adapter: "fake",
        internalSessionId: "",
        nativeSessionId: resumeId ?? null
      },
      child,
      lines,
      usage: {
        inputTokens: null,
        outputTokens: null,
        contextTokens: null,
        capturedAt: new Date().toISOString()
      },
      closed: Promise.resolve(),
      interruptWaiters: [],
      logFileDescriptor,
      logFileClosed: false,
      processExitLogged: false,
      processInstanceId: randomUUID(),
      lifecycleErrors: [],
      stopping: null
    };
    live.closed = new Promise<void>((resolvePromise) => {
      child.once("error", (error) => {
        live.lifecycleErrors.push(error);
        this.#tryWriteProcessExitDiagnostic(live, null, null);
        lines.close(error);
      });
      child.once("close", (exitCode, signal) => {
        this.#tryWriteProcessExitDiagnostic(live, exitCode, signal);
        this.#closeLogFile(live);
        for (const resolveInterrupt of live.interruptWaiters.splice(0)) {
          resolveInterrupt(false);
        }
        lines.push({ type: "session.exited", exitCode });
        lines.close();
        resolvePromise();
      });
    });
    const childPid = child.pid;
    if (!Number.isSafeInteger(childPid) || (childPid as number) <= 0) {
      return this.#abortFailedStart(
        live,
        new Error(`Fake Agent ${input.employeeId} did not expose a child PID`)
      );
    }
    try {
      this.#writeProcessDiagnostic(live, {
        type: "adapter.process.started",
        employeeId: input.employeeId,
        pid: childPid as number,
        processInstanceId: live.processInstanceId
      });
    } catch (error) {
      return this.#abortFailedStart(live, error);
    }
    child.stdin.on("error", () => undefined);

    let stdoutBuffer = "";
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
      while (true) {
        const newlineIndex = stdoutBuffer.indexOf("\n");
        if (newlineIndex < 0) break;
        const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/u, "");
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        if (line.length === 0) continue;

        appendFileSync(
          live.logFileDescriptor,
          `${new Date().toISOString()} ${line}\n`,
          "utf8"
        );
        let event: AgentEvent;
        try {
          event = JSON.parse(line) as AgentEvent;
        } catch {
          lines.push({
            type: "adapter.error",
            code: "invalid_json",
            message: "Fake Agent emitted invalid JSON"
          });
          continue;
        }
        if (event.type === "session.started") live.handle = event.handle;
        if (event.type === "session.interrupted") {
          live.interruptWaiters.shift()?.(true);
          continue;
        }
        if (event.type === "usage.updated") {
          live.usage = {
            inputTokens: event.inputTokens,
            outputTokens: event.outputTokens,
            contextTokens: event.contextTokens,
            capturedAt: new Date().toISOString()
          };
        }
        lines.push(event);
      }
    });
    child.stderr.resume();

    let first: IteratorResult<AgentEvent>;
    try {
      first = await nextWithTimeout(
        lines,
        START_TIMEOUT_MS,
        `Fake Agent ${input.employeeId} did not start within ${START_TIMEOUT_MS}ms`
      );
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await live.closed.catch(() => undefined);
      throw error;
    }
    if (first.done || first.value.type !== "session.started") {
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await live.closed.catch(() => undefined);
      throw new Error(`Fake Agent ${input.employeeId} did not emit session.started`);
    }

    live.handle = first.value.handle;
    this.#sessions.set(live.handle.internalSessionId, live);
    return live.handle;
  }

  #getLive(session: SessionHandle): LiveFakeSession {
    const live = this.#sessions.get(session.internalSessionId);
    if (live === undefined) {
      throw new Error(`unknown Fake Agent session: ${session.internalSessionId}`);
    }
    return live;
  }

  #closeLogFile(live: LiveFakeSession): void {
    if (live.logFileClosed) return;
    live.logFileClosed = true;
    closeSync(live.logFileDescriptor);
  }

  #writeProcessDiagnostic(
    live: LiveFakeSession,
    diagnostic: Record<string, unknown>
  ): void {
    if (live.logFileClosed) return;
    this.#writeDiagnosticLine(
      live.logFileDescriptor,
      `${new Date().toISOString()} ${JSON.stringify(diagnostic)}\n`
    );
  }

  #writeProcessExitDiagnostic(
    live: LiveFakeSession,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (live.processExitLogged) return;
    live.processExitLogged = true;
    this.#writeProcessDiagnostic(live, {
      type: "adapter.process.exited",
      employeeId: live.handle.employeeId,
      pid: live.child.pid,
      processInstanceId: live.processInstanceId,
      exitCode,
      signal
    });
  }

  #tryWriteProcessExitDiagnostic(
    live: LiveFakeSession,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): void {
    try {
      this.#writeProcessExitDiagnostic(live, exitCode, signal);
    } catch (error) {
      live.lifecycleErrors.push(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }

  async #abortFailedStart(
    live: LiveFakeSession,
    cause: unknown
  ): Promise<never> {
    const failure = cause instanceof Error ? cause : new Error(String(cause));
    const cleanupErrors: Error[] = [];
    live.child.stdin.destroy();
    if (live.child.exitCode === null && live.child.signalCode === null) {
      if (!live.child.kill("SIGKILL")) {
        cleanupErrors.push(new Error(
          `failed to terminate Fake Agent after start failure: ${live.handle.employeeId}`
        ));
      }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        live.closed,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(
              `Fake Agent ${live.handle.employeeId} cleanup timed out`
            )),
            STOP_TIMEOUT_MS
          );
        })
      ]);
    } catch (error) {
      cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      this.#closeLogFile(live);
    }
    cleanupErrors.push(...live.lifecycleErrors.filter((error) => error !== failure));
    if (cleanupErrors.length === 0) throw failure;
    throw new Error(failure.message, {
      cause: new AggregateError(
        [failure, ...cleanupErrors],
        `Fake Agent ${live.handle.employeeId} start cleanup failed`
      )
    });
  }
}
