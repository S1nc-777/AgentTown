import { EventEmitter } from "node:events";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio
} from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import type {
  ActionProposal,
  AgentEvent,
  AgentMessage,
  SessionHandle,
  StartSessionInput
} from "@agenttown/runtime-contract";
import { describe, expect, it } from "vitest";
import {
  ClaudeAgentAdapter,
  type ClaudeAgentAdapterOptions
} from "../src/agents/claude-adapter.js";
import { createTemporaryProject } from "./helpers.js";

type SpawnStub = NonNullable<ClaudeAgentAdapterOptions["spawnProcess"]>;

interface ScriptedChild extends ChildProcessWithoutNullStreams {
  executable: string;
  args: string[];
  cwd: string | undefined;
  killCalls: Array<string | number>;
  stdinEndCalls: number;
  writeStdout: (chunk: string) => void;
  closeChild: (exitCode: number, signal: NodeJS.Signals | null) => void;
}

let scriptedPid = 6000;

function makeScriptedChild(
  executable: string,
  args: string[],
  options: SpawnOptionsWithoutStdio & { stdio: ["pipe", "pipe", "pipe"] }
): ScriptedChild {
  const emitter = new EventEmitter();
  let exitCodeValue: number | null = null;
  let signalCodeValue: NodeJS.Signals | null = null;
  const killCalls: Array<string | number> = [];
  const stdin = new PassThrough();
  let stdinEndCalls = 0;
  const originalEnd = stdin.end.bind(stdin);
  Object.defineProperty(stdin, "end", {
    configurable: true,
    value: (...args: unknown[]) => {
      stdinEndCalls += 1;
      return originalEnd(...(args as []));
    }
  });
  const stdout = new PassThrough();
  const child = Object.assign(emitter, {
    pid: scriptedPid++,
    stdin,
    stdout,
    stderr: new PassThrough(),
    kill: (signal?: NodeJS.Signals | number) => {
      killCalls.push(signal ?? "SIGTERM");
      if (exitCodeValue === null && signalCodeValue === null) {
        if (signal === "SIGKILL") {
          signalCodeValue = "SIGKILL";
        } else {
          exitCodeValue = 1;
        }
        setImmediate(() => emitter.emit("close", exitCodeValue, signalCodeValue));
      }
      return true;
    }
  }) as unknown as ScriptedChild;
  Object.defineProperty(child, "exitCode", {
    get: () => exitCodeValue,
    configurable: true
  });
  Object.defineProperty(child, "signalCode", {
    get: () => signalCodeValue,
    configurable: true
  });
  Object.defineProperty(child, "stdinEndCalls", {
    get: () => stdinEndCalls,
    configurable: true
  });
  Object.assign(child, {
    executable,
    args,
    cwd: options.cwd,
    killCalls,
    writeStdout: (chunk: string) => {
      stdout.write(chunk);
    },
    closeChild: (exitCode: number, signal: NodeJS.Signals | null) => {
      if (exitCodeValue === null && signalCodeValue === null) {
        exitCodeValue = exitCode;
        signalCodeValue = signal;
        setImmediate(() => emitter.emit("close", exitCode, signal));
      }
    }
  });
  return child;
}

interface Script {
  match: (args: string[]) => boolean;
  lines: string[];
  keepOpen?: boolean;
}

function createScriptedSpawn(
  scripts: Script[]
): { spawnProcess: SpawnStub; children: ScriptedChild[] } {
  const children: ScriptedChild[] = [];
  const spawnProcess: SpawnStub = (executable, args, options) => {
    const script = scripts.find((candidate) => candidate.match(args));
    if (script === undefined) {
      throw new Error(`no scripted behavior for args: ${JSON.stringify(args)}`);
    }
    const child = makeScriptedChild(executable, args, options);
    children.push(child);
    setImmediate(() => {
      for (const line of script.lines) child.writeStdout(`${line}\n`);
      if (!script.keepOpen) child.closeChild(0, null);
    });
    return child;
  };
  return { spawnProcess, children };
}

/**
 * Builds the single-line JSON object `claude -p --output-format json` prints
 * to stdout. `overrides` may replace any base field; pass `usage: undefined`
 * to omit the usage block.
 */
function claudeResult(overrides: Record<string, unknown> = {}): string {
  const base: Record<string, unknown> = {
    is_error: false,
    type: "result",
    stop_reason: "end_turn",
    session_id: "session-1",
    result: "PONG",
    usage: { input_tokens: 3, output_tokens: 2 }
  };
  return JSON.stringify({ ...base, ...overrides });
}

function startInput(
  employeeId: string,
  projectRoot: string,
  scenario = "complete"
): StartSessionInput {
  return {
    employeeId,
    role: "Developer",
    projectRoot,
    scenario
  };
}

