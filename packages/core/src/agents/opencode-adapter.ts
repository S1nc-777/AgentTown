import {
  spawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptionsWithoutStdio
} from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  lstat,
  mkdir,
  openSync,
  realpath
} from "node:fs";
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
import {
  extractStructuredAction
} from "./codex-parse.js";
import { parseOpenCodeJsonl } from "./opencode-parse.js";

const lstatAsync = promisify(lstat);
const mkdirAsync = promisify(mkdir);
const realpathAsync = promisify(realpath);
const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;
/**
 * The initial `opencode run` (fresh session) or `opencode run -s` (recovered
 * session) is a full one-shot turn whose output is discarded as warm-up. We
 * wait up to this long for that process to exit on its own before killing it,
 * so `start`/`resume` never leave a concurrent run executing against the same
 * session when the first `send` spawns its own run.
 */
const INITIAL_EXEC_REAP_TIMEOUT_MS = 10_000;
const EMPLOYEE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const DEFAULT_EXECUTABLE = "opencode";

/**
 * `structuredOutput` is unsupported, so every prompt we hand to OpenCode
 * carries a reporting requirement: end each reply with a fenced json block the
 * adapter can parse with `extractStructuredAction`.
 */
const OPENCODE_FORMAT_INSTRUCTION = [
  "",
  "Formatting requirement: end every reply with your next action as a fenced json block:",
  "```json",
  'ACTION: {"schemaVersion": 1, "actionId": "<unique id>", "type": "<action type>", "actorEmployeeId": "<your employee id>", "taskId": "<task id or null>", "payload": { ... }, "reason": "<one sentence>", "causationEventId": "<event id or null>"}',
  "```",
  "The ACTION block is mandatory in every reply."
].join("\n");

const DEFAULT_SPAWN_PROCESS: NonNullable<
  OpenCodeAgentAdapterOptions["spawnProcess"]
> = (executable, args, options) => spawn(executable, args, options);

function initialPrompt(input: StartSessionInput): string {
  return [
    `You are ${input.role} in the AgentTown company.`,
    `Scenario: ${input.scenario}`,
    OPENCODE_FORMAT_INSTRUCTION
  ].join("\n");
}

function handoffPrompt(handoff: string): string {
  return `${handoff}\n${OPENCODE_FORMAT_INSTRUCTION}`;
}

interface AsyncJsonLineQueue<T> extends AsyncIterable<T> {
  push(value: T): void;
  close(error?: Error): void;
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

export interface OpenCodeAgentAdapterOptions {
  /** Executable used to launch OpenCode; defaults to "opencode". */
  executable?: string;
  /**
   * When set, the CLI is launched via `process.execPath` with this script as
   * the first argument instead of spawning `executable` directly. Needed when
   * the CLI ships as a `#!/usr/bin/env node` script (npm shims on Windows
   * cannot be spawned by Node directly).
   */
  scriptEntry?: string;
  /** Working directory for spawned processes; defaults to process.cwd(). */
  packageRoot?: string;
  /**
   * Provider/model passed as `--model <value>` on every `opencode run`
   * invocation. The adapter never hardcodes a model; when unset (or empty) no
   * `--model` flag is emitted and the CLI falls back to its default endpoint.
   */
  model?: string;
  /**
   * When true (default) `start`/`send`/`resume` refuse to spawn the real
   * executable unless a `spawnProcess` stub is injected, so tests never
   * launch a real OpenCode CLI.
   */
  forbidRealProbes?: boolean;
  spawnProcess?: (
    executable: string,
    args: string[],
    options: SpawnOptionsWithoutStdio & {
      stdio: ["pipe", "pipe", "pipe"];
    }
  ) => ChildProcessWithoutNullStreams;
  writeDiagnostic?: (fileDescriptor: number, line: string) => void;
}

/**
 * One `opencode run` invocation (`start`, `send` or `resume` turn). OpenCode's
 * `run` mode is one-shot: it streams JSONL events on stdout and exits when the
 * turn completes, so each turn owns its own child process.
 */
interface ActiveTurn {
  child: ChildProcessWithoutNullStreams;
  lines: AsyncJsonLineQueue<AgentEvent>;
  closed: Promise<void>;
  processInstanceId: string;
  processExitLogged: boolean;
  interruptRequested: boolean;
  accumulatedOutput: string;
  actionEmitted: boolean;
  lifecycleErrors: Error[];
}

interface LiveOpenCodeSession {
  handle: SessionHandle;
  projectRoot: string;
  usage: UsageSnapshot;
  logFileDescriptor: number;
  logFileClosed: boolean;
  lifecycleErrors: Error[];
  stopping: Promise<void> | null;
  activeTurn: ActiveTurn | null;
}

/**
 * OpenCodeAgentAdapter drives the real OpenCode CLI (`opencode run --format
 * json`). OpenCode has no long-lived interactive process: every turn is a
 * fresh one-shot run (initial, or resumed with `-s <sessionId>`) that streams
 * JSONL events and exits. The `sessionID` carried by the first `step_start`
 * event becomes the session's `nativeSessionId`, and because
 * `structuredOutput` is unsupported every prompt demands a fenced json
 * `ACTION: {...}` block that `extractStructuredAction` parses into
 * `action.proposed` events.
 */
export class OpenCodeAgentAdapter implements AgentAdapter {
  readonly #executable: string;
  readonly #scriptEntry: string | null;
  readonly #packageRoot: string;
  readonly #model: string | null;
  readonly #forbidRealProbes: boolean;
  readonly #spawnProcess: NonNullable<
    OpenCodeAgentAdapterOptions["spawnProcess"]
  >;
  readonly #writeDiagnosticLine: NonNullable<
    OpenCodeAgentAdapterOptions["writeDiagnostic"]
  >;
  readonly #sessions = new Map<string, LiveOpenCodeSession>();

