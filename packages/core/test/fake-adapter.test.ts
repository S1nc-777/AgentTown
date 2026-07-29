import {
  spawn,
  type ChildProcessWithoutNullStreams
} from "node:child_process";
import { EventEmitter } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink
} from "node:fs/promises";
import { PassThrough } from "node:stream";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AgentEvent,
  AgentMessage,
  SessionHandle,
  StartSessionInput
} from "@agenttown/runtime-contract";
import { describe, expect, it } from "vitest";
import { FakeAgentAdapter } from "../src/agents/fake-adapter.js";
import { createTemporaryProject } from "./helpers.js";

const fakeRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../fake-agent"
);

function startInput(
  employeeId: string,
  scenario: string,
  projectRoot: string
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
    text: "implement",
    actionRequest: null
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const collected: AgentEvent[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

async function bounded<T>(promise: Promise<T>, message: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), 2_000);
      })
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function createAdapter(
  allowedEmployeeIds: readonly string[] = ["developer"],
  overrides: Partial<ConstructorParameters<typeof FakeAgentAdapter>[0]> = {}
): FakeAgentAdapter {
  const options = {
    executable: process.execPath,
    packageRoot: fakeRoot,
    allowedEmployeeIds: new Set(allowedEmployeeIds)
  };
  return new FakeAgentAdapter({ ...options, ...overrides });
}

