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
import { extractStructuredAction } from "./codex-parse.js";
import { parseClaudeResult } from "./claude-parse.js";

const lstatAsync = promisify(lstat);
const mkdirAsync = promisify(mkdir);
const realpathAsync = promisify(realpath);
const STOP_TIMEOUT_MS = 2_000;
/**
 * The initial `claude -p` (fresh session) or `claude -p --resume` (recovered
 * session) is a full one-shot turn whose output is discarded as warm-up. We
 * wait up to this long for that process to exit on its own before aborting,
 * so `start`/`resume` never leave a concurrent claude running against the
 * same session when the first `send` spawns its own resume process. Real
 * model inference legitimately takes 10-60s, so this must be generous.
 */
/**
 * Real `claude -p` first turns can take minutes (model exploration and
 * reasoning); the start wait covers natural process exit, so use a generous
 * bound. Observed worst case on a local DeepSeek-backed endpoint: ~150s.
 */
const INITIAL_EXEC_TIMEOUT_MS = 300_000;
const EMPLOYEE_ID_PATTERN = /^[a-z][a-z0-9_-]*$/u;
const DEFAULT_EXECUTABLE = "claude";

/**
 * `structuredOutput` is unsupported, so every prompt we hand to Claude Code
 * carries a reporting requirement: end each reply with a fenced json block the
 * adapter can parse with `extractStructuredAction`.
 */
const CLAUDE_FORMAT_INSTRUCTION = [
  "",
  "Formatting requirement: end every reply with your next action as a fenced json block:",
  "```json",
  'ACTION: {"schemaVersion": 1, "actionId": "<unique id>", "type": "<action type>", "actorEmployeeId": "<your employee id>", "taskId": "<task id or null>", "payload": { ... }, "reason": "<one sentence>", "causationEventId": "<event id or null>"}',
  "```",
  "The ACTION block is mandatory in every reply.",
  "Allowed action types (use exactly one of these): task.propose, task.assign, task.start, task.submit, task.request_review, task.approve, task.reject, task.block, employee.message, user.approval.request, company.complete.request",
  "task.propose: taskId must be a non-empty unique string you generate, lowercase letters/digits/hyphens only (e.g. task-001, never null, never uppercase); payload must include title (string), objective (string), acceptanceCriteria (array of strings); dependencies MUST be an array of task id strings (use [] when there are none, never a string or object).",
  "task.assign: taskId must reference an existing proposed task; payload must include assignee (string, exactly one of the developer employee ids, e.g. developer-a).",
  "Do NOT use employee.message to ask questions or seek confirmation — you are the leader; act directly with task.propose, task.assign or company.complete.request."
].join("\n");

const DEFAULT_SPAWN_PROCESS: NonNullable<
  ClaudeAgentAdapterOptions["spawnProcess"]
> = (executable, args, options) => spawn(executable, args, options);

function initialPrompt(input: StartSessionInput): string {
  return [
    `You are ${input.role} in the AgentTown company.`,
    `Your employee id is ${input.employeeId}. Always use it as actorEmployeeId in ACTION blocks.`,
    `Scenario: ${input.scenario}`,
    CLAUDE_FORMAT_INSTRUCTION
  ].join("\n");
}