  constructor(options: OpenCodeAgentAdapterOptions = {}) {
    this.#executable = options.executable ?? DEFAULT_EXECUTABLE;
    this.#scriptEntry = options.scriptEntry ?? null;
    this.#packageRoot = resolve(options.packageRoot ?? process.cwd());
    this.#model = options.model != null && options.model.length > 0
      ? options.model
      : null;
    this.#forbidRealProbes = options.forbidRealProbes ?? true;
    this.#spawnProcess = options.spawnProcess ?? DEFAULT_SPAWN_PROCESS;
    this.#writeDiagnosticLine = options.writeDiagnostic
      ?? ((fileDescriptor, line) =>
        appendFileSync(fileDescriptor, line, "utf8"));
  }

  async detect(): Promise<{ available: boolean; version: string }> {
    if (this.#forbidRealProbes && this.#spawnProcess === DEFAULT_SPAWN_PROCESS) {
      return { available: false, version: "unknown" };
    }
    return { available: true, version: "unknown" };
  }

  async capabilities(): Promise<AgentCapabilities> {
    return {
      nativeResume: "supported",
      structuredOutput: "unsupported",
      nonInteractive: "supported",
      interrupt: "supported",
      parallelSessions: "unsupported",
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
    if (session.nativeSessionId === null) {
      yield {
        type: "adapter.error",
        code: "no_native_session",
        message: "OpenCode Agent session has no native session id; start() never observed a step_start sessionID"
      };
      return;
    }
    const live = this.#getLive(session);
    if (live.activeTurn !== null) {
      yield {
        type: "adapter.error",
        code: "busy",
        message: "OpenCode Agent session already has a running turn"
      };
      return;
    }
    const args = [
      "run",
      "--format",
      "json",
      ...this.#modelArgs(),
      "--dir",
      live.projectRoot,
      "-s",
      session.nativeSessionId,
      `${message.text}\n${OPENCODE_FORMAT_INSTRUCTION}`
    ];
    const turn = this.#spawnTurn(live, args);
    live.activeTurn = turn;
    try {
      for await (const event of turn.lines) {
        yield event;
        if (
          event.type === "usage.updated"
          || event.type === "adapter.error"
          || event.type === "session.interrupted"
          || event.type === "session.exited"
        ) {
          return;
        }
      }
    } finally {
      await this.#reapTurn(turn);
      if (live.activeTurn === turn) live.activeTurn = null;
    }
  }

  async interrupt(session: SessionHandle): Promise<{ interrupted: boolean }> {
    const live = this.#getLive(session);
    const turn = live.activeTurn;
    if (turn === null || turn.child.exitCode !== null || turn.child.signalCode !== null) {
      return { interrupted: false };
    }
    turn.interruptRequested = true;
    if (!turn.child.kill()) {
      return { interrupted: false };
    }
    await this.#boundedAwait(turn.closed, STOP_TIMEOUT_MS);
    return { interrupted: true };
  }

  async resume(input: ResumeSessionInput): Promise<SessionHandle> {
    if (input.previous.nativeSessionId === null) {
      throw new Error("OpenCode Agent resume requires a native session ID");
    }
    await this.stop(input.previous);
    return this.#start(input, {
      resumeId: input.previous.nativeSessionId,
      handoff: input.handoff
    });
  }