function isProcessAlive(pid: number): boolean {
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

describe("FakeAgentAdapter", () => {
  it("owns an asynchronous spawn error before validating or logging the child", async () => {
    const project = await createTemporaryProject();
    const fakeChild = new EventEmitter() as ChildProcessWithoutNullStreams;
    let fakeExitCode: number | null = null;
    Object.assign(fakeChild, {
      pid: 12_345,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => true
    });
    Object.defineProperty(fakeChild, "exitCode", {
      get: () => fakeExitCode
    });
    const adapter = createAdapter(["developer"], {
      spawnProcess: () => {
        setImmediate(() => {
          fakeChild.emit("error", new Error("async spawn marker"));
          fakeExitCode = 1;
          fakeChild.emit("close", 1, null);
        });
        return fakeChild;
      }
    });
    try {
      await expect(adapter.start(startInput(
        "developer",
        "complete",
        project.root
      ))).rejects.toThrow("async spawn marker");
    } finally {
      await project.cleanup();
    }
  });

  it("reaps a spawned child when the start diagnostic cannot be written", async () => {
    const project = await createTemporaryProject();
    let child: ChildProcessWithoutNullStreams | undefined;
    const adapter = createAdapter(["developer"], {
      spawnProcess: (...args) => {
        child = spawn(...args) as ChildProcessWithoutNullStreams;
        return child;
      },
      writeDiagnostic: () => {
        throw new Error("diagnostic write marker");
      }
    });
    try {
      await expect(adapter.start(startInput(
        "developer",
        "complete",
        project.root
      ))).rejects.toThrow("diagnostic write marker");
      expect(child?.pid).toBeTypeOf("number");
      expect(isProcessAlive(child!.pid!)).toBe(false);
    } finally {
      if (
        child !== undefined
        && child.exitCode === null
        && child.signalCode === null
      ) {
        child.kill("SIGKILL");
      }
      await project.cleanup();
    }
  });

  it("starts, sends, reports usage, interrupts and resumes", async () => {
    const project = await createTemporaryProject();
    const adapter = createAdapter();
    const handles: SessionHandle[] = [];

    expect(await adapter.detect()).toMatchObject({ available: true });
    expect(await adapter.capabilities()).toEqual({
      nativeResume: "supported",
      structuredOutput: "supported",
      nonInteractive: "supported",
      interrupt: "supported",
      parallelSessions: "supported",
      tokenUsage: "supported",
      contextUsage: "unknown",
      interactiveTakeover: "unsupported"
    });

    try {
      const input = startInput("developer", "complete", project.root);
      const first = await adapter.start(input);
      handles.push(first);
      const events = await collect(adapter.send(first, message("task-1")));
      expect(events.some((event) => event.type === "action.proposed")).toBe(true);
      expect(await adapter.usage(first)).toMatchObject({
        inputTokens: 10,
        outputTokens: 5,
        contextTokens: null
      });
      expect(await adapter.interrupt(first)).toEqual({ interrupted: true });

      const resumed = await adapter.resume({
        ...input,
        previous: first,
        handoff: "continue task-1"
      });
      handles.push(resumed);
      expect(resumed.nativeSessionId).toBe(first.nativeSessionId);
      await adapter.stop(resumed);

      await expect(readFile(
        join(project.root, ".agenttown", "logs", "developer.jsonl"),
        "utf8"
      )).resolves.toEqual(expect.stringContaining(
        "\"type\":\"adapter.process.started\""
      ));
      await expect(readFile(
        join(project.root, ".agenttown", "logs", "developer.jsonl"),
        "utf8"
      )).resolves.toEqual(expect.stringContaining(
        "\"type\":\"adapter.process.exited\""
      ));
    } finally {
      await Promise.all(handles.map(async (handle) => {
        await adapter.stop(handle).catch(() => undefined);
      }));
      await project.cleanup();
    }
  });

  it("preserves malformed output and recovers on the next send", async () => {
    const project = await createTemporaryProject();
    const adapter = createAdapter();
    let handle: SessionHandle | undefined;

    try {
      handle = await adapter.start(startInput(
        "developer",
        "malformed-once",
        project.root
      ));
      const malformed = await collect(adapter.send(
        handle,
        message("task-1", "message-1")
      ));
      expect(malformed).toEqual([{
        type: "adapter.error",
        code: "invalid_json",
        message: "Fake Agent emitted invalid JSON"
      }]);

      const recovered = await collect(adapter.send(
        handle,
        message("task-1", "message-2")
      ));
      expect(recovered.some((event) => event.type === "action.proposed")).toBe(true);
      await expect(readFile(
        join(project.root, ".agenttown", "logs", "developer.jsonl"),
        "utf8"
      )).resolves.toContain("not-json");
    } finally {
      if (handle !== undefined) {
        await adapter.stop(handle).catch(() => undefined);
      }
      await project.cleanup();
    }
  });

  it("consumes usage before starting the next send", async () => {
    const project = await createTemporaryProject();
    const adapter = createAdapter();
    let handle: SessionHandle | undefined;

    try {
      handle = await adapter.start(startInput("developer", "complete", project.root));
      const first = await collect(adapter.send(
        handle,
        message("task-1", "message-1")
      ));
      const second = await collect(adapter.send(
        handle,
        message("task-2", "message-2")
      ));

      expect(first.map((event) => event.type)).toEqual([
        "output.completed",
        "action.proposed",
        "usage.updated"
      ]);
      expect(second.map((event) => event.type)).toEqual([
        "output.completed",
        "action.proposed",
        "usage.updated"
      ]);
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("finishes an idle send after its usage event", async () => {
    const project = await createTemporaryProject();
    const adapter = createAdapter();
    let handle: SessionHandle | undefined;

    try {
      handle = await adapter.start(startInput("developer", "idle", project.root));
      const events = await bounded(
        collect(adapter.send(handle, message("task-1"))),
        "idle send did not finish"
      );
      expect(events.map((event) => event.type)).toEqual([
        "output.completed",
        "usage.updated"
      ]);
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("confirms an interrupt while a silent send is in flight", async () => {
    const project = await createTemporaryProject();
    const adapter = createAdapter();
    let handle: SessionHandle | undefined;
    let inFlight: Promise<AgentEvent[]> | undefined;

    try {
      handle = await adapter.start(startInput("developer", "silent", project.root));
      inFlight = collect(adapter.send(handle, message("task-1")));
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 50));

      await expect(bounded(
        adapter.interrupt(handle),
        "interrupt was consumed by the in-flight send"
      )).resolves.toEqual({ interrupted: true });
      await adapter.stop(handle);
      await expect(inFlight).resolves.toContainEqual({
        type: "session.exited",
        exitCode: 0
      });
    } finally {
      if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
      if (inFlight !== undefined) await inFlight.catch(() => undefined);
      await project.cleanup();
    }
  });

  it("retains a crashed session until its exit event is consumed", async () => {
    const project = await createTemporaryProject();
    const adapter = createAdapter();

    try {
      const handle = await adapter.start(startInput(
        "developer",
        "crash",
        project.root
      ));
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));

      await expect(collect(adapter.send(handle, message("task-1")))).resolves.toEqual([{
        type: "session.exited",
        exitCode: 23
      }]);
    } finally {
      await project.cleanup();
    }
  });

  it("reports a retained crashed session as not interruptible", async () => {
    const project = await createTemporaryProject();
    const adapter = createAdapter();

    try {
      const handle = await adapter.start(startInput(
        "developer",
        "crash",
        project.root
      ));
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 100));

      await expect(adapter.interrupt(handle)).resolves.toEqual({
        interrupted: false
      });
    } finally {
      await project.cleanup();
    }
  });

  it("rejects an invalid employee ID before constructing a log path", async () => {
    const project = await createTemporaryProject();
    const adapter = createAdapter();

    try {
      await expect(adapter.start(startInput(
        "../outside",
        "complete",
        project.root
      ))).rejects.toThrow("invalid employee id");
    } finally {
      await project.cleanup();
    }
  });

  it("rejects a valid employee ID outside the configured roster", async () => {
    const project = await createTemporaryProject();
    const adapter = createAdapter(["developer"]);

    try {
      await expect(adapter.start(startInput(
        "reviewer",
        "complete",
        project.root
      ))).rejects.toThrow("employee is not configured");
    } finally {
      await project.cleanup();
    }
  });

  it.skipIf(process.platform !== "win32")(
    "rejects a junction that redirects logs outside the project",
    async () => {
      const project = await createTemporaryProject();
      const outside = await mkdtemp(join(tmpdir(), "agenttown-outside-"));
      const adapter = createAdapter();

      try {
        const stateRoot = join(project.root, ".agenttown");
        await mkdir(stateRoot, { recursive: true });
        await symlink(outside, join(stateRoot, "logs"), "junction");

        await expect(adapter.start(startInput(
          "developer",
          "crash",
          project.root
        ))).rejects.toThrow("escapes the project state directory");
      } finally {
        await project.cleanup();
        await rm(outside, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform !== "win32")(
    "keeps logging to the validated file after a junction swap",
    async () => {
      const project = await createTemporaryProject();
      const outside = await mkdtemp(join(tmpdir(), "agenttown-swap-"));
      const adapter = createAdapter();
      let handle: SessionHandle | undefined;

      try {
        handle = await adapter.start(startInput(
          "developer",
          "complete",
          project.root
        ));
        const logsRoot = join(project.root, ".agenttown", "logs");
        const validatedLogsRoot = join(project.root, ".agenttown", "validated-logs");
        let activeLogsRoot = logsRoot;
        let renamedLogsRoot = false;
        try {
          await rename(logsRoot, validatedLogsRoot);
          renamedLogsRoot = true;
          await symlink(outside, logsRoot, "junction");
          activeLogsRoot = validatedLogsRoot;
        } catch (error) {
          if (renamedLogsRoot) throw error;
          expect((error as NodeJS.ErrnoException).code).toMatch(/^(?:EBUSY|EPERM)$/u);
        }

        await collect(adapter.send(handle, message("task-1")));

        await expect(readFile(
          join(outside, "developer.jsonl"),
          "utf8"
        )).rejects.toMatchObject({ code: "ENOENT" });
        await expect(readFile(
          join(activeLogsRoot, "developer.jsonl"),
          "utf8"
        )).resolves.toContain("\"type\":\"action.proposed\"");
      } finally {
        if (handle !== undefined) await adapter.stop(handle).catch(() => undefined);
        await project.cleanup();
        await rm(outside, { recursive: true, force: true });
      }
    }
  );
});