function handoffPrompt(handoff: string): string {
  return `${handoff}\n${CLAUDE_FORMAT_INSTRUCTION}`;
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

export interface ClaudeAgentAdapterOptions {
  /** Executable used to launch Claude Code; defaults to "claude". */
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
   * When true (default) `start`/`send`/`resume` refuse to spawn the real
   * executable unless a `spawnProcess` stub is injected, so tests never
   * launch a real Claude Code CLI.
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
  /**
   * Optional `--permission-mode <mode>` appended to every `claude -p`
   * invocation; omitted when unset or empty. Headless runs default to
   * read-only tools, which is acceptable for the leader-only task-splitting
   * scenario.
   */
  permissionMode?: string;
}

/**
 * One `claude -p` invocation (`start`, `send` or `resume` turn). Claude Code's
 * `-p` mode is one-shot: it prints a single JSON result object and exits, so
 * each turn owns its own child process.
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

interface LiveClaudeSession {
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
 * ClaudeAgentAdapter drives the real Claude Code CLI in its non-interactive
 * `claude -p` mode. Claude has no long-lived interactive process: every turn
 * is a fresh `claude -p` (initial) or `claude -p --resume <sessionId>`
 * (subsequent) one-shot process that prints a single JSON result object and
 * exits. The `session_id` from the first result becomes the session's
 * `nativeSessionId`, and because `structuredOutput` is unsupported every
 * prompt demands a fenced json `ACTION: {...}` block that
 * `extractStructuredAction` parses into `action.proposed` events.
 */
export class ClaudeAgentAdapter implements AgentAdapter {
  readonly #executable: string;
  readonly #scriptEntry: string | null;
  readonly #packageRoot: string;
  readonly #forbidRealProbes: boolean;
  readonly #permissionMode: string | null;
  readonly #spawnProcess: NonNullable<
    ClaudeAgentAdapterOptions["spawnProcess"]
  >;
  readonly #writeDiagnosticLine: NonNullable<
    ClaudeAgentAdapterOptions["writeDiagnostic"]
  >;
  readonly #sessions = new Map<string, LiveClaudeSession>();

  constructor(options: ClaudeAgentAdapterOptions = {}) {
    this.#executable = options.executable ?? DEFAULT_EXECUTABLE;
    this.#scriptEntry = options.scriptEntry ?? null;
    this.#packageRoot = resolve(options.packageRoot ?? process.cwd());
    this.#forbidRealProbes = options.forbidRealProbes ?? true;
    this.#permissionMode = options.permissionMode != null
      && options.permissionMode.length > 0
      ? options.permissionMode
      : null;
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
        message: "Claude Agent session has no native session id; start() never observed a result session_id"
      };
      return;
    }
    const live = this.#getLive(session);
    if (live.activeTurn !== null) {
      yield {
        type: "adapter.error",
        code: "busy",
        message: "Claude Agent session already has a running turn"
      };
      return;
    }
    const args = [
      "-p",
      `${message.text}\n${CLAUDE_FORMAT_INSTRUCTION}`,
      "--output-format",
      "json",
      "--resume",
      session.nativeSessionId,
      ...this.#permissionArgs()
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
      throw new Error("Claude Agent resume requires a native session ID");
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
          `failed to force-stop Claude Agent: ${session.employeeId}`
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
      throw new Error("Claude Agent log path escapes the project state directory");
    }
    await mkdirAsync(stateRoot, { recursive: true });
    const canonicalProjectRoot = await realpathAsync(projectRoot);
    const canonicalStateRoot = await realpathAsync(stateRoot);
    if (!isWithin(canonicalProjectRoot, canonicalStateRoot)) {
      throw new Error("Claude Agent log path escapes the project state directory");
    }
    await mkdirAsync(logsRoot, { recursive: true });
    const canonicalLogsRoot = await realpathAsync(logsRoot);
    if (!isWithin(canonicalStateRoot, canonicalLogsRoot)) {
      throw new Error("Claude Agent log path escapes the project state directory");
    }
    const logPath = resolve(canonicalLogsRoot, `${input.employeeId}.jsonl`);
    if (dirname(logPath) !== canonicalLogsRoot) {
      throw new Error("Claude Agent log path escapes the logs directory");
    }
    const existingLog = await lstatAsync(logPath).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      }
    );
    if (existingLog?.isSymbolicLink() === true) {
      throw new Error("Claude Agent log file must not be a symbolic link");
    }
    if (existingLog !== undefined) {
      const canonicalLogPath = await realpathAsync(logPath);
      if (dirname(canonicalLogPath) !== canonicalLogsRoot) {
        throw new Error("Claude Agent log file escapes the logs directory");
      }
    }
    const logFileDescriptor = openSync(logPath, "a", 0o600);

    const handle: SessionHandle = {
      employeeId: input.employeeId,
      adapter: "claude",
      internalSessionId: randomUUID(),
      nativeSessionId: resume?.resumeId ?? null
    };
    const live: LiveClaudeSession = {
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
          "-p",
          initialPrompt(input),
          "--output-format",
          "json",
          ...this.#permissionArgs()
        ]
      : [
          "-p",
          handoffPrompt(resume.handoff),
          "--output-format",
          "json",
          "--resume",
          resume.resumeId,
          ...this.#permissionArgs()
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
        INITIAL_EXEC_TIMEOUT_MS,
        `Claude Agent ${input.employeeId} did not exit within ${INITIAL_EXEC_TIMEOUT_MS}ms`
      );
      if (first.done || first.value.type === "session.exited") {
        throw new Error(
          `Claude Agent ${input.employeeId} exited before emitting any event`
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
            `Claude Agent ${input.employeeId} did not emit session.started`
          );
        }
        handle.nativeSessionId = first.value.handle.nativeSessionId;
      }
    } catch (error) {
      return this.#abortFailedStart(live, turn, error);
    }

    // The warm-up turn's output beyond session.started is discarded; only its
    // process lifecycle is reaped so the first send() can safely start a new
    // resume process against the same session.
    await this.#reapTurn(turn);
    live.activeTurn = null;
    this.#sessions.set(handle.internalSessionId, live);
    return handle;
  }

  #permissionArgs(): string[] {
    return this.#permissionMode === null
      ? []
      : ["--permission-mode", this.#permissionMode];
  }

  #spawnTurn(live: LiveClaudeSession, args: string[]): ActiveTurn {
    if (this.#forbidRealProbes && this.#spawnProcess === DEFAULT_SPAWN_PROCESS) {
      throw new Error(
        "Claude Agent refuses to launch the real Claude CLI while forbidRealProbes "
        + "is enabled (inject a spawnProcess stub in tests)"
      );
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = this.#spawnProcess(
        this.#scriptEntry === null ? this.#executable : process.execPath,
        this.#scriptEntry === null ? args : [this.#scriptEntry, ...args],
        {
          cwd: live.projectRoot,
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
    let stdoutBuffer = "";
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
        } else {
          // Claude is not a JSONL stream: stdout accumulates raw bytes and is
          // parsed once after the process exits.
          const text = stdoutBuffer.trim();
          if (text.length > 0) {
            this.#writeLogLine(live, text);
            for (const event of parseClaudeResult(text)) {
              const enriched = event.type === "session.started"
                ? {
                    ...event,
                    handle: {
                      ...live.handle,
                      nativeSessionId: event.handle.nativeSessionId
                    }
                  }
                : event;
              lines.push(enriched);
              this.#applyTurnEvent(live, turn, enriched);
            }
          }
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
    // `claude -p` reads stdin until EOF; end it immediately so the
    // non-interactive prompt returns instead of hanging on terminal input.
    child.stdin.end();
    child.stdout.on("data", (chunk: string) => {
      stdoutBuffer += chunk;
    });
    child.stderr.resume();
    return turn;
  }

  #applyTurnEvent(
    live: LiveClaudeSession,
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

  async #killActiveTurn(live: LiveClaudeSession): Promise<void> {
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
    live: LiveClaudeSession,
    turn: ActiveTurn,
    cause: unknown
  ): Promise<never> {
    const failure = cause instanceof Error ? cause : new Error(String(cause));
    const cleanupErrors: Error[] = [];
    if (turn.child.exitCode === null && turn.child.signalCode === null) {
      if (!turn.child.kill("SIGKILL")) {
        cleanupErrors.push(new Error(
          `failed to terminate Claude Agent after start failure: ${live.handle.employeeId}`
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
        `Claude Agent ${live.handle.employeeId} start cleanup failed`
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

  #getLive(session: SessionHandle): LiveClaudeSession {
    const live = this.#sessions.get(session.internalSessionId);
    if (live === undefined) {
      throw new Error(`unknown Claude Agent session: ${session.internalSessionId}`);
    }
    return live;
  }

  #writeLogLine(live: LiveClaudeSession, line: string): void {
    if (live.logFileClosed) return;
    this.#writeDiagnosticLine(
      live.logFileDescriptor,
      `${new Date().toISOString()} ${line}\n`
    );
  }

  #closeLogFile(live: LiveClaudeSession): void {
    if (live.logFileClosed) return;
    live.logFileClosed = true;
    closeSync(live.logFileDescriptor);
  }

  #writeProcessDiagnostic(
    live: LiveClaudeSession,
    diagnostic: Record<string, unknown>
  ): void {
    if (live.logFileClosed) return;
    this.#writeDiagnosticLine(
      live.logFileDescriptor,
      `${new Date().toISOString()} ${JSON.stringify(diagnostic)}\n`
    );
  }

  #writeProcessExitDiagnostic(
    live: LiveClaudeSession,
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
    live: LiveClaudeSession,
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