function message(taskId: string, messageId = "message-1"): AgentMessage {
  return {
    messageId,
    employeeId: "developer",
    taskId,
    text: "implement feature X",
    actionRequest: null,
    taskContext: null
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${label} timed out after 2000ms`)),
          2_000
        );
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function validProposal(): ActionProposal {
  return {
    schemaVersion: 1,
    actionId: "action-1",
    type: "task.start",
    actorEmployeeId: "developer",
    taskId: "task-1",
    payload: { note: "go" },
    reason: "ready to start",
    causationEventId: null
  };
}

function claudeStartedEvent(nativeSessionId: string): AgentEvent {
  return {
    type: "session.started",
    handle: {
      employeeId: "developer",
      adapter: "claude",
      internalSessionId: expect.any(String),
      nativeSessionId
    }
  };
}

describe("ClaudeAgentAdapter", () => {
  it("reports the exact capability matrix", async () => {
    const adapter = new ClaudeAgentAdapter({ forbidRealProbes: true });
    await expect(adapter.capabilities()).resolves.toEqual({
      nativeResume: "supported",
      structuredOutput: "unsupported",
      nonInteractive: "supported",
      interrupt: "supported",
      parallelSessions: "unsupported",
      tokenUsage: "supported",
      contextUsage: "unknown",
      interactiveTakeover: "unsupported"
    });
  });

  it("reports the real CLI as unavailable while real probes are forbidden", async () => {
    const adapter = new ClaudeAgentAdapter({ forbidRealProbes: true });
    await expect(adapter.detect()).resolves.toEqual({
      available: false,
      version: "unknown"
    });
  });

  it("spawns the initial claude -p and exposes the session id as nativeSessionId", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("--resume"),
        lines: [claudeResult({ result: "warm-up discarded" })]
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      executable: "claude",
      forbidRealProbes: true,
      spawnProcess
    });
    let handle: SessionHandle | undefined;
    try {
      handle = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      expect(handle).toEqual({
        employeeId: "developer",
        adapter: "claude",
        internalSessionId: expect.any(String),
        nativeSessionId: "session-1"
      });
      const startChild = children[0]!;
      expect(startChild.args.slice(0, 5)).toEqual([
        "-p",
        expect.stringContaining("Developer"),
        "--output-format",
        "json",
        "--cd"
      ]);
      expect(startChild.args[5]).toBe(project.root);
      expect(startChild.args).not.toContain("--resume");
      expect(startChild.stdinEndCalls).toBe(1);
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("refuses to launch the real executable while forbidRealProbes is enabled", async () => {
    const project = await createTemporaryProject();
    const adapter = new ClaudeAgentAdapter();
    try {
      await expect(adapter.start(startInput(
        "developer",
        project.root
      ))).rejects.toThrow(/refus/i);
    } finally {
      await project.cleanup();
    }
  });

  it("streams output, parsed actions and usage from a scripted resume exec", async () => {
    const project = await createTemporaryProject();
    const proposal = validProposal();
    const reply = `Plan:\n\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\`\nDone.`;
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("--resume"),
        lines: [claudeResult({ result: "warm-up" })]
      },
      {
        match: (args) => args.includes("--resume") && args.includes("session-1"),
        lines: [claudeResult({
          result: reply,
          usage: { input_tokens: 10, output_tokens: 5 }
        })]
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    let handle: SessionHandle | undefined;
    try {
      handle = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      const events = await bounded(
        collect(adapter.send(handle, message("task-1"))),
        "send"
      );
      expect(events).toEqual([
        claudeStartedEvent("session-1"),
        { type: "output.completed", text: reply },
        { type: "action.proposed", action: proposal },
        {
          type: "usage.updated",
          inputTokens: 10,
          outputTokens: 5,
          contextTokens: null
        }
      ]);
      const resumeChild = children[1]!;
      expect(resumeChild.args.slice(0, 5)).toEqual([
        "-p",
        expect.stringContaining("implement feature X"),
        "--output-format",
        "json",
        "--cd"
      ]);
      expect(resumeChild.args[5]).toBe(project.root);
      expect(resumeChild.args.slice(6)).toEqual(["--resume", "session-1"]);
      expect(resumeChild.stdinEndCalls).toBe(1);
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("appends --permission-mode when configured", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("--resume"),
        lines: [claudeResult({ result: "warm-up" })]
      },
      {
        match: (args) => args.includes("--resume"),
        lines: [claudeResult({ result: "ok" })]
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess,
      permissionMode: "bypassPermissions"
    });
    let handle: SessionHandle | undefined;
    try {
      handle = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      await bounded(
        collect(adapter.send(handle, message("task-1"))),
        "send"
      );
      const resumeChild = children[1]!;
      expect(resumeChild.args).toContain("--permission-mode");
      expect(
        resumeChild.args[resumeChild.args.indexOf("--permission-mode") + 1]
      ).toBe("bypassPermissions");
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("surfaces unparseable stdout as an adapter.error during send", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("--resume"),
        lines: [claudeResult({ result: "warm-up" })]
      },
      {
        match: (args) => args.includes("--resume"),
        lines: ["this is not json"]
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    let handle: SessionHandle | undefined;
    try {
      handle = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      await expect(bounded(
        collect(adapter.send(handle, message("task-1"))),
        "send"
      )).resolves.toEqual([{
        type: "adapter.error",
        code: "claude_error",
        message: expect.stringMatching(/unable to parse/i)
      }]);
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("parses stdout with leading ANSI noise during send", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("--resume"),
        lines: [claudeResult({ result: "warm-up" })]
      },
      {
        match: (args) => args.includes("--resume"),
        lines: [
          "\u001b[31m[claude-code:unrecognized_model]\u001b[0m "
          + claudeResult({ result: "noisy but parsed" })
        ]
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    let handle: SessionHandle | undefined;
    try {
      handle = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      const events = await bounded(
        collect(adapter.send(handle, message("task-1"))),
        "send"
      );
      expect(events).toEqual([
        claudeStartedEvent("session-1"),
        { type: "output.completed", text: "noisy but parsed" },
        {
          type: "usage.updated",
          inputTokens: 3,
          outputTokens: 2,
          contextTokens: null
        }
      ]);
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("yields no_native_session when the handle has no native session id", async () => {
    const adapter = new ClaudeAgentAdapter({ forbidRealProbes: true });
    const events = await bounded(
      collect(adapter.send({
        employeeId: "developer",
        adapter: "claude",
        internalSessionId: "s-1",
        nativeSessionId: null
      }, message("task-1"))),
      "send"
    );
    expect(events).toEqual([{
      type: "adapter.error",
      code: "no_native_session",
      message: expect.stringMatching(/no native session/i)
    }]);
  });

  it("yields busy when a turn is already running", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("--resume"),
        lines: [claudeResult({ result: "warm-up" })]
      },
      {
        match: (args) => args.includes("--resume"),
        lines: [],
        keepOpen: true
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    let handle: SessionHandle | undefined;
    let inFlight: Promise<AgentEvent[]> | undefined;
    try {
      handle = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      inFlight = bounded(
        collect(adapter.send(handle, message("task-1"))),
        "send"
      );
      await sleep(50);
      const events = await bounded(
        collect(adapter.send(handle, message("task-2"))),
        "send"
      );
      expect(events).toEqual([{
        type: "adapter.error",
        code: "busy",
        message: expect.stringMatching(/already has a running turn/i)
      }]);
    } finally {
      if (handle !== undefined) {
        await adapter.interrupt(handle).catch(() => undefined);
        await adapter.stop(handle).catch(() => undefined);
      }
      if (inFlight !== undefined) await inFlight.catch(() => undefined);
      await project.cleanup();
    }
  });

  it("kills the active child on interrupt and closes the in-flight send", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("--resume"),
        lines: [claudeResult({ result: "warm-up" })]
      },
      {
        match: (args) => args.includes("--resume"),
        lines: [],
        keepOpen: true
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    let handle: SessionHandle | undefined;
    let inFlight: Promise<AgentEvent[]> | undefined;
    try {
      handle = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      inFlight = bounded(
        collect(adapter.send(handle, message("task-1"))),
        "send"
      );
      await sleep(50);
      await expect(bounded(
        adapter.interrupt(handle),
        "interrupt"
      )).resolves.toEqual({ interrupted: true });
      const events = await inFlight;
      expect(events.map((event) => event.type)).toContain("session.interrupted");
      expect(children[1]!.killCalls.length).toBeGreaterThan(0);
    } finally {
      if (inFlight !== undefined) await inFlight.catch(() => undefined);
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("force-stops a running session with SIGKILL", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("--resume"),
        lines: [claudeResult({ result: "warm-up" })]
      },
      {
        match: (args) => args.includes("--resume"),
        lines: [],
        keepOpen: true
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    let handle: SessionHandle | undefined;
    let inFlight: Promise<AgentEvent[]> | undefined;
    try {
      handle = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      inFlight = bounded(
        collect(adapter.send(handle, message("task-1"))),
        "send"
      );
      await sleep(50);
      await bounded(adapter.forceStop(handle), "forceStop");
      expect(children[1]!.killCalls).toContain("SIGKILL");
      await inFlight;
      await expect(adapter.usage(handle)).rejects.toThrow(
        /unknown Claude Agent session/
      );
    } finally {
      if (inFlight !== undefined) await inFlight.catch(() => undefined);
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("stops a session idempotently", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("--resume"),
        lines: [claudeResult({ result: "warm-up" })]
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    let handle: SessionHandle | undefined;
    try {
      handle = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      await adapter.stop(handle);
      await adapter.stop(handle);
      await expect(adapter.usage(handle)).rejects.toThrow(
        /unknown Claude Agent session/
      );
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("throws when resuming a session without a native session id", async () => {
    const project = await createTemporaryProject();
    const adapter = new ClaudeAgentAdapter();
    const previous: SessionHandle = {
      employeeId: "developer",
      adapter: "claude",
      internalSessionId: "s-1",
      nativeSessionId: null
    };
    try {
      await expect(adapter.resume({
        ...startInput("developer", project.root),
        previous,
        handoff: "continue from checkpoint"
      })).rejects.toThrow(/native session ID/i);
    } finally {
      await project.cleanup();
    }
  });

  it("resumes using the previous native session id", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("--resume"),
        lines: [claudeResult({ result: "warm-up" })]
      },
      {
        match: (args) => args.includes("--resume"),
        lines: [claudeResult({ result: "resumed." })]
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    const handles: SessionHandle[] = [];
    try {
      const first = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      handles.push(first);
      const resumed = await bounded(adapter.resume({
        ...startInput("developer", project.root),
        previous: first,
        handoff: "continue from checkpoint"
      }), "resume");
      handles.push(resumed);
      expect(resumed.nativeSessionId).toBe("session-1");
      expect(resumed.internalSessionId).not.toBe(first.internalSessionId);
      const resumeChild = children[1]!;
      expect(resumeChild.args.slice(0, 5)).toEqual([
        "-p",
        expect.stringContaining("continue from checkpoint"),
        "--output-format",
        "json",
        "--cd"
      ]);
      expect(resumeChild.args[5]).toBe(project.root);
      expect(resumeChild.args.slice(6)).toEqual(["--resume", "session-1"]);
    } finally {
      await Promise.all(handles.map(async (handle) => {
        await adapter.stop(handle).catch(() => undefined);
      }));
      await project.cleanup();
    }
  });

  it("writes process started/exited diagnostics for each spawned process", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("--resume"),
        lines: [claudeResult({ result: "warm-up" })]
      },
      {
        match: (args) => args.includes("--resume"),
        lines: [claudeResult({ result: "ok" })]
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    let handle: SessionHandle | undefined;
    try {
      handle = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      await bounded(
        collect(adapter.send(handle, message("task-1"))),
        "send"
      );
      const log = await readFile(
        join(project.root, ".agenttown", "logs", "developer.jsonl"),
        "utf8"
      );
      const diagnostics = log.split(/\r?\n/u)
        .map((line) => line.slice(line.indexOf("{")))
        .filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line) as {
          type?: string;
          processInstanceId?: string;
        })
        .filter(({ type }) => type?.startsWith("adapter.process."));
      const started = diagnostics.filter(({ type }) =>
        type === "adapter.process.started"
      );
      const exited = diagnostics.filter(({ type }) =>
        type === "adapter.process.exited"
      );
      expect(started).toHaveLength(2);
      expect(exited).toHaveLength(2);
      expect(log).toContain("\"type\":\"result\"");
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("reports an error when the process exits before emitting any event", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: () => true,
        lines: []
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    try {
      await expect(adapter.start(startInput(
        "developer",
        project.root
      ))).rejects.toThrow(/exited before emitting/i);
    } finally {
      await project.cleanup();
    }
  });

  it("rejects a result without a session id during start", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: () => true,
        lines: [claudeResult({ session_id: null })]
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    try {
      await expect(adapter.start(startInput(
        "developer",
        project.root
      ))).rejects.toThrow(/did not emit session\.started/);
    } finally {
      await project.cleanup();
    }
  });

  it("reports captured usage tokens, or nulls before any turn", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("--resume"),
        lines: [claudeResult({ result: "warm-up", usage: undefined })]
      },
      {
        match: (args) => args.includes("--resume"),
        lines: [claudeResult({
          result: "ok",
          usage: { input_tokens: 10, output_tokens: 5 }
        })]
      }
    ]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    let handle: SessionHandle | undefined;
    try {
      handle = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      await expect(adapter.usage(handle)).resolves.toEqual({
        inputTokens: null,
        outputTokens: null,
        contextTokens: null,
        capturedAt: expect.any(String)
      });
      await bounded(
        collect(adapter.send(handle, message("task-1"))),
        "send"
      );
      await expect(adapter.usage(handle)).resolves.toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        contextTokens: null
      });
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("rejects an invalid employee ID before constructing a log path", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([]);
    const adapter = new ClaudeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    try {
      await expect(adapter.start(startInput(
        "../outside",
        project.root
      ))).rejects.toThrow("invalid employee id");
    } finally {
      await project.cleanup();
    }
  });
});
