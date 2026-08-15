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
  CodexAgentAdapter,
  type CodexAgentAdapterOptions
} from "../src/agents/codex-adapter.js";
import { createTemporaryProject } from "./helpers.js";

type SpawnStub = NonNullable<CodexAgentAdapterOptions["spawnProcess"]>;

interface ScriptedChild extends ChildProcessWithoutNullStreams {
  executable: string;
  args: string[];
  cwd: string | undefined;
  killCalls: Array<string | number>;
  writeStdout: (chunk: string) => void;
  closeChild: (exitCode: number, signal: NodeJS.Signals | null) => void;
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
  const stdout = new PassThrough();
  const child = Object.assign(emitter, {
    pid: scriptedPid++,
    stdin: new PassThrough(),
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

function threadStarted(threadId: string): string {
  return JSON.stringify({ type: "thread.started", thread_id: threadId });
}

function agentMessage(text: string): string {
  return JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text }
  });
}

function turnCompleted(inputTokens: number, outputTokens: number): string {
  return JSON.stringify({
    type: "turn.completed",
    usage: { input_tokens: inputTokens, output_tokens: outputTokens }
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

describe("CodexAgentAdapter", () => {
  it("reports the exact capability matrix", async () => {
    const adapter = new CodexAgentAdapter({ forbidRealProbes: true });
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
    const adapter = new CodexAgentAdapter({ forbidRealProbes: true });
    await expect(adapter.detect()).resolves.toEqual({
      available: false,
      version: "unknown"
    });
  });

  it("spawns the initial exec and exposes the thread id as nativeSessionId", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("resume"),
        lines: [
          threadStarted("thread-1"),
          agentMessage("Ready."),
          turnCompleted(2, 1)
        ]
      }
    ]);
    const adapter = new CodexAgentAdapter({
      executable: "codex",
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
        adapter: "codex",
        internalSessionId: expect.any(String),
        nativeSessionId: "thread-1"
      });
      expect(children[0]!.args.slice(0, 5)).toEqual([
        "exec",
        "--json",
        "--sandbox",
        "read-only",
        "--cd"
      ]);
      expect(children[0]!.args[5]).toBe(project.root);
      expect(children[0]!.args[6]).toContain("Developer");
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("refuses to launch the real executable while forbidRealProbes is enabled", async () => {
    const project = await createTemporaryProject();
    const adapter = new CodexAgentAdapter();
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
        match: (args) => !args.includes("resume"),
        lines: [threadStarted("thread-1"), turnCompleted(1, 1)]
      },
      {
        match: (args) => args.includes("resume") && args.includes("thread-1"),
        lines: [agentMessage(reply), turnCompleted(10, 5)]
      }
    ]);
    const adapter = new CodexAgentAdapter({
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
        {
          type: "usage.updated",
          inputTokens: 10,
          outputTokens: 5,
          contextTokens: null
        }
      ]);
      const resumeChild = children[1]!;
      expect(resumeChild.args.slice(0, 4)).toEqual([
        "exec",
        "resume",
        "thread-1",
        "--json"
      ]);
      expect(resumeChild.args[4]).toBe("--cd");
      expect(resumeChild.args[5]).toBe(project.root);
      expect(resumeChild.args[6]).toContain("implement feature X");
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("maps turn.failed to an adapter.error during send", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("resume"),
        lines: [threadStarted("thread-1"), turnCompleted(1, 1)]
      },
      {
        match: (args) => args.includes("resume"),
        lines: [JSON.stringify({ type: "turn.failed", message: "model errored" })]
      }
    ]);
    const adapter = new CodexAgentAdapter({
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
        code: "codex_error",
        message: "model errored"
      }]);
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("kills the active child on interrupt and closes the in-flight send", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("resume"),
        lines: [threadStarted("thread-1"), turnCompleted(1, 1)]
      },
      {
        match: (args) => args.includes("resume"),
        lines: [agentMessage("thinking...")],
        keepOpen: true
      }
    ]);
    const adapter = new CodexAgentAdapter({
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

  it("reports captured usage tokens, or nulls before any turn", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([
      {
        match: (args) => !args.includes("resume"),
        lines: [threadStarted("thread-1")]
      },
      {
        match: (args) => args.includes("resume"),
        lines: [agentMessage("ok"), turnCompleted(10, 5)]
      }
    ]);
    const adapter = new CodexAgentAdapter({
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
        match: (args) => !args.includes("resume"),
        lines: [threadStarted("thread-1"), turnCompleted(1, 1)]
      }
    ]);
    const adapter = new CodexAgentAdapter({
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
        /unknown Codex Agent session/
      );
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("throws when resuming a session without a native thread id", async () => {
    const project = await createTemporaryProject();
    const adapter = new CodexAgentAdapter();
    const previous: SessionHandle = {
      employeeId: "developer",
      adapter: "codex",
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

  it("resumes using the previous native thread id", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess, children } = createScriptedSpawn([
      {
        match: (args) => !args.includes("resume"),
        lines: [threadStarted("thread-1"), turnCompleted(1, 1)]
      },
      {
        match: (args) => args.includes("resume"),
        lines: [agentMessage("resumed."), turnCompleted(1, 1)]
      }
    ]);
    const adapter = new CodexAgentAdapter({
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
      expect(resumed.nativeSessionId).toBe("thread-1");
      expect(resumed.internalSessionId).not.toBe(first.internalSessionId);
      const resumeChild = children[1]!;
      expect(resumeChild.args.slice(0, 4)).toEqual([
        "exec",
        "resume",
        "thread-1",
        "--json"
      ]);
      expect(resumeChild.args[6]).toContain("continue from checkpoint");
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
        match: (args) => !args.includes("resume"),
        lines: [threadStarted("thread-1"), turnCompleted(1, 1)]
      },
      {
        match: (args) => args.includes("resume"),
        lines: [agentMessage("ok"), turnCompleted(1, 1)]
      }
    ]);
    const adapter = new CodexAgentAdapter({
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
      expect(log).toContain("\"type\":\"thread.started\"");
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("rejects an invalid employee ID before constructing a log path", async () => {
    const project = await createTemporaryProject();
    const { spawnProcess } = createScriptedSpawn([]);
    const adapter = new CodexAgentAdapter({
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