  async stop(session: SessionHandle): Promise<void> {
    const live = this.#sessions.get(session.internalSessionId);
    if (live === undefined) return;
    if (live.stopping !== null) return live.stopping;

    const stopping = (async () => {
      await this.#killActiveTurn(live);
      this.#closeLogFile(live);
      this.#sessions.delete(session.internalSessionId);
    })();
    live.stopping = stopping;
    return stopping;
  }

  async forceStop(session: SessionHandle): Promise<void> {
    const live = this.#sessions.get(session.internalSessionId);
    if (live === undefined) return;
    const turn = live.activeTurn;
    if (turn !== null && turn.child.exitCode === null && turn.child.signalCode === null) {
      if (!turn.child.kill("SIGKILL")) {
        throw new Error(
          `failed to force-stop OpenCode Agent: ${session.employeeId}`
        );
      }
    }
    if (turn !== null) await this.#boundedAwait(turn.closed, STOP_TIMEOUT_MS);
    this.#closeLogFile(live);
    this.#sessions.delete(session.internalSessionId);
  }

  async usage(session: SessionHandle): Promise<UsageSnapshot> {
    const live = this.#getLive(session);
    return { ...live.usage };
  }

  async #start(
    input: StartSessionInput,
    resume?: { resumeId: string; handoff: string }
  ): Promise<SessionHandle> {
    if (!EMPLOYEE_ID_PATTERN.test(input.employeeId)) {
      throw new Error(`invalid employee id: ${input.employeeId}`);
    }

    const projectRoot = resolve(input.projectRoot);
    const stateRoot = resolve(projectRoot, ".agenttown");
    const logsRoot = resolve(stateRoot, "logs");
    if (!isWithin(projectRoot, stateRoot) || !isWithin(stateRoot, logsRoot)) {
      throw new Error("OpenCode Agent log path escapes the project state directory");
    }
    await mkdirAsync(stateRoot, { recursive: true });
    const canonicalProjectRoot = await realpathAsync(projectRoot);
    const canonicalStateRoot = await realpathAsync(stateRoot);
    if (!isWithin(canonicalProjectRoot, canonicalStateRoot)) {
      throw new Error("OpenCode Agent log path escapes the project state directory");
    }
    await mkdirAsync(logsRoot, { recursive: true });
    const canonicalLogsRoot = await realpathAsync(logsRoot);
    if (!isWithin(canonicalStateRoot, canonicalLogsRoot)) {
      throw new Error("OpenCode Agent log path escapes the project state directory");
    }
    const logPath = resolve(canonicalLogsRoot, `${input.employeeId}.jsonl`);
    if (dirname(logPath) !== canonicalLogsRoot) {
      throw new Error("OpenCode Agent log path escapes the logs directory");
    }
    const existingLog = await lstatAsync(logPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
    );
    if (existingLog?.isSymbolicLink() === true) {
      throw new Error("OpenCode Agent log file must not be a symbolic link");
    }
    if (existingLog !== undefined) {
      const canonicalLogPath = await realpathAsync(logPath);
      if (dirname(canonicalLogPath) !== canonicalLogsRoot) {
        throw new Error("OpenCode Agent log file escapes the logs directory");
      }
    }
    const logFileDescriptor = openSync(logPath, "a", 0o600);

    const handle: SessionHandle = {
      employeeId: input.employeeId,
      adapter: "opencode",
      internalSessionId: randomUUID(),
      nativeSessionId: resume?.resumeId ?? null
    };
    const live: LiveOpenCodeSession = {
      handle,
      projectRoot,
      usage: {
        inputTokens: null,
        outputTokens: null,
        contextTokens: null,
        capturedAt: new Date().toISOString()
      },
      logFileDescriptor,
      logFileClosed: false,
      lifecycleErrors: [],
      stopping: null,
      activeTurn: null
    };

    const args = resume === undefined
      ? [
          "run",
          "--format",
          "json",
          ...this.#modelArgs(),
          "--dir",
          projectRoot,
          initialPrompt(input)
        ]
      : [
          "run",
          "--format",
          "json",
          ...this.#modelArgs(),
          "--dir",
          projectRoot,
          "-s",
          resume.resumeId,
          handoffPrompt(resume.handoff)
        ];
    let turn: ActiveTurn;
    try {
      turn = this.#spawnTurn(live, args);
    } catch (error) {
      live.logFileClosed = true;
      closeSync(logFileDescriptor);
      throw error;
    }
    live.activeTurn = turn;

    try {
      const first = await nextWithTimeout(
        turn.lines,
        START_TIMEOUT_MS,
        `OpenCode Agent ${input.employeeId} did not start within ${START_TIMEOUT_MS}ms`
      );
      if (first.done || first.value.type === "session.exited") {
        throw new Error(
          `OpenCode Agent ${input.employeeId} exited before emitting any event`
        );
      }
      if (first.value.type === "adapter.error") {
        throw new Error(first.value.message);
      }
      if (resume === undefined) {
        if (
          first.value.type !== "session.started"
          || first.value.handle.nativeSessionId === null
        ) {
          throw new Error(
            `OpenCode Agent ${input.employeeId} did not emit session.started`
          );
        }
        handle.nativeSessionId = first.value.handle.nativeSessionId;
      }
    } catch (error) {
      return this.#abortFailedStart(live, turn, error);
    }

    // The warm-up run's output beyond session.started is discarded; only its
    // process lifecycle is reaped so the first send() can safely start a new
    // run against the same session.
    await this.#reapTurn(turn, INITIAL_EXEC_REAP_TIMEOUT_MS);
    live.activeTurn = null;
    this.#sessions.set(handle.internalSessionId, live);
    return handle;
  }

  #modelArgs(): string[] {
    return this.#model === null ? [] : ["--model", this.#model];
  }

  #spawnTurn(live: LiveOpenCodeSession, args: string[]): ActiveTurn {
    if (this.#forbidRealProbes && this.#spawnProcess === DEFAULT_SPAWN_PROCESS) {
      throw new Error(
        "OpenCode Agent refuses to launch the real OpenCode CLI while forbidRealProbes "
        + "is enabled (inject a spawnProcess stub in tests)"
      );
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#spawnProcess(
        this.#scriptEntry === null ? this.#executable : process.execPath,
        this.#scriptEntry === null ? args : [this.#scriptEntry, ...args],
        {
          cwd: this.#packageRoot,
          stdio: ["pipe", "pipe", "pipe"]
        }
      );
    } catch (error) {
      throw error;
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const lines = createAsyncJsonLineQueue<AgentEvent>();
    const turn: ActiveTurn = {
      child,
      lines,
      closed: Promise.resolve(),
      processInstanceId: randomUUID(),
      processExitLogged: false,
      interruptRequested: false,
      accumulatedOutput: "",
      actionEmitted: false,
      lifecycleErrors: []
    };
    turn.closed = new Promise<void>((resolvePromise) => {
      child.once("error", (error) => {
        turn.lifecycleErrors.push(
          error instanceof Error ? error : new Error(String(error))
        );
        this.#tryWriteProcessExitDiagnostic(live, turn, null, null);
        lines.close(error instanceof Error ? error : new Error(String(error)));
        resolvePromise();
      });
      child.once("close", (exitCode, signal) => {
        this.#tryWriteProcessExitDiagnostic(live, turn, exitCode, signal);
        if (turn.interruptRequested) {
          lines.push({
            type: "session.interrupted",
            reason: "interrupted by operator"
          });
        }
        lines.push({ type: "session.exited", exitCode });
        lines.close();
        resolvePromise();
      });
    });

    try {
      this.#writeProcessDiagnostic(live, {
        type: "adapter.process.started",
        employeeId: live.handle.employeeId,
        pid: child.pid ?? null,
        processInstanceId: turn.processInstanceId
      });
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
      lines.close(error instanceof Error ? error : new Error(String(error)));
      throw error;
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

        this.#writeLogLine(live, line);
        for (const event of parseOpenCodeJsonl(line)) {
          lines.push(event);
          this.#applyTurnEvent(live, turn, event);
        }
      }
    });
    child.stderr.resume();
    return turn;
  }

  #applyTurnEvent(
    live: LiveOpenCodeSession,
    turn: ActiveTurn,
    event: AgentEvent
  ): void {
    if (event.type === "session.started" && event.handle.nativeSessionId !== null) {
      live.handle = { ...live.handle, nativeSessionId: event.handle.nativeSessionId };
    }
    if (event.type === "output.completed") {
      turn.accumulatedOutput = turn.accumulatedOutput.length === 0
        ? event.text
        : `${turn.accumulatedOutput}\n${event.text}`;
      if (!turn.actionEmitted) {
        const action = extractStructuredAction(turn.accumulatedOutput);
        if (action !== null) {
          turn.actionEmitted = true;
          turn.lines.push({ type: "action.proposed", action });
        }
      }
    }
    if (event.type === "usage.updated") {
      live.usage = {
        inputTokens: event.inputTokens,
        outputTokens: event.outputTokens,
        contextTokens: event.contextTokens,
        capturedAt: new Date().toISOString()
      };
    }
  }

  async #reapTurn(
    turn: ActiveTurn,
    timeoutMs = STOP_TIMEOUT_MS
  ): Promise<void> {
    if (turn.child.exitCode !== null || turn.child.signalCode !== null) {
      await this.#boundedAwait(turn.closed, timeoutMs);
      return;
    }
    turn.child.kill();
    await this.#boundedAwait(turn.closed, timeoutMs);
    if (turn.child.exitCode === null && turn.child.signalCode === null) {
      turn.child.kill("SIGKILL");
      await this.#boundedAwait(turn.closed, timeoutMs);
    }
  }

  async #killActiveTurn(live: LiveOpenCodeSession): Promise<void> {
    const turn = live.activeTurn;
    if (turn === null) return;
    if (turn.child.exitCode !== null || turn.child.signalCode !== null) {
      await this.#boundedAwait(turn.closed, STOP_TIMEOUT_MS);
      return;
    }
    turn.interruptRequested = true;
    turn.child.kill();
    await this.#boundedAwait(turn.closed, STOP_TIMEOUT_MS);
    if (turn.child.exitCode === null && turn.child.signalCode === null) {
      turn.child.kill("SIGKILL");
    }
    await this.#boundedAwait(turn.closed, STOP_TIMEOUT_MS);
  }

  async #abortFailedStart(
    live: LiveOpenCodeSession,
    turn: ActiveTurn,
    cause: unknown
  ): Promise<never> {
    const failure = cause instanceof Error ? cause : new Error(String(cause));
    const cleanupErrors: Error[] = [];
    if (turn.child.exitCode === null && turn.child.signalCode === null) {
      if (!turn.child.kill("SIGKILL")) {
        cleanupErrors.push(new Error(
          `failed to terminate OpenCode Agent after start failure: ${live.handle.employeeId}`
        ));
      }
    }
    await this.#boundedAwait(turn.closed, STOP_TIMEOUT_MS);
    this.#closeLogFile(live);
    cleanupErrors.push(...live.lifecycleErrors.filter((error) => error !== failure));
    if (cleanupErrors.length === 0) throw failure;
    throw new Error(failure.message, {
      cause: new AggregateError(
        [failure, ...cleanupErrors],
        `OpenCode Agent ${live.handle.employeeId} start cleanup failed`
      )
    });
  }

  #boundedAwait(promise: Promise<unknown>, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolvePromise) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      promise.then(
        () => {
          if (timer !== undefined) clearTimeout(timer);
          resolvePromise();
        },
        () => {
          if (timer !== undefined) clearTimeout(timer);
          resolvePromise();
        }
      );
      timer = setTimeout(() => resolvePromise(), timeoutMs);
    });
  }

  #getLive(session: SessionHandle): LiveOpenCodeSession {
    const live = this.#sessions.get(session.internalSessionId);
    if (live === undefined) {
      throw new Error(`unknown OpenCode Agent session: ${session.internalSessionId}`);
    }
    return live;
  }

  #writeLogLine(live: LiveOpenCodeSession, line: string): void {
    if (live.logFileClosed) return;
    this.#writeDiagnosticLine(
      live.logFileDescriptor,
      `${new Date().toISOString()} ${line}\n`
    );
  }

  #closeLogFile(live: LiveOpenCodeSession): void {
    if (live.logFileClosed) return;
    live.logFileClosed = true;
    closeSync(live.logFileDescriptor);
  }

  #writeProcessDiagnostic(
    live: LiveOpenCodeSession,
    diagnostic: Record<string, unknown>
  ): void {
    if (live.logFileClosed) return;
    this.#writeDiagnosticLine(
      live.logFileDescriptor,
      `${new Date().toISOString()} ${JSON.stringify(diagnostic)}\n`
    );
  }

  #writeProcessExitDiagnostic(
    live: LiveOpenCodeSession,
    turn: ActiveTurn,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): void {
    if (turn.processExitLogged) return;
    turn.processExitLogged = true;
    this.#writeProcessDiagnostic(live, {
      type: "adapter.process.exited",
      employeeId: live.handle.employeeId,
      pid: turn.child.pid ?? null,
      processInstanceId: turn.processInstanceId,
      exitCode,
      signal
    });
  }

  #tryWriteProcessExitDiagnostic(
    live: LiveOpenCodeSession,
    turn: ActiveTurn,
    exitCode: number | null,
    signal: NodeJS.Signals | null
  ): void {
    try {
      this.#writeProcessExitDiagnostic(live, turn, exitCode, signal);
    } catch (error) {
      live.lifecycleErrors.push(
        error instanceof Error ? error : new Error(String(error))
      );
    }
  }
}
