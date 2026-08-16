import { EventEmitter } from "node:events";
import type {
  ChildProcessWithoutNullStreams,
  SpawnOptionsWithoutStdio
} from "node:child_process";
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
  OpenCodeAgentAdapter,
  type OpenCodeAgentAdapterOptions
} from "../src/agents/opencode-adapter.js";
import { createTemporaryProject } from "./helpers.js";

type SpawnStub = NonNullable<OpenCodeAgentAdapterOptions["spawnProcess"]>;

interface ScriptedChild extends ChildProcessWithoutNullStreams {
  executable: string;
  args: string[];
  cwd: string | undefined;
  killCalls: Array<string | number>;
  stdinEndCalls: number;
  writeStdout: (chunk: string) => void;
  closeChild: (exitCode: number, signal: NodeJS.Signals | null) => void;
  exitChild: (exitCode: number) => void;
}

let scriptedPid = 5000;

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
        return true;
      }
      // A real ChildProcess returns false when the child has already exited.
      return false;
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
      exitCodeValue = exitCode;
      signalCodeValue = signal;
      setImmediate(() => emitter.emit("close", exitCode, signal));
    },
    exitChild: (exitCode: number) => {
      if (exitCodeValue === null && signalCodeValue === null) {
        exitCodeValue = exitCode;
        signalCodeValue = null;
        setImmediate(() => emitter.emit("exit", exitCode, null));
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

function stepStarted(sessionId: string): string {
  return JSON.stringify({
    type: "step_start",
    timestamp: 1786810448512,
    sessionID: sessionId,
    part: {
      id: "prt_start",
      sessionID: sessionId,
      messageID: "msg_1",
      type: "step-start"
    }
  });
}

function textEvent(text: string, sessionId = "ses_1"): string {
  return JSON.stringify({
    type: "text",
    timestamp: 1786810448637,
    sessionID: sessionId,
    part: {
      id: "prt_text",
      sessionID: sessionId,
      messageID: "msg_1",
      type: "text",
      text,
      time: { start: 1, end: 2 }
    }
  });
}

function stepFinished(
  reason: string,
  inputTokens: number,
  outputTokens: number,
  sessionId = "ses_1"
): string {
  return JSON.stringify({
    type: "step_finish",
    timestamp: 1786810448645,
    sessionID: sessionId,
    part: {
      id: "prt_finish",
      sessionID: sessionId,
      messageID: "msg_1",
      type: "step-finish",
      reason,
      cost: 0.0018263,
      tokens: {
        total: inputTokens + outputTokens,
        input: inputTokens,
        output: outputTokens,
        reasoning: 0,
        cache: { read: 0, write: 0 }
      }
    }
  });
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

describe("OpenCodeAgentAdapter", () => {
  it("reports the exact capability matrix", async () => {
    const adapter = new OpenCodeAgentAdapter({ forbidRealProbes: true });
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
    const adapter = new OpenCodeAgentAdapter({ forbidRealProbes: true });
    await expect(adapter.detect()).resolves.toEqual({
      available: false,
      version: "unknown"
    });
  });

  it("spawns the initial run and exposes the sessionID as nativeSessionId", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("-s"),
        lines: [
          stepStarted("ses_1"),
          textEvent("Ready."),
          stepFinished("stop", 2, 1)
        ]
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
      executable: "opencode",
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
        adapter: "opencode",
        internalSessionId: expect.any(String),
        nativeSessionId: "ses_1"
      });
      expect(children[0]!.args.slice(0, 5)).toEqual([
        "run",
        "--format",
        "json",
        "--dir",
        project.root
      ]);
      expect(children[0]!.args).not.toContain("--model");
      expect(children[0]!.args[5]).toContain("You are Developer");
      expect(children[0]!.stdinEndCalls).toBe(1);
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("spawns via process.execPath with the script entry prepended when scriptEntry is set", async () => {
    const project = await createTemporaryProject();
    const scriptEntry = "/path/to/cli.js";
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("-s"),
        lines: [stepStarted("ses_1"), stepFinished("stop", 1, 1)]
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess,
      scriptEntry
    });
    let handle: SessionHandle | undefined;
    try {
      handle = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      const startChild = children[0]!;
      expect(startChild.executable).toBe(process.execPath);
      expect(startChild.args[0]).toBe(scriptEntry);
      expect(startChild.args.slice(1, 4)).toEqual([
        "run",
        "--format",
        "json"
      ]);
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("adds --model to run args only when the model option is configured", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("-s"),
        lines: [stepStarted("ses_1"), stepFinished("stop", 1, 1)]
      },
      {
        match: (args) => args.includes("-s"),
        lines: [textEvent("PONG"), stepFinished("stop", 1, 1)]
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess,
      model: "alibaba-cn/deepseek-v4-flash"
    });
    let handle: SessionHandle | undefined;
    try {
      handle = await bounded(
        adapter.start(startInput("developer", project.root)),
        "start"
      );
      expect(children[0]!.args).toEqual([
        "run",
        "--format",
        "json",
        "--model",
        "alibaba-cn/deepseek-v4-flash",
        "--dir",
        project.root,
        expect.stringContaining("You are Developer")
      ]);
      await bounded(
        collect(adapter.send(handle, message("task-1"))),
        "send"
      );
      expect(children[1]!.args).toEqual([
        "run",
        "--format",
        "json",
        "--model",
        "alibaba-cn/deepseek-v4-flash",
        "--dir",
        project.root,
        "-s",
        "ses_1",
        expect.stringContaining("implement feature X")
      ]);
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("refuses to launch the real executable while forbidRealProbes is enabled", async () => {
    const project = await createTemporaryProject();
    const adapter = new OpenCodeAgentAdapter();
    try {
      await expect(adapter.start(startInput(
        "developer",
        project.root
      ))).rejects.toThrow(/refus/i);
    } finally {
      await project.cleanup();
    }
  });

  it("streams output, parsed actions and usage from a scripted run", async () => {
    const project = await createTemporaryProject();
    const proposal = validProposal();
    const reply = `Plan:\n\`\`\`json\n${JSON.stringify(proposal)}\n\`\`\`\nDone.`;
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("-s"),
        lines: [stepStarted("ses_1"), stepFinished("stop", 1, 1)]
      },
      {
        match: (args) => args.includes("-s"),
        lines: [
          textEvent(reply),
          textEvent("second chunk"),
          stepFinished("stop", 10, 5)
        ]
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
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
        { type: "output.completed", text: reply },
        { type: "action.proposed", action: proposal },
        { type: "output.completed", text: "second chunk" },
        {
          type: "usage.updated",
          inputTokens: 10,
          outputTokens: 5,
          contextTokens: null
        }
      ]);
      const resumeChild = children[1]!;
      expect(resumeChild.args.slice(0, 7)).toEqual([
        "run",
        "--format",
        "json",
        "--dir",
        project.root,
        "-s",
        "ses_1"
      ]);
      expect(resumeChild.args[7]).toContain("implement feature X");
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("emits action.proposed exactly once once the accumulated text parses", async () => {
    const project = await createTemporaryProject();
    const proposal = validProposal();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("-s"),
        lines: [stepStarted("ses_1"), stepFinished("stop", 1, 1)]
      },
      {
        match: (args) => args.includes("-s"),
        lines: [
          textEvent("Here is the plan:\n```json\n"),
          textEvent(`${JSON.stringify(proposal)}\n` + "```\nDone."),
          textEvent(`ACTION: ${JSON.stringify({ ...proposal, actionId: "action-2" })}`),
          stepFinished("stop", 10, 5)
        ]
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
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
      const actions = events.filter((event) => event.type === "action.proposed");
      expect(actions).toEqual([{ type: "action.proposed", action: proposal }]);
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("maps a non-stop step_finish to an adapter.error during send", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("-s"),
        lines: [stepStarted("ses_1"), stepFinished("stop", 1, 1)]
      },
      {
        match: (args) => args.includes("-s"),
        lines: [JSON.stringify({
          type: "step_finish",
          sessionID: "ses_1",
          message: "model errored",
          part: { type: "step-finish", reason: "error" }
        })]
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
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
        code: "opencode_error",
        message: "model errored"
      }]);
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("ignores invalid JSON lines and tolerates partial events", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("-s"),
        lines: [stepStarted("ses_1"), stepFinished("stop", 1, 1)]
      },
      {
        match: (args) => args.includes("-s"),
        lines: [
          "this is not json",
          "{",
          textEvent("PONG"),
          JSON.stringify({ type: "helper.event" }),
          stepFinished("stop", 3, 2)
        ]
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
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
        { type: "output.completed", text: "PONG" },
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

  it("yields a busy error when a turn is already running", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("-s"),
        lines: [stepStarted("ses_1"), stepFinished("stop", 1, 1)]
      },
      {
        match: (args) => args.includes("-s"),
        lines: [textEvent("working...")],
        keepOpen: true
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
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
        collect(adapter.send(handle, message("task-1"))),
        "send"
      );
      expect(events).toEqual([{
        type: "adapter.error",
        code: "busy",
        message: "OpenCode Agent session already has a running turn"
      }]);
    } finally {
      if (inFlight !== undefined) {
        if (handle !== undefined) {
          await adapter.interrupt(handle).catch(() => undefined);
        }
        await inFlight.catch(() => undefined);
      }
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("yields a no_native_session error when the handle has no session id", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([]);
    const adapter = new OpenCodeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    const handle: SessionHandle = {
      employeeId: "developer",
      adapter: "opencode",
      internalSessionId: "s-none",
      nativeSessionId: null
    };
    try {
      const events = await bounded(
        collect(adapter.send(handle, message("task-1"))),
        "send"
      );
      expect(events).toEqual([{
        type: "adapter.error",
        code: "no_native_session",
        message: "OpenCode Agent session has no native session id; start() never observed a step_start sessionID"
      }]);
    } finally {
      await project.cleanup();
    }
  });

  it("kills the active child on interrupt and closes the in-flight send", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("-s"),
        lines: [stepStarted("ses_1"), stepFinished("stop", 1, 1)]
      },
      {
        match: (args) => args.includes("-s"),
        lines: [textEvent("thinking...")],
        keepOpen: true
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
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

  it("does not suppress an already-exited child's output while close is pending", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("-s"),
        lines: [stepStarted("ses_1"), stepFinished("stop", 1, 1)]
      },
      {
        match: (args) => args.includes("-s"),
        lines: [textEvent("PONG")],
        keepOpen: true
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
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
      const resumeChild = children[1]!;
      // The child has exited (exitCode set, 'exit' emitted) but 'close' has
      // not fired yet because stdio is still flushing.
      resumeChild.exitChild(0);
      await expect(bounded(
        adapter.interrupt(handle),
        "interrupt"
      )).resolves.toEqual({ interrupted: false });
      expect(resumeChild.killCalls).toHaveLength(0);
      // 'close' fires now: the turn's already-queued real events must flow
      // through instead of a session.interrupted.
      resumeChild.closeChild(0, null);
      const events = await inFlight;
      expect(events.map((event) => event.type)).not.toContain(
        "session.interrupted"
      );
      expect(events).toContainEqual({ type: "output.completed", text: "PONG" });
    } finally {
      if (inFlight !== undefined) await inFlight.catch(() => undefined);
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("force-stops by SIGKILLing the active turn and removing the session", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("-s"),
        lines: [stepStarted("ses_1"), stepFinished("stop", 1, 1)]
      },
      {
        match: (args) => args.includes("-s"),
        lines: [textEvent("working...")],
        keepOpen: true
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
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
      await adapter.forceStop(handle);
      expect(children[1]!.killCalls).toContain("SIGKILL");
      await inFlight;
      await expect(adapter.usage(handle)).rejects.toThrow(
        /unknown OpenCode Agent session/
      );
    } finally {
      if (inFlight !== undefined) await inFlight.catch(() => undefined);
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("reports captured usage tokens, or nulls before any turn", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("-s"),
        lines: [stepStarted("ses_1")]
      },
      {
        match: (args) => args.includes("-s"),
        lines: [textEvent("ok"), stepFinished("stop", 10, 5)]
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
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

  it("stops a session idempotently", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("-s"),
        lines: [stepStarted("ses_1"), stepFinished("stop", 1, 1)]
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
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
        /unknown OpenCode Agent session/
      );
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("throws when resuming a session without a native session id", async () => {
    const project = await createTemporaryProject();
    const adapter = new OpenCodeAgentAdapter();
    const previous: SessionHandle = {
      employeeId: "developer",
      adapter: "opencode",
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
        match: (args) => !args.includes("-s"),
        lines: [stepStarted("ses_1"), stepFinished("stop", 1, 1)]
      },
      {
        match: (args) => args.includes("-s"),
        lines: [textEvent("resumed."), stepFinished("stop", 1, 1)]
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
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
      expect(resumed.nativeSessionId).toBe("ses_1");
      expect(resumed.internalSessionId).not.toBe(first.internalSessionId);
      const resumeChild = children[1]!;
      expect(resumeChild.args.slice(0, 7)).toEqual([
        "run",
        "--format",
        "json",
        "--dir",
        project.root,
        "-s",
        "ses_1"
      ]);
      expect(resumeChild.args[7]).toContain("continue from checkpoint");
    } finally {
      await Promise.all(handles.map(async (handle) => {
        await adapter.stop(handle).catch(() => undefined);
      }));
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
    const adapter = new OpenCodeAgentAdapter({
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

  it("rejects a start whose first event is not session.started", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: () => true,
        lines: [textEvent("PONG"), stepFinished("stop", 1, 1)]
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
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

  it("fails start and cleans up when no event arrives within the start timeout", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: () => true,
        lines: [],
        keepOpen: true
      }
    ]);
    const adapter = new OpenCodeAgentAdapter({
      forbidRealProbes: true,
      spawnProcess
    });
    try {
      await expect(adapter.start(startInput(
        "developer",
        project.root
      ))).rejects.toThrow(/did not start within/);
      expect(children[0]!.killCalls).toContain("SIGKILL");
    } finally {
      await project.cleanup();
    }
  }, 15_000);

  it("rejects an invalid employee ID before constructing a log path", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([]);
    const adapter = new OpenCodeAgentAdapter({
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
