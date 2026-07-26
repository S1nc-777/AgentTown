import {
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { access, appendFileSync, mkdir } from "node:fs";
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
const mkdirAsync = promisify(mkdir);
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
}

export class FakeAgentAdapter implements AgentAdapter {
  readonly #executable: string;
  readonly #packageRoot: string;
  readonly #sessions = new Map<string, LiveFakeSession>();

  constructor(options: FakeAgentAdapterOptions) {
    this.#executable = resolve(options.executable);
    this.#packageRoot = resolve(options.packageRoot);
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
    writeJsonLine(live.child, {
      type: "message",
      messageId: message.messageId,
      taskId: message.taskId,
      text: message.text
    });

    for await (const event of live.lines) {
      yield event;
      if (
        event.type === "action.proposed" ||
        event.type === "adapter.error" ||
        event.type === "session.exited"
      ) {
        return;
      }
    }
  }

  async interrupt(session: SessionHandle): Promise<{ interrupted: boolean }> {
    const live = this.#getLive(session);
    writeJsonLine(live.child, { type: "interrupt" });
    for await (const event of live.lines) {
      if (event.type === "session.interrupted") return { interrupted: true };
      if (event.type === "session.exited") return { interrupted: false };
      if (event.type === "adapter.error") {
        throw new Error(event.message);
      }
    }
    return { interrupted: false };
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

    if (live.child.exitCode === null && live.child.signalCode === null) {
      writeJsonLine(live.child, { type: "stop" });
      const closed = await Promise.race([
        live.closed.then(() => true),
        new Promise<false>((resolvePromise) => {
          setTimeout(() => resolvePromise(false), STOP_TIMEOUT_MS);
        })
      ]);
      if (!closed) {
        live.child.kill();
        await live.closed;
      }
    } else {
      await live.closed;
    }
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

    const projectRoot = resolve(input.projectRoot);
    const stateRoot = resolve(projectRoot, ".agenttown");
    const logsRoot = resolve(stateRoot, "logs");
    if (!isWithin(projectRoot, stateRoot) || !isWithin(stateRoot, logsRoot)) {
      throw new Error("Fake Agent log path escapes the project state directory");
    }
    await mkdirAsync(logsRoot, { recursive: true });
    const logPath = resolve(logsRoot, `${input.employeeId}.jsonl`);
    if (dirname(logPath) !== logsRoot) {
      throw new Error("Fake Agent log path escapes the logs directory");
    }

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

    const child = spawn(this.#executable, args, {
      cwd: this.#packageRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
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
      closed: Promise.resolve()
    };

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
          logPath,
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

    live.closed = new Promise<void>((resolvePromise, reject) => {
      child.once("error", (error) => {
        lines.close(error);
        reject(error);
      });
      child.once("close", (exitCode) => {
        lines.push({ type: "session.exited", exitCode });
        lines.close();
        this.#sessions.delete(live.handle.internalSessionId);
        resolvePromise();
      });
    });

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
}
